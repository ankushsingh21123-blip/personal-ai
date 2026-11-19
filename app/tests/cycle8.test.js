// Computer-use v2 tests (19 Nov 2026): vision-grounded clicks
// (DOM-geometry grounding + provider fallback labelling), self-healing
// observe-act-verify retries, multi-step stateful flows, desktop input
// execution (xdotool + scrot, now installed on this VM), snapshot
// geometry/caching, and per-action latency. Live browser tests run
// against a loopback HTTP server (allowLoopback sessions — the agent
// tool path never sets that flag). If Chromium is unavailable the live
// tests assert the clear error instead of failing.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const { after } = require('node:test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

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
const grounding = require('../grounding');
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

const fakeApprovals = (id) => (Number(id) === 7 ? { status: 'approved' } : null);

// --- grounding: DOM geometry -----------------------------------------------
const ENTRIES = [
  { role: 'button', name: 'Press me', selector: '#go', rect: { x: 10, y: 20, width: 100, height: 30 }, centerNorm: { x: 60 / 1280, y: 35 / 800 } },
  { role: 'textbox', name: 'Note', selector: '#note', rect: { x: 10, y: 60, width: 200, height: 24 }, centerNorm: { x: 110 / 1280, y: 72 / 800 } },
  { role: 'button', name: 'Submit form', selector: '#submitBtn', rect: { x: 10, y: 100, width: 90, height: 28 }, centerNorm: { x: 55 / 1280, y: 114 / 800 } },
];

test('computer-use-v2: groundFromSnapshot finds the target by quoted label and returns its centre', () => {
  const g = grounding.groundFromSnapshot("click the button labelled 'Press me'", ENTRIES, { width: 1280, height: 800 });
  assert.equal(g.action, 'click');
  assert.equal(g.grounder, 'dom-geometry');
  assert.ok(Math.abs(g.x - 60 / 1280) < 1e-9);
  assert.ok(Math.abs(g.y - 35 / 800) < 1e-9);
  assert.ok(g.confidence > 0 && g.confidence <= 1);
  assert.equal(g.matched.selector, '#go');
});

test('computer-use-v2: groundFromSnapshot matches by role+name words and by rect when no centreNorm', () => {
  const byRole = grounding.groundFromSnapshot('click the submit form button', ENTRIES, { width: 1280, height: 800 });
  assert.equal(byRole.matched.selector, '#submitBtn');
  const noCentre = [{ role: 'button', name: 'Press me', selector: '#go', rect: { x: 10, y: 20, width: 100, height: 30 } }];
  const g = grounding.groundFromSnapshot("click 'Press me'", noCentre, { width: 1280, height: 800 });
  assert.ok(Math.abs(g.x - 60 / 1280) < 1e-9);
  assert.ok(Math.abs(g.y - 35 / 800) < 1e-9);
});

test('computer-use-v2: groundFromSnapshot refuses to guess — unknown target is cannot_see', () => {
  assert.throws(() => grounding.groundFromSnapshot('click the banana launcher', ENTRIES), /cannot_see/);
  assert.throws(() => grounding.groundFromSnapshot('click the button', []), /cannot_see/);
  assert.throws(() => grounding.groundFromSnapshot('', ENTRIES), /needs a task/);
  const noGeo = [{ role: 'button', name: 'Press me', selector: '#go' }];
  assert.throws(() => grounding.groundFromSnapshot("click 'Press me'", noGeo), /no geometry/);
});

test('computer-use-v2: groundWithFallback prefers the provider when one answers, labels it', async () => {
  const realFetch = global.fetch;
  const savedKey = process.env.GEMINI_API_KEY;
  const savedOrder = process.env.BRAIN_PROVIDERS;
  process.env.GEMINI_API_KEY = 'AIza' + '-test-key-for-unit-test-only';
  process.env.BRAIN_PROVIDERS = 'gemini-direct'; // visionOrder follows this, not the key alone
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"action":"click","x":0.5,"y":0.25,"confidence":0.9,"description":"click it"}' }] } }] }),
  });
  try {
    const r = await grounding.groundWithFallback('click the button', 'iVBORw0KGgo=', { snapshotEntries: ENTRIES });
    assert.equal(r.grounder, 'vision-provider');
    assert.equal(r.provider, 'gemini-direct');
    assert.equal(r.action, 'click');
    assert.equal(r.x, 0.5);
  } finally {
    global.fetch = realFetch;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    if (savedOrder === undefined) delete process.env.BRAIN_PROVIDERS;
    else process.env.BRAIN_PROVIDERS = savedOrder;
  }
});

