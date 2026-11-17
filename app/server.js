// Ankush's personal AI — server. Full stack, wired up:
//   frontend (public/) + backend (this file) + SQLite database (db.js)
//   + brain (brain.js: configurable provider chain — default Gemini -> Groq
//     -> Ollama; OpenAI / Anthropic optional via keys in .env.local) + tools (tools.js)
//   + OpenClaw gateway + goose coding agent (wired in /api/status, skills/goose/SKILL.md)
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

const { all, get, run, getSetting, setSetting } = require('./db');
const brain = require('./brain');
const tools = require('./tools');
// Skills (cycle 3): curated, human-approved workflows, progressively
// disclosed — short index in every prompt, full body only when matched.
const skills = require('./skills');
// Memory v2 (cycle 4): timestamped facts with contradiction history,
// scoped recall, hard-delete forget. Local-only, never synced.
const memory = require('./memory');
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
const computerUseMod = require('./computer-use');
const { TelegramBot } = require('./telegram');
const whatsapp = require('./whatsapp');
// Product expansion (14 Nov 2026): settings/API keys, notifications,
// replay log, fast routing, secret handling.
const settings = require('./settings');
const notifyMod = require('./notify');
const replay = require('./replay');
const routeMod = require('./route');
const { redact } = require('./secrets');

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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'");
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// H5 fix (security audit 12 Nov 2026): rate-limit the whole API, not just
// chat/tools — /api/brain/test can burn free-tier quota and hang for minutes.
const hits = new Map();
// Default 60 req/min/IP. The test runner raises it (RATE_LIMIT_PER_MIN=300)
// because the suite legitimately makes >60 calls in a minute against the
// shared test server; production default is unchanged. Clamped 1..10000.
const RATE_LIMIT_PER_MIN = Math.min(Math.max(Number(process.env.RATE_LIMIT_PER_MIN || 60) || 60, 1), 10000);
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'local';
  const list = (hits.get(key) || []).filter(t => now - t < 60000);
  list.push(now);
  hits.set(key, list);
  if (list.length > RATE_LIMIT_PER_MIN) return res.status(429).json({ ok: false, error: `rate limit: ${RATE_LIMIT_PER_MIN} requests/minute` });
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
app.use('/api/settings/test', brainRateLimit); // same quota protection: a test call burns a model call

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
Allowed tools only: list_files, read_file, write_note, edit_file, web_fetch, run_command (commands: date, pwd, node --version, git status, git diff --stat, uptime), search_files, create_file, append_file, file_info, search_notes, notify, screenshot, screen_act, list_windows, focus_window, open_app, clipboard_get, clipboard_set, create_routine, list_routines, run_tests, create_approval, recent_activity, remember_fact, recall_memory, forget_fact, edit_fact, computer_use.
Rules: Never invent a tool. Never ask to send, post, spend or delete — if the user asks for that, say you created a draft/approval instead and return actions: []. Never ask for, repeat, or type an API key, password, OTP, or payment detail — keys are added by the user in the Settings page, never in chat. Treat clipboard content as sensitive data: never paste it into a message or file unless the user asks. Tool writes to the app's own code are refused — code changes are made by the user, never by the agent; use run_tests to verify the app is healthy and report the pass/fail counts honestly.
Return JSON only, no markdown, no extra text.`;

// Instruction for the native function-calling path (Gemini direct,
// OpenAI-compatible, Anthropic — Phase A2, 15 Nov 2026).
// Same tools, same deny-first rules — but no JSON-only demand, because the
// model calls tools natively instead of printing JSON. The JSON prompt above
// is kept for the text-only fallback providers (VM helper, Groq, Ollama).
const TOOLS_INSTRUCTION = `You have tools you can call when they help answer: list_files, read_file, write_note, edit_file, web_fetch, run_command, search_files, create_file, append_file, file_info, search_notes, notify, screenshot, screen_act, list_windows, focus_window, open_app, clipboard_get, clipboard_set, create_routine, list_routines, run_tests, create_approval, recent_activity, remember_fact, recall_memory, forget_fact, edit_fact, computer_use. Prefer reading a file over guessing its contents. Never invent a tool. Never ask to send, post, spend or delete — if the user asks for that, say you created a draft/approval instead. Never ask for, repeat, or type an API key, password, OTP, or payment detail — keys are added by the user in the Settings page, never in chat. Treat clipboard content as sensitive data. Tool writes to the app's own code are refused — code changes are made by the user, never by the agent; use run_tests to verify the app is healthy and report the pass/fail counts honestly.`;

