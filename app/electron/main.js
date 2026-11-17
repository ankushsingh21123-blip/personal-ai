// Piplet desktop shell (Electron, Windows-first, Linux too).
//
// What this shell owns: the app window, the system tray, the
// single-instance lock, the server lifecycle, and clean shutdown.
// What it does NOT add: any agent power. The renderer is the same
// loopback web UI the server already serves; the brain, tools,
// memory, skills, approvals, freeze, routines, queue, replay and
// audit chain all run in the existing server code, required
// in-process below. The shell is a local UI host, nothing more.
//
// Security posture (see SYSTEM-DESIGN-V2.md §3):
// - contextIsolation on, nodeIntegration off, sandbox on.
// - IPC is ONE allowlisted channel (piplet:token) via the preload
//   bridge. No other channel exists.
// - The window may only navigate to this app's own loopback URL.
//   External links open in the system browser, never in the window.
// - The server binds 127.0.0.1 only, exactly as in `npm start`.
// - Single-instance lock: a second launch focuses the running app.
//
// Data locations (all under Electron's userData dir, e.g.
// %APPDATA%/Piplet on Windows, ~/.config/Piplet on Linux):
//   data/personal-ai.db  — SQLite (same schema as the server)
//   data/shots/          — replay screenshots
//   .env.local           — keys + ANKU_TOKEN (mode 600)
//   skills/              — working copy of the bundled skills
// The packaged app itself is a read-only asar; nothing is written
// beside the code. PIPLET_USERDATA overrides the user-data dir
// (tests / portable runs). PIPLET_FIXED_PORT pins the server port
// (tests). PIPLET_DB_PATH / PIPLET_DATA_DIR / PIPLET_ENV_PATH /
// PIPLET_SKILLS_DIR still win when set explicitly.
'use strict';

const electron = require('electron');
if (!electron || !electron.app) {
  console.error('[piplet] Run the desktop app with Electron: npm run electron (or the installed Piplet app).');
  process.exit(1);
}
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = electron;
const fs = require('fs');
const path = require('path');
const { resolveUserDataDir, appPaths, bundledSkillsDir, ensureSkillsCopy, pickFreePort, buildServerEnv } = require('./paths');

const APP_NAME = 'Piplet';
const APP_ID = 'app.piplet';

// Portable/test override must be applied before the app is ready.
if (process.env.PIPLET_USERDATA) {
  app.setPath('userData', path.resolve(process.env.PIPLET_USERDATA));
}
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Single-instance lock: a second launch focuses the running window
// instead of starting a second server + second database writer.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[piplet] another instance is already running — focusing it instead');
  app.quit();
}

let win = null;
let tray = null;
let serverMod = null;
let serverPort = 0;
let quitting = false;
let shuttingDown = false;
let logPath = null;
let logStream = null;
let dataDirShown = null;

// The installed app has no visible terminal, so server + shell output
// is mirrored to <userData>/app.log (appended, never truncated) for
// troubleshooting. stdout keeps working exactly as before.
function setupLogFile(userDataDir) {
  logPath = path.join(userDataDir, 'app.log');
  dataDirShown = userDataDir;
  try {
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const origLog = console.log;
    const origErr = console.error;
    const write = (args) => {
      try {
        logStream.write(`[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`);
      } catch { /* logging must never break the app */ }
    };
    console.log = (...args) => { origLog(...args); write(args); };
    console.error = (...args) => { origErr(...args); write(args); };
  } catch (e) {
    console.error('[piplet] log file unavailable:', e.message);
  }
}

function iconPath() {
  // electron-builder packs electron/ inside the asar; nativeImage can
  // read through the asar. If the file is missing, callers fall back
  // to the default icon rather than crashing.
  const p = path.join(__dirname, 'icon.png');
  return fs.existsSync(p) ? p : null;
}

function appUrl() {
  return `http://127.0.0.1:${serverPort}/`;
}

function isAppUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:'
      && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
      && Number(u.port) === serverPort);
  } catch { return false; }
}

function openExternalIfSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') shell.openExternal(url);
  } catch { /* not a URL — ignore */ }
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function freezeModule() {
  // Same process, same require cache as the server: toggling freeze
  // here toggles the same persisted state the server enforces.
  try { return require('../freeze'); } catch { return null; }
}

