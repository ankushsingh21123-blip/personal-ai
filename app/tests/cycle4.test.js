// Cycle 4 tests (18 Nov 2026): Memory v2 — timestamped facts, FTS5
// recall with citations, contradiction history, hard-delete forget,
// edit-with-history, and strict per-scope isolation.
//
// Unit checks run against the real database through memory.js, but every
// fact uses a random `c4-*` scope that the after() hook deletes, so no
// test residue survives in the real DB. Live API checks run against the
// server started by tests/run-tests.sh on random scopes too. No test
// touches the default scope's real facts.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = process.env.ANKU_TOKEN || '';
if (!TOKEN) {
  const envPath = path.join(__dirname, '..', '.env.local');
  const m = fs.readFileSync(envPath, 'utf8').match(/ANKU_TOKEN=(\S+)/);
  TOKEN = m ? m[1] : '';
}
const H = { 'Content-Type': 'application/json', 'X-Anku-Token': TOKEN };
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { _text: text }; }
  return { status: r.status, body: j, text };
}

const memory = require('../memory');
const db = require('../db');
const { SYNC_TABLES } = require('../sync');
const { TOOL_DECLARATIONS, openaiTools, anthropicTools } = require('../brain');
const tools = require('../tools');

const SCOPES = [];
function newScope() {
  const s = `c4-${crypto.randomBytes(4).toString('hex')}`;
  SCOPES.push(s);
  return s;
}
test.after(() => {
  for (const s of SCOPES) {
    try { db.run('DELETE FROM memory_facts WHERE scope = ?', s); } catch {}
  }
});

// --- store + recall -----------------------------------------------------------
test('memory: remember + recall returns the fact with citation fields', () => {
  const scope = newScope();
  const r = memory.remember({ scope, topic: 'city', content: 'Ankush lives in Bengaluru', source: 'chat' });
  assert.equal(r.duplicate, false);
  assert.deepEqual(r.superseded, []);
  const back = memory.recall({ scope, query: 'Bengaluru' });
  assert.equal(back.facts.length, 1);
  const f = back.facts[0];
  assert.equal(f.id, r.id);
  assert.equal(f.content, 'Ankush lives in Bengaluru');
  assert.equal(f.scope, scope);
  assert.equal(f.topic, 'city');
  assert.equal(f.source, 'chat');
  assert.equal(f.status, 'current');
  assert.ok(f.created_at, 'citation must include created_at');
  assert.deepEqual(f.history, []);
});

test('memory: empty query returns the most recent facts in scope', () => {
  const scope = newScope();
  memory.remember({ scope, content: 'first remembered thing' });
  memory.remember({ scope, content: 'second remembered thing' });
  const back = memory.recall({ scope, query: '' });
  assert.equal(back.facts.length, 2);
  assert.equal(back.facts[0].content, 'second remembered thing');
});

test('memory: identical re-remember is a no-op returning the existing id', () => {
  const scope = newScope();
  const a = memory.remember({ scope, topic: 'dup', content: 'same words here' });
  const b = memory.remember({ scope, topic: 'dup', content: 'same words here' });
  assert.equal(b.id, a.id);
  assert.equal(b.duplicate, true);
  assert.equal(memory.listFacts({ scope }).length, 1);
});

// --- contradictions ------------------------------------------------------------
test('memory: newer fact supersedes the old one; recall shows new + history', () => {
  const scope = newScope();
  const old = memory.remember({ scope, topic: 'phone', content: 'phone is 111', source: 'chat' });
  const next = memory.remember({ scope, topic: 'phone', content: 'phone is 222', source: 'chat' });
  assert.deepEqual(next.superseded, [old.id]);
  const back = memory.recall({ scope, query: 'phone' });
  assert.equal(back.facts.length, 1, 'superseded facts must not surface as answers');
  assert.equal(back.facts[0].content, 'phone is 222');
  assert.equal(back.facts[0].history.length, 1);
  assert.equal(back.facts[0].history[0].content, 'phone is 111');
  assert.equal(back.facts[0].history[0].id, old.id);
  // History is kept in the store, visible with includeSuperseded.
  const allRows = memory.listFacts({ scope, includeSuperseded: true });
  assert.equal(allRows.length, 2);
  const superseded = allRows.find(r => r.id === old.id);
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.superseded_by, next.id);
});

test('memory: facts without a topic never supersede each other', () => {
  const scope = newScope();
  memory.remember({ scope, content: 'untopicked fact one' });
  memory.remember({ scope, content: 'untopicked fact two' });
  assert.equal(memory.listFacts({ scope }).length, 2);
});

