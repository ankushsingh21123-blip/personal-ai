// Skills — curated, human-approved workflows, loaded on demand (cycle 3).
//
// A skill is a folder in <repo>/skills/<name>/ with a SKILL.md file:
// YAML-ish frontmatter (name + description + optional triggers) followed by
// Markdown instructions. Skills are TEXT ONLY: they organise what the agent
// already knows how to do with its existing tools. They can never add a
// tool, widen a permission, or touch permissions.json / the allowlist —
// tools.execute is the single enforcement point and never reads skills.
//
// Progressive disclosure (Anthropic, Oct 2026): the brain's prompt carries
// only the short index (name + one-line description) of ACTIVE skills.
// A skill's full body loads only when the user's message matches it, and
// at most MAX_LOADED skills load per turn.
//
// Approval gate (the curator flow): a skill is ACTIVE only when
// skills/approved.json holds an entry for it with approved=true AND a
// sha256 that matches the file's current content. No entry, a changed
// file, a corrupt manifest, or a bad frontmatter all fail CLOSED: the
// skill is listed as draft/changed/invalid and its body never loads.
// Approval is recorded by a human running scripts/approve-skill.js (or
// editing approved.json by hand) — there is NO API endpoint that can
// approve a skill, so the model can never approve its own skill, and
// third-party skills are never auto-installed. Drafts live in
// skills/_drafts/ and are ignored by the loader entirely.
//
// This module never throws on bad input: bad files, bad manifests, and
// bad names all yield draft/invalid/null results.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'skills');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY_CHARS = 8000;
const MAX_LOADED = 2;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'can', 'how', 'what', 'when', 'please', 'help', 'want', 'need', 'about', 'use', 'using']);

function skillsDir(dir) {
  return dir || process.env.PIPLET_SKILLS_DIR || DEFAULT_DIR;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Parse SKILL.md frontmatter. Returns { name, description, triggers, body }
// or { error } — never throws.
function parseSkillFile(content) {
  if (typeof content !== 'string' || !content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { error: 'missing frontmatter (file must start with ---)' };
  }
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { error: 'unterminated frontmatter' };
  const front = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const fields = {};
  for (const line of front.split('\n')) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  if (!fields.name || !NAME_RE.test(fields.name)) return { error: 'frontmatter name missing or invalid' };
  if (!fields.description) return { error: 'frontmatter description missing' };
  const triggers = (fields.triggers || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!body.trim()) return { error: 'skill body is empty' };
  return { name: fields.name, description: fields.description.slice(0, 300), triggers, body };
}

function loadManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'approved.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Manifest shape: { skills: { name: { approved, approved_by, approved_at, sha256 } } }
    const entries = parsed.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
    return entries;
  } catch {
    return {}; // Missing or corrupt manifest: nothing is approved. Fail closed.
  }
}

// Discover skill folders. Ignores _drafts, dot-dirs, files, and bad names.
function discoverSkillNames(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.') && NAME_RE.test(e.name))
    .map(e => e.name)
    .sort();
}

// Status of one skill: active | draft | changed | invalid. Bodies are never
// returned here — this is the disclosure-safe index.
function getSkillStatus(name, dir) {
  dir = skillsDir(dir);
  if (!NAME_RE.test(name)) return { name, description: '', status: 'invalid', reason: 'bad skill name' };
  const file = path.join(dir, name, 'SKILL.md');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { name, description: '', status: 'invalid', reason: 'SKILL.md not found' };
  }
  const parsed = parseSkillFile(content);
  if (parsed.error) return { name, description: '', status: 'invalid', reason: parsed.error };
  if (parsed.name !== name) {
    return { name, description: '', status: 'invalid', reason: 'frontmatter name does not match folder name' };
  }
  const entry = loadManifest(dir)[name];
  if (!entry || entry.approved !== true) {
    return { name, description: parsed.description, status: 'draft', reason: 'not approved — needs human review (see docs/SKILLS.md)' };
  }
  if (typeof entry.sha256 !== 'string' || entry.sha256 !== sha256(content)) {
    return { name, description: parsed.description, status: 'changed', reason: 'file changed since approval — needs re-approval' };
  }
  return { name, description: parsed.description, status: 'active', reason: null };
}

function listSkills(dir) {
  dir = skillsDir(dir);
  return discoverSkillNames(dir).map(name => getSkillStatus(name, dir));
}

// Full body, ONLY for an active skill. Returns null for anything else —
// draft, changed, invalid, missing, or a bad name. Never throws.
function loadSkill(name, dir) {
  dir = skillsDir(dir);
  if (!NAME_RE.test(String(name))) return null;
  const status = getSkillStatus(name, dir);
  if (status.status !== 'active') return null;
  let content;
  try {
    content = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseSkillFile(content);
  if (parsed.error) return null;
  let body = parsed.body;
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n[...truncated]';
  return { name, description: parsed.description, body };
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Match ACTIVE skills against the user's message. Trigger words score 3,
// description/name words score 1. Deterministic: score desc, then name.
// Returns at most `max` names, only with score > 0.
function matchSkills(text, dir, max = MAX_LOADED) {
  dir = skillsDir(dir);
  const words = new Set(tokenize(text));
  if (!words.size) return [];
  const scored = [];
  for (const name of discoverSkillNames(dir)) {
    const status = getSkillStatus(name, dir);
    if (status.status !== 'active') continue;
    let content;
    try {
      content = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillFile(content);
    if (parsed.error) continue;
    let score = 0;
    const lowerText = String(text).toLowerCase();
    for (const trig of parsed.triggers) {
      // Word-boundary match only: "latest" must not match the trigger "test".
      // Single words use the token set; phrases use a boundary regex.
      if (trig.includes(' ')) {
        const re = new RegExp(`\\b${trig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (re.test(lowerText)) score += 3;
      } else if (words.has(trig)) {
        score += 3;
      }
    }
    for (const w of tokenize(parsed.description + ' ' + name.replace(/-/g, ' '))) {
      if (words.has(w)) score += 1;
    }
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, max).map(s => s.name);
}

// What the prompt gets: a short index of every ACTIVE skill (descriptions
// only), plus the full bodies of the matched skills, fenced and labelled.
// Draft/changed/invalid skills contribute nothing — not even their names
// in the loaded set (the index lists active skills only).
function buildSkillContext(text, dir) {
  dir = skillsDir(dir);
  const active = listSkills(dir).filter(s => s.status === 'active');
  const index = active.map(s => `- ${s.name}: ${s.description}`).join('\n');
  const loaded = [];
  for (const name of matchSkills(text, dir)) {
    const skill = loadSkill(name, dir);
    if (skill) loaded.push(skill);
  }
  return { index, loaded };
}

module.exports = {
  DEFAULT_DIR, NAME_RE, MAX_BODY_CHARS, MAX_LOADED,
  parseSkillFile, loadManifest, discoverSkillNames, getSkillStatus,
  listSkills, loadSkill, matchSkills, buildSkillContext, sha256,
};
