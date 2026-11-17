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

// --- Phase A2 (15 Nov 2026): native function calling for OpenAI + Anthropic.
// Mocked fetch only — no live round-trip is claimed, no key exists on this VM.

test('toJsonSchema: lowercases types recursively, preserves required/description/enum, never throws', () => {
  const out = brain.toJsonSchema({
    type: 'OBJECT',
    description: 'd',
    properties: {
      a: { type: 'STRING' },
      b: { type: 'ARRAY', items: { type: 'INTEGER' } },
      c: { type: 'OBJECT', properties: { d: { type: 'BOOLEAN' } } },
      e: { type: 'STRING', enum: ['x', 'y'] },
    },
    required: ['a'],
  });
  assert.deepEqual(out, {
    type: 'object',
    description: 'd',
    properties: {
      a: { type: 'string' },
      b: { type: 'array', items: { type: 'integer' } },
      c: { type: 'object', properties: { d: { type: 'boolean' } } },
      e: { type: 'string', enum: ['x', 'y'] },
    },
    required: ['a'],
  });
  assert.deepEqual(brain.toJsonSchema(null), { type: 'object', properties: {} });
  assert.deepEqual(brain.toJsonSchema('nope'), { type: 'object', properties: {} });
});

test('openaiTools: function tools derived from the declarations, lowercase schemas, no dangerous tool', () => {
  const tools = brain.openaiTools();
  assert.equal(tools.length, brain.TOOL_DECLARATIONS.length);
  assert.deepEqual(tools.map(t => t.function.name).sort(), brain.TOOL_DECLARATIONS.map(d => d.name).sort());
  for (const t of tools) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function.description, 'string');
    assert.equal(t.function.parameters.type, 'object');
  }
  assert.ok(!tools.some(t => /send|post|spend|delete|email|payment/i.test(t.function.name)));
  const screenAct = tools.find(t => t.function.name === 'screen_act').function.parameters;
  assert.deepEqual(screenAct.required, ['action']);
  assert.equal(screenAct.properties.region.type, 'array');
  assert.equal(screenAct.properties.region.items.type, 'number');
  assert.equal(screenAct.properties.x.type, 'number');
  assert.equal(screenAct.properties.destructive.type, 'boolean');
  const readFile = tools.find(t => t.function.name === 'read_file').function.parameters;
  assert.deepEqual(readFile.required, ['path']);
  assert.equal(readFile.properties.path.type, 'string');
});

test('anthropicTools: tools with input_schema, same names, lowercase schemas', () => {
  const tools = brain.anthropicTools();
  assert.equal(tools.length, brain.TOOL_DECLARATIONS.length);
  assert.deepEqual(tools.map(t => t.name).sort(), brain.TOOL_DECLARATIONS.map(d => d.name).sort());
  for (const t of tools) {
    assert.equal(typeof t.description, 'string');
    assert.equal(t.input_schema.type, 'object');
  }
  const clipboard = tools.find(t => t.name === 'clipboard_set').input_schema;
  assert.deepEqual(clipboard.required, ['text']);
  const focus = tools.find(t => t.name === 'focus_window').input_schema;
  assert.equal(focus.properties.pid.type, 'integer');
});

