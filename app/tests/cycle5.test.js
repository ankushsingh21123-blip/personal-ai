// Cycle 5 tests (18 Nov 2026): audit-fix cycle for the 18 Nov 2026 deep
// audit (audit-2026-11-18.md). Every test pins a fixed finding: H-1
// search_files secrets leak, H-2 symlink path escape, H-4 tool writes
// reaching the app directory, H-3 Telegram fail-open, M-4 WhatsApp
// allowlist, H-5 configured provider order, M-7 shell metacharacters in
// secrets, H-13 token usage accounting + Groq budget, H-14 fast-routing
// classification, H-11 turn budget mechanism, M-21 max_actions clamp,
// M-26 audit failure visibility, M-24 error mapping, H-15 port-in-use,
// M-1 freeze gating, H-12 status shape, and the frontend Highs H-6/H-7/
// H-8/H-9/H-10 (static pins — the live-browser behaviour is verified
// manually, see TEST-REPORT.md).
//
// Conventions follow the other cycle files: fake keys only, env vars
// saved/restored per test, scratch files under tmp-cycle5 (deleted in
// after()), live API checks against the suite server, and spawned
// servers on private ports with throwaway databases for the tests that
// must mutate freeze state or hold a port.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tools = require('../tools');
const brain = require('../brain');
const settings = require('../settings');
const routeMod = require('../route');
const desktop = require('../desktop');
const freeze = require('../freeze');
const { TelegramBot } = require('../telegram');
const whatsapp = require('../whatsapp');
const auditMod = require('../audit');

const FAKE_KEY = 'sk-' + 'a'.repeat(40);
const SCRATCH = path.join(tools.WORKSPACE, 'tmp-cycle5');

