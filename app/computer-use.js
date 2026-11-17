// Computer use — the agent-facing facade (computer-use cycle, 18 Nov 2026).
// One tool, `computer_use`, with two families:
//   Browser family — every StatefulBrowserSession action (tabs, navigation,
//     forms, DOM/a11y reads, screenshots, zoom, dom_check, console/network
//     observation), state kept across turns by the session manager.
//   Desktop family — desktop_click / desktop_type / desktop_key /
//     desktop_screenshot via CDP input into a real X session, plus
//     desktop_probe (environment report). Starting a display server is NOT
//     a tool: Xvfb is started by the demo script / laptop setup, never by
//     the agent.
// Deny-first: freeze is checked before every action; password/credential
// fields are refused; submit/upload/download need approved approvals (the
// session enforces it); sensitive text is never typed; every action is
// audit-logged. runFlow() runs scripted multi-step flows with a turn
// budget and per-step DOM verification. runObserveLoop() is the
// vision-grounded loop with the ZOOM FIX: a zoom action's region capture
// becomes the next observation (previously the loop re-captured the full
// screen and threw the zoomed image away — the audit's "zoom wiring
// broken" finding).
'use strict';
const { audit } = require('./tools');
const { assertNotFrozen, isFrozen } = require('./freeze');
const { BrowserSessionManager, SESSION_ACTIONS } = require('./browser-session');
const { probeEnvironment, CdpInput } = require('./desktop-input');

const DESKTOP_ACTIONS = new Set(['desktop_click', 'desktop_type', 'desktop_key', 'desktop_screenshot', 'desktop_probe']);
const COMPUTER_ACTIONS = new Set([...SESSION_ACTIONS, ...DESKTOP_ACTIONS]);

function defaultApprovalLookup(id) {
  try {
    const { get } = require('./db');
    return get('SELECT status FROM approvals WHERE id = ?', Number(id)) || null;
  } catch {
    return null;
  }
}

function validateDesktopAction(a) {
  if (a.action === 'desktop_click') {
    if (typeof a.x !== 'number' || typeof a.y !== 'number' || a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1) {
      throw new Error('desktop_click needs normalised x and y in 0..1');
    }
    return { action: a.action, x: a.x, y: a.y };
  }
  if (a.action === 'desktop_type') {
    if (typeof a.text !== 'string' || !a.text || a.text.length > 4000) throw new Error('desktop_type needs text, 1..4000 chars');
    if (a.sensitive) throw new Error('denied: sensitive text (credentials, OTPs) is never typed');
    return { action: a.action, text: a.text };
  }
  if (a.action === 'desktop_key') {
    if (typeof a.key !== 'string' || !/^[A-Za-z0-9_+\-]{1,30}$/.test(a.key)) throw new Error('desktop_key must be a short key name (e.g. Enter, Tab, Escape)');
    return { action: a.action, key: a.key };
  }
  return { action: a.action };
}

class ComputerUse {
  constructor({ manager, approvalLookup, auditFn } = {}) {
    this.manager = manager || new BrowserSessionManager({ approvalLookup: approvalLookup || defaultApprovalLookup });
    this.approvalLookup = approvalLookup || defaultApprovalLookup;
    this.auditFn = auditFn || audit;
    this.cdpInputs = new Map(); // session id -> CdpInput (created lazily)
  }

  async _cdpInput(sessionId) {
    if (this.cdpInputs.has(sessionId)) return this.cdpInputs.get(sessionId);
    const session = this.manager.get(sessionId);
    const tab = await session.ensureContext();
    const page = tab.page;
    if (!page || typeof page.context !== 'function') throw new Error('desktop input needs a real browser page — the injected driver cannot provide a CDP session');
    const context = page.context();
    if (!context || typeof context.newCDPSession !== 'function') throw new Error('this browser context cannot provide a CDP session');
    const cdp = await context.newCDPSession(page);
    const viewport = typeof page.viewportSize === 'function' ? (page.viewportSize() || { width: 1280, height: 800 }) : { width: 1280, height: 800 };
    const input = new CdpInput({ session: cdp, viewport });
    this.cdpInputs.set(sessionId, input);
    return input;
  }

