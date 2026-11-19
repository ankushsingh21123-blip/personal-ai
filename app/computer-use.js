// Computer use — the agent-facing facade (computer-use cycle, 18 Nov 2026;
// v2, 19 Nov 2026: vision-grounded clicks, self-healing retries, flow
// latency timings, snapshot geometry + caching, one fewer redundant DOM
// read per verified action).
// One tool, `computer_use`, with three families:
//   Browser family — every StatefulBrowserSession action (tabs, navigation,
//     forms, DOM/a11y reads, screenshots, zoom, dom_check, console/network
//     observation), state kept across turns by the session manager.
//   Desktop family — desktop_click / desktop_type / desktop_key /
//     desktop_screenshot via CDP input into a real X session, plus
//     desktop_probe (environment report). Starting a display server is NOT
//     a tool: Xvfb is started by the demo script / laptop setup, never by
//     the agent.
//   Grounded family — grounded_click: screenshot -> ground the task to
//     screen coordinates (vision provider when a key exists, DOM geometry
//     otherwise — the result always says which) -> real CDP mouse click
//     at those coordinates -> dom_check verification.
// Deny-first: freeze is checked before every action; password/credential
// fields are refused; submit/upload/download need approved approvals (the
// session enforces it); sensitive text is never typed; every action is
// audit-logged. runFlow() runs scripted multi-step flows with a turn
// budget and per-step DOM verification, plus an opt-in selfHeal mode:
// a failed step is re-attempted once with a different targeting strategy
// found in a fresh snapshot. runObserveLoop() is the
// vision-grounded loop with the ZOOM FIX: a zoom action's region capture
// becomes the next observation (previously the loop re-captured the full
// screen and threw the zoomed image away — the audit's "zoom wiring
// broken" finding).
'use strict';
const { audit } = require('./tools');
const { assertNotFrozen, isFrozen } = require('./freeze');
const { BrowserSessionManager, SESSION_ACTIONS } = require('./browser-session');
const { probeEnvironment, CdpInput } = require('./desktop-input');
const { groundWithFallback } = require('./grounding');