const ENV_VARS = ['BRAIN_PROVIDERS', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN',
  'WHATSAPP_ENABLED', 'WHATSAPP_SPARE_NUMBER_CONFIRMED', 'WHATSAPP_ALLOWED_SENDER',
  'GROQ_API_KEY', 'GROQ_DAILY_TOKEN_BUDGET', 'MAX_OUTPUT_TOKENS', 'FAST_ROUTING',
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
function saveEnv() {
  const saved = {};
  for (const k of ENV_VARS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
let savedEnv;
test.beforeEach(() => { savedEnv = saveEnv(); });
test.afterEach(() => { restoreEnv(savedEnv); global.fetch = REAL_FETCH; });
const REAL_FETCH = global.fetch;

test.before(() => { fs.mkdirSync(SCRATCH, { recursive: true }); });
test.after(() => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

// ---------------------------------------------------------------------------
// H-1: search_files must never surface secret-file contents
// ---------------------------------------------------------------------------
test('H-1: search_files skips secret files and redacts key-shaped excerpts', async () => {
  const dir = path.join(SCRATCH, 'h1');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env.local'), 'GEMINI_API_KEY=fake-key-here\nMARKER_H1_SECRET=1\n');
  fs.writeFileSync(path.join(dir, 'sub', '.env.production'), 'MARKER_H1_SECRET=1\n');
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{"token": "x"}\nMARKER_H1_SECRET=1\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), `pasted key: ${FAKE_KEY}\nMARKER_H1_PLAIN=1\n`);
  const rel = path.relative(tools.WORKSPACE, dir);
  const r = await tools.execute('search_files', { query: 'MARKER_H1', path: rel });
  const paths = r.matches.map(m => m.path);
  assert.ok(!paths.some(p => p.includes('.env')), 'env files must be skipped');
  assert.ok(!paths.some(p => p.includes('credentials.json')), 'credential files must be skipped');
  assert.ok(paths.some(p => p.endsWith('notes.txt')), 'plain files must still be searched');
  const r2 = await tools.execute('search_files', { query: 'sk-aaaa', path: rel });
  assert.ok(r2.matches.length >= 1, 'key-shaped line is still findable');
  for (const m of r2.matches) assert.ok(!m.excerpt.includes(FAKE_KEY), 'excerpt must not contain the full key');
});

// ---------------------------------------------------------------------------
// H-2: symlinked parent dirs cannot smuggle paths out of the workspace
// ---------------------------------------------------------------------------
test('H-2: safePath refuses reads through a symlink escaping the workspace, allows inside ones', async () => {
  const dir = path.join(SCRATCH, 'h2');
  const real = path.join(dir, 'real');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'inside.txt'), 'inside content');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'piplet-h2-'));
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside content');
  try {
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'dir');
    fs.symlinkSync(real, path.join(dir, 'inner'), 'dir');
    const rel = path.relative(tools.WORKSPACE, dir);
    await assert.rejects(tools.execute('read_file', { path: `${rel}/escape/outside.txt` }), /denied|escapes/);
    const ok = await tools.execute('read_file', { path: `${rel}/inner/inside.txt` });
    assert.equal(ok.content, 'inside content');
  } finally {
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// H-4: tool writes must never reach the app directory / manifest / hooks
// ---------------------------------------------------------------------------
test('H-4: create/edit/append refuse app paths; the gate allows normal writes', async () => {
  await assert.rejects(tools.execute('create_file', { path: 'app/cycle5-probe.txt', content: 'x' }), /refused/);
  await assert.rejects(tools.execute('edit_file', { path: 'app/tools.js', old_text: 'x', new_text: 'y' }), /refused/);
  await assert.rejects(tools.execute('append_file', { path: 'app/server.js', content: 'x' }), /refused/);
  await assert.rejects(tools.execute('create_file', { path: 'app/public/app.js', content: 'x' }), /refused/);
  assert.ok(!fs.existsSync(path.join(tools.APP_DIR, 'cycle5-probe.txt')), 'refused write must not create the file');
  // Skills manifest + git hooks are refused too.
  assert.throws(() => tools.assertWritablePath(path.join(tools.WORKSPACE, 'skills', 'approved.json')), /user only/);
  assert.throws(() => tools.assertWritablePath(path.join(tools.WORKSPACE, '.githooks', 'pre-commit')), /git hooks/);
  // Reads of app code still work; normal workspace writes still work.
  const back = await tools.execute('read_file', { path: 'app/tools.js' });
  assert.ok(back.content.length > 100);
  assert.doesNotThrow(() => tools.assertWritablePath(path.join(SCRATCH, 'ok.txt')));
  const r = await tools.execute('create_file', { path: 'tmp-cycle5/ok.txt', content: 'fine' });
  assert.equal(r.ok, true);
});

test('H-4: run_tests declaration no longer demands self-modification', () => {
  const decl = brain.TOOL_DECLARATIONS.find(d => d.name === 'run_tests');
  assert.ok(decl, 'run_tests declaration exists');
  assert.match(decl.description, /user, never by the agent/);
  assert.ok(!/self-modification/i.test(decl.description), 'no self-modification wording remains');
});

// ---------------------------------------------------------------------------
// H-3: Telegram fails closed until a chat id is set
// ---------------------------------------------------------------------------
function makeBot(extra = {}) {
  let forwarded = 0;
  const sent = [];
  const bot = new TelegramBot({
    token: 't'.repeat(12),
    fetchImpl: async () => ({ json: async () => ({ ok: true, result: {} }) }),
    handlers: {
      onMessage: async () => { forwarded++; return 'agent reply'; },
      getProviderStatus: async () => ({}),
    },
    ...extra,
  });
  return { bot, sent, forwarded: () => forwarded };
}

test('H-3: Telegram refuses EVERYONE (including /start) with no chat id configured', async () => {
  delete process.env.TELEGRAM_CHAT_ID;
  const { bot, forwarded } = makeBot();
  assert.equal(bot.status().chatConfigured, false);
  const start = await bot.handleUpdate({ message: { chat: { id: 111 }, text: '/start' } });
  assert.equal(start.handled, false);
  assert.match(start.reason, /chat id not configured/);
  const msg = await bot.handleUpdate({ message: { chat: { id: 111 }, text: 'hello' } });
  assert.equal(msg.handled, false);
  assert.equal(forwarded(), 0, 'nothing reaches the agent turn while unpaired');
});

test('H-3: Telegram answers only the configured chat; env pairing works without restart', async () => {
  delete process.env.TELEGRAM_CHAT_ID;
  const { bot, forwarded } = makeBot({ chatId: '111' });
  const other = await bot.handleUpdate({ message: { chat: { id: 999 }, text: 'hello' } });
  assert.equal(other.handled, false);
  assert.equal(other.reason, 'chat not authorised');
  const owner = await bot.handleUpdate({ message: { chat: { id: 111 }, text: 'hello' } });
  assert.equal(owner.handled, true);
  assert.equal(forwarded(), 1);
  // Pairing via the environment takes effect on a live bot instance.
  const { bot: unpaired, forwarded: f2 } = makeBot();
  const before = await unpaired.handleUpdate({ message: { chat: { id: 222 }, text: 'hello' } });
  assert.equal(before.handled, false);
  process.env.TELEGRAM_CHAT_ID = '222';
  assert.equal(unpaired.status().chatConfigured, true);
  const after = await unpaired.handleUpdate({ message: { chat: { id: 222 }, text: 'hello' } });
  assert.equal(after.handled, true);
  assert.equal(f2(), 1);
});

// ---------------------------------------------------------------------------
// M-4: WhatsApp sender allowlist
// ---------------------------------------------------------------------------
test('M-4: WhatsApp refuses all senders without an allowlist, and non-allowed senders with one', async () => {
  delete process.env.WHATSAPP_ALLOWED_SENDER;
  let forwarded = 0;
  const base = { onMessage: async () => { forwarded++; return 'reply'; }, send: async () => {} };
  const none = await whatsapp.handleIncomingMessage({ text: 'hi', from: '91x@s.whatsapp.net', ...base });
  assert.equal(none.handled, false);
  assert.match(none.reason, /no allowed sender/);
  const wrong = await whatsapp.handleIncomingMessage({ text: 'hi', from: '91bad@s.whatsapp.net', allowedFrom: '91good@s.whatsapp.net', ...base });
  assert.equal(wrong.handled, false);
  assert.equal(wrong.reason, 'sender not allowed');
  const good = await whatsapp.handleIncomingMessage({ text: 'hi', from: '91good@s.whatsapp.net', allowedFrom: '91good@s.whatsapp.net', ...base });
  assert.equal(good.handled, true);
  assert.equal(forwarded, 1);
  process.env.WHATSAPP_ENABLED = 'yes';
  process.env.WHATSAPP_SPARE_NUMBER_CONFIRMED = 'yes';
  const g = whatsapp.guards();
  assert.ok(g.problems.some(p => p.includes('WHATSAPP_ALLOWED_SENDER')), 'guards must require the allowlist');
});

// ---------------------------------------------------------------------------
// H-5: configured order (not the resolved chain) is what the UI edits
// ---------------------------------------------------------------------------
test('H-5: getConfiguredOrder keeps unconfigured providers; getOrder drops them', () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  process.env.BRAIN_PROVIDERS = 'gemini,groq,ollama';
  assert.deepEqual(settings.getConfiguredOrder(), ['gemini', 'groq', 'ollama']);
  assert.ok(!settings.getOrder().includes('gemini-direct'), 'resolved chain drops keyless providers');
  delete process.env.BRAIN_PROVIDERS;
  assert.deepEqual(settings.getConfiguredOrder(), ['gemini', 'groq', 'ollama']);
  process.env.BRAIN_PROVIDERS = 'gemini,bogus,groq,gemini';
  assert.deepEqual(settings.getConfiguredOrder(), ['gemini', 'groq']);
});

