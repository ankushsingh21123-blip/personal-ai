// Screen capture — screenshot the active display, on-device (Phase B).
// Screenshots are buffers in memory; they are never written to the repo,
// never logged, and only leave the machine inside a vision model call to
// the provider the user configured. Capture backends:
//   Windows (the laptop): PowerShell + .NET Graphics.CopyFromScreen — no
//     extra install, runs through the desktop agent (see desktop-agent.js).
//   Linux: scrot / ImageMagick import / gnome-screenshot (first found).
//   macOS: screencapture.
// On this VM no backend exists — capability() reports that honestly and
// capture() throws a clear error. Tests inject a capture function.
// Every capture is hashed (sha256) for the audit log: the log records the
// hash + the intended target, never the pixels.
'use strict';
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function availableBackend() {
  if (process.platform === 'win32') return { backend: 'powershell-dotnet', command: 'powershell.exe' };
  if (process.platform === 'darwin') return which('screencapture') ? { backend: 'screencapture', command: 'screencapture' } : null;
  for (const bin of ['scrot', 'import', 'gnome-screenshot']) {
    if (which(bin)) return { backend: bin, command: bin };
  }
  return null;
}

function capability() {
  const b = availableBackend();
  if (!b) return { available: false, backend: null, reason: `no screenshot backend on ${process.platform} — install scrot (Linux) or run the desktop agent on Windows` };
  return { available: true, backend: b.backend, reason: null };
}

function runCapture(bin, args, tmpFile) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err) => {
      if (err) return reject(new Error(`screenshot backend failed: ${err.message.slice(0, 200)}`));
      try {
        const buf = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        resolve(buf);
      } catch (e) { reject(new Error(`screenshot file unreadable: ${e.message}`)); }
    });
  });
}

// Capture a screenshot. Returns { buffer, mimeType, hash, width, height }.
// width/height are best-effort (PNG header parse); null when unknown.
// `captureFn` (tests / desktop agent) overrides the local backend.
async function captureScreenshot(opts = {}) {
  if (opts.captureFn) {
    const buf = await opts.captureFn();
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('captureFn must return a non-empty Buffer');
    return { buffer: buf, mimeType: 'image/png', hash: hashBuffer(buf), ...pngSize(buf) };
  }
  const b = availableBackend();
  if (!b) throw new Error(capability().reason);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ankush-ai-shot-'));
  const tmp = path.join(dir, 'shot.png');
  try {
    let buf;
    if (b.backend === 'powershell-dotnet') {
      // Windows laptop path — the desktop agent normally does this, but the
      // same snippet works when the app itself runs on Windows.
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
        `$b=[System.Drawing.Bitmap]::new([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height);` +
        `$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen(0,0,0,0,$b.Size);$b.Save('${tmp.replace(/'/g, "''")}');`;
      await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], tmp);
      buf = fs.readFileSync(tmp);
    } else if (b.backend === 'scrot') {
      buf = await runCapture(b.command, [tmp], tmp);
    } else if (b.backend === 'import') {
      buf = await runCapture(b.command, ['-window', 'root', tmp], tmp);
    } else if (b.backend === 'gnome-screenshot') {
      buf = await runCapture(b.command, ['-f', tmp], tmp);
    } else if (b.backend === 'screencapture') {
      buf = await runCapture(b.command, ['-x', tmp], tmp);
    } else {
      throw new Error(`unknown screenshot backend: ${b.backend}`);
    }
    return { buffer: buf, mimeType: 'image/png', hash: hashBuffer(buf), ...pngSize(buf) };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
}

function pngSize(buf) {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch {}
  return { width: null, height: null };
}

// Screen-state cache for the observe loop: if the new screenshot hashes the
// same as the last one, the screen did not change — the loop's stop rule
// counts consecutive unchanged observations and stops after 2.
function createScreenCache() {
  let lastHash = null;
  let unchanged = 0;
  return {
    observe(hash) {
      if (hash === lastHash) unchanged++;
      else { lastHash = hash; unchanged = 0; }
      return { unchanged, hash };
    },
    reset() { lastHash = null; unchanged = 0; },
  };
}

module.exports = { captureScreenshot, capability, hashBuffer, createScreenCache, availableBackend };
