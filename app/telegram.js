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
// deny-first tools as a chat turn. Only the configured chat id may talk to
// the bot (TELEGRAM_CHAT_ID, set after the first /start) — anyone else gets
// no reply at all. HONEST STATUS: unit-tested with mocked fetch only; no
// live bot run is proven (no token on this VM).
'use strict';

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

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      chatConfigured: !!this.chatId,
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
    // Chat lock: once TELEGRAM_CHAT_ID is set, only that chat is answered.
    if (this.chatId && fromId !== String(this.chatId)) return { handled: false, reason: 'chat not authorised' };
    const text = msg.text.trim();
    if (!text) return { handled: false };

    if (text === '/start') {
      await this.sendMessage(fromId, 'Ankush\'s Personal AI here. Send any message and I will work on it like a chat turn. Commands: /status /freeze /unfreeze /approve <id> /reject <id>. I never send, post or spend — approvals are drafts only.');
      return { handled: true, command: 'start' };
    }
    if (text === '/status' && this.handlers.getStatus) {
      const s = await this.handlers.getStatus();
      await this.sendMessage(fromId, `Brain: ${(s.brain_order || []).join(' → ')}\nFrozen: ${s.frozen}\nQueue: ${JSON.stringify(s.queue || {})}\nApprovals pending: ${s.approvals_pending ?? '?'}`);
      return { handled: true, command: 'status' };
    }
    if (text === '/freeze' && this.handlers.setFrozen) {
      const st = this.handlers.setFrozen(true, 'telegram /freeze');
      await this.sendMessage(fromId, `Frozen. Agent stopped. /unfreeze to resume.`);
      return { handled: true, command: 'freeze', state: st };
    }
    if (text === '/unfreeze' && this.handlers.setFrozen) {
      const st = this.handlers.setFrozen(false);
      await this.sendMessage(fromId, 'Unfrozen. Agent resumed.');
      return { handled: true, command: 'unfreeze', state: st };
    }
    const decide = text.match(/^\/(approve|reject)\s+(\d+)$/);
    if (decide && this.handlers.decideApproval) {
      const out = await this.handlers.decideApproval(Number(decide[2]), decide[1] === 'approve' ? 'approved' : 'rejected');
      await this.sendMessage(fromId, out?.error ? `Approval error: ${out.error}` : `Approval #${decide[2]} ${decide[1]}d. Recorded only — nothing was sent or executed.`);
      return { handled: true, command: decide[1] };
    }
    if (this.handlers.onMessage) {
      const reply = await this.handlers.onMessage(text, { chatId: fromId, source: 'telegram' });
      await this.sendMessage(fromId, reply);
      return { handled: true, command: 'message' };
    }
    return { handled: false, reason: 'no message handler' };
  }

  start(intervalMs = 5000) {
    if (!this.enabled) throw new Error('telegram disabled: no TELEGRAM_BOT_TOKEN');
    if (this.running) return;
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

module.exports = { TelegramBot };