test('computer-use-v2: groundWithFallback falls back to DOM geometry when no vision provider exists', async () => {
  if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OLLAMA_VISION_MODEL) {
    assert.ok(true, 'a vision key is configured here — fallback path not exercised');
    return;
  }
  const r = await grounding.groundWithFallback("click the button labelled 'Press me'", 'iVBORw0KGgo=', { snapshotEntries: ENTRIES });
  assert.equal(r.grounder, 'dom-geometry');
  assert.equal(r.provider, null);
  assert.equal(r.matched.selector, '#go');
  await assert.rejects(
    grounding.groundWithFallback('click the button', 'iVBORw0KGgo=', {}),
    /no vision providers available/);
});

// --- self-healing ------------------------------------------------------------
function healingFakeSession(behaviour) {
  // behaviour: { failFirst: Set of selectors that throw on first use,
  //   failVerify: Set of selectors whose click returns ok:false,
  //   submitDenied: boolean }
  const seen = new Map();
  return {
    act: async (a) => {
      if (a.action === 'snapshot') {
        return { ok: true, entries: ENTRIES, url: 'http://127.0.0.1/test', cached: false };
      }
      if (a.action === 'submit') {
        throw new Error('denied: approval 999 not found or not approved — form submit refused');
      }
      if (a.action === 'click' || a.action === 'type') {
        const key = a.selector || a.text || a.role || `#${a.index}`;
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        if (behaviour.failFirst && behaviour.failFirst.has(key) && n === 1) {
          throw new Error(`click target not found on the page: ${key}`);
        }
        if (behaviour.failVerify && behaviour.failVerify.has(key)) {
          return { ok: false, verification: { ok: false, checks: [] } };
        }
        return { ok: true, clicked: true, verification: { ok: true, checks: [] }, ms: 1 };
      }
      return { ok: true };
    },
  };
}

function healingInstance(behaviour) {
  const session = healingFakeSession(behaviour);
  const fakeManager = { get: () => session, list: () => [], close: async () => true, closeAll: async () => {} };
  return new cu.ComputerUse({ manager: fakeManager, approvalLookup: fakeApprovals, auditFn: () => {} });
}

test('computer-use-v2: actSelfHealing retries a stale selector with the snapshot selector and heals', async () => {
  // '#stale' is not in the snapshot; the heal path matches by name instead:
  // use a stale TEXT target so the snapshot can find the same element.
  const session = healingFakeSession({ failFirst: new Set(['Press me']) });
  const fakeManager = { get: () => session, list: () => [], close: async () => true, closeAll: async () => {} };
  const inst2 = new cu.ComputerUse({ manager: fakeManager, approvalLookup: fakeApprovals, auditFn: () => {} });
  const r = await inst2.actSelfHealing({ action: 'click', text: 'Press me' });
  assert.equal(r.ok, true);
  assert.equal(r.healed, true);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].ok, false);
  assert.equal(r.attempts[1].ok, true);
  assert.match(r.attempts[1].strategy, /selector/);
});

test('computer-use-v2: actSelfHealing fails honestly when no alternate strategy exists', async () => {
  const session = {
    act: async (a) => {
      if (a.action === 'snapshot') return { ok: true, entries: [], url: 'http://127.0.0.1/test' };
      throw new Error('click target not found on the page');
    },
  };
  const fakeManager = { get: () => session, list: () => [], close: async () => true, closeAll: async () => {} };
  const inst = new cu.ComputerUse({ manager: fakeManager, approvalLookup: fakeApprovals, auditFn: () => {} });
  const r = await inst.actSelfHealing({ action: 'click', selector: '#gone' });
  assert.equal(r.ok, false);
  assert.equal(r.healed, false);
  assert.equal(r.attempts.length, 1);
  assert.match(r.error, /no alternate targeting strategy/);
});

test('computer-use-v2: actSelfHealing never heals past a deny gate (submit without approval)', async () => {
  const inst = healingInstance({});
  const r = await inst.actSelfHealing({ action: 'submit', selector: '#submitBtn', approvalId: 999 });
  assert.equal(r.ok, false);
  assert.equal(r.healed, false);
  assert.equal(r.attempts.length, 2);
  assert.ok(r.attempts.every((a) => a.ok === false));
  assert.match(r.error || r.attempts[1].error, /not found or not approved/);
});

