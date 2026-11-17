// Hash-chained audit log + run receipts (cycle 2, 17 Nov 2026).
//
// Every audit entry hashes the previous entry's hash, so editing or
// deleting a historical entry breaks verification. This is tamper-EVIDENT,
// not tamper-PROOF: anyone with write access to the SQLite file could
// recompute the whole chain. What it catches is accidental edits, partial
// restores, and casual tampering — and it gives every run a checkable
// receipt. See SECURITY.md for the honest limits.
//
// Chain rules:
// - entry_hash = sha256(prev_hash + '\n' + canonical JSON of the entry).
// - The first chained entry uses GENESIS (64 zeroes) as prev_hash.
// - Rows written before chaining (NULL hashes) are "unchained (legacy)":
//   counted by verification, never treated as tamper.
// - The read-last-hash + insert runs inside BEGIN IMMEDIATE, so two
//   processes (server + a test runner) cannot fork the chain.
// - audit() never throws: a logging failure must never break a tool call.
'use strict';
const crypto = require('crypto');
const { db, all, get, run } = require('./db');

const GENESIS = '0'.repeat(64);

function canonical(entry) {
  // Fixed key order, no whitespace surprises: the hash must recompute
  // identically from the stored row.
  return JSON.stringify({
    tool: entry.tool,
    args: entry.args,
    allowed: entry.allowed,
    result: entry.result,
    created_at: entry.created_at,
    run_id: entry.run_id || null,
  });
}

function entryHash(prevHash, entry) {
  return crypto.createHash('sha256').update(prevHash + '\n' + canonical(entry)).digest('hex');
}

function audit(tool, args, allowed, result, opts = {}) {
  // M-26: a failed insert is no longer swallowed silently. One retry
  // (transient SQLITE_BUSY under contention is recoverable), then the
  // failure is counted and logged to stderr — a broken audit trail must
  // be visible, never quietly absent. audit() still never throws: a
  // logging failure must never break a tool call.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const entry = {
        tool: String(tool),
        args: JSON.stringify(args || {}),
        allowed: allowed ? 1 : 0,
        result: String(result || '').slice(0, 500),
        created_at: new Date().toISOString(),
        run_id: opts.runId ? String(opts.runId).slice(0, 64) : null,
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        const last = get('SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1');
        const prev = last ? last.entry_hash : GENESIS;
        const hash = entryHash(prev, entry);
        run('INSERT INTO audit_log (tool, args, allowed, result, created_at, prev_hash, entry_hash, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          entry.tool, entry.args, entry.allowed, entry.result, entry.created_at, prev, hash, entry.run_id);
        db.exec('COMMIT');
        return hash;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    } catch (e) {
      if (attempt === 1) {
        failureCount++;
        console.error(`[personal-ai] audit record FAILED (failures: ${failureCount}): ${String(e.message).slice(0, 200)} — tool: ${String(tool).slice(0, 100)}`);
      }
    }
  }
  return null;
}

let failureCount = 0;
function auditFailures() { return failureCount; }

// Verify the whole chain, oldest first. Returns a report, never throws.
function verifyAuditChain() {
  const rows = all('SELECT id, tool, args, allowed, result, created_at, prev_hash, entry_hash, run_id FROM audit_log ORDER BY id ASC');
  let expectedPrev = GENESIS;
  let checked = 0;
  let unchained = 0;
  for (const row of rows) {
    if (!row.entry_hash) { unchained++; continue; }
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, checked, unchained, total: rows.length, firstBadId: row.id, reason: 'prev_hash does not match the previous entry hash (entry inserted, deleted, or reordered)' };
    }
    const recomputed = entryHash(row.prev_hash, {
      tool: row.tool, args: row.args, allowed: row.allowed,
      result: row.result, created_at: row.created_at, run_id: row.run_id,
    });
    if (recomputed !== row.entry_hash) {
      return { ok: false, checked, unchained, total: rows.length, firstBadId: row.id, reason: 'entry hash mismatch (entry contents were edited after writing)' };
    }
    expectedPrev = row.entry_hash;
    checked++;
  }
  return { ok: true, checked, unchained, total: rows.length, firstBadId: null, reason: null };
}

// Build a human-readable receipt for one run (by run_id) or an id range.
// The receipt states only what the log shows: what was requested (the
// caller's own label, passed in — never invented here), what was done,
// what was denied, and whether the chain verifies.
function buildReceipt({ runId = null, fromId = null, toId = null, requested = null } = {}) {
  let rows;
  if (runId) {
    rows = all('SELECT * FROM audit_log WHERE run_id = ? ORDER BY id ASC', String(runId));
  } else if (fromId !== null || toId !== null) {
    rows = all('SELECT * FROM audit_log WHERE id >= COALESCE(?, id) AND id <= COALESCE(?, id) ORDER BY id ASC',
      fromId === null ? null : Number(fromId), toId === null ? null : Number(toId));
  } else {
    rows = all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').reverse();
  }
  const done = rows.filter(r => r.allowed === 1);
  const denied = rows.filter(r => r.allowed !== 1);
  const chain = verifyAuditChain();
  return {
    run_id: runId,
    requested: requested || null,
    generated_at: new Date().toISOString(),
    entries: rows.length,
    done: done.map(r => ({ id: r.id, tool: r.tool, result: r.result, created_at: r.created_at })),
    denied: denied.map(r => ({ id: r.id, tool: r.tool, result: r.result, created_at: r.created_at })),
    chain_ok: chain.ok,
    chain_checked: chain.checked,
    chain_unchained_legacy: chain.unchained,
  };
}

function renderReceiptMarkdown(receipt) {
  const lines = [
    `# Run receipt${receipt.run_id ? ` — ${receipt.run_id}` : ''}`,
    '',
    `Generated: ${receipt.generated_at}`,
    receipt.requested ? `Requested: ${receipt.requested}` : null,
    `Entries: ${receipt.entries} (${receipt.done.length} done, ${receipt.denied.length} denied)`,
    `Audit chain: ${receipt.chain_ok ? `OK (${receipt.chain_checked} chained entries verified, ${receipt.chain_unchained_legacy} legacy unchained)` : 'FAILED VERIFICATION — see /api/audit/verify'}`,
    '',
    '## Done',
    ...(receipt.done.length ? receipt.done.map(d => `- [${d.id}] ${d.tool} — ${d.result || ''} (${d.created_at})`) : ['- (nothing)']),
    '',
    '## Denied',
    ...(receipt.denied.length ? receipt.denied.map(d => `- [${d.id}] ${d.tool} — ${d.result || ''} (${d.created_at})`) : ['- (nothing)']),
    '',
  ];
  return lines.filter(l => l !== null).join('\n');
}

module.exports = { audit, verifyAuditChain, buildReceipt, renderReceiptMarkdown, GENESIS, entryHash, auditFailures };
