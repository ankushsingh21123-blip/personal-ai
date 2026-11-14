// Routines — scheduled recurring jobs (Phase E). A routine is a schedule +
// a task + a scope + an approval rule, stored in SQLite, run by a local
// scheduler (no external cron service). Every run writes a routine_runs
// record with evidence, exactly like a chat turn writes a job.
// Safety, non-negotiable (spec §E): a routine runs through the same
// deny-first tools as a chat turn, so it can never send, post, spend or
// delete — an irreversible intent creates a pending approval instead. The
// approval_rule can only make a routine STRICTER, never looser: 'default'
// and 'strict' are the only values, and anything else is rejected.
// Double-run prevention: a run lock in SQLite (atomic UPDATE … WHERE
// running=0). Missed runs: 'run_late' runs on the next tick, 'mark_missed'
// records a missed run — never silently dropped.
'use strict';
const { all, get, run } = require('./db');
const { isFrozen } = require('./freeze');

const APPROVAL_RULES = new Set(['default', 'strict']);
const MISSED_POLICIES = new Set(['run_late', 'mark_missed']);

// Schedule shapes:
//   { type: 'daily', time: 'HH:MM', weekdays: [0..6] }  (0 = Sunday; omitted = every day)
//   { type: 'interval', minutes: N }                     (N >= 5, whole minutes)
function validateSchedule(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('schedule must be an object');
  if (s.type === 'daily') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time || '')) throw new Error('daily schedule needs time "HH:MM" (24h)');
    if (s.weekdays !== undefined) {
      if (!Array.isArray(s.weekdays) || s.weekdays.length === 0 ||
          s.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new Error('weekdays must be a non-empty array of 0..6 (0 = Sunday)');
      }
    }
    return { type: 'daily', time: s.time, weekdays: s.weekdays ? [...new Set(s.weekdays)].sort() : [0, 1, 2, 3, 4, 5, 6] };
  }
  if (s.type === 'interval') {
    if (!Number.isInteger(s.minutes) || s.minutes < 5) throw new Error('interval schedule needs minutes >= 5 (integer)');
    return { type: 'interval', minutes: s.minutes };
  }
  throw new Error('schedule type must be "daily" or "interval"');
}

// Next run strictly after `from` (server local time — the server runs in the
// user's timezone; document it, don't pretend otherwise).
function nextRunAfter(schedule, from = new Date()) {
  const s = validateSchedule(schedule);
  if (s.type === 'interval') {
    return new Date(from.getTime() + s.minutes * 60_000);
  }
  const [hh, mm] = s.time.split(':').map(Number);
  for (let add = 0; add <= 7; add++) {
    const cand = new Date(from);
    cand.setDate(from.getDate() + add);
    cand.setHours(hh, mm, 0, 0);
    if (cand > from && s.weekdays.includes(cand.getDay())) return cand;
  }
  throw new Error('no next run found within 7 days — check weekdays');
}

