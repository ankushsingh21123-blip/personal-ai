// Notifications — a small local inbox for things the agent wants the user
// to see (routine results, queue failures, sync conflicts, reminders).
// Stored in SQLite, surfaced in the web UI, never synced, never sent
// anywhere. Creating a notification is the agent's way of saying "look at
// this when you are back" — it is not a push, an SMS, or a message.
'use strict';

function createNotification(title, body, source = '', db = require('./db')) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('notification title must be 1..200 chars');
  if (typeof body !== 'string' || body.length > 2000) throw new Error('notification body must be at most 2000 chars');
  if (typeof source !== 'string' || source.length > 100) throw new Error('notification source must be at most 100 chars');
  const r = db.run('INSERT INTO notifications (title, body, source) VALUES (?, ?, ?)', title.trim(), body, source);
  return { id: Number(r.lastInsertRowid), title: title.trim(), body, source };
}

function listNotifications({ unreadOnly = false, limit = 50, db = require('./db') } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const sql = unreadOnly
    ? 'SELECT * FROM notifications WHERE read_at IS NULL ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM notifications ORDER BY id DESC LIMIT ?';
  return db.all(sql, n);
}

function unreadCount(db = require('./db')) {
  const row = db.get('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL');
  return Number(row?.n || 0);
}

function markNotificationRead(id, db = require('./db')) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('notification id must be a positive integer');
  const r = db.run('UPDATE notifications SET read_at = datetime(\'now\') WHERE id = ? AND read_at IS NULL', n);
  return { ok: r.changes > 0, id: n };
}

module.exports = { createNotification, listNotifications, unreadCount, markNotificationRead };
