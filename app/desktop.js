// Desktop control — Codex-style computer use on the user's own desktop
// (Phase B). Two halves:
//   1. validateAction() — the single gate for every screen action. Only
//      allowlisted actions, bounded coordinates/text, and no destructive
//      act without an approved approval record.
//   2. screenLoop() — observe → decide → act → re-observe, with a per-task
//      action cap, a stop rule (screen unchanged twice in a row), freeze
//      checks before every action, and per-step latency measurement.
// Actuation happens in the desktop agent (desktop-agent.js), a separate
// process the user installs on the laptop. This module talks to it over
// loopback HTTP with the same token auth as the app. On this VM there is
// no desktop agent and no desktop — capability() says so, and the loop is
// unit-tested with injected capture/ground/act functions.
// Safety (spec §2.5/§2.6, non-negotiable): no credential/OTP/admin
// automation — the loop never sends credential text and refuses actions
// flagged sensitive; destructive actions need an approval; every action is
// audit-logged with the screenshot hash + the intended target.
'use strict';
const { audit } = require('./tools');
const { assertNotFrozen, isFrozen } = require('./freeze');
const { get } = require('./db');

const MAX_ACTIONS = 20;
const MAX_UNCHANGED = 2;

const SCREEN_ACTIONS = new Set(['click', 'type', 'scroll', 'key', 'screenshot', 'wait']);

// Validate a screen action before anything executes. Throws on anything
// outside the allowlist. `approvalId` is required when destructive=true —
// and the approval must exist and be status 'approved'.
function validateAction(action, opts = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('action must be an object');
  if (!SCREEN_ACTIONS.has(action.action)) throw new Error(`unknown screen action: ${String(action.action)}`);
  if (action.sensitive) throw new Error('denied: sensitive actions (credentials, OTPs, admin prompts) are never automated');
  if (action.destructive) {
    const id = Number(opts.approvalId);
    if (!Number.isInteger(id) || id < 1) throw new Error('denied: destructive screen action needs an approved approval id');
    const row = get('SELECT status FROM approvals WHERE id = ?', id);
    if (!row || row.status !== 'approved') throw new Error('denied: approval not found or not approved — destructive screen action refused');
  }
  const out = { action: action.action, destructive: !!action.destructive };
  if (action.action === 'click') {
    if (typeof action.x !== 'number' || typeof action.y !== 'number' || action.x < 0 || action.x > 1 || action.y < 0 || action.y > 1) {
      throw new Error('click needs normalised x and y in 0..1');
    }
    out.x = action.x; out.y = action.y;
  }
  if (action.action === 'type') {
    if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 4000) throw new Error('type needs text, 1..4000 chars');
    out.text = action.text;
  }
  if (action.action === 'scroll') {
    const amount = action.amount === undefined ? 3 : action.amount;
    if (!Number.isInteger(amount) || Math.abs(amount) > 20) throw new Error('scroll amount must be an integer -20..20');
    out.amount = amount;
  }
  if (action.action === 'key') {
    if (typeof action.key !== 'string' || !/^[A-Za-z0-9_+\-]{1,30}$/.test(action.key)) throw new Error('key must be a short key name (e.g. Enter, Tab, Escape)');
    out.key = action.key;
  }
  if (action.action === 'wait') {
    const ms = action.ms === undefined ? 1000 : action.ms;
    if (!Number.isInteger(ms) || ms < 0 || ms > 30000) throw new Error('wait ms must be an integer 0..30000');
    out.ms = ms;
  }
  if (typeof action.description === 'string') out.description = action.description.slice(0, 300);
  return out;
}

// Client for the laptop desktop agent. fetchImpl is injectable (tests).
class DesktopAgentClient {
  constructor({ baseUrl, token, fetchImpl }) {
    this.baseUrl = (baseUrl || `http://127.0.0.1:${process.env.DESKTOP_AGENT_PORT || 3101}`).replace(/\/$/, '');
    this.token = token || process.env.ANKU_TOKEN || '';
    this.fetch = fetchImpl || fetch;
  }

