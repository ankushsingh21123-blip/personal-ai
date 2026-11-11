// Internship Tracker — tests. Run with: npm test  (node --test)
// These tests hit the LIVE server over HTTP (spawned as a child process on
// 127.0.0.1), not the Express app object in-process. They cover:
//   auth (missing/wrong token), validation, full CRUD, status filter,
//   deadline sorting, stats, and database persistence across a restart.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 34123;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-for-internship-tracker-only';
const PROJECT_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internship-tracker-test-'));
const DB_PATH = path.join(tmpDir, 'test.db');

let child = null;

function startServer() {
  const proc = spawn('node', ['server.js'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: String(PORT), ANKU_TOKEN: TOKEN, DB_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stderr.write('[server] ' + d));
  proc.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d));
  return proc;
}

async function waitForHealth(proc, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy in time');
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise((resolve) => {
    const done = () => resolve();
    proc.once('exit', done);
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} done(); }, 5000);
  });
}

function req(p, { token = TOKEN, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Anku-Token'] = token;
  return fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function createApp(payload) {
  const res = await req('/api/applications', { method: 'POST', body: payload });
  if (res.status !== 201) {
    const text = await res.text();
    assert.fail(`create should return 201, got ${res.status}: ${text}`);
  }
  const data = await res.json();
  assert.equal(data.ok, true);
  return data.application;
}

before(async () => {
  child = startServer();
  await waitForHealth(child);
});

after(async () => {
  await stopServer(child);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('health endpoint works without a token', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, 'internship-tracker');
});

test('frontend is served and contains the app (no CDN)', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Internship Tracker/);
  assert.doesNotMatch(html, /https?:\/\/(cdn|unpkg|cdnjs)/);
  const js = await (await fetch(`${BASE}/app.js`)).text();
  assert.match(js, /X-Anku-Token/);
  const css = await fetch(`${BASE}/style.css`);
  assert.equal(css.status, 200);
});

test('auth: missing token is rejected on protected routes', async () => {
  for (const p of ['/api/applications', '/api/stats']) {
    const res = await req(p, { token: null });
    assert.equal(res.status, 401, `${p} without token should be 401`);
    assert.equal((await res.json()).ok, false);
  }
});

test('auth: wrong token is rejected', async () => {
  const res = await req('/api/applications', { token: 'wrong-token' });
  assert.equal(res.status, 401);
});

test('validation: missing company and role are rejected', async () => {
  const cases = [
    {},
    { company: 'Acme' },
    { role: 'Intern' },
    { company: '   ', role: 'Intern' },
    { company: 'Acme', role: '' },
  ];
  for (const body of cases) {
    const res = await req('/api/applications', { method: 'POST', body });
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be 400`);
    assert.equal((await res.json()).ok, false);
  }
});

test('validation: bad status, deadline, link and oversized notes are rejected', async () => {
  const bad = [
    { company: 'A', role: 'R', status: 'hired' },
    { company: 'A', role: 'R', status: 'APPLIED' },
    { company: 'A', role: 'R', deadline: '20-11-2026' },
    { company: 'A', role: 'R', deadline: '2026-02-30' },
    { company: 'A', role: 'R', deadline: '2026-13-01' },
    { company: 'A', role: 'R', link: 'not-a-url' },
    { company: 'A', role: 'R', link: 'ftp://example.com/x' },
    { company: 'A', role: 'R', notes: 'x'.repeat(2001) },
  ];
  for (const body of bad) {
    const res = await req('/api/applications', { method: 'POST', body });
    assert.equal(res.status, 400, `body ${JSON.stringify(body).slice(0, 80)} should be 400`);
  }
  // Valid optional fields are accepted.
  const ok = await createApp({ company: 'Valid Co', role: 'Intern', deadline: '2026-12-01', link: 'https://example.com/jobs/1', notes: 'ok' });
  assert.equal(ok.deadline, '2026-12-01');
  assert.equal(ok.link, 'https://example.com/jobs/1');
  await req(`/api/applications/${ok.id}`, { method: 'DELETE' });
});

test('CRUD: create, read, update, delete an application end to end', async () => {
  const created = await createApp({ company: 'Acme Robotics', role: 'Backend Intern', status: 'applied', deadline: '2026-11-20', link: 'https://acme.example/careers', notes: 'via referral' });
  assert.equal(created.company, 'Acme Robotics');
  assert.equal(created.status, 'applied');
  assert.ok(created.id > 0);

  const got = await (await req(`/api/applications/${created.id}`)).json();
  assert.equal(got.application.role, 'Backend Intern');

  const updatedRes = await req(`/api/applications/${created.id}`, { method: 'PUT', body: { status: 'interview', notes: 'HR round on Monday' } });
  assert.equal(updatedRes.status, 200);
  const updated = (await updatedRes.json()).application;
  assert.equal(updated.status, 'interview');
  assert.equal(updated.notes, 'HR round on Monday');
  assert.equal(updated.company, 'Acme Robotics'); // untouched fields survive

  const badUpdate = await req(`/api/applications/${created.id}`, { method: 'PUT', body: { status: 'hired' } });
  assert.equal(badUpdate.status, 400);

  const emptyUpdate = await req(`/api/applications/${created.id}`, { method: 'PUT', body: {} });
  assert.equal(emptyUpdate.status, 400);

  const del = await req(`/api/applications/${created.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).deleted_id, created.id);

  const gone = await req(`/api/applications/${created.id}`);
  assert.equal(gone.status, 404);
  const delAgain = await req(`/api/applications/${created.id}`, { method: 'DELETE' });
  assert.equal(delAgain.status, 404);
  const putGone = await req('/api/applications/999999', { method: 'PUT', body: { status: 'offer' } });
  assert.equal(putGone.status, 404);
});

