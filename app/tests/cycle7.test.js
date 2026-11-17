// Computer-use cycle tests (18 Nov 2026, cycle7 after the merge — the
// branch's cycle6.test.js renamed, since main already had a cycle6):
// stateful browser sessions,
// DOM-check verification, desktop input alternatives, the observe loop
// with the zoom fix, and the Xvfb + CDP live proof. Live browser tests run
// against a loopback HTTP server (allowLoopback sessions — the agent tool
// path never sets that flag). If Chromium is unavailable the live tests
// assert the clear error instead of failing.
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { after } = require('node:test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Throwaway browser profiles: unique per session, removed after the file.
const tmpProfiles = [];
function profileDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'piplet-test-profile-'));
  tmpProfiles.push(d);
  return d;
}
after(() => {
  for (const d of tmpProfiles) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const bs = require('../browser-session');
const di = require('../desktop-input');
const cu = require('../computer-use');
const browserMod = require('../browser');

const PORT = Number(process.env.PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.ANKU_TOKEN || '';

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Anku-Token': TOKEN, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Approval lookup for tests: only id 7 is approved.
const fakeApprovals = (id) => (Number(id) === 7 ? { status: 'approved' } : null);

// --- validation -------------------------------------------------------------
test('computer-use: session action validation rejects unknown actions and bad targets', () => {
  assert.throws(() => bs.validateAction({ action: 'explode' }), /unknown browser session action/);
  assert.throws(() => bs.validateAction({ action: 'click' }), /exactly one target/);
  assert.throws(() => bs.validateAction({ action: 'click', selector: '#a', text: 'hi' }), /exactly one target/);
  assert.throws(() => bs.validateAction({ action: 'click', role: 'button' }), /needs name/);
  assert.throws(() => bs.validateAction({ action: 'type', selector: '#a' }), /needs value/);
  assert.throws(() => bs.validateAction({ action: 'type', selector: '#a', value: 'x', sensitive: true }), /sensitive/);
  assert.throws(() => bs.validateAction({ action: 'submit', selector: '#a' }), /approved approval id/);
  assert.throws(() => bs.validateAction({ action: 'set_files', selector: '#a', files: ['x.txt'] }), /approved approval id/);
  assert.throws(() => bs.validateAction({ action: 'click', selector: '#a', expectDownload: true }), /approved approval id/);
  assert.throws(() => bs.validateAction({ action: 'zoom', region: [0, 0, 0, 0] }), /zoom needs region/);
  assert.throws(() => bs.validateAction({ action: 'dom_check' }), /needs checks/);
  assert.throws(() => bs.validateAction({ action: 'switch_tab', tab: 99 }), /tab must be/);
  assert.equal(bs.validateAction({ action: 'click', selector: '#a', expect: [{ type: 'text_present', text: 'hi' }] }).action, 'click');
});

test('computer-use: check validation rejects unknown types and bad shapes', () => {
  assert.throws(() => bs.validateChecks([{ type: 'nope' }]), /unknown type/);
  assert.throws(() => bs.validateChecks([{ type: 'selector_count', selector: '#a' }]), /needs count, gte, or lte/);
  assert.throws(() => bs.validateChecks([{ type: 'url_matches', pattern: '(' }]), /not a valid regular expression/);
  assert.throws(() => bs.validateChecks([]), /1..20 checks/);
  assert.equal(bs.validateChecks([{ type: 'checked', selector: '#a' }])[0].checked, true);
  assert.throws(() => bs.validateSessionId('bad id!'), /session id/);
  assert.equal(bs.validateSessionId(), 'default');
});

test('computer-use: domCheck evaluates every check type against a fake page', async () => {
  const model = {
    text: 'Hello World\nstatus: after',
    els: {
      '#name': { value: 'Ankush', checked: false, visible: true },
      '#agree': { value: 'on', checked: true, visible: true },
      '#hidden': { value: '', checked: false, visible: false },
    },
    counts: { button: 2, 'input.missing': 0 },
  };
  const fakePage = {
    url: () => 'https://example.com/page?x=1',
    title: async () => 'Test Title',
    evaluate: async (fn, wanted) => ({
      text: model.text,
      per: wanted.map((w) => {
        if (w.type === 'selector_count') return { count: model.counts[w.selector] ?? 0 };
        const el = model.els[w.selector];
        if (!el) return { missing: true };
        return { value: el.value, checked: el.checked, visible: el.visible, attribute: w.attribute === 'data-kind' ? 'demo' : null };
      }),
    }),
  };
  const pass = await bs.domCheck(fakePage, [
    { type: 'text_present', text: 'after' },
    { type: 'text_absent', text: 'nope' },
    { type: 'title_contains', text: 'Test' },
    { type: 'url_matches', pattern: 'example\\.com/page' },
    { type: 'selector_count', selector: 'button', count: 2 },
    { type: 'selector_count', selector: 'button', gte: 1, lte: 5 },
    { type: 'value_equals', selector: '#name', value: 'Ankush' },
    { type: 'attribute_equals', selector: '#name', attribute: 'data-kind', value: 'demo' },
    { type: 'checked', selector: '#agree', checked: true },
    { type: 'visible', selector: '#name' },
  ]);
  assert.equal(pass.ok, true);
  const fail = await bs.domCheck(fakePage, [
    { type: 'text_present', text: 'missing-text' },
    { type: 'value_equals', selector: '#nope', value: 'x' },
    { type: 'checked', selector: '#agree', checked: false },
    { type: 'visible', selector: '#hidden' },
  ]);
  assert.equal(fail.ok, false);
  assert.equal(fail.checks.filter((c) => !c.passed).length, 4);
  assert.equal(fail.checks[1].actual, 'element missing');
});

// --- desktop input alternatives ----------------------------------------------
test('computer-use: probeEnvironment reports every backend honestly', () => {
  const probe = di.probeEnvironment();
  assert.equal(typeof probe.platform, 'string');
  assert.equal(typeof probe.backends.cdpViaPlaywright, 'boolean');
  assert.equal(typeof probe.backends.xvfb, 'boolean');
  assert.equal(Array.isArray(probe.usable), true);
  assert.equal(typeof probe.screenshotRoot, 'boolean');
});

test('computer-use: xdotool/ydotool argv builders produce exact argv', () => {
  assert.deepEqual(di.xdotoolArgs({ action: 'click', x: 100, y: 200 }), ['mousemove', '100', '200', 'click', '1']);
  assert.deepEqual(di.xdotoolArgs({ action: 'double_click', x: 1, y: 2 }), ['mousemove', '1', '2', 'click', '--repeat', '2', '--delay', '80', '1']);
  assert.deepEqual(di.xdotoolArgs({ action: 'type', text: 'hi' }), ['type', '--delay', '12', '--', 'hi']);
  assert.deepEqual(di.xdotoolArgs({ action: 'key', key: 'Return' }), ['key', 'Return']);
  assert.deepEqual(di.xdotoolArgs({ action: 'scroll', amount: -2 }), ['click', '--repeat', '2', '5']);
  assert.throws(() => di.xdotoolArgs({ action: 'zoom' }), /unsupported action/);
  assert.deepEqual(di.ydotoolArgs({ action: 'move', x: 5, y: 6 }), ['mousemove', '--absolute', '5', '6']);
  assert.throws(() => di.ydotoolArgs({ action: 'scroll', amount: 1 }), /unsupported action/);
});

test('computer-use: CdpInput sends exact CDP commands (recording fake)', async () => {
  const sent = [];
  const input = new di.CdpInput({ session: { send: async (m, p) => { sent.push([m, p]); return { data: 'iVBOR' }; } }, viewport: { width: 1000, height: 500 } });
  assert.deepEqual(input.toPixels(0.5, 0.5), { x: 500, y: 250 });
  await input.mouseClick(10, 20);
  await input.keyPress('Enter');
  await input.typeText('abc');
  await input.scroll(10, 20, -120);
  const shot = await input.screenshot();
  assert.equal(shot.imageBase64, 'iVBOR');
  assert.equal(sent[0][0], 'Input.dispatchMouseEvent');
  assert.equal(sent[0][1].type, 'mousePressed');
  assert.equal(sent[2][0], 'Input.dispatchKeyEvent');
  assert.equal(sent[4][0], 'Input.insertText');
  assert.equal(sent[4][1].text, 'abc');
  assert.equal(sent[5][1].type, 'mouseWheel');
  assert.throws(() => new di.CdpInput({}), /needs a CDP session/);
  await assert.rejects(input.typeText(''), /1..4000 chars/);
});

test('computer-use: runToolBinary refuses clearly when the binary is missing', async () => {
  await assert.rejects(di.runToolBinary('definitely-not-a-real-binary-xyz', []), /not installed/);
});

// --- observe loop: zoom fix + budget ------------------------------------------
test('computer-use: runObserveLoop feeds the zoom region shot to the next grounding', async () => {
  const crypto = require('crypto');
  const full = Buffer.from('full-screen-pixels');
  const region = Buffer.from('zoomed-region-pixels');
  const seen = [];
  let calls = 0;
  const out = await cu.runObserveLoop('read the small text', {
    capture: async () => ({ buffer: full, hash: crypto.createHash('sha256').update(full).digest('hex') }),
    ground: async (task, b64, { zoomed }) => {
      calls++;
      seen.push({ zoomed, b64: Buffer.from(b64, 'base64').toString() });
      if (calls === 1) return { action: 'zoom', region: [0.1, 0.1, 0.5, 0.5], description: 'zoom into text' };
      return { action: 'done', description: 'read it' };
    },
    act: async (a) => (a.action === 'zoom' ? { ok: true, imageBase64: region.toString('base64') } : { ok: true }),
  }, { maxActions: 5, budgetMs: 5000 });
  assert.equal(out.done, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].zoomed, false);
  assert.equal(seen[1].zoomed, true);
  assert.equal(seen[1].b64, 'zoomed-region-pixels');
});

test('computer-use: runObserveLoop stops on unchanged screen and on budget', async () => {
  const same = { buffer: Buffer.from('same'), hash: 'h1' };
  const unchanged = await cu.runObserveLoop('t', {
    capture: async () => same,
    ground: async () => ({ action: 'wait', ms: 1 }),
    act: async () => ({ ok: true }),
  }, { maxActions: 5, budgetMs: 5000 });
  assert.equal(unchanged.done, false);
  assert.match(unchanged.stopReason, /unchanged twice/);
  let now = 0;
  const budgeted = await cu.runObserveLoop('t', {
    capture: async () => ({ buffer: Buffer.from('x' + now), hash: 'h' + now }),
    ground: async () => { now += 1000; return { action: 'wait', ms: 1 }; },
    act: async () => ({ ok: true }),
  }, { maxActions: 10, budgetMs: 500, clock: () => now });
  assert.match(budgeted.stopReason, /budget_exceeded/);
});

// --- runFlow with a fake session ------------------------------------------------
test('computer-use: runFlow stops on the first failed verification and honours the budget', async () => {
  const fakeSession = {
    act: async (a) => {
      // Real action names only — the facade validates them. Behaviour is
      // keyed by marker selectors.
      if (a.selector === '#boom') throw new Error('kaboom');
      if (a.selector === '#bad') return { ok: false, verification: { ok: false, checks: [] } };
      return { ok: true, stateChanged: true };
    },
  };
  const fakeManager = { get: () => fakeSession, list: () => [], close: async () => true, closeAll: async () => {} };
  const inst = new cu.ComputerUse({ manager: fakeManager, approvalLookup: fakeApprovals, auditFn: () => {} });
  const okFlow = await inst.runFlow([{ action: 'navigate', url: 'https://example.com' }, { action: 'click', selector: '#ok' }], { budgetMs: 5000 });
  assert.equal(okFlow.done, true);
  assert.equal(okFlow.steps.length, 2);
  const badFlow = await inst.runFlow([{ action: 'navigate', url: 'https://example.com' }, { action: 'click', selector: '#bad' }, { action: 'click', selector: '#ok' }], { budgetMs: 5000 });
  assert.equal(badFlow.done, false);
  assert.match(badFlow.stopReason, /failed verification/);
  assert.equal(badFlow.steps.length, 2);
  const throwFlow = await inst.runFlow([{ action: 'click', selector: '#boom' }], { budgetMs: 5000 });
  assert.match(throwFlow.stopReason, /threw/);
  let now = 0;
  const clock = () => now;
  const budgetFlow = await inst.runFlow([{ action: 'navigate' }, { action: 'click' }], { budgetMs: 100, clock });
  assert.equal(budgetFlow.done, true); // fake clock never advances: no false budget trip
  await assert.rejects(inst.runFlow([], {}), /1..50 steps/);
  void now; void clock;
});

// --- live browser: loopback test site ------------------------------------------
const TEST_HTML = `<!doctype html><html><head><title>CU Test</title></head><body>
<h1>Computer Use Test</h1>
<p id="status">before</p>
<button id="flip" onclick="document.getElementById('status').textContent='after';document.title='Flipped'">Flip it</button>
<label>Name <input id="name" type="text" value=""></label>
<label>Secret <input id="pwd" type="password" value=""></label>
<label>Choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label><input id="agree" type="checkbox"> Agree</label>
<input id="file" type="file">
<form id="form" onsubmit="event.preventDefault();document.getElementById('status').textContent='submitted';"><button id="submitBtn" type="submit">Submit form</button></form>
<a id="page2" href="/two">Page two</a>
<a id="dl" href="/dl">Download file</a>
<div style="height:2800px"></div>
<p id="bottom">bottom marker</p>
<script>console.log('cu-test-log'); setTimeout(() => { const d = document.createElement('p'); d.id = 'late'; d.textContent = 'arrived late'; document.body.appendChild(d); }, 300);</script>
</body></html>`;
const PAGE2_HTML = `<!doctype html><html><head><title>Page Two</title></head><body><h1>Page Two</h1></body></html>`;

function startSite() {
  const server = http.createServer((req, res) => {
    if (req.url === '/two') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE2_HTML); }
    else if (req.url === '/dl') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="proof.txt"' });
      res.end('download-proof');
    }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(TEST_HTML); }
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })); });
}

