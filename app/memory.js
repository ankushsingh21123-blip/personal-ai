// Memory v2 — trustworthy long-term recall, local-first, $0 (cycle 4, 18 Nov 2026).
//
// What it is: a timestamped fact store in the existing SQLite file. Every
// fact carries a scope, an optional topic, its content, a source (which
// conversation/run stored it), and created/updated timestamps. Recall
// returns facts WITH citations (id, scope, topic, source, date) so the
// agent — and the user — can always see where a recalled fact came from.
//
// Recall method — FTS5 + recency, NOT vectors (documented decision):
// the backlog item (#4) proposed sqlite-vec + local ONNX embeddings. That
// stack is unavailable here without new infrastructure: node:sqlite can
// load extensions, but the repo ships no sqlite-vec binary, and no local
// embedding model is installed (adding one means a native binary + a
// ~100MB model download + an ONNX runtime dependency). The $0, zero-new-
// infra alternative is FTS5 keyword search (built into SQLite 3.53.4,
// verified on this machine) fused with recency and exact-topic boost in
// SQL, plus exact structured lookup by topic. This module keeps recall
// behind one function (recall) so a vector path can be added later
// without changing callers: a future sqlite-vec vec0 table + embedder
// would only add a second ranked candidate set to the same fusion.
// Recall is keyword-based today — it does not understand synonyms or
// paraphrase, and nothing in the UI or docs claims otherwise.
//
// Contradictions: facts with the same scope + topic are versions of one
// claim. Storing a different content for an existing topic SUPERSEDES the
// old row (status='superseded', superseded_by points at the new row) and
// keeps it as history. Recall returns only 'current' facts, and attaches
// the superseded history for the same topic so a conflict stays visible
// ("you told me X last week, Y today") instead of being silently
// overwritten. Storing identical content for the same scope+topic is a
// no-op that returns the existing id (no duplicates).
//
// Forget and edit: forget() is a HARD DELETE of the row (the FTS5
// trigger removes it from the index in the same statement) — a forgotten
// fact cannot be recalled again, by any scope. editFact() corrects a
// fact by superseding the old row and inserting the corrected one, so
// the correction is reflected in recall AND the previous wording stays
// in history. Neither function logs fact content anywhere.
//
// Scoping: every read and write filters on scope (SQL equality). The
// default scope is 'default'. A fact stored in one scope is invisible
// to recall/list/edit/forget in any other scope. Scopes are plain
// labels supplied by the caller (e.g. 'work', 'personal'); this module
// does not invent them.
//
// Never synced: memory_facts is deliberately absent from SYNC_TABLES in
// sync.js. Memory never leaves this device. This module never calls the
// audit writer itself — callers (tools, API endpoints) audit with
// metadata only (ids, scope, topic), never fact content.
//
// This module never throws for "not found" on forget (it reports
// forgotten: 0); it throws Error on invalid input so callers can return
// a 400/403 with the message.
'use strict';
const { db, all, get, run } = require('./db');

const DEFAULT_SCOPE = 'default';
const MAX_CONTENT = 2000;
const MAX_TOPIC = 100;
const MAX_SOURCE = 120;
const MAX_RUN_ID = 64;
const SCOPE_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

function validScope(scope) {
  const s = (scope === undefined || scope === null || scope === '') ? DEFAULT_SCOPE : String(scope);
  if (!SCOPE_RE.test(s)) throw new Error(`invalid scope '${s}' — use 1..64 chars: lowercase letters, digits, : _ -`);
  return s;
}

function normalizeTopic(topic) {
  if (topic === undefined || topic === null) return '';
  const t = String(topic).trim().toLowerCase().replace(/\s+/g, ' ');
  if (t.length > MAX_TOPIC) throw new Error(`topic capped at ${MAX_TOPIC} chars`);
  return t;
}

function validContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content required (1..2000 chars)');
  const c = content.trim();
  if (c.length > MAX_CONTENT) throw new Error(`content capped at ${MAX_CONTENT} chars`);
  return c;
}

// Build a safe FTS5 MATCH expression from free text: split into words,
// quote each one, prefix-match, OR them. The tokenizer only keeps
// letters/digits, so no FTS5 operator or quote can ever reach MATCH.
function ftsQuery(query) {
  const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const unique = [...new Set(words)].slice(0, 10);
  if (!unique.length) return null;
  return unique.map(w => `"${w}"*`).join(' OR ');
}