// --- forget --------------------------------------------------------------------
test('memory: forget by id removes the fact from recall and list', () => {
  const scope = newScope();
  const r = memory.remember({ scope, topic: 'gone', content: 'this fact will be forgotten' });
  assert.equal(memory.recall({ scope, query: 'forgotten' }).facts.length, 1);
  const gone = memory.forget({ scope, id: r.id });
  assert.equal(gone.forgotten, 1);
  assert.equal(memory.recall({ scope, query: 'forgotten' }).facts.length, 0);
  assert.equal(memory.listFacts({ scope, includeSuperseded: true }).length, 0);
  assert.equal(memory.forget({ scope, id: r.id }).forgotten, 0, 'second forget reports nothing');
});

test('memory: forget by topic removes all versions of the topic', () => {
  const scope = newScope();
  memory.remember({ scope, topic: 'wipe', content: 'wipe version one' });
  memory.remember({ scope, topic: 'wipe', content: 'wipe version two' });
  memory.remember({ scope, topic: 'keep', content: 'keep this fact' });
  const gone = memory.forget({ scope, topic: 'wipe' });
  assert.equal(gone.forgotten, 2);
  assert.equal(memory.recall({ scope, query: 'wipe' }).facts.length, 0);
  assert.equal(memory.recall({ scope, query: 'keep' }).facts.length, 1);
});

test('memory: forget needs exactly one of id or topic', () => {
  const scope = newScope();
  assert.throws(() => memory.forget({ scope }), /exactly one/);
  assert.throws(() => memory.forget({ scope, id: 1, topic: 'x' }), /exactly one/);
});

// --- edit ----------------------------------------------------------------------
test('memory: edit updates recall and keeps the old wording as history', () => {
  const scope = newScope();
  const r = memory.remember({ scope, topic: 'title', content: 'old job title here' });
  const e = memory.editFact({ scope, id: r.id, content: 'new job title here' });
  assert.equal(e.unchanged, false);
  assert.equal(e.previous_id, r.id);
  const back = memory.recall({ scope, query: 'title' });
  assert.equal(back.facts.length, 1);
  assert.equal(back.facts[0].content, 'new job title here');
  assert.equal(back.facts[0].id, e.id);
  assert.equal(back.facts[0].history.length, 1);
  assert.equal(back.facts[0].history[0].content, 'old job title here');
});

test('memory: editing a superseded fact or a no-op edit is refused/harmless', () => {
  const scope = newScope();
  const old = memory.remember({ scope, topic: 'role', content: 'role one' });
  memory.remember({ scope, topic: 'role', content: 'role two' });
  assert.throws(() => memory.editFact({ scope, id: old.id, content: 'role three' }), /only a current fact/);
  const current = memory.recall({ scope, query: 'role' }).facts[0];
  const noop = memory.editFact({ scope, id: current.id, content: 'role two' });
  assert.equal(noop.unchanged, true);
  assert.equal(noop.id, current.id);
});

// --- scope isolation -------------------------------------------------------------
test('memory: facts are invisible outside their scope (recall, list, edit, forget)', () => {
  const a = newScope();
  const b = newScope();
  const r = memory.remember({ scope: a, topic: 'secret', content: 'scope A only fact' });
  assert.equal(memory.recall({ scope: b, query: 'scope' }).facts.length, 0);
  assert.equal(memory.recall({ scope: b, query: '' }).facts.length, 0);
  assert.equal(memory.listFacts({ scope: b }).length, 0);
  assert.throws(() => memory.editFact({ scope: b, id: r.id, content: 'tampered' }), /not found/);
  assert.equal(memory.forget({ scope: b, id: r.id }).forgotten, 0);
  assert.equal(memory.forget({ scope: b, topic: 'secret' }).forgotten, 0);
  assert.equal(memory.recall({ scope: a, query: 'scope' }).facts.length, 1, 'scope A fact untouched');
});

// --- validation + hostile input ----------------------------------------------------
test('memory: invalid input is rejected', () => {
  const scope = newScope();
  assert.throws(() => memory.remember({ scope, content: '' }), /content required/);
  assert.throws(() => memory.remember({ scope, content: 'x'.repeat(2001) }), /capped/);
  assert.throws(() => memory.remember({ scope, topic: 't'.repeat(101), content: 'ok' }), /capped/);
  assert.throws(() => memory.remember({ scope: 'BAD SCOPE!', content: 'ok' }), /invalid scope/);
  assert.throws(() => memory.remember({ scope: 'a/b', content: 'ok' }), /invalid scope/);
  assert.throws(() => memory.recall({ scope: 'BAD SCOPE!' }), /invalid scope/);
});

test('memory: hostile FTS5 query text cannot break recall or leak rows', () => {
  const scope = newScope();
  memory.remember({ scope, content: 'plain fact about cats' });
  for (const q of ['" OR 1=1 --', 'cats OR *', '(', 'NEAR(cats dogs)', 'cats: *', '   ', '%%%%']) {
    const back = memory.recall({ scope, query: q });
    assert.ok(Array.isArray(back.facts), `query ${JSON.stringify(q)} must return an array`);
    assert.ok(back.facts.length <= 1, 'hostile query must not dump extra rows');
  }
});

