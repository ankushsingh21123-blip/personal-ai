---
name: coding-agent
description: Build a project end-to-end with a coding agent (OpenCode primary, goose fallback), tested before reporting.
triggers: build, project, proof project, opencode, goose, coding agent, app
---

# Coding agent skill — how the agent builds projects

## Which coding agent (12 Nov 2026, alternatives research)

- **Primary: OpenCode 1.19.5** (MIT, ~211–224k stars) — 75+ providers, terminal TUI, server mode + API, runs over SSH. Installed on this VM: `opencode --version` → 1.19.5.
- **Fallback: goose 1.59.0** (Apache-2.0, ~55k stars) — 15+ providers, 70+ MCP extensions.
- Both use the same brain order: Gemini free (Flash-Lite first, 3.6 Flash for hard turns) → Groq free → Ollama local (qwen3:8b on the laptop).
- **VM limit, proven 11–12 Nov 2026:** neither agent completes a coding job with the tiny `qwen3:0.6b` local model on this VM (goose looped 15 min writing zero files; OpenCode produced no output in 90 s). Both need qwen3:8b or Gemini on the laptop. The proof project in `projects/proof-internship-tracker/` was built and tested (9/9) by the agent directly, not by goose/OpenCode on the VM model.

## When to use a coding agent

Use it for "build me a project" jobs: proof projects for internships, small apps,
scripts, and anything that needs code written, tested, and run. Do NOT use it for
answering questions, summarising files, or drafting emails — answer those directly.

## How to call it

OpenCode, in the project folder:

```bash
opencode run "<task in one clear sentence, with the exact acceptance criteria>" --model ollama/qwen3:8b
# or with Gemini: --model google/gemini-3.5-flash-lite (key in .env.local / OS store)
```

goose (fallback):

```bash
goose run --text "<task in one clear sentence, with the exact acceptance criteria>"
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

## Proof template (internship tracker — the real one, 9/9 tests)

`projects/proof-internship-tracker/` — Internship Tracker: frontend + Express backend + SQLite, CRUD, filter/sort/stats, token auth, 127.0.0.1 only. Run it with `npm install && npm test`.
