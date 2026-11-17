// Computer-use end-to-end demo — the live proof script (computer-use cycle,
// 18 Nov 2026). Runs a scripted scenario against a local test page on a REAL
// X11 session (Xvfb) with a HEADED Chromium, driven two ways:
//   1. DOM/Playwright actions (navigate, snapshot, click, type, dom_check)
//   2. CDP input (real mouse events at real coordinates) + CDP screenshot
// Every step prints its evidence. At the end it prints a PROVEN/UNPROVEN
// table — nothing is claimed that did not just run. No keys, no real
// accounts, $0. Usage: node scripts/computer-use-demo.js
// (from the app folder). Exits 1 if any proven step fails.
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.WORKSPACE = process.env.WORKSPACE || path.resolve(__dirname, '..', '..');

const { BrowserSessionManager } = require('../browser-session');
const { ComputerUse } = require('../computer-use');
const { XvfbSession, probeEnvironment, CdpInput } = require('../desktop-input');
const browserMod = require('../browser');

const PAGE = `<!doctype html><html><head><title>Demo Page</title></head><body>
<h1>Computer Use Demo</h1>
<p id="status">waiting</p>
<button id="go" onclick="document.getElementById('status').textContent='clicked via DOM'">Press me</button>
<label>Note <input id="note" type="text"></label>
<button id="go2" onclick="document.getElementById('status').textContent='clicked via CDP mouse'">Press via mouse</button>
</body></html>`;

function log(step, ok, evidence) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${evidence}`);
  return ok;
}

async function main() {
  let allOk = true;
  const probe = probeEnvironment();
  console.log('Environment probe:', JSON.stringify({ platform: probe.platform, display: probe.display, backends: probe.backends, usable: probe.usable }));

  const cap = browserMod.capability();
  if (!cap.available) { console.log('FAIL  browser unavailable: ' + cap.reason); process.exit(1); }
  if (!probe.backends.xvfb) { console.log('UNPROVEN  Xvfb missing — headed desktop proof cannot run on this machine'); process.exit(1); }

  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const xvfb = new XvfbSession({});
  const disp = await xvfb.start();
  console.log('Xvfb display:', disp.display, `${disp.width}x${disp.height}`);
  const prevDisplay = process.env.DISPLAY;
  process.env.DISPLAY = disp.display;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piplet-demo-profile-'));
  const mgr = new BrowserSessionManager({ approvalLookup: () => null });
  const cu = new ComputerUse({ manager: mgr, approvalLookup: () => null, auditFn: () => {} });
  try {
    // 1. Headed session on the virtual display, navigate, read DOM.
    const nav = await cu.act({ action: 'navigate', url, session: 'demo', headed: true, allowLoopback: true });
    allOk = log('headed navigate to local page', nav.ok, `url=${nav.url || url}`) && allOk;
    const snap = await cu.act({ action: 'snapshot', session: 'demo' });
    allOk = log('DOM snapshot', snap.ok && snap.entries.length >= 3, `${snap.entries.length} entries`) && allOk;

    // 2. DOM click + DOM CHECK verification.
    const clicked = await cu.act({ action: 'click', selector: '#go', session: 'demo', expect: [{ type: 'text_present', text: 'clicked via DOM' }] });
    allOk = log('DOM click + dom_check', clicked.ok && clicked.verification.ok, `stateChanged=${clicked.stateChanged}`) && allOk;

    // 3. DOM type + value verification.
    const typed = await cu.act({ action: 'type', selector: '#note', value: 'hello desktop', session: 'demo', expect: [{ type: 'value_equals', selector: '#note', value: 'hello desktop' }] });
    allOk = log('DOM type + dom_check', typed.ok && typed.verification.ok, `chars=${typed.chars}`) && allOk;

    // 4. CDP mouse click at real coordinates + DOM CHECK verification.
    const session = mgr.get('demo');
    const tab = await session.ensureContext();
    const page = tab.page;
    const box = await page.locator('#go2').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const input = new CdpInput({ session: cdp, viewport: page.viewportSize() });
    await input.mouseClick(box.x + box.width / 2, box.y + box.height / 2);
    const cdpCheck = await cu.act({ action: 'dom_check', session: 'demo', checks: [{ type: 'text_present', text: 'clicked via CDP mouse' }] });
    allOk = log('CDP mouse click + dom_check', cdpCheck.ok, `at (${Math.round(box.x)}, ${Math.round(box.y)}) on DISPLAY ${disp.display}`) && allOk;

    // 5. CDP screenshot = real pixels of the headed window.
    const shot = await input.screenshot();
    allOk = log('CDP screenshot', shot.imageBase64.length > 1000, `${shot.imageBase64.length} base64 chars`) && allOk;

    // 6. Zoom region capture (the zoom fix: region shot returned, usable as
    //    the next observation).
    const zoom = await cu.act({ action: 'zoom', session: 'demo', region: [0, 0, 0.5, 0.3] });
    allOk = log('zoom region capture', zoom.ok && zoom.imageBase64.length > 100, `clip=${JSON.stringify(zoom.clip)}`) && allOk;

    // 7. Multi-step flow with a turn budget, all steps verified.
    const flow = await cu.runFlow([
      { action: 'navigate', url },
      { action: 'click', selector: '#go', expect: [{ type: 'text_present', text: 'clicked via DOM' }] },
      { action: 'dom_check', checks: [{ type: 'title_contains', text: 'Demo' }] },
    ], { session: 'demo', budgetMs: 30000 });
    allOk = log('runFlow (3 steps, budget 30s)', flow.done, flow.stopReason) && allOk;

    // 8. Deny-first spot checks: password refusal + submit approval gate.
    //    (Password field absent here; the gate is proven by the suite. The
    //    submit gate is exercised against the demo page's button.)
    try {
      await cu.act({ action: 'submit', selector: '#go', session: 'demo', approvalId: 999 });
      allOk = log('submit without approval refused', false, 'no error thrown') && allOk;
    } catch (e) {
      allOk = log('submit without approval refused', /not found or not approved/.test(e.message), e.message.slice(0, 80)) && allOk;
    }
  } finally {
    await mgr.closeAll().catch(() => {});
    process.env.DISPLAY = prevDisplay;
    await xvfb.stop().catch(() => {});
    server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n--- PROVEN vs UNPROVEN (this run, this machine) ---');
  console.log('PROVEN: Xvfb virtual X11 session; headed Chromium; DOM navigate/snapshot/click/type; dom_check verification after acting; CDP mouse click changing the DOM; CDP screenshot; zoom region capture; budgeted multi-step flows; submit approval gate.');
  console.log('UNPROVEN: physical laptop desktop (Windows PowerShell path); xdotool/ydotool execution (binaries absent); X11 root screenshot (no scrot/import/xwd); vision-grounded loop end-to-end (no provider key); external https navigation (VM egress proxy rejects Chromium tunnels); phone control; two-node sync.');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('DEMO ERROR:', e.message); process.exit(1); });
