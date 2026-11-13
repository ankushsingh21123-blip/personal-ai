# Personal AI — build status (13 Nov 2026, ~19:30 IST)

Full working, $0, full stack wired up — frontend + backend + database + server + cyber checks.
Scope: compete with ChatGPT and Muse (12 Nov 01:24 IST) — a public AI assistant product, not just a personal tool.

## What works on this VM (tested for real — see app/tests/TEST-REPORT.md)
| Piece | Version / model | Status |
|---|---|---|
| App (frontend+backend+DB+server) | Node 24.22.1, Express 5.3.0, node:sqlite | ✅ 22/22 tests pass, 17.2 s |
| Native function calling | Gemini `functionDeclarations` → deny-first tools, 2 rounds max, 5 calls/round | ✅ Wired 13 Nov: declarations mirror tools.js exactly, malformed/undeclared calls dropped, all deny-first checks still in tools.execute. Parser + declarations unit-tested; live end-to-end needs his Gemini key on the laptop (no direct key on this VM — live chat test proved the text+JSON fallback instead) |
| Gemini (primary brain) | gemini-3.5-flash-lite first, gemini-3.6-flash fallback | ✅ Works, 0.98 s. 3.8-flash: 503 (12 Nov), 2.5-flash: 404 |
| Ollama local | qwen3:0.6b (VM only) | ✅ Answers short prompts (12 s); too small for agent tool-calling |
| Groq fallback | openai/gpt-oss-120b | ⏳ Not tested — no key created (Ankush creates it himself) |
| OpenClaw gateway | 2026.11.3 (reinstalled) | ✅ Dashboard HTTP 200 on 127.0.0.1:18789; agent turns with 0.6b cannot complete on this VM (15k-token prompt, CPU timeout) |
| goose | 1.59.0 | ✅ Installed; coding job with 0.6b loops, zero files (11 Nov) |
| OpenCode (new coding agent) | 1.19.5 | ✅ CLI works; run with 0.6b produced no output in 90 s on this VM — needs 8B/Gemini on laptop |
| Security checks | scripts/security-check.sh | ✅ ALL PASS (15 checks, re-run 13 Nov); audit H1–H5 fixed |
| Proof project | Internship Tracker | ✅ 9/9 tests pass (verified by re-run) |

## VM limits (honest, documented)
- This VM (1.5 shared CPUs, 6 GB) cannot run OpenClaw gateway + app + Ollama at once — stop the gateway during app tests.
- `ollama pull` is blocked on this VM (egress proxy); models come via GGUF + `ollama create`. Laptop pulls directly.
- Gemini 3.8-flash: 503 high demand (10 + 12 Nov). Groq: untested, no key.

## Still needs Ankush
- His Windows laptop install (Node 24.22.1, WSL2, Ollama qwen3:8b) — see SETUP.md
- His Gemini key in .env.local (secure form only) + Groq key later — the key also unlocks live native function calling (Gemini direct REST path); without it the app uses the text+JSON fallback, which is what the VM tests prove
- Telegram bot token via @BotFather; spare number for WhatsApp (never primary)
- Oracle Cloud account (Phase 6, after Phase 5 passes)
- His yes before any GitHub push — repo prepared locally as `personal-ai`, NOT pushed (see GITHUB.md)

## Files
- `app/` — the working system: README, SECURITY, server/brain/tools/db, public frontend, tests (22/22), TEST-REPORT, security-check
- `research/` — personal-ai-laptop-phone-cloud-2026-11-11.md, efficiency-2026-11-12.md, alternatives-2026-11-12.md, competitive-chatgpt-muse-2026-11-12.md
- `projects/proof-internship-tracker/` — 9/9 tests, real full-stack proof project
- `skills/coding-agent.md` — OpenCode primary, goose fallback
- `GITHUB.md` — repo prep, not pushed yet
