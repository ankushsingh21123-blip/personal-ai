// Telegram via grammY (MIT) — the recommended library in
// research-channels-apps-design-2026-11-18.md §1.2. Long polling, no
// webhook, no public exposure. This transport is an ALTERNATIVE to the
// built-in fetch poller (telegram.js); both run the SAME fail-closed
// gating and commands in telegram-core.js, so behaviour cannot drift.
//
// Activation: TELEGRAM_TRANSPORT=grammy in .env.local (or the Settings
// UI) + a TELEGRAM_BOT_TOKEN. Default transport is 'polling'; nothing
// changes unless the owner opts in. The grammY package is required
// lazily — if it is missing, createGrammyBot throws and server.js falls
// back to the built-in poller with a loud log line.
//
// HONEST STATUS: integration-tested against a local fake Bot API server
// with the real grammY package (tests/telegram-grammy.test.js) — no
// live bot run is proven (no token on this VM). Going live needs
// Ankush's token (via @BotFather) + his numeric chat id, both set in
// the Settings UI. Until TELEGRAM_CHAT_ID is set, NO chat is answered.
'use strict';

const { handleTelegramMessage } = require('./telegram-core');

// createGrammyBot({ token, chatId, handlers, grammyImpl, apiRoot })
//   token: bot token ('' = disabled, like TelegramBot)
//   chatId: owner chat id; the environment is re-read on every update
//     so pairing via the Settings UI takes effect without a restart
//   handlers: same shape as TelegramBot's handlers (server.js)
//   grammyImpl: { Bot } — injectable for tests; defaults to require('grammy')
//   apiRoot: Bot API root override — tests point it at a local fake
//     server; production uses Telegram's default (omit this).
// Returns { bot, enabled, running, start, stop, status } — the same
// control surface TelegramBot exposes, so server.js treats both alike.
function createGrammyBot({ token, chatId, handlers = {}, grammyImpl, apiRoot } = {}) {
  const resolvedToken = token || process.env.TELEGRAM_BOT_TOKEN || '';
  const { Bot } = grammyImpl || require('grammy');
  const bot = new Bot(resolvedToken || '0:disabled', apiRoot ? { client: { apiRoot } } : {});
  const fixedChatId = chatId || '';

  const effectiveChatId = () => String(fixedChatId || process.env.TELEGRAM_CHAT_ID || '');

  // Text messages only. No other update kind is handled: no photos,
  // no group joins, no callbacks — the bot answers owner text, nothing
  // else. Privacy mode stays ON (the default); group adds are not
  // part of this bot's job.
  bot.on('message:text', async (ctx) => {
    const fromId = String(ctx.chat?.id || '');
    try {
      await handleTelegramMessage({
        text: ctx.message.text,
        fromId,
        allowedChatId: effectiveChatId(),
        handlers,
        send: (t) => ctx.reply(t),
      });
    } catch (e) {
      // A handler failure must never kill the polling loop or leak a
      // stack to the chat. Log the failure (no message text), stay up.
      console.error('[personal-ai] telegram (grammy): message handler failed:', e.message);
    }
  });

  // grammY surfaces polling/API errors here; without a handler they
  // are unhandled rejections. Log and keep polling — a transient
  // network failure must not kill the bot.
  bot.catch((err) => {
    console.error('[personal-ai] telegram (grammy): bot error:', err?.message || String(err).slice(0, 200));
  });

  let running = false;
  return {
    bot,
    get enabled() { return !!resolvedToken; },
    get running() { return running; },
    status() {
      return {
        enabled: !!resolvedToken,
        running,
        chatConfigured: !!effectiveChatId(),
        transport: 'grammy',
        reason: resolvedToken ? null : 'no TELEGRAM_BOT_TOKEN in .env.local — create a bot via @BotFather, paste the token in .env.local, restart',
      };
    },
    start() {
      if (!resolvedToken) throw new Error('telegram disabled: no TELEGRAM_BOT_TOKEN');
      if (running) return;
      if (!effectiveChatId()) {
        console.error('[personal-ai] telegram bot (grammy) polling WITHOUT a chat id — all chats are refused until TELEGRAM_CHAT_ID is set (Settings UI or .env.local)');
      }
      running = true;
      // bot.start() runs long polling until bot.stop() is called.
      // It returns a promise that resolves when polling stops; a
      // rejection (e.g. 409 conflict with another poller) is logged
      // and marks the bot stopped — two pollers must never fight.
      bot.start().catch((e) => {
        running = false;
        console.error('[personal-ai] telegram (grammy): polling stopped:', e.message);
      });
    },
    async stop() {
      running = false;
      try { await bot.stop(); } catch {}
    },
  };
}

module.exports = { createGrammyBot };
