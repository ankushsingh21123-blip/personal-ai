// Tests for Phases B–E (14 Nov 2026): screen vision + desktop control,
// phone, offline queue + sync, routines, browser use, messaging channels.
// Two halves:
//   (1) Unit tests with mocked fetch / injected drivers — no server, no
//       keys, no desktop, no phone. These prove validation, parsing,
//       ordering, gating, and state machines.
//   (2) Live API tests against the server started by tests/run-tests.sh —
//       same pattern as tests/test.js. These prove the endpoints are wired
//       and the SQLite persistence is real.
// Honest boundaries, stated in tests/TEST-REPORT.md: vision providers,
// desktop-agent execution, ADB control, Telegram/WhatsApp live runs, and
// two-node sync are UNPROVEN live (no key / desktop / phone / second node
// on this VM). The browser launch + render + read + screenshot path IS
// proven live (Chromium headless, local page); external goto is unproven
// here because the VM egress proxy rejects Chromium CONNECT tunnels.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const vision = require('../vision');
const screen = require('../screen');
const desktop = require('../desktop');
const phone = require('../phone');
const { TelegramBot } = require('../telegram');
const whatsapp = require('../whatsapp');
const browserMod = require('../browser');
const queue = require('../queue');
const routines = require('../routines');
const sync = require('../sync');
const freeze = require('../freeze');
const { all, get, run } = require('../db');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const REAL_FETCH = global.fetch;
const ENV_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'BRAIN_PROVIDERS', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_MAX_TOKENS',
  'OLLAMA_VISION_MODEL', 'OLLAMA_HOST', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'WHATSAPP_ENABLED', 'WHATSAPP_SPARE_NUMBER_CONFIRMED'];
function saveEnv() { const s = {}; for (const k of ENV_KEYS) s[k] = process.env[k]; return s; }
function restoreEnv(s) { for (const k of ENV_KEYS) { if (s[k] === undefined) delete process.env[k]; else process.env[k] = s[k]; } }
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
let savedEnv;
test.beforeEach(() => { savedEnv = saveEnv(); clearEnv(); });
test.afterEach(() => { restoreEnv(savedEnv); global.fetch = REAL_FETCH; freeze.setFrozen(false); phone.disableSession(); });

function fakeResponse(json, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(json) };
}
function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(String(url), opts, calls.length); };
  return calls;
}
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Vision (Phase B)
// ---------------------------------------------------------------------------
test('vision: gemini-direct sends image parts, parses text, never returns the key', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-vision-key';
  const calls = mockFetch(() => fakeResponse({ candidates: [{ content: { parts: [{ text: '{"action":"done","confidence":0.9}' }] } }] }));
  const r = await vision.askVision('what is on screen?', PNG_1X1, 'image/png', 'gemini-direct');
  assert.equal(r.provider, 'gemini-direct');
  assert.match(r.text, /done/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'test-gemini-vision-key');
  const body = JSON.parse(calls[0].opts.body);
  const parts = body.contents[0].parts;
  assert.equal(parts[1].inline_data.mime_type, 'image/png');
  assert.equal(parts[1].inline_data.data, PNG_1X1);
  assert.doesNotMatch(JSON.stringify(r), /test-gemini-vision-key/);
});

test('vision: openai sends image_url parts to a custom base URL; anthropic sends image blocks', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-vision-key';
  process.env.OPENAI_BASE_URL = 'https://proxy.test/v1/';
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: 'seen' } }] }));
  const r1 = await vision.askVision('look', PNG_1X1, 'image/png', 'openai');
  assert.equal(r1.provider, 'openai');
  assert.equal(calls[0].url, 'https://proxy.test/v1/chat/completions');
  const b1 = JSON.parse(calls[0].opts.body);
  assert.equal(b1.messages[0].content[1].type, 'image_url');
  assert.ok(b1.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'));

  process.env.ANTHROPIC_API_KEY = 'test-anthropic-vision-key';
  const calls2 = mockFetch(() => fakeResponse({ content: [{ type: 'text', text: 'seen2' }] }));
  const r2 = await vision.askVision('look', PNG_1X1, 'image/jpeg', 'anthropic');
  assert.equal(r2.text, 'seen2');
  const b2 = JSON.parse(calls2[0].opts.body);
  assert.equal(b2.messages[0].content[0].type, 'image');
  assert.equal(b2.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal(calls2[0].opts.headers['anthropic-version'], '2023-06-01');
});

test('vision: chain order follows BRAIN_PROVIDERS; ollama skipped without a vision model; empty chain throws', async () => {
  process.env.OPENAI_API_KEY = 'k1';
  process.env.ANTHROPIC_API_KEY = 'k2';
  process.env.BRAIN_PROVIDERS = 'anthropic,openai,ollama';
  assert.deepEqual(vision.visionOrder(), ['anthropic', 'openai']);
  process.env.OLLAMA_VISION_MODEL = 'llava';
  assert.deepEqual(vision.visionOrder(), ['anthropic', 'openai', 'ollama']);
  delete process.env.OLLAMA_VISION_MODEL;
  clearEnv();
  assert.deepEqual(vision.visionOrder(), []);
  await assert.rejects(vision.askVision('x', PNG_1X1), /no vision providers available/);
});

test('vision: falls through a failing provider to the next; only-mode surfaces the provider error', async () => {
  process.env.OPENAI_API_KEY = 'k1';
  process.env.ANTHROPIC_API_KEY = 'k2';
  process.env.BRAIN_PROVIDERS = 'openai,anthropic';
  mockFetch((url) => url.includes('openai') || url.includes('proxy')
    ? fakeResponse({ error: 'boom' }, false, 500)
    : fakeResponse({ content: [{ type: 'text', text: 'anthropic saw it' }] }));
  // default openai base URL contains 'openai.com' — the mock above matches it
  const r = await vision.askVision('look', PNG_1X1);
  assert.equal(r.provider, 'anthropic');
  assert.deepEqual(r.tried, ['openai', 'anthropic']);
  await assert.rejects(vision.askVision('look', PNG_1X1, 'image/png', 'openai'), /vision provider openai failed/);
});

