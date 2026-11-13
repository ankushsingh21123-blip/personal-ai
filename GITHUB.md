# GitHub — personal-ai repo (PUSHED 13 Nov 2026)

**Owner:** ankushsingh21123-blip · **Repo:** `personal-ai`
**URL:** https://github.com/ankushsingh21123-blip/personal-ai (PUBLIC)
**Pushed:** 13 Nov 2026 ~19:35 IST, after Ankush authorised a `gh` device-code
flow on his phone. 3 commits, 62 files on `main`, verified on the remote:
no `.env.local`, no `.db`, no `node_modules` in the tree.

Commits:
- `936fff1` Personal AI v1.0: full-stack app, Gemini→Groq→Ollama brain,
  deny-first tools, security audit H1–H5 fixed, proof internship tracker 9/9
- `c952112` Fix audit Medium findings: Gemini key via header, DB read blocked,
  timing-safe token compare, stricter CSP, chat concurrency cap; tests 18/18
- `8141e97` Native Gemini function calling: 6 tool declarations, malformed
  calls dropped, deny-first checks intact, JSON fallback kept; tests 22/22,
  security 15/15

## What is in the repo
- `app/` — full-stack personal AI: `server.js`, `brain.js`, `tools.js`,
  `db.js`, `public/` (frontend), `package.json`, `tests/test.js` (22 tests),
  `tests/run-tests.sh`, `scripts/security-check.sh`, `README.md`,
  `SECURITY.md`, `.env.example`, `.gitignore`
- `AGENT.md`, `permissions.json`, `skills/`, `SETUP.md`,
  `setup-windows-laptop.ps1`
- `research/` — research files, including the competitive roadmap and
  efficiency/alternatives research
- `projects/proof-internship-tracker/` — proof project (9/9 tests)

## What will NEVER be pushed
- `.env.local` (token + keys) — git-ignored, mode 600
- `data/*.db` (SQLite DB with messages/jobs) — git-ignored
- `node_modules/` — git-ignored
- Any API key, password, OTP, or token — never in chat, never in a file that
  is committed. The GitHub login Ankush handed over on 8 Nov 2026 was for
  the VidyaAI push only — it is **not** a general licence, and it was not
  reused here (this push used his fresh device-code authorisation).

## Licences / credit (kept, not copied as his own)
- OpenClaw — MIT — gateway base, credited in README + research file
- goose — Apache-2.0 — coding agent base, credited
- Ollama — MIT — local model runtime, credited
- The app code in `app/` is Ankush's own, written for this project,
  substantially his own version on top of those bases.

## Test status at push (13 Nov 2026)
- App tests: 22/22 passing (see `app/tests/TEST-REPORT.md`)
- Security checks: 15/15 passing (see `scripts/security-check.sh`)
- Proof project (internship tracker): 9/9 passing
- Honest limit: no live Gemini `functionCall` round-trip proven yet — no
  `GEMINI_API_KEY` on the build VM; live native calling needs his key.

## Daily push cadence
`gh` is now authenticated on this VM as ankushsingh21123-blip (HTTPS, token
scopes: gist, read:org, repo), so future pushes do not need a new device
code unless the token is revoked. Commit + push daily as Ankush requested,
after re-running tests and re-scanning for secrets before each push.
