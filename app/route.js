// Fast routing — deterministic, rule-based model routing (differentiator,
// narrow by design).
//
// The router NEVER uses an LLM to decide: it classifies the prompt by
// cheap, inspectable rules (length, keywords, code blocks, multi-step
// language). Routine text steps (short status/read/summary questions) may
// go to the local model first; anything that looks like planning,
// building, debugging, design, comparison, research, or screen/browser
// work goes straight to the full provider chain. Vision grounding and
// multi-step planning are NEVER routed to the small local model — the
// evidence says small models fail structured tool use (see docs/TOOLS.md
// and SYSTEM-DESIGN.md), so the router is deliberately conservative.
//
// OFF by default (FAST_ROUTING=1 to enable, via Settings). The VM's
// qwen3:0.6b is too weak to be a router target; the laptop's qwen3:8b is
// the intended local target. Every routed turn records its route, model,
// and latency in the job evidence, so the routing decision is auditable.
// On any local failure the turn falls back to the full chain — routing
// can only speed a turn up, never break it.
'use strict';

const HARD_MARKERS = [
  /```/, // code blocks = build/debug work
  /\b(build|debug|design|compare|plan|refactor|research|implement|fix|rewrite|analyse|analyze|review|architect|migrate|optimise|optimize)\b/i,
  /\b(screen|click|desktop|browser|automate|tap|swipe|open app|window)\b/i, // device control
  /\b(then|after that|and then|first .* then|step by step)\b/i, // multi-step
  /\b(delete|remove|send|post|publish|spend|pay|buy)\b/i, // irreversible — full chain + approvals
];

const ROUTINE_MARKERS = [
  /^(what|show|list|read|check|remind|note|status|how many|when|is|are|did|can you show|give me)\b/i,
  /^(summarise|summarize|translate|draft|explain)\b/i,
  /\b(weather|time|date|status|unread|queue|routine)\b/i,
];

function classify(text) {
  const t = String(text || '');
  if (t.length > 140) return { route: 'hard', reason: 'prompt longer than 140 chars' };
  for (const re of HARD_MARKERS) {
    if (re.test(t)) return { route: 'hard', reason: `hard marker: ${re.source.slice(0, 40)}` };
  }
  for (const re of ROUTINE_MARKERS) {
    if (re.test(t)) return { route: 'routine', reason: `routine marker: ${re.source.slice(0, 40)}` };
  }
  // Short, plain, no markers: routine by default (cheap, and the fallback
  // covers a misclassification — the local model just answers, and any
  // failure re-runs on the full chain).
  return { route: 'routine', reason: 'short plain prompt, no hard markers' };
}

function routingEnabled() {
  return process.env.FAST_ROUTING === '1';
}

// Routed ask. `brain` is the brain module (ask/askWith). Returns the ask
// result plus route + latency. Falls back to the full chain on any local
// failure when the route was routine.
// H-14 fix (audit 18 Nov 2026): classification must run on the RAW user
// text, not the wrapped prompt — the wrapper (tool list + memory +
// skills) is always >2 KB, so the ">140 chars → hard" rule fired on
// every turn and the routine route could never engage. Callers pass
// `classifyText` (the user's own words); without it, the prompt itself
// is classified, as before.
async function routedAsk(prompt, { brain = require('./brain'), clock = Date.now, classifyText } = {}) {
  const t0 = clock();
  const c = classify(classifyText !== undefined ? classifyText : prompt);
  if (!routingEnabled() || c.route !== 'routine') {
    const r = await brain.ask(prompt);
    return { ...r, route: routingEnabled() ? 'hard' : 'default', routeReason: routingEnabled() ? c.reason : 'fast routing off', ms: clock() - t0, fellBack: false };
  }
  // Routine route: local model first (ollama), one attempt, then the full
  // chain. The local attempt is bounded by the provider's own timeouts.
  try {
    const r = await brain.askWith(prompt, ['ollama']);
    return { ...r, route: 'routine', routeReason: c.reason, ms: clock() - t0, fellBack: false };
  } catch (e) {
    const r = await brain.ask(prompt);
    return { ...r, route: 'routine', routeReason: c.reason, ms: clock() - t0, fellBack: true, fallbackError: String(e.message).slice(0, 200) };
  }
}

module.exports = { classify, routedAsk, routingEnabled, HARD_MARKERS, ROUTINE_MARKERS };
