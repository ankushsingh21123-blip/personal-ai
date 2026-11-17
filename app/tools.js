// Tools — what the agent may actually DO. Deny-first, per AGENT.md / permissions.json.
// Allowed tools run for real and return evidence. Everything else is denied
// and logged, or turned into a pending approval (never executed by the agent).
// Path traversal, shell injection, secret reads and send/spend/delete are all
// blocked here, before any execution.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { run, all } = require('./db');
const { audit } = require('./audit'); // hash-chained audit writer (audit.js)
const { redact } = require('./secrets'); // search excerpts are redacted (H-1)

const WORKSPACE = process.env.WORKSPACE
  || path.join(require('os').homedir(), 'workspace', 'personal-ai');

// The app's own code directory. Tool writes under it are refused (H-4):
// a model turn must never edit the code, tests, or served frontend, or it
// could rewrite the test script / test files and reach arbitrary code
// execution through run_tests, or overwrite public/app.js for stored XSS
// + token theft. Code changes are made by the user, never by the agent.
// Reads are still allowed — the agent may read code to reason about it.
const APP_DIR = (() => { try { return fs.realpathSync(__dirname); } catch { return path.resolve(__dirname); } })();

// Files the agent may NEVER read, even if asked.
const DENIED_PATHS = [/\.env/i, /\.ssh/i, /\.openclaw\/credentials/i, /credentials/i, /\.git\/config/i, /\.db(-shm|-wal)?$/i, /\.sqlite/i];

function safePath(rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('path required');
  if (DENIED_PATHS.some(re => re.test(rel))) throw new Error('denied: secret/credential path');
  const resolved = path.resolve(WORKSPACE, rel);
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
    throw new Error('denied: path escapes workspace');
  }
  // H2 fix (security audit 12 Nov 2026): refuse symlinks outright, and re-check
  // the real (resolved) path — lexical checks alone can be escaped by a symlink.
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error('denied: symlinks are not allowed');
  }
  // H-2 fix (audit 18 Nov 2026): for paths that do not exist yet, realpath
  // throws and the old fallback kept the lexical path — so a symlinked
  // PARENT directory could smuggle a new file outside the workspace.
  // Resolve the nearest existing ancestor instead, and require the
  // recombined real path to stay inside the real workspace.
  let ancestor = resolved;
  const rest = [];
  while (!fs.existsSync(ancestor)) {
    rest.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break; // filesystem root
    ancestor = parent;
  }
  let realAncestor = ancestor;
  try { realAncestor = fs.realpathSync(ancestor); } catch { /* keep lexical ancestor */ }
  const real = rest.length ? path.join(realAncestor, ...rest) : realAncestor;
  let wsReal = WORKSPACE;
  try { wsReal = fs.realpathSync(WORKSPACE); } catch { /* workspace missing — lexical check already ran */ }
  if (real !== wsReal && !real.startsWith(wsReal + path.sep)) {
    throw new Error('denied: path escapes workspace (symlink)');
  }
  if (DENIED_PATHS.some(re => re.test(real))) throw new Error('denied: secret/credential path');
  return real;
}

// H-4: refuse tool writes to the app's own code, the skills approval
// manifest, and the git hooks. `p` must be a safePath() result (real path).
// The approval manifest is a human act: letting the agent write it would
// let it approve its own skills. The pre-push hook is a safety gate.
function assertWritablePath(p) {
  if (p === APP_DIR || p.startsWith(APP_DIR + path.sep)) {
    throw new Error('denied: tool writes to the app code directory are refused — code, tests, and the served frontend are changed by the user, never by the agent');
  }
  let wsReal = WORKSPACE;
  try { wsReal = fs.realpathSync(WORKSPACE); } catch { /* fall back to the lexical workspace */ }
  const rel = path.relative(wsReal, p);
  if (rel === path.join('skills', 'approved.json')) {
    throw new Error('denied: the skills approval manifest is written by the user only — the agent cannot approve its own skills');
  }
  if (rel === '.githooks' || rel.startsWith('.githooks' + path.sep)) {
    throw new Error('denied: git hooks are safety gates — the agent cannot write them');
  }
}