// ---------------------------------------------------------------------------
// M-7: secret validation rejects shell metacharacters
// ---------------------------------------------------------------------------
test('M-7: secret values with shell metacharacters are rejected', () => {
  for (const bad of ['abc;rm', 'a|b', 'a&b', 'a$b', 'a(b)', 'a<b>', 'a\\b']) {
    assert.throws(() => settings.validateValue('GROQ_API_KEY', bad + '12345678'), /shell characters/);
  }
  // Backtick is caught by the earlier quotes check — either way it is refused.
  assert.throws(() => settings.validateValue('GROQ_API_KEY', 'a`b`12345678'), /whitespace or quotes/);
  assert.equal(settings.validateValue('GROQ_API_KEY', 'gsk_abcDEF1234567890_-'), 'gsk_abcDEF1234567890_-');
  assert.equal(settings.validateValue('TELEGRAM_BOT_TOKEN', '123456:' + 'ABC-DEF1234ghIkl-zyx57W2v1u123ew11'), '123456:' + 'ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
});

// ---------------------------------------------------------------------------
// H-13: token usage accounting + Groq daily budget
// ---------------------------------------------------------------------------
test('H-13: normalizeUsage collapses provider shapes; estimates only when absent', () => {
  assert.deepEqual(brain.normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, '', ''), { prompt: 10, completion: 5, total: 15, estimated: false });
  assert.deepEqual(brain.normalizeUsage({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }, '', ''), { prompt: 7, completion: 3, total: 10, estimated: false });
  assert.deepEqual(brain.normalizeUsage({ input_tokens: 4, output_tokens: 6 }, '', ''), { prompt: 4, completion: 6, total: 10, estimated: false });
  assert.deepEqual(brain.normalizeUsage({ prompt_eval_count: 9, eval_count: 2 }, '', ''), { prompt: 9, completion: 2, total: 11, estimated: false });
  const est = brain.normalizeUsage(null, 'abcdefgh', 'ijkl');
  assert.equal(est.estimated, true);
  assert.ok(est.total > 0);
  assert.equal(brain.estimateTokens(''), 1);
  assert.equal(brain.estimateTokens('a'.repeat(40)), 10);
  assert.deepEqual(brain.sumUsage([{ prompt: 1, completion: 2, total: 3, estimated: false }, { prompt: 4, completion: 5, total: 9, estimated: true }]), { prompt: 5, completion: 7, total: 12, estimated: true });
});

