// Ankush's personal AI — server. Full stack, wired up:
//   frontend (public/) + backend (this file) + SQLite database (db.js)
//   + brain (brain.js: Gemini -> Groq -> Ollama) + tools (tools.js)
//   + OpenClaw gateway + goose coding agent (wired in /api/status, skills/goose.md)
// Security (see SECURITY.md / scripts/security-check.sh for the test report):
//   - binds 127.0.0.1 only, never 0.0.0.0; no CORS; security headers
//   - token auth on every /api route except /api/health; token in .env.local
//     (git-ignored, generated on first start if missing), never logged
//   - rate limit 60 req/min/IP on /api/chat and /api/tools
//   - JSON body limit 100kb; input validation on every route
//   - deny-first tools: send/post/spend/delete never execute — they create a
//     pending approval record instead, and approving it still does NOT send
//     anything (a human sends it). Secrets are never read or returned.
//   - prompt injection: outside content is data, never instructions; tool args
//     are validated, paths are confined to the workspace, shell is allowlist-only.
'use strict';
// H1 fix (security audit 12 Nov 2026): refuse to start on a Node below the
// Oct 2026 security fix (CVE-2026-111497, Brotli RCE, CISA KEV 27 Oct 2026).
// Fixed releases: >=24.22.1, >=22.23.4, >=26.12.1.
{
  const [maj, min, pat] = process.versions.node.split('.').map(Number);
  const okNode = (maj === 24 && (min > 22 || (min === 22 && pat >= 1)))
    || (maj === 22 && (min > 23 || (min === 23 && pat >= 4)))
    || (maj === 26 && (min > 12 || (min === 12 && pat >= 1)));
  if (!okNode) {
    console.error(`[personal-ai] REFUSING TO START: Node ${process.versions.node} is below the Oct 2026 security fix (need >=24.22.1, >=22.23.4 or >=26.12.1, CVE-2026-111497)`);
    process.exit(1);
  }
}
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
// goose lives in ~/.local/bin, openclaw in ~/.npm-global/bin — not in the
// default PATH on this VM / on a fresh laptop install. Add both.
process.env.PATH = `${require('os').homedir()}/.local/bin:${require('os').homedir()}/.npm-global/bin:${process.env.PATH}`;

const { all, get, run } = require('./db');
const brain = require('./brain');
const tools = require('./tools');

