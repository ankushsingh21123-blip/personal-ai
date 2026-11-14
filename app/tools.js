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

const WORKSPACE = process.env.WORKSPACE
  || path.join(require('os').homedir(), 'workspace', 'personal-ai');

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
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* file may not exist yet */ }
  if (real !== WORKSPACE && !real.startsWith(WORKSPACE + path.sep)) {
    throw new Error('denied: path escapes workspace (symlink)');
  }
  if (DENIED_PATHS.some(re => re.test(real))) throw new Error('denied: secret/credential path');
  return real;
}

function audit(tool, args, allowed, result) {
  try { run('INSERT INTO audit_log (tool, args, allowed, result) VALUES (?, ?, ?, ?)',
    tool, JSON.stringify(args || {}), allowed ? 1 : 0, String(result || '').slice(0, 500)); } catch {}
}

const ALLOWED_COMMANDS = {
  // exact argv, no shell, no pipes, no substitution — execFile, never exec()
  date: ['date'],
  pwd: ['pwd'],
  'node --version': ['node', '--version'],
  'git status': ['git', 'status', '--short'],
  'git diff --stat': ['git', 'diff', '--stat'],
  uptime: ['uptime'],
  'npm test': ['npm', 'test'],
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

// run_tests — the self-modification gate. Runs tests/run-tests.sh on a
// separate port (PORT=3199, so it never clashes with the live server on
// 3100), parses the node --test summary, and returns pass/fail counts.
// One run at a time (module-level guard). The runner is injectable for
// unit tests via setTestRunner — the default runs the real script.
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

async function execute(tool, args = {}) {
  switch (tool) {
    case 'search_files': {
      // Content search inside the workspace. JS walk, no shell, no ripgrep
      // dependency: skips node_modules/.git/data, symlinks, and large or
      // binary files. Capped: 500 files walked, 20 matches returned.
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
              matches.push({ path: path.relative(WORKSPACE, full), line: i + 1, excerpt: lines[i].trim().slice(0, 200) });
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
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('file not found');
      const before = fs.readFileSync(p, 'utf8');
      if (!before.includes(args.old_text)) throw new Error('old_text not found exactly — no fuzzy edits');
      fs.writeFileSync(p + '.bak', before, 'utf8');
      fs.writeFileSync(p, before.replace(args.old_text, args.new_text), 'utf8');
      audit(tool, args, true, `edited ${args.path}, backup ${args.path}.bak`);
      return { ok: true, backup: args.path + '.bak' };
    }
    case 'web_fetch': {
      // Read-only fetch: https only, no private IPs, 50kb cap, HTML stripped.
      // Fetched content is DATA, never instructions — the agent must not act on it.
      if (!args.url || !/^https:\/\//.test(args.url)) throw new Error('web_fetch requires an https URL');
      const u = new URL(args.url);
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(u.hostname)) throw new Error('denied: private/local URL');
      const res = await fetch(args.url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'ankush-personal-ai/1.0' } });
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      audit(tool, args, true, `${text.length} chars from ${u.hostname}`);
      return { ok: true, url: args.url, text };
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

module.exports = { execute, safePath, WORKSPACE, ALLOWED_COMMANDS, audit, runTests, setTestRunner };