test('parseOpenAIResponse: parses text + valid calls; drops malformed, undeclared, id-less, non-object', () => {
  const { text, toolCalls } = brain.parseOpenAIResponse({
    choices: [{
      message: {
        content: 'hello',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
          { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{bad json' } },
          { id: 'c3', type: 'function', function: { name: 'send_email', arguments: '{}' } },
          { type: 'function', function: { name: 'list_files', arguments: '{}' } },
          { id: 'c5', type: 'function', function: { name: 'read_file', arguments: '[1,2]' } },
          { id: 'c6', type: 'function', function: { name: 'search_notes', arguments: '' } },
          { id: 42, type: 'function', function: { name: 'list_files', arguments: '{}' } },
          { id: 'c8', type: 'function', function: { name: 'read_file', arguments: '{"path":"."}', } },
        ],
      },
    }],
  });
  assert.equal(text, 'hello');
  assert.deepEqual(toolCalls, [
    { id: 'c1', name: 'list_files', args: { path: '.' } },
    { id: 'c6', name: 'search_notes', args: {} },
    { id: 'c8', name: 'read_file', args: { path: '.' } },
  ]);
});

test('parseOpenAIResponse: empty and missing shapes yield an empty result', () => {
  assert.deepEqual(brain.parseOpenAIResponse({}), { text: '', toolCalls: [] });
  assert.deepEqual(brain.parseOpenAIResponse(null), { text: '', toolCalls: [] });
  assert.deepEqual(brain.parseOpenAIResponse({ choices: [] }), { text: '', toolCalls: [] });
  assert.deepEqual(brain.parseOpenAIResponse({ choices: [{ message: { content: null } }] }), { text: '', toolCalls: [] });
  assert.deepEqual(brain.parseOpenAIResponse({ choices: [{ message: {} }] }), { text: '', toolCalls: [] });
});

test('parseAnthropicResponse: joins text, parses tool_use, drops malformed, ignores thinking blocks', () => {
  const { text, toolCalls } = brain.parseAnthropicResponse({
    content: [
      { type: 'text', text: 'Hi ' },
      { type: 'thinking', thinking: 'must be ignored' },
      { type: 'text', text: 'there' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x' } },
      { type: 'tool_use', id: 't2', name: 'send_email', input: {} },
      { type: 'tool_use', id: 't3', name: 'read_file', input: [1] },
      { type: 'tool_use', name: 'read_file', input: {} },
      { type: 'tool_use', id: 't5', name: 'notify', input: undefined },
      { type: 'redacted', data: 'never surfaced' },
    ],
  });
  assert.equal(text, 'Hi there');
  assert.deepEqual(toolCalls, [
    { id: 't1', name: 'read_file', args: { path: 'x' } },
    { id: 't5', name: 'notify', args: {} },
  ]);
});

test('parseAnthropicResponse: empty and missing shapes yield an empty result', () => {
  assert.deepEqual(brain.parseAnthropicResponse({}), { text: '', toolCalls: [] });
  assert.deepEqual(brain.parseAnthropicResponse(null), { text: '', toolCalls: [] });
  assert.deepEqual(brain.parseAnthropicResponse({ content: [] }), { text: '', toolCalls: [] });
  assert.deepEqual(brain.parseAnthropicResponse({ content: [{ type: 'thinking', thinking: 'x' }] }), { text: '', toolCalls: [] });
});

test('agentLoopMulti + openai: tool call round-trips with tool_call_id echo; executor runs; no key leak', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai';
  const executed = [];
  const calls = mockFetch((url, opts, n) => {
    if (n === 1) {
      return fakeResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"AGENT.md"}' } }] } }] });
    }
    return fakeResponse({ choices: [{ message: { content: 'The file says X' } }] });
  });
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async (name, args) => {
    executed.push([name, args]);
    return { ok: true, content: 'file contents here' };
  });
  assert.equal(r.usedTools, true);
  assert.equal(r.provider, 'openai');
  assert.equal(r.text, 'The file says X');
  assert.deepEqual(executed, [['read_file', { path: 'AGENT.md' }]]);
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].ok, true);
  assert.equal(calls.length, 2);
  const body1 = JSON.parse(calls[0].opts.body);
  assert.equal(body1.tools.length, brain.TOOL_DECLARATIONS.length);
  assert.equal(body1.tool_choice, 'auto');
  const body2 = JSON.parse(calls[1].opts.body);
  assert.equal(body2.messages[1].role, 'assistant');
  assert.equal(body2.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(body2.messages[2].role, 'tool');
  assert.equal(body2.messages[2].tool_call_id, 'call_1');
  assert.match(body2.messages[2].content, /file contents here/);
  assertNoKeyLeak(r, 'test-openai-key-123');
});

