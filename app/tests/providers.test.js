// Unit tests for the multi-provider brain (Phase A, 14 Nov 2026).
// Mocked fetch, no server, no live keys. Run via: bash tests/run-tests.sh
// (the same script that runs tests/test.js — this file needs no server, but
// the one script runs the whole suite so the counts stay honest).
// These prove request shapes, response parsing, chain order, and key
// handling for the OpenAI-compatible and Anthropic providers. They do NOT
// prove a live round-trip — no live key exists on this VM, and none is
// claimed. Fake keys below are test strings, never real credentials.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brain = require('../brain');

const REAL_FETCH = global.fetch;
const KEY_VARS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'BRAIN_PROVIDERS', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_MAX_TOKENS'];

function saveEnv() {
  const saved = {};
  for (const k of KEY_VARS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const k of KEY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
function clearKeys() { for (const k of KEY_VARS) delete process.env[k]; }

let savedEnv;
test.beforeEach(() => { savedEnv = saveEnv(); clearKeys(); });
test.afterEach(() => { restoreEnv(savedEnv); global.fetch = REAL_FETCH; });

// Minimal Response-like stub: postJson only uses ok, status, and text().
function fakeResponse(json, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(json) };
}

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls.length);
  };
  return calls;
}

function assertNoKeyLeak(obj, key) {
  assert.doesNotMatch(JSON.stringify(obj), new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'result must never contain the API key');
}

test('openai: posts chat completions to the default base URL, Bearer key, parses the reply', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: 'hello from openai' } }] }));
  const r = await brain.ask('hi', 'openai');
  assert.equal(r.text, 'hello from openai');
  assert.equal(r.model, 'gpt-4o-mini');
  assert.equal(r.provider, 'openai');
  assert.deepEqual(r.tried, ['openai']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-openai-key-123');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assertNoKeyLeak(r, 'test-openai-key-123');
});

test('openai: custom base URL and model from env are honoured (trailing slash stripped)', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.OPENAI_BASE_URL = 'https://example-proxy.test/v1/';
  process.env.OPENAI_MODEL = 'custom-model';
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: 'ok' } }] }));
  const r = await brain.ask('hi', 'openai');
  assert.equal(r.model, 'custom-model');
  assert.equal(calls[0].url, 'https://example-proxy.test/v1/chat/completions');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'custom-model');
});

test('openai: empty content throws; missing key throws without calling fetch', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  mockFetch(() => fakeResponse({ choices: [{ message: { content: '' } }] }));
  await assert.rejects(brain.ask('hi', 'openai'), /empty OpenAI-compatible response/);
  mockFetch(() => fakeResponse({ choices: [] }));
  await assert.rejects(brain.ask('hi', 'openai'), /empty OpenAI-compatible response/);
  delete process.env.OPENAI_API_KEY;
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: 'ok' } }] }));
  await assert.rejects(brain.ask('hi', 'openai'), /no OPENAI_API_KEY/);
  assert.equal(calls.length, 0, 'no HTTP call may happen without a key');
});

test('anthropic: posts to the Messages API with version header, joins text blocks only', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-456';
  const calls = mockFetch(() => fakeResponse({
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'thinking', thinking: 'must be ignored' },
      { type: 'text', text: 'world' },
    ],
  }));
  const r = await brain.ask('hi', 'anthropic');
  assert.equal(r.text, 'Hello world');
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.provider, 'anthropic');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].opts.headers['x-api-key'], 'test-anthropic-key-456');
  assert.equal(calls[0].opts.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assertNoKeyLeak(r, 'test-anthropic-key-456');
});

test('anthropic: model and max_tokens from env are honoured; empty content throws', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-456';
  process.env.ANTHROPIC_MODEL = 'custom-claude';
  process.env.ANTHROPIC_MAX_TOKENS = '512';
  const calls = mockFetch(() => fakeResponse({ content: [{ type: 'text', text: 'ok' }] }));
  const r = await brain.ask('hi', 'anthropic');
  assert.equal(r.model, 'custom-claude');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.max_tokens, 512);
  mockFetch(() => fakeResponse({ content: [] }));
  await assert.rejects(brain.ask('hi', 'anthropic'), /empty Anthropic response/);
  mockFetch(() => fakeResponse({ content: [{ type: 'tool_use', name: 'x' }] }));
  await assert.rejects(brain.ask('hi', 'anthropic'), /empty Anthropic response/);
});

test('resolveOrder: default order skips providers with no key (helper only if present)', () => {
  const helperExists = fs.existsSync(path.join(os.homedir(), 'workspace/custom-connectors/custom.gemini/bin/gemini.py'));
  const expected = helperExists ? ['gemini-vm-helper', 'ollama'] : ['ollama'];
  assert.deepEqual(brain.resolveOrder(), expected);
  // A blank BRAIN_PROVIDERS means the same as unset.
  process.env.BRAIN_PROVIDERS = '   ';
  assert.deepEqual(brain.resolveOrder(), expected);
});

test('resolveOrder: BRAIN_PROVIDERS order honoured, unknown ignored, duplicates dropped, keyless skipped', () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai, bogus-provider, anthropic, openai, ollama, groq';
  assert.deepEqual(brain.resolveOrder(), ['openai', 'ollama']);
});

test('resolveOrder: gemini alias normalises to gemini-direct', () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key-789';
  process.env.BRAIN_PROVIDERS = 'gemini,ollama';
  assert.deepEqual(brain.resolveOrder(), ['gemini-direct', 'ollama']);
});

test('ask: chain follows BRAIN_PROVIDERS and falls through a failing provider to the next', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-456';
  process.env.BRAIN_PROVIDERS = 'openai,anthropic';
  const calls = mockFetch((url) => {
    if (url.includes('api.openai.com')) return fakeResponse({ error: 'boom' }, false, 500);
    return fakeResponse({ content: [{ type: 'text', text: 'anthropic answered' }] });
  });
  const r = await brain.ask('hi');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.text, 'anthropic answered');
  assert.deepEqual(r.tried, ['openai', 'anthropic']);
  assert.equal(calls.length, 2);
  assertNoKeyLeak(r, 'test-openai-key-123');
  assertNoKeyLeak(r, 'test-anthropic-key-456');
});

test('ask: empty resolved chain throws a clear no-providers error without calling fetch', async () => {
  process.env.BRAIN_PROVIDERS = 'openai';
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: 'ok' } }] }));
  await assert.rejects(brain.ask('hi'), /no brain providers available/);
  assert.equal(calls.length, 0);
});

test('ask: unknown provider name in only throws unknown provider', async () => {
  await assert.rejects(brain.ask('hi', 'no-such-provider'), /unknown provider/);
});

test('agentLoop: falls back to the configured chain when Gemini direct has no key', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai';
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: 'OK' } }] }));
  let executed = 0;
  const r = await brain.agentLoop('tools prompt', 'text prompt', async () => { executed++; return { ok: true }; });
  assert.equal(r.usedTools, false);
  assert.equal(r.provider, 'openai');
  assert.match(r.text, /OK/i);
  assert.equal(executed, 0, 'no tool may execute on the text fallback');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
});