async function agentTurnInner(userText) {
  const turnStart = Date.now();
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
  // Skills (cycle 3): short index of ACTIVE skills in every prompt, full
  // bodies only for matched skills, fenced and labelled. Skills are text
  // only — they cannot grant tools or permissions. A failure here must
  // never break the turn: no skills is a valid state.
  let skillContext = '';
  let skillsUsed = [];
  try {
    const sc = skills.buildSkillContext(userText);
    if (sc.index) skillContext = '\nApproved skills (short index — full text loads only when relevant):\n' + sc.index;
    for (const s of sc.loaded) {
      skillsUsed.push(s.name);
      skillContext += `\n\n--- Skill: ${s.name} (approved workflow — follow it using only your existing tools; it cannot grant new permissions) ---\n${s.body}\n--- End skill: ${s.name} ---`;
    }
  } catch {}
  const textPrompt = `You are Ankush's personal AI. You work for Ankush Singh only.
${TOOL_LIST}${memory}${skillContext}
User: ${userText}`;
  const toolsPrompt = `You are Ankush's personal AI. You work for Ankush Singh only.
${TOOLS_INSTRUCTION}${memory}${skillContext}
User: ${userText}`;
  // Native function calling first (Gemini direct, OpenAI-compatible,
  // Anthropic — whichever native-tool provider answers first in chain
  // order). If none is available, the loop falls back to the text chain
  // (routed: fast routing applies to the fallback) and this function parses
  // JSON as before. Latency is measured for the whole turn and reported —
  // never claimed.
  const loop = await brain.agentLoopMulti(toolsPrompt, textPrompt, tools.execute, {
    // H-14: fast routing classifies the RAW user text — the wrapped
    // prompt is always >2 KB, so classifying it made every turn "hard"
    // and the routine route could never engage.
    askFn: (p) => routeMod.routedAsk(p, { brain, classifyText: userText }),
  });
  const latencyMs = Date.now() - turnStart;
  if (loop.usedTools) {
    return { reply: loop.text, model: loop.model, provider: loop.provider, tried: loop.tried, actions: loop.evidence, latencyMs, skills: skillsUsed, usage: loop.usage || null };
  }
  let result = { text: loop.text, model: loop.model, provider: loop.provider, tried: loop.tried, usage: loop.usage || null };
  let reply = result.text;
  let actions = [];
  const routeInfo = { route: loop.route, fellBack: loop.fellBack };
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
  return { reply, model: result.model, provider: result.provider, tried: result.tried, actions: evidence, route: routeInfo.route, fellBack: routeInfo.fellBack, latencyMs: Date.now() - turnStart, skills: skillsUsed, usage: result.usage || null };
}

// Turn budget (H-11): TURN_BUDGET_MS bounds a whole agent turn. Default
// 240 s — under Node's 300 s request timeout, so the HTTP response is
// never dropped while work continues holding a slot. Clamped 30..290 s.
function turnBudgetMs() {
  const n = Number(process.env.TURN_BUDGET_MS || 240000);
  if (!Number.isFinite(n)) return 240000;
  return Math.min(Math.max(Math.floor(n), 30000), 290000);
}