// --- .env.local (git-ignored) ------------------------------------------------
const ENV_PATH = path.join(__dirname, '.env.local');
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
if (!process.env.ANKU_TOKEN) {
  // H4 fix (security audit 12 Nov 2026): APPEND, never truncate — an existing
  // .env.local may already hold GEMINI_API_KEY / GROQ_API_KEY.
  const token = crypto.randomBytes(32).toString('hex');
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  fs.writeFileSync(ENV_PATH, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + `ANKU_TOKEN=${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(ENV_PATH, 0o600); } catch {}
  process.env.ANKU_TOKEN = token;
  console.log('[personal-ai] generated ANKU_TOKEN in .env.local (git-ignored)');
}

const PORT = Number(process.env.PORT || 3100);
const HOST = '127.0.0.1'; // loopback only — never expose to the internet
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// H5 fix (security audit 12 Nov 2026): rate-limit the whole API, not just
// chat/tools — /api/brain/test can burn free-tier quota and hang for minutes.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'local';
  const list = (hits.get(key) || []).filter(t => now - t < 60000);
  list.push(now);
  hits.set(key, list);
  if (list.length > 60) return res.status(429).json({ ok: false, error: 'rate limit: 60 requests/minute' });
  next();
}
const brainHits = new Map();
function brainRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'local';
  const list = (brainHits.get(key) || []).filter(t => now - t < 60000);
  list.push(now);
  brainHits.set(key, list);
  if (list.length > 10) return res.status(429).json({ ok: false, error: 'rate limit: 10 brain tests/minute' });
  next();
}
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  rateLimit(req, res, next);
});
app.use('/api/brain/test', brainRateLimit);

// --- auth --------------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = req.get('X-Anku-Token');
  if (!token || token !== process.env.ANKU_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorised: X-Anku-Token required' });
  }
  next();
}
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  requireAuth(req, res, next);
});

// --- helpers -----------------------------------------------------------------
const TOOL_LIST = `You can use these tools by returning JSON only:
{"reply":"...","actions":[{"tool":"list_files","args":{"path":"."}},{"tool":"read_file","args":{"path":"AGENT.md"}},{"tool":"write_note","args":{"title":"...","body":"..."}},{"tool":"run_command","args":{"command":"date"}}]}
Allowed tools only: list_files, read_file, write_note, edit_file, web_fetch, run_command (commands: date, pwd, node --version, git status, git diff --stat, uptime, npm test).
Never invent a tool. Never ask to send, post, spend or delete — if the user asks for that, say you created a draft/approval instead and return actions: [].
Return JSON only, no markdown, no extra text.`;

async function agentTurn(userText) {
  // Memory (v1): feed the last 5 messages + matching notes back into the prompt.
  // Recalled text is DATA, never instructions — it cannot authorise a send/spend/delete.
  let memory = '';
  try {
    const recent = all('SELECT role, content FROM messages ORDER BY id DESC LIMIT 5').reverse();
    const notes = all('SELECT title, body FROM notes ORDER BY id DESC LIMIT 5');
    if (recent.length || notes.length) {
      memory = '\nRecent conversation (for context only):\n' + recent.map(m => `${m.role}: ${String(m.content).slice(0, 300)}`).join('\n')
        + '\nSaved notes:\n' + notes.map(n => `${n.title}: ${String(n.body).slice(0, 200)}`).join('\n');
    }
  } catch {}
  const prompt = `You are Ankush's personal AI. You work for Ankush Singh only.
${TOOL_LIST}${memory}
User: ${userText}`;
  let result = await brain.ask(prompt);
  let reply = result.text;
  let actions = [];
  try {
    const parsed = JSON.parse(result.text);
    if (typeof parsed.reply === 'string') reply = parsed.reply;
    if (Array.isArray(parsed.actions)) actions = parsed.actions.slice(0, 5);
  } catch {
    // One retry, asking for JSON only — small models often need the second ask.
    try {
      const retry = await brain.ask(`${prompt}\n\nYour last reply was not valid JSON. Reply with JSON only, in exactly this shape: {"reply":"...","actions":[]}`, result.provider);
      const parsed = JSON.parse(retry.text);
      if (typeof parsed.reply === 'string') reply = parsed.reply;
      if (Array.isArray(parsed.actions)) actions = parsed.actions.slice(0, 5);
      result = retry;
    } catch {
      // Still not JSON — treat the whole text as the reply, run no actions.
    }
  }
  // Independent tools run in parallel (Promise.allSettled, order preserved).
  const settled = await Promise.allSettled(actions.map(a => tools.execute(a.tool, a.args || {})));
  const evidence = settled.map((s, i) => s.status === 'fulfilled'
    ? { tool: actions[i].tool, ok: true, result: JSON.stringify(s.value).slice(0, 2000) }
    : { tool: actions[i].tool, ok: false, error: String(s.reason?.message || s.reason).slice(0, 300) });
  return { reply, model: result.model, provider: result.provider, tried: result.tried, actions: evidence };
}

// --- routes ------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ankush-personal-ai', version: '1.0.0' }));

app.get('/api/status', async (req, res) => {
  const ollama = await brain.ollamaReachable();
  let openclaw = false, goose = '';
  try {
    const r = await fetch('http://127.0.0.1:18789/', { signal: AbortSignal.timeout(3000) });
    openclaw = r.ok;
  } catch {}
  try {
    const { execFile } = require('child_process');
    const os = require('os');
    const gooseBin = fs.existsSync(path.join(os.homedir(), '.local/bin/goose')) ? path.join(os.homedir(), '.local/bin/goose') : 'goose';
    goose = await new Promise(resolve => execFile(gooseBin, ['--version'], { timeout: 10000 },
      (e, out) => resolve(e ? '' : String(out).trim())));
  } catch {}
  res.json({
    ok: true,
    brain_order: ['gemini-direct (gemini-3.6-flash -> gemini-3.5-flash-lite)', 'gemini-vm-helper', 'groq (openai/gpt-oss-120b)', `ollama (${brain.OLLAMA_MODEL})`],
    providers_configured: {
      gemini_direct: !!process.env.GEMINI_API_KEY,
      gemini_vm_helper: fs.existsSync(require('os').homedir() + '/workspace/custom-connectors/custom.gemini/bin/gemini.py'),
      groq: !!process.env.GROQ_API_KEY,
      ollama_models: ollama || false,
    },
    openclaw_gateway_up: openclaw,
    goose_version: goose || 'not found',
    counts: {
      messages: get('SELECT COUNT(*) c FROM messages').c,
      jobs: get('SELECT COUNT(*) c FROM jobs').c,
      notes: get('SELECT COUNT(*) c FROM notes').c,
      approvals_pending: get("SELECT COUNT(*) c FROM approvals WHERE status='pending'").c,
    },
  });
});

app.post('/api/chat', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 4000) return res.status(400).json({ ok: false, error: 'text required, max 4000 chars' });
  try {
    run('INSERT INTO messages (role, content) VALUES (?, ?)', 'user', text);
    const turn = await agentTurn(text);
    run('INSERT INTO messages (role, content, model, provider) VALUES (?, ?, ?, ?)', 'assistant', turn.reply, turn.model, turn.provider);
    const job = run('INSERT INTO jobs (task, status, model, provider, evidence) VALUES (?, ?, ?, ?, ?)',
      text.slice(0, 500), 'done', turn.model, turn.provider, JSON.stringify(turn.actions));
    res.json({ ok: true, job_id: Number(job.lastInsertRowid), reply: turn.reply, model: turn.model, provider: turn.provider, tried: turn.tried, actions: turn.actions });
  } catch (e) {
    run('INSERT INTO jobs (task, status, evidence) VALUES (?, ?, ?)', text.slice(0, 500), 'failed', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/brain/test', async (req, res) => {
  const provider = req.body?.provider; // gemini-direct | gemini-vm-helper | groq | ollama
  const allowed = ['gemini-direct', 'gemini-vm-helper', 'groq', 'ollama'];
  if (provider && !allowed.includes(provider)) return res.status(400).json({ ok: false, error: 'unknown provider' });
  try {
    const r = await brain.ask('Reply with the word OK only.', provider);
    res.json({ ok: true, model: r.model, provider: r.provider, tried: r.tried, text: r.text });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tools', async (req, res) => {
  const { tool, args } = req.body || {};
  if (typeof tool !== 'string') return res.status(400).json({ ok: false, error: 'tool required' });
  try {
    const out = await tools.execute(tool, args || {});
    res.json({ ok: true, ...out });
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
});

app.get('/api/files', (req, res) => {
  try {
    const out = require('./tools').execute('list_files', { path: req.query.path || '.' });
    out.then(r => res.json({ ok: true, ...r })).catch(e => res.status(403).json({ ok: false, error: e.message }));
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
});

app.get('/api/jobs', (req, res) => res.json({ ok: true, jobs: all('SELECT * FROM jobs ORDER BY id DESC LIMIT 50') }));
app.get('/api/messages', (req, res) => res.json({ ok: true, messages: all('SELECT * FROM messages ORDER BY id DESC LIMIT 50') }));
app.get('/api/notes', (req, res) => res.json({ ok: true, notes: all('SELECT * FROM notes ORDER BY id DESC LIMIT 50') }));
app.post('/api/notes', (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ ok: false, error: 'title and body required' });
  const r = run('INSERT INTO notes (title, body) VALUES (?, ?)', String(title).slice(0, 200), String(body).slice(0, 5000));
  res.json({ ok: true, note_id: Number(r.lastInsertRowid) });
});

app.get('/api/approvals', (req, res) => res.json({ ok: true, approvals: all('SELECT * FROM approvals ORDER BY id DESC LIMIT 50') }));
app.post('/api/approvals', (req, res) => {
  const { action, details } = req.body || {};
  if (!action || !details) return res.status(400).json({ ok: false, error: 'action and details required' });
  // Irreversible actions are NEVER executed by the agent. This only records
  // the draft for Ankush to approve — approving still does not send/spend/post.
  const r = run('INSERT INTO approvals (action, details) VALUES (?, ?)', String(action).slice(0, 200), String(details).slice(0, 5000));
  res.json({ ok: true, approval_id: Number(r.lastInsertRowid), status: 'pending', note: 'Draft only — approving does not execute the action. A human sends/posts/spends.' });
});
app.post('/api/approvals/:id/decide', (req, res) => {
  const status = req.body?.status;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ ok: false, error: 'status must be approved or rejected' });
  const row = get('SELECT * FROM approvals WHERE id = ?', Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: 'approval not found' });
  run("UPDATE approvals SET status = ?, decided_at = datetime('now') WHERE id = ?", status, Number(req.params.id));
  res.json({ ok: true, approval_id: row.id, status, executed: false, note: 'Recorded only — no message/email/post/spend was executed.' });
});

app.get('/api/audit', (req, res) => res.json({ ok: true, audit: all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100') }));

app.use((err, req, res, next) => res.status(400).json({ ok: false, error: 'bad request' }));

const server = app.listen(PORT, HOST, () => {
  console.log(`[personal-ai] listening on http://${HOST}:${PORT} (loopback only)`);
  console.log(`[personal-ai] workspace: ${tools.WORKSPACE}`);
});
module.exports = { app, server };