test('computer-use-v2: runFlow selfHeal rescues a step and reports it; without it the flow stops', async () => {
  const inst = healingInstance({ failFirst: new Set(['Press me']) });
  const healed = await inst.runFlow([
    { action: 'navigate', url: 'https://example.com' },
    { action: 'click', text: 'Press me' },
    { action: 'click', selector: '#go' },
  ], { budgetMs: 5000, selfHeal: true });
  assert.equal(healed.done, true);
  assert.equal(healed.steps[1].healed, true);
  assert.equal(healed.steps[1].attempts.length, 2);
  assert.equal(healed.steps[0].healed, false);
  assert.equal(typeof healed.timings.totalMs, 'number');
  assert.equal(healed.timings.stepsMs.length, 3);

  const inst2 = healingInstance({ failFirst: new Set(['Press me']) });
  const plain = await inst2.runFlow([
    { action: 'navigate', url: 'https://example.com' },
    { action: 'click', text: 'Press me' },
  ], { budgetMs: 5000 });
  assert.equal(plain.done, false);
  assert.match(plain.stopReason, /threw/);
  assert.equal(plain.steps.length, 2);
});

test('computer-use-v2: runFlow timings are measured on every run', async () => {
  const fakeSession = { act: async () => ({ ok: true, stateChanged: true }) };
  const fakeManager = { get: () => fakeSession, list: () => [], close: async () => true, closeAll: async () => {} };
  const inst = new cu.ComputerUse({ manager: fakeManager, approvalLookup: () => null, auditFn: () => {} });
  const flow = await inst.runFlow([
    { action: 'navigate', url: 'https://example.com' },
    { action: 'click', selector: '#ok' },
  ], { budgetMs: 5000 });
  assert.equal(flow.done, true);
  assert.equal(flow.timings.stepsMs.length, 2);
  assert.ok(flow.timings.totalMs >= 0);
  assert.ok(flow.timings.slowestMs >= 0);
  assert.ok(flow.timings.slowestStep === 0 || flow.timings.slowestStep === 1);
});

// --- domCheck hash + snapshot geometry/caching (unit) ------------------------
test('computer-use-v2: domCheck returns the page text hash for digest reuse', async () => {
  const model = { text: 'Hello World\nstatus: after', els: { '#name': { value: 'Ankush', checked: false, visible: true } }, counts: {} };
  const fakePage = {
    url: () => 'https://example.com/page',
    title: async () => 'T',
    evaluate: async (fn, wanted) => ({
      text: model.text,
      per: wanted.map(() => ({ value: 'Ankush', checked: false, visible: true })),
    }),
  };
  const r = await bs.domCheck(fakePage, [{ type: 'text_present', text: 'after' }]);
  assert.equal(r.ok, true);
  assert.equal(r.textHash, crypto.createHash('sha256').update(model.text).digest('hex').slice(0, 16));
  assert.equal(r.textLength, String(model.text).length);
});

// --- desktop input execution -------------------------------------------------
test('computer-use-v2: xdotool calibration helpers compute screen points from window geometry', () => {
  const geo = { screenX: 10, screenY: 10, outerW: 1288, outerH: 931, innerW: 1280, innerH: 800 };
  const cands = di.xdotoolTopChromeCandidates(geo);
  assert.ok(cands.includes(131), 'full chrome height is the first candidate');
  assert.ok(cands.includes(90));
  assert.ok(cands.every((c) => c >= 0));
  const pt = di.xdotoolScreenPoint(100, 50, geo, 90);
  assert.deepEqual(pt, { x: 110, y: 150 });
});

test('computer-use-v2: xdotoolAct and rootScreenshot refuse clearly without a DISPLAY', async () => {
  const saved = process.env.DISPLAY;
  delete process.env.DISPLAY;
  try {
    await assert.rejects(di.xdotoolAct({ action: 'click', x: 0.5, y: 0.5 }), /DISPLAY/);
    await assert.rejects(di.rootScreenshot(), /DISPLAY/);
    await assert.rejects(di.xdotoolAct({ action: 'type', text: 'x', sensitive: true }), /sensitive/);
    await assert.rejects(di.xdotoolAct({ action: 'click', x: 2, y: 0.5 }), /DISPLAY|normalised/);
  } finally {
    if (saved !== undefined) process.env.DISPLAY = saved;
  }
});

