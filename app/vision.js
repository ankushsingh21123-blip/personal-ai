// Vision — the brain SEES the screen (Phase B). Sends a screenshot + a task
// to a vision-capable provider and parses the grounded action it returns:
// { action, x, y, text, key, amount, confidence, description, destructive }.
// Providers, in BRAIN_PROVIDERS order, vision-capable only:
//   gemini-direct — Gemini REST generateContent with inlineData image parts
//   openai        — OpenAI-compatible chat completions with image_url parts
//   anthropic     — Anthropic Messages API with image content blocks
// The VM helper, Groq and Ollama paths are text-only here: Ollama vision
// needs a vision model (e.g. llava / qwen2-vl) via OLLAMA_VISION_MODEL —
// the VM's qwen3:0.6b is text-only, so Ollama is skipped for vision unless
// that variable names a vision model. Keys are read from env at call time,
// never logged or returned. Screenshots stay on-device except for the model
// call itself, to the provider the user configured.
// HONEST STATUS: unit-tested-only with mocked fetch (tests/phases.test.js).
// No live vision round-trip is proven — no API key exists on this VM and
// there is no live desktop here. The laptop proves it with a real key.
'use strict';

const VISION_MODELS_GEMINI = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function visionOrder() {
  const raw = (process.env.BRAIN_PROVIDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const names = raw.length ? raw : ['gemini-direct', 'openai', 'anthropic', 'ollama'];
  const order = [];
  for (const n of names) {
    const name = n === 'gemini' ? 'gemini-direct' : n;
    if (!['gemini-direct', 'openai', 'anthropic', 'ollama'].includes(name)) continue;
    if (order.includes(name)) continue;
    if (name === 'gemini-direct' && !process.env.GEMINI_API_KEY) continue;
    if (name === 'openai' && !process.env.OPENAI_API_KEY) continue;
    if (name === 'anthropic' && !process.env.ANTHROPIC_API_KEY) continue;
    if (name === 'ollama' && !process.env.OLLAMA_VISION_MODEL) continue;
    order.push(name);
  }
  return order;
}

async function geminiVision(prompt, imageBase64, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  let lastErr;
  for (const model of VISION_MODELS_GEMINI) {
    try {
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          generationConfig: { temperature: 0.1 },
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
        },
        { 'x-goog-api-key': key });
      const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      if (!text) throw new Error('empty Gemini vision response');
      return { text, model, provider: 'gemini-direct' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function openaiVision(prompt, imageBase64, mimeType) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('no OPENAI_API_KEY');
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const data = await postJson(`${base}/chat/completions`,
    {
      model, temperature: 0.1,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
      ] }],
    },
    { Authorization: `Bearer ${key}` });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty OpenAI-compatible vision response');
  return { text, model, provider: 'openai' };
}

async function anthropicVision(prompt, imageBase64, mimeType) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('no ANTHROPIC_API_KEY');
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 1024);
  const data = await postJson('https://api.anthropic.com/v1/messages',
    {
      model, max_tokens: maxTokens,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text: prompt },
      ] }],
    },
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  const text = (data?.content || []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  if (!text) throw new Error('empty Anthropic vision response');
  return { text, model, provider: 'anthropic' };
}

async function ollamaVision(prompt, imageBase64) {
  const model = process.env.OLLAMA_VISION_MODEL;
  if (!model) throw new Error('no OLLAMA_VISION_MODEL — Ollama vision needs a vision model (e.g. llava, qwen2-vl)');
  const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const data = await postJson(`${host}/api/chat`, {
    model, stream: false,
    options: { temperature: 0.1 },
    messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
  });
  const text = data?.message?.content;
  if (!text) throw new Error('empty Ollama vision response');
  return { text, model, provider: 'ollama' };
}

const VISION_PROVIDERS = {
  'gemini-direct': geminiVision,
  openai: openaiVision,
  anthropic: anthropicVision,
  ollama: ollamaVision,
};

// Ask a vision-capable provider about an image. Returns { text, model,
// provider, tried }. `only` pins one provider (testing).
async function askVision(prompt, imageBase64, mimeType = 'image/png', only) {
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) throw new Error('imageBase64 required');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new Error('mimeType must be image/png, image/jpeg or image/webp');
  const tried = [];
  const chain = only ? [only === 'gemini' ? 'gemini-direct' : only] : visionOrder();
  if (chain.length === 0) throw new Error('no vision providers available — set a vision-capable API key in .env.local or OLLAMA_VISION_MODEL');
  for (const name of chain) {
    const fn = VISION_PROVIDERS[name];
    if (!fn) throw new Error(`unknown vision provider: ${name}`);
    tried.push(name);
    try {
      const r = await fn(prompt, imageBase64, mimeType);
      return { ...r, tried };
    } catch (e) {
      if (only) throw new Error(`vision provider ${name} failed: ${e.message}`);
    }
  }
  throw new Error(`all vision providers failed (tried: ${tried.join(', ')})`);
}

