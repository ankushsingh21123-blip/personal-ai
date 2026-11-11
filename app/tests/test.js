// Real tests for Ankush's personal AI — run against a LIVE server, no mocks.
// Usage: ANKU_TOKEN=<token> PORT=3100 node --test tests/test.js
// Run via: bash tests/run-tests.sh  (starts the server, runs these, stops it)
// Every test names the model/provider that actually answered, where a model is used.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

test('health: server is up, no auth needed', async () => {
  const r = await fetch(BASE + '/api/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.service, 'ankush-personal-ai');
});

test('cyber: auth rejected without token', async () => {
  const r = await fetch(BASE + '/api/status');
  assert.equal(r.status, 401);
});

test('cyber: auth rejected with wrong token', async () => {
  const r = await fetch(BASE + '/api/status', { headers: { 'X-Anku-Token': 'wrong-token' } });
  assert.equal(r.status, 401);
});

test('status: brain order + wired components reported', async () => {
  const { status, body } = await api('/api/status');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.brain_order) && body.brain_order[0].includes('gemini'));
  assert.ok('openclaw_gateway_up' in body);
  assert.ok('goose_version' in body);
  assert.ok(body.counts);
});

test('brain: Gemini primary answers for real (Flash-Lite first, 3.6 fallback)', async () => {
  const { status, body } = await api('/api/brain/test', {
    method: 'POST', body: JSON.stringify({ provider: 'gemini-vm-helper' }),
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(['gemini-3.5-flash-lite', 'gemini-3.6-flash'].includes(body.model), `unexpected model ${body.model}`);
  assert.equal(body.provider, 'gemini-vm-helper');
  assert.match(body.text, /OK/i);
});

test('brain: Ollama local fallback answers for real (qwen3:0.6b on this VM)', async () => {
  const { status, body } = await api('/api/brain/test', {
    method: 'POST', body: JSON.stringify({ provider: 'ollama' }),
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.provider, 'ollama');
  assert.ok(body.text && body.text.length > 0, 'Ollama returned empty text');
});

test('chat: perceive -> reason (Gemini) -> act, job + message persisted in SQLite', async () => {
  const { status, body } = await api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ text: 'List the files in the workspace, then in one sentence say what this agent is for. Answer from AGENT.md.' }),
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.reply && body.reply.length > 10);
  assert.ok(body.model, 'no model recorded');
  assert.ok(body.job_id, 'no job id');
  const jobs = await api('/api/jobs');
  assert.ok(jobs.body.jobs.some(j => j.id === body.job_id && j.status === 'done'));
  const msgs = await api('/api/messages');
  assert.ok(msgs.body.messages.some(m => m.role === 'assistant' && m.model === body.model));
});

test('tools: read_file works, write_note persists', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'read_file', args: { path: 'AGENT.md' } }) });
  assert.equal(r.status, 200);
  assert.match(r.body.content, /Ankush/);
  const n = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'write_note', args: { title: 'test-note', body: 'test run' } }) });
  assert.equal(n.status, 200);
  assert.ok(n.body.note_id);
});

test('cyber: path traversal blocked', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'read_file', args: { path: '../../etc/passwd' } }) });
  assert.equal(r.status, 403);
});

test('cyber: secret file blocked (.env.local)', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'read_file', args: { path: '.env.local' } }) });
  assert.equal(r.status, 403);
});

test('cyber: dangerous shell command denied, never executed', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'run_command', args: { command: 'rm -rf /' } }) });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /denied/);
});

test('cyber: send/post tool denied — approval only', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'send_email', args: { to: 'x@example.com' } }) });
  assert.equal(r.status, 403);
  const a = await api('/api/approvals', { method: 'POST', body: JSON.stringify({ action: 'send email', details: 'Draft to x@example.com — test only' }) });
  assert.equal(a.status, 200);
  assert.equal(a.body.status, 'pending');
  const d = await api(`/api/approvals/${a.body.approval_id}/decide`, { method: 'POST', body: JSON.stringify({ status: 'approved' }) });
  assert.equal(d.status, 200);
  assert.equal(d.body.executed, false, 'approving must NOT execute a send');
});

test('tools: edit_file with backup, then restore', async () => {
  const fs2 = require('fs');
  const p = require('path');
  const os = require('os');
  const notePath = 'tests/_edit-test.txt';
  const full = p.join(os.homedir(), 'workspace', 'personal-ai', notePath);
  fs2.writeFileSync(full, 'hello world\n', 'utf8');
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'edit_file', args: { path: notePath, old_text: 'hello', new_text: 'hello Ankush' } }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fs2.existsSync(full + '.bak'));
  const read = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'read_file', args: { path: notePath } }) });
  assert.match(read.body.content, /hello Ankush/);
  fs2.unlinkSync(full);
  fs2.unlinkSync(full + '.bak');
});

test('tools: web_fetch reads a real https page, text only', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'web_fetch', args: { url: 'https://example.com' } }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Example Domain/);
});

test('cyber: web_fetch blocks private/local URLs', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'web_fetch', args: { url: 'http://127.0.0.1:3100/api/health' } }) });
  assert.equal(r.status, 403);
});

test('cyber: symlink escape blocked (H2 regression)', async () => {
  const fs2 = require('fs');
  const p = require('path');
  const os = require('os');
  const link = p.join(os.homedir(), 'workspace', 'personal-ai', 'tests', '_link-test.txt');
  try { fs2.unlinkSync(link); } catch {}
  fs2.symlinkSync('/etc/passwd', link);
  try {
    const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'read_file', args: { path: 'tests/_link-test.txt' } }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  } finally { fs2.unlinkSync(link); }
});

test('cyber: SQLite DB file cannot be read via tools (audit M)', async () => {
  const r = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'read_file', args: { path: 'data/personal-ai.db' } }) });
  assert.equal(r.status, 403);
});

test('frontend: index page served', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Ankush's Personal AI/);
});