test('vision: grounded actions parse + validate; malformed input is rejected, never trusted', () => {
  const ok = vision.parseGroundedAction('{"action":"click","x":0.5,"y":0.25,"confidence":0.8,"description":"Click Send"}');
  assert.deepEqual(ok, { action: 'click', x: 0.5, y: 0.25, confidence: 0.8, description: 'Click Send', destructive: false });
  assert.equal(vision.parseGroundedAction('prefix {"action":"done"} suffix').action, 'done');
  assert.equal(vision.parseGroundedAction('{"action":"type","text":"hello"}').text, 'hello');
  assert.equal(vision.parseGroundedAction('{"action":"scroll"}').amount, 3);
  assert.equal(vision.parseGroundedAction('{"action":"key","key":"Enter"}').key, 'Enter');
  assert.equal(vision.parseGroundedAction('{"action":"click","x":0.1,"y":0.1,"destructive":true}').destructive, true);
  assert.throws(() => vision.parseGroundedAction('no json here'), /not valid JSON/);
  assert.throws(() => vision.parseGroundedAction('{"action":"rm"}'), /unknown grounded action/);
  assert.throws(() => vision.parseGroundedAction('{"action":"click","x":1.5,"y":0.5}'), /normalised x and y/);
  assert.throws(() => vision.parseGroundedAction('{"action":"click","x":0.5}'), /normalised x and y/);
  assert.throws(() => vision.parseGroundedAction('{"action":"type","text":""}'), /type needs text/);
  assert.throws(() => vision.parseGroundedAction('{"action":"type","text":"' + 'x'.repeat(4001) + '"}'), /type needs text/);
  assert.throws(() => vision.parseGroundedAction('{"action":"click","x":0.5,"y":0.5,"confidence":2}'), /confidence/);
  assert.throws(() => vision.parseGroundedAction('{"action":"key","key":"rm -rf"}'), /key must be/);
  assert.throws(() => vision.parseGroundedAction('{"action":"wait","ms":99999}'), /wait ms/);
  assert.throws(() => vision.parseGroundedAction('[]'), /JSON object/);
});

test('vision: groundAction wires ask + parse; bad model JSON throws a clear error', async () => {
  process.env.GEMINI_API_KEY = 'k1';
  mockFetch(() => fakeResponse({ candidates: [{ content: { parts: [{ text: '{"action":"click","x":0.2,"y":0.3,"description":"the button"}' }] } }] }));
  const r = await vision.groundAction('click the button', PNG_1X1);
  assert.equal(r.action.action, 'click');
  assert.equal(r.action.x, 0.2);
  assert.equal(r.provider, 'gemini-direct');
  mockFetch(() => fakeResponse({ candidates: [{ content: { parts: [{ text: 'I see a button but no JSON' }] } }] }));
  await assert.rejects(vision.groundAction('click the button', PNG_1X1), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// Screen capture (Phase B)
// ---------------------------------------------------------------------------
test('screen: hash is stable sha256; png size parses; cache counts unchanged observations', () => {
  const buf = Buffer.from(PNG_1X1, 'base64');
  const h1 = screen.hashBuffer(buf);
  assert.equal(h1, screen.hashBuffer(Buffer.from(PNG_1X1, 'base64')));
  assert.match(h1, /^[0-9a-f]{64}$/);
  const cache = screen.createScreenCache();
  assert.deepEqual(cache.observe('a'), { unchanged: 0, hash: 'a' });
  assert.deepEqual(cache.observe('a'), { unchanged: 1, hash: 'a' });
  assert.deepEqual(cache.observe('a'), { unchanged: 2, hash: 'a' });
  assert.deepEqual(cache.observe('b'), { unchanged: 0, hash: 'b' });
});

test('screen: capture with an injected function returns buffer + hash + size; capability shape is honest', async () => {
  const buf = Buffer.from(PNG_1X1, 'base64');
  const shot = await screen.captureScreenshot({ captureFn: async () => buf });
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.hash, screen.hashBuffer(buf));
  assert.equal(shot.width, 1);
  assert.equal(shot.height, 1);
  await assert.rejects(screen.captureScreenshot({ captureFn: async () => Buffer.alloc(0) }), /non-empty Buffer/);
  const cap = screen.capability();
  assert.equal(typeof cap.available, 'boolean');
  if (cap.available) assert.ok(cap.backend, 'available capture must name a backend');
  else assert.ok(cap.reason && cap.reason.length > 0, 'unavailable capture must say why');
});

// ---------------------------------------------------------------------------
// Desktop control (Phase B)
// ---------------------------------------------------------------------------
test('desktop: validateAction allows the allowlist and rejects everything else', () => {
  assert.deepEqual(desktop.validateAction({ action: 'click', x: 0.5, y: 0.5 }), { action: 'click', x: 0.5, y: 0.5, destructive: false });
  assert.equal(desktop.validateAction({ action: 'type', text: 'hi' }).text, 'hi');
  assert.equal(desktop.validateAction({ action: 'scroll' }).amount, 3);
  assert.equal(desktop.validateAction({ action: 'key', key: 'Escape' }).key, 'Escape');
  assert.equal(desktop.validateAction({ action: 'wait' }).ms, 1000);
  assert.equal(desktop.validateAction({ action: 'screenshot' }).action, 'screenshot');
  assert.throws(() => desktop.validateAction({ action: 'delete_file' }), /unknown screen action/);
  assert.throws(() => desktop.validateAction({ action: 'click', x: 2, y: 0 }), /normalised/);
  assert.throws(() => desktop.validateAction({ action: 'type', text: 'x', sensitive: true }), /sensitive/);
  assert.throws(() => desktop.validateAction({ action: 'click', x: 0.1, y: 0.1, sensitive: true }), /sensitive/);
  assert.throws(() => desktop.validateAction({ action: 'key', key: 'A'.repeat(31) }), /key must be/);
  assert.throws(() => desktop.validateAction(null), /must be an object/);
});

test('desktop: destructive actions need an approved approval — pending or missing is refused', () => {
  const pending = run('INSERT INTO approvals (action, details) VALUES (?, ?)', 'phases-test delete', 'draft');
  const pendingId = Number(pending.lastInsertRowid);
  try {
    assert.throws(() => desktop.validateAction({ action: 'click', x: 0.5, y: 0.5, destructive: true }), /approved approval id/);
    assert.throws(() => desktop.validateAction({ action: 'click', x: 0.5, y: 0.5, destructive: true }, { approvalId: pendingId }), /not found or not approved/);
    assert.throws(() => desktop.validateAction({ action: 'click', x: 0.5, y: 0.5, destructive: true }, { approvalId: 999999999 }), /not found or not approved/);
    run("UPDATE approvals SET status = 'approved' WHERE id = ?", pendingId);
    const ok = desktop.validateAction({ action: 'click', x: 0.5, y: 0.5, destructive: true }, { approvalId: pendingId });
    assert.equal(ok.destructive, true);
  } finally {
    run('DELETE FROM approvals WHERE id = ?', pendingId);
  }
});

test('desktop: agent client posts validated actions with the token; status is false when unreachable', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ ok: true, x: 10, y: 20 }) };
  };
  const client = new desktop.DesktopAgentClient({ baseUrl: 'http://127.0.0.1:3101', token: 'tok-123', fetchImpl: fakeFetch });
  const out = await client.act({ action: 'click', x: 0.5, y: 0.5 });
  assert.equal(out.ok, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:3101/action');
  assert.equal(calls[0].opts.headers['X-Anku-Token'], 'tok-123');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { action: 'click', x: 0.5, y: 0.5, destructive: false });
  await assert.rejects(client.act({ action: 'click', x: 5, y: 0 }), /normalised/);
  const dead = new desktop.DesktopAgentClient({ baseUrl: 'http://127.0.0.1:9', token: 't', fetchImpl: async () => { throw new Error('conn refused'); } });
  assert.equal(await dead.status(), false);
});

