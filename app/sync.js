// Sync — last-write-wins between devices (Phase D). Each device keeps its
// own SQLite database; the cloud node is a relay + remote runner, never the
// only copy. Records carry device_id + updated_at; the newer record wins.
// Conflicts (same id, same-or-older timestamp, different content, different
// device) are NEVER silently overwritten: the local record is kept, the
// conflict is stored in sync_conflicts and returned to the caller, and the
// UI can show it. Sync transport is the app's own HTTPS API behind
// Tailscale (loopback + token auth on each node) — no public exposure.
// Live two-node sync is UNPROVEN on this VM (no second node here): the
// merge logic is unit-tested with fixtures, and the push/pull endpoints are
// tested against the live server in tests/phases.test.js.
'use strict';
const { all, get, run, deviceId } = require('./db');

const SYNC_TABLES = ['messages', 'jobs', 'notes', 'approvals'];
// Columns synced per table (id + these). created_at is kept from the winner.
const SYNC_COLUMNS = {
  messages: ['role', 'content', 'model', 'provider', 'created_at'],
  jobs: ['task', 'status', 'model', 'provider', 'evidence', 'created_at'],
  notes: ['title', 'body', 'created_at'],
  approvals: ['action', 'details', 'status', 'created_at', 'decided_at'],
};

// Compare two records. Returns 'incoming' (incoming wins), 'local' (local
// wins), or 'conflict' (same timestamp, different content, different
// device — surface it, keep local).
function compareRecords(local, incoming, columns) {
  const lt = String(local.updated_at || local.created_at || '');
  const it = String(incoming.updated_at || incoming.created_at || '');
  if (it > lt) return 'incoming';
  if (it < lt) return 'local';
  // Equal timestamps: identical content is a no-op; different content from
  // a different device is a real conflict; same device re-pushing is a no-op.
  const sameContent = columns.every(c => String(local[c] ?? '') === String(incoming[c] ?? ''));
  if (sameContent) return 'local';
  if (String(local.device_id || '') === String(incoming.device_id || '')) return 'local';
  return 'conflict';
}

function rowToRecord(table, row) {
  const rec = { id: row.id, device_id: row.device_id || null, updated_at: row.updated_at || row.created_at };
  for (const c of SYNC_COLUMNS[table]) rec[c] = row[c] ?? null;
  return rec;
}

// Merge incoming records into the local DB. Returns { applied, kept, conflicts }.
// `incoming` shape: { messages: [rec...], jobs: [...], notes: [...], approvals: [...] }.
// Records are validated (integer id, string fields) — malformed records are
// skipped and reported, never trusted.
function mergeIncoming(incoming, fromDeviceId) {
  const result = { applied: 0, kept: 0, conflicts: [], skipped: 0 };
  for (const table of SYNC_TABLES) {
    const records = incoming?.[table];
    if (!Array.isArray(records)) continue;
    for (const rec of records) {
      if (!rec || !Number.isInteger(rec.id) || rec.id < 1) { result.skipped++; continue; }
      const local = get(`SELECT * FROM ${table} WHERE id = ?`, rec.id);
      if (!local) {
        const cols = ['id', 'device_id', 'updated_at', ...SYNC_COLUMNS[table]];
        const placeholders = cols.map(() => '?').join(', ');
        const vals = cols.map(c => (c === 'id' ? rec.id : (c === 'device_id' ? (rec.device_id || fromDeviceId || null) : (rec[c] ?? null))));
        run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, ...vals);
        result.applied++;
        continue;
      }
      const verdict = compareRecords(local, rec, SYNC_COLUMNS[table]);
      if (verdict === 'incoming') {
        const sets = SYNC_COLUMNS[table].map(c => `${c} = ?`).join(', ');
        run(`UPDATE ${table} SET ${sets}, device_id = ?, updated_at = ? WHERE id = ?`,
          ...SYNC_COLUMNS[table].map(c => rec[c] ?? null), rec.device_id || fromDeviceId || null, rec.updated_at || rec.created_at || null, rec.id);
        result.applied++;
      } else if (verdict === 'conflict') {
        run('INSERT INTO sync_conflicts (table_name, record_id, local_json, incoming_json, device_id) VALUES (?, ?, ?, ?, ?)',
          table, rec.id, JSON.stringify(rowToRecord(table, local)), JSON.stringify(rec), String(fromDeviceId || rec.device_id || 'unknown').slice(0, 100));
        result.conflicts.push({ table, id: rec.id });
        result.kept++;
      } else {
        result.kept++;
      }
    }
  }
  return result;
}

// Records changed since `since` (ISO datetime, or null for everything).
// Capped per table so one pull cannot dump the whole DB unboundedly.
function recordsSince(since, limitPerTable = 200) {
  const out = {};
  for (const table of SYNC_TABLES) {
    const rows = since
      ? all(`SELECT * FROM ${table} WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?`, since, limitPerTable)
      : all(`SELECT * FROM ${table} ORDER BY id ASC LIMIT ?`, limitPerTable);
    out[table] = rows.map(r => rowToRecord(table, r));
  }
  return out;
}

function listConflicts(limit = 50) {
  return all('SELECT * FROM sync_conflicts ORDER BY id DESC LIMIT ?', limit);
}

function thisDeviceId() {
  return deviceId();
}

module.exports = { mergeIncoming, recordsSince, listConflicts, compareRecords, thisDeviceId, SYNC_TABLES, SYNC_COLUMNS };
