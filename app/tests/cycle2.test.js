// Cycle 2 tests (17 Nov 2026): hash-chained audit log + run receipts,
// the eval harness (golden task set + runner + CLI), and the removal of
// 'npm test' from the shell allowlist. Live API tests run against the
// server started by tests/run-tests.sh; chain/receipt/eval checks run
// in-process against the same database the server uses.
//
// The tamper test edits one audit row and restores it in a finally block,
// so the chain is intact for every other test. The legacy-row test
// inserts and deletes its own row. Neither deletes real history.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
async function tool(name, args) {
  return api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: name, args }) });
}

const { all, get, run } = require('../db');
const { audit, verifyAuditChain, buildReceipt, renderReceiptMarkdown } = require('../audit');

// --- hash-chained audit log -------------------------------------------------
test('audit: chained entries verify, including entries written by tools', async () => {
  audit('cycle2.test', { probe: 'chain-write' }, true, 'chain probe row');
  const v = verifyAuditChain();
  assert.equal(v.ok, true, `chain failed at ${v.firstBadId}: ${v.reason}`);
  assert.ok(v.checked >= 1);
  const row = get("SELECT * FROM audit_log WHERE tool = 'cycle2.test' AND args LIKE '%chain-write%' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'probe row must exist');
  assert.ok(/^[0-9a-f]{64}$/.test(row.entry_hash), 'entry_hash is a sha256 hex string');
  assert.ok(/^[0-9a-f]{64}$/.test(row.prev_hash), 'prev_hash is a sha256 hex string');
});

test('audit: editing one entry breaks verification, restoring it fixes it', async () => {
  audit('cycle2.test', { probe: 'tamper-target' }, true, 'original result text');
  const row = get("SELECT * FROM audit_log WHERE tool = 'cycle2.test' AND args LIKE '%tamper-target%' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'tamper target row must exist');
  try {
    run('UPDATE audit_log SET result = ? WHERE id = ?', 'tampered result text', row.id);
    const v = verifyAuditChain();
    assert.equal(v.ok, false, 'tampered chain must fail verification');
    assert.equal(v.firstBadId, row.id);
    assert.match(v.reason, /hash mismatch/);
  } finally {
    run('UPDATE audit_log SET result = ? WHERE id = ?', row.result, row.id);
  }
  const restored = verifyAuditChain();
  assert.equal(restored.ok, true, 'chain must verify again after restore');
});

test('audit: pre-chain rows with NULL hashes count as legacy, not tamper', async () => {
  const r = run("INSERT INTO audit_log (tool, args, allowed, result) VALUES ('cycle2.legacy', '{}', 1, 'legacy row')");
  const id = Number(r.lastInsertRowid);
  try {
    const v = verifyAuditChain();
    assert.equal(v.ok, true);
    assert.ok(v.unchained >= 1, 'legacy row must be counted as unchained');
  } finally {
    run('DELETE FROM audit_log WHERE id = ?', id);
  }
});

// --- run receipts ------------------------------------------------------------
test('receipt: buildReceipt groups a run by run_id with done/denied split', async () => {
  const runId = `cycle2-receipt-${Date.now()}`;
  audit('cycle2.receipt', { step: 1 }, true, 'did one thing', { runId });
  audit('cycle2.receipt', { step: 2 }, true, 'did another thing', { runId });
  audit('cycle2.receipt', { step: 3 }, false, 'denied: not allowlisted', { runId });
  const receipt = buildReceipt({ runId, requested: 'cycle2 receipt probe' });
  assert.equal(receipt.run_id, runId);
  assert.equal(receipt.entries, 3);
  assert.equal(receipt.done.length, 2);
  assert.equal(receipt.denied.length, 1);
  assert.equal(receipt.requested, 'cycle2 receipt probe');
  assert.equal(receipt.chain_ok, true);
});

test('receipt: markdown render names the run, counts, and both sections', async () => {
  const runId = `cycle2-receipt-md-${Date.now()}`;
  audit('cycle2.receipt', {}, true, 'done thing', { runId });
  audit('cycle2.receipt', {}, false, 'denied thing', { runId });
  const md = renderReceiptMarkdown(buildReceipt({ runId }));
  assert.match(md, /Run receipt/);
  assert.match(md, new RegExp(runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(md, /## Done/);
  assert.match(md, /## Denied/);
  assert.match(md, /done thing/);
  assert.match(md, /denied thing/);
});

// --- audit API ---------------------------------------------------------------
test('api: GET /api/audit/verify reports the chain status', async () => {
  const r = await api('/api/audit/verify');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.checked, 'number');
  assert.equal(typeof r.body.unchained, 'number');
});

test('api: GET /api/audit/receipt returns JSON by default and Markdown with format=md', async () => {
  const runId = `cycle2-receipt-api-${Date.now()}`;
  audit('cycle2.receipt', {}, true, 'api receipt probe', { runId });
  const j = await api(`/api/audit/receipt?run_id=${runId}`);
  assert.equal(j.status, 200);
  assert.equal(j.body.receipt.run_id, runId);
  assert.equal(j.body.receipt.entries, 1);
  const m = await api(`/api/audit/receipt?run_id=${runId}&format=md`);
  assert.equal(m.status, 200);
  assert.match(m.text, /Run receipt/);
  assert.match(m.text, /api receipt probe/);
});

test('tools: recent_activity rows carry the chain hash prefix', async () => {
  const r = await tool('recent_activity', { limit: 5 });
  assert.equal(r.status, 200);
  assert.ok(r.body.activity.length >= 1);
  for (const row of r.body.activity) {
    assert.ok('hash' in row, 'each row carries a hash field (null for legacy rows)');
    assert.ok(row.hash === null || /^[0-9a-f]{12}$/.test(row.hash));
  }
});

// --- eval harness --------------------------------------------------------------
test('eval: golden set passes twice in-process with identical outcomes', async () => {
  const { runGoldenSet } = require('../eval-runner');
  const { GOLDEN_TASKS } = require('../eval-tasks');
  assert.ok(GOLDEN_TASKS.length >= 10, `golden set has ${GOLDEN_TASKS.length} tasks, need >= 10`);
  const first = await runGoldenSet({ repeat: 2, skip: ['freeze-gate'] });
  assert.equal(first.totals.failed, 0, JSON.stringify(first.tasks.filter(t => t.failed)));
  assert.equal(first.deterministic, true);
  const second = await runGoldenSet({ repeat: 2, skip: ['freeze-gate'] });
  assert.deepEqual(
    second.tasks.map(t => [t.id, t.passed]),
    first.tasks.map(t => [t.id, t.passed]),
    'two harness runs must give the same per-task outcome');
  assert.deepEqual(first.skipped, ['freeze-gate']);
});

test('eval: a failing task is reported, not fatal, and breaks determinism honestly', async () => {
  const { runGoldenSet } = require('../eval-runner');
  let calls = 0;
  const flaky = {
    id: 'flaky-fixture', name: 'fixture: fails once, then passes',
    async run() { calls++; if (calls === 1) throw new Error('fixture failure'); },
  };
  const report = await runGoldenSet({ repeat: 2, tasks: [flaky] });
  assert.equal(report.totals.failed, 1);
  assert.equal(report.tasks[0].passes, 1);
  assert.match(report.tasks[0].errors[0], /fixture failure/);
  assert.equal(report.deterministic, false, 'mixed outcomes must not be called deterministic');
});

test('eval: CLI runs the full set in a throwaway sandbox, exit 0, 20/20', async () => {
  const out = await new Promise((resolve, reject) => {
    execFile('node', ['scripts/run-eval.js', '--repeat=1'], {
      cwd: path.join(__dirname, '..'), timeout: 60000, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`run-eval failed: ${err.message}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
  });
  const report = JSON.parse(out);
  assert.equal(report.totals.tasks, 20);
  assert.equal(report.totals.passed, 20);
  assert.equal(report.totals.failed, 0);
  assert.ok(report.tasks.some(t => t.id === 'freeze-gate' && t.passed), 'CLI runs the freeze task too');
  assert.ok(report.tasks.some(t => t.id === 'memory-contradiction' && t.passed), 'CLI runs the memory tasks too');
});

// --- npm test removal from the shell allowlist ---------------------------------
test('tools: run_command refuses npm test; run_tests is the sanctioned path', async () => {
  const { ALLOWED_COMMANDS } = require('../tools');
  assert.ok(!('npm test' in ALLOWED_COMMANDS), 'npm test must not be allowlisted');
  assert.equal(Object.keys(ALLOWED_COMMANDS).length, 6);
  const r = await tool('run_command', { command: 'npm test' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /denied/);
  const { TOOL_DECLARATIONS } = require('../brain');
  assert.ok(TOOL_DECLARATIONS.some(d => d.name === 'run_tests'), 'run_tests tool still declared');
  const rc = TOOL_DECLARATIONS.find(d => d.name === 'run_command');
  assert.ok(!rc.parameters.properties.command.description.includes('npm test'),
    'run_command declaration must not advertise npm test');
});
