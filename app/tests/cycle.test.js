// Cycle tests (17 Nov 2026): the 4 new deny-first tools, the redirect-safe
// web_fetch, and the multilingual UI strings. Live tests run against the
// server started by tests/run-tests.sh, same as the other suites; the
// fetch-redirect and i18n checks are pure unit tests (stubbed fetch).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
async function tool(name, args) {
  return api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: name, args }) });
}

const WORKSPACE = process.env.WORKSPACE || path.join(os.homedir(), 'workspace', 'personal-ai');

// --- create_approval: draft only, never executes ---------------------------
test('tools: create_approval records a pending draft and never executes', async () => {
  const r = await tool('create_approval', { action: 'send email', details: 'To: test@example.com\nSubject: hi\nBody: hello' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.status, 'pending');
  assert.ok(Number.isInteger(r.body.approval_id));
  assert.match(r.body.note, /Draft only/);
  const list = await api('/api/approvals');
  const row = list.body.approvals.find(a => a.id === r.body.approval_id);
  assert.ok(row, 'draft is listed');
  assert.equal(row.status, 'pending');
  assert.equal(row.action, 'send email');
});

test('tools: create_approval rejects missing args', async () => {
  const r = await tool('create_approval', { action: 'send email' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /action and details required/);
});

// --- file_info --------------------------------------------------------------
test('tools: file_info reports type/size/lines for a workspace file', async () => {
  const r = await tool('file_info', { path: 'AGENT.md' });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'file');
  assert.ok(r.body.size > 0);
  assert.ok(Number.isInteger(r.body.lines) && r.body.lines > 5);
  assert.ok(!('content' in r.body), 'file_info never returns contents');
  const d = await tool('file_info', { path: '.' });
  assert.equal(d.status, 200);
  assert.equal(d.body.type, 'dir');
});

test('tools: file_info denies missing and secret paths', async () => {
  const missing = await tool('file_info', { path: 'no-such-file-xyz.md' });
  assert.equal(missing.status, 403);
  const secret = await tool('file_info', { path: 'app/.env.local' });
  assert.equal(secret.status, 403);
  assert.match(secret.body.error, /denied/);
});

// --- append_file ------------------------------------------------------------
test('tools: append_file appends to an existing file and refuses the rest', async () => {
  const rel = 'cycle-test-append.txt';
  const full = path.join(WORKSPACE, rel);
  try {
    const c = await tool('create_file', { path: rel, content: 'line one\n' });
    assert.equal(c.status, 200);
    const a = await tool('append_file', { path: rel, content: 'line two\n' });
    assert.equal(a.status, 200);
    assert.equal(a.body.appended_chars, 9);
    const back = await tool('read_file', { path: rel });
    assert.equal(back.body.content, 'line one\nline two\n');
    const missing = await tool('append_file', { path: 'cycle-test-nope.txt', content: 'x' });
    assert.equal(missing.status, 403);
    assert.match(missing.body.error, /use create_file/);
    const big = await tool('append_file', { path: rel, content: 'x'.repeat(10241) });
    assert.equal(big.status, 403);
    const denied = await tool('append_file', { path: 'app/.env.local', content: 'x' });
    assert.equal(denied.status, 403);
  } finally {
    try { fs.unlinkSync(full); } catch {}
  }
});

// --- recent_activity --------------------------------------------------------
test('tools: recent_activity returns newest-first audit rows, capped at 20', async () => {
  await tool('list_files', { path: '.' });
  const r = await tool('recent_activity', { limit: 5 });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.activity));
  assert.ok(r.body.activity.length >= 1 && r.body.activity.length <= 5);
  const ids = r.body.activity.map(a => a.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
  for (const row of r.body.activity) {
    assert.equal(typeof row.tool, 'string');
    assert.ok(String(row.args).length <= 200);
    assert.ok(String(row.result).length <= 200);
  }
  const clamped = await tool('recent_activity', { limit: 999 });
  assert.ok(clamped.body.activity.length <= 20);
  const one = await tool('recent_activity', { limit: 1 });
  assert.equal(one.body.activity.length, 1);
});

// --- declarations: 25 tools, derived schemas stay in sync -------------------
test('brain: derived OpenAI/Anthropic schemas include the 4 new tools', () => {
  const brain = require('../brain');
  assert.equal(brain.TOOL_DECLARATIONS.length, 25);
  const names = brain.TOOL_DECLARATIONS.map(d => d.name);
  for (const n of ['create_approval', 'file_info', 'append_file', 'recent_activity']) assert.ok(names.includes(n));
  assert.deepEqual(brain.openaiTools().map(t => t.function.name).sort(), [...names].sort());
  assert.deepEqual(brain.anthropicTools().map(t => t.name).sort(), [...names].sort());
  assert.ok(!names.some(n => /send|post|spend|delete|email|payment/i.test(n)));
});