test('list: filter by status, sort by deadline, stats add up', async () => {
  const a = await createApp({ company: 'Beta Labs', role: 'SDE Intern', status: 'applied', deadline: '2026-11-20' });
  const b = await createApp({ company: 'Gamma AI', role: 'ML Intern', status: 'interview', deadline: '2026-11-15' });
  const c = await createApp({ company: 'Delta Systems', role: 'Frontend Intern', status: 'offer' }); // no deadline
  const d = await createApp({ company: 'Epsilon', role: 'Data Intern', status: 'rejected', deadline: '2026-11-10' });

  const all = (await (await req('/api/applications')).json()).applications;
  assert.ok(all.length >= 4);

  const interviews = (await (await req('/api/applications?status=interview')).json()).applications;
  assert.ok(interviews.length >= 1);
  assert.ok(interviews.every((x) => x.status === 'interview'));
  assert.ok(interviews.some((x) => x.id === b.id));

  const badFilter = await req('/api/applications?status=hired');
  assert.equal(badFilter.status, 400);
  const badSort = await req('/api/applications?sort=random');
  assert.equal(badSort.status, 400);

  const sorted = (await (await req('/api/applications?sort=deadline')).json()).applications;
  const mine = sorted.filter((x) => [a.id, b.id, c.id, d.id].includes(x.id));
  // Soonest deadline first; no-deadline last.
  assert.deepEqual(mine.map((x) => x.id), [d.id, b.id, a.id, c.id]);

  const stats = (await (await req('/api/stats')).json()).stats;
  assert.equal(stats.total, stats.applied + stats.interview + stats.offer + stats.rejected);
  assert.ok(stats.applied >= 1 && stats.interview >= 1 && stats.offer >= 1 && stats.rejected >= 1);

  // Cleanup so later tests see a clean slate.
  for (const row of [a, b, c, d]) await req(`/api/applications/${row.id}`, { method: 'DELETE' });
});

test('persistence: data survives a server restart (real SQLite file)', async () => {
  const created = await createApp({ company: 'Zeta Health', role: 'SDE Intern', status: 'applied', deadline: '2026-11-25' });

  // Restart the server against the same DB file.
  await stopServer(child);
  child = startServer();
  await waitForHealth(child);

  const res = await req(`/api/applications/${created.id}`);
  assert.equal(res.status, 200);
  const row = (await res.json()).application;
  assert.equal(row.company, 'Zeta Health');
  assert.equal(row.role, 'SDE Intern');

  const stats = (await (await req('/api/stats')).json()).stats;
  assert.ok(stats.total >= 1);

  // The DB file on disk is a real SQLite database, not a mock.
  const header = fs.readFileSync(DB_PATH).subarray(0, 16).toString('latin1');
  assert.match(header, /SQLite format 3/);

  await req(`/api/applications/${created.id}`, { method: 'DELETE' });
});
