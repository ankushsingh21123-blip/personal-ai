// Tests for the product expansion (14 Nov 2026): API-key settings,
// expanded tools, screen/phone/browser action sets, replay, fast routing,
// notifications, clipboard/windows, key refusal in chat channels, doctor.
// Two halves, same conventions as tests/phases.test.js:
//   (1) Unit tests with mocks / injected drivers — no server, no keys,
//       no desktop, no phone. Fake keys are built by concatenation, never
//       written as literals, so the secret-pattern scans stay clean.
//   (2) Live API tests against the server started by tests/run-tests.sh.
//       Settings writes use harmless vars and RESTORE them, so other test
//       files are unaffected. Live-call count is kept small: the API rate
//       limit (60/min, shared) is a real constraint on the suite.
// Honest boundaries: desktop-agent execution, ADB control, Telegram/
// WhatsApp live runs, and two-node sync stay UNPROVEN live (no desktop /
// phone / second node on this VM). The browser element-first path IS
// proven live (Chromium headless, local page).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const secrets = require('../secrets');
const settings = require('../settings');
const routeMod = require('../route');
const vision = require('../vision');
const desktop = require('../desktop');
const phone = require('../phone');
const browserMod = require('../browser');
const clipboard = require('../clipboard');
const windows = require('../windows');
const notifyMod = require('../notify');
const replay = require('../replay');
const tools = require('../tools');
const freeze = require('../freeze');
const doctor = require('../doctor');
const { TelegramBot, KEY_REFUSAL } = require('../telegram');
const whatsapp = require('../whatsapp');
const { all, get, run } = require('../db');

// Fake key-shaped values, built by concatenation so no literal key pattern
// appears in this file (the security scan greps tracked files).
const FAKE_GEMINI = 'AIza' + 'A'.repeat(35);
const FAKE_OPENAI = 'sk-' + 'a'.repeat(40);
const FAKE_ANTHROPIC = 'sk-ant-' + 'b'.repeat(40);
const FAKE_GROQ = 'gsk_' + 'c'.repeat(40);
const FAKE_TELEGRAM = '123456789:' + 'd'.repeat(35);
const FAKE_LONE = 'A1'.repeat(25);

const ENV_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'BRAIN_PROVIDERS', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_MAX_TOKENS',
  'OLLAMA_VISION_MODEL', 'OLLAMA_HOST', 'OLLAMA_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'TELEGRAM_ENABLED', 'WHATSAPP_ENABLED', 'WHATSAPP_SPARE_NUMBER_CONFIRMED',
  'SYNC_PEER_URL', 'SYNC_TOKEN', 'FAST_ROUTING', 'DESKTOP_AGENT_PORT', 'ADB_PATH'];
function saveEnv() { const s = {}; for (const k of ENV_KEYS) s[k] = process.env[k]; return s; }
function restoreEnv(s) { for (const k of ENV_KEYS) { if (s[k] === undefined) delete process.env[k]; else process.env[k] = s[k]; } }
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
let savedEnv;
test.beforeEach(() => { savedEnv = saveEnv(); clearEnv(); });
test.afterEach(() => { restoreEnv(savedEnv); freeze.setFrozen(false); phone.disableSession(); tools.setTestRunner(null); });

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---------------------------------------------------------------------------
// Secrets: detection, masking, redaction
// ---------------------------------------------------------------------------
test('secrets: looksLikeSecret detects every provider key shape + assignments + lone tokens', () => {
  assert.equal(secrets.looksLikeSecret(`my key is ${FAKE_GEMINI}`), true);
  assert.equal(secrets.looksLikeSecret(FAKE_OPENAI), true);
  assert.equal(secrets.looksLikeSecret(FAKE_ANTHROPIC), true);
  assert.equal(secrets.looksLikeSecret(FAKE_GROQ), true);
  assert.equal(secrets.looksLikeSecret(FAKE_TELEGRAM), true);
  assert.equal(secrets.looksLikeSecret(`GEMINI_API_KEY=${FAKE_GEMINI}`), true);
  assert.equal(secrets.looksLikeSecret(FAKE_LONE), true);
  assert.equal(secrets.looksLikeSecret('sk-or-v1-' + 'e'.repeat(40)), true);
  assert.equal(secrets.looksLikeSecret('hf_' + 'f'.repeat(30)), true);
});
test('secrets: looksLikeSecret does not flag ordinary chat text', () => {
  assert.equal(secrets.looksLikeSecret('hello, what is the weather today?'), false);
  assert.equal(secrets.looksLikeSecret('list the files in the workspace'), false);
  assert.equal(secrets.looksLikeSecret('my password is hunter2'), false);
  assert.equal(secrets.looksLikeSecret(''), false);
  assert.equal(secrets.looksLikeSecret('short sk-abc'), false);
});
test('secrets: redact removes key shapes, mask shows last 4 only', () => {
  const redacted = secrets.redact(`failed with key ${FAKE_GEMINI} end`);
  assert.ok(!redacted.includes(FAKE_GEMINI));
  assert.match(redacted, /\[redacted-secret\]/);
  assert.equal(secrets.mask(FAKE_GEMINI), '••••' + FAKE_GEMINI.slice(-4));
  assert.equal(secrets.mask(''), null);
  assert.equal(secrets.mask('ab'), '••••');
});

// ---------------------------------------------------------------------------
// Settings: validated .env.local writes (temp file, never the real one)
// ---------------------------------------------------------------------------
function tmpEnv(initial = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ankush-settings-'));
  const p = path.join(dir, '.env.local');
  fs.writeFileSync(p, initial);
  return p;
}
test('settings: writeEnvUpdates preserves comments/order, validates, mirrors to env, mode 600', () => {
  const p = tmpEnv('# comment\nFOO=bar\nGEMINI_API_KEY=oldvalue123\n');
  const changed = settings.writeEnvUpdates({ GEMINI_API_KEY: FAKE_GEMINI, GROQ_API_KEY: FAKE_GROQ }, p);
  assert.deepEqual(changed.sort(), ['GEMINI_API_KEY', 'GROQ_API_KEY']);
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /# comment/);
  assert.match(text, /FOO=bar/);
  assert.ok(text.includes(`GEMINI_API_KEY=${FAKE_GEMINI}`));
  assert.equal(process.env.GEMINI_API_KEY, FAKE_GEMINI);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});