test('H-13: maxOutputTokens clamps; groqBudget defaults to the 200k free tier', () => {
  delete process.env.MAX_OUTPUT_TOKENS;
  assert.equal(brain.maxOutputTokens(), 2048);
  process.env.MAX_OUTPUT_TOKENS = '999999';
  assert.equal(brain.maxOutputTokens(), 32000);
  process.env.MAX_OUTPUT_TOKENS = '0';
  assert.equal(brain.maxOutputTokens(), 1);
  delete process.env.GROQ_DAILY_TOKEN_BUDGET;
  assert.equal(brain.groqBudget(), 200000);
  process.env.GROQ_DAILY_TOKEN_BUDGET = '5000';
  assert.equal(brain.groqBudget(), 5000);
});

test('H-13: Groq refuses before spending once the daily budget is reached', async () => {
  process.env.GROQ_API_KEY = 'fake-test-key';
  process.env.GROQ_DAILY_TOKEN_BUDGET = '0';
  let fetched = false;
  global.fetch = async () => { fetched = true; throw new Error('fetch must not run'); };
  await assert.rejects(brain.ask('hi', 'groq'), /daily token budget/);
  assert.equal(fetched, false, 'no provider call is made once the budget is spent');
});

test('H-13: a Groq call reports usage and records it against the daily counter', async () => {
  const { getSetting, run } = require('../db');
  const key = `groq_tokens_${new Date().toISOString().slice(0, 10)}`;
  const before = Number(getSetting(key) || 0);
  process.env.GROQ_API_KEY = 'fake-test-key';
  process.env.GROQ_DAILY_TOKEN_BUDGET = '200000';
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: 'hello back' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  });
  try {
    const r = await brain.ask('hi', 'groq');
    assert.equal(r.provider, 'groq');
    assert.deepEqual(r.usage, { prompt: 10, completion: 5, total: 15, estimated: false });
    assert.equal(Number(getSetting(key) || 0), before + 15);
  } finally {
    try { run('DELETE FROM settings WHERE key = ?', key); } catch {}
  }
});

// ---------------------------------------------------------------------------
// H-14: fast routing classifies the raw user text
// ---------------------------------------------------------------------------
test('H-14: routedAsk classifies classifyText, not the wrapped prompt', async () => {
  process.env.FAST_ROUTING = '1';
  const calls = [];
  const fakeBrain = {
    ask: async () => ({ text: 'full', model: 'm-full', provider: 'groq' }),
    askWith: async (p, order) => { calls.push(order); return { text: 'local', model: 'm-local', provider: 'ollama' }; },
  };
  const wrapped = `You are Ankush's personal AI.\n${'TOOL LIST '.repeat(400)}\nUser: show my notes`;
  assert.ok(wrapped.length > 2000, 'wrapped prompt is long by construction');
  const r = await routeMod.routedAsk(wrapped, { brain: fakeBrain, classifyText: 'show my notes' });
  assert.equal(r.route, 'routine');
  assert.equal(r.provider, 'ollama');
  assert.equal(calls.length, 1);
  // Without classifyText the same long prompt is (correctly) hard.
  const r2 = await routeMod.routedAsk(wrapped, { brain: fakeBrain });
  assert.equal(r2.route, 'hard');
  assert.equal(r2.provider, 'groq');
});

