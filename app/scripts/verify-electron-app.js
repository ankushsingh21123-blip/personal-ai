// End-to-end verification for the PACKAGED Piplet desktop app.
//
// Launches the built Electron app (unpacked dir) under Xvfb with a
// throwaway user-data dir, then proves, against the real running app:
//   1. the window opens and renders the UI (CDP + screenshot, no token
//      prompt dialog appears — the preload bridge supplies the token)
//   2. the server auto-starts (health + status)
//   3. a real chat round-trip returns a reply (live brain)
//   4. a tool call executes (list_files)
//   5. memory write + recall works (remember_fact / recall_memory)
//   6. a settings save persists across an app restart
//   7. freeze blocks tool calls (423) and unfreeze restores them
//   8. the audit hash chain verifies
//   9. the bundled skills are present and approved
//  10. the app exits on SIGTERM and restarts cleanly on the same data
//
// Usage:
//   xvfb-run -a node scripts/verify-electron-app.js [path-to-binary]
//   (re-execs under xvfb-run itself when no DISPLAY is set)
//   Default binary: dist/linux-unpacked/Piplet (electron-builder dir
//   target). TELEGRAM stays disabled; no keys are needed — the brain
//   uses whatever providers this machine already has (Gemini helper /
//   Ollama). Exit 0 = every check passed, 1 = anything failed.
//
// This script is a VERIFIER, not a test-suite member: it is not run by
// tests/run-tests.sh (it needs a packaged build + a display).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const APP_DIR = path.join(__dirname, '..');
const PORT = Number(process.env.PIPLET_E2E_PORT || 3217);
const CDP_PORT = Number(process.env.PIPLET_E2E_CDP_PORT || 9223);
const CHAT_TIMEOUT_MS = 240000;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