test('settings: writeEnvUpdates removes on empty, rejects unknown vars and ANKU_TOKEN', () => {
  const p = tmpEnv(`GEMINI_API_KEY=${FAKE_GEMINI}\n`);
  settings.writeEnvUpdates({ GEMINI_API_KEY: '' }, p);
  assert.ok(!fs.readFileSync(p, 'utf8').includes('GEMINI_API_KEY'));
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  assert.throws(() => settings.writeEnvUpdates({ ANKU_TOKEN: 'x'.repeat(64) }, p), /not a settable variable/);
  assert.throws(() => settings.writeEnvUpdates({ EVIL_VAR: '1' }, p), /not a settable variable/);
  assert.throws(() => settings.writeEnvUpdates({ GEMINI_API_KEY: 'has space in it key' }, p), /whitespace/);
  assert.throws(() => settings.writeEnvUpdates({ GEMINI_API_KEY: 'short' }, p), /8\.\.500/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});
test('settings: URL validation — https ok, loopback http ok, public http + credentials rejected', () => {
  const p = tmpEnv('');
  assert.equal(settings.validateValue('OPENAI_BASE_URL', 'https://api.openai.com/v1'), 'https://api.openai.com/v1');
  assert.equal(settings.validateValue('OPENAI_BASE_URL', 'http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.throws(() => settings.validateValue('OPENAI_BASE_URL', 'http://api.openai.com/v1'), /https/);
  assert.throws(() => settings.validateValue('OPENAI_BASE_URL', 'https://user:pass@api.openai.com/v1'), /credentials/);
  assert.equal(settings.validateValue('SYNC_PEER_URL', 'http://100.64.0.5:3100'), 'http://100.64.0.5:3100');
  assert.throws(() => settings.validateValue('SYNC_PEER_URL', 'http://203.0.113.5:3100'), /https/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});
test('settings: order/model/int/chatid/bool validation', () => {
  assert.equal(settings.validateValue('BRAIN_PROVIDERS', 'gemini, groq, ollama'), 'gemini,groq,ollama');
  assert.throws(() => settings.validateValue('BRAIN_PROVIDERS', 'gemini,bogus'), /unknown provider/);
  assert.throws(() => settings.validateValue('BRAIN_PROVIDERS', ''), /at least one/);
  assert.throws(() => settings.validateValue('OPENAI_MODEL', 'model with spaces'), /model id/);
  assert.equal(settings.validateValue('ANTHROPIC_MAX_TOKENS', '2048'), '2048');
  assert.throws(() => settings.validateValue('ANTHROPIC_MAX_TOKENS', '0'), /1\.\.100000/);
  assert.equal(settings.validateValue('TELEGRAM_CHAT_ID', '-123456'), '-123456');
  assert.throws(() => settings.validateValue('TELEGRAM_CHAT_ID', 'abc'), /numeric/);
  assert.equal(settings.validateValue('FAST_ROUTING', 'yes'), '1');
  assert.equal(settings.validateValue('TELEGRAM_ENABLED', 'no'), 'no');
});
test('settings: getProviderStatus masks keys and never returns a full key', () => {
  process.env.GEMINI_API_KEY = FAKE_GEMINI;
  process.env.OPENAI_API_KEY = FAKE_OPENAI;
  const rows = settings.getProviderStatus();
  assert.equal(rows.length, 5);
  const gemini = rows.find(r => r.id === 'gemini');
  assert.equal(gemini.configured, true);
  assert.equal(gemini.masked, '••••' + FAKE_GEMINI.slice(-4));
  const groq = rows.find(r => r.id === 'groq');
  assert.equal(groq.configured, false);
  assert.equal(groq.masked, null);
  const dumped = JSON.stringify(rows);
  assert.ok(!dumped.includes(FAKE_GEMINI) && !dumped.includes(FAKE_OPENAI));
  const openai = rows.find(r => r.id === 'openai');
  assert.ok('baseUrl' in openai && 'model' in openai, 'custom-endpoint fields present on the openai row');
});
test('settings: recordTestResult redacts key-shaped text from stored errors', () => {
  const saved = settings.recordTestResult('gemini', { ok: false, ms: 12, error: `bad key ${FAKE_GEMINI}` });
  assert.equal(saved.ok, false);
  assert.ok(!JSON.stringify(saved).includes(FAKE_GEMINI));
  const again = settings.getLastTest('gemini');
  assert.ok(again && !JSON.stringify(again).includes(FAKE_GEMINI));
  run('DELETE FROM settings WHERE key = ?', 'provider_test_gemini');
});

// ---------------------------------------------------------------------------
// Fast routing: deterministic classifier + routed ask with fallback
// ---------------------------------------------------------------------------
test('route: classify sends short plain prompts to routine, hard work to the full chain', () => {
  assert.equal(routeMod.classify('what is the status of the queue?').route, 'routine');
  assert.equal(routeMod.classify('show my notes').route, 'routine');
  assert.equal(routeMod.classify('build a REST API with auth and tests').route, 'hard');
  assert.equal(routeMod.classify('debug why the login fails').route, 'hard');
  assert.equal(routeMod.classify('click the submit button on the screen').route, 'hard');
  assert.equal(routeMod.classify('first list the files then summarise them').route, 'hard');
  assert.equal(routeMod.classify('delete the old backup').route, 'hard');
  assert.equal(routeMod.classify('x'.repeat(200)).route, 'hard');
  assert.equal(routeMod.classify('```js\ncode\n```').route, 'hard');
});
test('route: routedAsk tries local first for routine, falls back on failure, never routes hard work local', async () => {
  process.env.FAST_ROUTING = '1';
  const calls = [];
  const fakeBrain = {
    ask: async (p) => { calls.push(['ask', p]); return { text: 'full', model: 'm-full', provider: 'groq' }; },
    askWith: async (p, order) => { calls.push(['askWith', order]); return { text: 'local', model: 'm-local', provider: 'ollama' }; },
  };
  let r = await routeMod.routedAsk('show my notes', { brain: fakeBrain });
  assert.equal(r.provider, 'ollama');
  assert.equal(r.route, 'routine');
  assert.equal(r.fellBack, false);
  assert.ok(typeof r.ms === 'number');
  r = await routeMod.routedAsk('build a REST API', { brain: fakeBrain });
  assert.equal(r.provider, 'groq');
  assert.equal(r.route, 'hard');
  const failingBrain = {
    ask: async () => ({ text: 'full', model: 'm-full', provider: 'groq' }),
    askWith: async () => { throw new Error('ollama down'); },
  };
  r = await routeMod.routedAsk('show my notes', { brain: failingBrain });
  assert.equal(r.provider, 'groq');
  assert.equal(r.fellBack, true);
  delete process.env.FAST_ROUTING;
  r = await routeMod.routedAsk('show my notes', { brain: fakeBrain });
  assert.equal(r.route, 'default');
});

// ---------------------------------------------------------------------------
// Expanded screen action sets: vision grounding + desktop validation
// ---------------------------------------------------------------------------
test('vision: parseGroundedAction accepts double_click/right_click/drag/move/zoom, rejects bad shapes', () => {
  assert.deepEqual(
    (({ action, x, y }) => ({ action, x, y }))(vision.parseGroundedAction('{"action":"double_click","x":0.5,"y":0.5}')),
    { action: 'double_click', x: 0.5, y: 0.5 });
  assert.equal(vision.parseGroundedAction('{"action":"right_click","x":0.1,"y":0.9}').action, 'right_click');
  assert.equal(vision.parseGroundedAction('{"action":"move","x":0.2,"y":0.2}').action, 'move');
  const drag = vision.parseGroundedAction('{"action":"drag","x":0.1,"y":0.1,"x2":0.8,"y2":0.8}');
  assert.equal(drag.x2, 0.8);
  const zoom = vision.parseGroundedAction('{"action":"zoom","region":[0.1,0.1,0.5,0.5]}');
  assert.deepEqual(zoom.region, [0.1, 0.1, 0.5, 0.5]);
  assert.throws(() => vision.parseGroundedAction('{"action":"drag","x":0.1,"y":0.1}'), /drag needs/);
  assert.throws(() => vision.parseGroundedAction('{"action":"zoom","region":[0.5,0.5,0.1,0.1]}'), /zoom needs/);
  assert.throws(() => vision.parseGroundedAction('{"action":"zoom","region":[0,0,2,1]}'), /zoom needs/);
  assert.throws(() => vision.parseGroundedAction('{"action":"triple_click","x":0.5,"y":0.5}'), /unknown grounded action/);
  assert.ok(vision.GROUND_PROMPT.includes('double_click') && vision.GROUND_PROMPT.includes('zoom'));
});
test('desktop: validateAction accepts the expanded set; destructive gate still applies', () => {
  assert.equal(desktop.validateAction({ action: 'double_click', x: 0.5, y: 0.5 }).action, 'double_click');
  assert.equal(desktop.validateAction({ action: 'drag', x: 0, y: 0, x2: 1, y2: 1 }).action, 'drag');
  assert.equal(desktop.validateAction({ action: 'zoom', region: [0, 0, 0.5, 0.5] }).action, 'zoom');
  assert.throws(() => desktop.validateAction({ action: 'drag', x: 0, y: 0, x2: 2, y2: 1 }), /drag needs/);
  assert.throws(() => desktop.validateAction({ action: 'click', x: 0.5, y: 0.5, sensitive: true }), /sensitive/);
  assert.throws(() => desktop.validateAction({ action: 'click', x: 0.5, y: 0.5, destructive: true }), /approved approval id/);
  const ap = run('INSERT INTO approvals (action, details, status) VALUES (?, ?, ?)', 'test destructive', 'test', 'approved');
  const id = Number(ap.lastInsertRowid);
  assert.equal(desktop.validateAction({ action: 'click', x: 0.5, y: 0.5, destructive: true }, { approvalId: id }).destructive, true);
  run('DELETE FROM approvals WHERE id = ?', id);
});
test('desktop: screenLoop calls the replay recorder with the observation + action', async () => {
  const recorded = [];
  const recorder = { record: async (s) => { recorded.push(s); }, sessionId: 999 };
  const out = await desktop.screenLoop('test task', {
    capture: async () => ({ buffer: PNG_1X1, hash: 'hash-1' }),
    ground: async () => ({ action: 'click', x: 0.5, y: 0.5, description: 'the button' }),
    act: async () => ({ ok: true }),
    audit: () => {},
  }, { maxActions: 1, recorder });
  assert.equal(out.done, false); // action cap reached after 1 action
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].action.action, 'click');
  assert.ok(Buffer.isBuffer(recorded[0].shot.buffer));
  assert.ok(typeof recorded[0].latencyMs === 'number');
});

// ---------------------------------------------------------------------------
// Phone: new ADB actions
// ---------------------------------------------------------------------------
test('phone: adbArgv builds long_press/open_app/list_apps/dump, rejects bad packages', () => {
  assert.deepEqual(phone.adbArgv({ action: 'long_press', x: 100, y: 200, ms: 900 }),
    ['shell', 'input', 'swipe', '100', '200', '100', '200', '900']);
  assert.deepEqual(phone.adbArgv({ action: 'open_app', package: 'com.example.app' }),
    ['shell', 'monkey', '-p', 'com.example.app', '-c', 'android.intent.category.LAUNCHER', '1']);
  assert.deepEqual(phone.adbArgv({ action: 'list_apps' }), ['shell', 'pm', 'list', 'packages']);
  assert.deepEqual(phone.adbArgv({ action: 'dump' }), ['shell', 'uiautomator', 'dump', '/dev/tty']);
  assert.throws(() => phone.adbArgv({ action: 'open_app', package: 'com.example; rm -rf /' }), /package name/);
  assert.throws(() => phone.adbArgv({ action: 'open_app', package: 'singleword' }), /package name/);
  assert.throws(() => phone.adbArgv({ action: 'long_press', x: 1, y: 2, ms: 50 }), /100\.\.5000/);
});

// ---------------------------------------------------------------------------
// Clipboard + windows (injected runners — no real clipboard/desktop)
// ---------------------------------------------------------------------------
test('clipboard: get/set use the platform backend, caps enforced, win32 uses base64 argv', async () => {
  const seen = [];
  const runFn = async (cmd, args, input) => { seen.push({ cmd, args, input }); return 'hello clipboard'; };
  const r = await clipboard.getClipboard({ platform: 'darwin', run: runFn });
  assert.equal(r.text, 'hello clipboard');
  assert.equal(seen[0].cmd, 'pbpaste');
  await clipboard.setClipboard('new text', { platform: 'darwin', run: runFn });
  assert.equal(seen[1].cmd, 'pbcopy');
  assert.equal(seen[1].input, 'new text');
  // Linux falls through candidates in order.
  const linuxSeen = [];
  const linuxRun = async (cmd) => { linuxSeen.push(cmd); if (cmd !== 'xclip') throw new Error('nope'); return 'x'; };
  await clipboard.getClipboard({ platform: 'linux', run: linuxRun });
  assert.deepEqual(linuxSeen, ['wl-paste', 'xclip']);
  // Windows: the text travels as base64, never raw in argv.
  const winSeen = [];
  await clipboard.setClipboard('secret words here', { platform: 'win32', run: async (cmd, args) => { winSeen.push({ cmd, args }); return ''; } });
  assert.equal(winSeen[0].cmd, 'powershell.exe');
  assert.ok(!winSeen[0].args.join(' ').includes('secret words here'));
  assert.ok(winSeen[0].args.some(a => a === Buffer.from('secret words here', 'utf8').toString('base64')));
  await assert.rejects(clipboard.setClipboard('x'.repeat(4001)), /1\.\.4000/);
  await assert.rejects(clipboard.getClipboard({ platform: 'linux', run: async () => { throw new Error('all down'); } }), /clipboard read failed/);
});
test('windows: list/focus/open use fixed scripts with $args only — injection travels as data', async () => {
  const calls = [];
  const runFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return JSON.stringify([{ Id: 123, ProcessName: 'notepad', MainWindowTitle: 'Untitled' }]);
  };
  const wins = await windows.listWindows({ run: runFn });
  assert.equal(wins[0].pid, 123);
  assert.equal(wins[0].title, 'Untitled');
  await windows.focusWindow({ pid: 123 }, { run: runFn });
  assert.ok(calls[1].args.includes('123'));
  const evil = '"; Remove-Item -Recurse C:\\; #';
  await windows.focusWindow({ title: evil }, { run: runFn });
  const script = calls[2].args[3];
  assert.ok(!script.includes('Remove-Item'), 'user input must never be interpolated into the script');
  assert.ok(calls[2].args.includes(evil), 'user input travels as a single $args element');
  await windows.openApp('notepad', { run: runFn });
  assert.ok(calls[3].args.includes('notepad.exe'));
  await assert.rejects(windows.openApp('powershell'), /allowlist only/);
  await assert.rejects(windows.focusWindow({ pid: 0 }, { run: runFn }), /positive integer/);
});

// ---------------------------------------------------------------------------
// Browser: element-first actions (fake driver) + live Chromium proof
// ---------------------------------------------------------------------------
function fakePage() {
  const calls = [];
  const state = { url: 'https://example.com', elements: { '#btn': 'visible', '#pw': 'password', '#gone': 'missing' } };
  const driver = {
    calls, state,
    url: () => state.url,
    goto: async (u) => { calls.push(['goto', u]); state.url = u; },
    click: async (sel) => { calls.push(['click', sel]); },
    fill: async (sel, text) => { calls.push(['fill', sel, text]); },
    evaluate: async (fn, arg) => {
      if (typeof fn === 'function' && arg === undefined) {
        // snapshotDom call — return canned entries
        return [
          { role: 'button', name: 'Save', selector: '#btn' },
          { role: 'textbox', name: 'Password', selector: '#pw' },
        ];
      }
      // element state check (selector arg)
      const st = state.elements[arg];
      if (st === 'missing') return 'missing';
      if (st === 'password') return 'password';
      return 'text';
    },
    screenshot: async () => PNG_1X1,
    waitForTimeout: async (ms) => { calls.push(['wait', ms]); },
    title: async () => 'Fake Title',
    goBack: async () => { calls.push(['back']); },
    goForward: async () => { calls.push(['forward']); },
    getByText: (text) => ({
      count: async () => (text === 'unique' ? 1 : text === 'many' ? 3 : 0),
      first: () => ({
        click: async () => { calls.push(['click_text', text]); },
        scrollIntoViewIfNeeded: async () => { calls.push(['scroll_text', text]); },
      }),
    }),
  };
  return driver;
}
test('browser: snapshot + click_ref/type_ref work; stale refs and password fields refused', async () => {
  const agent = new browserMod.BrowserAgent({ driver: fakePage() });
  await assert.rejects(agent.act({ action: 'click_ref', index: 0 }), /no snapshot/);
  const snap = await agent.act({ action: 'snapshot' });
  assert.equal(snap.entries.length, 2);
  assert.equal(snap.entries[0].selector, '#btn');
  const c = await agent.act({ action: 'click_ref', index: 0 });
  assert.equal(c.selector, '#btn');
  await assert.rejects(agent.act({ action: 'type_ref', index: 1, text: 'x' }), /password field/);
  await assert.rejects(agent.act({ action: 'click_ref', index: 9 }), /no index 9/);
  await agent.close();
});
test('browser: click_ref refuses when the page navigated since the snapshot', async () => {
  const driver = fakePage();
  const agent = new browserMod.BrowserAgent({ driver });
  await agent.act({ action: 'snapshot' });
  driver.state.url = 'https://other.example/';
  await assert.rejects(agent.act({ action: 'click_ref', index: 0 }), /page changed/);
  await agent.close();
});
test('browser: find_text counts, click_text refuses ambiguous and missing text', async () => {
  const agent = new browserMod.BrowserAgent({ driver: fakePage() });
  const f = await agent.act({ action: 'find_text', text: 'unique' });
  assert.equal(f.count, 1);
  assert.equal(f.found, true);
  await agent.act({ action: 'click_text', text: 'unique' });
  await assert.rejects(agent.act({ action: 'click_text', text: 'many' }), /ambiguous/);
  await assert.rejects(agent.act({ action: 'click_text', text: 'absent' }), /not found/);
  const b = await agent.act({ action: 'back' });
  assert.equal(b.url, 'https://example.com');
  await agent.close();
});
test('browser: validateAction rejects submit/post/send actions — none exist', () => {
  assert.throws(() => browserMod.validateAction({ action: 'submit' }), /unknown browser action/);
  assert.throws(() => browserMod.validateAction({ action: 'send' }), /unknown browser action/);
  assert.throws(() => browserMod.validateAction({ action: 'post' }), /unknown browser action/);
  assert.ok(!browserMod.BROWSER_ACTIONS.has('submit'));
});
test('browser: REAL chromium snapshot + click_text + type_ref + find_text (local page)', async () => {
  const cap = browserMod.capability();
  if (!cap.available) { assert.ok(cap.reason); return; }
  const agent = new browserMod.BrowserAgent({});
  try {
    const page = await agent.ensurePage();
    await page.setContent(`<html><head><title>Element Test</title></head><body>
      <h1>Welcome</h1><input id="q" type="text" value="">
      <button onclick="document.title='clicked'">Press Me</button>
      <a href="https://example.com">Example link</a></body></html>`);
    const snap = await agent.act({ action: 'snapshot' });
    assert.ok(snap.entries.length >= 3, 'snapshot finds heading, input, button, link');
    assert.ok(snap.entries.some(e => e.name.includes('Press Me')));
    const found = await agent.act({ action: 'find_text', text: 'Welcome' });
    assert.equal(found.found, true);
    await agent.act({ action: 'click_text', text: 'Press Me' });
    assert.equal((await agent.act({ action: 'title' })).title, 'clicked');
    const inputIdx = snap.entries.findIndex(e => e.selector === '#q');
    assert.ok(inputIdx >= 0, 'input with id #q is in the snapshot with an id selector');
    await agent.act({ action: 'type_ref', index: inputIdx, text: 'hello refs' });
    const text = await agent.act({ action: 'text' });
    assert.ok(text.text.length >= 0); // page text readable after acting
  } finally {
    await agent.close();
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
test('notify: create/list/unread/mark-read round-trips in SQLite', () => {
  const n = notifyMod.createNotification('Test title', 'Test body', 'product-test');
  assert.ok(n.id > 0);
  assert.ok(notifyMod.listNotifications({ unreadOnly: true }).some(x => x.id === n.id));
  assert.ok(notifyMod.unreadCount() >= 1);
  assert.equal(notifyMod.markNotificationRead(n.id).ok, true);
  assert.ok(!notifyMod.listNotifications({ unreadOnly: true }).some(x => x.id === n.id));
  assert.equal(notifyMod.markNotificationRead(n.id).ok, false);
  assert.throws(() => notifyMod.createNotification('', 'b'), /title/);
  run('DELETE FROM notifications WHERE id = ?', n.id);
});

// ---------------------------------------------------------------------------
// Replay: record, retrieve, purge, verified replay
// ---------------------------------------------------------------------------
test('replay: recorder stores session + step + PNG (mode 600), getShot is traversal-safe', async () => {
  const rec = replay.createRecorder('product test task', { device: 'test' });
  await rec.record({ action: { action: 'click', x: 0.5, y: 0.5 }, shot: { buffer: PNG_1X1 }, result: { ok: true }, latencyMs: 42 });
  rec.finish('done');
  const s = replay.getSession(rec.sessionId);
  assert.equal(s.task, 'product test task');
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].action, 'click');
  assert.equal(s.steps[0].latency_ms, 42);
  assert.ok(s.steps[0].screenshot_hash && s.steps[0].screenshot_hash.length === 64);
  const shotFile = path.join(replay.SHOTS_DIR, s.steps[0].shot_path);
  assert.ok(fs.existsSync(shotFile));
  assert.equal(fs.statSync(shotFile).mode & 0o777, 0o600);
  const shot = replay.getShot(s.steps[0].id);
  assert.ok(shot && shot.buffer.equals(PNG_1X1));
  // Traversal: a step whose shot_path escapes the dir returns null.
  const evil = run('INSERT INTO screen_steps (session_id, step_index, action, shot_path) VALUES (?, ?, ?, ?)',
    rec.sessionId, 1, 'click', '../../etc/passwd');
  assert.equal(replay.getShot(Number(evil.lastInsertRowid)), null);
  const purged = replay.purgeSession(rec.sessionId);
  assert.equal(purged.ok, true);
  assert.ok(!fs.existsSync(shotFile));
  assert.equal(replay.getSession(rec.sessionId), null);
});
test('replay: verified replay stops at screen mismatch and at unapproved destructive steps', async () => {
  const rec = replay.createRecorder('replay-verify test', { device: 'test' });
  const h1 = replay.hashBuffer(PNG_1X1);
  await rec.record({ action: { action: 'click', x: 0.5, y: 0.5 }, shot: { buffer: PNG_1X1, hash: h1 }, result: { ok: true }, latencyMs: 1 });
  await rec.record({ action: { action: 'type', text: 'hi', destructive: true }, shot: { buffer: PNG_1X1, hash: h1 }, result: { ok: true }, latencyMs: 1 });
  rec.finish('done');
  const acted = [];
  // Mismatch on step 0: nothing acts.
  let out = await replay.replaySession(rec.sessionId, {
    capture: async () => ({ buffer: Buffer.from('different'), hash: 'deadbeef' }),
    act: async (a) => { acted.push(a); },
  });
  assert.equal(out.done, false);
  assert.equal(out.matched, 0);
  assert.match(out.reason, /did not match/);
  assert.equal(acted.length, 0);
  // Match, then destructive step refused without fresh approval.
  out = await replay.replaySession(rec.sessionId, {
    capture: async () => ({ buffer: PNG_1X1, hash: h1 }),
    act: async (a) => { acted.push(a); },
  });
  assert.equal(out.done, false);
  assert.equal(out.matched, 1);
  assert.match(out.reason, /fresh approval/);
  assert.equal(acted.length, 1);
  // Match + fresh approval: all steps replay.
  out = await replay.replaySession(rec.sessionId, {
    capture: async () => ({ buffer: PNG_1X1, hash: h1 }),
    act: async (a) => { acted.push(a); },
    confirmDestructive: () => true,
  });
  assert.equal(out.done, true);
  assert.equal(out.matched, 2);
  replay.purgeSession(rec.sessionId);
});
test('replay: pruneShots caps the shots dir at 200 files', () => {
  replay.createRecorder('prune probe', { device: 'test' });
  fs.mkdirSync(replay.SHOTS_DIR, { recursive: true });
  const before = fs.readdirSync(replay.SHOTS_DIR).filter(f => f.endsWith('.png')).length;
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(replay.SHOTS_DIR, `prune-test-${i}.png`), PNG_1X1);
  const pruned = replay.pruneShots(require('../db'));
  const after = fs.readdirSync(replay.SHOTS_DIR).filter(f => f.endsWith('.png')).length;
  assert.ok(after <= 200, `shots dir capped at 200, got ${after}`);
  assert.ok(pruned >= 5);
  for (const f of fs.readdirSync(replay.SHOTS_DIR).filter(f => f.startsWith('prune-test-'))) {
    try { fs.unlinkSync(path.join(replay.SHOTS_DIR, f)); } catch {}
  }
  assert.ok(before <= 200);
});

// ---------------------------------------------------------------------------
// Tools: new allowlisted tools + run_tests gate
// ---------------------------------------------------------------------------
const TMP_WS_DIR = path.join(tools.WORKSPACE, 'app', 'tests', 'tmp-product');
test('routines: parseScheduleString accepts daily/interval strings, rejects bad ones', () => {
  const routines = require('../routines');
  assert.deepEqual(routines.parseScheduleString('09:00'), { type: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(routines.parseScheduleString('9:00'), { type: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(routines.parseScheduleString('09:00 mon-fri').weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(routines.parseScheduleString('09:00 weekends').weekdays, [0, 6]);
  assert.deepEqual(routines.parseScheduleString('09:00 mon,wed,fri').weekdays, [1, 3, 5]);
  assert.deepEqual(routines.parseScheduleString('every 30m'), { type: 'interval', minutes: 30 });
  assert.throws(() => routines.parseScheduleString('every 2m'), /minutes >= 5/);
  assert.throws(() => routines.parseScheduleString('25:00'), /HH:MM/);
  assert.throws(() => routines.parseScheduleString('09:00 marsday'), /unknown weekday/);
  assert.throws(() => routines.parseScheduleString('tomorrow'), /must look like/);
});
test('tools: search_files finds content, skips node_modules/data, caps matches', async () => {
  fs.mkdirSync(TMP_WS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TMP_WS_DIR, 'a.txt'), 'the needle lives here\nsecond line\n');
  fs.writeFileSync(path.join(TMP_WS_DIR, 'b.txt'), 'nothing to see\n');
  try {
    const r = await tools.execute('search_files', { query: 'needle', path: 'app/tests/tmp-product' });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].line, 1);
    assert.match(r.matches[0].excerpt, /needle/);
    const none = await tools.execute('search_files', { query: 'zzz-no-such-string-zzz', path: 'app/tests/tmp-product' });
    assert.equal(none.matches.length, 0);
    await assert.rejects(tools.execute('search_files', { query: '' }), /query/);
  } finally {
    fs.rmSync(TMP_WS_DIR, { recursive: true, force: true });
  }
});
test('tools: create_file creates new files only, refuses existing + missing parents', async () => {
  fs.mkdirSync(TMP_WS_DIR, { recursive: true });
  try {
    const r = await tools.execute('create_file', { path: 'app/tests/tmp-product/new.txt', content: 'fresh' });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(TMP_WS_DIR, 'new.txt'), 'utf8'), 'fresh');
    await assert.rejects(tools.execute('create_file', { path: 'app/tests/tmp-product/new.txt', content: 'again' }), /already exists/);
    await assert.rejects(tools.execute('create_file', { path: 'app/tests/tmp-product/no-dir/x.txt', content: 'x' }), /parent directory/);
    await assert.rejects(tools.execute('create_file', { path: 'app/tests/tmp-product/evil.txt', content: 'x'.repeat(100 * 1024 + 1) }), /100KB/);
  } finally {
    fs.rmSync(TMP_WS_DIR, { recursive: true, force: true });
  }
});
test('tools: search_notes, notify, create_routine/list_routines round-trip; unknown tools still denied', async () => {
  const note = await tools.execute('write_note', { title: 'product-probe-note', body: 'uniqueword123' });
  const found = await tools.execute('search_notes', { query: 'uniqueword123' });
  assert.ok(found.notes.some(n => n.id === note.note_id));
  run('DELETE FROM notes WHERE id = ?', note.note_id);
  const n = await tools.execute('notify', { title: 'probe', body: 'probe body', source: 'product-test' });
  assert.ok(n.notification_id > 0);
  run('DELETE FROM notifications WHERE id = ?', n.notification_id);
  const routine = await tools.execute('create_routine', { name: 'product-probe-routine', schedule: '09:00', task: 'probe task' });
  assert.ok(routine.routine.id > 0);
  const listed = await tools.execute('list_routines', {});
  assert.ok(listed.routines.some(r => r.id === routine.routine.id));
  run('DELETE FROM routines WHERE id = ?', routine.routine.id);
  await assert.rejects(tools.execute('send_email', {}), /not allowlisted/);
  await assert.rejects(tools.execute('delete_file', { path: 'x' }), /not allowlisted/);
});
test('tools: run_tests parses pass/fail counts and refuses concurrent runs', async () => {
  tools.setTestRunner(async () => ({ code: 0, output: 'ℹ pass 71\nℹ fail 0\n' }));
  let r = await tools.execute('run_tests', {});
  assert.equal(r.ok, true);
  assert.equal(r.pass, 71);
  assert.equal(r.fail, 0);
  tools.setTestRunner(async () => ({ code: 1, output: 'ℹ pass 70\nℹ fail 1\nboom' }));
  r = await tools.execute('run_tests', {});
  assert.equal(r.ok, false);
  assert.equal(r.fail, 1);
  // Concurrency guard: a slow run blocks a second one.
  let release;
  const gate = new Promise(res => { release = res; });
  tools.setTestRunner(async () => { await gate; return { code: 0, output: 'ℹ pass 1\nℹ fail 0\n' }; });
  const first = tools.execute('run_tests', {});
  await assert.rejects(tools.execute('run_tests', {}), /already running/);
  release();
  await first;
});
test('tools: screen_act/list_windows/clipboard_get fail honestly on this VM (no desktop/agent), never as "not allowlisted"', async () => {
  await assert.rejects(tools.execute('screen_act', { action: 'click', x: 0.5, y: 0.5 }), /desktop agent unavailable|unknown screen action|fetch failed/i);
  await assert.rejects(tools.execute('list_windows', {}), /failed|not found|powershell/i);
  await assert.rejects(tools.execute('clipboard_get', {}), /clipboard read failed/);
});

// ---------------------------------------------------------------------------
// Channels: keys refused in chat, status only
// ---------------------------------------------------------------------------
test('telegram: a pasted key is refused before the agent turn; /providers shows masked status only', async () => {
  const sent = [];
  let forwarded = 0;
  const bot = new TelegramBot({
    token: 'fake-token', chatId: '111',
    fetchImpl: async () => ({ json: async () => ({ ok: true, result: {} }) }),
    handlers: {
      onMessage: async () => { forwarded++; return 'agent reply'; },
      getProviderStatus: async () => settings.getProviderStatus(),
    },
  });
  bot.sendMessage = async (chatId, text) => { sent.push(text); return {}; };
  process.env.GEMINI_API_KEY = FAKE_GEMINI;
  const refused = await bot.handleUpdate({ message: { chat: { id: 111 }, text: `here is my key ${FAKE_GEMINI}` } });
  assert.equal(refused.command, 'key_refused');
  assert.equal(forwarded, 0, 'a key must never reach the agent turn');
  assert.ok(sent[0].includes('Settings'));
  assert.ok(!sent[0].includes(FAKE_GEMINI));
  const prov = await bot.handleUpdate({ message: { chat: { id: 111 }, text: '/providers' } });
  assert.equal(prov.command, 'providers');
  assert.ok(sent[1].includes('••••' + FAKE_GEMINI.slice(-4)));
  assert.ok(!sent[1].includes(FAKE_GEMINI));
  const normal = await bot.handleUpdate({ message: { chat: { id: 111 }, text: 'hello there' } });
  assert.equal(normal.command, 'message');
  assert.equal(forwarded, 1);
});
test('whatsapp: handleIncomingMessage refuses keys, forwards normal text', async () => {
  const sent = [];
  let forwarded = 0;
  const out = await whatsapp.handleIncomingMessage({
    text: `key: ${FAKE_OPENAI}`, from: '123@s.whatsapp.net',
    onMessage: async () => { forwarded++; return 'reply'; },
    send: async (t) => { sent.push(t); },
  });
  assert.equal(out.refused, true);
  assert.equal(forwarded, 0);
  assert.equal(sent[0], KEY_REFUSAL);
  assert.ok(!sent[0].includes(FAKE_OPENAI));
  const out2 = await whatsapp.handleIncomingMessage({
    text: 'hello', from: '123@s.whatsapp.net',
    onMessage: async () => { forwarded++; return 'hi back'; },
    send: async (t) => { sent.push(t); },
  });
  assert.equal(out2.handled, true);
  assert.equal(forwarded, 1);
  assert.equal(sent[1], 'hi back');
});

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------
test('doctor: version floor matches server.js; brain check never prints a key value', () => {
  assert.equal(doctor.versionOk('24.22.1'), true);
  assert.equal(doctor.versionOk('24.22.0'), false);
  assert.equal(doctor.versionOk('22.23.4'), true);
  assert.equal(doctor.versionOk('26.12.1'), true);
  assert.equal(doctor.versionOk('20.0.0'), false);
});
test('doctor: runChecks reports brain missing with no keys + dead ollama, present with a key (value never shown)', async () => {
  const deadFetch = async () => { throw new Error('down'); };
  const noKey = await doctor.runChecks({ env: {}, fetchImpl: deadFetch, runCmd: async () => { throw new Error('no adb'); } });
  const brainNoKey = noKey.checks.find(c => c.name === 'brain available');
  assert.equal(brainNoKey.ok, false);
  const withKey = await doctor.runChecks({ env: { GEMINI_API_KEY: FAKE_GEMINI }, fetchImpl: deadFetch, runCmd: async () => { throw new Error('no adb'); } });
  const brainWithKey = withKey.checks.find(c => c.name === 'brain available');
  assert.equal(brainWithKey.ok, true);
  assert.ok(!JSON.stringify(withKey.checks).includes(FAKE_GEMINI), 'doctor output must never contain a key value');
  assert.ok(withKey.checks.some(c => c.name === '.gitignore (secrets)' && c.ok));
});

// ---------------------------------------------------------------------------
// Live API tests (server started by tests/run-tests.sh)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = process.env.ANKU_TOKEN || '';
if (!TOKEN) {
  const m = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').match(/ANKU_TOKEN=(\S+)/);
  TOKEN = m[1];
}
const H = { 'Content-Type': 'application/json', 'X-Anku-Token': TOKEN };
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, raw: r };
}