// ---------------------------------------------------------------------------
// H-11: turn budget mechanism
// ---------------------------------------------------------------------------
test('H-11: withDeadline resolves fast work and rejects slow work with a budget error', async () => {
  const fast = await brain.withDeadline(Promise.resolve('done'), 1000, 'test op');
  assert.equal(fast, 'done');
  await assert.rejects(
    brain.withDeadline(new Promise(resolve => setTimeout(() => resolve('late'), 500)), 50, 'test op'),
    /test op exceeded its budget \(50ms\)/);
  // A rejection from the work itself still propagates unchanged.
  await assert.rejects(brain.withDeadline(Promise.reject(new Error('work failed')), 1000, 'test op'), /work failed/);
});

// ---------------------------------------------------------------------------
// M-21: max_actions clamp in the screen loop
// ---------------------------------------------------------------------------
test('M-21: screenLoop clamps maxActions — NaN/negative/huge cannot zero-step or run away', async () => {
  const stubs = (counter) => ({
    capture: async () => ({ buffer: Buffer.from('s' + counter.n), hash: 'h' + (counter.n++) }),
    ground: async () => ({ action: 'click', x: 0.5, y: 0.5 }),
    act: async () => ({ ok: true }),
    audit: () => {},
  });
  let c = { n: 0 };
  let r = await desktop.screenLoop('task', stubs(c), { maxActions: -5 });
  assert.equal(r.steps.length, 1, 'negative clamps to 1 step');
  assert.match(r.stopReason, /action cap reached \(1\)/);
  c = { n: 0 };
  r = await desktop.screenLoop('task', stubs(c), { maxActions: 'abc' });
  assert.equal(r.steps.length, 20, 'non-numeric falls back to the default 20');
  assert.match(r.stopReason, /action cap reached \(20\)/);
  c = { n: 0 };
  r = await desktop.screenLoop('task', stubs(c), { maxActions: 1000000 });
  assert.equal(r.steps.length, 50, 'huge values clamp to 50');
  assert.match(r.stopReason, /action cap reached \(50\)/);
});

// ---------------------------------------------------------------------------
// M-26: audit failures are counted, never swallowed silently
// ---------------------------------------------------------------------------
test('M-26: audit() returns a hash and auditFailures() starts at zero', () => {
  assert.equal(typeof auditMod.auditFailures, 'function');
  const before = auditMod.auditFailures();
  const hash = auditMod.audit('cycle5-probe', {}, true, 'probe entry');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(auditMod.auditFailures(), before, 'a successful audit must not count as a failure');
});

// ---------------------------------------------------------------------------
// Live API checks against the suite server (H-5, H-12, M-21, M-24)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = process.env.ANKU_TOKEN || '';
if (!TOKEN) {
  const envPath = path.join(__dirname, '..', '.env.local');
  const m = fs.readFileSync(envPath, 'utf8').match(/ANKU_TOKEN=(\S+)/);
  TOKEN = m ? m[1] : '';
}
const H = { 'Content-Type': 'application/json', 'X-Anku-Token': TOKEN };
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { _text: text }; }
  return { status: r.status, body: j };
}

test('H-5 API: GET /api/settings/providers returns configured_order alongside the resolved order', async () => {
  const { status, body } = await api('/api/settings/providers');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.configured_order), 'configured_order must be present');
  assert.ok(Array.isArray(body.order), 'resolved order must still be present');
  assert.ok(body.configured_order.length >= 1);
});

test('H-12 API: GET /api/status answers with cached-shape fields on repeat calls', async () => {
  const a = await api('/api/status');
  const b = await api('/api/status');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.goose_version, b.body.goose_version, 'goose version is stable across calls');
  assert.ok('brain_order' in a.body && 'counts' in a.body);
});

test('M-21 API: POST /api/screen/loop rejects bad max_actions with 400', async () => {
  for (const bad of ['abc', -5, 0, 51, 1.5]) {
    const { status, body } = await api('/api/screen/loop', {
      method: 'POST', body: JSON.stringify({ task: 'cycle5 probe', max_actions: bad }),
    });
    assert.equal(status, 400, `max_actions=${JSON.stringify(bad)} must be 400, got ${status}: ${JSON.stringify(body)}`);
    assert.match(body.error, /max_actions/);
  }
});

