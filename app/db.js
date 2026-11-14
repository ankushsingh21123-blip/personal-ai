// Database — SQLite, real, persistent. node:sqlite (Node 22.5+, stable in Node 24).
// Tables: messages (chat history), jobs (every agent run + evidence),
// notes (memory), approvals (draft-first gate — nothing irreversible executes
// without an approved record), audit_log (every tool call, allowed or denied).
// Phases B–E (14 Nov 2026): outbox (durable offline queue), routines +
// routine_runs (scheduled jobs), sync_conflicts (sync conflicts, surfaced
// never silently overwritten), settings (key/value — freeze state, device id).
// Sync columns: messages/jobs/notes/approvals gain device_id + updated_at
// (added by migration below if an older DB exists) for last-write-wins sync.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'personal-ai.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
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
    result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`);

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