  async status() {
    try {
      const r = await this.fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }

  // Send one validated action to the desktop agent. Validation happens here
  // AND in the agent — defence in depth, same as tools.execute.
  async act(action, opts = {}) {
    const validated = validateAction(action, opts);
    const r = await this.fetch(`${this.baseUrl}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anku-Token': this.token },
      body: JSON.stringify(validated),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `desktop agent HTTP ${r.status}`);
    return j;
  }

  async screenshot() {
    const r = await this.fetch(`${this.baseUrl}/screenshot`, {
      headers: { 'X-Anku-Token': this.token },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`desktop agent screenshot HTTP ${r.status}`);
    const j = await r.json();
    if (!j.imageBase64) throw new Error('desktop agent returned no image');
    return j;
  }
}

function capability() {
  // The desktop agent is a laptop-side process; on this VM it is not
  // running. The caller checks status() live — this reports the static
  // facts only.
  return {
    available: process.platform === 'win32' || !!process.env.DESKTOP_AGENT_URL,
    platform: process.platform,
    agentUrl: process.env.DESKTOP_AGENT_URL || `http://127.0.0.1:${process.env.DESKTOP_AGENT_PORT || 3101}`,
    reason: process.platform === 'win32'
      ? null
      : 'desktop control runs on the Windows laptop via desktop-agent.js — not available on this VM',
  };
}

// The observe → decide → act → re-observe loop.
// deps: { capture: () => {buffer, hash, ...}, ground: (task, imageBase64) => grounded action,
//         act: (action) => result, audit?: fn, clock?: () => ms }
// Speed design (spec §2.1): the loop measures each step's latency and
// returns it — "fastest action loop" is measured, never claimed. Routine
// steps use short prompts and cached screen state (the unchanged rule
// avoids re-grounding a static screen); the frontier model is only the
// `ground` function, called once per observation.
async function screenLoop(task, deps, opts = {}) {
  const maxActions = Number(opts.maxActions || MAX_ACTIONS);
  const clock = deps.clock || Date.now;
  const steps = [];
  const latencies = [];
  let lastHash = null;
  let unchanged = 0;
  let actions = 0;

  for (let step = 0; step < maxActions; step++) {
    const t0 = clock();
    assertNotFrozen();
    const shot = await deps.capture();
    const tCapture = clock();
    if (shot.hash === lastHash) unchanged++;
    else { lastHash = shot.hash; unchanged = 0; }
    if (unchanged >= MAX_UNCHANGED) {
      return { done: false, stopReason: 'screen unchanged twice — stopped, showing last screenshot', steps, latencies, lastHash };
    }
    const grounded = await deps.ground(task, shot.buffer.toString('base64'));
    const tGround = clock();
    if (grounded.action === 'done') {
      steps.push({ step, action: 'done', description: grounded.description || '' });
      latencies.push({ step, captureMs: tCapture - t0, groundMs: tGround - tCapture, actMs: 0 });
      return { done: true, stopReason: 'task visibly complete', steps, latencies, lastHash };
    }
    if (grounded.action === 'cannot_see') {
      return { done: false, stopReason: 'target not visible on screen', steps, latencies, lastHash };
    }
    const validated = validateAction(grounded, { approvalId: opts.approvalId });
    const result = await deps.act(validated);
    const tAct = clock();
    actions++;
    steps.push({ step, action: validated.action, description: validated.description || grounded.description || '', result: result?.ok !== false });
    latencies.push({ step, captureMs: tCapture - t0, groundMs: tGround - tCapture, actMs: tAct - tGround });
    (deps.audit || audit)('screen.' + validated.action,
      { task: String(task).slice(0, 200), target: validated.description || '', x: validated.x, y: validated.y },
      true, `shot ${String(shot.hash).slice(0, 12)} action ${actions}/${maxActions}`);
    if (isFrozen()) return { done: false, stopReason: 'frozen mid-task', steps, latencies, lastHash };
  }
  return { done: false, stopReason: `action cap reached (${maxActions})`, steps, latencies, lastHash };
}

module.exports = { validateAction, DesktopAgentClient, capability, screenLoop, MAX_ACTIONS, MAX_UNCHANGED, SCREEN_ACTIONS };