function escapeLike(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function publicFact(row) {
  return {
    id: row.id,
    scope: row.scope,
    topic: row.topic,
    content: row.content,
    source: row.source,
    run_id: row.run_id || null,
    status: row.status,
    superseded_by: row.superseded_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function historyFor(scope, topic, limit = 3) {
  if (!topic) return [];
  return all(
    `SELECT id, content, source, created_at, updated_at FROM memory_facts
     WHERE scope = ? AND topic = ? AND status = 'superseded' ORDER BY id DESC LIMIT ?`,
    scope, topic, limit,
  ).map(r => ({ id: r.id, content: r.content, source: r.source, created_at: r.created_at, superseded_at: r.updated_at }));
}

function remember({ scope, topic, content, source = '', runId = null } = {}) {
  const s = validScope(scope);
  const t = normalizeTopic(topic);
  const c = validContent(content);
  const src = String(source || '').slice(0, MAX_SOURCE);
  const rid = runId ? String(runId).slice(0, MAX_RUN_ID) : null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = get(
      `SELECT id FROM memory_facts WHERE scope = ? AND topic = ? AND content = ? AND status = 'current'`,
      s, t, c,
    );
    if (existing) {
      db.exec('COMMIT');
      return { id: existing.id, duplicate: true, superseded: [] };
    }
    const r = run(
      `INSERT INTO memory_facts (scope, topic, content, source, run_id) VALUES (?, ?, ?, ?, ?)`,
      s, t, c, src, rid,
    );
    const id = Number(r.lastInsertRowid);
    let superseded = [];
    if (t) {
      superseded = all(
        `SELECT id FROM memory_facts WHERE scope = ? AND topic = ? AND status = 'current' AND id <> ?`,
        s, t, id,
      ).map(row => row.id);
      for (const oldId of superseded) {
        run(`UPDATE memory_facts SET status = 'superseded', superseded_by = ?, updated_at = datetime('now') WHERE id = ?`, id, oldId);
      }
    }
    db.exec('COMMIT');
    return { id, duplicate: false, superseded };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function recall({ scope, query = '', limit = 5 } = {}) {
  const s = validScope(scope);
  const n = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const q = String(query || '').trim();
  const t = normalizeTopic(q);
  let rows = [];
  const match = ftsQuery(q);
  if (match) {
    rows = all(
      `SELECT f.*, bm25(memory_facts_fts) AS rank FROM memory_facts_fts
       JOIN memory_facts f ON f.id = memory_facts_fts.rowid
       WHERE memory_facts_fts MATCH ? AND f.scope = ? AND f.status = 'current'
       ORDER BY CASE WHEN f.topic = ? THEN 0 ELSE 1 END, rank ASC, f.created_at DESC, f.id DESC
       LIMIT ?`,
      match, s, t, n,
    );
  }
  if (!rows.length && q) {
    // LIKE fallback: covers short/partial tokens the FTS5 tokenizer
    // splits differently (e.g. hyphenated words), same scope + status.
    const like = `%${escapeLike(q)}%`;
    rows = all(
      `SELECT * FROM memory_facts WHERE scope = ? AND status = 'current'
       AND (content LIKE ? ESCAPE '\\' OR topic LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      s, like, like, n,
    );
  }
  if (!rows.length && !q) {
    rows = all(
      `SELECT * FROM memory_facts WHERE scope = ? AND status = 'current'
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      s, n,
    );
  }
  const facts = rows.map(row => {
    const fact = publicFact(row);
    fact.history = historyFor(s, fact.topic);
    return fact;
  });
  return { facts, query: q, scope: s };
}

function forget({ scope, id, topic } = {}) {
  const s = validScope(scope);
  const hasId = id !== undefined && id !== null && id !== '';
  const hasTopic = topic !== undefined && topic !== null && String(topic).trim() !== '';
  if (hasId === hasTopic) throw new Error('forget needs exactly one of id or topic');
  if (hasId) {
    const row = get('SELECT id FROM memory_facts WHERE id = ? AND scope = ?', Number(id), s);
    if (!row) return { forgotten: 0 };
    run('DELETE FROM memory_facts WHERE id = ?', row.id);
    return { forgotten: 1, id: row.id };
  }
  const t = normalizeTopic(topic);
  const r = run('DELETE FROM memory_facts WHERE scope = ? AND topic = ?', s, t);
  return { forgotten: Number(r.changes), topic: t };
}

function editFact({ scope, id, content, topic } = {}) {
  const s = validScope(scope);
  const c = validContent(content);
  const row = get('SELECT * FROM memory_facts WHERE id = ? AND scope = ?', Number(id), s);
  if (!row) throw new Error('fact not found in this scope');
  if (row.status !== 'current') throw new Error('only a current fact can be edited — superseded facts are history');
  const t = topic === undefined ? row.topic : normalizeTopic(topic);
  if (c === row.content && t === row.topic) return { id: row.id, previous_id: null, unchanged: true };
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = run(
      `INSERT INTO memory_facts (scope, topic, content, source, run_id) VALUES (?, ?, ?, ?, ?)`,
      s, t, c, row.source, row.run_id,
    );
    const newId = Number(r.lastInsertRowid);
    run(`UPDATE memory_facts SET status = 'superseded', superseded_by = ?, updated_at = datetime('now') WHERE id = ?`, newId, row.id);
    db.exec('COMMIT');
    return { id: newId, previous_id: row.id, unchanged: false };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function listFacts({ scope, includeSuperseded = false, limit = 50 } = {}) {
  const s = validScope(scope);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = includeSuperseded
    ? all('SELECT * FROM memory_facts WHERE scope = ? ORDER BY id DESC LIMIT ?', s, n)
    : all(`SELECT * FROM memory_facts WHERE scope = ? AND status = 'current' ORDER BY id DESC LIMIT ?`, s, n);
  return rows.map(publicFact);
}

module.exports = { remember, recall, forget, editFact, listFacts, DEFAULT_SCOPE, MAX_CONTENT, MAX_TOPIC };