test('desktop: screenLoop completes, caps actions, stops on unchanged screens, and measures latency', async () => {
  const noopAudit = () => {};
  // (a) done immediately — zero actions.
  let r = await desktop.screenLoop('task', {
    capture: async () => ({ buffer: Buffer.from('shot1'), hash: 'h1' }),
    ground: async () => ({ action: 'done', description: 'already done' }),
    act: async () => { throw new Error('act must not run'); },
    audit: noopAudit,
  });
  assert.equal(r.done, true);
  assert.equal(r.steps.length, 1);
  assert.equal(r.latencies.length, 1);
  assert.ok('captureMs' in r.latencies[0] && 'groundMs' in r.latencies[0] && 'actMs' in r.latencies[0]);

  // (b) two clicks then done — actions + latencies recorded.
  let n = 0;
  const acted = [];
  r = await desktop.screenLoop('task', {
    capture: async () => ({ buffer: Buffer.from('shot' + n), hash: 'h' + (n++) }),
    ground: async () => (n <= 2 ? { action: 'click', x: 0.5, y: 0.5, description: 'click' } : { action: 'done' }),
    act: async (a) => { acted.push(a); return { ok: true }; },
    audit: noopAudit,
  });
  assert.equal(r.done, true);
  assert.equal(acted.length, 2);

  // (c) screen never changes — stops after 2 unchanged observations.
  r = await desktop.screenLoop('task', {
    capture: async () => ({ buffer: Buffer.from('same'), hash: 'same' }),
    ground: async () => ({ action: 'click', x: 0.5, y: 0.5 }),
    act: async () => ({ ok: true }),
    audit: noopAudit,
  });
  assert.equal(r.done, false);
  assert.match(r.stopReason, /unchanged twice/);

  // (d) action cap.
  let count = 0;
  r = await desktop.screenLoop('task', {
    capture: async () => ({ buffer: Buffer.from('s' + count), hash: 'h' + (count++) }),
    ground: async () => ({ action: 'click', x: 0.5, y: 0.5 }),
    act: async () => ({ ok: true }),
    audit: noopAudit,
  }, { maxActions: 3 });
  assert.equal(r.done, false);
  assert.match(r.stopReason, /action cap reached \(3\)/);

  // (e) freeze mid-task stops the loop.
  let first = true;
  r = await desktop.screenLoop('task', {
    capture: async () => ({ buffer: Buffer.from('s' + Math.random()), hash: 'h' + Math.random() }),
    ground: async () => ({ action: 'click', x: 0.5, y: 0.5 }),
    act: async () => { if (first) { first = false; freeze.setFrozen(true, 'phases test'); } return { ok: true }; },
    audit: noopAudit,
  });
  assert.equal(r.done, false);
  assert.match(r.stopReason, /frozen/);
  freeze.setFrozen(false);

  // (f) cannot_see stops with a clear reason.
  r = await desktop.screenLoop('task', {
    capture: async () => ({ buffer: Buffer.from('s'), hash: 'h1' }),
    ground: async () => ({ action: 'cannot_see' }),
    act: async () => { throw new Error('act must not run'); },
    audit: noopAudit,
  });
  assert.equal(r.done, false);
  assert.match(r.stopReason, /not visible/);
});

// ---------------------------------------------------------------------------
// Phone (Phase C)
// ---------------------------------------------------------------------------
test('phone: adb argv allowlist builds exact commands and rejects everything else', () => {
  assert.deepEqual(phone.adbArgv({ action: 'tap', x: 100, y: 200 }), ['shell', 'input', 'tap', '100', '200']);
  assert.deepEqual(phone.adbArgv({ action: 'swipe', x1: 0, y1: 0, x2: 10, y2: 10 }), ['shell', 'input', 'swipe', '0', '0', '10', '10', '300']);
  assert.deepEqual(phone.adbArgv({ action: 'keyevent', key: 'KEYCODE_BACK' }), ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  assert.deepEqual(phone.adbArgv({ action: 'screencap' }), ['exec-out', 'screencap', '-p']);
  assert.deepEqual(phone.adbArgv({ action: 'launch', url: 'https://example.com' }), ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'https://example.com']);
  assert.deepEqual(phone.adbArgv({ action: 'type', text: 'hi there' }), ['shell', 'input', 'text', 'hi%sthere']);
  assert.throws(() => phone.adbArgv({ action: 'shell', cmd: 'rm -rf /' }), /unknown phone action/);
  assert.throws(() => phone.adbArgv({ action: 'tap', x: -1, y: 0 }), /integer pixel/);
  assert.throws(() => phone.adbArgv({ action: 'tap', x: 1.5, y: 0 }), /integer pixel/);
  assert.throws(() => phone.adbArgv({ action: 'keyevent', key: 'KEYCODE_CAMERA' }), /not allowlisted/);
  assert.throws(() => phone.adbArgv({ action: 'launch', url: 'http://evil.test' }), /https URL/);
  assert.throws(() => phone.adbArgv({ action: 'type', text: 'x', sensitive: true }), /sensitive/);
  assert.throws(() => phone.adbArgv({ action: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, ms: 99999 }), /swipe ms/);
});

