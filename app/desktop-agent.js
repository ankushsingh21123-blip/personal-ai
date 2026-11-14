// Desktop agent — LAPTOP-ONLY process (Windows). The app server never
// touches the mouse or keyboard itself; this small agent does, on the
// user's own machine, accepting actions ONLY from the local server on
// loopback, with the same token auth as the app.
//   Run on the laptop (PowerShell, from the app folder):
//     node desktop-agent.js
//   It listens on 127.0.0.1:3101 (DESKTOP_AGENT_PORT), never 0.0.0.0.
// Actuation is PowerShell + .NET only — no extra install, $0:
//   mouse: user32 SetCursorPos + mouse_event (P/Invoke via Add-Type)
//   keyboard: System.Windows.Forms.SendKeys
//   screenshot: System.Drawing Graphics.CopyFromScreen
// Safety (spec §2.5/§2.6): every action is validated by the SAME
// validateAction() the server uses (destructive acts need an approved
// approval id; sensitive acts are refused outright). The agent ALSO
// refuses to act when the foreground window is a UAC/consent prompt
// (best-effort check, logged). A visible indicator window shows while a
// control session is active, with a Freeze button that calls the app's
// /api/freeze endpoint. A global ESC hotkey is NOT implemented (it needs
// a low-level keyboard hook) — freeze via the indicator button, the web
// UI, or Telegram /freeze. This is stated honestly, not hidden.
// This file does NOT run on this VM (Linux) — it refuses to start with a
// clear message. Live execution is UNPROVEN until it runs on the laptop.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

if (process.platform !== 'win32') {
  console.error('[desktop-agent] REFUSING TO START: this agent runs on Windows only (the laptop). Platform here: ' + process.platform);
  process.exit(1);
}

const { validateAction } = require('./desktop');

// --- token (same .env.local as the server, never logged) --------------------
const ENV_PATH = path.join(__dirname, '.env.local');
function loadToken() {
  if (process.env.ANKU_TOKEN) return process.env.ANKU_TOKEN;
  if (fs.existsSync(ENV_PATH)) {
    const m = fs.readFileSync(ENV_PATH, 'utf8').match(/^ANKU_TOKEN=(\S+)/m);
    if (m) return m[1];
  }
  return '';
}
const TOKEN = loadToken();
if (!TOKEN) {
  console.error('[desktop-agent] REFUSING TO START: no ANKU_TOKEN in env or .env.local — start the app server first (it generates one).');
  process.exit(1);
}

const PORT = Number(process.env.DESKTOP_AGENT_PORT || 3101);
const HOST = '127.0.0.1';

// --- PowerShell helpers ------------------------------------------------------
// Arguments travel as base64 (text) or plain integers — never interpolated
// into the script, so no PowerShell injection is possible from an action.
function runPs(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, ...args],
      { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`powershell failed: ${(stderr || err.message).slice(0, 300)}`));
        resolve(stdout);
      });
  });
}

const ADD_TYPE_MOUSE = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, WHEEL = 0x0800;
}
'@;
`;

async function foregroundWindowTitle() {
  try {
    const out = await runPs(ADD_TYPE_MOUSE + `$sb = New-Object System.Text.StringBuilder 256; [Mouse]::GetWindowText([Mouse]::GetForegroundWindow(), $sb, 256) | Out-Null; $sb.ToString()`);
    return String(out).trim();
  } catch { return ''; }
}

async function refuseIfAdminPrompt() {
  const title = await foregroundWindowTitle();
  if (/user account control|consent/i.test(title)) {
    throw new Error('denied: foreground window is a UAC/admin prompt — admin approvals are the user\'s own act, never automated');
  }
}

function screenSizePs() {
  return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height;`;
}

async function getScreenSize() {
  const out = await runPs(screenSizePs());
  const [w, h] = String(out).trim().split(/\s+/).map(Number);
  if (!w || !h) throw new Error('could not read screen size');
  return { width: w, height: h };
}

async function doScreenshot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ankush-ai-shot-'));
  const tmp = path.join(dir, 'shot.png');
  try {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
      `$b=[System.Drawing.Bitmap]::new([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height);` +
      `$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen(0,0,0,0,$b.Size);$b.Save($args[0]);`;
    await runPs(ps, [tmp]);
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
}

async function doClick(xNorm, yNorm) {
  await refuseIfAdminPrompt();
  const { width, height } = await getScreenSize();
  const x = Math.round(xNorm * width);
  const y = Math.round(yNorm * height);
  await runPs(ADD_TYPE_MOUSE + `[Mouse]::SetCursorPos([int]$args[0], [int]$args[1]); [Mouse]::mouse_event([Mouse]::LEFTDOWN, 0, 0, 0, 0); Start-Sleep -Milliseconds 60; [Mouse]::mouse_event([Mouse]::LEFTUP, 0, 0, 0, 0);`,
    [String(x), String(y)]);
  return { ok: true, x, y };
}

async function doType(textB64) {
  await refuseIfAdminPrompt();
  // SendKeys special chars (+ ^ % ~ ( ) { } [ ]) are escaped by wrapping in
  // braces — done in PowerShell so the escaping is exact.
  const ps = `Add-Type -AssemblyName System.Windows.Forms;` +
    `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]));` +
    `$t = $t -replace '([+^%~(){}[\\]])','{$1}';` +
    `[System.Windows.Forms.SendKeys]::SendWait($t);`;
  await runPs(ps, [textB64]);
  return { ok: true };
}