function findBinary(explicit) {
  if (explicit) return explicit;
  const dir = path.join(APP_DIR, 'dist', 'linux-unpacked');
  for (const name of ['Piplet', 'piplet', 'electron']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no unpacked app found in ${dir} — build first: npm run dist:linux -- --dir`);
}

async function waitForHealth(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function readToken(userDataDir) {
  const envPath = path.join(userDataDir, '.env.local');
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^ANKU_TOKEN=(.+)$/m);
  if (!m) throw new Error('ANKU_TOKEN not found in the app user-data .env.local');
  return m[1].trim();
}

function launch(binary, userDataDir, logPath) {
  const log = fs.openSync(logPath, 'a');
  const child = spawn(binary, [`--remote-debugging-port=${CDP_PORT}`], {
    env: {
      ...process.env,
      PIPLET_USERDATA: userDataDir,
      PIPLET_FIXED_PORT: String(PORT),
      TELEGRAM_ENABLED: 'no',
      PIPLET_E2E: '1',
    },
    stdio: ['ignore', log, log],
    detached: false,
  });
  return child;
}

function stopApp(child, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => { if (!done) { done = true; resolve(how); } };
    child.once('exit', () => finish('sigterm'));
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!done) {
        try { child.kill('SIGKILL'); } catch {}
        child.once('exit', () => finish('sigkill'));
        setTimeout(() => finish('still-running'), 5000);
      }
    }, timeoutMs);
  });
}

async function main() {
  // No display? Re-exec under Xvfb once.
  if (!process.env.DISPLAY && !process.env.PIPLET_XVFB) {
    const r = spawnSync('xvfb-run', ['-a', 'node', __filename, ...process.argv.slice(2)], {
      env: { ...process.env, PIPLET_XVFB: '1' },
      stdio: 'inherit',
    });
    process.exit(r.status ?? 1);
  }

  const binary = findBinary(process.argv[2]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piplet-e2e-'));
  const logPath = path.join(userDataDir, 'app.log');
  console.log(`binary: ${binary}`);
  console.log(`user-data: ${userDataDir}`);

  const { chromium } = require('playwright');
  let child = null;
  try {
    // ---- launch 1 -------------------------------------------------------
    child = launch(binary, userDataDir, logPath);
    const healthy = await waitForHealth(PORT);
    check('server auto-starts (health)', healthy);
    if (!healthy) throw new Error('server never became healthy — see ' + logPath);
    const token = readToken(userDataDir);
    check('server generated a session token in user-data .env.local', token.length >= 32);
    const H = { 'Content-Type': 'application/json', 'X-Anku-Token': token };
    const api = async (p, opts = {}) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j };
    };

    // ---- window via CDP --------------------------------------------------
    let dialogs = 0;
    let page = null;
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      const contexts = browser.contexts();
      const pages = contexts.flatMap((c) => c.pages());
      page = pages.find((p) => p.url().includes(`127.0.0.1:${PORT}`)) || pages[0];
      page.on('dialog', async (d) => { dialogs += 1; await d.dismiss(); });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);
      const title = await page.title();
      check('window opens with the Piplet UI', /Piplet/.test(title), `title: ${title}`);
      const shotPath = path.join(userDataDir, 'window.png');
      await page.screenshot({ path: shotPath });
      const shotSize = fs.statSync(shotPath).size;
      check('window renders (screenshot non-trivial)', shotSize > 10000, `${shotSize} bytes -> ${shotPath}`);
      const bodyText = await page.evaluate(() => document.body.innerText);
      check('UI loads data without a token prompt', !/No token|token_missing/i.test(bodyText) && dialogs === 0, `${dialogs} dialog(s)`);
      check('chat input is present', await page.locator('#chat-input').count() === 1);
      await browser.close();
    } catch (e) {
      check('window opens with the Piplet UI', false, e.message);
    }

    // ---- status + skills -------------------------------------------------
    const status = await api('/api/status');
    check('status endpoint answers', status.status === 200 && status.body.ok === true);
    check('brain order resolves', Array.isArray(status.body.brain_order) && status.body.brain_order.length > 0, (status.body.brain_order || []).join(','));
    const skills = await api('/api/skills');
    const activeSkills = (skills.body.skills || []).filter((s) => s.status === 'active').map((s) => s.name);
    check('bundled skills present + approved', activeSkills.length >= 5, activeSkills.join(','));

    // ---- tool call -------------------------------------------------------
    const tool = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'list_files', args: {} }) });
    check('tool call executes (list_files)', tool.status === 200 && tool.body.ok === true, tool.body.error || '');

    // ---- memory write + recall -------------------------------------------
    const probeTopic = `e2e-probe-${Date.now()}`;
    const probeContent = 'The Electron verification probe fact: quokka-plover-77.';
    const remembered = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'remember_fact', args: { scope: 'personal', topic: probeTopic, content: probeContent, source: 'e2e' } }) });
    check('memory write (remember_fact)', remembered.status === 200 && remembered.body.ok === true);
    const recalled = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'recall_memory', args: { scope: 'personal', query: 'quokka-plover-77' } }) });
    const found = (recalled.body.facts || []).some((f) => String(f.content || '').includes('quokka-plover-77'));
    check('memory recall returns the fact', recalled.status === 200 && found);

    // ---- settings save ----------------------------------------------------
    const orderBefore = (await api('/api/settings/providers')).body.configured_order;
    const newOrder = ['ollama', 'groq', 'gemini'];
    const saved = await api('/api/settings/order', { method: 'POST', body: JSON.stringify({ order: newOrder.join(',') }) });
    check('settings save (provider order)', saved.status === 200 && JSON.stringify(saved.body.configured_order) === JSON.stringify(newOrder), `was: ${(orderBefore || []).join(',')}`);

    // ---- freeze gates ------------------------------------------------------
    const froze = await api('/api/freeze', { method: 'POST', body: JSON.stringify({ frozen: true, reason: 'e2e freeze check' }) });
    check('freeze sets', froze.status === 200 && froze.body.frozen === true);
    const blocked = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'list_files', args: {} }) });
    check('freeze blocks tool calls (423)', blocked.status === 423, `got ${blocked.status}`);
    const unfroze = await api('/api/freeze', { method: 'POST', body: JSON.stringify({ frozen: false }) });
    check('unfreeze restores', unfroze.status === 200 && unfroze.body.frozen === false);
    const toolAgain = await api('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'list_files', args: {} }) });
    check('tool calls work after unfreeze', toolAgain.status === 200 && toolAgain.body.ok === true);

    // ---- audit chain --------------------------------------------------------
    const audit = await api('/api/audit/verify');
    check('audit hash chain verifies', audit.status === 200 && audit.body.ok === true && audit.body.checked > 0, `checked ${audit.body.checked}/${audit.body.total}`);

    // ---- real chat round-trip ------------------------------------------------
    const t0 = Date.now();
    const chat = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ text: 'Reply with exactly the word OK and nothing else.' }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    const chatOk = chat.status === 200 && typeof chat.body.reply === 'string' && chat.body.reply.trim().length > 0;
    check('real chat round-trip returns a reply', chatOk, chatOk ? `${chat.body.provider}/${chat.body.model} in ${Date.now() - t0}ms: ${JSON.stringify(chat.body.reply.slice(0, 80))}` : `status ${chat.status}: ${JSON.stringify(chat.body).slice(0, 200)}`);

    // ---- restart: stop, relaunch, verify persistence -----------------------
    const stopHow = await stopApp(child);
    child = null;
    check('app exits on SIGTERM', stopHow === 'sigterm', `stopped via ${stopHow}`);
    child = launch(binary, userDataDir, logPath);
    const healthy2 = await waitForHealth(PORT);
    check('app restarts cleanly on the same data', healthy2);
    if (healthy2) {
      const token2 = readToken(userDataDir);
      check('session token survives restart (same .env.local)', token2 === token);
      const H2 = { 'Content-Type': 'application/json', 'X-Anku-Token': token2 };
      const api2 = async (p, opts = {}) => {
        const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { ...opts, headers: { ...H2, ...(opts.headers || {}) } });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      const providers2 = await api2('/api/settings/providers');
      check('settings persist across restart', JSON.stringify(providers2.body.configured_order) === JSON.stringify(newOrder), (providers2.body.configured_order || []).join(','));
      const recalled2 = await api2('/api/tools', { method: 'POST', body: JSON.stringify({ tool: 'recall_memory', args: { scope: 'personal', query: 'quokka-plover-77' } }) });
      check('memory persists across restart', (recalled2.body.facts || []).some((f) => String(f.content || '').includes('quokka-plover-77')));
      const audit2 = await api2('/api/audit/verify');
      check('audit chain still verifies after restart', audit2.body.ok === true && audit2.body.checked > 0);
      const stopHow2 = await stopApp(child);
      child = null;
      check('second shutdown is clean', stopHow2 === 'sigterm', `stopped via ${stopHow2}`);
    }
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch {} }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`---\nE2E: ${results.length - failed.length}/${results.length} checks passed. User-data dir kept for inspection: ${userDataDir}`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