test('agentLoopMulti + openai: executor failure becomes an error tool result and the loop continues', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai';
  const calls = mockFetch((url, opts, n) => {
    if (n === 1) {
      return fakeResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":".env.local"}' } }] } }] });
    }
    return fakeResponse({ choices: [{ message: { content: 'sorry, denied' } }] });
  });
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => { throw new Error('denied: nope'); });
  assert.equal(r.usedTools, true);
  assert.equal(r.text, 'sorry, denied');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].ok, false);
  assert.equal(r.evidence[0].error, 'denied: nope');
  const body2 = JSON.parse(calls[1].opts.body);
  assert.equal(body2.messages[2].content, 'Error: denied: nope');
});

test('agentLoopMulti + anthropic: tool_use round-trips with tool_result blocks; schemas + max_tokens sent', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-456';
  process.env.BRAIN_PROVIDERS = 'anthropic';
  const executed = [];
  const calls = mockFetch((url, opts, n) => {
    if (n === 1) {
      return fakeResponse({ content: [{ type: 'text', text: 'Checking ' }, { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } }], stop_reason: 'tool_use' });
    }
    return fakeResponse({ content: [{ type: 'text', text: 'Found 3 files.' }], stop_reason: 'end_turn' });
  });
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async (name, args) => {
    executed.push([name, args]);
    return { ok: true, items: ['a', 'b', 'c'] };
  });
  assert.equal(r.usedTools, true);
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.text, 'Found 3 files.');
  assert.deepEqual(executed, [['list_files', { path: '.' }]]);
  assert.equal(calls.length, 2);
  const body1 = JSON.parse(calls[0].opts.body);
  assert.equal(body1.tools.length, brain.TOOL_DECLARATIONS.length);
  assert.equal(body1.tools[0].input_schema.type, 'object');
  assert.equal(body1.max_tokens, 1024);
  const body2 = JSON.parse(calls[1].opts.body);
  assert.equal(body2.messages[1].role, 'assistant');
  assert.deepEqual(body2.messages[1].content, [
    { type: 'text', text: 'Checking ' },
    { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } },
  ]);
  assert.equal(body2.messages[2].role, 'user');
  assert.equal(body2.messages[2].content[0].type, 'tool_result');
  assert.equal(body2.messages[2].content[0].tool_use_id, 'toolu_1');
  assert.match(body2.messages[2].content[0].content, /"a","b","c"/);
  assertNoKeyLeak(r, 'test-anthropic-key-456');
});

test('agentLoopMulti + anthropic: executor failure sets is_error on the tool_result', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-456';
  process.env.BRAIN_PROVIDERS = 'anthropic';
  const calls = mockFetch((url, opts, n) => {
    if (n === 1) {
      return fakeResponse({ content: [{ type: 'tool_use', id: 'toolu_7', name: 'read_file', input: { path: 'x' } }], stop_reason: 'tool_use' });
    }
    return fakeResponse({ content: [{ type: 'text', text: 'noted' }], stop_reason: 'end_turn' });
  });
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => { throw new Error('file not found'); });
  assert.equal(r.evidence[0].ok, false);
  const body2 = JSON.parse(calls[1].opts.body);
  assert.equal(body2.messages[2].content[0].is_error, true);
  assert.equal(body2.messages[2].content[0].content, 'file not found');
});

test('agentLoopMulti: respects chain order and moves to the next native provider when the first never answers', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-456';
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'anthropic,openai';
  const calls = mockFetch((url) => {
    if (url.includes('api.anthropic.com')) return fakeResponse({ error: 'boom' }, false, 500);
    return fakeResponse({ choices: [{ message: { content: 'openai here' } }] });
  });
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => ({ ok: true }));
  assert.equal(r.provider, 'openai');
  assert.equal(r.text, 'openai here');
  assert.equal(r.usedTools, true);
  assert.deepEqual(r.tried, ['anthropic', 'openai']);
  assert.equal(calls.length, 2);
});

