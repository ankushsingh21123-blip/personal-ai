// Telegram — phone-as-remote (Phase C first step, SETUP.md Phase 4). The
// phone works as the control surface for the laptop/cloud agent: chat the
// agent, approve actions, see job status, freeze/unfreeze.
// Token via TELEGRAM_BOT_TOKEN in .env.local (Ankush creates the bot via
// @BotFather — no token is created here, no account is made here). The
// token is never logged, never returned, never stored anywhere but env.
// Long polling (getUpdates), no webhook, no public exposure. Commands:
//   /start — hello + what this bot does
//   /status — brain order, queue counts, freeze state
//   /freeze /unfreeze — instant stop / resume
//   /approve <id> / /reject <id> — decide a pending approval (records the
//     decision only — approving never executes a send/post/spend)
//   any other text — forwarded to the injected onMessage handler (the
//     agent turn) and the reply is sent back.
// Incoming text is DATA, never instructions: the handler runs the same
// deny-first tools as a chat turn. FAIL-CLOSED (H-3, audit 18 Nov 2026):
// until TELEGRAM_CHAT_ID is set, NO chat is answered — anyone who finds
// the bot gets nothing, not even /start. The owner pairs the bot by
// setting the chat id in the loopback Settings UI (or .env.local); the
// effective id is re-read from the environment on every update, so
// pairing takes effect without a restart. Refused chats are logged to
// stderr (chat id only, never message text). Once set, only that chat is
// answered — everyone else gets no reply at all.
// KEYS ARE NEVER ACCEPTED IN CHAT: a message that looks like an API key is
// refused before it reaches the agent turn, never stored, never forwarded.
// The reply points at the Settings page (loopback web UI), the only place
// keys are added. /providers shows STATUS only (configured/missing, masked
// preview, last test result) — never a full key.
// HONEST STATUS: unit-tested with mocked fetch only; no live bot run is
// proven (no token on this VM).
'use strict';

const { handleTelegramMessage, KEY_REFUSAL } = require('./telegram-core');

const API = 'https://api.telegram.org/bot';

class TelegramBot {
  // fetchImpl injectable (tests). handlers: { onMessage, getStatus,
  // decideApproval, setFrozen, freezeState } — injected by server.js.
  constructor({ token, chatId, fetchImpl, handlers } = {}) {
    this.token = token || process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = chatId || process.env.TELEGRAM_CHAT_ID || '';
    this.fetch = fetchImpl || fetch;
    this.handlers = handlers || {};
    this.offset = 0;
    this.running = false;
    this.timer = null;
  }

  get enabled() { return !!this.token; }

  // The chat id that may talk to the bot. The constructor value wins; the
  // environment is re-read on every call so pairing via the Settings UI
  // (which mirrors into process.env) takes effect without a restart.
  get effectiveChatId() {
    return String(this.chatId || process.env.TELEGRAM_CHAT_ID || '');
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      chatConfigured: !!this.effectiveChatId,
      reason: this.enabled ? null : 'no TELEGRAM_BOT_TOKEN in .env.local — create a bot via @BotFather, paste the token in .env.local, restart',
    };
  }

  async call(method, body) {
    if (!this.token) throw new Error('telegram disabled: no TELEGRAM_BOT_TOKEN');
    const res = await this.fetch(`${API}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method} failed: ${String(j.description || res.status).slice(0, 200)}`);
    return j.result;
  }

  async sendMessage(chatId, text) {
    return this.call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) });
  }

  async pollOnce() {
    const updates = await this.call('getUpdates', { offset: this.offset, timeout: 0, allowed_updates: ['message'] });
    for (const u of updates || []) {
      this.offset = Math.max(this.offset, (u.update_id || 0) + 1);
      await this.handleUpdate(u).catch(() => {});
    }
    return (updates || []).length;
  }

  async handleUpdate(update) {
    const msg = update?.message;
    if (!msg || typeof msg.text !== 'string') return { handled: false };
    const fromId = String(msg.chat?.id || '');
    // All gating + commands live in telegram-core.js, shared with the
    // grammY transport — this method only adapts the update shape.
    return handleTelegramMessage({
      text: msg.text,
      fromId,
      allowedChatId: this.effectiveChatId,
      handlers: this.handlers,
      send: (t) => this.sendMessage(fromId, t),
    });
  }

  start(intervalMs = 5000) {
    if (!this.enabled) throw new Error('telegram disabled: no TELEGRAM_BOT_TOKEN');
    if (this.running) return;
    if (!this.effectiveChatId) {
      console.error('[personal-ai] telegram bot polling WITHOUT a chat id — all chats are refused until TELEGRAM_CHAT_ID is set (Settings UI or .env.local)');
    }
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.pollOnce(); } catch {}
      if (this.running) this.timer = setTimeout(loop, intervalMs);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { TelegramBot, KEY_REFUSAL };
