// Verify-fix cycle tests (push gate, 18 Nov 2026). Mocked fetch, no server.
// Regression: a skill-loaded chat turn through the local Ollama model failed
// end-to-end (HTTP 500, "all brain providers failed") because the shared
// 60 s provider timeout aborted the call — a ~1500-token prompt + generation
// measured ~140 s on this VM's shared CPUs (~6 tok/s). Ollama now gets its
// own generation cap (OLLAMA_NUM_PREDICT, default 512) and timeout
// (OLLAMA_TIMEOUT_MS, default 180 s), both clamped; cloud providers keep
// the 60 s timeout. The live proof is the E2E re-run, not these unit tests.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const brain = require('../brain');

const REAL_FETCH = global.fetch;
const VARS = ['OLLAMA_NUM_PREDICT', 'OLLAMA_TIMEOUT_MS', 'MAX_OUTPUT_TOKENS'];

function saveEnv() {
  const saved = {};
  for (const k of VARS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

let savedEnv;
test.beforeEach(() => { savedEnv = saveEnv(); for (const k of VARS) delete process.env[k]; });
test.afterEach(() => { restoreEnv(savedEnv); global.fetch = REAL_FETCH; });

test('ollama bounds: num_predict defaults to 512 and clamps 64..2048', () => {
  assert.equal(brain.ollamaNumPredict(), 512);
  process.env.OLLAMA_NUM_PREDICT = '300';
  assert.equal(brain.ollamaNumPredict(), 300);
  process.env.OLLAMA_NUM_PREDICT = '1';
  assert.equal(brain.ollamaNumPredict(), 64);
  process.env.OLLAMA_NUM_PREDICT = '5000';
  assert.equal(brain.ollamaNumPredict(), 2048);
  process.env.OLLAMA_NUM_PREDICT = 'not-a-number';
  assert.equal(brain.ollamaNumPredict(), 512);
});

test('ollama bounds: timeout defaults to 180000ms and clamps 30000..290000', () => {
  assert.equal(brain.ollamaTimeoutMs(), 180000);
  process.env.OLLAMA_TIMEOUT_MS = '120000';
  assert.equal(brain.ollamaTimeoutMs(), 120000);
  process.env.OLLAMA_TIMEOUT_MS = '1000';
  assert.equal(brain.ollamaTimeoutMs(), 30000);
  process.env.OLLAMA_TIMEOUT_MS = '999999';
  assert.equal(brain.ollamaTimeoutMs(), 290000);
  process.env.OLLAMA_TIMEOUT_MS = 'not-a-number';
  assert.equal(brain.ollamaTimeoutMs(), 180000);
});

test('ollama bounds: cloud provider timeout unchanged at 60s', () => {
  assert.equal(brain.PROVIDER_TIMEOUT_MS, 60000);
});

test('ollama request: num_predict comes from the Ollama cap, not maxOutputTokens', async () => {
  process.env.MAX_OUTPUT_TOKENS = '2048';
  let seenBody = null;
  let seenSignal = null;
  global.fetch = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    seenSignal = opts.signal;
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: 'hi' }, eval_count: 2, prompt_eval_count: 10 }) };
  };
  const r = await brain.ask('hello', 'ollama');
  assert.equal(r.provider, 'ollama');
  assert.equal(seenBody.options.num_predict, 512);
  assert.equal(seenBody.options.num_ctx, 2048);
  assert.ok(seenSignal instanceof AbortSignal);
});

test('ollama request: OLLAMA_NUM_PREDICT env reaches the request body', async () => {
  process.env.OLLAMA_NUM_PREDICT = '256';
  let seenBody = null;
  global.fetch = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: 'hi' }, eval_count: 2, prompt_eval_count: 10 }) };
  };
  await brain.ask('hello', 'ollama');
  assert.equal(seenBody.options.num_predict, 256);
});