async function doScroll(amount) {
  await refuseIfAdminPrompt();
  const delta = Math.round(amount * 120);
  await runPs(ADD_TYPE_MOUSE + `[Mouse]::mouse_event([Mouse]::WHEEL, 0, 0, [uint][int]$args[0], 0);`, [String(delta)]);
  return { ok: true, amount };
}

const KEY_MAP = {
  Enter: '{ENTER}', Tab: '{TAB}', Escape: '{ESC}', Backspace: '{BACKSPACE}', Delete: '{DEL}',
  Up: '{UP}', Down: '{DOWN}', Left: '{LEFT}', Right: '{RIGHT}', Home: '{HOME}', End: '{END}',
  PageUp: '{PGUP}', PageDown: '{PGDN}', Space: ' ', F1: '{F1}', F5: '{F5}',
};

async function doKey(keyName) {
  await refuseIfAdminPrompt();
  // Ctrl+C / Ctrl+V / Alt+Tab style combos: SendKeys ^c, ^v, %{TAB}.
  let send = KEY_MAP[keyName];
  if (!send) {
    const m = keyName.match(/^(Ctrl|Alt|Shift)\+([A-Za-z0-9])$/);
    if (m) {
      const mod = { Ctrl: '^', Alt: '%', Shift: '+' }[m[1]];
      send = mod + m[2].toLowerCase();
    } else if (/^[A-Za-z0-9]$/.test(keyName)) {
      send = keyName;
    } else {
      throw new Error(`key not supported by the desktop agent: ${keyName}`);
    }
  }
  const b64 = Buffer.from(send, 'utf8').toString('base64');
  const ps = `Add-Type -AssemblyName System.Windows.Forms;` +
    `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]));` +
    `[System.Windows.Forms.SendKeys]::SendWait($k);`;
  await runPs(ps, [b64]);
  return { ok: true, key: keyName };
}

// --- On-screen indicator ------------------------------------------------------
// A small always-on-top window ("Personal AI is controlling the desktop")
// with a Freeze button. Best-effort: if it fails to spawn, the agent logs
// and continues — freeze is still available via the web UI and Telegram.
// The button calls the app server's /api/freeze with the token.
let indicatorProc = null;
function showIndicator() {
  if (indicatorProc) return;
  const appPort = process.env.PORT || 3100;
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
    `$f=New-Object System.Windows.Forms.Form; $f.Text='Personal AI'; $f.TopMost=$true; $f.Width=340; $f.Height=90; $f.StartPosition='Manual'; $f.Location=New-Object System.Drawing.Point(20,20);` +
    `$l=New-Object System.Windows.Forms.Label; $l.Text='Personal AI is controlling the desktop'; $l.Width=300; $l.Top=10; $l.Left=10; $f.Controls.Add($l);` +
    `$b=New-Object System.Windows.Forms.Button; $b.Text='Freeze'; $b.Top=40; $b.Left=10; $b.Width=100;` +
    `$b.Add_Click({ try { Invoke-RestMethod -Uri 'http://127.0.0.1:${appPort}/api/freeze' -Method Post -Headers @{'X-Anku-Token'='${TOKEN}'; 'Content-Type'='application/json'} -Body '{"frozen":true,"reason":"indicator button"}' -TimeoutSec 5 | Out-Null } catch {} });` +
    `$f.Controls.Add($b); [void]$f.ShowDialog();`;
  const { spawn } = require('child_process');
  try {
    indicatorProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    indicatorProc.on('exit', () => { indicatorProc = null; });
  } catch (e) {
    console.error('[desktop-agent] indicator failed to start (continuing without it):', e.message);
    indicatorProc = null;
  }
}
function hideIndicator() {
  if (indicatorProc) { try { indicatorProc.kill(); } catch {} indicatorProc = null; }
}

// --- HTTP server ---------------------------------------------------------------
function authed(req) {
  const token = req.headers['x-anku-token'] || '';
  const a = Buffer.from(String(token));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100 * 1024) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, service: 'ankush-desktop-agent' })); return;
  }
  if (!authed(req)) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'unauthorised: X-Anku-Token required' })); return; }
  try {
    if (req.url === '/screenshot' && req.method === 'GET') {
      const buf = await doScreenshot();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, imageBase64: buf.toString('base64'), mimeType: 'image/png' }));
      return;
    }
    if (req.url === '/action' && req.method === 'POST') {
      const body = await readBody(req);
      const action = validateAction(body, { approvalId: body.approvalId });
      showIndicator();
      let out;
      if (action.action === 'click') out = await doClick(action.x, action.y);
      else if (action.action === 'type') out = await doType(Buffer.from(action.text, 'utf8').toString('base64'));
      else if (action.action === 'scroll') out = await doScroll(action.amount);
      else if (action.action === 'key') out = await doKey(action.key);
      else if (action.action === 'screenshot') { const buf = await doScreenshot(); out = { ok: true, imageBase64: buf.toString('base64'), mimeType: 'image/png' }; }
      else if (action.action === 'wait') { await new Promise(r => setTimeout(r, action.ms)); out = { ok: true, ms: action.ms }; }
      res.writeHead(200); res.end(JSON.stringify(out));
      return;
    }
    if (req.url === '/indicator/hide' && req.method === 'POST') {
      hideIndicator();
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }
    res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    res.writeHead(403); res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 300) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[desktop-agent] listening on http://${HOST}:${PORT} (loopback only) — Windows desktop control ready`);
});
process.on('SIGINT', () => { hideIndicator(); process.exit(0); });
process.on('SIGTERM', () => { hideIndicator(); process.exit(0); });
