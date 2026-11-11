// Internship Tracker — backend server.
//   frontend (public/) + backend (this file) + SQLite database (db.js)
// Security, same pattern as Ankush's personal-ai app:
//   - binds 127.0.0.1 only, never 0.0.0.0; no CORS; security headers
//   - token auth on every /api route except /api/health; token in .env.local
//     (git-ignored, generated on first start if missing), never logged
//   - JSON body limit 100kb; input validation on every write route
//   - no external requests, no paid service, $0 only
'use strict';
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { all, get, run } = require('./db');

// --- .env.local (git-ignored) ------------------------------------------------
const ENV_PATH = path.join(__dirname, '.env.local');
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
if (!process.env.ANKU_TOKEN) {
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(ENV_PATH, `# Internship Tracker — local token. NEVER commit, never paste in chat.\nANKU_TOKEN=${token}\n`, { mode: 0o600 });
  process.env.ANKU_TOKEN = token;
  console.log('[internship-tracker] generated ANKU_TOKEN in .env.local (git-ignored)');
}

const PORT = Number(process.env.PORT || 3200);
const HOST = '127.0.0.1'; // loopback only — never expose to the internet
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- auth --------------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = req.get('X-Anku-Token');
  if (!token || token !== process.env.ANKU_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorised: X-Anku-Token required' });
  }
  next();
}
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  requireAuth(req, res, next);
});

// --- validation ---------------------------------------------------------------
const STATUSES = ['applied', 'interview', 'offer', 'rejected'];

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidLink(s) {
  if (s === '' || s === null || s === undefined) return true;
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// Returns { value } on success or { error } on failure. `partial` = PUT:
// only fields present in the body are validated/returned.
function validateApplication(body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'JSON object required' };
  }
  const value = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('company')) {
    const company = typeof body.company === 'string' ? body.company.trim() : '';
    if (!company) return { error: 'company is required' };
    if (company.length > 200) return { error: 'company must be 200 characters or fewer' };
    value.company = company;
  }
  if (!partial || has('role')) {
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    if (!role) return { error: 'role is required' };
    if (role.length > 200) return { error: 'role must be 200 characters or fewer' };
    value.role = role;
  }
  if (!partial || has('status')) {
    if (!has('status')) {
      // Create without a status defaults to 'applied'; PUT without a status
      // leaves it unchanged.
      if (!partial) value.status = 'applied';
    } else {
      if (!STATUSES.includes(body.status)) {
        return { error: `status must be one of: ${STATUSES.join(', ')}` };
      }
      value.status = body.status;
    }
  }
  if (!partial || has('deadline')) {
    const deadline = body.deadline;
    if (deadline !== '' && deadline !== null && deadline !== undefined && !isValidDate(deadline)) {
      return { error: 'deadline must be a real date in YYYY-MM-DD format' };
    }
    value.deadline = deadline ? deadline : null;
  }
  if (!partial || has('link')) {
    if (!isValidLink(body.link)) return { error: 'link must be a valid http(s) URL' };
    value.link = body.link ? String(body.link).trim() : null;
  }
  if (!partial || has('notes')) {
    const notes = body.notes === undefined || body.notes === null ? '' : String(body.notes);
    if (notes.length > 2000) return { error: 'notes must be 2000 characters or fewer' };
    value.notes = notes;
  }
  return { value };
}

// --- routes -------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'internship-tracker', version: '1.0.0' }));

app.get('/api/stats', (req, res) => {
  const rows = all('SELECT status, COUNT(*) c FROM applications GROUP BY status');
  const stats = { total: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
  for (const r of rows) {
    stats[r.status] = r.c;
    stats.total += r.c;
  }
  res.json({ ok: true, stats });
});

app.get('/api/applications', (req, res) => {
  const { status, sort } = req.query;
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  if (sort !== undefined && sort !== 'deadline' && sort !== 'newest') {
    return res.status(400).json({ ok: false, error: 'sort must be deadline or newest' });
  }
  let sql = 'SELECT * FROM applications';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  // Deadline sort: soonest first, applications with no deadline last.
  sql += sort === 'deadline'
    ? ' ORDER BY (deadline IS NULL), deadline ASC, id DESC'
    : ' ORDER BY id DESC';
  res.json({ ok: true, applications: all(sql, ...params) });
});

app.get('/api/applications/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });
  const row = get('SELECT * FROM applications WHERE id = ?', id);
  if (!row) return res.status(404).json({ ok: false, error: 'application not found' });
  res.json({ ok: true, application: row });
});

app.post('/api/applications', (req, res) => {
  const { value, error } = validateApplication(req.body, false);
  if (error) return res.status(400).json({ ok: false, error });
  const r = run(
    'INSERT INTO applications (company, role, status, deadline, link, notes) VALUES (?, ?, ?, ?, ?, ?)',
    value.company, value.role, value.status || 'applied', value.deadline, value.link, value.notes || '',
  );
  const row = get('SELECT * FROM applications WHERE id = ?', Number(r.lastInsertRowid));
  res.status(201).json({ ok: true, application: row });
});

app.put('/api/applications/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });
  const existing = get('SELECT * FROM applications WHERE id = ?', id);
  if (!existing) return res.status(404).json({ ok: false, error: 'application not found' });
  const { value, error } = validateApplication(req.body, true);
  if (error) return res.status(400).json({ ok: false, error });
  const keys = Object.keys(value);
  if (keys.length === 0) return res.status(400).json({ ok: false, error: 'no updatable fields provided' });
  const set = keys.map((k) => `${k} = ?`).join(', ');
  run(`UPDATE applications SET ${set}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => value[k]), id);
  res.json({ ok: true, application: get('SELECT * FROM applications WHERE id = ?', id) });
});

app.delete('/api/applications/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });
  const existing = get('SELECT * FROM applications WHERE id = ?', id);
  if (!existing) return res.status(404).json({ ok: false, error: 'application not found' });
  run('DELETE FROM applications WHERE id = ?', id);
  res.json({ ok: true, deleted_id: id });
});

app.use((err, req, res, next) => res.status(400).json({ ok: false, error: 'bad request' }));

let server = null;
if (require.main === module) {
  server = app.listen(PORT, HOST, () => {
    console.log(`[internship-tracker] listening on http://${HOST}:${PORT} (loopback only)`);
  });
}
module.exports = { app, server, STATUSES };
