// Replay — audit + verified replay of screen sessions (differentiator).
//
// Every screenLoop run can record its steps: the observation screenshot
// taken BEFORE each action, the validated action, the result, and the
// latency. Screenshots live as PNG files in data/shots/ (git-ignored,
// mode 600, pruned to the latest 200). The session + step metadata live
// in SQLite (screen_sessions / screen_steps). NOTHING here syncs to
// another device: screenshots never leave this machine except inside a
// model call the user already authorised.
//
// Replay is VERIFIED, not blind: before each recorded action, the current
// screen is captured and its hash compared to the recorded observation.
// On mismatch the replay STOPS before acting. A step that was destructive
// needs fresh approval (the original approval never replays). Replay
// results are reported as "N/M steps matched" — never claimed from the
// model alone.
//
// Privacy: recorded action arguments include typed text (truncated to 100
// chars). The replay log is local-only, and any session can be purged
// (rows + PNG files) via purgeSession / DELETE /api/replay/:id.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertNotFrozen } = require('./freeze');

// PIPLET_DATA_DIR override: the desktop app (Electron) keeps shots in
// the OS user-data dir (the packaged app is a read-only asar). Default
// is unchanged: data/shots/ beside this file.
const SHOTS_DIR = path.join(process.env.PIPLET_DATA_DIR || path.join(__dirname, 'data'), 'shots');
const MAX_SHOTS = 200;

function ensureShotsDir() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  return SHOTS_DIR;
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeArgs(action) {
  const a = { ...action };
  if (typeof a.text === 'string') a.text = a.text.slice(0, 100);
  return a;
}

