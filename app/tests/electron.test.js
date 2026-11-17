// Electron shell tests (cycle 7): pure path/port/env helpers, the
// PIPLET_* path overrides the packaged app depends on, and structural
// checks on the shell files. No Electron runtime is needed here — the
// packaged app itself is verified live by scripts/verify-electron-app.js.
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const {
  resolveUserDataDir, appPaths, bundledSkillsDir, ensureSkillsCopy,
  pickFreePort, buildServerEnv,
} = require('../electron/paths');

const APP_DIR = path.join(__dirname, '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveUserDataDir: PIPLET_USERDATA wins, Electron path is the fallback, neither throws', () => {
  assert.equal(resolveUserDataDir({ env: { PIPLET_USERDATA: '/tmp/x' }, electronUserData: '/tmp/y' }), path.resolve('/tmp/x'));
  assert.equal(resolveUserDataDir({ env: {}, electronUserData: '/tmp/y' }), '/tmp/y');
  assert.throws(() => resolveUserDataDir({ env: {} }), /no user data dir/);
});

test('appPaths: DB, data dir, env file and skills all live under the user-data dir', () => {
  const p = appPaths('/tmp/ud');
  assert.equal(p.dbPath, path.join('/tmp/ud', 'data', 'personal-ai.db'));
  assert.equal(p.dataDir, path.join('/tmp/ud', 'data'));
  assert.equal(p.envPath, path.join('/tmp/ud', '.env.local'));
  assert.equal(p.skillsDir, path.join('/tmp/ud', 'skills'));
});

test('bundledSkillsDir: packaged resources win, repo skills dir is the dev fallback', () => {
  const resDir = tmpDir('piplet-res-');
  fs.mkdirSync(path.join(resDir, 'skills'));
  assert.equal(bundledSkillsDir({ resourcesPath: resDir, electronDir: path.join(APP_DIR, 'electron') }), path.join(resDir, 'skills'));
  const dev = bundledSkillsDir({ resourcesPath: '/nonexistent', electronDir: path.join(APP_DIR, 'electron') });
  assert.equal(dev, path.join(APP_DIR, '..', 'skills'));
  assert.ok(fs.existsSync(path.join(dev, 'approved.json')));
});

test('ensureSkillsCopy: copies once, never overwrites an existing dir, reports a missing source', () => {
  const src = tmpDir('piplet-src-');
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# test skill');
  fs.writeFileSync(path.join(src, 'approved.json'), '{"a":true}');
  const target = path.join(tmpDir('piplet-tgt-'), 'skills');
  const first = ensureSkillsCopy(src, target);
  assert.equal(first.copied, true);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), '# test skill');
  // Owner edits approved.json; a second launch must not clobber it.
  fs.writeFileSync(path.join(target, 'approved.json'), '{"owner":true}');
  const second = ensureSkillsCopy(src, target);
  assert.equal(second.copied, false);
  assert.equal(fs.readFileSync(path.join(target, 'approved.json'), 'utf8'), '{"owner":true}');
  assert.equal(ensureSkillsCopy(null, path.join(tmpDir('piplet-tgt2-'), 'skills')).copied, false);
});

test('pickFreePort: fixed port is honoured, free port is actually bindable', async () => {
  assert.equal(await pickFreePort({ fixedPort: '3210' }), 3210);
  const port = await pickFreePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
  });
});

test('buildServerEnv: sets all four paths + PORT, explicit values win', () => {
  const paths = appPaths('/tmp/ud');
  const env = buildServerEnv({ paths, port: 3456, env: {} });
  assert.equal(env.PORT, '3456');
  assert.equal(env.PIPLET_DB_PATH, paths.dbPath);
  assert.equal(env.PIPLET_DATA_DIR, paths.dataDir);
  assert.equal(env.PIPLET_ENV_PATH, paths.envPath);
  assert.equal(env.PIPLET_SKILLS_DIR, paths.skillsDir);
  const kept = buildServerEnv({ paths, port: 3456, env: { PIPLET_DB_PATH: '/mine.db', PIPLET_ENV_PATH: '/mine.env' } });
  // Explicit values are left out of the additions entirely, so
  // Object.assign(process.env, additions) leaves them in place.
  assert.equal(kept.PIPLET_DB_PATH, undefined);
  assert.equal(kept.PIPLET_ENV_PATH, undefined);
  assert.equal(kept.PIPLET_DATA_DIR, paths.dataDir);
  assert.equal(kept.PIPLET_SKILLS_DIR, paths.skillsDir);
  assert.equal(kept.PORT, '3456');
});

