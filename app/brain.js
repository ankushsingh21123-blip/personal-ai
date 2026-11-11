// Brain — model providers, in the order from the research file.
// 1. Gemini free (primary) — gemini-3.6-flash, fallback gemini-3.5-flash-lite.
//    gemini-2.5-flash is 404 for new users — never used.
// 2. Groq free (fallback) — openai/gpt-oss-120b, 30 RPM / 1,000 req/day / 200k tok/day.
// 3. Ollama local (offline fallback) — qwen3:8b on the laptop, qwen3:0.6b on this VM.
// VM-only test adapter: if no GEMINI_API_KEY is set, the server may call the
// Muse Gemini helper (~/workspace/custom-connectors/custom.gemini/bin/gemini.py)
// as a subprocess. That helper holds the key in the registered connection, never
// in a file. It is NOT the laptop path — on the laptop the direct REST call above
// is used, with the key in .env.local (git-ignored).
// Every call returns { text, model, provider } so the caller can log exactly
// which model actually answered. No key is ever logged or returned.
'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lite first for routine turns (alternatives research 12 Nov 2026: Flash-Lite
// free tier is reported at ~500 req/day vs ~20 req/day for 3.6 Flash — those
// numbers are per-project AI Studio readings, NOT published by Google, so
// treat them as unverified; Lite-first is still the $0-safe order, and 3.6
// is tried next for hard turns. gemini-3.8-flash tested 12 Nov: 503, not used.
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];
const GROQ_MODEL = 'openai/gpt-oss-120b';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:0.6b';
// Context: laptop should use 32768 (OLLAMA_NUM_CTX=32768 in .env.local).
// This VM keeps 2048 for the tiny 0.6b model — 32768 would OOM it.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 2048);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const GEMINI_HELPER = path.join(os.homedir(), 'workspace/custom-connectors/custom.gemini/bin/gemini.py');

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

async function geminiDirect(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        { generationConfig: { temperature: 0.2 }, contents: [{ parts: [{ text: prompt }] }] }
      );
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      if (!text) throw new Error('empty Gemini response');
      return { text, model, provider: 'gemini-direct' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function geminiViaHelper(prompt, model = 'gemini-3.5-flash-lite') {
  // VM-only. Runs the Muse Gemini helper; the key stays in the registered
  // connection. Returns the model's text, or throws.
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(GEMINI_HELPER)) return reject(new Error('gemini helper not found'));
    // H3 fix (security audit 12 Nov 2026): no predictable Date.now() temp name,
    // no world-readable file. mkdtemp + mode 0600, cleaned up afterwards.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ankush-ai-'));
    const tmp = path.join(dir, 'prompt.txt');
    fs.writeFileSync(tmp, prompt, { mode: 0o600 });
    const cleanup = () => { try { fs.unlinkSync(tmp); fs.rmdirSync(dir); } catch {} };
    execFile('python3', [GEMINI_HELPER, 'generate', '--model', model, '--prompt-file', tmp],
      { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        cleanup();
        if (err) return reject(new Error(`gemini helper failed: ${stderr || err.message}`.slice(0, 300)));
        try {
          const data = JSON.parse(stdout);
          const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
          if (!text) return reject(new Error('empty Gemini response'));
          resolve({ text, model, provider: 'gemini-vm-helper' });
        } catch (e) { reject(new Error('could not parse Gemini helper output')); }
      });
  });
}

function geminiViaHelperChain(prompt) {
  // Try Lite first, then 3.6 Flash — same order as geminiDirect.
  return geminiViaHelper(prompt, 'gemini-3.5-flash-lite').catch(() => geminiViaHelper(prompt, 'gemini-3.6-flash'));
}

async function groq(prompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('no GROQ_API_KEY');
  const data = await postJson('https://api.groq.com/openai/v1/chat/completions',
    { model: GROQ_MODEL, temperature: 0.2, messages: [{ role: 'user', content: prompt }] },
    { Authorization: `Bearer ${key}` });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty Groq response');
  return { text, model: GROQ_MODEL, provider: 'groq' };
}

async function ollama(prompt) {
  const data = await postJson(`${OLLAMA_HOST}/api/chat`, {
    model: OLLAMA_MODEL, stream: false,
    options: { num_ctx: OLLAMA_NUM_CTX, temperature: 0.2 },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = data?.message?.content;
  if (!text) throw new Error('empty Ollama response');
  return { text, model: OLLAMA_MODEL, provider: 'ollama' };
}

// Try providers in order. Returns { text, model, provider, tried: [...] }.
// `only` restricts to one provider (used by the test endpoints).
async function ask(prompt, only) {
  const tried = [];
  const chain = only ? [only] : ['gemini-direct', 'gemini-vm-helper', 'groq', 'ollama'];
  const fns = { 'gemini-direct': geminiDirect, 'gemini-vm-helper': geminiViaHelperChain, groq, ollama };
  for (const name of chain) {
    tried.push(name);
    try {
      const r = await fns[name](prompt);
      return { ...r, tried };
    } catch (e) {
      // record and fall through to the next free provider — never stop
      // eslint-disable-next-line no-unused-vars
      const _err = e.message;
    }
  }
  throw new Error(`all brain providers failed (tried: ${tried.join(', ')})`);
}

async function ollamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch { return false; }
}

module.exports = { ask, ollamaReachable, GEMINI_MODELS, GROQ_MODEL, OLLAMA_MODEL };