// agentTurn — the single entry point for every agent turn (chat,
// Telegram, routines, queue). Three guards live here so no caller can
// bypass them:
//   M-1 freeze: a frozen agent refuses the turn outright (423 on chat).
//   M-19 cap: at most 2 turns at once, shared by ALL callers — the old
//     cap lived only on /api/chat, so Telegram/routines/queue bypassed it.
//   H-11 budget: the whole turn races a deadline; on timeout the caller
//     gets an honest 504 and the turn slot is freed (the underlying
//     provider calls end on their own 60 s timeouts).
// Errors carry .code ('TURNS_BUSY' / 'TURN_BUDGET') so HTTP callers can
// map them to 429 / 504; the freeze error message starts with 'frozen:'.
let turnsInFlight = 0;
async function agentTurn(userText) {
  freeze.assertNotFrozen();
  if (turnsInFlight >= 2) {
    const e = new Error('busy: 2 agent turns already running, try again in a moment');
    e.code = 'TURNS_BUSY';
    throw e;
  }
  turnsInFlight++;
  try {
    return await brain.withDeadline(agentTurnInner(userText), turnBudgetMs(), 'chat turn');
  } catch (e) {
    if (/exceeded its budget/.test(e.message)) e.code = 'TURN_BUDGET';
    throw e;
  } finally {
    turnsInFlight--;
  }
}

// --- routes ------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ankush-personal-ai', version: '1.0.0' }));