// --- never synced, never logged ------------------------------------------------------
test('memory: memory_facts is not a synced table', () => {
  assert.ok(!SYNC_TABLES.includes('memory_facts'), 'memory must never sync');
  assert.ok(!SYNC_TABLES.includes('memory_facts_fts'), 'memory FTS index must never sync');
});

test('memory: tool audit rows carry metadata only, never fact content', async () => {
  const scope = newScope();
  const marker = `marker-${crypto.randomBytes(6).toString('hex')}`;
  await tools.execute('remember_fact', { scope, topic: 'auditcheck', content: `fact with ${marker} inside` });
  const rows = db.all(`SELECT args, result FROM audit_log WHERE tool = 'remember_fact' ORDER BY id DESC LIMIT 5`);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.ok(!String(row.args).includes(marker), 'fact content must not appear in audit args');
    assert.ok(!String(row.result).includes(marker), 'fact content must not appear in audit result');
  }
});

// --- tools + declarations ------------------------------------------------------------
test('memory: four memory tools are declared and derived for OpenAI + Anthropic', () => {
  const names = TOOL_DECLARATIONS.map(d => d.name);
  for (const n of ['remember_fact', 'recall_memory', 'forget_fact', 'edit_fact']) {
    assert.ok(names.includes(n), `${n} must be declared`);
  }
  assert.equal(TOOL_DECLARATIONS.length, 28, '24 tools + 4 memory tools');
  const oa = openaiTools().map(t => t.function.name);
  const an = anthropicTools().map(t => t.name);
  for (const n of ['remember_fact', 'recall_memory', 'forget_fact', 'edit_fact']) {
    assert.ok(oa.includes(n), `OpenAI schema must include ${n}`);
    assert.ok(an.includes(n), `Anthropic schema must include ${n}`);
  }
});

test('memory: tool round-trip remember -> recall -> edit -> forget', async () => {
  const scope = newScope();
  const r = await tools.execute('remember_fact', { scope, topic: 'roundtrip', content: 'roundtrip fact v1', source: 'test' });
  assert.equal(r.ok, true);
  const back = await tools.execute('recall_memory', { scope, query: 'roundtrip' });
  assert.equal(back.facts[0].content, 'roundtrip fact v1');
  const e = await tools.execute('edit_fact', { scope, id: r.fact_id, content: 'roundtrip fact v2' });
  assert.equal(e.ok, true);
  const back2 = await tools.execute('recall_memory', { scope, query: 'roundtrip' });
  assert.equal(back2.facts[0].content, 'roundtrip fact v2');
  const gone = await tools.execute('forget_fact', { scope, id: e.fact_id });
  assert.equal(gone.forgotten, 1);
  const back3 = await tools.execute('recall_memory', { scope, query: 'roundtrip' });
  assert.equal(back3.facts.length, 0);
});

// --- live API ----------------------------------------------------------------------
test('memory API: POST/GET/PUT/DELETE round-trip on a random scope', async () => {
  const scope = newScope();
  const created = await api('/api/memory', { method: 'POST', body: JSON.stringify({ scope, topic: 'api', content: 'api fact v1' }) });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.body.ok, true);
  const listed = await api(`/api/memory?scope=${scope}`);
  assert.equal(listed.body.facts.length, 1);
  assert.equal(listed.body.facts[0].content, 'api fact v1');
  const edited = await api(`/api/memory/${created.body.fact_id}`, { method: 'PUT', body: JSON.stringify({ scope, content: 'api fact v2' }) });
  assert.equal(edited.status, 200, edited.text);
  const listed2 = await api(`/api/memory?scope=${scope}`);
  assert.equal(listed2.body.facts[0].content, 'api fact v2');
  const history = await api(`/api/memory?scope=${scope}&include_superseded=1`);
  assert.equal(history.body.facts.length, 2, 'superseded history visible via API');
  const deleted = await api(`/api/memory/${edited.body.fact_id}?scope=${scope}`, { method: 'DELETE' });
  assert.equal(deleted.body.forgotten, 1);
  const listed3 = await api(`/api/memory?scope=${scope}`);
  assert.equal(listed3.body.facts.length, 0);
});

test('memory API: validation errors are 400 and unauthenticated reads are 401', async () => {
  const scope = newScope();
  const bad = await api('/api/memory', { method: 'POST', body: JSON.stringify({ scope, content: '' }) });
  assert.equal(bad.status, 400);
  const badScope = await api('/api/memory?scope=BAD%20SCOPE', {});
  assert.equal(badScope.status, 400);
  const noAuth = await fetch(BASE + `/api/memory?scope=${scope}`);
  assert.equal(noAuth.status, 401);
});
