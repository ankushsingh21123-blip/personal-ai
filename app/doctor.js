// Doctor — verify a laptop/VM install instead of assuming it works.
//   node doctor.js            — print a pass/fail checklist, exit 1 on failure
//   node doctor.js --json      — same, as JSON
// Every check prints the exact fix command on failure. API keys are
// reported as present/missing ONLY — never printed. Optional checks
// (Ollama, ADB, desktop agent) fail soft: they say what is missing and
// what needs it, without failing the whole run.
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const APP_DIR = __dirname;
const ROOT_DIR = path.join(__dirname, '..');

function versionOk(version) {
  const m = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  if (major === 24) return minor > 22 || (minor === 22 && patch >= 1);
  if (major === 22) return minor > 23 || (minor === 23 && patch >= 4);
  if (major === 26) return minor > 12 || (minor === 12 && patch >= 1);
  return major > 26;
}

async function runChecks(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const fetchImpl = deps.fetchImpl || fetch;
  const runCmd = deps.runCmd || ((cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => err ? reject(err) : resolve(String(stdout || '')));
  }));
  const checks = [];
  const check = (name, required, ok, detail, fix) => checks.push({ name, required, ok: !!ok, detail: String(detail || ''), fix: fix || null });

  // 1. Node version floor (CVE-2026-111497 — same floor server.js enforces).
  check('node version', true, versionOk(process.version), process.version,
    'Install Node 24.22.1+ (or 22.23.4+ / 26.12.1+) from https://nodejs.org — see SETUP.md Phase 0');

  // 2. Dependencies installed.
  let depsOk = true; let depsDetail = '';
  try { require.resolve('express', { paths: [APP_DIR] }); } catch { depsOk = false; depsDetail = 'express missing'; }
  try { require.resolve('playwright', { paths: [APP_DIR] }); } catch { depsOk = false; depsDetail = (depsDetail ? depsDetail + ', ' : '') + 'playwright missing'; }
  try { require.resolve('node:sqlite'); } catch { depsOk = false; depsDetail = (depsDetail ? depsDetail + ', ' : '') + 'node:sqlite missing (Node too old)'; }
  check('dependencies', true, depsOk, depsDetail || 'express, playwright, node:sqlite present',
    'From the app folder: npm install');

  // 3. Playwright Chromium binary present.
  let pwOk = false; let pwDetail = '';
  try {
    const pw = require('playwright');
    const exe = pw.chromium.executablePath();
    pwOk = !!exe && fs.existsSync(exe);
    pwDetail = pwOk ? exe : 'binary not found';
  } catch (e) { pwDetail = String(e.message).slice(0, 120); }
  check('playwright chromium', true, pwOk, pwDetail, 'npx playwright install chromium');

  // 4. At least one brain path: a key, or Ollama reachable.
  const keyVars = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const present = keyVars.filter(v => env[v]);
  let ollamaUp = false;
  try {
    const host = (env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const r = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) });
    ollamaUp = r.ok;
  } catch {}
  check('brain available', true, present.length > 0 || ollamaUp,
    present.length ? `keys present: ${present.join(', ')} (values never shown)` : (ollamaUp ? 'no keys, but Ollama is reachable' : 'no API keys and Ollama not reachable'),
    'Add a key in the Settings page (or .env.local — see docs/API-KEYS.md), or start Ollama: ollama serve');

  // 5. Ollama (optional — local/offline path).
  check('ollama (optional)', false, ollamaUp, ollamaUp ? 'reachable' : 'not reachable',
    'Install from https://ollama.com, then: ollama pull qwen3:8b && ollama serve');

  // 6. .env.local permissions (when the file exists).
  const envPath = path.join(APP_DIR, '.env.local');
  if (fs.existsSync(envPath)) {
    const mode = fs.statSync(envPath).mode & 0o777;
    check('.env.local permissions', true, mode === 0o600, `mode ${mode.toString(8)}`,
      'chmod 600 app/.env.local');
  } else {
    check('.env.local permissions', true, true, 'no .env.local yet — the server creates one on first start (mode 600)');
  }

  // 7. Database writable.
  let dbOk = false; let dbDetail = '';
  try {
    const { getSetting } = require('./db');
    getSetting('device_id');
    dbOk = true; dbDetail = 'SQLite readable';
  } catch (e) { dbDetail = String(e.message).slice(0, 120); }
  check('database', true, dbOk, dbDetail, 'Check app/data/ is writable, or delete app/data/personal-ai.db* and restart (fresh DB)');

  // 8. Ports (informational — occupied means the server may already run).
  for (const port of [3100, 3101]) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    check(`port ${port}`, false, true, free ? 'free' : `in use — a server may already be running (fine)`);
  }

  // 9. ADB (optional — phone control).
  let adbOk = false;
  try { await runCmd(env.ADB_PATH || 'adb', ['version']); adbOk = true; } catch {}
  check('adb (optional, phone)', false, adbOk, adbOk ? 'adb present' : 'adb not found',
    'Install Android platform-tools and enable USB debugging on the phone — see SETUP.md Phase 4');

  // 10. Desktop agent (optional, Windows laptop only).
  if (platform === 'win32') {
    let agentUp = false;
    try {
      const r = await fetchImpl(`http://127.0.0.1:${env.DESKTOP_AGENT_PORT || 3101}/health`, { signal: AbortSignal.timeout(3000) });
      agentUp = r.ok;
    } catch {}
    check('desktop agent (optional)', false, agentUp, agentUp ? 'running' : 'not running',
      'From the app folder, second PowerShell window: node desktop-agent.js');
  } else {
    check('desktop agent (optional)', false, true, 'not applicable here — runs on the Windows laptop only');
  }

  // 11. .gitignore covers the private paths.
  let giOk = false; let giDetail = '';
  try {
    const gi = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
    const need = ['.env.local', 'data/*.db', 'data/shots/'];
    const missing = need.filter(n => !gi.includes(n));
    giOk = missing.length === 0;
    giDetail = giOk ? 'covers .env.local, data/*.db, data/shots/' : `missing: ${missing.join(', ')}`;
  } catch (e) { giDetail = String(e.message).slice(0, 120); }
  check('.gitignore (secrets)', true, giOk, giDetail, 'Re-clone or restore .gitignore from the repo — never commit without it');

  return { ok: checks.filter(c => c.required).every(c => c.ok), checks };
}

async function main() {
  const { ok, checks } = await runChecks();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    console.log('Piplet — doctor\n');
    for (const c of checks) {
      console.log(`${c.ok ? 'PASS' : c.required ? 'FAIL' : 'SKIP'}  ${c.name} — ${c.detail}`);
      if (!c.ok && c.fix) console.log(`       fix: ${c.fix}`);
    }
    console.log(ok ? '\nAll required checks passed.' : '\nSome required checks failed — see the fix lines above.');
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch(e => { console.error('doctor failed:', e.message); process.exit(1); });

module.exports = { runChecks, versionOk };