// H-12: /api/status used to re-run `goose --version` (6.2 s) sequentially
// on every call, after a sequential Ollama + OpenClaw check. The goose
// version never changes while the server runs, so it is resolved once
// and cached for the process lifetime; the Ollama model list is cached
// for 30 s; all three checks run in parallel. A failed check resolves
// to its "not found" value — status must never fail because a probe did.
let gooseVersionCache = null;
async function getGooseVersion() {
  if (gooseVersionCache !== null) return gooseVersionCache;
  try {
    const { execFile } = require('child_process');
    const os = require('os');
    const gooseBin = fs.existsSync(path.join(os.homedir(), '.local/bin/goose')) ? path.join(os.homedir(), '.local/bin/goose') : 'goose';
    gooseVersionCache = await new Promise(resolve => execFile(gooseBin, ['--version'], { timeout: 10000 },
      (e, out) => resolve(e ? '' : String(out).trim())));
  } catch { gooseVersionCache = ''; }
  return gooseVersionCache;
}
let ollamaCache = { at: 0, value: false };
async function cachedOllamaReachable() {
  if (Date.now() - ollamaCache.at < 30000) return ollamaCache.value;
  const v = await brain.ollamaReachable();
  ollamaCache = { at: Date.now(), value: v };
  return v;
}
async function checkOpenClaw() {
  try {
    const r = await fetch('http://127.0.0.1:18789/', { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

app.get('/api/status', async (req, res) => {
  const [ollama, openclaw, goose] = await Promise.all([cachedOllamaReachable(), checkOpenClaw(), getGooseVersion()]);
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
      notifications_unread: notifyMod.unreadCount(),
      replay_sessions: get('SELECT COUNT(*) c FROM screen_sessions').c,
    },
    fast_routing: routeMod.routingEnabled(),
    sync: {
      peer_configured: !!(process.env.SYNC_PEER_URL && process.env.SYNC_TOKEN),
      last_push_sent: getSetting('last_sync_push_sent'),
      last_push_received: getSetting('last_sync_push_received'),
      last_pull: getSetting('last_sync_pull'),
      conflicts: get('SELECT COUNT(*) c FROM sync_conflicts').c,
    },
  });
});

app.post('/api/chat', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 4000) return res.status(400).json({ ok: false, error: 'text required, max 4000 chars' });
  // The 2-turn concurrency cap lives in agentTurn (M-19) so chat,
  // Telegram, routines and the queue share it; the turn budget (H-11)
  // and freeze gate (M-1) live there too. This route only maps the
  // guard errors to honest HTTP statuses.
  try {
    run('INSERT INTO messages (role, content) VALUES (?, ?)', 'user', text);
    const turn = await agentTurn(text);
    run('INSERT INTO messages (role, content, model, provider) VALUES (?, ?, ?, ?)', 'assistant', turn.reply, turn.model, turn.provider);
    const job = run('INSERT INTO jobs (task, status, model, provider, evidence) VALUES (?, ?, ?, ?, ?)',
      text.slice(0, 500), 'done', turn.model, turn.provider, JSON.stringify({ actions: turn.actions, latencyMs: turn.latencyMs, route: turn.route, fellBack: turn.fellBack, skills: turn.skills, usage: turn.usage || null }));
    res.json({ ok: true, job_id: Number(job.lastInsertRowid), reply: turn.reply, model: turn.model, provider: turn.provider, tried: turn.tried, actions: turn.actions, route: turn.route, latencyMs: turn.latencyMs, skills: turn.skills, usage: turn.usage || null });
  } catch (e) {
    run('INSERT INTO jobs (task, status, evidence) VALUES (?, ?, ?)', text.slice(0, 500), 'failed', 'brain failed');
    console.error('[personal-ai] chat failed:', e.message);
    if (e.code === 'TURNS_BUSY') return res.status(429).json({ ok: false, error: e.message });
    if (e.code === 'TURN_BUDGET') return res.status(504).json({ ok: false, error: 'turn exceeded its time budget — try a shorter request' });
    if (/^frozen:/.test(e.message)) return res.status(423).json({ ok: false, error: e.message });
    res.status(500).json({ ok: false, error: 'brain failed — try again, or check the server log' });
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
  // M-1: freeze gates direct tool calls too — a frozen agent executes
  // nothing, through any entry point.
  if (freeze.isFrozen()) return res.status(423).json({ ok: false, error: 'frozen: agent stopped by user — unfreeze to resume' });
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

// Memory v2 (cycle 4): user-visible fact controls. GET lists (JSON export
// is this endpoint), POST remembers, PUT edits, DELETE forgets (by id,
// or by ?topic= for a whole topic). All scoped; default scope 'default'.
// Errors from memory.js validation surface as 400 with the message.
app.get('/api/memory', (req, res) => {
  try {
    const facts = memory.listFacts({ scope: req.query.scope, includeSuperseded: req.query.include_superseded === '1', limit: req.query.limit });
    res.json({ ok: true, facts });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/memory', (req, res) => {
  try {
    const r = memory.remember({ scope: req.body.scope, topic: req.body.topic, content: req.body.content, source: req.body.source || 'ui' });
    res.json({ ok: true, fact_id: r.id, duplicate: r.duplicate, superseded: r.superseded });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/memory/:id', (req, res) => {
  try {
    const r = memory.editFact({ scope: req.body.scope, id: req.params.id, content: req.body.content, topic: req.body.topic });
    res.json({ ok: true, fact_id: r.id, previous_id: r.previous_id, unchanged: r.unchanged });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/memory/:id', (req, res) => {
  try {
    const r = memory.forget({ scope: req.query.scope, id: req.params.id });
    res.json({ ok: true, forgotten: r.forgotten, id: r.id || null });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/memory', (req, res) => {
  try {
    if (!req.query.topic) return res.status(400).json({ ok: false, error: 'topic required (or DELETE /api/memory/:id)' });
    const r = memory.forget({ scope: req.query.scope, topic: req.query.topic });
    res.json({ ok: true, forgotten: r.forgotten, topic: r.topic });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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

// Skills (cycle 3): read-only list with status. Bodies are never returned
// — the agent loads them server-side when matched. There is deliberately
// NO write endpoint: approval is a human act in the repo (see docs/SKILLS.md).
app.get('/api/skills', (req, res) => res.json({ ok: true, skills: skills.listSkills() }));

// Hash-chain verification + run receipts (cycle 2). Both are read-only and
// behind the same token auth as every other /api route.
app.get('/api/audit/verify', (req, res) => {
  const { verifyAuditChain } = require('./audit');
  res.json({ ok: true, ...verifyAuditChain() });
});
app.get('/api/audit/receipt', (req, res) => {
  const { buildReceipt, renderReceiptMarkdown } = require('./audit');
  const receipt = buildReceipt({
    runId: req.query.run_id || null,
    fromId: req.query.from_id ? Number(req.query.from_id) : null,
    toId: req.query.to_id ? Number(req.query.to_id) : null,
  });
  if (req.query.format === 'md') return res.type('text/markdown').send(renderReceiptMarkdown(receipt));
  res.json({ ok: true, receipt });
});

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
    setSetting('last_sync_push_sent', new Date().toISOString());
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
    tools.audit('screen.act', { action: req.body?.action?.action }, true, 'screen action ok');
    res.json({ ok: true, ...out });
  } catch (e) {
    tools.audit('screen.act', { action: req.body?.action?.action }, false, String(e.message).slice(0, 200));
    res.status(403).json({ ok: false, error: e.message });
  }
});
app.post('/api/screen/loop', async (req, res) => {
  const task = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
  if (!task || task.length > 4000) return res.status(400).json({ ok: false, error: 'task required, max 4000 chars' });
  // M-21: max_actions is validated, not coerced. "abc"/-5 used to return
  // a 200 zero-step "success" + a replay row; huge values ran an
  // unbounded vision loop. Omitted = desktop default (20).
  let maxActions;
  if (req.body?.max_actions !== undefined && req.body?.max_actions !== null) {
    maxActions = Number(req.body.max_actions);
    if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 50) {
      return res.status(400).json({ ok: false, error: 'max_actions must be an integer 1..50' });
    }
  }
  const client = new desktop.DesktopAgentClient({});
  // Replay recorder: every step's observation + action is recorded locally
  // (data/shots/, git-ignored). A recorder failure never breaks the loop.
  let recorder = null;
  try { recorder = replay.createRecorder(task, { device: 'desktop' }); } catch (e) { console.error('[personal-ai] replay recorder failed to start:', e.message); }
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
    }, { maxActions, approvalId: req.body?.approval_id, recorder });
    try { recorder?.finish(out.done ? 'done' : 'stopped'); } catch {}
    run('INSERT INTO jobs (task, status, model, provider, evidence) VALUES (?, ?, ?, ?, ?)',
      `[screen loop] ${task}`.slice(0, 500), out.done ? 'done' : 'stopped', null, null, JSON.stringify({ stopReason: out.stopReason, steps: out.steps, latencies: out.latencies, replaySessionId: recorder?.sessionId }).slice(0, 5000));
    res.json({ ok: true, replay_session_id: recorder?.sessionId || null, ...out });
  } catch (e) {
    try { recorder?.finish('failed'); } catch {}
    res.status(503).json({ ok: false, error: e.message });
  }
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

// --- computer use: stateful browser sessions + desktop input ---------------
app.get('/api/computer-use/status', (req, res) => {
  try { res.json({ ok: true, ...computerUseMod.getComputerUse().status() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/computer-use/act', async (req, res) => {
  try {
    const out = await computerUseMod.getComputerUse().act({ ...(req.body || {}), allowLoopback: false });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
});
app.post('/api/computer-use/flow', async (req, res) => {
  try {
    const out = await computerUseMod.getComputerUse().runFlow(req.body?.steps || [], { session: req.body?.session, budgetMs: req.body?.budgetMs });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
});

// --- sync (Phase D) -------------------------------------------------------------
app.post('/api/sync/push', (req, res) => {
  const { device_id, records } = req.body || {};
  if (typeof device_id !== 'string' || !device_id || !records || typeof records !== 'object') {
    return res.status(400).json({ ok: false, error: 'device_id and records required' });
  }
  const result = sync.mergeIncoming(records, device_id.slice(0, 100));
  setSetting('last_sync_push_received', new Date().toISOString());
  res.json({ ok: true, ...result });
});
app.get('/api/sync/pull', (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  setSetting('last_sync_pull', new Date().toISOString());
  res.json({ ok: true, device_id: sync.thisDeviceId(), records: sync.recordsSince(since) });
});
app.get('/api/sync/conflicts', (req, res) => res.json({ ok: true, conflicts: sync.listConflicts(50) }));
app.get('/api/sync/status', (req, res) => res.json({
  ok: true,
  device_id: sync.thisDeviceId(),
  peer_configured: !!(process.env.SYNC_PEER_URL && process.env.SYNC_TOKEN),
  peer_url: process.env.SYNC_PEER_URL || null,
  last_push_sent: getSetting('last_sync_push_sent'),
  last_push_received: getSetting('last_sync_push_received'),
  last_pull: getSetting('last_sync_pull'),
  conflicts: get('SELECT COUNT(*) c FROM sync_conflicts').c,
  synced_tables: sync.SYNC_TABLES,
  never_synced: ['notifications', 'screen_sessions', 'screen_steps', 'settings', 'outbox', 'audit_log'],
  note: 'Screenshots and keys never sync. Only messages, jobs, notes, and approvals sync, last-write-wins.',
}));

// --- settings: API keys + provider order + channels (loopback + token auth)
// Keys are written to .env.local (git-ignored, mode 600) via settings.js and
// mirrored into process.env — no restart needed. Responses carry masked
// previews (last 4 chars) only, never full keys. ANKU_TOKEN is not settable.
app.get('/api/settings/providers', (req, res) => res.json({
  ok: true,
  providers: settings.getProviderStatus(),
  order: settings.getOrder(),
  // H-5: the editable order input must be pre-filled with the CONFIGURED
  // order (what the user saved), not the resolved chain (key-holders
  // only) — saving the resolved chain silently dropped unconfigured
  // providers. `order` stays as the resolved chain for display.
  configured_order: settings.getConfiguredOrder(),
  channels: settings.getChannelStatus(),
  fast_routing: routeMod.routingEnabled(),
  guide: 'docs/API-KEYS.md — where to get free keys, what each tier gives',
}));
app.post('/api/settings/providers', (req, res) => {
  const updates = req.body?.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ ok: false, error: 'updates object required, e.g. {"GEMINI_API_KEY": "…"} — empty string removes a key' });
  }
  try {
    const changed = settings.writeEnvUpdates(updates);
    res.json({ ok: true, changed, providers: settings.getProviderStatus(), order: settings.getOrder(), configured_order: settings.getConfiguredOrder(), channels: settings.getChannelStatus() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/settings/order', (req, res) => {
  const order = req.body?.order;
  if (typeof order !== 'string' || !order.trim()) return res.status(400).json({ ok: false, error: 'order string required, e.g. "gemini,groq,ollama"' });
  try {
    settings.writeEnvUpdates({ BRAIN_PROVIDERS: order });
    res.json({ ok: true, order: settings.getOrder(), configured_order: settings.getConfiguredOrder() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/settings/fast-routing', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled must be a boolean' });
  try {
    settings.writeEnvUpdates({ FAST_ROUTING: enabled ? '1' : '0' });
    res.json({ ok: true, fast_routing: routeMod.routingEnabled() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
const SETTINGS_TEST_MAP = { gemini: 'gemini-direct', groq: 'groq', openai: 'openai', anthropic: 'anthropic', ollama: 'ollama' };
app.post('/api/settings/test', async (req, res) => {
  const id = req.body?.provider;
  const brainName = SETTINGS_TEST_MAP[id];
  if (!brainName) return res.status(400).json({ ok: false, error: 'provider must be one of: gemini, groq, openai, anthropic, ollama' });
  const t0 = Date.now();
  try {
    const r = await brain.ask('Reply with the word OK only.', brainName);
    const lastTest = settings.recordTestResult(id, { ok: true, model: r.model, provider: r.provider, ms: Date.now() - t0 });
    res.json({ ok: true, provider: id, model: r.model, ms: Date.now() - t0, lastTest });
  } catch (e) {
    const lastTest = settings.recordTestResult(id, { ok: false, ms: Date.now() - t0, error: redact(e.message) });
    res.status(500).json({ ok: false, provider: id, error: redact(e.message), lastTest });
  }
});

// --- notifications: local inbox ---------------------------------------------
app.get('/api/notifications', (req, res) => res.json({
  ok: true,
  unread: notifyMod.unreadCount(),
  notifications: notifyMod.listNotifications({ unreadOnly: req.query.unread === '1', limit: Number(req.query.limit) || 50 }),
}));
app.post('/api/notifications', (req, res) => {
  try {
    const n = notifyMod.createNotification(req.body?.title, req.body?.body || '', req.body?.source || 'api');
    res.json({ ok: true, notification: n });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/notifications/:id/read', (req, res) => {
  try { res.json({ ok: true, ...notifyMod.markNotificationRead(req.params.id) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// --- replay: audit + verified replay of screen sessions ----------------------
app.get('/api/replay', (req, res) => res.json({ ok: true, sessions: replay.listSessions({ limit: Number(req.query.limit) || 20 }) }));
app.get('/api/replay/:id', (req, res) => {
  try {
    const s = replay.getSession(req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'session not found' });
    res.json({ ok: true, session: s });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/replay/shot/:stepId', (req, res) => {
  try {
    const shot = replay.getShot(req.params.stepId);
    if (!shot) return res.status(404).json({ ok: false, error: 'screenshot not found (pruned or never recorded)' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(shot.buffer);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/replay/:id', (req, res) => {
  try {
    const out = replay.purgeSession(req.params.id);
    if (!out.ok) return res.status(404).json({ ok: false, error: 'session not found' });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/replay/:id/replay', async (req, res) => {
  // Verified replay: stops at the first screen mismatch or refused
  // destructive step. confirm_destructive=true is a FRESH approval for
  // this replay only — the original approval never replays.
  const client = new desktop.DesktopAgentClient({});
  try {
    const out = await replay.replaySession(req.params.id, {
      capture: async () => {
        try {
          const s = await client.screenshot();
          const buf = Buffer.from(s.imageBase64, 'base64');
          return { buffer: buf, hash: screen.hashBuffer(buf) };
        } catch { return screen.captureScreenshot(); }
      },
      act: (a) => client.act(a, { approvalId: req.body?.approval_id }),
      confirmDestructive: () => req.body?.confirm_destructive === true,
    });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(403).json({ ok: false, error: e.message }); }
});

// --- messaging channels: status only (Telegram polls inside the server when
// a token exists; WhatsApp starts manually — QR scan, spare number only) -------
app.get('/api/channels', (req, res) => res.json({
  ok: true,
  telegram: telegramBot ? telegramBot.status() : new TelegramBot().status(),
  whatsapp: whatsapp.status(),
}));

app.use((err, req, res, next) => {
  // M-24: map errors honestly instead of masking everything as 400
  // 'bad request' with no log. Parse failures stay 400, oversized
  // bodies are 413, a locked database is 503 (retryable), everything
  // else is 500. The message is redacted before it is logged or sent.
  const msg = redact(String(err?.message || 'unknown error'));
  console.error(`[personal-ai] ${req.method} ${req.path} failed: ${msg.slice(0, 300)}`);
  if (err?.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'request body too large' });
  if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid JSON body' });
  if (/SQLITE_BUSY|database is locked/i.test(msg)) return res.status(503).json({ ok: false, error: 'database busy — try again in a moment' });
  return res.status(500).json({ ok: false, error: 'internal error — check the server log' });
});

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
      // Provider STATUS only (masked previews) — keys are never shown or
      // accepted in chat; the bot refuses pasted keys (see telegram.js).
      getProviderStatus: async () => settings.getProviderStatus(),
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
// H-15: a bind failure (port already in use) used to surface as an
// unhandled error with no clear message. Fail loudly and exit non-zero
// so a supervisor — or a human — can see the server never started, and
// so the "listening" log above is never followed by a silent death.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[personal-ai] FATAL: port ${PORT} is already in use — another instance may be running. Exiting.`);
  } else {
    console.error(`[personal-ai] FATAL: server failed to start: ${e.message}`);
  }
  process.exit(1);
});
// Explicit request timeout: 300 s, matching the documented turn budget
// (240 s) plus margin. Stating it beats relying on the Node default.
server.requestTimeout = 300000;
module.exports = { app, server, agentTurn, routineRunner, defaultOutboxWorker, schedulerTimer, telegramBot, turnBudgetMs };
