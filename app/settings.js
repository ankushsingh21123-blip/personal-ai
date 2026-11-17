// Settings — API keys and provider configuration, end to end.
//
// Keys live in ONE place: `.env.local` in this folder (git-ignored, mode
// 600). This module is the only writer: it validates every value against
// an allowlist schema, rewrites the file atomically (temp file + rename,
// preserving comments and order), and mirrors the change into
// process.env so the running server picks it up without a restart.
//
// What this module NEVER does:
//   - return a full key (masked last-4 previews only, via secrets.mask)
//   - log a key, or store one in the database (the DB syncs — keys must
//     never sync to the cloud node)
//   - touch ANKU_TOKEN (the server's own auth token is not a setting)
//   - accept an arbitrary variable name (allowlist only)
//
// The Settings UI (frontend) and the /api/settings/* routes are the only
// way to add a key through the app. Telegram/WhatsApp refuse keys pasted
// in chat and point here instead. The file itself can still be edited by
// hand — same format, same file, same rules.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mask, redact } = require('./secrets');

const ENV_PATH = path.join(__dirname, '.env.local');

// --- validation schema (allowlist) ------------------------------------------
const ORDER_NAMES = new Set(['gemini', 'gemini-direct', 'gemini-vm-helper', 'groq', 'openai', 'anthropic', 'ollama']);

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.localhost');
}
function isCgnat(hostname) {
  // 100.64.0.0/10 — CGNAT range, used by Tailscale (100.x.y.z peer IPs).
  const m = hostname.match(/^100\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

function validateValue(name, value) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain newlines`);
  const schema = SETTING_VARS[name];
  if (!schema) throw new Error(`not a settable variable: ${name}`);
  switch (schema.kind) {
    case 'secret': {
      if (value.length < 8 || value.length > 500) throw new Error(`${name} must be 8..500 characters`);
      if (/\s/.test(value) || /['"`]/.test(value)) throw new Error(`${name} must not contain whitespace or quotes`);
      // M-7: reject shell metacharacters. .env.local is a data file, but
      // a value containing `;`, `|`, `&`, `$`, backtick, `()`, or `<>`
      // would execute if the file were ever sourced by a shell script.
      // Real API keys/tokens never contain these characters.
      if (/[;|&$`\\()<>]/.test(value)) throw new Error(`${name} must not contain shell characters (; | & $ \` ( ) < >)`);
      return value;
    }
    case 'url': {
      if (value.length === 0 || value.length > 500) throw new Error(`${name} must be 1..500 characters`);
      let u;
      try { u = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
      if (u.username || u.password) throw new Error(`${name} must not contain credentials in the URL`);
      if (u.protocol === 'https:') return value;
      if (u.protocol === 'http:' && (isLoopback(u.hostname) || (schema.allowCgnatHttp && isCgnat(u.hostname)))) return value;
      throw new Error(`${name} must be https, or http only to loopback${schema.allowCgnatHttp ? ' / Tailscale (100.x)' : ''}`);
    }
    case 'model': {
      if (value.length === 0 || value.length > 200) throw new Error(`${name} must be 1..200 characters`);
      if (!/^[A-Za-z0-9._\-/:]+$/.test(value)) throw new Error(`${name} must be a model id (letters, digits, . _ - / :)`);
      return value;
    }
    case 'int': {
      if (!/^-?\d+$/.test(value)) throw new Error(`${name} must be an integer`);
      const n = Number(value);
      if (n < schema.min || n > schema.max) throw new Error(`${name} must be ${schema.min}..${schema.max}`);
      return String(n);
    }
    case 'order': {
      const names = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (names.length === 0) throw new Error('BRAIN_PROVIDERS must list at least one provider');
      for (const n of names) if (!ORDER_NAMES.has(n)) throw new Error(`unknown provider in BRAIN_PROVIDERS: ${n}`);
      return [...new Set(names)].join(',');
    }
    case 'chatid': {
      if (!/^-?\d{1,20}$/.test(value)) throw new Error(`${name} must be a numeric chat id`);
      return value;
    }
    case 'bool': {
      const v = value.trim().toLowerCase();
      if (['1', 'yes', 'true', 'on'].includes(v)) return schema.normalizeTo || '1';
      if (['0', 'no', 'false', 'off'].includes(v)) return schema.normalizeTo === 'yes' ? 'no' : '0';
      throw new Error(`${name} must be yes/no`);
    }
    case 'path': {
      if (value.length === 0 || value.length > 500) throw new Error(`${name} must be 1..500 characters`);
      if (/[;|&$`\n]/.test(value)) throw new Error(`${name} must not contain shell characters`);
      return value;
    }
    default:
      throw new Error(`unknown schema for ${name}`);
  }
}

const SETTING_VARS = {
  GEMINI_API_KEY: { kind: 'secret' },
  GROQ_API_KEY: { kind: 'secret' },
  OPENAI_API_KEY: { kind: 'secret' },
  ANTHROPIC_API_KEY: { kind: 'secret' },
  TELEGRAM_BOT_TOKEN: { kind: 'secret' },
  SYNC_TOKEN: { kind: 'secret' },
  OPENAI_BASE_URL: { kind: 'url' },
  OLLAMA_HOST: { kind: 'url' },
  SYNC_PEER_URL: { kind: 'url', allowCgnatHttp: true },
  OPENAI_MODEL: { kind: 'model' },
  ANTHROPIC_MODEL: { kind: 'model' },
  OLLAMA_MODEL: { kind: 'model' },
  OLLAMA_VISION_MODEL: { kind: 'model' },
  ANTHROPIC_MAX_TOKENS: { kind: 'int', min: 1, max: 100000 },
  DESKTOP_AGENT_PORT: { kind: 'int', min: 1024, max: 65535 },
  BRAIN_PROVIDERS: { kind: 'order' },
  TELEGRAM_CHAT_ID: { kind: 'chatid' },
  TELEGRAM_ENABLED: { kind: 'bool', normalizeTo: 'yes' },
  FAST_ROUTING: { kind: 'bool', normalizeTo: '1' },
  ADB_PATH: { kind: 'path' },
};

// --- provider metadata (what the Settings UI shows) --------------------------
// keyUrl values are filled from the verified guide (docs/API-KEYS.md).
// The custom-endpoint row IS the OpenAI provider: OPENAI_BASE_URL turns
// it into any OpenAI-compatible endpoint (OpenRouter, a local server,
// another provider that speaks chat-completions). One row, three fields.
const PROVIDER_META = [
  { id: 'gemini', brainName: 'gemini-direct', label: 'Gemini (Google AI Studio)', keyVar: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/api-keys', freeTier: true, note: 'Free tier. Primary brain.' },
  { id: 'groq', brainName: 'groq', label: 'Groq', keyVar: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys', freeTier: true, note: 'Free tier. Fast fallback.' },
  { id: 'openai', brainName: 'openai', label: 'OpenAI / custom OpenAI-compatible endpoint', keyVar: 'OPENAI_API_KEY', baseUrlVar: 'OPENAI_BASE_URL', modelVar: 'OPENAI_MODEL', keyUrl: 'https://platform.openai.com/api-keys', freeTier: false, note: 'Paid. Leave Base URL empty for api.openai.com, or set any OpenAI-compatible endpoint (OpenRouter, local server).' },
  { id: 'anthropic', brainName: 'anthropic', label: 'Anthropic', keyVar: 'ANTHROPIC_API_KEY', modelVar: 'ANTHROPIC_MODEL', maxTokensVar: 'ANTHROPIC_MAX_TOKENS', keyUrl: 'https://platform.claude.com/settings/keys', freeTier: false, note: 'Paid. Optional.' },
  { id: 'ollama', brainName: 'ollama', label: 'Ollama (local, no key)', keyVar: null, modelVar: 'OLLAMA_MODEL', hostVar: 'OLLAMA_HOST', keyUrl: null, freeTier: true, note: 'Runs on your own machine. No key, works offline.' },
];

// --- .env.local read/write ----------------------------------------------------
// Parse lines, preserving comments/blank lines/order. Returns [{raw, key, value}].
function parseEnvText(text) {
  return String(text || '').split('\n').map(raw => {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || raw.trimStart().startsWith('#')) return { raw, key: null, value: null };
    return { raw, key: m[1], value: m[2].trim() };
  });
}

function readEnvFile(envPath = ENV_PATH) {
  if (!fs.existsSync(envPath)) return [];
  return parseEnvText(fs.readFileSync(envPath, 'utf8'));
}

// Apply updates (object key -> value, or null to remove). All values are
// validated BEFORE anything is written. Atomic: temp file + rename, 0600.
function writeEnvUpdates(updates, envPath = ENV_PATH) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('updates must be an object');
  const validated = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!SETTING_VARS[key]) throw new Error(`not a settable variable: ${key}`);
    if (value === null || value === '') { validated[key] = null; continue; }
    validated[key] = validateValue(key, String(value));
  }
  const lines = readEnvFile(envPath);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (line.key && line.key in validated) {
      if (seen.has(line.key)) continue; // drop duplicates
      seen.add(line.key);
      if (validated[line.key] !== null) out.push(`${line.key}=${validated[line.key]}`);
      // null = remove: emit nothing
    } else {
      out.push(line.raw);
    }
  }
  for (const [key, value] of Object.entries(validated)) {
    if (!seen.has(key) && value !== null) out.push(`${key}=${value}`);
  }
  let text = out.join('\n');
  if (text && !text.endsWith('\n')) text += '\n';
  // Atomic write: temp file in the same directory, mode 0600, then rename.
  const dir = path.dirname(envPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.env.local.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, envPath);
  try { fs.chmodSync(envPath, 0o600); } catch {}
  // Mirror into the running process so no restart is needed.
  for (const [key, value] of Object.entries(validated)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return Object.keys(validated);
}

// --- status (masked, never full keys) -----------------------------------------
// Last test results live in the settings DB table (runtime state, not
// config) — recorded by the test endpoint, redacted, keyed per provider.
function getLastTest(providerId) {
  try {
    const { getSetting } = require('./db');
    const raw = getSetting(`provider_test_${providerId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function recordTestResult(providerId, result) {
  const { setSetting } = require('./db');
  const safe = {
    ok: !!result.ok,
    model: result.model ? String(result.model).slice(0, 100) : null,
    provider: result.provider ? String(result.provider).slice(0, 50) : null,
    ms: typeof result.ms === 'number' ? Math.round(result.ms) : null,
    at: new Date().toISOString(),
    error: result.error ? redact(String(result.error)).slice(0, 300) : null,
  };
  setSetting(`provider_test_${providerId}`, JSON.stringify(safe));
  return safe;
}

function getProviderStatus() {
  return PROVIDER_META.map(meta => {
    const key = meta.keyVar ? (process.env[meta.keyVar] || '') : '';
    const row = {
      id: meta.id,
      brainName: meta.brainName,
      label: meta.label,
      configured: meta.keyVar ? key.length > 0 : true,
      masked: meta.keyVar ? mask(key) : null,
      keyUrl: meta.keyUrl,
      freeTier: meta.freeTier,
      note: meta.note,
      lastTest: getLastTest(meta.id),
    };
    if (meta.baseUrlVar) row.baseUrl = process.env[meta.baseUrlVar] || '';
    if (meta.modelVar) row.model = process.env[meta.modelVar] || '';
    if (meta.maxTokensVar) row.maxTokens = process.env[meta.maxTokensVar] || '';
    if (meta.hostVar) row.host = process.env[meta.hostVar] || '';
    return row;
  });
}

function getChannelStatus() {
  return {
    telegram: {
      tokenConfigured: !!(process.env.TELEGRAM_BOT_TOKEN || ''),
      tokenMasked: mask(process.env.TELEGRAM_BOT_TOKEN || ''),
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      enabled: process.env.TELEGRAM_ENABLED !== 'no',
    },
    sync: {
      peerUrl: process.env.SYNC_PEER_URL || '',
      tokenConfigured: !!(process.env.SYNC_TOKEN || ''),
      tokenMasked: mask(process.env.SYNC_TOKEN || ''),
    },
    fastRouting: process.env.FAST_ROUTING === '1',
  };
}

function getOrder() {
  const brain = require('./brain');
  return brain.resolveOrder();
}

// H-5: the CONFIGURED order — BRAIN_PROVIDERS exactly as saved (or the
// default order when unset), including providers with no key yet. The
// Settings UI edits this; getOrder() (the resolved chain) is display
// only. Names are returned as saved (e.g. 'gemini', not the normalised
// 'gemini-direct') so a save round-trips byte-for-byte; unknown names
// are dropped, duplicates collapsed, and an empty result falls back to
// the default order.
function getConfiguredOrder() {
  const raw = String(process.env.BRAIN_PROVIDERS || '').trim();
  const names = raw ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : ['gemini', 'groq', 'ollama'];
  const seen = new Set();
  const out = [];
  for (const n of names) {
    if (!ORDER_NAMES.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length ? out : ['gemini', 'groq', 'ollama'];
}

module.exports = {
  ENV_PATH, SETTING_VARS, PROVIDER_META, ORDER_NAMES,
  validateValue, parseEnvText, readEnvFile, writeEnvUpdates,
  getProviderStatus, getChannelStatus, getOrder, getConfiguredOrder,
  getLastTest, recordTestResult,
};