// --- web_fetch: redirect safety (stubbed fetch, no network) ------------------
test('fetch: redirect to a private address is denied, public redirect followed', async () => {
  const { fetchPublicText, assertPublicHttpsUrl } = require('../tools');
  assert.equal(assertPublicHttpsUrl('https://example.com/a').hostname, 'example.com');
  assert.throws(() => assertPublicHttpsUrl('http://example.com/'), /requires an https URL/);
  assert.throws(() => assertPublicHttpsUrl('https://169.254.169.254/latest'), /private\/local/);
  assert.throws(() => assertPublicHttpsUrl('https://10.0.0.5/'), /private\/local/);

  const headers = (loc) => ({ get: (k) => (k.toLowerCase() === 'location' ? loc : null) });
  // Public -> private redirect: must be denied, and the private hop never fetched.
  let fetched = [];
  const evil = async (url) => {
    fetched.push(url);
    if (url === 'https://example.com/start') return { status: 302, ok: false, headers: headers('https://169.254.169.254/latest/meta-data/'), text: async () => '' };
    throw new Error('must not fetch the private hop');
  };
  await assert.rejects(() => fetchPublicText('https://example.com/start', evil), /private\/local/);
  assert.deepEqual(fetched, ['https://example.com/start']);
  // Public -> public redirect: followed once, HTML stripped, manual redirect mode.
  let opts;
  const good = async (url, o) => {
    opts = o;
    if (url === 'https://example.com/old') return { status: 301, ok: false, headers: headers('https://example.com/new'), text: async () => '' };
    return { status: 200, ok: true, headers: headers(null), text: async () => '<html><body><p>Hello <b>world</b></p><script>evil()</script></body></html>' };
  };
  const text = await fetchPublicText('https://example.com/old', good);
  assert.equal(text, 'Hello world');
  assert.equal(opts.redirect, 'manual');
  // Redirect loop: capped.
  const loop = async () => ({ status: 302, ok: false, headers: headers('https://example.com/loop'), text: async () => '' });
  await assert.rejects(() => fetchPublicText('https://example.com/loop', loop), /too many redirects/);
  // HTTP error surfaces, no silent empty text.
  const notFound = async () => ({ status: 404, ok: false, headers: headers(null), text: async () => 'nope' });
  await assert.rejects(() => fetchPublicText('https://example.com/missing', notFound), /HTTP 404/);
});

// --- i18n --------------------------------------------------------------------
test('i18n: en/hi/te share identical key sets, no empty strings, real translations', () => {
  const { STRINGS, LANGS, t } = require('../public/i18n');
  assert.deepEqual(LANGS.map(l => l.code), ['en', 'hi', 'te']);
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.ok(enKeys.length >= 50, `expected 50+ keys, got ${enKeys.length}`);
  for (const lang of ['hi', 'te']) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), enKeys, `${lang} key set must match en`);
    for (const k of enKeys) {
      assert.equal(typeof STRINGS[lang][k], 'string');
      assert.ok(STRINGS[lang][k].length > 0, `${lang}.${k} must not be empty`);
    }
    const translated = enKeys.filter(k => STRINGS[lang][k] !== STRINGS.en[k]).length;
    assert.ok(translated / enKeys.length >= 0.9, `${lang}: only ${translated}/${enKeys.length} keys differ from English`);
  }
  // Spot checks: known real translations, not English copies.
  assert.equal(t('thinking', 'hi'), 'सोच रहा हूँ…');
  assert.equal(t('send', 'te'), 'పంపండి');
  assert.equal(t('freeze', 'hi'), 'एजेंट रोकें');
  // Fallbacks.
  assert.equal(t('send', 'xx'), STRINGS.en.send);
  assert.equal(t('no_such_key', 'hi'), 'no_such_key');
});

test('i18n: every data-i18n key used by index.html exists in all languages', () => {
  const { STRINGS } = require('../public/i18n');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-ph="([^"]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size >= 30, `expected 30+ i18n keys in HTML, got ${keys.size}`);
  for (const k of keys) for (const lang of ['en', 'hi', 'te']) assert.ok(STRINGS[lang][k], `missing ${lang}.${k}`);
});

// --- frontend serving + shipped chat path ------------------------------------
test('frontend: index serves chat first with language picker, i18n.js served', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.indexOf('id="chat-box"') < html.indexOf('id="settings-box"'), 'chat comes before settings');
  assert.match(html, /id="lang-select"/);
  assert.match(html, /src="i18n\.js"/);
  const js = await fetch(BASE + '/i18n.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /PipletI18n/);
});

test('frontend: chat rendering appends nodes instead of re-parsing history', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!appJs.includes('innerHTML +='), 'no innerHTML += re-parse path may remain');
  assert.match(appJs, /appendChild/);
  assert.match(appJs, /pending/);
});