test('M-24 API: invalid JSON is 400, oversized body is 413 — not a masked generic error', async () => {
  const bad = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: H, body: '{invalid json',
  });
  assert.equal(bad.status, 400);
  const badJson = await bad.json();
  assert.match(badJson.error, /invalid JSON/);
  const big = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: H, body: JSON.stringify({ text: 'x'.repeat(150 * 1024) }),
  });
  assert.equal(big.status, 413);
  const bigJson = await big.json();
  assert.match(bigJson.error, /too large/);
});

// ---------------------------------------------------------------------------
// Spawned-server checks (H-15, M-1, H-11) — private ports, throwaway DBs
// ---------------------------------------------------------------------------
function spawnServer({ port, extraEnv = {} }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piplet-cycle5-'));
  const dbPath = path.join(tmpRoot, 'test.db');
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ANKU_TOKEN: 'cycle5-test-token',
      PIPLET_DB_PATH: dbPath,
      DISABLE_SCHEDULER: '1',
      TELEGRAM_ENABLED: 'no',
      RATE_LIMIT_PER_MIN: '1000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Anku-Token': 'cycle5-test-token' };
  return {
    child, tmpRoot, base, headers,
    stderr: () => stderr,
    stop() {
      try { child.kill('SIGTERM'); } catch {}
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    },
  };
}
async function waitForHealth(srv, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(srv.base + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`server on ${srv.base} did not become healthy; stderr: ${srv.stderr().slice(0, 500)}`);
    await new Promise(r => setTimeout(r, 250));
  }
}
async function waitForExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
    child.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

test('H-15: a second server on a busy port exits non-zero with a clear message', async () => {
  const port = 3211;
  const a = spawnServer({ port });
  try {
    await waitForHealth(a);
    const b = spawnServer({ port });
    try {
      const { code } = await waitForExit(b.child, 15000);
      assert.notEqual(code, 0, 'port-in-use must exit non-zero');
      assert.match(b.stderr(), /already in use/, 'stderr must name the port conflict');
    } finally {
      try { b.child.kill('SIGKILL'); } catch {}
      try { fs.rmSync(b.tmpRoot, { recursive: true, force: true }); } catch {}
    }
    // The first server is untouched and still healthy.
    const r = await fetch(a.base + '/api/health');
    assert.equal(r.status, 200);
  } finally {
    a.stop();
  }
});