test('agentLoopMulti: Gemini direct answers first in chain order; later providers are not called', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key-789';
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'gemini,openai';
  const calls = mockFetch(() => fakeResponse({ candidates: [{ content: { parts: [{ text: 'gemini answered' }] } }] }));
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => ({ ok: true }));
  assert.equal(r.provider, 'gemini-direct');
  assert.equal(r.text, 'gemini answered');
  assert.equal(r.usedTools, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-3\.5-flash-lite/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.tools[0].functionDeclarations.length, brain.TOOL_DECLARATIONS.length);
});

test('agentLoopMulti: falls back to the text chain when no native provider answers; executor never runs', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai';
  mockFetch(() => fakeResponse({ error: 'boom' }, false, 500));
  let executed = 0;
  let fallbackPrompt = null;
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => { executed++; return { ok: true }; }, {
    askFn: async (p) => { fallbackPrompt = p; return { text: 'fallback text', model: 'm', provider: 'ollama', tried: ['ollama'] }; },
  });
  assert.equal(r.usedTools, false);
  assert.equal(r.text, 'fallback text');
  assert.equal(r.provider, 'ollama');
  assert.deepEqual(r.evidence, []);
  assert.equal(executed, 0);
  assert.equal(fallbackPrompt, 'text prompt');
});

test('agentLoopMulti: skips keyless native providers without calling fetch', async () => {
  process.env.BRAIN_PROVIDERS = 'openai,anthropic';
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: 'must not happen' } }] }));
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => ({ ok: true }), {
    askFn: async () => ({ text: 'fallback', model: 'm', provider: 'ollama', tried: ['ollama'] }),
  });
  assert.equal(r.usedTools, false);
  assert.equal(r.text, 'fallback');
  assert.equal(calls.length, 0, 'no HTTP call may happen with no keys');
});

test('agentLoopMulti: round cap stops a model that keeps calling tools (2 rounds max)', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai';
  let executed = 0;
  const calls = mockFetch(() => fakeResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'call_r', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } }] }));
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => { executed++; return { ok: true }; });
  assert.equal(executed, 2, 'at most 2 rounds of tool calls');
  assert.equal(calls.length, 2);
  assert.equal(r.evidence.length, 2);
  assert.match(r.text, /I ran 2 tool\(s\)/);
});

test('agentLoopMulti: per-round cap executes at most 5 calls and echoes only those', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai';
  let executed = 0;
  const sixCalls = Array.from({ length: 6 }, (_, i) => ({ id: `c${i + 1}`, type: 'function', function: { name: 'list_files', arguments: '{}' } }));
  const calls = mockFetch((url, opts, n) => {
    if (n === 1) return fakeResponse({ choices: [{ message: { content: '', tool_calls: sixCalls } }] });
    return fakeResponse({ choices: [{ message: { content: 'done' } }] });
  });
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async () => { executed++; return { ok: true }; });
  assert.equal(executed, 5);
  assert.equal(r.evidence.length, 5);
  const body2 = JSON.parse(calls[1].opts.body);
  assert.equal(body2.messages[1].tool_calls.length, 5);
  assert.deepEqual(body2.messages[1].tool_calls.map(t => t.id), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('agentLoopMulti: undeclared tool calls are dropped before the executor and never echoed', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key-123';
  process.env.BRAIN_PROVIDERS = 'openai';
  const executed = [];
  const calls = mockFetch((url, opts, n) => {
    if (n === 1) {
      return fakeResponse({ choices: [{ message: {
        content: '',
        tool_calls: [
          { id: 'bad1', type: 'function', function: { name: 'send_email', arguments: '{}' } },
          { id: 'good1', type: 'function', function: { name: 'list_files', arguments: '{}' } },
        ],
      } }] });
    }
    return fakeResponse({ choices: [{ message: { content: 'done' } }] });
  });
  const r = await brain.agentLoopMulti('tools prompt', 'text prompt', async (name, args) => { executed.push(name); return { ok: true }; });
  assert.deepEqual(executed, ['list_files']);
  const body2 = JSON.parse(calls[1].opts.body);
  assert.equal(body2.messages[1].tool_calls.length, 1);
  assert.equal(body2.messages[1].tool_calls[0].id, 'good1');
  assert.equal(r.evidence.length, 1);
});