const DESKTOP_ACTIONS = new Set(['desktop_click', 'desktop_type', 'desktop_key', 'desktop_screenshot', 'desktop_probe']);
// Facade-only actions: implemented in ComputerUse, not in the session.
const FACADE_ACTIONS = new Set(['grounded_click']);
const COMPUTER_ACTIONS = new Set([...SESSION_ACTIONS, ...DESKTOP_ACTIONS, ...FACADE_ACTIONS]);

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
    if (args.action === 'grounded_click') {
      if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 500) {
        throw new Error('grounded_click needs task, 1..500 chars — plain words for the element to click');
      }
      result = await this.groundedClick(args.task, {
        session: sessionId, allowLoopback: !!args.allowLoopback, headed: !!args.headed,
        preferDom: !!args.preferDom, only: args.only, expect: args.expect,
      });
      this.auditFn('computer.grounded_click', { session: sessionId, grounder: result.grounder }, result.ok !== false, `grounded_click ok=${result.ok !== false} via ${result.grounder}`);
      return { ok: result.ok !== false, session: sessionId, ...result };
    }
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

  // --- self-healing ---------------------------------------------------------
  // One step, one retry, with a DIFFERENT targeting strategy. A failed
  // click/type/select/check/submit is re-attempted after a fresh snapshot,
  // locating the same element by another route (snapshot selector, role+name,
  // visible text). Exactly one retry — then it fails honestly with the
  // evidence from both attempts. Approval gates and password refusal live
  // in act(), so the retry re-checks them; a denied action stays denied.
  static describeTarget(step) {
    if (step.index !== undefined) return `snapshot index ${step.index}`;
    if (step.selector !== undefined) return `selector "${String(step.selector).slice(0, 80)}"`;
    if (step.role !== undefined) return `role ${step.role} "${String(step.name || '').slice(0, 80)}"`;
    if (step.text !== undefined) return `text "${String(step.text).slice(0, 80)}"`;
    return step.action;
  }

  static alternatesFor(step, entries) {
    if (!Array.isArray(entries) || !entries.length) return [];
    if (!['click', 'type', 'select', 'check', 'submit'].includes(step.action)) return [];
    let entry = null;
    if (step.index !== undefined) entry = entries[step.index] || null;
    else if (step.selector !== undefined) entry = entries.find((e) => e.selector === step.selector) || null;
    else if (step.role !== undefined) entry = entries.find((e) => e.role === step.role && e.name === step.name) || null;
    else if (step.text !== undefined) entry = entries.find((e) => e.name && (e.name.includes(step.text) || step.text.includes(e.name))) || null;
    if (!entry) return [];
    const out = [];
    if (step.selector === undefined && entry.selector) out.push({ selector: entry.selector });
    if (step.role === undefined && entry.role && /^[a-z]+$/.test(entry.role) && entry.name) {
      out.push({ role: entry.role, name: entry.name });
    }
    if (step.text === undefined && entry.name) out.push({ text: entry.name });
    return out;
  }

  async actSelfHealing(step, opts = {}, first = null) {
    assertNotFrozen();
    const sessionId = opts.session === undefined ? 'default' : opts.session;
    const attempts = [];
    const stripTarget = (s) => {
      const c = { ...s };
      delete c.index; delete c.selector; delete c.role; delete c.name; delete c.text;
      return c;
    };
    // Attempt 1 — as written, unless the caller already ran it and is
    // handing us its failure (runFlow does, so the failed action is not
    // run twice for the same evidence).
    if (first) {
      attempts.push({ attempt: 1, strategy: ComputerUse.describeTarget(step), ok: first.ok === true, verification: first.verification || null, error: first.error || null, ms: first.ms ?? null });
      if (first.ok === true) return { ok: true, healed: false, attempts, ...first };
    } else {
      try {
        const r = await this.act({ ...step, session: sessionId });
        attempts.push({ attempt: 1, strategy: ComputerUse.describeTarget(step), ok: r.ok !== false, verification: r.verification || null, ms: r.ms ?? null });
        if (r.ok !== false) return { ok: true, healed: false, attempts, ...r };
      } catch (e) {
        attempts.push({ attempt: 1, strategy: ComputerUse.describeTarget(step), ok: false, error: String(e.message).slice(0, 300) });
      }
    }
    // Re-snapshot, then retry once with a different strategy.
    let snap;
    try {
      snap = await this.act({ action: 'snapshot', session: sessionId });
    } catch (e) {
      return { ok: false, healed: false, attempts, error: `re-snapshot failed, cannot heal: ${String(e.message).slice(0, 200)}` };
    }
    const alternates = ComputerUse.alternatesFor(step, snap.entries || []);
    if (!alternates.length) {
      return { ok: false, healed: false, attempts, error: 'no alternate targeting strategy found in the fresh snapshot' };
    }
    const alt = alternates[0];
    const retryStep = { ...stripTarget(step), ...alt };
    try {
      const r2 = await this.act({ ...retryStep, session: sessionId });
      attempts.push({ attempt: 2, strategy: ComputerUse.describeTarget(alt), ok: r2.ok !== false, verification: r2.verification || null, ms: r2.ms ?? null });
      if (r2.ok !== false) return { ok: true, healed: true, attempts, ...r2 };
      return { ok: false, healed: false, attempts, error: 'retry failed verification', verification: r2.verification || null };
    } catch (e) {
      attempts.push({ attempt: 2, strategy: ComputerUse.describeTarget(alt), ok: false, error: String(e.message).slice(0, 300) });
      return { ok: false, healed: false, attempts, error: String(e.message).slice(0, 300) };
    }
  }

  // --- vision-grounded click --------------------------------------------------
  // Screenshot -> ground the task to normalised coordinates -> real CDP
  // mouse click at those coordinates -> dom_check verification. The
  // grounder is labelled in the result (vision-provider or dom-geometry),
  // so a DOM-grounded click is never presented as model vision.
  async groundedClick(task, opts = {}) {
    assertNotFrozen();
    const sessionId = opts.session === undefined ? 'default' : opts.session;
    const t0 = Date.now();
    const session = this.manager.get(sessionId, { allowLoopback: !!opts.allowLoopback, headed: !!opts.headed });
    const snap = await session.act({ action: 'snapshot' });
    if (!snap.ok) throw new Error('grounded_click needs a snapshot first');
    const shot = await session.act({ action: 'screenshot' });
    if (!shot.ok || !shot.imageBase64) throw new Error('grounded_click needs a screenshot first');
    const grounded = await groundWithFallback(task, shot.imageBase64, {
      snapshotEntries: snap.entries || [], preferDom: !!opts.preferDom, only: opts.only,
    });
    const input = await this._cdpInput(sessionId);
    const { x, y } = input.toPixels(grounded.x, grounded.y);
    const click = await input.mouseClick(x, y);
    let verification = null;
    if (opts.expect) {
      verification = await session.act({ action: 'dom_check', checks: opts.expect });
    }
    const ok = click.ok !== false && (!verification || verification.ok !== false);
    return {
      ok, grounder: grounded.grounder, provider: grounded.provider || null, model: grounded.model || null,
      x: grounded.x, y: grounded.y, confidence: grounded.confidence, description: grounded.description,
      matched: grounded.matched || null, verification, ms: Date.now() - t0,
    };
  }

  // Scripted multi-step flow: explicit steps, each verified by DOM check
  // after acting. Stops on the first failed step. Budget is a hard
  // deadline — a step that would start after it is never started, and the
  // flow reports budget_exceeded with the steps completed so far.
  // opts.selfHeal: on a failed step, retry it once via actSelfHealing
  // before giving up. Every result carries timings: { totalMs, slowestMs,
  // slowestStep, stepsMs } so turn latency is measured, not guessed.
  async runFlow(steps, opts = {}) {
    const budgetMs = Number(opts.budgetMs || 60000);
    const clock = opts.clock || Date.now;
    const deadline = clock() + budgetMs;
    const sessionId = opts.session === undefined ? 'default' : opts.session;
    const selfHeal = !!opts.selfHeal;
    const results = [];
    const timings = () => {
      const msList = results.map((r) => r.ms || 0);
      const totalMs = msList.reduce((a, b) => a + b, 0);
      const slowestMs = msList.length ? Math.max(...msList) : 0;
      return { totalMs, slowestMs, slowestStep: msList.indexOf(slowestMs), stepsMs: msList };
    };
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 50) throw new Error('runFlow needs 1..50 steps');
    for (let i = 0; i < steps.length; i++) {
      assertNotFrozen();
      if (clock() > deadline) {
        return { done: false, stopReason: 'budget_exceeded', steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
      }
      const t0 = clock();
      const step = steps[i];
      let out;
      try {
        out = await this.act({ ...step, session: sessionId });
      } catch (e) {
        if (selfHeal) {
          const healed = await this.actSelfHealing(step, { session: sessionId }, { ok: false, error: String(e.message).slice(0, 300), ms: clock() - t0 });
          results.push({ step: i, action: step.action, ok: healed.ok, healed: healed.healed, attempts: healed.attempts, ms: clock() - t0, error: healed.error || null });
          if (healed.ok) {
            if (isFrozen()) return { done: false, stopReason: 'frozen mid-flow', steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
            continue;
          }
          return { done: false, stopReason: `step ${i} (${step.action}) threw and self-heal failed`, steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
        }
        results.push({ step: i, action: step.action, ok: false, error: String(e.message).slice(0, 300), ms: clock() - t0 });
        return { done: false, stopReason: `step ${i} (${step.action}) threw`, steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
      }
      if (out.ok === false && selfHeal) {
        const healed = await this.actSelfHealing(step, { session: sessionId }, { ok: false, verification: out.verification || null, ms: clock() - t0 });
        results.push({ step: i, action: step.action, ok: healed.ok, healed: healed.healed, attempts: healed.attempts, ms: clock() - t0, verification: healed.verification || out.verification || null });
        if (!healed.ok) {
          return { done: false, stopReason: `step ${i} (${step.action}) failed verification and self-heal failed`, steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
        }
      } else {
        results.push({ step: i, action: step.action, ok: out.ok !== false, healed: false, ms: clock() - t0, verification: out.verification || null, stateChanged: out.stateChanged });
        if (out.ok === false) {
          return { done: false, stopReason: `step ${i} (${step.action}) failed verification`, steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
        }
      }
      if (isFrozen()) return { done: false, stopReason: 'frozen mid-flow', steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
    }
    return { done: true, stopReason: 'all steps passed verification', steps: results, timings: timings(), elapsedMs: clock() - (deadline - budgetMs) };
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
  // v2: latency summary so turn cost is measured, not guessed.
  const latencySummary = () => {
    const n = latencies.length || 1;
    const sum = (k) => latencies.reduce((a, l) => a + (l[k] || 0), 0);
    return {
      steps: latencies.length,
      avgCaptureMs: Math.round(sum('captureMs') / n),
      avgGroundMs: Math.round(sum('groundMs') / n),
      avgActMs: Math.round(sum('actMs') / n),
      totalMs: sum('captureMs') + sum('groundMs') + sum('actMs'),
    };
  };
  let lastHash = null;
  let unchanged = 0;
  let pendingObservation = null; // { buffer, hash, zoomed } from a zoom step
  let actions = 0;

  for (let step = 0; step < maxActions; step++) {
    const t0 = clock();
    assertNotFrozen();
    if (clock() > deadline) return { done: false, stopReason: 'budget_exceeded', steps, latencies, latencySummary: latencySummary(), lastHash };
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
      return { done: false, stopReason: 'screen unchanged twice — stopped', steps, latencies, latencySummary: latencySummary(), lastHash };
    }
    const grounded = await deps.ground(task, shot.buffer.toString('base64'), { zoomed: !!shot.zoomed });
    const tGround = clock();
    if (grounded.action === 'done') {
      steps.push({ step, action: 'done', description: grounded.description || '' });
      latencies.push({ step, captureMs: tCapture - t0, groundMs: tGround - tCapture, actMs: 0 });
      return { done: true, stopReason: 'task visibly complete', steps, latencies, latencySummary: latencySummary(), lastHash };
    }
    if (grounded.action === 'cannot_see') {
      return { done: false, stopReason: 'target not visible on screen', steps, latencies, latencySummary: latencySummary(), lastHash };
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
      return { done: false, stopReason: `step ${step} failed verification`, steps, latencies, latencySummary: latencySummary(), lastHash };
    }
    if (isFrozen()) return { done: false, stopReason: 'frozen mid-task', steps, latencies, latencySummary: latencySummary(), lastHash };
  }
  return { done: false, stopReason: `action cap reached (${maxActions})`, steps, latencies, latencySummary: latencySummary(), lastHash };
}

let singleton = null;
function getComputerUse() {
  if (!singleton) singleton = new ComputerUse({});
  return singleton;
}
function resetComputerUse() { singleton = null; }

module.exports = { ComputerUse, runObserveLoop, getComputerUse, resetComputerUse, COMPUTER_ACTIONS, DESKTOP_ACTIONS, FACADE_ACTIONS, defaultApprovalLookup };