test('M-1: freeze gates /api/chat and /api/tools; unfreezing restores them', async () => {
  const srv = spawnServer({ port: 3212 });
  try {
    await waitForHealth(srv);
    const post = async (p, body) => {
      const r = await fetch(srv.base + p, { method: 'POST', headers: srv.headers, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const fr = await post('/api/freeze', { frozen: true, reason: 'cycle5 test' });
    assert.equal(fr.status, 200);
    assert.equal(fr.body.frozen, true);
    const chat = await post('/api/chat', { text: 'hello while frozen' });
    assert.equal(chat.status, 423, `frozen chat must be 423, got ${chat.status}`);
    const tool = await post('/api/tools', { tool: 'read_file', args: { path: 'AGENT.md' } });
    assert.equal(tool.status, 423, `frozen tool call must be 423, got ${tool.status}`);
    const unfr = await post('/api/freeze', { frozen: false });
    assert.equal(unfr.body.frozen, false);
    const tool2 = await post('/api/tools', { tool: 'read_file', args: { path: 'AGENT.md' } });
    assert.equal(tool2.status, 200);
    assert.match(tool2.body.content, /Ankush/);
  } finally {
    srv.stop();
  }
});

test('H-11: a hung provider call hits the turn budget and /api/chat answers 504', async () => {
  // Stub Ollama that accepts the request and never responds. The turn
  // budget (30 s floor) must fire before the 60 s provider timeout.
  const stub = http.createServer(() => { /* never respond */ });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = stub.address().port;
  const srv = spawnServer({
    port: 3213,
    extraEnv: {
      BRAIN_PROVIDERS: 'ollama',
      OLLAMA_HOST: `http://127.0.0.1:${stubPort}`,
      TURN_BUDGET_MS: '30000',
    },
  });
  try {
    await waitForHealth(srv);
    const t0 = Date.now();
    const r = await fetch(srv.base + '/api/chat', {
      method: 'POST', headers: srv.headers,
      body: JSON.stringify({ text: 'say hello' }),
      signal: AbortSignal.timeout(45000),
    });
    const elapsed = Date.now() - t0;
    const body = await r.json().catch(() => ({}));
    assert.equal(r.status, 504, `hung turn must be 504, got ${r.status}: ${JSON.stringify(body)}`);
    assert.ok(elapsed >= 29000 && elapsed < 45000, `budget must fire at ~30s, took ${elapsed}ms`);
    // The server is still responsive after the timed-out turn.
    const h = await fetch(srv.base + '/api/health');
    assert.equal(h.status, 200);
  } finally {
    srv.stop();
    try { stub.closeAllConnections?.(); } catch {}
    await new Promise(resolve => stub.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// Frontend static pins (H-5/H-6/H-7/H-8/H-9/H-10)
// ---------------------------------------------------------------------------
test('frontend: approvals decidable, loaders guarded, no inline CSP-blocked styles, order uses configured_order', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // H-6: approve/reject buttons + decide endpoint wiring.
  assert.ok(appJs.includes('data-approval-decide'), 'approvals list must render decide buttons');
  assert.ok(appJs.includes('/decide'), 'decide endpoint must be called');
  assert.ok(appJs.includes('approval_decide_note'), 'row must say deciding never executes');
  // H-7: per-section error helper + auth banner + retry in loaders.
  assert.ok(appJs.includes('function sectionError'), 'sectionError helper must exist');
  assert.ok(appJs.includes('showAuthBanner'), '401 banner must exist');
  assert.ok(appJs.includes("sectionError('notifications'"), 'notifications loader must be guarded');
  assert.ok(appJs.includes("sectionError('replay'"), 'replay loader must be guarded');
  assert.ok(appJs.includes("sectionError('jobs'"), 'jobs loader must be guarded');
  assert.ok(appJs.includes("sectionError('approvals'"), 'approvals loader must be guarded');
  assert.ok(appJs.includes("sectionError('routines'"), 'routines loader must be guarded');
  assert.ok(html.includes('id="auth-banner"'), 'auth banner element must exist in HTML');
  assert.ok(appJs.includes('reenter-token'), 're-enter-token control must exist');
  // H-8: settings feedback lives in static HTML with role=status.
  assert.ok(html.includes('id="settings-result" role="status"'), 'settings result span must be static with role=status');
  assert.ok(!appJs.includes('<button id="save-settings">'), 'save button must not be re-rendered by loadSettings');
  // H-9: language switch must not re-render (which wiped typed keys).
  // Comments are stripped first: the explanatory comment names loadAll.
  const langHandler = appJs.slice(appJs.indexOf("lang-select').addEventListener('change'"));
  const langCode = langHandler.slice(0, 400).replace(/\/\/.*$/gm, '');
  assert.ok(!langCode.includes('loadAll'), 'language switch must not call loadAll');
  assert.ok(appJs.includes('snapshotTypedKeys'), 'typed keys must be snapshotted across re-renders');
  // H-10: replay sizing in CSS, no inline style (CSP blocks inline styles).
  assert.ok(!appJs.includes('style="max-width'), 'no inline max-width styles (CSP-blocked)');
  assert.ok(/\.step img\{[^}]*max-width:\s*100%/.test(css), 'replay images must be capped in CSS');
  // H-5: order input pre-filled from configured_order, resolved shown read-only.
  assert.ok(appJs.includes('s.configured_order'), 'settings must use configured_order');
  assert.ok(html.includes('id="order-resolved"'), 'resolved-order read-only line must exist');
});

test('frontend: new i18n keys exist in all three languages', () => {
  const { STRINGS } = require('../public/i18n');
  const keys = ['approve', 'reject', 'approval_decide_note', 'retry', 'load_failed', 'auth_failed', 'reenter_token', 'order_resolved', 'order_saved'];
  for (const lang of ['en', 'hi', 'te']) {
    for (const k of keys) {
      assert.ok(typeof STRINGS[lang][k] === 'string' && STRINGS[lang][k].length > 0, `${lang}.${k} must be a real string`);
    }
  }
});

test('prompts: fallback prompt strings list all 28 tools and no self-modification demand', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const tool of ['remember_fact', 'recall_memory', 'forget_fact', 'edit_fact', 'create_approval', 'file_info', 'append_file', 'recent_activity']) {
    assert.ok(serverSrc.includes(tool), `server prompts must list ${tool}`);
  }
  assert.ok(!serverSrc.includes('self-modification'), 'no self-modification demand may remain in server prompts');
});