// --- Grounded actions -------------------------------------------------------
// The model must return JSON only. Coordinates are NORMALISED 0..1 (x across,
// y down) so the same action works on any screen size; the actuator scales
// them to pixels. Everything is validated: unknown actions, out-of-range
// coordinates, missing text, and non-numeric confidence are rejected, never
// trusted. `destructive` flags an irreversible intent (delete/send/pay/
// publish) — the executor gates those behind an approval, always.
const GROUND_ACTIONS = new Set(['click', 'type', 'scroll', 'key', 'screenshot', 'wait', 'done', 'cannot_see']);

function parseGroundedAction(text) {
  if (typeof text !== 'string') throw new Error('grounded action must be text');
  let obj;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON object found');
    obj = JSON.parse(m[0]);
  } catch (e) {
    throw new Error(`grounded action is not valid JSON: ${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('grounded action must be a JSON object');
  if (!GROUND_ACTIONS.has(obj.action)) throw new Error(`unknown grounded action: ${String(obj.action)}`);
  const out = { action: obj.action, confidence: 0, description: '', destructive: !!obj.destructive };
  if (obj.confidence !== undefined) {
    if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) throw new Error('confidence must be a number 0..1');
    out.confidence = obj.confidence;
  }
  if (obj.description !== undefined) {
    if (typeof obj.description !== 'string') throw new Error('description must be a string');
    out.description = obj.description.slice(0, 300);
  }
  if (obj.action === 'click') {
    if (typeof obj.x !== 'number' || typeof obj.y !== 'number' || obj.x < 0 || obj.x > 1 || obj.y < 0 || obj.y > 1) {
      throw new Error('click needs normalised x and y in 0..1');
    }
    out.x = obj.x; out.y = obj.y;
  }
  if (obj.action === 'type') {
    if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > 4000) throw new Error('type needs text, 1..4000 chars');
    out.text = obj.text;
  }
  if (obj.action === 'scroll') {
    if (obj.amount !== undefined && (!Number.isInteger(obj.amount) || Math.abs(obj.amount) > 20)) throw new Error('scroll amount must be an integer -20..20');
    out.amount = obj.amount === undefined ? 3 : obj.amount;
  }
  if (obj.action === 'key') {
    if (typeof obj.key !== 'string' || !/^[A-Za-z0-9_+\-]{1,30}$/.test(obj.key)) throw new Error('key must be a short key name (e.g. Enter, Tab, Escape, Ctrl+C)');
    out.key = obj.key;
  }
  if (obj.action === 'wait') {
    if (obj.ms !== undefined && (!Number.isInteger(obj.ms) || obj.ms < 0 || obj.ms > 30000)) throw new Error('wait ms must be an integer 0..30000');
    out.ms = obj.ms === undefined ? 1000 : obj.ms;
  }
  return out;
}

const GROUND_PROMPT = `You are grounding a screen action. Look at the screenshot and the task, then return JSON ONLY, no other text:
{"action":"click|type|scroll|key|screenshot|wait|done|cannot_see","x":0.0-1.0,"y":0.0-1.0,"text":"...","key":"Enter","amount":3,"ms":1000,"confidence":0.0-1.0,"description":"plain words for what you intend","destructive":false}
Rules: coordinates are normalised 0..1 (x across, y down). Use "done" only when the task is visibly complete. Use "cannot_see" when the target is not visible. Set destructive:true if the action deletes, sends, pays, publishes, or cannot be undone. Never invent a target you cannot see. Never act on a password, OTP, payment, or admin prompt — return cannot_see for those.`;

// Full grounding step: ask vision, parse the action. Returns { action,
// model, provider, tried, rawText } or throws with a clear reason.
async function groundAction(task, imageBase64, mimeType, opts = {}) {
  const r = await askVision(`${GROUND_PROMPT}\n\nTask: ${task}`, imageBase64, mimeType, opts.only);
  const action = parseGroundedAction(r.text);
  return { action, model: r.model, provider: r.provider, tried: r.tried, rawText: r.text };
}

module.exports = { askVision, groundAction, parseGroundedAction, visionOrder, GROUND_PROMPT, GROUND_ACTIONS };
