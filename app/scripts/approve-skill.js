#!/usr/bin/env node
// approve-skill.js — the HUMAN curator tool for Piplet skills.
//
//   node scripts/approve-skill.js <name> --by "Your Name" [--dir <skills-dir>] [--dry-run]
//   node scripts/approve-skill.js <name> --revoke [--dir <skills-dir>]
//
// Approving records the skill's sha256 in approved.json. Any later edit
// to SKILL.md changes the hash, which deactivates the skill until a
// human re-approves it. Revoking removes the entry, which deactivates
// the skill immediately. There is deliberately NO API endpoint and NO
// agent tool that runs this: approval is a human act, recorded in the
// repo. The agent's run_command allowlist does not include this script.
//
// Exit codes: 0 = done (or dry-run OK), 1 = usage/validation error.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseSkillFile, sha256, NAME_RE } = require('../skills');

function fail(msg) {
  console.error(`approve-skill: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const name = argv.find(a => !a.startsWith('--'));
const byIdx = argv.indexOf('--by');
const by = byIdx !== -1 ? argv[byIdx + 1] : null;
const dirIdx = argv.indexOf('--dir');
const dir = dirIdx !== -1 && argv[dirIdx + 1]
  ? path.resolve(argv[dirIdx + 1])
  : path.join(__dirname, '..', '..', 'skills');
const dryRun = argv.includes('--dry-run');
const revoke = argv.includes('--revoke');

if (!name || !NAME_RE.test(name)) fail('usage: approve-skill.js <skill-name> --by "Name" [--dir <dir>] [--dry-run] | --revoke');
if (!revoke && !by) fail('--by "Your Name" is required to approve (who reviewed it)');

const manifestPath = path.join(dir, 'approved.json');
let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  manifest = {};
}
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) manifest = {};
if (!manifest.skills || typeof manifest.skills !== 'object') manifest.skills = {};

if (revoke) {
  if (!manifest.skills[name]) fail(`skill '${name}' has no approval entry to revoke`);
  if (dryRun) {
    console.log(`[dry-run] would revoke approval for '${name}'`);
    process.exit(0);
  }
  delete manifest.skills[name];
  fs.writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(manifestPath + '.tmp', manifestPath);
  console.log(`revoked approval for '${name}' — the skill is now inactive`);
  process.exit(0);
}

const file = path.join(dir, name, 'SKILL.md');
let content;
try {
  content = fs.readFileSync(file, 'utf8');
} catch {
  fail(`SKILL.md not found for '${name}' at ${file}`);
}
const parsed = parseSkillFile(content);
if (parsed.error) fail(`SKILL.md is invalid: ${parsed.error}`);
if (parsed.name !== name) fail('frontmatter name does not match folder name');

const hash = sha256(content);
if (dryRun) {
  console.log(`[dry-run] would approve '${name}' (sha256 ${hash.slice(0, 16)}…, reviewed by ${by})`);
  process.exit(0);
}
manifest.skills[name] = {
  approved: true,
  approved_by: by,
  approved_at: new Date().toISOString().slice(0, 10),
  sha256: hash,
};
fs.writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
fs.renameSync(manifestPath + '.tmp', manifestPath);
console.log(`approved '${name}' (sha256 ${hash.slice(0, 16)}…, reviewed by ${by})`);
