// Secrets — detection, masking, and redaction helpers shared by every
// surface that could ever see a key: the Settings API, Telegram, WhatsApp,
// the audit log, and stored test results. One module, one set of patterns,
// so a new provider's key format is added in exactly one place.
//
// Rules:
//   - looksLikeSecret(text): true when the text contains something shaped
//     like an API key, token, or a `*_KEY=` / `*_TOKEN=` assignment. Used to
//     REFUSE keys pasted in chat channels (Telegram/WhatsApp) — chat history
//     must never hold a key. False positives are acceptable here: the
//     refusal message points at the Settings page, which is the right flow.
//   - redact(text): replaces every match with [redacted-secret]. Used before
//     anything key-shaped is stored (test errors) or logged.
//   - mask(key): last-4 preview only, e.g. "••••3f9a". The only form of a
//     key the API or UI ever returns.
'use strict';

// Key shapes, by provider. Patterns are deliberately broad on the tail
// (20+ chars) so rotated/changed formats still match; the prefixes are
// what make a match trustworthy.
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google / Gemini API keys
  /sk-proj-[A-Za-z0-9_-]{20,}/g, // OpenAI project keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic keys
  /sk-or-v1-[A-Za-z0-9]{20,}/g, // OpenRouter keys
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI legacy keys (after the longer prefixes)
  /gsk_[A-Za-z0-9]{20,}/g, // Groq keys
  /hf_[A-Za-z0-9]{20,}/g, // Hugging Face tokens
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub personal access tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET)\s*=\s*\S+/g, // KEY= assignments
];

// A lone token-like word: 40+ chars, letters + digits, no whitespace.
// Catches keys whose prefix we do not know yet. URLs are excluded by the
// charset (no : / ? #). Applied per line, only when the whole line is one
// such word — a pasted key on its own line.
const LONE_TOKEN = /^[A-Za-z0-9_-]{40,}$/;

function looksLikeSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (LONE_TOKEN.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t)) return true;
  }
  return false;
}

function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '[redacted-secret]');
  }
  out = out.split('\n').map(line => {
    const t = line.trim();
    if (LONE_TOKEN.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t)) return '[redacted-secret]';
    return line;
  }).join('\n');
  return out;
}

function mask(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (key.length <= 4) return '••••';
  return '••••' + key.slice(-4);
}

module.exports = { looksLikeSecret, redact, mask, SECRET_PATTERNS };