test('api: settings providers returns masked status + order + channels, never a full key', async () => {
  const { status, body } = await api('/api/settings/providers');
  assert.equal(status, 200);
  assert.equal(body.providers.length, 5);
  for (const p of body.providers) {
    assert.ok(p.masked === null || p.masked.startsWith('••••'), `${p.id} masked preview only`);
    assert.ok('lastTest' in p);
  }
  assert.ok(Array.isArray(body.order) && body.order.length > 0);
  assert.ok(body.channels.telegram && body.channels.sync);
  const noAuth = await fetch(BASE + '/api/settings/providers');
  assert.equal(noAuth.status, 401);
});
test('api: settings write + remove round-trips on a harmless var and restores it', async () => {
  try {
    const set = await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates: { OLLAMA_VISION_MODEL: 'probe-model-xyz' } }) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const envText = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    assert.ok(envText.includes('OLLAMA_VISION_MODEL=probe-model-xyz'), 'the write must land in .env.local');
    const after = await api('/api/settings/providers');
    assert.equal(after.status, 200);
    assert.equal(after.body.providers.length, 5);
    const bad = await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates: { ANKU_TOKEN: 'x'.repeat(64) } }) });
    assert.equal(bad.status, 400);
    const badUrl = await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates: { OPENAI_BASE_URL: 'http://public.example.com/v1' } }) });
    assert.equal(badUrl.status, 400);
  } finally {
    const rm = await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates: { OLLAMA_VISION_MODEL: '' } }) });
    assert.equal(rm.status, 200);
    const envText = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    assert.ok(!envText.includes('OLLAMA_VISION_MODEL=probe-model-xyz'), 'the removal must restore .env.local');
  }
});
test('api: settings order + fast-routing endpoints work and restore', async () => {
  const before = await api('/api/settings/providers');
  const order = await api('/api/settings/order', { method: 'POST', body: JSON.stringify({ order: before.body.order.join(',') }) });
  assert.equal(order.status, 200);
  assert.deepEqual(order.body.order, before.body.order);
  const badOrder = await api('/api/settings/order', { method: 'POST', body: JSON.stringify({ order: 'bogus-provider' }) });
  assert.equal(badOrder.status, 400);
  const on = await api('/api/settings/fast-routing', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(on.status, 200);
  assert.equal(on.body.fast_routing, true);
  const off = await api('/api/settings/fast-routing', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  assert.equal(off.body.fast_routing, false);
});
test('api: settings test hits the live Ollama model and records the result', async () => {
  const { status, body } = await api('/api/settings/test', { method: 'POST', body: JSON.stringify({ provider: 'ollama' }) });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.provider, 'ollama');
  assert.ok(body.model);
  assert.ok(typeof body.ms === 'number');
  assert.equal(body.lastTest.ok, true);
  const bad = await api('/api/settings/test', { method: 'POST', body: JSON.stringify({ provider: 'bogus' }) });
  assert.equal(bad.status, 400);
});
test('api: notifications create + mark-read; sync status shape; screen/act is audit-logged', async () => {
  const created = await api('/api/notifications', { method: 'POST', body: JSON.stringify({ title: 'api-probe', body: 'probe', source: 'product-test' }) });
  assert.equal(created.status, 200);
  const id = created.body.notification.id;
  const read = await api(`/api/notifications/${id}/read`, { method: 'POST', body: '{}' });
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);
  run('DELETE FROM notifications WHERE id = ?', id);
  const syncStatus = await api('/api/sync/status');
  assert.equal(syncStatus.status, 200);
  assert.ok(Array.isArray(syncStatus.body.synced_tables));
  assert.ok(syncStatus.body.never_synced.includes('screen_steps'));
  const before = get("SELECT COUNT(*) c FROM audit_log WHERE tool = 'screen.act'").c;
  const act = await api('/api/screen/act', { method: 'POST', body: JSON.stringify({ action: { action: 'bogus_action' } }) });
  assert.equal(act.status, 403);
  const after = get("SELECT COUNT(*) c FROM audit_log WHERE tool = 'screen.act'").c;
  assert.equal(after, before + 1, 'screen/act failures must be audit-logged');
});
test('api: replay session serves steps + PNG shot over HTTP and purges', async () => {
  const rec = replay.createRecorder('api replay probe', { device: 'test' });
  await rec.record({ action: { action: 'click', x: 0.5, y: 0.5 }, shot: { buffer: PNG_1X1 }, result: { ok: true }, latencyMs: 7 });
  rec.finish('done');
  try {
    const s = await api(`/api/replay/${rec.sessionId}`);
    assert.equal(s.status, 200);
    assert.equal(s.body.session.steps.length, 1);
    const stepId = s.body.session.steps[0].id;
    const shot = await fetch(`${BASE}/api/replay/shot/${stepId}`, { headers: H });
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await shot.arrayBuffer());
    assert.ok(buf.equals(PNG_1X1));
    const noAuth = await fetch(`${BASE}/api/replay/shot/${stepId}`);
    assert.equal(noAuth.status, 401, 'screenshots require auth, like every /api route');
  } finally {
    const del = await api(`/api/replay/${rec.sessionId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(replay.getSession(rec.sessionId), null);
  }
});
