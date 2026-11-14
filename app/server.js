// Ankush's personal AI — server. Full stack, wired up:
//   frontend (public/) + backend (this file) + SQLite database (db.js)
//   + brain (brain.js: configurable provider chain — default Gemini -> Groq
//     -> Ollama; OpenAI / Anthropic optional via keys in .env.local) + tools (tools.js)
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
// Phases B–E (14 Nov 2026): screen vision + desktop control, phone,
// offline queue + sync, routines, browser use, messaging channels.
const freeze = require('./freeze');
const queue = require('./queue');
const routines = require('./routines');
const sync = require('./sync');
const vision = require('./vision');
const screen = require('./screen');
const desktop = require('./desktop');
const phone = require('./phone');
const browserMod = require('./browser');
const { TelegramBot } = require('./telegram');
const whatsapp = require('./whatsapp');

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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'");
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

// --- auth (timing-safe compare) --------------------------------------------
function requireAuth(req, res, next) {
  const token = req.get('X-Anku-Token') || '';
  const expected = process.env.ANKU_TOKEN || '';
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
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

// Instruction for the native function-calling path (Gemini direct only).
// Same tools, same deny-first rules — but no JSON-only demand, because the
// model calls tools natively instead of printing JSON. The JSON prompt above
// is kept for the text-only fallback providers (VM helper, Groq, Ollama).
const TOOLS_INSTRUCTION = `You have tools you can call when they help answer: list_files, read_file, write_note, edit_file, web_fetch, run_command. Prefer reading a file over guessing its contents. Never invent a tool. Never ask to send, post, spend or delete — if the user asks for that, say you created a draft/approval instead.`;

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
  const textPrompt = `You are Ankush's personal AI. You work for Ankush Singh only.
${TOOL_LIST}${memory}
User: ${userText}`;
  const toolsPrompt = `You are Ankush's personal AI. You work for Ankush Singh only.
${TOOLS_INSTRUCTION}${memory}
User: ${userText}`;
  // Native function calling first (Gemini direct). If it is unavailable, the
  // loop falls back to the text chain and this function parses JSON as before.
  const loop = await brain.agentLoop(toolsPrompt, textPrompt, tools.execute);
  if (loop.usedTools) {
    return { reply: loop.text, model: loop.model, provider: loop.provider, tried: loop.tried, actions: loop.evidence };
  }
  let result = { text: loop.text, model: loop.model, provider: loop.provider, tried: loop.tried };
  let reply = result.text;
  let actions = [];
  try {
    const parsed = JSON.parse(result.text);
    if (typeof parsed.reply === 'string') reply = parsed.reply;
    if (Array.isArray(parsed.actions)) actions = parsed.actions.slice(0, 5);
  } catch {
    // One retry, asking for JSON only — small models often need the second ask.
    try {
      const retry = await brain.ask(`${textPrompt}\n\nYour last reply was not valid JSON. Reply with JSON only, in exactly this shape: {"reply":"...","actions":[]}`, result.provider);
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
    // brain_order is the resolved chain for the next turn: BRAIN_PROVIDERS
    // order (or the default order), with providers that have no key skipped.
    // providers_configured reports only whether a key is set, never the key.
    brain_order: brain.resolveOrder(),
    providers_configured: {
      gemini_direct: !!process.env.GEMINI_API_KEY,
      gemini_vm_helper: fs.existsSync(require('os').homedir() + '/workspace/custom-connectors/custom.gemini/bin/gemini.py'),
      groq: !!process.env.GROQ_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      ollama_models: ollama || false,
    },
    openclaw_gateway_up: openclaw,
    goose_version: goose || 'not found',
    frozen: freeze.freezeState(),
    queue: queue.counts(),
    routines: { total: get('SELECT COUNT(*) c FROM routines').c, enabled: get('SELECT COUNT(*) c FROM routines WHERE enabled = 1').c },
    phone_session: phone.sessionState(),
    capabilities: {
      screen_capture: screen.capability(),
      desktop_agent: desktop.capability(),
      browser: browserMod.capability(),
      telegram: new TelegramBot().status(),
      whatsapp: whatsapp.status(),
    },
    counts: {
      messages: get('SELECT COUNT(*) c FROM messages').c,
      jobs: get('SELECT COUNT(*) c FROM jobs').c,
      notes: get('SELECT COUNT(*) c FROM notes').c,
      approvals_pending: get("SELECT COUNT(*) c FROM approvals WHERE status='pending'").c,
    },
  });
});