test('computer-use: LIVE session — navigate, snapshot, click, type, select, check, dom_check', { timeout: 90000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) {
    const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
    await assert.rejects(mgr.get('t1').act({ action: 'navigate', url: 'https://example.com' }), /browser unavailable/);
    return;
  }
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const s = mgr.get('live1', { allowLoopback: true, userDataDir: profileDir() });
    const nav = await s.act({ action: 'navigate', url });
    assert.equal(nav.ok, true);
    const title = await s.act({ action: 'title' });
    assert.equal(title.title, 'CU Test');
    const snap = await s.act({ action: 'snapshot' });
    assert.ok(snap.entries.length >= 6);
    assert.ok(snap.entries.some((e) => e.name.includes('Flip it')));
    assert.ok(snap.entries.some((e) => e.inputType === 'password'));
    const clicked = await s.act({ action: 'click', selector: '#flip', expect: [{ type: 'text_present', text: 'after' }] });
    assert.equal(clicked.ok, true);
    assert.equal(clicked.verification.ok, true);
    assert.equal(clicked.stateChanged, true);
    const typed = await s.act({ action: 'type', selector: '#name', value: 'Ankush', expect: [{ type: 'value_equals', selector: '#name', value: 'Ankush' }] });
    assert.equal(typed.ok, true);
    const byRole = await s.act({ action: 'type', role: 'textbox', name: 'Name', value: 'ByRole' });
    assert.equal(byRole.ok, true);
    const sel = await s.act({ action: 'select', selector: '#choice', value: 'b', expect: [{ type: 'value_equals', selector: '#choice', value: 'b' }] });
    assert.equal(sel.ok, true);
    const chk = await s.act({ action: 'check', selector: '#agree', checked: true, expect: [{ type: 'checked', selector: '#agree', checked: true }] });
    assert.equal(chk.ok, true);
    // A failing expectation is reported, not hidden.
    const bad = await s.act({ action: 'click', selector: '#flip', expect: [{ type: 'text_present', text: 'never-appears-xyz' }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.verification.ok, false);
    // Password field: refused, no matter the targeting mode.
    await assert.rejects(s.act({ action: 'type', selector: '#pwd', value: 'secret' }), /password\/credential field/);
    // Submit without approval: refused. With approval 7: runs.
    await assert.rejects(s.act({ action: 'submit', selector: '#submitBtn', approvalId: 99 }), /not found or not approved/);
    const sub = await s.act({ action: 'submit', selector: '#submitBtn', approvalId: 7, expect: [{ type: 'text_present', text: 'submitted' }] });
    assert.equal(sub.ok, true);
    // File upload: outside-workspace path denied even with approval.
    await assert.rejects(s.act({ action: 'set_files', selector: '#file', files: ['/etc/passwd'], approvalId: 7 }), /escapes workspace|secret/);
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

test('computer-use: LIVE session — tabs, history, scroll, wait, a11y, dom, screenshots, observe', { timeout: 90000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) return; // covered by the unavailable-branch test above
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const s = mgr.get('live2', { allowLoopback: true, userDataDir: profileDir() });
    await s.act({ action: 'navigate', url });
    // Tabs: open, list, switch, close.
    const nt = await s.act({ action: 'new_tab', url: url + 'two' });
    assert.equal(nt.tabs, 2);
    const tabs = await s.act({ action: 'list_tabs' });
    assert.equal(tabs.tabs.length, 2);
    assert.equal(tabs.tabs[1].title, 'Page Two');
    await s.act({ action: 'switch_tab', tab: 0 });
    const back1 = await s.act({ action: 'title' });
    assert.equal(back1.title, 'CU Test');
    const closed = await s.act({ action: 'close_tab', tab: 1 });
    assert.equal(closed.tabs, 1);
    // History: follow the link, then back.
    await s.act({ action: 'click', text: 'Page two' });
    const u1 = await s.act({ action: 'url' });
    assert.match(u1.url, /\/two$/);
    await s.act({ action: 'back' });
    const u2 = await s.act({ action: 'url' });
    assert.equal(u2.url, url);
    await s.act({ action: 'forward' });
    await s.act({ action: 'reload' });
    // Back on the main test page for scroll/wait/screenshot checks.
    await s.act({ action: 'navigate', url });
    // Scroll + wait for the late element.
    await s.act({ action: 'scroll', text: 'bottom marker' });
    await s.act({ action: 'wait', selector: '#late', state: 'visible', timeoutMs: 5000 });
    const late = await s.act({ action: 'dom_check', checks: [{ type: 'text_present', text: 'arrived late' }] });
    assert.equal(late.ok, true);
    await s.act({ action: 'scroll', deltaY: -600 });
    // A11y tree + full DOM.
    const a11y = await s.act({ action: 'a11y' });
    assert.equal(a11y.ok, true);
    assert.equal(typeof a11y.tree, 'object');
    assert.match(JSON.stringify(a11y.tree), /Flip it/);
    assert.ok(['accessibility-tree', 'dom-fallback'].includes(a11y.source));
    const dom = await s.act({ action: 'dom' });
    assert.match(dom.html, /Computer Use Test/);
    // Screenshots: viewport, full page (taller), zoom clip (smaller bytes).
    const shot = await s.act({ action: 'screenshot' });
    assert.ok(shot.imageBase64.length > 1000);
    assert.equal(shot.fullPage, false);
    const full = await s.act({ action: 'screenshot', fullPage: true });
    assert.ok(full.imageBase64.length > shot.imageBase64.length);
    const zoom = await s.act({ action: 'zoom', region: [0, 0, 0.5, 0.25] });
    assert.ok(zoom.imageBase64.length > 100);
    assert.ok(zoom.imageBase64.length < shot.imageBase64.length);
    // Console + network observation captured the page's console.log.
    const obs = await s.act({ action: 'observe' });
    assert.ok(obs.console.some((c) => c.text.includes('cu-test-log')));
    assert.ok(obs.network.length >= 1);
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

test('computer-use: LIVE session — state persists across turns via the manager', { timeout: 60000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) return;
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const first = mgr.get('persist1', { allowLoopback: true, userDataDir: profileDir() });
    await first.act({ action: 'navigate', url });
    await first.act({ action: 'type', selector: '#name', value: 'kept' });
    // A "later turn" grabs the same session id: same page, same state.
    const second = mgr.get('persist1');
    assert.equal(second, first);
    const check = await second.act({ action: 'dom_check', checks: [{ type: 'value_equals', selector: '#name', value: 'kept' }] });
    assert.equal(check.ok, true);
    assert.equal(mgr.list().length, 1);
    await mgr.close('persist1');
    assert.equal(mgr.list().length, 0);
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

test('computer-use: LIVE session — downloads need approval; unapproved downloads are deleted', { timeout: 90000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) return;
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  const dlDir = path.join(__dirname, '..', 'data', 'downloads');
  try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
  try {
    const s = mgr.get('dl1', { allowLoopback: true, userDataDir: profileDir() });
    await s.act({ action: 'navigate', url });
    // Unapproved click on the download link: file must NOT be kept.
    await s.act({ action: 'click', selector: '#dl' });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(fs.existsSync(path.join(dlDir, 'proof.txt')), false);
    // Approved click: file lands in data/downloads with its content.
    const dl = await s.act({ action: 'click', selector: '#dl', expectDownload: true, approvalId: 7 });
    assert.equal(dl.downloadArrived, true);
    const saved = path.join(dlDir, 'proof.txt');
    assert.equal(fs.existsSync(saved), true);
    assert.equal(fs.readFileSync(saved, 'utf8'), 'download-proof');
  } finally {
    await mgr.closeAll();
    server.close();
    try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
  }
});

test('computer-use: LIVE session — https-only policy holds without allowLoopback', { timeout: 60000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) return;
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const s = mgr.get('policy1');
    await assert.rejects(s.act({ action: 'navigate', url: 'http://example.com' }), /https URL/);
    await assert.rejects(s.act({ action: 'navigate', url: 'https://127.0.0.1:3100/' }), /private\/local/);
  } finally {
    await mgr.closeAll();
  }
});

test('computer-use: LIVE Xvfb + headed Chromium + CDP click changes the DOM', { timeout: 120000 }, async () => {
  const probe = di.probeEnvironment();
  if (!probe.backends.xvfb || !browserMod.capability().available) {
    // Honest skip path: the environment cannot prove this.
    assert.ok(true, 'Xvfb or Chromium missing — desktop proof skipped, not faked');
    return;
  }
  const { server, url } = await startSite();
  const xvfb = new di.XvfbSession({});
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  const prevDisplay = process.env.DISPLAY;
  try {
    const disp = await xvfb.start();
    process.env.DISPLAY = disp.display;
    // Headed session on the virtual display.
    const s = mgr.get('xvfb1', { allowLoopback: true, headed: true, userDataDir: profileDir() });
    await s.act({ action: 'navigate', url });
    // CDP input: real mouse event at the Flip button's centre.
    const tab = await s.ensureContext();
    const page = tab.page;
    const box = await page.locator('#flip').boundingBox();
    assert.ok(box, 'button bounding box found');
    const cdp = await page.context().newCDPSession(page);
    const input = new di.CdpInput({ session: cdp, viewport: page.viewportSize() });
    await input.mouseClick(box.x + box.width / 2, box.y + box.height / 2);
    const check = await s.act({ action: 'dom_check', checks: [{ type: 'text_present', text: 'after' }] });
    assert.equal(check.ok, true, 'CDP click flipped the DOM text');
    // CDP screenshot of the headed window is real pixels.
    const shot = await input.screenshot();
    assert.ok(shot.imageBase64.length > 1000);
    // Desktop family through the facade: normalised click + screenshot.
    const inst = new cu.ComputerUse({ manager: mgr, approvalLookup: fakeApprovals, auditFn: () => {} });
    const deskShot = await inst.act({ action: 'desktop_screenshot', session: 'xvfb1' });
    assert.ok(deskShot.imageBase64.length > 1000);
    const probeOut = await inst.act({ action: 'desktop_probe', session: 'xvfb1' });
    assert.equal(probeOut.display, disp.display);
  } finally {
    process.env.DISPLAY = prevDisplay;
    await mgr.closeAll();
    await xvfb.stop();
    server.close();
  }
});

// --- live API surface ----------------------------------------------------------
test('computer-use: API status + act endpoints (live server)', { timeout: 30000 }, async () => {
  const st = await api('/api/computer-use/status');
  assert.equal(st.status, 200);
  assert.equal(typeof st.body.browser.available, 'boolean');
  assert.equal(typeof st.body.desktop, 'object');
  assert.ok(Array.isArray(st.body.sessions));
  const bad = await api('/api/computer-use/act', { method: 'POST', body: JSON.stringify({ action: 'explode' }) });
  assert.equal(bad.status, 403);
  const httpDenied = await api('/api/computer-use/act', { method: 'POST', body: JSON.stringify({ action: 'navigate', url: 'http://example.com' }) });
  assert.equal(httpDenied.status, 403);
  assert.match(httpDenied.body.error, /https URL/);
  const flowBad = await api('/api/computer-use/flow', { method: 'POST', body: JSON.stringify({ steps: [] }) });
  assert.equal(flowBad.status, 403);
});

test('computer-use: tool declared for native calling + ComputerUse status shape', () => {
  const brain = require('../brain');
  const names = brain.TOOL_DECLARATIONS ? brain.TOOL_DECLARATIONS.map((d) => d.name) : [];
  if (names.length) {
    assert.ok(names.includes('computer_use'), 'computer_use declared');
    const decl = brain.TOOL_DECLARATIONS.find((d) => d.name === 'computer_use');
    assert.deepEqual(decl.parameters.required, ['action']);
  }
  const inst = new cu.ComputerUse({ manager: new bs.BrowserSessionManager({ approvalLookup: fakeApprovals }), approvalLookup: fakeApprovals, auditFn: () => {} });
  const st = inst.status();
  assert.equal(typeof st.browser.available, 'boolean');
  assert.ok(Array.isArray(st.sessions));
});