// --- live browser: loopback test site (shared with cycle7) -------------------
const TEST_HTML = `<!doctype html><html><head><title>CU Test</title></head><body>
<h1>Computer Use Test</h1>
<p id="status">before</p>
<button id="flip" onclick="document.getElementById('status').textContent='after';document.title='Flipped'">Flip it</button>
<label>Name <input id="name" type="text" value=""></label>
<label>Secret <input id="pwd" type="password" value=""></label>
<label>Choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label><input id="agree" type="checkbox"> Agree</label>
<form id="form" onsubmit="event.preventDefault();document.getElementById('status').textContent='submitted: '+document.getElementById('name').value+' / '+document.getElementById('choice').value;"><button id="submitBtn" type="submit">Submit form</button></form>
</body></html>`;

function startSite() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(TEST_HTML); });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })); });
}

test('computer-use-v2: LIVE snapshot entries carry real geometry + centreNorm, and fresh:false caches', { timeout: 90000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) { assert.ok(true, 'browser unavailable — covered by the cycle7 unavailable test'); return; }
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const s = mgr.get('v2snap', { allowLoopback: true, userDataDir: profileDir() });
    await s.act({ action: 'navigate', url });
    const snap = await s.act({ action: 'snapshot' });
    assert.equal(snap.cached, false);
    const flip = snap.entries.find((e) => e.name.includes('Flip it'));
    assert.ok(flip, 'Flip button in snapshot');
    assert.ok(flip.rect && flip.rect.width > 0 && flip.rect.height > 0, 'rect present');
    assert.ok(flip.centerNorm && flip.centerNorm.x > 0 && flip.centerNorm.x < 1 && flip.centerNorm.y > 0 && flip.centerNorm.y < 1, 'centreNorm in 0..1');
    const cached = await s.act({ action: 'snapshot', fresh: false });
    assert.equal(cached.cached, true);
    assert.equal(cached.entries.length, snap.entries.length);
    const fresh = await s.act({ action: 'snapshot' });
    assert.equal(fresh.cached, false);
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

test('computer-use-v2: LIVE every action reports its own latency in ms', { timeout: 90000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) return;
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const s = mgr.get('v2ms', { allowLoopback: true, userDataDir: profileDir() });
    const nav = await s.act({ action: 'navigate', url });
    assert.equal(typeof nav.ms, 'number');
    assert.ok(nav.ms >= 0);
    const clicked = await s.act({ action: 'click', selector: '#flip', expect: [{ type: 'text_present', text: 'after' }] });
    assert.equal(typeof clicked.ms, 'number');
    assert.ok(clicked.ok);
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

test('computer-use-v2: LIVE grounded_click — screenshot, DOM-geometry ground, CDP mouse click, dom_check', { timeout: 120000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) return;
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const inst = new cu.ComputerUse({ manager: mgr, approvalLookup: fakeApprovals, auditFn: () => {} });
    const nav = await inst.act({ action: 'navigate', url, session: 'v2ground', allowLoopback: true });
    assert.equal(nav.ok, true);
    const g = await inst.act({ action: 'grounded_click', task: "click the button labelled 'Flip it'", session: 'v2ground', preferDom: true, expect: [{ type: 'text_present', text: 'after' }] });
    assert.equal(g.ok, true);
    assert.equal(g.grounder, 'dom-geometry');
    assert.ok(g.x > 0 && g.x < 1 && g.y > 0 && g.y < 1);
    assert.equal(g.verification.ok, true);
    assert.equal(typeof g.ms, 'number');
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

test('computer-use-v2: LIVE multi-step stateful flow — navigate, fill, select, check, submit (approved), verify', { timeout: 120000 }, async () => {
  const cap = browserMod.capability();
  if (!cap.available) return;
  const { server, url } = await startSite();
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  try {
    const inst = new cu.ComputerUse({ manager: mgr, approvalLookup: fakeApprovals, auditFn: () => {} });
    // Step 1 (a "turn"): navigate + type the name — state persists.
    const first = mgr.get('v2flow', { allowLoopback: true, userDataDir: profileDir() });
    await first.act({ action: 'navigate', url });
    await first.act({ action: 'type', selector: '#name', value: 'Ankush' });
    // Step 2 (a "later turn"): same session id, same page, same typed value.
    const flow = await inst.runFlow([
      { action: 'select', selector: '#choice', value: 'b', expect: [{ type: 'value_equals', selector: '#choice', value: 'b' }] },
      { action: 'check', selector: '#agree', checked: true, expect: [{ type: 'checked', selector: '#agree', checked: true }] },
      { action: 'submit', selector: '#submitBtn', approvalId: 7, expect: [{ type: 'text_present', text: 'submitted: Ankush / b' }] },
      { action: 'dom_check', checks: [{ type: 'value_equals', selector: '#name', value: 'Ankush' }] },
    ], { session: 'v2flow', budgetMs: 30000, selfHeal: true });
    assert.equal(flow.done, true, flow.stopReason);
    assert.equal(flow.steps.length, 4);
    assert.ok(flow.timings.totalMs >= 0);
    assert.equal(flow.steps.every((s) => s.ok), true);
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

test('computer-use-v2: LIVE Xvfb + xdotool click changes the DOM (real OS-level input)', { timeout: 120000 }, async () => {
  const probe = di.probeEnvironment();
  if (!probe.backends.xvfb || !probe.backends.xdotool || !browserMod.capability().available) {
    assert.ok(true, 'Xvfb or xdotool or Chromium missing — desktop proof skipped, not faked');
    return;
  }
  const { server, url } = await startSite();
  const xvfb = new di.XvfbSession({});
  const mgr = new bs.BrowserSessionManager({ approvalLookup: fakeApprovals });
  const prevDisplay = process.env.DISPLAY;
  try {
    const disp = await xvfb.start();
    process.env.DISPLAY = disp.display;
    const s = mgr.get('v2xdo', { allowLoopback: true, headed: true, userDataDir: profileDir() });
    await s.act({ action: 'navigate', url });
    const tab = await s.ensureContext();
    const page = tab.page;
    const box = await page.locator('#flip').boundingBox();
    assert.ok(box, 'button bounding box found');
    // Viewport -> screen needs calibration (see desktop-input.js): try
    // candidate top-chrome heights against the known button until the
    // DOM flips. The button's viewport centre is known; each probe click
    // is followed by a dom_check, and a miss resets the page.
    const geo = await page.evaluate(() => ({ screenX: window.screenX, screenY: window.screenY, outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight }));
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    let hit = null;
    for (const topChrome of di.xdotoolTopChromeCandidates(geo)) {
      const pt = di.xdotoolScreenPoint(cx, cy, geo, topChrome);
      const r = await di.xdotoolAct({ action: 'click', x: pt.x / 1280, y: pt.y / 800 }, { display: disp.display, viewport: { width: 1280, height: 800 } });
      assert.equal(r.ok, true);
      assert.equal(r.backend, 'xdotool');
      const check = await s.act({ action: 'dom_check', checks: [{ type: 'text_present', text: 'after' }] });
      if (check.ok) { hit = { topChrome, screenX: pt.x, screenY: pt.y }; break; }
      await s.act({ action: 'navigate', url });
    }
    assert.ok(hit, 'xdotool click flipped the DOM text after calibration');
  } finally {
    process.env.DISPLAY = prevDisplay;
    await mgr.closeAll();
    await xvfb.stop();
    server.close();
  }
});

test('computer-use-v2: LIVE Xvfb + scrot captures the whole desktop (root screenshot)', { timeout: 120000 }, async () => {
  const probe = di.probeEnvironment();
  if (!probe.backends.xvfb || !probe.backends.scrot || !browserMod.capability().available) {
    assert.ok(true, 'Xvfb or scrot or Chromium missing — root screenshot skipped, not faked');
    return;
  }
  const xvfb = new di.XvfbSession({});
  const prevDisplay = process.env.DISPLAY;
  try {
    const disp = await xvfb.start();
    process.env.DISPLAY = disp.display;
    const shot = await di.rootScreenshot({ display: disp.display });
    assert.equal(shot.ok, true);
    assert.equal(shot.backend, 'scrot');
    assert.ok(shot.imageBase64.length > 1000, 'real desktop pixels captured');
    assert.equal(shot.mimeType, 'image/png');
  } finally {
    process.env.DISPLAY = prevDisplay;
    await xvfb.stop();
  }
});

// --- API surface: grounded_click + selfHeal flow ------------------------------
test('computer-use-v2: API grounded_click validation + flow selfHeal flag (live server)', { timeout: 30000 }, async () => {
  const bad = await api('/api/computer-use/act', { method: 'POST', body: JSON.stringify({ action: 'grounded_click' }) });
  assert.equal(bad.status, 403);
  assert.match(bad.body.error, /needs task/);
  const badFlow = await api('/api/computer-use/flow', { method: 'POST', body: JSON.stringify({ steps: [] }) });
  assert.equal(badFlow.status, 403);
});
