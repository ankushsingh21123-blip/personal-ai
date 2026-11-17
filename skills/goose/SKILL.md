---
name: goose
description: Use the goose coding agent for build-me-a-project jobs, with the proof template and internship rules.
triggers: goose, build, proof template, hello-proof
---

# goose skill — how the agent uses the coding agent

## When to use goose

Use goose for "build me a project" jobs: proof projects for internships, small apps,
scripts, and anything that needs code written, tested, and run. Do NOT use goose for
answering questions, summarising files, or drafting emails — answer those directly.

## How to call it

Run in the project folder:

```bash
goose run "<task in one clear sentence, with the exact acceptance criteria>"
```

Then ALWAYS run the project's tests and report the result:

```bash
npm install && npm test
```

## Rules (from Ankush's 11 Nov 2026 internship rule)

- Every proof project is frontend + backend + database, working end-to-end, tested.
- `.env.local` is git-ignored. Never commit a key. Check with `git status` — no `.env*` file may appear.
- Real README / code / tests / demo. Not AI-slop-looking.
- The role's exact skill keywords must appear VISIBLY in the README (ATS-friendly).
  NEVER hidden white text / hidden keywords / tricks to fool screening AI.
- Do NOT invent skills or experience Ankush lacks. If a role needs a skill he does not
  have, say so in the report.
- If stuck building from scratch, use a related open-source repo as a reference and
  starting point, then change it substantially into his own working version — keeping
  the original licence and credit — rather than copying it as his own work.
- **Never push to GitHub without Ankush's yes.** Never submit an application without
  his yes on the exact text.

## Provider

- goose provider: `ollama`, model `qwen3:8b` (local, $0).
- If Ollama is down or the model is too slow, fall back to Gemini free tier
  (`gemini-3.6-flash`) as the brain — never stop, just switch.
- Config lives in `~/.config/goose/config.yaml` (GOOSE_PROVIDER / GOOSE_MODEL / GOOSE_MODE).

## Proof template (hello-proof)

The first project every new setup must build and pass:

```
goose run "Create a small Node.js + Express + SQLite app with one page that says
Hello, Ankush, and one API route /api/health that returns {ok:true}. Add a README,
a .gitignore that ignores .env.local, and npm test that checks /api/health."
npm install && npm test
```

Pass mark: `npm test` passes, app runs on localhost:3000, `/api/health` returns
`{"ok":true}`, `.env.local` is git-ignored.
