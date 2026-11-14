// Phone control (Phase C). Android-first, honestly labelled:
//   Android — ADB-class control on a device the user owns and has
//     authorised via USB/wireless debugging: screencap, tap/swipe/keyevent,
//     app launch. Same observe → decide → act loop, same safety gates,
//     same audit log as the desktop.
//   iOS — NO general screen control exists (Apple restriction). iOS gets
//     messaging + shortcuts-grade capability only, honestly labelled — the
//     product must never imply full iPhone control.
// Presence rule (Ankush's own rule, 11 Nov 2026): phone access only when
// needed and only when the user allows it. The phone agent must be
// explicitly enabled per session (POST /api/phone/enable), expires
// automatically (default 30 min), shows as active in /api/status, and
// stops the moment the user freezes or disables it.
// No phone is attached to this VM — capability() reports that, and the
// driver is unit-tested with an injected executor.
'use strict';
const { execFile } = require('child_process');
const { audit } = require('./tools');
const { assertNotFrozen, isFrozen } = require('./freeze');

const IOS = {
  supported: false,
  control: 'not available',
  reason: 'Apple does not allow general screen control or automation from a third-party agent — no public API exists to move a cursor, tap arbitrary apps, or read another app\'s screen. iOS capability is messaging + Shortcuts only.',
  messaging: true,
  shortcuts: true,
};

// ADB allowlist — exact argv, execFile, no shell. `shell` subcommands are
// restricted to the input/am verbs below; arbitrary `adb shell <anything>`
// is never allowed.
function adbArgv(action) {
  switch (action.action) {
    case 'devices': return ['devices'];
    case 'screencap': return ['exec-out', 'screencap', '-p'];
    case 'tap': {
      if (!Number.isInteger(action.x) || !Number.isInteger(action.y) || action.x < 0 || action.y < 0) throw new Error('tap needs integer pixel x and y >= 0');
      return ['shell', 'input', 'tap', String(action.x), String(action.y)];
    }
    case 'swipe': {
      for (const k of ['x1', 'y1', 'x2', 'y2']) if (!Number.isInteger(action[k]) || action[k] < 0) throw new Error(`swipe needs integer ${k} >= 0`);
      const ms = action.ms === undefined ? 300 : action.ms;
      if (!Number.isInteger(ms) || ms < 0 || ms > 5000) throw new Error('swipe ms must be an integer 0..5000');
      return ['shell', 'input', 'swipe', String(action.x1), String(action.y1), String(action.x2), String(action.y2), String(ms)];
    }
    case 'keyevent': {
      const allowed = new Set(['KEYCODE_BACK', 'KEYCODE_HOME', 'KEYCODE_ENTER', 'KEYCODE_TAB', 'KEYCODE_ESCAPE', 'KEYCODE_DPAD_UP', 'KEYCODE_DPAD_DOWN', 'KEYCODE_DPAD_LEFT', 'KEYCODE_DPAD_RIGHT', 'KEYCODE_VOLUME_UP', 'KEYCODE_VOLUME_DOWN', 'KEYCODE_POWER', 'KEYCODE_WAKEUP', 'KEYCODE_SLEEP']);
      if (!allowed.has(action.key)) throw new Error(`keyevent not allowlisted: ${String(action.key)}`);
      return ['shell', 'input', 'keyevent', action.key];
    }
    case 'launch': {
      // App launch by https URL only (deep links) — no arbitrary intents.
      if (typeof action.url !== 'string' || !/^https:\/\//.test(action.url)) throw new Error('launch needs an https URL');
      return ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', action.url];
    }
    case 'type': {
      if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 4000) throw new Error('type needs text, 1..4000 chars');
      if (action.sensitive) throw new Error('denied: sensitive text (credentials, OTPs) is never typed on the phone');
      // adb input text: spaces become %s. No shell involved — argv only.
      return ['shell', 'input', 'text', action.text.replace(/ /g, '%s')];
    }
    case 'long_press': {
      // Long press = swipe with zero distance and a long duration.
      if (!Number.isInteger(action.x) || !Number.isInteger(action.y) || action.x < 0 || action.y < 0) throw new Error('long_press needs integer pixel x and y >= 0');
      const ms = action.ms === undefined ? 800 : action.ms;
      if (!Number.isInteger(ms) || ms < 100 || ms > 5000) throw new Error('long_press ms must be an integer 100..5000');
      return ['shell', 'input', 'swipe', String(action.x), String(action.y), String(action.x), String(action.y), String(ms)];
    }
    case 'open_app': {
      // Launch by package name via monkey (the standard ADB app-launch).
      // Package names are validated strictly — no shell, no intents.
      if (typeof action.package !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(action.package) || action.package.length > 200) {
        throw new Error('open_app needs a valid Android package name (e.g. com.example.app)');
      }
      return ['shell', 'monkey', '-p', action.package, '-c', 'android.intent.category.LAUNCHER', '1'];
    }
    case 'list_apps': {
      return ['shell', 'pm', 'list', 'packages'];
    }
    case 'dump': {
      // uiautomator XML dump of the current screen (element bounds) — the
      // element-first phone path: tap by element bounds instead of guessing
      // coordinates. Output is XML text; the caller parses bounds.
      return ['shell', 'uiautomator', 'dump', '/dev/tty'];
    }
    default: throw new Error(`unknown phone action: ${String(action.action)}`);
  }
}

