// Database — SQLite, real, persistent. node:sqlite (Node 22.5+, stable in Node 24).
// Tables: messages (chat history), jobs (every agent run + evidence),
// notes (memory), approvals (draft-first gate — nothing irreversible executes
// without an approved record), audit_log (every tool call, allowed or denied).
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
`);

function all(sql, ...params) { return db.prepare(sql).all(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }
function run(sql, ...params) { return db.prepare(sql).run(...params); }

module.exports = { db, all, get, run, DB_PATH };
