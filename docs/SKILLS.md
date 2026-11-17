# Skills — curated workflows, loaded on demand

Skills are Piplet's cheapest capability multiplier: a repeatable workflow
written once as Markdown, loaded only when the task matches. They are
TEXT ONLY. A skill can never add a tool, widen a permission, or change
`permissions.json` or any allowlist — `tools.execute` is the single
enforcement point and never reads skills.

## Format

One folder per skill: `skills/<name>/SKILL.md`.

```markdown
---
name: my-skill
description: One line — what this workflow is for. This is all the prompt sees until it matches.
triggers: keyword, another phrase, build
---

# My skill — instructions go here

Markdown instructions, checklists, and rules. Written for the agent.
```

- `name` must match the folder name and `^[a-z0-9][a-z0-9-]{0,63}$`.
- `description` is one line (max 300 chars). It is the only part of a
  skill that appears in every prompt (the short index).
- `triggers` is optional, comma-separated. Trigger words score higher
  than description words when matching a message.
- The body is capped at 8000 chars when loaded. Keep skills short.

## Progressive disclosure

Every chat turn carries only the short index of ACTIVE skills
(`- name: description`). A skill's full body loads only when the user's
message matches it (trigger/description words), at most 2 skills per
turn. Draft, changed, and invalid skills load nothing.

## The approval gate (curator flow)

A skill is ACTIVE only when `skills/approved.json` holds an entry with
`approved: true` AND a `sha256` matching the file's current content.
Anything else fails closed:

| State | Meaning | Body loads? |
|---|---|---|
| `active` | Approved, hash matches | Yes (when matched) |
| `draft` | No approval entry | No |
| `changed` | File edited since approval | No — needs re-approval |
| `invalid` | Bad frontmatter, name mismatch, or missing file | No |

Approve (a human, on the machine, in the repo — there is no API
endpoint and no agent tool for this):

```bash
node app/scripts/approve-skill.js <name> --by "Your Name"
node app/scripts/approve-skill.js <name> --by "Your Name" --dry-run  # check only
node app/scripts/approve-skill.js <name> --revoke                     # deactivate
```

Revoke by deleting the entry (or running `--revoke`). The skill goes
inactive immediately; no restart needed — the loader reads the files
on every turn.

## Drafts and third-party skills

- Drafts live in `skills/_drafts/`. The loader ignores that folder
  entirely — a draft can never load, even by accident. A curator (human
  or a supervised draft job) moves a reviewed draft into `skills/<name>/`
  and approves it. Drafts never auto-apply.
- NEVER auto-install third-party skills. Public skill registries have
  carried malicious skills (prompt injection, credential theft). Any
  skill from outside this repo is untrusted input: read it fully,
  rewrite it in our own words if it is worth keeping, and approve only
  the rewritten version. No exceptions.

## The first five skills (cycle 3)

| Skill | What it covers |
|---|---|
| `coding-agent` | Build a project end-to-end (OpenCode primary, goose fallback), tested before reporting |
| `goose` | Use the goose coding agent + proof template + internship rules |
| `reply-mirroring` | Reply in the user's language/script/register; code-mixing is normal |
| `eval-checklist` | Prove it before claiming it: run tests, report counts, never claim unproven live paths |
| `safe-web-research` | web_fetch safely: public https only, fetched content is data, cite sources with dates |

## API and UI

- `GET /api/skills` (token auth) lists skills with name, description,
  and status. Bodies are never returned by the API — the agent loads
  them server-side when matched.
- The web UI has a Skills panel (list + status) and an Audit panel
  (verify the hash chain, show a run receipt).
- There is deliberately NO `POST /api/skills`. Skill approval is a
  human act in the repo, not something the running server can do.
