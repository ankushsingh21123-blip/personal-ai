// Visual grounding — locate a screen element and return normalised
// coordinates to click (computer-use-v2, 19 Nov 2026).
//
// Two grounding paths, and the result ALWAYS says which one was used —
// never claim model vision when the coordinates came from the DOM:
//   1. vision-provider — groundAction() in vision.js asks a vision-capable
//      provider (Gemini/OpenAI/Anthropic/Ollama-vision) to ground the task
//      from a screenshot. Needs a provider key or OLLAMA_VISION_MODEL.
//      On this VM no such key exists, so this path is UNPROVEN live here.
//   2. dom-geometry — groundFromSnapshot(): the page's own snapshot
//      (browser-session.js, entries carry real getBoundingClientRect
//      geometry + centre in normalised 0..1) is matched against the task
//      text by role/name/text. Coordinates come from the RENDERED page, so
//      the actuator clicks at real pixels — this is the path proven live
//      by the v2 demo (screenshot -> ground -> CDP mouse click at the
//      grounded coordinates -> dom_check verification).
// Matching is scored, never guessed: exact name > name substring >
// role+name > visible-text substring. A target with no match throws
// (the caller reports cannot_see) instead of clicking a wrong element.
// Coordinates are always clamped to 0..1 and checked against the matched
// element's own rectangle, so a grounding result can never point at an
// element it did not match.
'use strict';
const { groundAction } = require('./vision');

function clamp01(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

// Score one snapshot entry against a task. Returns -1 for no match.
function scoreEntry(entry, taskLower) {
  if (!entry || typeof entry !== 'object') return -1;
  const name = String(entry.name || '').toLowerCase();
  const role = String(entry.role || '').toLowerCase();
  const selector = String(entry.selector || '').toLowerCase();
  if (!name && !role) return -1;
  // Exact name match (e.g. task "click the button labelled 'Press me'").
  if (name && taskLower.includes(`'${name}'`)) return 100;
  if (name && taskLower.includes(`"${name}"`)) return 100;
  // Quoted label in the task, matched against the entry name.
  const quoted = taskLower.match(/['"]([^'"]{2,80})['"]/);
  if (quoted) {
    const q = quoted[1].trim();
    if (name === q) return 100;
    if (name.includes(q)) return 90;
    if (q.includes(name) && name.length >= 3) return 80;
  }
  // Role + name words: every significant word of the entry name in the task.
  const words = name.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (words.length && words.every((w) => taskLower.includes(w))) return 85;
  if (name && taskLower.includes(name)) return 75;
  // Single distinctive word of the name in the task (needs length >= 4 so
  // "go" or "me" cannot match everything).
  if (words.length) {
    const hits = words.filter((w) => w.length >= 4 && taskLower.includes(w));
    if (hits.length) return 60 + Math.min(10, hits.length * 5);
  }
  // Role word in the task + a name word (e.g. "click the submit button").
  if (role && taskLower.includes(role)) {
    if (words.some((w) => w.length >= 4 && taskLower.includes(w))) return 70;
    return 40;
  }
  // Selector id hint (e.g. task mentions "#go" or "go button").
  const idMatch = selector.match(/#([a-z0-9_-]{2,40})/);
  if (idMatch && taskLower.includes(idMatch[1])) return 65;
  return -1;
}

// Ground a task against snapshot entries (each entry: { role, name,
// selector, rect: {x,y,width,height}, centerNorm: {x,y} } — geometry is
// captured by snapshotDom() in browser-session.js). Returns a grounded
// click action with normalised coordinates of the element centre.
function groundFromSnapshot(task, entries, viewport) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('grounding needs a task description');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('cannot_see: no snapshot entries to ground against');
  const taskLower = task.toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const entry of entries) {
    const score = scoreEntry(entry, taskLower);
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  if (!best || bestScore < 0) throw new Error(`cannot_see: no element matches "${task.slice(0, 120)}"`);
  const vp = viewport || { width: 1280, height: 800 };
  let x; let y;
  if (best.centerNorm && typeof best.centerNorm.x === 'number' && typeof best.centerNorm.y === 'number') {
    x = best.centerNorm.x; y = best.centerNorm.y;
  } else if (best.rect && typeof best.rect.x === 'number') {
    x = (best.rect.x + best.rect.width / 2) / vp.width;
    y = (best.rect.y + best.rect.height / 2) / vp.height;
  } else {
    throw new Error('cannot_see: matched element has no geometry — take a fresh snapshot');
  }
  x = clamp01(x); y = clamp01(y);
  if (x === null || y === null) throw new Error('cannot_see: grounded coordinates out of range');
  // Sanity: the point must sit inside the matched element's own rect.
  if (best.rect && typeof best.rect.x === 'number') {
    const px = x * vp.width; const py = y * vp.height;
    if (px < best.rect.x - 1 || px > best.rect.x + best.rect.width + 1 ||
        py < best.rect.y - 1 || py > best.rect.y + best.rect.height + 1) {
      throw new Error('cannot_see: grounded point falls outside the matched element');
    }
  }
  return {
    action: 'click',
    x, y,
    confidence: Math.min(0.95, 0.4 + bestScore / 200),
    description: `click ${best.role || 'element'} "${String(best.name || '').slice(0, 80)}"`,
    destructive: false,
    grounder: 'dom-geometry',
    matched: { role: best.role, name: String(best.name || '').slice(0, 80), selector: String(best.selector || '').slice(0, 200), score: bestScore },
  };
}

// Full grounding step: provider vision first when one is available,
// DOM-geometry fallback when it is not (or when the caller asks for it
// with opts.preferDom). The return always carries `grounder` so the
// caller — and the audit log — can tell which path produced the point.
// opts.snapshotEntries + opts.viewport are required for the fallback.
async function groundWithFallback(task, imageBase64, opts = {}) {
  const { snapshotEntries, viewport, mimeType = 'image/png', only } = opts;
  if (opts.preferDom) {
    if (!snapshotEntries) throw new Error('dom grounding needs snapshotEntries');
    return { ...groundFromSnapshot(task, snapshotEntries, viewport), provider: null, model: null };
  }
  try {
    const r = await groundAction(task, imageBase64, mimeType, { only });
    return { ...r.action, grounder: 'vision-provider', provider: r.provider, model: r.model, tried: r.tried };
  } catch (e) {
    const msg = String(e.message || '');
    if (/no vision providers available/.test(msg) && snapshotEntries) {
      return { ...groundFromSnapshot(task, snapshotEntries, viewport), provider: null, model: null, fallbackFrom: msg.slice(0, 120) };
    }
    throw e;
  }
}

module.exports = { groundFromSnapshot, groundWithFallback, scoreEntry };
