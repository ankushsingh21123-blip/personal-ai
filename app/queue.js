// Offline queue — durable outbox (Phase D). Any job that needs the network
// (a frontier provider call, a web fetch, a sync push) is written to the
// SQLite outbox FIRST, then attempted. On failure it stays queued with its
// next-retry time; on reconnect the outbox drains in order. Nothing is lost
// to a dropped connection, nothing is silently skipped, and nothing is
// double-run: claiming a job is one atomic UPDATE, and a crashed worker
// leaves the job 'processing' until the stale-claim sweep returns it to
// 'pending'. The UI shows queued vs done — see /api/queue and /api/status.
'use strict';
const { all, get, run } = require('./db');
const { assertNotFrozen } = require('./freeze');

// Retry backoff in milliseconds: 1m, 5m, 15m, 1h, 6h, then dead.
// attempts counts failures so far; attempt 1 fails -> retry in 1m, etc.
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
const STALE_CLAIM_MS = 10 * 60_000; // a 'processing' job older than this is re-queued

function backoffMs(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
}

const KINDS = new Set(['brain_call', 'web_fetch', 'sync_push', 'routine_run', 'notify']);

function enqueue(kind, payload, opts = {}) {
  if (!KINDS.has(kind)) throw new Error(`unknown outbox kind: ${kind}`);
  const maxAttempts = opts.maxAttempts === undefined ? 5 : Number(opts.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error('maxAttempts must be an integer 1..20');
  }
  const r = run(
    'INSERT INTO outbox (kind, payload, max_attempts, next_retry_at) VALUES (?, ?, ?, datetime(\'now\'))',
    kind, JSON.stringify(payload || {}), maxAttempts);
  return Number(r.lastInsertRowid);
}

// Atomically claim up to `limit` due jobs (oldest first). The UPDATE … WHERE
// status='pending' makes the claim race-safe: two drainers never get the
// same job.
function claimDue(limit = 10, now = new Date()) {
  const rows = all(
    `SELECT id FROM outbox WHERE status = 'pending' AND next_retry_at <= ?
     ORDER BY id ASC LIMIT ?`, now.toISOString().replace('T', ' ').slice(0, 19), limit);
  const claimed = [];
  for (const row of rows) {
    const r = run(
      `UPDATE outbox SET status = 'processing', updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`, row.id);
    if (r.changes === 1) claimed.push(row.id);
  }
  return claimed;
}

// Return stale 'processing' jobs (worker died mid-job) to 'pending' so the
// next drain retries them. Called at the start of every drain.
function sweepStale(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString().replace('T', ' ').slice(0, 19);
  const r = run(
    `UPDATE outbox SET status = 'pending', updated_at = datetime('now')
     WHERE status = 'processing' AND updated_at <= ?`, cutoff);
  return r.changes;
}

function complete(id) {
  run(`UPDATE outbox SET status = 'done', updated_at = datetime('now') WHERE id = ?`, id);
}

function fail(id, error, now = new Date()) {
  const row = get('SELECT attempts, max_attempts FROM outbox WHERE id = ?', id);
  if (!row) return;
  const attempts = row.attempts + 1;
  if (attempts >= row.max_attempts) {
    run(`UPDATE outbox SET status = 'dead', attempts = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      attempts, String(error || '').slice(0, 500), id);
  } else {
    const next = new Date(now.getTime() + backoffMs(attempts)).toISOString().replace('T', ' ').slice(0, 19);
    run(`UPDATE outbox SET status = 'pending', attempts = ?, next_retry_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      attempts, next, String(error || '').slice(0, 500), id);
  }
}

function counts() {
  const rows = all('SELECT status, COUNT(*) c FROM outbox GROUP BY status');
  const out = { pending: 0, processing: 0, done: 0, dead: 0 };
  for (const r of rows) if (r.status in out) out[r.status] = r.c;
  return out;
}

function list(limit = 50) {
  return all('SELECT id, kind, status, attempts, max_attempts, next_retry_at, last_error, created_at FROM outbox ORDER BY id DESC LIMIT ?', limit);
}

// Drain due jobs with `worker(kind, payload, id)`. Sequential, in claim
// order, so a later job can depend on an earlier one. Respects freeze:
// a frozen drain processes nothing and reports frozen:true. Returns a
// summary — the caller logs it, and the UI shows the counts.
async function drain(worker, opts = {}) {
  const limit = Number(opts.limit || 10);
  const now = opts.now || new Date();
  sweepStale(now);
  if (require('./freeze').isFrozen()) return { drained: 0, done: 0, failed: 0, frozen: true };
  const ids = claimDue(limit, now);
  let done = 0, failed = 0;
  for (const id of ids) {
    if (require('./freeze').isFrozen()) {
      // Return the remaining claimed jobs to pending so they are not stuck.
      run(`UPDATE outbox SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'processing'`, id);
      continue;
    }
    const row = get('SELECT kind, payload FROM outbox WHERE id = ?', id);
    try {
      assertNotFrozen();
      await worker(row.kind, JSON.parse(row.payload || '{}'), id);
      complete(id);
      done++;
    } catch (e) {
      fail(id, e?.message || e, now);
      failed++;
    }
  }
  return { drained: ids.length, done, failed, frozen: false };
}

module.exports = { enqueue, claimDue, sweepStale, complete, fail, counts, list, drain, backoffMs, BACKOFF_MS, KINDS };