test('phone: session presence rule — explicit enable, TTL expiry, freeze stops it; iOS honestly labelled', () => {
  assert.equal(phone.phoneSessionActive(), false);
  const s = phone.enableSession({ ttlMs: 60000, reason: 'phases test' });
  assert.equal(s.active, true);
  assert.equal(phone.phoneSessionActive(), true);
  assert.equal(phone.phoneSessionActive(Date.now() + 61000), false, 'session must expire after its TTL');
  phone.enableSession({ ttlMs: 60000 });
  freeze.setFrozen(true, 'phases test');
  assert.equal(phone.phoneSessionActive(), false, 'freeze must stop phone access');
  freeze.setFrozen(false);
  assert.equal(phone.phoneSessionActive(), true);
  phone.disableSession();
  assert.equal(phone.phoneSessionActive(), false);
  assert.throws(() => phone.enableSession({ ttlMs: 1000 }), /ttlMs/);
  assert.equal(phone.IOS.supported, false);
  assert.match(phone.IOS.reason, /Apple does not allow/);
  assert.equal(phone.IOS.messaging, true);
});

test('phone: driver refuses without a session, runs allowlisted adb with a mock executor', async () => {
  const calls = [];
  const driver = new phone.AdbDriver({ executor: async (argv) => { calls.push(argv); return { stdout: Buffer.from('ok'), ok: true }; } });
  await assert.rejects(driver.run({ action: 'tap', x: 1, y: 1 }), /phone session not enabled/);
  phone.enableSession({ ttlMs: 60000 });
  await driver.run({ action: 'tap', x: 10, y: 20 });
  assert.deepEqual(calls[0], ['shell', 'input', 'tap', '10', '20']);
  const devs = await driver.devices.call({ executor: async () => ({ stdout: Buffer.from('List of devices attached\nemulator-1\tdevice\n') }) });
  assert.deepEqual(devs, [{ serial: 'emulator-1', state: 'device' }]);
  phone.disableSession();
});

// ---------------------------------------------------------------------------
// Telegram (Phase C — phone-as-remote)
// ---------------------------------------------------------------------------
test('telegram: disabled without a token; commands handled with a mocked API; other chats ignored', async () => {
  const off = new TelegramBot({ token: '' });
  assert.equal(off.enabled, false);
  assert.match(off.status().reason, /TELEGRAM_BOT_TOKEN/);
  await assert.rejects(off.call('getMe'), /no TELEGRAM_BOT_TOKEN/);

  const sent = [];
  const bot = new TelegramBot({
    token: 'test-token-123', chatId: '111',
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (String(url).endsWith('/sendMessage')) sent.push(body);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
    handlers: {
      onMessage: async (text) => `echo:${text}`,
      getStatus: async () => ({ brain_order: ['ollama'], frozen: false, queue: { pending: 0 }, approvals_pending: 1 }),
      setFrozen: (f, reason) => ({ frozen: f, reason }),
      decideApproval: async (id, status) => ({ ok: true }),
    },
  });
  let h = await bot.handleUpdate({ message: { chat: { id: 111 }, text: '/start' } });
  assert.equal(h.command, 'start');
  assert.match(sent[0].text, /Personal AI/);
  h = await bot.handleUpdate({ message: { chat: { id: 111 }, text: 'hello' } });
  assert.equal(h.command, 'message');
  assert.equal(sent[1].text, 'echo:hello');
  h = await bot.handleUpdate({ message: { chat: { id: 111 }, text: '/freeze' } });
  assert.equal(h.command, 'freeze');
  assert.match(sent[2].text, /Frozen/);
  h = await bot.handleUpdate({ message: { chat: { id: 999 }, text: 'hello' } });
  assert.equal(h.handled, false, 'a non-configured chat must get no reply');
  assert.equal(sent.length, 3);
  h = await bot.handleUpdate({ message: { chat: { id: 111 }, text: '/approve 7' } });
  assert.equal(h.command, 'approve');
  assert.match(sent[3].text, /Recorded only/);
  // The token must never appear in any message text.
  assert.doesNotMatch(JSON.stringify(sent), /test-token-123/);
});

// ---------------------------------------------------------------------------
// WhatsApp (Phase C — scaffolding, guards only)
// ---------------------------------------------------------------------------
test('whatsapp: refuses to start without every guard; spare-number confirmation is mandatory', async () => {
  const g0 = whatsapp.guards();
  assert.equal(g0.ok, false);
  assert.ok(g0.problems.some(p => /WHATSAPP_ENABLED/.test(p)));
  assert.ok(g0.problems.some(p => /SPARE_NUMBER/.test(p)));
  await assert.rejects(whatsapp.startWhatsApp({}), /whatsapp refused/);
  process.env.WHATSAPP_ENABLED = 'yes';
  process.env.WHATSAPP_SPARE_NUMBER_CONFIRMED = 'yes';
  const g1 = whatsapp.guards();
  // The Baileys package is not installed on this VM — the guard must say so.
  assert.equal(g1.ok, false);
  assert.ok(g1.problems.some(p => /baileys/i.test(p)), 'must report the missing package honestly');
  assert.match(whatsapp.status().warning, /Spare number only/);
});

// ---------------------------------------------------------------------------
// Browser (spec §1.7)
// ---------------------------------------------------------------------------
test('browser: action validation — https/private/submit rules enforced before anything runs', () => {
  assert.equal(browserMod.validateAction({ action: 'goto', url: 'https://example.com' }).url, 'https://example.com');
  assert.throws(() => browserMod.validateAction({ action: 'goto', url: 'http://example.com' }), /https URL/);
  assert.throws(() => browserMod.validateAction({ action: 'goto', url: 'https://127.0.0.1:3100/' }), /private\/local/);
  assert.throws(() => browserMod.validateAction({ action: 'goto', url: 'https://10.0.0.5/' }), /private\/local/);
  assert.throws(() => browserMod.validateAction({ action: 'submit', selector: 'form' }), /unknown browser action/);
  assert.throws(() => browserMod.validateAction({ action: 'post', selector: 'x' }), /unknown browser action/);
  assert.throws(() => browserMod.validateAction({ action: 'type', selector: '#q', text: 'x', sensitive: true }), /sensitive/);
  assert.throws(() => browserMod.validateAction({ action: 'click', selector: '' }), /selector required/);
  assert.throws(() => browserMod.validateAction({ action: 'wait', ms: 99999 }), /wait ms/);
});

