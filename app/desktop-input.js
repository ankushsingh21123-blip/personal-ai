// Desktop input — every viable alternative for real OS-level control,
// probed honestly, with the fallback chain documented (computer-use cycle,
// 18 Nov 2026). Backends, in preference order:
//   1. CDP (Chrome DevTools Protocol) via Playwright — real mouse/keyboard
//      events delivered to a Chromium window on a real X session. PROVEN on
//      this VM under Xvfb (see scripts/computer-use-demo.js + cycle7 tests).
//   2. xdotool (X11) — argv builders implemented + unit-tested; the binary
//      is ABSENT on this VM, so execution is UNPROVEN until a machine with
//      xdotool runs it. Never claimed.
//   3. ydotool / wtype (Wayland) — same status as xdotool: builders tested,
//      execution unproven, binaries absent here.
//   4. Desktop agent (Windows laptop, desktop-agent.js) — PowerShell/.NET
//      input; code exists, live execution needs the laptop (UNPROVEN).
//   5. X11 root screenshot (scrot/import/xwd) — NO backend on this VM;
//      capability() reports that. Under Xvfb the CDP screenshot covers the
//      browser window; a full-desktop capture on Linux needs scrot (laptop
//      step, documented in STATUS.md).
// Input actions are validated like desktop.js (normalised 0..1 coords,
// bounded text, sensitive refused). Every executed action is audit-logged
// by the caller (computer-use.js), never here — this module only moves the
// pointer/keys and reports what it did.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const net = require('net');

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// Full environment probe — what exists HERE, right now. The computer-use
// status endpoint and the demo script both report this verbatim.
function probeEnvironment() {
  const display = process.env.DISPLAY || null;
  const wayland = process.env.WAYLAND_DISPLAY || null;
  const backends = {
    cdpViaPlaywright: (() => { try { require.resolve('playwright'); return true; } catch { return false; } })(),
    xvfb: !!which('Xvfb'),
    xdotool: !!which('xdotool'),
    ydotool: !!which('ydotool'),
    wtype: !!which('wtype'),
    scrot: !!which('scrot'),
    import: !!which('import'),
    xwd: !!which('xwd'),
    desktopAgentWindows: process.platform === 'win32',
  };
  const usable = [];
  if (backends.cdpViaPlaywright && display) usable.push('cdp');
  if (backends.xdotool && display) usable.push('xdotool');
  if ((backends.ydotool || backends.wtype) && wayland) usable.push('wayland-tools');
  if (backends.desktopAgentWindows) usable.push('desktop-agent');
  return {
    platform: process.platform,
    display,
    waylandDisplay: wayland,
    backends,
    usable,
    screenshotRoot: !!(backends.scrot || backends.import || backends.xwd || backends.desktopAgentWindows),
    note: usable.length
      ? `usable input backends here: ${usable.join(', ')}`
      : 'no live input backend on this machine — start Xvfb (Linux) or the desktop agent (Windows)',
  };
}

// --- Xvfb virtual display ---------------------------------------------------
// A REAL X11 session (virtual framebuffer): windows, input focus, and pixels
// all behave like a physical desktop. This is what makes the VM proof real
// instead of mocked. Display numbers :99..:110 are probed for a free socket.
class XvfbSession {
  constructor({ display, width = 1280, height = 800, depth = 24, spawnFn } = {}) {
    this.display = display || null;
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.spawnFn = spawnFn || spawn;
    this.proc = null;
  }

  static socketFree(displayNum) {
    return !fs.existsSync(`/tmp/.X${displayNum}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${displayNum}`);
  }

  static async waitForSocket(displayNum, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const s = net.createConnection(`/tmp/.X11-unix/X${displayNum}`);
          s.once('connect', () => { s.destroy(); resolve(); });
          s.once('error', reject);
        });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return false;
  }

  async start() {
    const xvfb = which('Xvfb');
    if (!xvfb) throw new Error('Xvfb not installed — no virtual display can be started on this machine');
    let num = null;
    if (this.display) {
      num = Number(String(this.display).replace(/^:/, '').split('.')[0]);
      if (!Number.isInteger(num)) throw new Error('display must look like ":99"');
    } else {
      for (let n = 99; n <= 110; n++) {
        if (XvfbSession.socketFree(n)) { num = n; break; }
      }
      if (num === null) throw new Error('no free X display in :99..:110');
    }
    this.display = `:${num}`;
    this.proc = this.spawnFn(xvfb, [this.display, '-screen', '0', `${this.width}x${this.height}x${this.depth}`, '-ac'], {
      stdio: 'ignore',
    });
    const ok = await XvfbSession.waitForSocket(num);
    if (!ok) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
      throw new Error(`Xvfb on ${this.display} did not come up within 10s`);
    }
    return { display: this.display, width: this.width, height: this.height };
  }

  env() {
    return { ...process.env, DISPLAY: this.display };
  }

  async stop() {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
    }
  }
}