class AdbDriver {
  // executor(argv) -> { stdout: Buffer|string, ok } — injectable for tests.
  // Default executor runs the real adb binary via execFile.
  constructor({ adbPath, executor } = {}) {
    this.adbPath = adbPath || process.env.ADB_PATH || 'adb';
    this.executor = executor || this.defaultExecutor.bind(this);
  }

  defaultExecutor(argv) {
    return new Promise((resolve, reject) => {
      execFile(this.adbPath, argv, { timeout: 30000, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
        if (err) return reject(new Error(`adb failed: ${err.message.slice(0, 200)}`));
        resolve({ stdout, ok: true });
      });
    });
  }

  async run(action) {
    assertNotFrozen();
    if (!phoneSessionActive()) throw new Error('phone session not enabled — enable it first (POST /api/phone/enable); phone access only when the user allows it');
    const argv = adbArgv(action);
    const r = await this.executor(argv);
    audit('phone.' + action.action, { action: action.action }, true, 'adb ok');
    return r;
  }

  async devices() {
    const r = await this.executor(['devices']);
    const text = Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout || '');
    return text.split('\n').slice(1).map(l => l.trim()).filter(Boolean)
      .map(l => { const [serial, state] = l.split(/\s+/); return { serial, state }; });
  }

  async capability() {
    try {
      const devs = await this.devices();
      const connected = devs.filter(d => d.state === 'device');
      return { available: connected.length > 0, adb: true, devices: devs, sessionActive: phoneSessionActive(), ios: IOS,
        reason: connected.length ? null : 'adb found, no authorised device connected — connect the phone and authorise USB/wireless debugging' };
    } catch (e) {
      return { available: false, adb: false, devices: [], sessionActive: phoneSessionActive(), ios: IOS,
        reason: `adb not usable: ${e.message.slice(0, 150)} — install Android platform-tools on the laptop` };
    }
  }
}

// --- Phone session (presence rule) ------------------------------------------
let session = { active: false, until: 0, reason: '' };

function enableSession({ ttlMs = 30 * 60_000, reason = '' } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 4 * 60 * 60_000) throw new Error('ttlMs must be an integer 60000..14400000 (1 min..4 h)');
  session = { active: true, until: Date.now() + ttlMs, reason: String(reason).slice(0, 200) };
  return sessionState();
}

function disableSession() {
  session = { active: false, until: 0, reason: '' };
  return sessionState();
}

function phoneSessionActive(now = Date.now()) {
  if (!session.active) return false;
  if (now >= session.until) { session.active = false; return false; }
  if (isFrozen()) return false;
  return true;
}

function sessionState(now = Date.now()) {
  const active = phoneSessionActive(now);
  return { active, until: active ? new Date(session.until).toISOString() : null, reason: active ? session.reason : '' };
}

module.exports = { AdbDriver, adbArgv, enableSession, disableSession, phoneSessionActive, sessionState, IOS };
