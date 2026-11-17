// grammY transport tests (cycle 7): the REAL grammY package talking to
// a LOCAL fake Bot API server (no token, no network, no Telegram).
// Proves the grammY poller wires into the same fail-closed gating as
// the built-in poller: owner answered, strangers silent, keys refused,
// commands honoured, no-chat-id refuses everyone.
'use strict';
const assert = require('node:assert/strict');
const { test, before, after, afterEach } = require('node:test');
const http = require('node:http');

const { createGrammyBot } = require('../telegram-grammy');
const { KEY_REFUSAL } = require('../telegram-core');

const FAKE_GEMINI = 'AIza' + 'A'.repeat(35);
const OWNER = '999';
const STRANGER = '555';

// --- fake Bot API ---------------------------------------------------------
// Serves getMe / getUpdates / sendMessage / anything-else with {ok:true}.
// Updates are queued by tests; each is delivered exactly once.
let server;
let baseUrl;
let queuedUpdates;
let sent;
let updateSeq;

function startFakeApi() {
  return new Promise((resolve) => {
    queuedUpdates = [];
    sent = [];
    updateSeq = 100;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const method = (req.url || '').split('/').pop();
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch {}
        let result = {};
        if (method === 'getMe') {
          result = { id: 1, is_bot: true, first_name: 'TestBot', username: 'testbot' };
        } else if (method === 'getUpdates') {
          const offset = Number(payload.offset || 0);
          result = queuedUpdates.filter((u) => u.update_id >= offset);
          queuedUpdates = queuedUpdates.filter((u) => u.update_id < offset);
        } else if (method === 'sendMessage') {
          sent.push({ chat_id: String(payload.chat_id), text: payload.text });
          result = { message_id: sent.length, chat: { id: payload.chat_id }, text: payload.text };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function queueMessage(chatId, text) {
  updateSeq += 1;
  queuedUpdates.push({
    update_id: updateSeq,
    message: {
      message_id: updateSeq,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), is_bot: false, first_name: 'Tester' },
      text,
    },
  });
}

async function waitFor(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = fn();
    if (out) return out;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

let bots = [];
function track(bot) {
  bots.push(bot);
  return bot;
}

before(async () => { await startFakeApi(); });
after(async () => {
  for (const b of bots) { try { await b.stop(); } catch {} }
  bots = [];
  await new Promise((r) => server.close(r));
});
// Stop every bot between tests: a still-polling bot from an earlier
// test would consume later tests' queued updates (shared fake server).
afterEach(async () => {
  for (const b of bots) { try { await b.stop(); } catch {} }
  bots = [];
  await new Promise((r) => setTimeout(r, 500));
  queuedUpdates = [];
});

function makeHandlers(overrides = {}) {
  return {
    onMessage: async (text) => `echo:${text}`,
    getStatus: async () => ({ brain_order: ['ollama'], frozen: false, queue: {}, approvals_pending: 0 }),
    getProviderStatus: async () => [],
    decideApproval: async (id, status) => ({ ok: true }),
    setFrozen: () => ({ frozen: true }),
    freezeState: () => ({ frozen: false }),
    ...overrides,
  };
}

test('grammy transport: owner message is answered, stranger is silently refused', async () => {
  const bot = track(createGrammyBot({
    token: '123:fake-token-for-local-test',
    chatId: OWNER,
    handlers: makeHandlers(),
    apiRoot: baseUrl,
  }));
  assert.equal(bot.enabled, true);
  assert.equal(bot.status().transport, 'grammy');
  bot.start();
  await waitFor(() => sent.length === 0 && bot.running, 'bot running');
  const before = sent.length;
  queueMessage(OWNER, 'hello grammy');
  const reply = await waitFor(() => sent.slice(before).find((s) => s.chat_id === OWNER), 'owner reply');
  assert.equal(reply.text, 'echo:hello grammy');
  queueMessage(STRANGER, 'hello stranger');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sent.slice(before).filter((s) => s.chat_id === STRANGER).length, 0);
});

test('grammy transport: pasted key is refused, never forwarded to the agent', async () => {
  let forwarded = 0;
  const bot = track(createGrammyBot({
    token: '123:fake-token-for-local-test',
    chatId: OWNER,
    handlers: makeHandlers({ onMessage: async () => { forwarded += 1; return 'should not happen'; } }),
    apiRoot: baseUrl,
  }));
  bot.start();
  await waitFor(() => bot.running, 'bot running');
  const before = sent.length;
  queueMessage(OWNER, `my key is ${FAKE_GEMINI}`);
  const reply = await waitFor(() => sent.slice(before).find((s) => s.chat_id === OWNER), 'key refusal');
  assert.equal(reply.text, KEY_REFUSAL);
  assert.equal(forwarded, 0);
});

test('grammy transport: /freeze command reaches the handler and is confirmed', async () => {
  let froze = 0;
  const bot = track(createGrammyBot({
    token: '123:fake-token-for-local-test',
    chatId: OWNER,
    handlers: makeHandlers({ setFrozen: () => { froze += 1; return { frozen: true }; } }),
    apiRoot: baseUrl,
  }));
  bot.start();
  await waitFor(() => bot.running, 'bot running');
  const before = sent.length;
  queueMessage(OWNER, '/freeze');
  const reply = await waitFor(() => sent.slice(before).find((s) => s.chat_id === OWNER), 'freeze reply');
  assert.match(reply.text, /Frozen/);
  assert.equal(froze, 1);
});

test('grammy transport: with no chat id configured, everyone is refused', async () => {
  const savedChatId = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_CHAT_ID;
  try {
    const bot = track(createGrammyBot({
      token: '123:fake-token-for-local-test',
      chatId: '',
      handlers: makeHandlers(),
      apiRoot: baseUrl,
    }));
    assert.equal(bot.status().chatConfigured, false);
    bot.start();
    await waitFor(() => bot.running, 'bot running');
    const before = sent.length;
    queueMessage(OWNER, 'hello?');
    queueMessage(STRANGER, 'hello?');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(sent.length, before);
  } finally {
    if (savedChatId !== undefined) process.env.TELEGRAM_CHAT_ID = savedChatId;
  }
});

test('grammy transport: disabled without a token, start() throws', () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const bot = createGrammyBot({ token: '', chatId: OWNER, handlers: makeHandlers(), apiRoot: baseUrl });
    assert.equal(bot.enabled, false);
    assert.throws(() => bot.start(), /no TELEGRAM_BOT_TOKEN/);
  } finally {
    if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
  }
});