const ALLOWED_COMMANDS = {
  // exact argv, no shell, no pipes, no substitution — execFile, never exec()
  // NOTE (cycle 2, 17 Nov 2026): 'npm test' was REMOVED from this list.
  // It executed whatever package.json's test script defines in WORKSPACE
  // (flagged as L6 in the 12 Nov security audit), and it ran node --test
  // without the live server, so live tests failed misleadingly. The
  // sanctioned path is the run_tests tool, which runs tests/run-tests.sh
  // on its own port and parses the real pass/fail counts.
  date: ['date'],
  pwd: ['pwd'],
  'node --version': ['node', '--version'],
  'git status': ['git', 'status', '--short'],
  'git diff --stat': ['git', 'diff', '--stat'],
  uptime: ['uptime'],
};

function runCommand(name) {
  return new Promise((resolve) => {
    const argv = ALLOWED_COMMANDS[name];
    if (!argv) return resolve({ ok: false, error: `denied: command '${name}' is not allowlisted` });
    execFile(argv[0], argv.slice(1), { cwd: WORKSPACE, timeout: 60000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: (stdout || stderr || '').slice(0, 4000), error: err ? err.message.slice(0, 200) : undefined });
      });
  });
}

// run_tests — runs tests/run-tests.sh on a separate port (PORT=3199, so it
// never clashes with the live server on 3100), parses the node --test
// summary, and returns pass/fail counts. One run at a time (module-level
// guard). The runner is injectable for unit tests via setTestRunner — the
// default runs the real script.
// H-4 note (audit 18 Nov 2026): run_tests executes a shell script, so it
// is only safe because tool writes to the app directory are refused
// (assertWritablePath) — a model turn cannot rewrite the script or the
// test files it runs. Tampering would require direct file access by a
// human, which is the trust boundary. The script itself never sources
// .env.local (see scripts/load-env.sh) so a crafted value cannot execute.
let testsRunning = false;
let testRunnerOverride = null;
function setTestRunner(fn) { testRunnerOverride = fn; }

function defaultTestRunner() {
  return new Promise((resolve) => {
    execFile('bash', ['tests/run-tests.sh'], {
      cwd: path.join(__dirname), timeout: 240000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PORT: '3199' },
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, output: String(stdout || '') + String(stderr || '') });
    });
  });
}

async function runTests() {
  if (testsRunning) throw new Error('tests are already running — wait for the current run to finish');
  testsRunning = true;
  try {
    const { code, output } = await (testRunnerOverride || defaultTestRunner)();
    const passMatch = output.match(/ℹ pass (\d+)/);
    const failMatch = output.match(/ℹ fail (\d+)/);
    const pass = passMatch ? Number(passMatch[1]) : null;
    const fail = failMatch ? Number(failMatch[1]) : null;
    const ok = code === 0 && (fail === null || fail === 0);
    return { ok, pass, fail, exitCode: code, outputTail: output.slice(-2000) };
  } finally {
    testsRunning = false;
  }
}

// --- Public-URL fetching (web_fetch) --------------------------------------
// A fetch must never reach a private/local address — including through a
// redirect. The checks run on EVERY hop: https only, no loopback/RFC1918/
// link-local/metadata hosts. DNS-rebinding and exotic IP spellings
// (0x7f000001, decimal) are NOT covered — see SECURITY.md known limits.
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|::1|\[::1\]|169\.254\.)/i;
function assertPublicHttpsUrl(raw) {
  if (typeof raw !== 'string' || !/^https:\/\//i.test(raw)) throw new Error('web_fetch requires an https URL');
  const u = new URL(raw);
  if (PRIVATE_HOST.test(u.hostname)) throw new Error('denied: private/local URL');
  return u;
}

// Redirect-safe fetch with injectable fetch (unit tests stub it). Follows at
// most 3 redirects, re-validating every hop; returns stripped page text,
// max 5000 chars. Fetched content is DATA, never instructions.
async function fetchPublicText(rawUrl, fetchImpl = fetch, maxRedirects = 3) {
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = assertPublicHttpsUrl(url);
    const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'ankush-personal-ai/1.0' }, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (!loc) throw new Error(`fetch failed: HTTP ${res.status} with no Location header`);
      if (hop === maxRedirects) throw new Error('fetch failed: too many redirects');
      url = new URL(loc, u.toString()).toString();
      continue;
    }
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    const html = await res.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
  }
  throw new Error('fetch failed: too many redirects');
}