// --- xdotool (X11) argv builders -------------------------------------------
// Pure functions — unit-tested. Execution needs the binary (absent on this
// VM) and a DISPLAY. Coordinates are PIXELS here: the caller converts from
// normalised 0..1 using the real screen size, at the actuator edge.
function xdotoolArgs(action) {
  if (!action || typeof action !== 'object') throw new Error('xdotool action must be an object');
  switch (action.action) {
    case 'click':
      return ['mousemove', String(action.x), String(action.y), 'click', '1'];
    case 'double_click':
      return ['mousemove', String(action.x), String(action.y), 'click', '--repeat', '2', '--delay', '80', '1'];
    case 'right_click':
      return ['mousemove', String(action.x), String(action.y), 'click', '3'];
    case 'move':
      return ['mousemove', String(action.x), String(action.y)];
    case 'type':
      if (typeof action.text !== 'string' || !action.text) throw new Error('xdotool type needs text');
      return ['type', '--delay', '12', '--', action.text];
    case 'key':
      if (typeof action.key !== 'string' || !action.key) throw new Error('xdotool key needs a key name');
      return ['key', action.key];
    case 'scroll': {
      const amount = action.amount || 3;
      const button = amount > 0 ? '4' : '5';
      return ['click', '--repeat', String(Math.abs(amount)), button];
    }
    default:
      throw new Error(`xdotool: unsupported action ${String(action.action)}`);
  }
}

function ydotoolArgs(action) {
  if (!action || typeof action !== 'object') throw new Error('ydotool action must be an object');
  switch (action.action) {
    case 'move':
      return ['mousemove', '--absolute', String(action.x), String(action.y)];
    case 'click':
      return ['click', '--', '0xC0'];
    case 'type':
      if (typeof action.text !== 'string' || !action.text) throw new Error('ydotool type needs text');
      return ['type', '--delay', '12', '--', action.text];
    case 'key':
      if (typeof action.key !== 'string' || !action.key) throw new Error('ydotool key needs a key name');
      return ['key', action.key];
    default:
      throw new Error(`ydotool: unsupported action ${String(action.action)} (use mousemove + click separately)`);
  }
}

function runToolBinary(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const binPath = which(bin);
    if (!binPath) return reject(new Error(`${bin} is not installed — cannot run desktop input on this machine`));
    execFile(binPath, args, {
      timeout: opts.timeoutMs || 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(opts.display ? { DISPLAY: opts.display } : {}) },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin} failed: ${String(stderr || err.message).slice(0, 200)}`));
      resolve({ ok: true, stdout: String(stdout || '').slice(0, 500) });
    });
  });
}

// --- CDP input ---------------------------------------------------------------
// Real input events via the Chrome DevTools Protocol Input domain. The CDP
// session comes from Playwright (page.context().newCDPSession(page)); the
// class only needs a { send(method, params) } object, so tests inject a
// recording fake. Coordinates are CSS pixels in the page viewport.
class CdpInput {
  constructor({ session, viewport = { width: 1280, height: 800 } } = {}) {
    if (!session || typeof session.send !== 'function') throw new Error('CdpInput needs a CDP session with send()');
    this.session = session;
    this.viewport = viewport;
  }

  async mouseMove(x, y) {
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return { ok: true, x, y };
  }

  async mouseClick(x, y, button = 'left') {
    await this.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    return { ok: true, x, y, button };
  }

  async mouseDoubleClick(x, y) {
    await this.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
    return { ok: true, x, y };
  }

  async keyPress(key, text) {
    // key: CDP key name (e.g. 'Enter', 'Tab', 'a'). text: the character to
    // insert for printable keys.
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...(text ? { text } : {}) });
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    return { ok: true, key };
  }

  async typeText(text) {
    if (typeof text !== 'string' || !text || text.length > 4000) throw new Error('typeText needs text, 1..4000 chars');
    await this.session.send('Input.insertText', { text });
    return { ok: true, chars: text.length };
  }

  async scroll(x, y, deltaY) {
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    return { ok: true, x, y, deltaY };
  }

  async screenshot() {
    const shot = await this.session.send('Page.captureScreenshot', { format: 'png' });
    if (!shot || !shot.data) throw new Error('CDP Page.captureScreenshot returned no image data');
    return { ok: true, imageBase64: shot.data, mimeType: 'image/png' };
  }

  // Normalised 0..1 → viewport pixels (conversion at the actuator edge).
  toPixels(xNorm, yNorm) {
    return { x: Math.round(xNorm * this.viewport.width), y: Math.round(yNorm * this.viewport.height) };
  }
}

module.exports = {
  probeEnvironment, XvfbSession, xdotoolArgs, ydotoolArgs, runToolBinary, CdpInput, which,
};
