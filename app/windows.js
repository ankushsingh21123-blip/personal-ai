// Windows / apps — list, focus, and launch desktop windows (Windows only,
// incl. WSL2 interop via powershell.exe on PATH). Fixed PowerShell
// scripts; user input travels as $args only — never interpolated into a
// script, so no PowerShell injection is possible.
//
//   listWindows() — visible top-level windows: pid, process, title (cap 100)
//   focusWindow({pid} | {title}) — bring a window to the foreground
//   openApp(name) — launch an allowlisted app only (no arbitrary paths or
//     commands; launching anything else is the user's own act)
// `run` is injectable for tests.
'use strict';
const { execFile } = require('child_process');

const OPEN_APP_ALLOWLIST = {
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  paint: 'mspaint.exe',
  code: 'code',
  chrome: 'chrome.exe',
  firefox: 'firefox.exe',
  edge: 'msedge.exe',
  explorer: 'explorer.exe',
  terminal: 'wt.exe',
};

function defaultRun(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 200)}`));
        resolve(String(stdout || ''));
      });
  });
}

function requirePowershell(deps) {
  // powershell.exe exists on win32, and on WSL2 when Windows interop is
  // enabled. Anywhere else there is no Windows desktop to control.
  if (deps.run) return deps.run;
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    throw new Error('window control needs Windows (or WSL2 with powershell.exe on PATH)');
  }
  return defaultRun;
}

async function runPs(script, args, run) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, ...args]);
}

async function listWindows(deps = {}) {
  const run = requirePowershell(deps);
  const script = `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ` +
    `Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;
  const out = await runPs(script, [], run);
  const trimmed = String(out).trim();
  if (!trimmed) return [];
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error('could not parse window list'); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.slice(0, 100).map(r => ({
    pid: Number(r.Id), process: String(r.ProcessName || ''), title: String(r.MainWindowTitle || '').slice(0, 200),
  }));
}

async function focusWindow(target, deps = {}) {
  const run = requirePowershell(deps);
  if (!target || typeof target !== 'object') throw new Error('focusWindow needs { pid } or { title }');
  let script;
  let args;
  if (target.pid !== undefined) {
    const pid = Number(target.pid);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('focusWindow pid must be a positive integer');
    script = `Add-Type -TypeDefinition @'\nusing System; using System.Runtime.InteropServices;\npublic static class FG { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }\n'@;\n` +
      `$p = Get-Process -Id ([int]$args[0]) -ErrorAction Stop; if ($p.MainWindowHandle -eq 0) { throw 'window has no main handle' }; [FG]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;`;
    args = [String(pid)];
  } else if (typeof target.title === 'string') {
    if (!target.title.trim() || target.title.length > 200) throw new Error('focusWindow title must be 1..200 chars');
    script = `Add-Type -TypeDefinition @'\nusing System; using System.Runtime.InteropServices;\npublic static class FG { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }\n'@;\n` +
      `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq $args[0] } | Select-Object -First 1; if (-not $p) { throw 'no window with that exact title' }; [FG]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;`;
    args = [target.title];
  } else {
    throw new Error('focusWindow needs { pid } or { title }');
  }
  await runPs(script, args, run);
  return { ok: true };
}

async function openApp(name, deps = {}) {
  const run = requirePowershell(deps);
  if (typeof name !== 'string' || !OPEN_APP_ALLOWLIST[name.toLowerCase()]) {
    throw new Error(`openApp allowlist only: ${Object.keys(OPEN_APP_ALLOWLIST).join(', ')}`);
  }
  const exe = OPEN_APP_ALLOWLIST[name.toLowerCase()];
  // The executable name is from the allowlist and travels as $args[0];
  // Start-Process resolves it via PATH / App Paths on the laptop.
  await runPs(`Start-Process -FilePath $args[0]`, [exe], run);
  return { ok: true, app: name.toLowerCase() };
}

module.exports = { listWindows, focusWindow, openApp, OPEN_APP_ALLOWLIST };