function buildTrayMenu() {
  const freeze = freezeModule();
  const frozen = freeze ? freeze.isFrozen() : false;
  return Menu.buildFromTemplate([
    {
      label: 'Show Piplet',
      click: () => { if (win) { win.show(); win.focus(); } },
    },
    {
      label: frozen ? 'Unfreeze agent' : 'Freeze agent',
      click: () => {
        if (freeze) freeze.setFrozen(!frozen, frozen ? 'tray unfreeze' : 'tray freeze');
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Open app log',
      click: () => { if (logPath) shell.showItemInFolder(logPath); },
    },
    {
      label: 'Open data folder',
      click: () => { if (dataDirShown) shell.openPath(dataDirShown); },
    },
    { type: 'separator' },
    {
      label: 'Quit Piplet',
      click: () => { quitting = true; app.quit(); },
    },
  ]);
}

function createTray() {
  try {
    const icon = iconPath();
    if (!icon) { console.error('[piplet] tray icon missing — running without a tray icon'); return; }
    tray = new Tray(nativeImage.createFromPath(icon));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => { if (win) { win.isVisible() ? win.focus() : win.show(); } });
  } catch (e) {
    // A tray failure (e.g. no system tray in this desktop session)
    // must never kill the app — the window still works.
    console.error('[piplet] tray unavailable:', e.message);
    tray = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    title: APP_NAME,
    icon: iconPath() || undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Close hides to the tray; Quit comes from the tray menu. A tray-less
  // session still quits cleanly via the menu / CmdOrCtrl+Q.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  // The window may only ever show this app's own loopback UI.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) { e.preventDefault(); openExternalIfSafe(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[piplet] window failed to load (${code}): ${desc}`);
  });
  win.loadURL(appUrl());
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Agent',
      submenu: [
        {
          label: 'Freeze / Unfreeze',
          click: () => {
            const freeze = freezeModule();
            if (freeze) freeze.setFrozen(!freeze.isFrozen(), 'menu toggle');
            if (tray) tray.setContextMenu(buildTrayMenu());
          },
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Piplet',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About Piplet',
              message: 'Piplet — Ankush\'s Personal AI',
              detail: 'Local-first, $0, deny-first. Your data stays on this machine.\n\nRepo: https://github.com/ankushsingh21123-blip/personal-ai',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function shutdown() {
  // Stop the Telegram poller first (no new turns), then the HTTP
  // server, then close the database. Each step is guarded: a failure
  // in one must not block the rest, and shutdown never hangs.
  try {
    if (serverMod && serverMod.telegramBot && typeof serverMod.telegramBot.stop === 'function') {
      await serverMod.telegramBot.stop();
    }
  } catch (e) { console.error('[piplet] telegram stop failed:', e.message); }
  try {
    if (serverMod && serverMod.schedulerTimer) clearInterval(serverMod.schedulerTimer);
  } catch {}
  try {
    if (serverMod && serverMod.server) {
      await new Promise((resolve) => {
        const done = () => resolve();
        try { serverMod.server.close(done); } catch { done(); }
        setTimeout(done, 3000);
      });
    }
  } catch (e) { console.error('[piplet] server close failed:', e.message); }
  try {
    const { db } = require('../db');
    if (db) db.close();
  } catch (e) { console.error('[piplet] db close failed:', e.message); }
  try {
    if (logStream) logStream.end();
  } catch {}
}

app.on('second-instance', () => {
  if (win) { if (!win.isVisible()) win.show(); win.focus(); }
});

app.on('window-all-closed', (e) => {
  // Tray app: closing the window hides it; the agent keeps running
  // (routines, queue, Telegram) until Quit from the tray menu.
  e.preventDefault();
});

app.on('before-quit', async (e) => {
  if (shuttingDown) return;
  e.preventDefault();
  shuttingDown = true;
  try {
    await Promise.race([shutdown(), new Promise((r) => setTimeout(r, 8000))]);
  } finally {
    quitting = true;
    app.quit();
  }
});

app.whenReady().then(async () => {
  const userDataDir = resolveUserDataDir({ electronUserData: app.getPath('userData') });
  const paths = appPaths(userDataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  // Log file first: everything below (including the server) is recorded.
  setupLogFile(userDataDir);

  // Skills working copy (copy-once, never overwrite approvals).
  const bundled = bundledSkillsDir({ resourcesPath: process.resourcesPath, electronDir: __dirname });
  const skillsCopy = ensureSkillsCopy(bundled, paths.skillsDir);
  if (skillsCopy.copied) console.log('[piplet] skills copied to user data dir');
  else if (skillsCopy.reason && skillsCopy.reason !== 'exists') console.log(`[piplet] skills copy skipped: ${skillsCopy.reason}`);

  // Port + env BEFORE requiring the server: it binds on require.
  serverPort = await pickFreePort({ fixedPort: process.env.PIPLET_FIXED_PORT });
  Object.assign(process.env, buildServerEnv({ paths, port: serverPort }));

  // The one allowlisted IPC channel: the session token for the UI.
  // The token is generated/loaded by the server into process.env.
  ipcMain.handle('piplet:token', () => process.env.ANKU_TOKEN || '');

  serverMod = require('../server.js');
  const healthy = await waitForHealth(serverPort);
  if (!healthy) {
    dialog.showErrorBox('Piplet failed to start', 'The local server did not answer its health check. See the log and try again.');
    app.exit(1);
    return;
  }
  console.log(`[piplet] server up on http://127.0.0.1:${serverPort} — user data: ${userDataDir}`);
  buildMenu();
  createWindow();
  createTray();
}).catch((e) => {
  console.error('[piplet] fatal startup error:', e);
  app.exit(1);
});