test('browser: injected driver runs goto/click/type/text/screenshot; password fields refused', async () => {
  const calls = [];
  const driver = {
    goto: async (url) => { calls.push(['goto', url]); },
    click: async (sel) => { calls.push(['click', sel]); },
    fill: async (sel, text) => { calls.push(['fill', sel, text]); },
    evaluate: async (fn, sel) => (sel === '#pw' ? 'password' : 'text'),
    screenshot: async () => Buffer.from('fake-png'),
    waitForTimeout: async (ms) => { calls.push(['wait', ms]); },
    title: async () => 'Fake Title',
  };
  const agent = new browserMod.BrowserAgent({ driver });
  await agent.act({ action: 'goto', url: 'https://example.com' });
  await agent.act({ action: 'click', selector: '#btn' });
  await agent.act({ action: 'type', selector: '#q', text: 'hello' });
  const t = await agent.act({ action: 'text' });
  assert.equal(typeof t.text, 'string');
  const s = await agent.act({ action: 'screenshot' });
  assert.equal(Buffer.from(s.imageBase64, 'base64').toString(), 'fake-png');
  const ti = await agent.act({ action: 'title' });
  assert.equal(ti.title, 'Fake Title');
  assert.deepEqual(calls[0], ['goto', 'https://example.com']);
  assert.deepEqual(calls[2], ['fill', '#q', 'hello']);
  await assert.rejects(agent.act({ action: 'type', selector: '#pw', text: 'secret' }), /password field/);
  await agent.close();
});

test('browser: REAL chromium launch + render + read + screenshot on this VM (local page; external goto unproven here)', async () => {
  const cap = browserMod.capability();
  if (!cap.available) {
    // Graceful degradation is the honest outcome when the binary is missing.
    assert.ok(cap.reason && cap.reason.length > 0);
    const agent = new browserMod.BrowserAgent({});
    await assert.rejects(agent.act({ action: 'goto', url: 'https://example.com' }), /browser unavailable/);
    return;
  }
  const agent = new browserMod.BrowserAgent({});
  try {
    const page = await agent.ensurePage();
    await page.setContent('<html><head><title>Phases Test</title></head><body><h1>Hello Browser</h1></body></html>');
    const t = await agent.act({ action: 'text' });
    assert.match(t.text, /Hello Browser/);
    const ti = await agent.act({ action: 'title' });
    assert.equal(ti.title, 'Phases Test');
    const s = await agent.act({ action: 'screenshot' });
    const png = Buffer.from(s.imageBase64, 'base64');
    assert.ok(png.length > 100, 'screenshot must be a real PNG');
    assert.equal(png.readUInt32BE(12), 0x49484452, 'PNG IHDR chunk present');
  } finally {
    await agent.close();
  }
});

// ---------------------------------------------------------------------------
// Offline queue (Phase D)
// ---------------------------------------------------------------------------
test('queue: backoff schedule is 1m/5m/15m/1h/6h and caps at the last step', () => {
  assert.deepEqual(queue.BACKOFF_MS, [60000, 300000, 900000, 3600000, 21600000]);
  assert.equal(queue.backoffMs(1), 60000);
  assert.equal(queue.backoffMs(2), 300000);
  assert.equal(queue.backoffMs(5), 21600000);
  assert.equal(queue.backoffMs(99), 21600000);
  assert.throws(() => queue.enqueue('bogus_kind', {}), /unknown outbox kind/);
  assert.throws(() => queue.enqueue('notify', {}, { maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => queue.enqueue('notify', {}, { maxAttempts: 21 }), /maxAttempts/);
});

test('queue: enqueue → claim → complete/fail with retry time → dead after max attempts; stale claims swept', async () => {
  const id1 = queue.enqueue('notify', { marker: 'phases-test-1', title: 't1', body: 'b1' });
  const id2 = queue.enqueue('notify', { marker: 'phases-test-2', title: 't2', body: 'b2' }, { maxAttempts: 2 });
  try {
    const claimed = queue.claimDue(10, new Date());
    assert.ok(claimed.includes(id1) && claimed.includes(id2), 'both due jobs claimed');
    assert.deepEqual(queue.claimDue(10, new Date()), [], 'claimed jobs are not claimed twice');
    queue.complete(id1);
    assert.equal(get('SELECT status FROM outbox WHERE id = ?', id1).status, 'done');
    const before = new Date();
    queue.fail(id2, 'boom', before);
    const row = get('SELECT status, attempts, next_retry_at FROM outbox WHERE id = ?', id2);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.ok(new Date(row.next_retry_at.replace(' ', 'T') + 'Z') > before, 'next retry is in the future (1m backoff)');
    // Second failure exhausts maxAttempts=2 -> dead, never silently dropped.
    queue.claimDue(10, new Date(Date.now() + 120000));
    queue.fail(id2, 'boom again', new Date());
    assert.equal(get('SELECT status FROM outbox WHERE id = ?', id2).status, 'dead');
    // Stale claim sweep: a job stuck in 'processing' returns to pending.
    const id3 = queue.enqueue('notify', { marker: 'phases-test-3' });
    queue.claimDue(10, new Date());
    run("UPDATE outbox SET updated_at = datetime('now', '-20 minutes') WHERE id = ?", id3);
    assert.equal(queue.sweepStale(new Date()), 1);
    assert.equal(get('SELECT status FROM outbox WHERE id = ?', id3).status, 'pending');
    run('DELETE FROM outbox WHERE id = ?', id3);
  } finally {
    run('DELETE FROM outbox WHERE id IN (?, ?)', id1, id2);
  }
});

test('queue: drain runs jobs in order with the worker, respects freeze, and survives a new connection (restart)', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { DB_PATH } = require('../db');
  const idA = queue.enqueue('notify', { marker: 'phases-test-drain-a' });
  const idB = queue.enqueue('notify', { marker: 'phases-test-drain-b' });
  try {
    // Restart survival: a brand-new connection sees the queued rows.
    const fresh = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const rows = fresh.prepare("SELECT id FROM outbox WHERE status = 'pending' AND id IN (?, ?)").all(idA, idB);
      assert.equal(rows.length, 2, 'queued jobs survive a new connection (restart)');
    } finally { fresh.close(); }
    const seen = [];
    const out = await queue.drain(async (kind, payload, id) => {
      seen.push(id);
      if (id === idB) throw new Error('worker boom');
    });
    assert.deepEqual(seen, [idA, idB], 'drain order is oldest-first');
    assert.equal(out.done, 1);
    assert.equal(out.failed, 1);
    assert.equal(get('SELECT status FROM outbox WHERE id = ?', idA).status, 'done');
    assert.equal(get('SELECT status FROM outbox WHERE id = ?', idB).status, 'pending');
    // Freeze: drain processes nothing.
    const idC = queue.enqueue('notify', { marker: 'phases-test-drain-c' });
    freeze.setFrozen(true, 'phases test');
    const frozenOut = await queue.drain(async () => { throw new Error('worker must not run while frozen'); });
    assert.equal(frozenOut.frozen, true);
    assert.equal(frozenOut.drained, 0);
    assert.equal(get('SELECT status FROM outbox WHERE id = ?', idC).status, 'pending');
    freeze.setFrozen(false);
    run('DELETE FROM outbox WHERE id = ?', idC);
  } finally {
    run('DELETE FROM outbox WHERE id IN (?, ?)', idA, idB);
  }
});

