// Database — SQLite, real, persistent. node:sqlite (Node 22.5+, stable in Node 24).
// Tables: messages (chat history), jobs (every agent run + evidence),
// notes (memory), approvals (draft-first gate — nothing irreversible executes
// without an approved record), audit_log (every tool call, allowed or denied),
// memory_facts + memory_facts_fts (Memory v2: timestamped facts with
// contradiction history, FTS5 recall — cycle 4, 18 Nov 2026).
// Phases B–E (14 Nov 2026): outbox (durable offline queue), routines +
// routine_runs (scheduled jobs), sync_conflicts (sync conflicts, surfaced
// never silently overwritten), settings (key/value — freeze state, device id).
// Sync columns: messages/jobs/notes/approvals gain device_id + updated_at
// (added by migration below if an older DB exists) for last-write-wins sync.
// Notifications, screen sessions/steps, settings, outbox, audit_log, and
// memory_facts are NEVER synced: screenshots, keys, audit state, and
// personal memory must not leave the device (see sync.js SYNC_TABLES —
// memory_facts is deliberately absent from it).
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// PIPLET_DB_PATH lets the eval harness (scripts/run-eval.js) and other
// throwaway runs use a temporary database instead of the real one. Default
// is unchanged: the persistent DB in data/. Never point this at a shared
// or synced location — audit/settings rows must stay on this device.
const DB_PATH = process.env.PIPLET_DB_PATH || path.join(DATA_DIR, 'personal-ai.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
// H-16: busy_timeout 1000 ms by default (was a hard-coded 5000).
// node:sqlite is synchronous, so a contended write blocks the whole
// event loop for the full timeout — 5 s of frozen server per lock. 1 s
// still absorbs normal contention (server + one helper process) while
// bounding the freeze. WAL mode keeps readers unblocked; writers
// serialize briefly. PIPLET_BUSY_TIMEOUT_MS overrides it: the test
// runner sets 5000 because it deliberately runs 8 processes against
// one DB file, a contention level the running server never sees.
const BUSY_TIMEOUT_MS = (() => {
  const n = Number(process.env.PIPLET_BUSY_TIMEOUT_MS || 1000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1000;
})();
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; 
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    model TEXT, provider TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL, status TEXT NOT NULL,
    model TEXT, provider TEXT, evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL, details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT NOT NULL, args TEXT, allowed INTEGER NOT NULL,
    result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    prev_hash TEXT, entry_hash TEXT, run_id TEXT
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, schedule TEXT NOT NULL, task TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    approval_rule TEXT NOT NULL DEFAULT 'default',
    enabled INTEGER NOT NULL DEFAULT 1,
    running INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT, next_run_at TEXT,
    missed_policy TEXT NOT NULL DEFAULT 'run_late',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS routine_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL, status TEXT NOT NULL,
    evidence TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL, record_id INTEGER NOT NULL,
    local_json TEXT NOT NULL, incoming_json TEXT NOT NULL,
    device_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS screen_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL, device TEXT NOT NULL DEFAULT 'desktop',
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS screen_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES screen_sessions(id),
    step_index INTEGER NOT NULL,
    action TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}',
    result TEXT, screenshot_hash TEXT, shot_path TEXT,
    latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Memory v2 (cycle 4, 18 Nov 2026): timestamped facts with scope,
  -- topic, source, and contradiction history. status 'current' means the
  -- fact stands; 'superseded' means a newer fact with the same scope+topic
  -- replaced it — the old row is KEPT (history), never silently
  -- overwritten. Forget is a hard DELETE (see memory.js). The FTS5 table
  -- is an external-content index over memory_facts, kept in sync by
  -- triggers; recall filters to status='current', so superseded facts
  -- never surface as answers (they surface only as history).
  CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'default',
    topic TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'current',
    superseded_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(content, topic, content='memory_facts', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS memory_facts_fts_ai AFTER INSERT ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(rowid, content, topic) VALUES (new.id, new.content, new.topic);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_facts_fts_ad AFTER DELETE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content, topic) VALUES ('delete', old.id, old.content, old.topic);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_facts_fts_au AFTER UPDATE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content, topic) VALUES ('delete', old.id, old.content, old.topic);
    INSERT INTO memory_facts_fts(rowid, content, topic) VALUES (new.id, new.content, new.topic);
  END;
`);

// Migration: hash-chain columns on audit_log (cycle 2, 17 Nov 2026).
// Rows written before this change have NULL hashes and are reported as
// "unchained (legacy)" by verification — they are not retroactively
// chained, and their presence is not a tamper signal.
{
  const cols = db.prepare('PRAGMA table_info(audit_log)').all().map(c => c.name);
  for (const col of ['prev_hash', 'entry_hash', 'run_id']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE audit_log ADD COLUMN ${col} TEXT`);
  }
}

// Migration: sync columns on the pre-existing tables. ALTER TABLE fails if
// the column already exists, so check PRAGMA first — safe to run every start.
for (const table of ['messages', 'jobs', 'notes', 'approvals']) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes('device_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN device_id TEXT`);
  if (!cols.includes('updated_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`);
}
// Backfill updated_at from created_at where it is still NULL, so the sync
// merge always has a timestamp to compare.
for (const table of ['messages', 'jobs', 'notes', 'approvals']) {
  db.exec(`UPDATE ${table} SET updated_at = created_at WHERE updated_at IS NULL`);
}

function all(sql, ...params) { return db.prepare(sql).all(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }
function run(sql, ...params) { return db.prepare(sql).run(...params); }

function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, key, String(value));
}

// Stable device id for sync: generated once, stored in settings, never a
// secret (it only labels which device wrote a record).
function deviceId() {
  let id = getSetting('device_id');
  if (!id) {
    id = `device-${require('crypto').randomBytes(8).toString('hex')}`;
    setSetting('device_id', id);
  }
  return id;
}

module.exports = { db, all, get, run, DB_PATH, getSetting, setSetting, deviceId };