let chatInFlight = 0;
app.post('/api/chat', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 4000) return res.status(400).json({ ok: false, error: 'text required, max 4000 chars' });
  // Concurrency cap (audit M5): at most 2 agent turns at once — a brain turn
  // can take minutes on a slow local model and burn free-tier quota.
  if (chatInFlight >= 2) return res.status(429).json({ ok: false, error: 'busy: 2 agent turns already running, try again in a moment' });
  chatInFlight++;
  try {
    run('INSERT INTO messages (role, content) VALUES (?, ?)', 'user', text);
    const turn = await agentTurn(text);
    run('INSERT INTO messages (role, content, model, provider) VALUES (?, ?, ?, ?)', 'assistant', turn.reply, turn.model, turn.provider);
    const job = run('INSERT INTO jobs (task, status, model, provider, evidence) VALUES (?, ?, ?, ?, ?)',
      text.slice(0, 500), 'done', turn.model, turn.provider, JSON.stringify(turn.actions));
    res.json({ ok: true, job_id: Number(job.lastInsertRowid), reply: turn.reply, model: turn.model, provider: turn.provider, tried: turn.tried, actions: turn.actions });
  } catch (e) {
    run('INSERT INTO jobs (task, status, evidence) VALUES (?, ?, ?)', text.slice(0, 500), 'failed', 'brain failed');
    console.error('[personal-ai] chat failed:', e.message);
    res.status(500).json({ ok: false, error: 'brain failed — try again, or check the server log' });
  } finally {
    chatInFlight--;
  }
});