function toSqlDate(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function createRoutine({ name, schedule, task, scope, approval_rule, missed_policy }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('name required, max 200 chars');
  if (typeof task !== 'string' || !task.trim() || task.length > 4000) throw new Error('task required, max 4000 chars');
  const s = validateSchedule(schedule);
  const rule = approval_rule || 'default';
  if (!APPROVAL_RULES.has(rule)) throw new Error('approval_rule must be "default" or "strict" — routines can only be stricter, never looser');
  const missed = missed_policy || 'run_late';
  if (!MISSED_POLICIES.has(missed)) throw new Error('missed_policy must be "run_late" or "mark_missed"');
  const next = nextRunAfter(s, new Date());
  const r = run(
    `INSERT INTO routines (name, schedule, task, scope, approval_rule, missed_policy, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name.trim(), JSON.stringify(s), task.trim(), String(scope || '').slice(0, 2000), rule, missed, toSqlDate(next));
  return getRoutine(Number(r.lastInsertRowid));
}

function getRoutine(id) {
  const row = get('SELECT * FROM routines WHERE id = ?', id);
  if (!row) return null;
  return { ...row, schedule: JSON.parse(row.schedule), enabled: !!row.enabled, running: !!row.running };
}

function listRoutines() {
  return all('SELECT * FROM routines ORDER BY id DESC').map(r => ({ ...r, schedule: JSON.parse(r.schedule), enabled: !!r.enabled, running: !!r.running }));
}

function setEnabled(id, enabled) {
  const r = run('UPDATE routines SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?', enabled ? 1 : 0, id);
  if (r.changes === 0) throw new Error('routine not found');
  return getRoutine(id);
}

function deleteRoutine(id) {
  const r = run('DELETE FROM routines WHERE id = ?', id);
  if (r.changes === 0) throw new Error('routine not found');
  return { deleted: id };
}

// Routines arrive with schedule as a JSON string (raw DB row) or a parsed
// object (getRoutine / tick) — normalise before computing the next run.
function scheduleOf(routine) {
  return typeof routine.schedule === 'string' ? JSON.parse(routine.schedule) : routine.schedule;
}
function acquireLock(id) {
  const r = run('UPDATE routines SET running = 1, updated_at = datetime(\'now\') WHERE id = ? AND running = 0', id);
  return r.changes === 1;
}

function releaseLock(id, nextRunAt, lastRunAt) {
  run(`UPDATE routines SET running = 0, next_run_at = ?, last_run_at = ?, updated_at = datetime('now') WHERE id = ?`,
    nextRunAt, lastRunAt, id);
}

function recordRun(routineId, status, evidence) {
  const r = run('INSERT INTO routine_runs (routine_id, status, evidence, finished_at) VALUES (?, ?, ?, datetime(\'now\'))',
    routineId, status, JSON.stringify(evidence || {}).slice(0, 5000));
  return Number(r.lastInsertRowid);
}

function listRuns(routineId, limit = 20) {
  return all('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?', routineId, limit);
}

// Run one routine now. `runner(task, scope, routine)` does the real work
// (in server.js it is agentTurn); here it is injected so the scheduler is
// unit-testable without a brain. Dry runs validate + record, and never call
// the runner. A frozen scheduler records 'skipped_frozen' and does nothing.
async function runRoutine(routine, runner, opts = {}) {
  const now = opts.now || new Date();
  if (isFrozen()) {
    recordRun(routine.id, 'skipped_frozen', { reason: 'agent frozen' });
    return { status: 'skipped_frozen' };
  }
  if (!acquireLock(routine.id)) return { status: 'already_running' };
  try {
    if (opts.dryRun) {
      recordRun(routine.id, 'dry_run', { task: routine.task, scope: routine.scope });
      return { status: 'dry_run' };
    }
    const evidence = await runner(routine.task, routine.scope, routine);
    recordRun(routine.id, 'done', evidence);
    run('INSERT INTO jobs (task, status, model, provider, evidence) VALUES (?, ?, ?, ?, ?)',
      `[routine:${routine.name}] ${routine.task}`.slice(0, 500), 'done',
      evidence?.model || null, evidence?.provider || null, JSON.stringify(evidence).slice(0, 5000));
    return { status: 'done', evidence };
  } catch (e) {
    const evidence = { error: String(e?.message || e).slice(0, 500) };
    recordRun(routine.id, 'failed', evidence);
    return { status: 'failed', evidence };
  } finally {
    const next = nextRunAfter(scheduleOf(routine), now);
    releaseLock(routine.id, toSqlDate(next), toSqlDate(now));
  }
}

// One scheduler tick: run every enabled, due, unlocked routine. Returns what
// happened so the caller can log it. Routines whose time passed while the
// device was offline: 'run_late' runs them now; 'mark_missed' records a
// missed run and moves on. Never double-runs: the lock + next_run_at update
// in runRoutine make a second tick skip the same routine.
async function tick(runner, opts = {}) {
  const now = opts.now || new Date();
  if (isFrozen()) return { ran: 0, skipped_frozen: true, results: [] };
  const due = all(
    `SELECT * FROM routines WHERE enabled = 1 AND running = 0 AND next_run_at <= ?
     ORDER BY next_run_at ASC`, toSqlDate(now));
  const results = [];
  for (const row of due) {
    const routine = { ...row, schedule: JSON.parse(row.schedule) };
    if (routine.missed_policy === 'mark_missed' && opts.markMissedOlderThanMs) {
      const dueAt = new Date(row.next_run_at.replace(' ', 'T') + 'Z').getTime();
      if (now.getTime() - dueAt > opts.markMissedOlderThanMs) {
        if (acquireLock(routine.id)) {
          try {
            recordRun(routine.id, 'missed', { due_at: row.next_run_at, reason: 'device was offline/past due; missed_policy=mark_missed' });
          } finally {
            const next = nextRunAfter(scheduleOf(routine), now);
            releaseLock(routine.id, toSqlDate(next), toSqlDate(now));
          }
        }
        results.push({ routine_id: routine.id, status: 'missed' });
        continue;
      }
    }
    const r = await runRoutine(routine, runner, opts);
    results.push({ routine_id: routine.id, status: r.status });
  }
  return { ran: results.length, skipped_frozen: false, results };
}

module.exports = { validateSchedule, nextRunAfter, createRoutine, getRoutine, listRoutines, setEnabled, deleteRoutine, runRoutine, tick, listRuns, APPROVAL_RULES, MISSED_POLICIES };
