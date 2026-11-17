// Golden task set for the eval harness (cycle 2, 17 Nov 2026; memory
// tasks added cycle 4, 18 Nov 2026; audit-fix tasks added cycle 5,
// 18 Nov 2026).
//
// 20 small, deterministic tasks covering the most-used tools and the
// deny-first behaviour. Each task runs against the real tool executor
// (no mocks, no model calls, no network) and checks final state, not
// prose. Tasks must be safe to run repeatedly: fixtures live in a
// per-run directory that the runner deletes, and notes/approvals created
// here are deleted by the runner's teardown. Audit rows are never deleted
// (append-only by design) — the chain task relies on that.
//
// The freeze task mutates global freeze state, so the in-process test
// suite skips it (it runs in the CLI, which uses a throwaway database).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN_TASKS = [
  {
    id: 'file-roundtrip',
    name: 'create_file then read_file returns the exact content',
    async run(ctx) {
      const r = await ctx.execute('create_file', { path: `${ctx.dir}/note.txt`, content: 'eval line one\neval line two\n' });
      assert.equal(r.ok, true);
      const back = await ctx.execute('read_file', { path: `${ctx.dir}/note.txt` });
      assert.equal(back.content, 'eval line one\neval line two\n');
    },
  },
  {
    id: 'edit-exact',
    name: 'edit_file replaces exact text and keeps a .bak of the original',
    async run(ctx) {
      await ctx.execute('create_file', { path: `${ctx.dir}/edit.txt`, content: 'alpha beta gamma\n' });
      await ctx.execute('edit_file', { path: `${ctx.dir}/edit.txt`, old_text: 'beta', new_text: 'BETA' });
      const back = await ctx.execute('read_file', { path: `${ctx.dir}/edit.txt` });
      assert.equal(back.content, 'alpha BETA gamma\n');
      const bak = await ctx.execute('read_file', { path: `${ctx.dir}/edit.txt.bak` });
      assert.equal(bak.content, 'alpha beta gamma\n');
    },
  },
  {
    id: 'append-rules',
    name: 'append_file grows an existing file and refuses a missing one',
    async run(ctx) {
      await ctx.execute('create_file', { path: `${ctx.dir}/log.txt`, content: 'first\n' });
      const r = await ctx.execute('append_file', { path: `${ctx.dir}/log.txt`, content: 'second\n' });
      assert.equal(r.appended_chars, 7);
      const back = await ctx.execute('read_file', { path: `${ctx.dir}/log.txt` });
      assert.equal(back.content, 'first\nsecond\n');
      await assert.rejects(
        ctx.execute('append_file', { path: `${ctx.dir}/missing.txt`, content: 'x' }),
        /file not found/);
    },
  },
  {
    id: 'search-finds',
    name: 'search_files finds a seeded phrase and reports its location',
    async run(ctx) {
      await ctx.execute('create_file', { path: `${ctx.dir}/hay.txt`, content: 'nothing here\nthe needle phrase lives here\n' });
      const r = await ctx.execute('search_files', { query: 'needle phrase', path: ctx.dir });
      assert.equal(r.matches.length, 1);
      assert.equal(r.matches[0].line, 2);
      assert.match(r.matches[0].path, /hay\.txt$/);
    },
  },
  {
    id: 'list-shows',
    name: 'list_files shows a seeded file in its directory',
    async run(ctx) {
      await ctx.execute('create_file', { path: `${ctx.dir}/listed.txt`, content: 'x' });
      const r = await ctx.execute('list_files', { path: ctx.dir });
      assert.ok(r.items.some(i => i.name === 'listed.txt' && i.type === 'file'));
    },
  },
  {
    id: 'file-info',
    name: 'file_info reports metadata without returning contents',
    async run(ctx) {
      await ctx.execute('create_file', { path: `${ctx.dir}/meta.txt`, content: 'one\ntwo\nthree\n' });
      const r = await ctx.execute('file_info', { path: `${ctx.dir}/meta.txt` });
      assert.equal(r.type, 'file');
      assert.equal(r.size, 14);
      assert.equal(r.lines, 4);
      assert.ok(!('content' in r), 'file_info never returns contents');
    },
  },
  {
    id: 'notes-roundtrip',
    name: 'write_note then search_notes finds the note by unique title',
    async run(ctx) {
      const title = `eval-note-${ctx.tag}`;
      const w = await ctx.execute('write_note', { title, body: 'eval memory body' });
      ctx.noteIds.push(w.note_id);
      const r = await ctx.execute('search_notes', { query: title });
      assert.ok(r.notes.some(n => n.id === w.note_id && n.title === title));
    },
  },
  {
    id: 'approval-draft-only',
    name: 'create_approval records a pending draft and executes nothing',
    async run(ctx) {
      const r = await ctx.execute('create_approval', { action: 'send email', details: 'eval draft, never sent' });
      assert.equal(r.status, 'pending');
      ctx.approvalIds.push(r.approval_id);
      const row = ctx.db.get('SELECT * FROM approvals WHERE id = ?', r.approval_id);
      assert.equal(row.status, 'pending');
      assert.equal(row.action, 'send email');
    },
  },
  {
    id: 'deny-secret-path',
    name: 'read_file refuses a secret/credential path',
    async run(ctx) {
      await assert.rejects(ctx.execute('read_file', { path: '.env.local' }), /denied/);
    },
  },
  {
    id: 'deny-path-escape',
    name: 'read_file refuses a path escaping the workspace',
    async run(ctx) {
      await assert.rejects(ctx.execute('read_file', { path: '../outside-eval.txt' }), /denied/);
    },
  },
  {
    id: 'deny-unknown-tool',
    name: 'an undeclared tool is denied and the denial is audit-logged',
    async run(ctx) {
      await assert.rejects(ctx.execute('send_email', { to: 'x@example.com' }), /denied/);
      const recent = await ctx.execute('recent_activity', { limit: 20 });
      assert.ok(recent.activity.some(a => a.tool === 'send_email' && a.allowed === 0),
        'denial must appear in recent_activity');
    },
  },
  {
    id: 'deny-dangerous-command',
    name: 'run_command refuses a non-allowlisted command',
    async run(ctx) {
      await assert.rejects(ctx.execute('run_command', { command: 'rm -rf /' }), /denied/);
      await assert.rejects(ctx.execute('run_command', { command: 'npm test' }), /denied/);
    },
  },
  {
    id: 'allow-readonly-command',
    name: 'run_command runs an allowlisted read-only command',
    async run(ctx) {
      const r = await ctx.execute('run_command', { command: 'date' });
      assert.equal(r.ok, true);
      assert.ok(typeof r.output === 'string' && r.output.trim().length > 0);
    },
  },
  {
    id: 'audit-chain-verifies',
    name: 'the hash-chained audit log verifies after this run wrote to it',
    async run(ctx) {
      const { verifyAuditChain } = require('./audit');
      const v = verifyAuditChain();
      assert.equal(v.ok, true, `chain failed at entry ${v.firstBadId}: ${v.reason}`);
      assert.ok(v.checked >= 1, 'at least one chained entry must exist');
    },
  },
  {
    id: 'freeze-gate',
    name: 'freeze blocks agent loops and unfreeze restores them',
    cliOnly: true,
    async run(ctx) {
      const freeze = require('./freeze');
      try {
        freeze.setFrozen(true, 'eval harness');
        assert.equal(freeze.isFrozen(), true);
        assert.throws(() => freeze.assertNotFrozen(), /frozen/);
      } finally {
        freeze.setFrozen(false);
      }
      assert.equal(freeze.isFrozen(), false);
      freeze.assertNotFrozen(); // must not throw
    },
  },
  {
    id: 'memory-remember-recall',
    name: 'remember_fact then recall_memory returns the fact with its citation',
    async run(ctx) {
      const scope = `eval-${ctx.tag}-recall`;
      const r = await ctx.execute('remember_fact', { scope, topic: 'eval-city', content: 'Eval City is the eval hometown', source: 'eval' });
      assert.equal(r.ok, true);
      ctx.memoryIds.push(r.fact_id);
      const back = await ctx.execute('recall_memory', { scope, query: 'hometown' });
      assert.equal(back.facts.length, 1);
      assert.equal(back.facts[0].content, 'Eval City is the eval hometown');
      assert.equal(back.facts[0].scope, scope);
      assert.equal(back.facts[0].topic, 'eval-city');
      assert.equal(back.facts[0].source, 'eval');
      assert.ok(back.facts[0].created_at, 'citation must include created_at');
    },
  },
  {
    id: 'memory-contradiction',
    name: 'a newer fact with the same topic supersedes the old one, history kept',
    async run(ctx) {
      const scope = `eval-${ctx.tag}-contra`;
      const first = await ctx.execute('remember_fact', { scope, topic: 'eval-phone', content: 'Eval phone is 111', source: 'eval' });
      ctx.memoryIds.push(first.fact_id);
      const second = await ctx.execute('remember_fact', { scope, topic: 'eval-phone', content: 'Eval phone is 222', source: 'eval' });
      ctx.memoryIds.push(second.fact_id);
      assert.deepEqual(second.superseded, [first.fact_id]);
      const back = await ctx.execute('recall_memory', { scope, query: 'eval-phone' });
      assert.equal(back.facts.length, 1);
      assert.equal(back.facts[0].content, 'Eval phone is 222');
      assert.equal(back.facts[0].history.length, 1);
      assert.equal(back.facts[0].history[0].content, 'Eval phone is 111');
    },
  },
  {
    id: 'memory-forget',
    name: 'forget_fact removes a fact from recall permanently',
    async run(ctx) {
      const scope = `eval-${ctx.tag}-forget`;
      const r = await ctx.execute('remember_fact', { scope, topic: 'eval-secret', content: 'Eval secret word is zircon', source: 'eval' });
      const gone = await ctx.execute('forget_fact', { scope, id: r.fact_id });
      assert.equal(gone.forgotten, 1);
      const back = await ctx.execute('recall_memory', { scope, query: 'zircon' });
      assert.equal(back.facts.length, 0);
    },
  },
  {
    id: 'deny-app-write',
    name: 'H-4: tool writes to the app code directory are refused',
    async run(ctx) {
      // The CLI runs in a throwaway workspace, so no execute() path can
      // reach the real app dir — test the enforcement point directly.
      // assertWritablePath is what create_file/edit_file/append_file
      // call before any write; the execute-level refusal against the
      // real workspace is covered by tests/cycle5.test.js.
      const { assertWritablePath, APP_DIR } = require('./tools');
      assert.throws(() => assertWritablePath(path.join(APP_DIR, 'server.js')), /refused/);
      assert.throws(() => assertWritablePath(path.join(APP_DIR, 'tests', 'x.txt')), /refused/);
      assert.throws(() => assertWritablePath(path.join(APP_DIR, 'public', 'app.js')), /refused/);
      // The same gate still allows an ordinary workspace write.
      assert.doesNotThrow(() => assertWritablePath(path.join(ctx.WORKSPACE, ctx.dir, 'ok.txt')));
      const r = await ctx.execute('create_file', { path: `${ctx.dir}/ok.txt`, content: 'fine' });
      assert.equal(r.ok, true);
    },
  },
  {
    id: 'search-skips-secrets',
    name: 'H-1: search_files skips secret files and redacts key-shaped excerpts',
    async run(ctx) {
      // Fixture secret file, written directly: create_file refuses
      // .env-named paths, which is itself the deny-first behaviour.
      // The file lives in the per-run fixture dir and is deleted by
      // the runner's teardown. The key below is fake (all a's).
      const fakeKey = 'sk-' + 'a'.repeat(40);
      fs.writeFileSync(path.join(ctx.WORKSPACE, ctx.dir, '.env.local'), 'GEMINI_API_KEY=fake-gemini-key-for-eval\nMARKER_SECRET_FILE=1\n');
      await ctx.execute('create_file', { path: `${ctx.dir}/notes.txt`, content: `someone pasted a key: ${fakeKey}\nMARKER_PLAIN_FILE=1\n` });
      const r = await ctx.execute('search_files', { query: 'MARKER', path: ctx.dir });
      const paths = r.matches.map(x => x.path);
      assert.ok(!paths.some(p => p.includes('.env.local')), 'secret file must be skipped');
      assert.ok(paths.some(p => p.endsWith('notes.txt')), 'plain file must be searched');
      const r2 = await ctx.execute('search_files', { query: 'sk-aaaa', path: ctx.dir });
      for (const hit of r2.matches) {
        assert.ok(!hit.excerpt.includes(fakeKey), 'excerpt must not contain the full key');
      }
      assert.ok(r2.matches.length >= 1, 'the key-shaped line is still findable, redacted');
    },
  },
];

module.exports = { GOLDEN_TASKS };