// ---------------------------------------------------------------------------
// Routines (Phase E)
// ---------------------------------------------------------------------------
test('routines: schedule validation rejects bad shapes; approval rules can only be stricter', () => {
  assert.deepEqual(routines.validateSchedule({ type: 'daily', time: '09:00' }),
    { type: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(routines.validateSchedule({ type: 'daily', time: '09:00', weekdays: [1, 5] }),
    { type: 'daily', time: '09:00', weekdays: [1, 5] });
  assert.deepEqual(routines.validateSchedule({ type: 'interval', minutes: 60 }), { type: 'interval', minutes: 60 });
  assert.throws(() => routines.validateSchedule({ type: 'daily', time: '9:00' }), /HH:MM/);
  assert.throws(() => routines.validateSchedule({ type: 'daily', time: '25:00' }), /HH:MM/);
  assert.throws(() => routines.validateSchedule({ type: 'daily', time: '09:00', weekdays: [] }), /weekdays/);
  assert.throws(() => routines.validateSchedule({ type: 'daily', time: '09:00', weekdays: [7] }), /weekdays/);
  assert.throws(() => routines.validateSchedule({ type: 'interval', minutes: 4 }), /minutes >= 5/);
  assert.throws(() => routines.validateSchedule({ type: 'cron', expr: '* * * * *' }), /daily.*interval/);
  assert.throws(() => routines.validateSchedule(null), /must be an object/);
  assert.throws(() => routines.createRoutine({ name: 'x', schedule: { type: 'daily', time: '09:00' }, task: 't', approval_rule: 'loose' }), /stricter/);
  assert.throws(() => routines.createRoutine({ name: 'x', schedule: { type: 'daily', time: '09:00' }, task: 't', missed_policy: 'drop' }), /missed_policy/);
  assert.throws(() => routines.createRoutine({ name: '', schedule: { type: 'daily', time: '09:00' }, task: 't' }), /name required/);
  assert.throws(() => routines.createRoutine({ name: 'x', schedule: { type: 'daily', time: '09:00' }, task: '' }), /task required/);
});

test('routines: nextRunAfter computes daily + interval runs in server local time', () => {
  // A Monday 08:00 local: daily 09:00 weekdays [1] -> today 09:00.
  const monday0800 = new Date(2026, 10, 16, 8, 0, 0); // 16 Nov 2026 is a Monday
  assert.equal(monday0800.getDay(), 1);
  const next = routines.nextRunAfter({ type: 'daily', time: '09:00', weekdays: [1] }, monday0800);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getDate(), 16);
  // Same day 10:00 -> next Monday 09:00 (7 days later).
  const monday1000 = new Date(2026, 10, 16, 10, 0, 0);
  const next2 = routines.nextRunAfter({ type: 'daily', time: '09:00', weekdays: [1] }, monday1000);
  assert.equal(next2.getDate(), 23);
  // Interval: strictly after `from`.
  const iv = routines.nextRunAfter({ type: 'interval', minutes: 30 }, monday0800);
  assert.equal(iv.getTime() - monday0800.getTime(), 30 * 60000);
});

test('routines: tick runs due routines once, locks against double-run, records evidence + job', async () => {
  const past = new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19);
  const r = run(`INSERT INTO routines (name, schedule, task, scope, next_run_at) VALUES (?, ?, ?, ?, ?)`,
    'phases-test-routine', JSON.stringify({ type: 'interval', minutes: 60 }), 'phases test task', '', past);
  const id = Number(r.lastInsertRowid);
  try {
    let runs = 0;
    const out = await routines.tick(async (task) => { runs++; return { reply: 'did it', model: 'test-model', provider: 'test' }; });
    assert.equal(runs, 1, 'due routine runs once');
    assert.equal(out.results[0].status, 'done');
    const runRows = routines.listRuns(id);
    assert.equal(runRows.length, 1);
    assert.equal(runRows[0].status, 'done');
    assert.match(runRows[0].evidence, /did it/);
    assert.ok(all("SELECT * FROM jobs WHERE task LIKE '[routine:phases-test-routine]%'").length >= 1, 'a job row is written too');
    // Second tick immediately: next_run_at is now in the future — no re-run.
    const out2 = await routines.tick(async () => { runs++; return {}; });
    assert.equal(runs, 1, 'must not double-run');
    assert.equal(out2.ran, 0);
    // Run lock: a routine already marked running is skipped, never double-run.
    run("UPDATE routines SET running = 1, next_run_at = datetime('now', '-1 minute') WHERE id = ?", id);
    const locked = await routines.runRoutine(routines.getRoutine(id), async () => { runs++; return {}; });
    assert.equal(locked.status, 'already_running');
    assert.equal(runs, 1, 'locked routine must not run');
    run('UPDATE routines SET running = 0 WHERE id = ?', id);
  } finally {
    run('DELETE FROM routine_runs WHERE routine_id = ?', id);
    run('DELETE FROM routines WHERE id = ?', id);
    run("DELETE FROM jobs WHERE task LIKE '[routine:phases-test-routine]%'");
  }
});

