// Pure helpers for the Electron shell (main.js). No electron import,
// so plain node can require this file in unit tests.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');

// The user-data dir: PIPLET_USERDATA wins (tests / portable runs),
// otherwise Electron's app.getPath('userData') passed in by main.js.
function resolveUserDataDir({ env = process.env, electronUserData } = {}) {
  if (env.PIPLET_USERDATA) return path.resolve(env.PIPLET_USERDATA);
  if (electronUserData) return electronUserData;
  throw new Error('no user data dir: PIPLET_USERDATA unset and no Electron userData path');
}

// Every writable path the server needs, rooted at the user-data dir.
// The packaged app lives in a read-only asar and cannot write beside
// its own code, so the DB, .env.local, shots and skills all live here.
function appPaths(userDataDir) {
  return {
    userDataDir,
    dbPath: path.join(userDataDir, 'data', 'personal-ai.db'),
    dataDir: path.join(userDataDir, 'data'),
    envPath: path.join(userDataDir, '.env.local'),
    skillsDir: path.join(userDataDir, 'skills'),
  };
}

// Where the bundled skills live. Packaged: extraResources puts skills/
// beside the asar (process.resourcesPath). Dev: the repo skills/ dir.
function bundledSkillsDir({ resourcesPath, electronDir }) {
  if (resourcesPath) {
    const p = path.join(resourcesPath, 'skills');
    if (fs.existsSync(p)) return p;
  }
  const dev = path.join(electronDir, '..', '..', 'skills');
  if (fs.existsSync(dev)) return dev;
  return null;
}

// Copy-once: if the user-data skills dir is missing, copy the bundled
// one (SKILL.md files + approved.json). NEVER overwrite an existing
// dir — the owner's approvals live there, and approved.json is the
// human-review record. Returns { copied, reason? }.
function ensureSkillsCopy(sourceDir, targetDir) {
  if (!sourceDir) return { copied: false, reason: 'no bundled skills dir found' };
  if (fs.existsSync(targetDir)) return { copied: false, reason: 'exists' };
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return { copied: true };
}

// A free loopback port for this run. PIPLET_FIXED_PORT (tests) wins;
// otherwise bind port 0, read the assigned port, and release it. The
// shell owns the port so the window and the server always agree, and
// a second app copy never fights the first over a fixed port.
function pickFreePort({ fixedPort, host = '127.0.0.1' } = {}) {
  if (fixedPort) return Promise.resolve(Number(fixedPort));
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// Env additions the server needs before it is required. Existing
// explicit values win (except PORT, which the shell owns) so a power
// user can still point the app at their own DB/env/skills.
function buildServerEnv({ paths, port, env = process.env }) {
  const out = { PORT: String(port) };
  if (!env.PIPLET_DB_PATH) out.PIPLET_DB_PATH = paths.dbPath;
  if (!env.PIPLET_DATA_DIR) out.PIPLET_DATA_DIR = paths.dataDir;
  if (!env.PIPLET_ENV_PATH) out.PIPLET_ENV_PATH = paths.envPath;
  if (!env.PIPLET_SKILLS_DIR) out.PIPLET_SKILLS_DIR = paths.skillsDir;
  return out;
}

module.exports = {
  resolveUserDataDir, appPaths, bundledSkillsDir, ensureSkillsCopy,
  pickFreePort, buildServerEnv,
};
