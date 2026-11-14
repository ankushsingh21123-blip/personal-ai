// Clipboard — read/write the system clipboard, deny-first.
//
// The clipboard can hold passwords. This module caps reads (2000 chars),
// caps writes (4000 chars), and never logs content — the tools layer
// audits LENGTH ONLY. Clipboard content is treated as sensitive data: the
// agent is instructed never to paste it into a message, a file, or a
// chat reply without the user asking. There is no clipboard-history or
// clipboard-sync feature, by design.
//
// Backends (exact argv via execFile, no shell):
//   win32  — PowerShell Get-Clipboard -Raw / Set-Clipboard (base64 arg)
//   darwin — pbpaste / pbcopy
//   linux  — wl-paste/wl-copy (Wayland) then xclip, then xsel
// `run` is injectable for tests.
'use strict';
const { execFile } = require('child_process');

const GET_CAP = 2000;
const SET_CAP = 4000;

function defaultRun(cmd, args, input) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 1024 * 1024, input: input || undefined, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 200)}`));
        resolve(String(stdout || ''));
      });
  });
}

// Candidate backends per platform. Each entry: { get: [cmd, args], set: [cmd, args] }.
// `input` carries the text for set commands (stdin); win32 uses a base64 argv instead.
function candidates(platform) {
  if (platform === 'win32') {
    return [{
      get: ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']],
      set: (b64) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0])); Set-Clipboard -Value $t', b64]],
    }];
  }
  if (platform === 'darwin') {
    return [{ get: ['pbpaste', []], set: () => ['pbcopy', []] }];
  }
  // Linux: Wayland first (wl-*), then X11 (xclip, xsel). Order matters:
  // wl-paste fails fast when there is no Wayland session.
  return [
    { get: ['wl-paste', []], set: () => ['wl-copy', []] },
    { get: ['xclip', ['-selection', 'clipboard', '-o']], set: () => ['xclip', ['-selection', 'clipboard', '-i']] },
    { get: ['xsel', ['--clipboard', '--output']], set: () => ['xsel', ['--clipboard', '--input']] },
  ];
}

async function getClipboard(deps = {}) {
  const platform = deps.platform || process.platform;
  const run = deps.run || defaultRun;
  const errors = [];
  for (const c of candidates(platform)) {
    try {
      const out = await run(c.get[0], c.get[1]);
      return { text: String(out).slice(0, GET_CAP), truncated: String(out).length > GET_CAP, length: String(out).length };
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`clipboard read failed on ${platform}: ${errors.join('; ').slice(0, 300)}`);
}

async function setClipboard(text, deps = {}) {
  if (typeof text !== 'string' || text.length === 0 || text.length > SET_CAP) throw new Error(`clipboard text must be 1..${SET_CAP} chars`);
  const platform = deps.platform || process.platform;
  const run = deps.run || defaultRun;
  const errors = [];
  for (const c of candidates(platform)) {
    try {
      if (platform === 'win32') {
        const [cmd, args] = c.set(Buffer.from(text, 'utf8').toString('base64'));
        await run(cmd, args);
      } else {
        const [cmd, args] = c.set();
        await run(cmd, args, text);
      }
      return { ok: true, length: text.length };
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`clipboard write failed on ${platform}: ${errors.join('; ').slice(0, 300)}`);
}

module.exports = { getClipboard, setClipboard, GET_CAP, SET_CAP };