test('routines: dry run never calls the runner; missed policy marks missed; freeze skips', async () => {
  const past = new Date(Date.now() - 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const mk = (name, policy) => Number(run(
    'INSERT INTO routines (name, schedule, task, missed_policy, next_run_at) VALUES (?, ?, ?, ?, ?)',
    name, JSON.stringify({ type: 'interval', minutes: 60 }), 't', policy, past).lastInsertRowid);
  const idDry = mk('phases-test-dry', 'run_late');
  const idMiss = mk('phases-test-miss', 'mark_missed');
  const idFrz = mk('phases-test-frz', 'run_late');
  try {
    let calls = 0;
    const dry = await routines.runRoutine(routines.getRoutine(idDry), async () => { calls++; return {}; }, { dryRun: true });
    assert.equal(dry.status, 'dry_run');
    assert.equal(calls, 0, 'dry run must never call the runner');
    const out = await routines.tick(async () => { calls++; return {}; }, { markMissedOlderThanMs: 5 * 60000 });
    const miss = out.results.find(x => x.routine_id === idMiss);
    assert.equal(miss.status, 'missed', 'past-due + mark_missed records a missed run');
    assert.ok(routines.listRuns(idMiss).some(x => x.status === 'missed'));
    freeze.setFrozen(true, 'phases test');
    const frz = await routines.runRoutine(routines.getRoutine(idFrz), async () => { calls++; return {}; });
    assert.equal(frz.status, 'skipped_frozen');
    freeze.setFrozen(false);
    const tickFrz = await routines.tick(async () => { calls++; return {}; });
    assert.equal(tickFrz.skipped_frozen, false, 'unfrozen tick proceeds normally');
  } finally {
    for (const id of [idDry, idMiss, idFrz]) {
      run('DELETE FROM routine_runs WHERE routine_id = ?', id);
      run('DELETE FROM routines WHERE id = ?', id);
    }
  }
});

// ---------------------------------------------------------------------------
// Sync (Phase D)
// ---------------------------------------------------------------------------
test('sync: merge is last-write-wins, conflicts are surfaced never overwritten, malformed skipped', () => {
  // Local note, device A, older timestamp.
  const local = run(`INSERT INTO notes (title, body, device_id, updated_at) VALUES (?, ?, ?, ?)`,
    'sync-test-local', 'local body', 'device-a', '2026-11-14 10:00:00');
  const id = Number(local.lastInsertRowid);
  try {
    // Incoming NEWER from device B -> applied.
    let res = sync.mergeIncoming({ notes: [{ id, title: 'sync-test-newer', body: 'newer body', created_at: '2026-11-14 10:00:00', updated_at: '2026-11-14 11:00:00', device_id: 'device-b' }] }, 'device-b');
    assert.equal(res.applied, 1);
    assert.equal(get('SELECT title FROM notes WHERE id = ?', id).title, 'sync-test-newer');
    // Incoming OLDER -> kept.
    res = sync.mergeIncoming({ notes: [{ id, title: 'sync-test-older', body: 'older', created_at: '2026-11-14 10:00:00', updated_at: '2026-11-14 09:00:00', device_id: 'device-b' }] }, 'device-b');
    assert.equal(res.kept, 1);
    assert.equal(get('SELECT title FROM notes WHERE id = ?', id).title, 'sync-test-newer');
    // SAME timestamp, different content, different device -> conflict, local kept.
    res = sync.mergeIncoming({ notes: [{ id, title: 'sync-test-conflict', body: 'conflict', created_at: '2026-11-14 10:00:00', updated_at: '2026-11-14 11:00:00', device_id: 'device-c' }] }, 'device-c');
    assert.equal(res.conflicts.length, 1);
    assert.equal(get('SELECT title FROM notes WHERE id = ?', id).title, 'sync-test-newer');
    assert.ok(sync.listConflicts().some(c => c.record_id === id && c.table_name === 'notes'), 'conflict stored + listed');
    // Malformed records skipped, never trusted.
    res = sync.mergeIncoming({ notes: [{ title: 'no id' }, null, { id: 'x' }] }, 'device-b');
    assert.equal(res.skipped, 3);
    assert.equal(res.applied, 0);
    // recordsSince returns the note when the cutoff is older.
    const since = sync.recordsSince('2026-11-14 10:30:00');
    assert.ok(since.notes.some(n => n.id === id), 'recordsSince finds recently updated rows');
    const sinceLater = sync.recordsSince('2026-11-14 12:00:00');
    assert.ok(!sinceLater.notes.some(n => n.id === id), 'recordsSince excludes rows older than the cutoff');
  } finally {
    run('DELETE FROM notes WHERE id = ?', id);
    run('DELETE FROM sync_conflicts WHERE record_id = ?', id);
  }
});

// ---------------------------------------------------------------------------
// Live API tests (server started by tests/run-tests.sh)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = process.env.ANKU_TOKEN || '';
if (!TOKEN) {
  const m = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').match(/ANKU_TOKEN=(\S+)/);
  TOKEN = m ? m[1] : '';
}
const H = { 'Content-Type': 'application/json', 'X-Anku-Token': TOKEN };
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

test('api: status reports freeze, queue, routines, phone session and capabilities', async () => {
  const { status, body } = await api('/api/status');
  assert.equal(status, 200);
  assert.ok('frozen' in body && typeof body.frozen.frozen === 'boolean');
  assert.ok(body.queue && typeof body.queue.pending === 'number');
  assert.ok(body.routines && typeof body.routines.total === 'number');
  assert.ok(body.phone_session && typeof body.phone_session.active === 'boolean');
  assert.ok(body.capabilities.screen_capture && 'available' in body.capabilities.screen_capture);
  assert.ok(body.capabilities.desktop_agent && 'available' in body.capabilities.desktop_agent);
  assert.ok(body.capabilities.browser && 'available' in body.capabilities.browser);
  assert.ok('enabled' in body.capabilities.telegram);
  assert.ok('enabled' in body.capabilities.whatsapp);
});

test('api: freeze toggles and persists across requests', async () => {
  try {
    let r = await api('/api/freeze', { method: 'POST', body: JSON.stringify({ frozen: true, reason: 'phases api test' }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.frozen, true);
    r = await api('/api/freeze');
    assert.equal(r.body.frozen, true);
    assert.equal(r.body.reason, 'phases api test');
    r = await api('/api/freeze', { method: 'POST', body: JSON.stringify({ frozen: 'yes' }) });
    assert.equal(r.status, 400, 'frozen must be a boolean');
  } finally {
    await api('/api/freeze', { method: 'POST', body: JSON.stringify({ frozen: false }) });
  }
  const r = await api('/api/freeze');
  assert.equal(r.body.frozen, false);
});

test('api: queue enqueue + drain completes a notify job and writes the note', async () => {
  const title = 'phases-test-queue-note-' + Date.now();
  const e = await api('/api/queue', { method: 'POST', body: JSON.stringify({ kind: 'notify', payload: { title, body: 'queued body' } }) });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.ok(e.body.outbox_id);
  const bad = await api('/api/queue', { method: 'POST', body: JSON.stringify({ kind: 'nope', payload: {} }) });
  assert.equal(bad.status, 400);
  // Drain (the scheduler may drain first — poll for the done state either way).
  await api('/api/queue/drain', { method: 'POST', body: JSON.stringify({ limit: 10 }) });
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    const q = await api('/api/queue');
    const item = q.body.items.find(x => x.id === e.body.outbox_id);
    if (item && item.status === 'done') done = true;
    else await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(done, true, 'queued notify job must reach done');
  const notes = await api('/api/notes');
  assert.ok(notes.body.notes.some(n => n.title === title), 'notify worker wrote the note');
});

test('api: routines CRUD + dry run + run history; bad schedules rejected', async () => {
  const c = await api('/api/routines', {
    method: 'POST',
    body: JSON.stringify({ name: 'phases-test-api-routine', task: 'phases test task', schedule: { type: 'daily', time: '09:00' } }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.routine.id;
  try {
    assert.equal(c.body.routine.schedule.type, 'daily');
    const bad = await api('/api/routines', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad', task: 't', schedule: { type: 'daily', time: '99:99' } }),
    });
    assert.equal(bad.status, 400);
    const loose = await api('/api/routines', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad', task: 't', schedule: { type: 'daily', time: '09:00' }, approval_rule: 'auto_send' }),
    });
    assert.equal(loose.status, 400, 'approval rules can only be stricter');
    const runRes = await api(`/api/routines/${id}/run`, { method: 'POST', body: JSON.stringify({ dry_run: true }) });
    assert.equal(runRes.status, 200);
    assert.equal(runRes.body.status, 'dry_run');
    const runs = await api(`/api/routines/${id}/runs`);
    assert.ok(runs.body.runs.some(x => x.status === 'dry_run'));
    const dis = await api(`/api/routines/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    assert.equal(dis.body.routine.enabled, false);
    const list = await api('/api/routines');
    assert.ok(list.body.routines.some(x => x.id === id));
  } finally {
    const d = await api(`/api/routines/${id}`, { method: 'DELETE' });
    assert.equal(d.status, 200);
  }
  const gone = await api(`/api/routines/${id}/runs`);
  assert.equal(gone.status, 404);
});

test('api: sync push/pull round-trip with a new record; conflicts listed; bad push rejected', async () => {
  const recId = 424242001 + Math.floor(Math.random() * 1000);
  const push = await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      device_id: 'phases-test-device',
      records: { notes: [{ id: recId, title: 'phases-sync-note', body: 'from another device', created_at: '2026-11-14 12:00:00', updated_at: '2026-11-14 12:00:00', device_id: 'phases-test-device' }] },
    }),
  });
  assert.equal(push.status, 200, JSON.stringify(push.body));
  assert.equal(push.body.applied, 1);
  try {
    const pull = await api('/api/sync/pull?since=2026-11-14 11:00:00');
    assert.equal(pull.status, 200);
    assert.ok(pull.body.records.notes.some(n => n.id === recId), 'pushed record comes back in a pull');
    assert.ok(pull.body.device_id, 'pull reports this device id');
    const conf = await api('/api/sync/conflicts');
    assert.equal(conf.status, 200);
    assert.ok(Array.isArray(conf.body.conflicts));
  } finally {
    run('DELETE FROM notes WHERE id = ?', recId);
  }
  const bad = await api('/api/sync/push', { method: 'POST', body: JSON.stringify({ records: {} }) });
  assert.equal(bad.status, 400);
});

test('api: phone session enable/disable; actions refused without a session; iOS labelled restricted', async () => {
  const s = await api('/api/phone');
  assert.equal(s.status, 200);
  assert.equal(s.body.ios.supported, false);
  assert.match(s.body.ios.reason, /Apple does not allow/);
  const denied = await api('/api/phone/act', { method: 'POST', body: JSON.stringify({ action: { action: 'tap', x: 1, y: 1 } }) });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /session not enabled/);
  const en = await api('/api/phone/enable', { method: 'POST', body: JSON.stringify({ ttl_ms: 60000, reason: 'phases api test' }) });
  assert.equal(en.status, 200);
  assert.equal(en.body.session.active, true);
  // No adb/device on this VM — the action must fail cleanly with an adb error, not hang.
  const act = await api('/api/phone/act', { method: 'POST', body: JSON.stringify({ action: { action: 'devices' } }) });
  assert.equal(act.status, 403);
  assert.match(act.body.error, /adb/i);
  const dis = await api('/api/phone/disable', { method: 'POST', body: '{}' });
  assert.equal(dis.body.session.active, false);
});

test('api: browser status + validation errors; no submit action exists', async () => {
  const s = await api('/api/browser');
  assert.equal(s.status, 200);
  assert.equal(typeof s.body.available, 'boolean');
  const bad = await api('/api/browser/act', { method: 'POST', body: JSON.stringify({ action: { action: 'goto', url: 'http://example.com' } }) });
  assert.equal(bad.status, 403);
  assert.match(bad.body.error, /https URL/);
  const submit = await api('/api/browser/act', { method: 'POST', body: JSON.stringify({ action: { action: 'submit', selector: 'form' } }) });
  assert.equal(submit.status, 403);
  assert.match(submit.body.error, /unknown browser action/);
});

test('api: screen capture/act/loop fail cleanly with no desktop on this VM', async () => {
  const cap = await api('/api/screen/capture', { method: 'POST', body: '{}' });
  // Either a real capture (a backend exists) or a clear 503 — never a crash, never fake pixels.
  assert.ok([200, 503].includes(cap.status), `unexpected status ${cap.status}`);
  if (cap.status === 503) assert.ok(cap.body.error && cap.body.error.length > 0);
  if (cap.status === 200) assert.ok(cap.body.hash && cap.body.imageBase64);
  const act = await api('/api/screen/act', { method: 'POST', body: JSON.stringify({ action: { action: 'click', x: 5, y: 0 } }) });
  assert.equal(act.status, 403, 'out-of-range click must be refused before any agent call');
  const loop = await api('/api/screen/loop', { method: 'POST', body: JSON.stringify({ task: 'phases test loop' }) });
  assert.equal(loop.status, 503, 'no desktop agent + no capture backend on this VM must surface as 503');
  assert.ok(loop.body.error && loop.body.error.length > 0);
  const noTask = await api('/api/screen/loop', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(noTask.status, 400);
});

test('api: channels report telegram/whatsapp disabled without credentials; frontend serves new panels', async () => {
  const c = await api('/api/channels');
  assert.equal(c.status, 200);
  assert.equal(c.body.telegram.enabled, false, 'no TELEGRAM_BOT_TOKEN on this VM');
  assert.equal(c.body.whatsapp.enabled, false, 'whatsapp guards fail without explicit confirmation');
  assert.ok(c.body.whatsapp.problems.some(p => /SPARE_NUMBER/.test(p)));
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Ankush's Personal AI/);
  assert.match(html, /Freeze agent/);
  assert.match(html, /Routines/);
  assert.match(html, /Offline queue/);
});
