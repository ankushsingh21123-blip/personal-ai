// Internship Tracker — SQLite database, real and persistent.
// Uses node:sqlite (built into Node 22.5+, stable in Node 24) — no extra
// database dependency, no paid service, no mock data.
// One table: applications (company, role, status, deadline, link, notes).
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// DB_PATH env override exists so tests can point at a throwaway file.
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'internships.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied'
      CHECK (status IN ('applied', 'interview', 'offer', 'rejected')),
    deadline TEXT,
    link TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function all(sql, ...params) { return db.prepare(sql).all(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }
function run(sql, ...params) { return db.prepare(sql).run(...params); }

module.exports = { db, all, get, run, DB_PATH };