// Delete oldest shot files beyond MAX_SHOTS; clear shot_path on the
// affected step rows so the UI shows "pruned" instead of a broken link.
function pruneShots(db) {
  try {
    ensureShotsDir();
    const files = fs.readdirSync(SHOTS_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ f, mtime: fs.statSync(path.join(SHOTS_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    const excess = files.slice(0, Math.max(0, files.length - MAX_SHOTS));
    for (const { f } of excess) {
      try { fs.unlinkSync(path.join(SHOTS_DIR, f)); } catch {}
      try { db.run('UPDATE screen_steps SET shot_path = NULL WHERE shot_path = ?', f); } catch {}
    }
    return excess.length;
  } catch { return 0; }
}

function createRecorder(task, { db = require('./db'), device = 'desktop' } = {}) {
  if (typeof task !== 'string' || !task.trim() || task.length > 500) throw new Error('recorder task must be 1..500 chars');
  const r = db.run('INSERT INTO screen_sessions (task, device) VALUES (?, ?)', task.trim(), device);
  const sessionId = Number(r.lastInsertRowid);
  let stepIndex = 0;
  return {
    sessionId,
    async record({ action, shot, result, latencyMs }) {
      const idx = stepIndex++;
      let shotPath = null;
      let screenshotHash = null;
      if (shot?.buffer && Buffer.isBuffer(shot.buffer)) {
        ensureShotsDir();
        screenshotHash = shot.hash || hashBuffer(shot.buffer);
        const name = `${sessionId}-${idx}.png`;
        const full = path.join(SHOTS_DIR, name);
        fs.writeFileSync(full, shot.buffer, { mode: 0o600 });
        try { fs.chmodSync(full, 0o600); } catch {}
        shotPath = name;
        pruneShots(db);
      } else if (typeof shot?.hash === 'string') {
        screenshotHash = shot.hash;
      }
      db.run(
        'INSERT INTO screen_steps (session_id, step_index, action, args_json, result, screenshot_hash, shot_path, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        sessionId, idx, String(action?.action || 'unknown'), JSON.stringify(safeArgs(action || {})),
        result === undefined ? null : String(typeof result === 'object' ? JSON.stringify(result) : result).slice(0, 500),
        screenshotHash, shotPath, Number.isInteger(latencyMs) ? latencyMs : null);
      return { sessionId, stepIndex: idx };
    },
    finish(status = 'done') {
      db.run('UPDATE screen_sessions SET status = ?, finished_at = datetime(\'now\') WHERE id = ?', status, sessionId);
    },
  };
}

function listSessions({ limit = 20, db = require('./db') } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db.all(`SELECT s.*, (SELECT COUNT(*) FROM screen_steps WHERE session_id = s.id) AS steps
    FROM screen_sessions s ORDER BY s.id DESC LIMIT ?`, n);
}

function getSession(id, { db = require('./db') } = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('session id must be a positive integer');
  const session = db.get('SELECT * FROM screen_sessions WHERE id = ?', n);
  if (!session) return null;
  const steps = db.all('SELECT * FROM screen_steps WHERE session_id = ? ORDER BY step_index ASC', n);
  return { ...session, steps };
}

// Traversal-safe shot retrieval: the path comes from the DB, is a bare
// filename, and must resolve inside SHOTS_DIR.
function getShot(stepId, { db = require('./db') } = {}) {
  const n = Number(stepId);
  if (!Number.isInteger(n) || n < 1) throw new Error('step id must be a positive integer');
  const row = db.get('SELECT shot_path, screenshot_hash FROM screen_steps WHERE id = ?', n);
  if (!row || !row.shot_path) return null;
  const name = path.basename(row.shot_path);
  const full = path.resolve(SHOTS_DIR, name);
  if (!full.startsWith(path.resolve(SHOTS_DIR) + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return { buffer: fs.readFileSync(full), hash: row.screenshot_hash };
}

function purgeSession(id, { db = require('./db') } = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('session id must be a positive integer');
  const steps = db.all('SELECT shot_path FROM screen_steps WHERE session_id = ?', n);
  for (const s of steps) {
    if (!s.shot_path) continue;
    const full = path.resolve(SHOTS_DIR, path.basename(s.shot_path));
    if (full.startsWith(path.resolve(SHOTS_DIR) + path.sep)) {
      try { fs.unlinkSync(full); } catch {}
    }
  }
  db.run('DELETE FROM screen_steps WHERE session_id = ?', n);
  const r = db.run('DELETE FROM screen_sessions WHERE id = ?', n);
  return { ok: r.changes > 0, id: n, shotsDeleted: steps.filter(s => s.shot_path).length };
}

// Verified replay. deps: { capture: () => {buffer, hash}, act: (action) =>
// result, confirmDestructive?: (step) => boolean, db }. Stops at the first
// screen mismatch, the first refused destructive step, or the first error.
async function replaySession(sessionId, deps) {
  assertNotFrozen();
  const db = deps.db || require('./db');
  const session = getSession(sessionId, { db });
  if (!session) throw new Error(`no replay session ${sessionId}`);
  const confirmDestructive = deps.confirmDestructive || (() => false);
  let matched = 0;
  for (const step of session.steps) {
    let action;
    try { action = JSON.parse(step.args_json || '{}'); } catch { action = {}; }
    action.action = step.action;
    const shot = await deps.capture();
    const hash = shot.hash || hashBuffer(shot.buffer);
    if (step.screenshot_hash && hash !== step.screenshot_hash) {
      return { done: false, matched, total: session.steps.length, stoppedAt: step.step_index,
        reason: 'screen did not match the recording — stopped before acting' };
    }
    if (action.destructive && !confirmDestructive(step)) {
      return { done: false, matched, total: session.steps.length, stoppedAt: step.step_index,
        reason: 'destructive step needs fresh approval — original approvals never replay' };
    }
    try {
      await deps.act(action);
    } catch (e) {
      return { done: false, matched, total: session.steps.length, stoppedAt: step.step_index,
        reason: `action failed: ${String(e.message).slice(0, 200)}` };
    }
    matched++;
  }
  return { done: true, matched, total: session.steps.length, stoppedAt: null, reason: 'all steps matched and replayed' };
}

// Store one standalone screenshot (from the `screenshot` tool) as a
// one-step session, so it shows in the replay UI with the rest.
function storeStandaloneShot(buffer, task = 'tool screenshot', { db = require('./db') } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('storeStandaloneShot needs a PNG buffer');
  const recorder = createRecorder(task, { db, device: 'tool' });
  return recorder.record({ action: { action: 'screenshot', description: task }, shot: { buffer }, result: { ok: true }, latencyMs: null })
    .then(step => { recorder.finish('done'); return { sessionId: recorder.sessionId, ...step }; });
}

module.exports = { createRecorder, listSessions, getSession, getShot, purgeSession, replaySession, pruneShots, storeStandaloneShot, SHOTS_DIR, MAX_SHOTS, hashBuffer };