test('PIPLET_ENV_PATH override: settings.js reads/writes the override file', async () => {
  const dir = tmpDir('piplet-env-');
  const envPath = path.join(dir, '.env.local');
  const script = `
    const s = require(${JSON.stringify(path.join(APP_DIR, 'settings.js'))});
    console.log(s.ENV_PATH);
    s.writeEnvUpdates({ OLLAMA_MODEL: 'override-probe-model' });
    console.log(require('fs').readFileSync(process.env.PIPLET_ENV_PATH, 'utf8').includes('override-probe-model') ? 'WROTE' : 'NOT-WROTE');
  `;
  const { stdout } = await execFileAsync('node', ['-e', script], {
    env: { ...process.env, PIPLET_ENV_PATH: envPath },
  });
  const lines = stdout.trim().split('\n');
  assert.equal(lines[0], envPath);
  assert.equal(lines[1], 'WROTE');
  // The repo .env.local must be untouched by the override run.
  const repoEnv = path.join(APP_DIR, '.env.local');
  if (fs.existsSync(repoEnv)) {
    assert.ok(!fs.readFileSync(repoEnv, 'utf8').includes('override-probe-model'));
  }
});

test('PIPLET_DATA_DIR + PIPLET_DB_PATH overrides: the database lands in the override dir', async () => {
  const dir = tmpDir('piplet-db-');
  const dataDir = path.join(dir, 'data');
  const script = `
    const { db, DB_PATH } = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
    db.exec("INSERT INTO notes (title, body) VALUES ('probe', 'probe')");
    console.log(DB_PATH);
    db.close();
  `;
  const { stdout } = await execFileAsync('node', ['-e', script], {
    env: { ...process.env, PIPLET_DATA_DIR: dataDir },
  });
  assert.equal(stdout.trim(), path.join(dataDir, 'personal-ai.db'));
  assert.ok(fs.existsSync(path.join(dataDir, 'personal-ai.db')));
});

test('PIPLET_SKILLS_DIR override: the skills loader reads the override dir', async () => {
  const dir = tmpDir('piplet-skills-');
  fs.mkdirSync(path.join(dir, 'demo'));
  fs.writeFileSync(path.join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: a probe skill for the override test.\ntriggers: probe\n---\n\n# Demo\n\nBody.\n');
  fs.writeFileSync(path.join(dir, 'approved.json'), '{}');
  const script = `
    const skills = require(${JSON.stringify(path.join(APP_DIR, 'skills.js'))});
    console.log(JSON.stringify(skills.listSkills().map(s => s.name)));
  `;
  const { stdout } = await execFileAsync('node', ['-e', script], {
    env: { ...process.env, PIPLET_SKILLS_DIR: dir },
  });
  assert.deepEqual(JSON.parse(stdout.trim()), ['demo']);
});

test('electron shell files parse under plain node --check', async () => {
  for (const f of ['electron/main.js', 'electron/preload.js', 'electron/paths.js']) {
    await execFileAsync('node', ['--check', path.join(APP_DIR, f)]);
  }
});

test('preload bridge exposes exactly one IPC channel (piplet:token)', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'electron', 'preload.js'), 'utf8');
  const invokes = [...src.matchAll(/ipcRenderer\.invoke\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(invokes, ['piplet:token']);
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/nodeIntegration|require\(['"]fs|require\(['"]child_process/.test(code));
});

test('main process hardens the window: context isolation, no node integration, sandbox, single instance', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'electron', 'main.js'), 'utf8');
  assert.match(src, /contextIsolation:\s*true/);
  assert.match(src, /nodeIntegration:\s*false/);
  assert.match(src, /sandbox:\s*true/);
  assert.match(src, /requestSingleInstanceLock\(\)/);
  assert.doesNotMatch(src, /nodeIntegration:\s*true/);
  assert.match(src, /will-navigate/);
  assert.match(src, /setWindowOpenHandler/);
  // Exactly one ipcMain channel, the token.
  const handles = [...src.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(handles, ['piplet:token']);
});
