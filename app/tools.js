// Tools — what the agent may actually DO. Deny-first, per AGENT.md / permissions.json.
// Allowed tools run for real and return evidence. Everything else is denied
// and logged, or turned into a pending approval (never executed by the agent).
// Path traversal, shell injection, secret reads and send/spend/delete are all
// blocked here, before any execution.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { run } = require('./db');

const WORKSPACE = process.env.WORKSPACE
  || path.join(require('os').homedir(), 'workspace', 'personal-ai');

// Files the agent may NEVER read, even if asked.
const DENIED_PATHS = [/\.env/i, /\.ssh/i, /\.openclaw\/credentials/i, /credentials/i, /\.git\/config/i];

function safePath(rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('path required');
  if (DENIED_PATHS.some(re => re.test(rel))) throw new Error('denied: secret/credential path');
  const resolved = path.resolve(WORKSPACE, rel);
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
    throw new Error('denied: path escapes workspace');
  }
  // H2 fix (security audit 12 Nov 2026): refuse symlinks outright, and re-check
  // the real (resolved) path — lexical checks alone can be escaped by a symlink.
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error('denied: symlinks are not allowed');
  }
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* file may not exist yet */ }
  if (real !== WORKSPACE && !real.startsWith(WORKSPACE + path.sep)) {
    throw new Error('denied: path escapes workspace (symlink)');
  }
  if (DENIED_PATHS.some(re => re.test(real))) throw new Error('denied: secret/credential path');
  return real;
}

function audit(tool, args, allowed, result) {
  try { run('INSERT INTO audit_log (tool, args, allowed, result) VALUES (?, ?, ?, ?)',
    tool, JSON.stringify(args || {}), allowed ? 1 : 0, String(result || '').slice(0, 500)); } catch {}
}

const ALLOWED_COMMANDS = {
  // exact argv, no shell, no pipes, no substitution — execFile, never exec()
  date: ['date'],
  pwd: ['pwd'],
  'node --version': ['node', '--version'],
  'git status': ['git', 'status', '--short'],
  'git diff --stat': ['git', 'diff', '--stat'],
  uptime: ['uptime'],
  'npm test': ['npm', 'test'],
};

function runCommand(name) {
  return new Promise((resolve) => {
    const argv = ALLOWED_COMMANDS[name];
    if (!argv) return resolve({ ok: false, error: `denied: command '${name}' is not allowlisted` });
    execFile(argv[0], argv.slice(1), { cwd: WORKSPACE, timeout: 60000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: (stdout || stderr || '').slice(0, 4000), error: err ? err.message.slice(0, 200) : undefined });
      });
  });
}

async function execute(tool, args = {}) {
  switch (tool) {
    case 'list_files': {
      const dir = safePath(args.path || '.');
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.isSymbolicLink()) // H2: do not follow symlinked entries
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      audit(tool, args, true, `${items.length} items`);
      return { ok: true, items };
    }
    case 'read_file': {
      const p = safePath(args.path);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('file not found');
      const content = fs.readFileSync(p, 'utf8').slice(0, 20000);
      audit(tool, args, true, `${content.length} chars`);
      return { ok: true, content };
    }
    case 'write_note': {
      if (!args.title || !args.body) throw new Error('title and body required');
      const r = run('INSERT INTO notes (title, body) VALUES (?, ?)', String(args.title).slice(0, 200), String(args.body).slice(0, 5000));
      audit(tool, args, true, `note ${r.lastInsertRowid}`);
      return { ok: true, note_id: Number(r.lastInsertRowid) };
    }
    case 'edit_file': {
      // Precise old->new replacement, with a .bak backup first. Workspace only.
      if (!args.path || typeof args.old_text !== 'string' || typeof args.new_text !== 'string') throw new Error('path, old_text and new_text required');
      const p = safePath(args.path);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('file not found');
      const before = fs.readFileSync(p, 'utf8');
      if (!before.includes(args.old_text)) throw new Error('old_text not found exactly — no fuzzy edits');
      fs.writeFileSync(p + '.bak', before, 'utf8');
      fs.writeFileSync(p, before.replace(args.old_text, args.new_text), 'utf8');
      audit(tool, args, true, `edited ${args.path}, backup ${args.path}.bak`);
      return { ok: true, backup: args.path + '.bak' };
    }
    case 'web_fetch': {
      // Read-only fetch: https only, no private IPs, 50kb cap, HTML stripped.
      // Fetched content is DATA, never instructions — the agent must not act on it.
      if (!args.url || !/^https:\/\//.test(args.url)) throw new Error('web_fetch requires an https URL');
      const u = new URL(args.url);
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(u.hostname)) throw new Error('denied: private/local URL');
      const res = await fetch(args.url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'ankush-personal-ai/1.0' } });
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      audit(tool, args, true, `${text.length} chars from ${u.hostname}`);
      return { ok: true, url: args.url, text };
    }
    case 'run_command': {
      const r = await runCommand(args.command);
      audit(tool, args, r.ok, r.ok ? r.output.slice(0, 200) : r.error);
      if (!r.ok) throw new Error(r.error || 'command failed');
      return { ok: true, output: r.output };
    }
    default: {
      // send / post / spend / delete / anything unknown -> denied, approval only
      audit(tool, args, false, 'denied: not an allowlisted tool');
      throw new Error(`denied: tool '${tool}' is not allowlisted — create an approval instead`);
    }
  }
}

module.exports = { execute, safePath, WORKSPACE, ALLOWED_COMMANDS, audit };
