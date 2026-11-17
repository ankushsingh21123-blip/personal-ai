// Telegram message handling core — shared by BOTH transports (the
// built-in fetch poller in telegram.js and the grammY poller in
// telegram-grammy.js). The gating and command behaviour exist exactly
// once, here, so the transports cannot drift apart.
//
// Rules (unchanged from telegram.js — this file is a pure extraction):
// - Chat lock, fail-closed (H-3): with no chat id configured, refuse
//   EVERYONE — including /start. With one configured, only that chat is
//   answered; others are logged (chat id only, never message text) and
//   refused with no reply.
// - Key refusal BEFORE any command or agent handling: a pasted key is
//   never forwarded to the agent turn and never stored.
// - Incoming text is DATA, never instructions: the agent turn runs the
//   same deny-first tools as a chat turn.
// - Approving/rejecting records the decision only — it never executes
//   a send/post/spend.
// - Replies are capped at 4000 chars (Telegram's 4096 limit, margin).
'use strict';

const { looksLikeSecret } = require('./secrets');

const KEY_REFUSAL = 'I cannot accept API keys in chat — chat history must never hold a key. Add it in the Settings page of the web UI (open the app on the laptop, Settings → Providers), or edit .env.local directly. Use /providers to see which providers are configured.';

// handleTelegramMessage({ text, fromId, allowedChatId, handlers, send })
//   text: raw message text (trimmed here)
//   fromId: sender chat id, as a string
//   allowedChatId: the owner chat id, as a string ('' = none configured)
//   handlers: { onMessage, getStatus, getProviderStatus, decideApproval,
//             setFrozen, freezeState } — injected by server.js
//   send: async (text) => void — the transport's reply function
// Returns { handled, command?, reason?, state? } — the same shapes
// telegram.js has always returned.
async function handleTelegramMessage({ text: rawText, fromId, allowedChatId, handlers = {}, send }) {
  const allowed = String(allowedChatId || '');
  if (!allowed) {
    console.error(`[personal-ai] telegram: refused update from chat ${fromId || '(unknown)'} — no TELEGRAM_CHAT_ID configured`);
    return { handled: false, reason: 'telegram chat id not configured — refusing all chats until TELEGRAM_CHAT_ID is set' };
  }
  if (String(fromId || '') !== allowed) {
    console.error(`[personal-ai] telegram: refused update from unauthorised chat ${fromId || '(unknown)'}`);
    return { handled: false, reason: 'chat not authorised' };
  }
  const text = String(rawText || '').trim();
  if (!text) return { handled: false };
  const reply = async (t) => { await send(String(t).slice(0, 4000)); };

  // Key refusal: BEFORE any command or agent handling.
  if (looksLikeSecret(text)) {
    await reply(KEY_REFUSAL);
    return { handled: true, command: 'key_refused' };
  }

  if (text === '/start') {
    await reply('Piplet — Ankush\'s Personal AI here. Send any message and I will work on it like a chat turn. Commands: /status /providers /freeze /unfreeze /approve <id> /reject <id>. I never send, post or spend — approvals are drafts only. Never paste API keys here — use the Settings page.');
    return { handled: true, command: 'start' };
  }
  if (text === '/providers' && handlers.getProviderStatus) {
    const rows = await handlers.getProviderStatus();
    const lines = (rows || []).map(p => {
      const state = p.configured ? `configured ${p.masked || ''}` : 'missing';
      const test = p.lastTest ? (p.lastTest.ok ? `last test OK (${p.lastTest.ms ?? '?'}ms)` : 'last test FAILED') : 'never tested';
      return `${p.label}: ${state} — ${test}`;
    });
    await reply(`Providers (status only — keys are added in the Settings page):\n${lines.join('\n')}`);
    return { handled: true, command: 'providers' };
  }
  if (text === '/status' && handlers.getStatus) {
    const s = await handlers.getStatus();
    await reply(`Brain: ${(s.brain_order || []).join(' → ')}\nFrozen: ${s.frozen}\nQueue: ${JSON.stringify(s.queue || {})}\nApprovals pending: ${s.approvals_pending ?? '?'}`);
    return { handled: true, command: 'status' };
  }
  if (text === '/freeze' && handlers.setFrozen) {
    const st = handlers.setFrozen(true, 'telegram /freeze');
    await reply('Frozen. Agent stopped. /unfreeze to resume.');
    return { handled: true, command: 'freeze', state: st };
  }
  if (text === '/unfreeze' && handlers.setFrozen) {
    const st = handlers.setFrozen(false);
    await reply('Unfrozen. Agent resumed.');
    return { handled: true, command: 'unfreeze', state: st };
  }
  const decide = text.match(/^\/(approve|reject)\s+(\d+)$/);
  if (decide && handlers.decideApproval) {
    const out = await handlers.decideApproval(Number(decide[2]), decide[1] === 'approve' ? 'approved' : 'rejected');
    await reply(out?.error ? `Approval error: ${out.error}` : `Approval #${decide[2]} ${decide[1]}d. Recorded only — nothing was sent or executed.`);
    return { handled: true, command: decide[1] };
  }
  if (handlers.onMessage) {
    const answer = await handlers.onMessage(text, { chatId: String(fromId), source: 'telegram' });
    await reply(answer);
    return { handled: true, command: 'message' };
  }
  return { handled: false, reason: 'no message handler' };
}

module.exports = { handleTelegramMessage, KEY_REFUSAL };