async function execute(tool, args = {}) {
  switch (tool) {
    case 'search_files': {
      // Content search inside the workspace. JS walk, no shell, no ripgrep
      // dependency: skips node_modules/.git/data, symlinks, and large or
      // binary files. Capped: 500 files walked, 20 matches returned.
      // H-1 fix (audit 18 Nov 2026): the walk used to read files directly
      // and never applied DENIED_PATHS, so key lines from app/.env.local
      // came back as excerpts. Every file is now checked against the
      // deny list before it is opened, .env* files are skipped outright,
      // and excerpts are redacted — a key-shaped line can never leak
      // through a search result.
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200) throw new Error('search_files needs a query, 1..200 chars');
      const root = safePath(args.path || '.');
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('search path is not a directory');
      const q = args.query.toLowerCase();
      const SKIP = new Set(['node_modules', '.git', 'data', '__pycache__']);
      const matches = [];
      let walked = 0;
      const walk = (dir) => {
        if (walked >= 500 || matches.length >= 20) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (walked >= 500 || matches.length >= 20) return;
          if (e.isSymbolicLink() || SKIP.has(e.name)) continue;
          const full = path.join(dir, e.name);
          // Deny-list applies to every file the walk would open, by name
          // and by full path — secret/credential files are never read.
          if (DENIED_PATHS.some(re => re.test(e.name) || re.test(full))) continue;
          if (e.isDirectory()) { walk(full); continue; }
          if (!e.isFile()) continue;
          walked++;
          let stat;
          try { stat = fs.statSync(full); } catch { continue; }
          if (stat.size > 200 * 1024) continue;
          let content;
          try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
          if (content.includes('\0')) continue; // binary
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && matches.length < 20; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              matches.push({ path: path.relative(WORKSPACE, full), line: i + 1, excerpt: redact(lines[i].trim().slice(0, 200)) });
            }
          }
        }
      };
      walk(root);
      audit(tool, args, true, `${matches.length} matches in ${walked} files`);
      return { ok: true, matches, filesWalked: walked };
    }
    case 'create_file': {
      // New files only — refuses when the file exists (edit_file changes
      // existing ones). Parent directory must already exist.
      if (!args.path || typeof args.content !== 'string') throw new Error('path and content required');
      if (args.content.length > 100 * 1024) throw new Error('create_file content capped at 100KB');
      const p = safePath(args.path);
      assertWritablePath(p); // H-4: never write app code, the skills manifest, or git hooks
      if (fs.existsSync(p)) throw new Error('file already exists — use edit_file to change it');
      const parent = path.dirname(p);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('parent directory does not exist');
      fs.writeFileSync(p, args.content, 'utf8');
      audit(tool, args, true, `created ${args.path}`);
      return { ok: true, path: args.path };
    }
    case 'search_notes': {
      const q = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
      const rows = q
        ? all('SELECT * FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY id DESC LIMIT 10', `%${q}%`, `%${q}%`)
        : all('SELECT * FROM notes ORDER BY id DESC LIMIT 10');
      audit(tool, args, true, `${rows.length} notes`);
      return { ok: true, notes: rows };
    }
    case 'notify': {
      const { createNotification } = require('./notify');
      const n = createNotification(args.title, args.body || '', args.source || 'agent');
      audit(tool, { title: args.title }, true, `notification ${n.id}`);
      return { ok: true, notification_id: n.id };
    }
    case 'screenshot': {
      // Capture the desktop and store it in the local replay log. Prefers
      // the desktop agent (laptop); falls back to a local display capture.
      // Returns ids + hash only — the PNG lives in data/shots/, never in
      // the reply text.
      const { DesktopAgentClient } = require('./desktop');
      const { storeStandaloneShot } = require('./replay');
      let buffer = null;
      const client = new DesktopAgentClient({});
      try {
        if (await client.status()) {
          const shot = await client.screenshot();
          buffer = Buffer.from(shot.imageBase64, 'base64');
        }
      } catch { /* fall through to local capture */ }
      if (!buffer) {
        const { captureScreenshot } = require('./screen');
        const shot = await captureScreenshot();
        buffer = shot.buffer;
      }
      const stored = await storeStandaloneShot(buffer, 'tool screenshot');
      const { hashBuffer } = require('./replay');
      audit(tool, args, true, `shot session ${stored.sessionId} hash ${hashBuffer(buffer).slice(0, 12)}`);
      return { ok: true, session_id: stored.sessionId, step_index: stored.stepIndex, hash: hashBuffer(buffer) };
    }
    case 'screen_act': {
      // One validated screen action via the desktop agent. Validation
      // happens in the client AND the agent; destructive actions need an
      // approved approval id; sensitive actions are refused outright.
      const { DesktopAgentClient } = require('./desktop');
      const client = new DesktopAgentClient({});
      let result;
      try {
        result = await client.act(args, { approvalId: args.approvalId });
      } catch (e) {
        audit(tool, { action: args.action }, false, String(e.message).slice(0, 200));
        if (/fetch failed|ECONNREFUSED|Failed to fetch/i.test(e.message)) {
          throw new Error('desktop agent unavailable — start it on the laptop: node desktop-agent.js (from the app folder)');
        }
        throw e;
      }
      audit(tool, { action: args.action }, true, 'screen action ok');
      return { ok: true, result };
    }
    case 'list_windows': {
      const { listWindows } = require('./windows');
      const wins = await listWindows();
      audit(tool, args, true, `${wins.length} windows`);
      return { ok: true, windows: wins };
    }
    case 'focus_window': {
      const { focusWindow } = require('./windows');
      const r = await focusWindow({ pid: args.pid, title: args.title });
      audit(tool, args, true, 'window focused');
      return r;
    }
    case 'open_app': {
      const { openApp } = require('./windows');
      const r = await openApp(args.name);
      audit(tool, args, true, `opened ${args.name}`);
      return r;
    }
    case 'clipboard_get': {
      const { getClipboard } = require('./clipboard');
      const r = await getClipboard();
      audit(tool, args, true, `clipboard read, ${r.length} chars (content never logged)`);
      return { ok: true, text: r.text, truncated: r.truncated, length: r.length };
    }
    case 'clipboard_set': {
      const { setClipboard } = require('./clipboard');
      const r = await setClipboard(args.text);
      audit(tool, { length: String(args.text || '').length }, true, `clipboard wrote ${r.length} chars`);
      return r;
    }
    case 'create_routine': {
      const { createRoutine } = require('./routines');
      const r = createRoutine({ name: args.name, schedule: args.schedule, task: args.task, scope: args.scope, approval_rule: args.approval_rule, missed_policy: args.missed_policy });
      audit(tool, { name: args.name }, true, `routine ${r.id}`);
      return { ok: true, routine: r };
    }
    case 'list_routines': {
      const { listRoutines } = require('./routines');
      const rows = listRoutines();
      audit(tool, args, true, `${rows.length} routines`);
      return { ok: true, routines: rows };
    }
    case 'run_tests': {
      const r = await runTests();
      audit(tool, args, r.ok, `tests pass=${r.pass} fail=${r.fail}`);
      return r;
    }
    case 'remember_fact': {
      // Memory v2: store a timestamped fact (scope + optional topic +
      // source). Same scope+topic with different content supersedes the
      // old fact (history kept); identical content is a no-op. Audit
      // records metadata only — fact content is never written to the log.
      const memory = require('./memory');
      const r = memory.remember({ scope: args.scope, topic: args.topic, content: args.content, source: args.source || 'tool:remember_fact', runId: args.run_id });
      audit(tool, { scope: args.scope || 'default', topic: args.topic || '' }, true, `fact ${r.id}${r.duplicate ? ' (duplicate)' : ''}${r.superseded.length ? ` superseded ${r.superseded.join(',')}` : ''}`);
      return { ok: true, fact_id: r.id, duplicate: r.duplicate, superseded: r.superseded };
    }
    case 'recall_memory': {
      // Memory v2: keyword recall (FTS5 + recency + exact-topic boost)
      // within one scope only. Every fact carries its citation (id,
      // scope, topic, source, date) plus superseded history for the
      // same topic. Never returns facts from another scope.
      const memory = require('./memory');
      const r = memory.recall({ scope: args.scope, query: args.query, limit: args.limit });
      audit(tool, { scope: r.scope, query: String(args.query || '').slice(0, 100) }, true, `${r.facts.length} facts`);
      return { ok: true, facts: r.facts, scope: r.scope };
    }
    case 'forget_fact': {
      // Memory v2: PERMANENT delete — by id or by topic, within one
      // scope. A forgotten fact cannot be recalled again. Audit records
      // the id/topic only, never the deleted content.
      const memory = require('./memory');
      const r = memory.forget({ scope: args.scope, id: args.id, topic: args.topic });
      audit(tool, { scope: args.scope || 'default', id: args.id || null, topic: args.topic || null }, true, `forgot ${r.forgotten}`);
      return { ok: true, forgotten: r.forgotten, id: r.id || null, topic: r.topic || null };
    }
    case 'edit_fact': {
      // Memory v2: correct a current fact. The old wording is kept as
      // superseded history; recall returns the corrected fact. Audit
      // records ids only — neither wording is written to the log.
      const memory = require('./memory');
      const r = memory.editFact({ scope: args.scope, id: args.id, content: args.content, topic: args.topic });
      audit(tool, { scope: args.scope || 'default', id: args.id }, true, `fact ${args.id} -> ${r.id}${r.unchanged ? ' (unchanged)' : ''}`);
      return { ok: true, fact_id: r.id, previous_id: r.previous_id, unchanged: r.unchanged };
    }
    case 'computer_use': {
      // Full browser + desktop control (computer-use cycle): stateful
      // browser sessions (tabs, forms, DOM/a11y, screenshots, zoom,
      // dom_check, console/network observation) and CDP desktop input.
      // All deny-first gates live in computer-use.js / browser-session.js:
      // password fields refused, submit/upload/download need approved
      // approvals, sensitive text never typed, every action audit-logged
      // and DOM-verified after acting. allowLoopback is test/demo-only and
      // is ignored here — the agent tool path never sets it.
      const { getComputerUse } = require('./computer-use');
      const cu = getComputerUse();
      const r = await cu.act({ ...args, allowLoopback: false });
      audit(tool, { action: args.action }, r.ok !== false, `computer_use ${args.action} ok=${r.ok !== false}`);
      return r;
    }
    case 'list_files': {
      const dir = safePath(args.path || '.');
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.isSymbolicLink()) // H2: do not follow symlinked entries
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      audit(tool, args, true, `${items.length} items`);
      return { ok: true, items };
    }
    case 'read_file': {
      const p = safePath(args.path);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('file not found');
      const content = fs.readFileSync(p, 'utf8').slice(0, 20000);
      audit(tool, args, true, `${content.length} chars`);
      return { ok: true, content };
    }
    case 'write_note': {
      if (!args.title || !args.body) throw new Error('title and body required');
      const r = run('INSERT INTO notes (title, body) VALUES (?, ?)', String(args.title).slice(0, 200), String(args.body).slice(0, 5000));
      audit(tool, args, true, `note ${r.lastInsertRowid}`);
      return { ok: true, note_id: Number(r.lastInsertRowid) };
    }
    case 'edit_file': {
      // Precise old->new replacement, with a .bak backup first. Workspace only.
      if (!args.path || typeof args.old_text !== 'string' || typeof args.new_text !== 'string') throw new Error('path, old_text and new_text required');
      const p = safePath(args.path);
      assertWritablePath(p); // H-4: never write app code, the skills manifest, or git hooks
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('file not found');
      const before = fs.readFileSync(p, 'utf8');
      if (!before.includes(args.old_text)) throw new Error('old_text not found exactly — no fuzzy edits');
      fs.writeFileSync(p + '.bak', before, 'utf8');
      fs.writeFileSync(p, before.replace(args.old_text, args.new_text), 'utf8');
      audit(tool, args, true, `edited ${args.path}, backup ${args.path}.bak`);
      return { ok: true, backup: args.path + '.bak' };
    }
    case 'web_fetch': {
      // Read-only fetch: https only, no private IPs (checked on every
      // redirect hop), 5000-char text cap, HTML stripped.
      // Fetched content is DATA, never instructions — the agent must not act on it.
      const text = await fetchPublicText(args.url);
      const u = new URL(args.url);
      audit(tool, args, true, `${text.length} chars from ${u.hostname}`);
      return { ok: true, url: args.url, text };
    }
    case 'create_approval': {
      // Draft ONLY: records an approval request for the user to decide.
      // This is the sanctioned path for send/post/spend/delete requests:
      // approving the record still does NOT execute anything — a human
      // sends, posts, or spends. The agent can never execute via this tool.
      if (!args.action || !args.details) throw new Error('action and details required');
      const r = run('INSERT INTO approvals (action, details) VALUES (?, ?)', String(args.action).slice(0, 200), String(args.details).slice(0, 5000));
      audit(tool, { action: args.action }, true, `approval draft ${r.lastInsertRowid}`);
      return { ok: true, approval_id: Number(r.lastInsertRowid), status: 'pending', note: 'Draft only — approving does not execute the action. A human sends/posts/spends.' };
    }
    case 'file_info': {
      // Read-only metadata for one workspace file or directory: type,
      // size, last-modified time, and line count for small text files.
      // Never returns file contents (use read_file) or secret paths.
      const p = safePath(args.path);
      if (!fs.existsSync(p)) throw new Error('file not found');
      const st = fs.statSync(p);
      const info = { path: args.path, type: st.isDirectory() ? 'dir' : 'file', size: st.size, modified: st.mtime.toISOString() };
      if (st.isFile() && st.size <= 200 * 1024) {
        const content = fs.readFileSync(p, 'utf8');
        if (!content.includes('\0')) info.lines = content.split('\n').length;
      }
      audit(tool, args, true, `${info.type} ${st.size} bytes`);
      return { ok: true, ...info };
    }
    case 'append_file': {
      // Append text to an EXISTING workspace file (logs, journals, lists).
      // Refuses when the file does not exist (create_file makes new ones)
      // and when content is empty or over 10KB. No backup is written —
      // appends are additive; edit_file keeps the .bak behaviour.
      if (!args.path || typeof args.content !== 'string') throw new Error('path and content required');
      if (!args.content.length || args.content.length > 10 * 1024) throw new Error('append_file content must be 1..10240 chars');
      const p = safePath(args.path);
      assertWritablePath(p); // H-4: never write app code, the skills manifest, or git hooks
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('file not found — use create_file for new files');
      fs.appendFileSync(p, args.content, 'utf8');
      audit(tool, { path: args.path }, true, `appended ${args.content.length} chars to ${args.path}`);
      return { ok: true, path: args.path, appended_chars: args.content.length };
    }
    case 'recent_activity': {
      // Read-only self-review: the last N audit-log rows (1..20, default
      // 10), args and results truncated. Lets the agent check what it
      // already did before acting again. Audit rows are local-only and
      // never synced; this tool returns metadata, never secret content.
      const limit = Math.min(Math.max(Number(args.limit || 10) || 10, 1), 20);
      const rows = all('SELECT id, tool, args, allowed, result, created_at, entry_hash, run_id FROM audit_log ORDER BY id DESC LIMIT ?', limit)
        .map(r => ({ id: r.id, tool: r.tool, args: String(r.args || '').slice(0, 200), allowed: r.allowed, result: String(r.result || '').slice(0, 200), created_at: r.created_at, hash: r.entry_hash ? r.entry_hash.slice(0, 12) : null, run_id: r.run_id || null }));
      audit(tool, args, true, `${rows.length} audit rows`);
      return { ok: true, activity: rows };
    }
    case 'run_command': {
      const r = await runCommand(args.command);
      audit(tool, args, r.ok, r.ok ? r.output.slice(0, 200) : r.error);
      if (!r.ok) throw new Error(r.error || 'command failed');
      return { ok: true, output: r.output };
    }
    default: {
      // send / post / spend / delete / anything unknown -> denied, approval only
      audit(tool, args, false, 'denied: not an allowlisted tool');
      throw new Error(`denied: tool '${tool}' is not allowlisted — create an approval instead`);
    }
  }
}

module.exports = { execute, safePath, assertWritablePath, APP_DIR, WORKSPACE, ALLOWED_COMMANDS, audit, runTests, setTestRunner, assertPublicHttpsUrl, fetchPublicText };
