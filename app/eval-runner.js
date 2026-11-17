// Eval runner (cycle 2, 17 Nov 2026).
//
// Runs the golden task set (eval-tasks.js) against the real tool
// executor, directly in-process — no model, no network, no mocks — and
// reports pass/fail per task. Repeat runs must give the same per-task
// outcome: the report's `deterministic` field is true only when every
// task passed every repetition or failed every repetition.
//
// The runner is deliberately boring: fixed fixtures, fixed assertions,
// final-state checks. It proves the harness and tools behave, not that
// any model is smart. Model/provider behaviour is covered by the
// provider unit tests and the live chat tests in tests/.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function runGoldenSet({ repeat = 1, skip = [], tasks = null } = {}) {
  const { execute, WORKSPACE } = require('./tools');
  const db = require('./db');
  const { GOLDEN_TASKS } = require('./eval-tasks');
  const selected = (tasks || GOLDEN_TASKS).filter(t => !skip.includes(t.id));
  const skipped = (tasks || GOLDEN_TASKS).filter(t => skip.includes(t.id)).map(t => t.id);

  const runId = `eval-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const perTask = new Map(selected.map(t => [t.id, { id: t.id, name: t.name, attempts: 0, passes: 0, errors: [] }]));

  for (let rep = 0; rep < repeat; rep++) {
    const tag = `${runId}-r${rep}`;
    const dir = `eval-fixtures-${tag}`;
    const absDir = path.join(WORKSPACE, dir);
    fs.mkdirSync(absDir, { recursive: true });
    const noteIds = [];
    const approvalIds = [];
    const memoryIds = [];
    try {
      for (const task of selected) {
        const rec = perTask.get(task.id);
        const t0 = Date.now();
        rec.attempts++;
        try {
          await task.run({ execute, db, tag, dir, noteIds, approvalIds, memoryIds, WORKSPACE, fs, path });
          rec.passes++;
        } catch (e) {
          rec.errors.push(`rep ${rep}: ${e.message}`);
        }
        rec.lastMs = Date.now() - t0;
      }
    } finally {
      // Teardown: fixtures, notes, approval drafts, and memory facts
      // created by this repetition are removed. Audit rows stay
      // (append-only by design).
      try { fs.rmSync(absDir, { recursive: true, force: true }); } catch {}
      for (const id of noteIds) { try { db.run('DELETE FROM notes WHERE id = ?', id); } catch {} }
      for (const id of approvalIds) { try { db.run('DELETE FROM approvals WHERE id = ?', id); } catch {} }
      for (const id of memoryIds) { try { db.run('DELETE FROM memory_facts WHERE id = ?', id); } catch {} }
    }
  }

  const taskList = [...perTask.values()].map(t => ({
    ...t,
    passed: t.passes === t.attempts,
    failed: t.passes < t.attempts,
  }));
  const report = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    repeat,
    skipped,
    tasks: taskList,
    totals: {
      tasks: taskList.length,
      passed: taskList.filter(t => t.passed).length,
      failed: taskList.filter(t => t.failed).length,
    },
    deterministic: repeat > 1
      ? taskList.every(t => t.passes === 0 || t.passes === t.attempts)
      : null,
  };
  return report;
}

function renderEvalMarkdown(report) {
  const lines = [
    `# Eval report — ${report.runId}`,
    '',
    `Started: ${report.startedAt} · Duration: ${report.durationMs} ms · Repetitions: ${report.repeat}`,
    `Result: ${report.totals.passed}/${report.totals.tasks} tasks passed` +
      (report.deterministic === null ? '' : report.deterministic ? ' · deterministic across repetitions' : ' · NON-DETERMINISTIC across repetitions'),
    ...(report.skipped.length ? [`Skipped: ${report.skipped.join(', ')}`] : []),
    '',
    '| Task | Result | Attempts passed |',
    '|---|---|---|',
    ...report.tasks.map(t => `| ${t.name} | ${t.passed ? 'PASS' : 'FAIL'} | ${t.passes}/${t.attempts} |`),
  ];
  const failed = report.tasks.filter(t => t.failed);
  if (failed.length) {
    lines.push('', '## Failures');
    for (const t of failed) for (const e of t.errors) lines.push(`- ${t.id}: ${e}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { runGoldenSet, renderEvalMarkdown };