  async act(args = {}) {
    assertNotFrozen();
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('computer_use needs an action object');
    if (!COMPUTER_ACTIONS.has(args.action)) throw new Error(`unknown computer_use action: ${String(args.action)}`);
    const sessionId = args.session === undefined ? 'default' : args.session;
    let result;
    if (DESKTOP_ACTIONS.has(args.action)) {
      const a = validateDesktopAction(args);
      if (a.action === 'desktop_probe') {
        result = { ok: true, ...probeEnvironment() };
      } else {
        const input = await this._cdpInput(sessionId);
        if (a.action === 'desktop_click') {
          const { x, y } = input.toPixels(a.x, a.y);
          result = await input.mouseClick(x, y);
        } else if (a.action === 'desktop_type') {
          result = await input.typeText(a.text);
        } else if (a.action === 'desktop_key') {
          result = await input.keyPress(a.key);
        } else if (a.action === 'desktop_screenshot') {
          result = await input.screenshot();
        }
      }
      this.auditFn('computer.' + a.action, { session: sessionId }, true, `desktop ${a.action} ok`);
      return { ok: true, session: sessionId, ...result };
    }
    // Browser family — the session validates, enforces approvals, verifies,
    // and audit-logs; the facade adds the tool-level record.
    const session = this.manager.get(sessionId, { allowLoopback: !!args.allowLoopback, headed: !!args.headed });
    result = await session.act({ ...args, session: undefined });
    this.auditFn('computer.' + args.action, { session: sessionId, action: args.action }, result.ok !== false, `computer_use ${args.action} ok=${result.ok !== false}`);
    return { ok: result.ok !== false, session: sessionId, ...result };
  }

  // Scripted multi-step flow: explicit steps, each verified by DOM check
  // after acting. Stops on the first failed step. Budget is a hard
  // deadline — a step that would start after it is never started, and the
  // flow reports budget_exceeded with the steps completed so far.
  async runFlow(steps, opts = {}) {
    const budgetMs = Number(opts.budgetMs || 60000);
    const clock = opts.clock || Date.now;
    const deadline = clock() + budgetMs;
    const sessionId = opts.session === undefined ? 'default' : opts.session;
    const results = [];
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 50) throw new Error('runFlow needs 1..50 steps');
    for (let i = 0; i < steps.length; i++) {
      assertNotFrozen();
      if (clock() > deadline) {
        return { done: false, stopReason: 'budget_exceeded', steps: results, elapsedMs: clock() - (deadline - budgetMs) };
      }
      const t0 = clock();
      const step = steps[i];
      let out;
      try {
        out = await this.act({ ...step, session: sessionId });
      } catch (e) {
        results.push({ step: i, action: step.action, ok: false, error: String(e.message).slice(0, 300), ms: clock() - t0 });
        return { done: false, stopReason: `step ${i} (${step.action}) threw`, steps: results, elapsedMs: clock() - (deadline - budgetMs) };
      }
      results.push({ step: i, action: step.action, ok: out.ok !== false, ms: clock() - t0, verification: out.verification || null, stateChanged: out.stateChanged });
      if (out.ok === false) {
        return { done: false, stopReason: `step ${i} (${step.action}) failed verification`, steps: results, elapsedMs: clock() - (deadline - budgetMs) };
      }
      if (isFrozen()) return { done: false, stopReason: 'frozen mid-flow', steps: results, elapsedMs: clock() - (deadline - budgetMs) };
    }
    return { done: true, stopReason: 'all steps passed verification', steps: results, elapsedMs: clock() - (deadline - budgetMs) };
  }

  async closeSession(sessionId) {
    this.cdpInputs.delete(sessionId);
    return this.manager.close(sessionId);
  }

  async closeAll() {
    this.cdpInputs.clear();
    return this.manager.closeAll();
  }

  status() {
    return {
      browser: (() => { try { return require('./browser').capability(); } catch { return { available: false }; } })(),
      desktop: probeEnvironment(),
      sessions: this.manager.list(),
    };
  }
}