app.post('/api/brain/test', async (req, res) => {
  const provider = req.body?.provider; // gemini-direct | gemini-vm-helper | groq | openai | anthropic | ollama
  const allowed = ['gemini-direct', 'gemini-vm-helper', 'groq', 'openai', 'anthropic', 'ollama'];
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

// --- freeze: the instant stop control ---------------------------------------
app.get('/api/freeze', (req, res) => res.json({ ok: true, ...freeze.freezeState() }));
app.post('/api/freeze', (req, res) => {
  const frozen = req.body?.frozen;
  if (typeof frozen !== 'boolean') return res.status(400).json({ ok: false, error: 'frozen must be a boolean' });
  res.json({ ok: true, ...freeze.setFrozen(frozen, req.body?.reason) });
});

// --- offline queue (Phase D) -------------------------------------------------
app.get('/api/queue', (req, res) => res.json({ ok: true, counts: queue.counts(), items: queue.list(50) }));
app.post('/api/queue', (req, res) => {
  const { kind, payload, maxAttempts } = req.body || {};
  try {
    const id = queue.enqueue(kind, payload || {}, { maxAttempts });
    res.json({ ok: true, outbox_id: id, status: 'pending' });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Default outbox worker: dispatches queued kinds to the real handlers.
// brain_call / web_fetch run through the same deny-first paths as a chat
// turn. sync_push needs SYNC_PEER_URL + SYNC_TOKEN (the cloud node behind
// Tailscale) — without them it fails visibly and retries, then goes dead.
async function defaultOutboxWorker(kind, payload) {
  if (kind === 'brain_call') {
    const r = await brain.ask(String(payload.prompt || ''), payload.only);
    run('INSERT INTO jobs (task, status, model, provider, evidence) VALUES (?, ?, ?, ?, ?)',
      `[queued brain_call] ${String(payload.prompt || '').slice(0, 400)}`, 'done', r.model, r.provider, JSON.stringify({ text: r.text.slice(0, 2000) }));
    return r;
  }
  if (kind === 'web_fetch') {
    const out = await tools.execute('web_fetch', { url: payload.url });
    run('INSERT INTO jobs (task, status, evidence) VALUES (?, ?, ?)', `[queued web_fetch] ${payload.url}`, 'done', JSON.stringify(out).slice(0, 2000));
    return out;
  }
  if (kind === 'sync_push') {
    const peer = process.env.SYNC_PEER_URL;
    const token = process.env.SYNC_TOKEN;
    if (!peer || !token) throw new Error('no sync peer configured — set SYNC_PEER_URL + SYNC_TOKEN (cloud node behind Tailscale)');
    const records = sync.recordsSince(payload.since || null);
    const r = await fetch(peer.replace(/\/$/, '') + '/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anku-Token': token },
      body: JSON.stringify({ device_id: sync.thisDeviceId(), records }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`sync peer HTTP ${r.status}`);
    return r.json();
  }
  if (kind === 'routine_run') {
    const routine = routines.getRoutine(Number(payload.routine_id));
    if (!routine) throw new Error('routine not found');
    return routines.runRoutine(routine, routineRunner);
  }
  if (kind === 'notify') {
    const r = run('INSERT INTO notes (title, body) VALUES (?, ?)', String(payload.title || 'notification').slice(0, 200), String(payload.body || '').slice(0, 5000));
    return { note_id: Number(r.lastInsertRowid) };
  }
  throw new Error(`no worker for outbox kind: ${kind}`);
}
app.post('/api/queue/drain', async (req, res) => {
  const limit = Number(req.body?.limit || 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return res.status(400).json({ ok: false, error: 'limit must be an integer 1..50' });
  const result = await queue.drain(defaultOutboxWorker, { limit });
  res.json({ ok: true, ...result });
});

// --- routines (Phase E) -------------------------------------------------------
async function routineRunner(task, scope) {
  const turn = await agentTurn(task + (scope ? `\nScope: ${scope}` : ''));
  return { reply: turn.reply, model: turn.model, provider: turn.provider, actions: turn.actions };
}
app.get('/api/routines', (req, res) => res.json({ ok: true, routines: routines.listRoutines() }));
app.post('/api/routines', (req, res) => {
  try {
    const r = routines.createRoutine(req.body || {});
    res.json({ ok: true, routine: r });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.patch('/api/routines/:id', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled must be a boolean' });
  try { res.json({ ok: true, routine: routines.setEnabled(Number(req.params.id), enabled) }); }
  catch (e) { res.status(404).json({ ok: false, error: e.message }); }
});
app.delete('/api/routines/:id', (req, res) => {
  try { res.json({ ok: true, ...routines.deleteRoutine(Number(req.params.id)) }); }
  catch (e) { res.status(404).json({ ok: false, error: e.message }); }
});
app.post('/api/routines/:id/run', async (req, res) => {
  const routine = routines.getRoutine(Number(req.params.id));
  if (!routine) return res.status(404).json({ ok: false, error: 'routine not found' });
  const out = await routines.runRoutine(routine, routineRunner, { dryRun: req.body?.dry_run === true });
  res.json({ ok: true, ...out });
});
app.get('/api/routines/:id/runs', (req, res) => {
  const routine = routines.getRoutine(Number(req.params.id));
  if (!routine) return res.status(404).json({ ok: false, error: 'routine not found' });
  res.json({ ok: true, runs: routines.listRuns(routine.id) });
});

// --- screen vision + desktop control (Phase B) -------------------------------
app.post('/api/screen/capture', async (req, res) => {
  try {
    const shot = await screen.captureScreenshot();
    res.json({ ok: true, hash: shot.hash, width: shot.width, height: shot.height, mimeType: shot.mimeType, imageBase64: shot.buffer.toString('base64') });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.post('/api/screen/act', async (req, res) => {
  try {
    const client = new desktop.DesktopAgentClient({});
    const out = await client.act(req.body?.action || {}, { approvalId: req.body?.approval_id });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
});
app.post('/api/screen/loop', async (req, res) => {
  const task = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
  if (!task || task.length > 4000) return res.status(400).json({ ok: false, error: 'task required, max 4000 chars' });
  const client = new desktop.DesktopAgentClient({});
  try {
    const out = await desktop.screenLoop(task, {
      capture: async () => {
        // Prefer the desktop agent's screenshot; fall back to local capture.
        try {
          const s = await client.screenshot();
          const buf = Buffer.from(s.imageBase64, 'base64');
          return { buffer: buf, hash: screen.hashBuffer(buf) };
        } catch {
          return screen.captureScreenshot();
        }
      },
      ground: async (t, imageBase64) => (await vision.groundAction(t, imageBase64, 'image/png')).action,
      act: (a) => client.act(a, { approvalId: req.body?.approval_id }),
    }, { maxActions: req.body?.max_actions, approvalId: req.body?.approval_id });
    run('INSERT INTO jobs (task, status, model, provider, evidence) VALUES (?, ?, ?, ?, ?)',
      `[screen loop] ${task}`.slice(0, 500), out.done ? 'done' : 'stopped', null, null, JSON.stringify({ stopReason: out.stopReason, steps: out.steps, latencies: out.latencies }).slice(0, 5000));
    res.json({ ok: true, ...out });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// --- phone (Phase C) -----------------------------------------------------------
app.get('/api/phone', async (req, res) => {
  const driver = new phone.AdbDriver({});
  res.json({ ok: true, android: await driver.capability(), ios: phone.IOS, session: phone.sessionState() });
});
app.post('/api/phone/enable', (req, res) => {
  try { res.json({ ok: true, session: phone.enableSession({ ttlMs: req.body?.ttl_ms, reason: req.body?.reason }) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/phone/disable', (req, res) => res.json({ ok: true, session: phone.disableSession() }));
app.post('/api/phone/act', async (req, res) => {
  try {
    const driver = new phone.AdbDriver({});
    const r = await driver.run(req.body?.action || {});
    const stdout = Buffer.isBuffer(r.stdout) ? r.stdout.toString('base64') : String(r.stdout || '');
    res.json({ ok: true, stdout_base64: stdout.slice(0, 20000) });
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
});

// --- browser use ---------------------------------------------------------------
app.get('/api/browser', (req, res) => res.json({ ok: true, ...browserMod.capability() }));
app.post('/api/browser/act', async (req, res) => {
  const agent = new browserMod.BrowserAgent({});
  try {
    const out = await agent.act(req.body?.action || {});
    res.json({ ok: true, ...out });
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
  finally { await agent.close(); }
});

// --- sync (Phase D) -------------------------------------------------------------
app.post('/api/sync/push', (req, res) => {
  const { device_id, records } = req.body || {};
  if (typeof device_id !== 'string' || !device_id || !records || typeof records !== 'object') {
    return res.status(400).json({ ok: false, error: 'device_id and records required' });
  }
  const result = sync.mergeIncoming(records, device_id.slice(0, 100));
  res.json({ ok: true, ...result });
});
app.get('/api/sync/pull', (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  res.json({ ok: true, device_id: sync.thisDeviceId(), records: sync.recordsSince(since) });
});
app.get('/api/sync/conflicts', (req, res) => res.json({ ok: true, conflicts: sync.listConflicts(50) }));

// --- messaging channels: status only (Telegram polls inside the server when
// a token exists; WhatsApp starts manually — QR scan, spare number only) -------
app.get('/api/channels', (req, res) => res.json({
  ok: true,
  telegram: telegramBot ? telegramBot.status() : new TelegramBot().status(),
  whatsapp: whatsapp.status(),
}));

app.use((err, req, res, next) => res.status(400).json({ ok: false, error: 'bad request' }));

// --- scheduler: routines tick + outbox drain, every 60s ----------------------
// No-ops when there are no routines and an empty outbox. Disabled with
// DISABLE_SCHEDULER=1 (tests / debugging). Both respect freeze.
let schedulerTimer = null;
if (process.env.DISABLE_SCHEDULER !== '1') {
  schedulerTimer = setInterval(async () => {
    try { await routines.tick(routineRunner); } catch (e) { console.error('[personal-ai] routine tick failed:', e.message); }
    try { await queue.drain(defaultOutboxWorker, { limit: 10 }); } catch (e) { console.error('[personal-ai] queue drain failed:', e.message); }
  }, 60000);
  schedulerTimer.unref();
}

// --- Telegram bot (phone-as-remote): polls only when a token exists ---------
let telegramBot = null;
if (process.env.TELEGRAM_ENABLED !== 'no') {
  const bot = new TelegramBot({
    handlers: {
      onMessage: async (text) => {
        const turn = await agentTurn(text);
        run('INSERT INTO messages (role, content, model, provider) VALUES (?, ?, ?, ?)', 'assistant', turn.reply, turn.model, turn.provider);
        return turn.reply;
      },
      getStatus: async () => ({
        brain_order: brain.resolveOrder(),
        frozen: freeze.isFrozen(),
        queue: queue.counts(),
        approvals_pending: get("SELECT COUNT(*) c FROM approvals WHERE status='pending'").c,
      }),
      decideApproval: async (id, status) => {
        const row = get('SELECT * FROM approvals WHERE id = ?', id);
        if (!row) return { error: 'approval not found' };
        run("UPDATE approvals SET status = ?, decided_at = datetime('now') WHERE id = ?", status, id);
        return { ok: true };
      },
      setFrozen: (frozen, reason) => freeze.setFrozen(frozen, reason),
      freezeState: () => freeze.freezeState(),
    },
  });
  if (bot.enabled) {
    telegramBot = bot;
    try { bot.start(); console.log('[personal-ai] telegram bot polling started'); }
    catch (e) { console.error('[personal-ai] telegram bot failed to start:', e.message); }
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[personal-ai] listening on http://${HOST}:${PORT} (loopback only)`);
  console.log(`[personal-ai] workspace: ${tools.WORKSPACE}`);
});
module.exports = { app, server, agentTurn, routineRunner, defaultOutboxWorker, schedulerTimer, telegramBot };