// Vision-grounded observe → act → verify loop. deps:
//   capture: () => { buffer, hash } — full-screen observation
//   ground: (task, imageBase64, { zoomed }) => grounded action object
//   act: (validatedAction) => result (zoom returns { imageBase64 } region shot)
//   verify: optional (action, result) => { ok, evidence }
// The zoom fix: when the grounded action is zoom, the region capture
// returned by act() becomes the NEXT observation instead of a fresh
// full-screen capture — the model actually sees what it zoomed into.
// Budget + unchanged-screen stop + freeze checks mirror desktop.screenLoop.
async function runObserveLoop(task, deps, opts = {}) {
  const maxActions = Number(opts.maxActions || 20);
  const budgetMs = Number(opts.budgetMs || 120000);
  const clock = opts.clock || Date.now;
  const deadline = clock() + budgetMs;
  const steps = [];
  const latencies = [];
  let lastHash = null;
  let unchanged = 0;
  let pendingObservation = null; // { buffer, hash, zoomed } from a zoom step
  let actions = 0;

  for (let step = 0; step < maxActions; step++) {
    const t0 = clock();
    assertNotFrozen();
    if (clock() > deadline) return { done: false, stopReason: 'budget_exceeded', steps, latencies, lastHash };
    let shot;
    if (pendingObservation) {
      shot = pendingObservation;
      pendingObservation = null;
    } else {
      shot = await deps.capture();
    }
    const tCapture = clock();
    if (shot.hash === lastHash) unchanged++;
    else { lastHash = shot.hash; unchanged = 0; }
    if (unchanged >= 2 && !shot.zoomed) {
      return { done: false, stopReason: 'screen unchanged twice — stopped', steps, latencies, lastHash };
    }
    const grounded = await deps.ground(task, shot.buffer.toString('base64'), { zoomed: !!shot.zoomed });
    const tGround = clock();
    if (grounded.action === 'done') {
      steps.push({ step, action: 'done', description: grounded.description || '' });
      latencies.push({ step, captureMs: tCapture - t0, groundMs: tGround - tCapture, actMs: 0 });
      return { done: true, stopReason: 'task visibly complete', steps, latencies, lastHash };
    }
    if (grounded.action === 'cannot_see') {
      return { done: false, stopReason: 'target not visible on screen', steps, latencies, lastHash };
    }
    const result = await deps.act(grounded);
    const tAct = clock();
    actions++;
    let verification = null;
    if (deps.verify) {
      try { verification = await deps.verify(grounded, result); } catch (e) { verification = { ok: false, evidence: String(e.message).slice(0, 200) }; }
    }
    steps.push({ step, action: grounded.action, description: grounded.description || '', ok: result?.ok !== false, verification });
    latencies.push({ step, captureMs: tCapture - t0, groundMs: tGround - tCapture, actMs: tAct - tGround });
    // ZOOM FIX: the region shot is the next observation.
    if (grounded.action === 'zoom' && result && result.imageBase64) {
      const buf = Buffer.from(result.imageBase64, 'base64');
      const crypto = require('crypto');
      pendingObservation = { buffer: buf, hash: crypto.createHash('sha256').update(buf).digest('hex'), zoomed: true };
    }
    if (verification && verification.ok === false) {
      return { done: false, stopReason: `step ${step} failed verification`, steps, latencies, lastHash };
    }
    if (isFrozen()) return { done: false, stopReason: 'frozen mid-task', steps, latencies, lastHash };
  }
  return { done: false, stopReason: `action cap reached (${maxActions})`, steps, latencies, lastHash };
}

let singleton = null;
function getComputerUse() {
  if (!singleton) singleton = new ComputerUse({});
  return singleton;
}
function resetComputerUse() { singleton = null; }

module.exports = { ComputerUse, runObserveLoop, getComputerUse, resetComputerUse, COMPUTER_ACTIONS, DESKTOP_ACTIONS, defaultApprovalLookup };
