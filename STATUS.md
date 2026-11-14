# Personal AI — build status (14 Nov 2026, ~16:30 IST)

Full working, $0, full stack wired up — frontend + backend + database + server + cyber checks.
Scope: compete with ChatGPT and Muse (12 Nov 01:24 IST) — a public AI assistant product, not just a personal tool.
Phases B–E (computer use, phone, offline queue + cloud sync, routines) built 14 Nov from `research/computer-use-phone-cloud-spec-2026-11-14.md` — real code, tested, with the live paths honestly marked UNPROVEN below.

## What works on this VM (tested for real — see app/tests/TEST-REPORT.md)
| Piece | Version / model | Status |
|---|---|---|
| App (frontend+backend+DB+server) | Node 24.22.1, Express 5.3.0, node:sqlite | ✅ 71/71 tests pass, 27.0 s (22 live Phase A + 12 provider unit + 37 Phases B–E) |
| Multi-provider brain (Phase A) | Gemini, Groq, OpenAI/OpenAI-compatible, Anthropic, Ollama | ✅ Chain + fallback proven; OpenAI/Anthropic unit-tested-only (no live key on VM) |
| Native function calling | Gemini `functionDeclarations` → deny-first tools, 2 rounds max, 5 calls/round | ✅ Wired: declarations mirror tools.js exactly, malformed/undeclared calls dropped; live end-to-end needs his Gemini key on the laptop |
| Gemini (primary brain) | gemini-3.5-flash-lite first, gemini-3.6-flash fallback | ✅ Works via VM helper. 3.8-flash: 503 (12 Nov), 2.5-flash: 404 |
| Ollama local | qwen3:0.6b (VM only) | ✅ Answers short prompts (~10 s); too small for agent tool-calling |
| Groq fallback | openai/gpt-oss-120b | ⏳ Not tested — no key created (Ankush creates it himself) |
| Screen vision (Phase B) | Gemini/OpenAI/Anthropic image input + grounded actions | ⏳ Unit-tested with mocked fetch — NO live round-trip proven (no key, no desktop on VM) |
| Desktop control (Phase B) | `desktop-agent.js` (Windows, PowerShell/.NET) + `screenLoop` | ⏳ Loop + validation unit-tested with mocks; agent refuses to start on Linux — LIVE execution needs the laptop |
| Browser use | Playwright 1.65.1 + Chromium headless shell 159.0.8154.6 | ✅ Launch + render + read + screenshot proven live (1.9 s, local page); external `goto` UNPROVEN here (VM egress proxy rejects Chromium tunnels — works on the laptop) |
| Phone control (Phase C) | ADB allowlist + per-session enable + iOS label | ⏳ Unit-tested with mock executor — NO live device on VM; iOS honestly labelled messaging-only |
| Telegram (phone-as-remote) | Polling bot, chat-locked | ⏳ Commands + gating unit-tested with mocked API — NO live run (no token on VM) |
| WhatsApp scaffolding | Baileys guards only | ⏳ Guards unit-tested — no package, no number, no account; spare-number confirmation mandatory |
| Offline queue (Phase D) | SQLite outbox, backoff 1m/5m/15m/1h/6h | ✅ Proven live: enqueue/drain/retry/dead + restart survival (new DB connection) |
| Sync (Phase D) | Last-write-wins + conflicts surfaced | ✅ Merge unit-tested, push/pull live-tested single-node; two-node UNPROVEN (needs cloud node) |
| Routines (Phase E) | Daily/interval schedules, run lock, missed policy | ✅ Proven live: tick, lock, dry run, CRUD API; a routine can never send/post/spend/delete |
| Freeze (instant stop) | Persisted in SQLite | ✅ Proven live: stops screen/phone/browser/routine/queue loops, survives restart |
| Security checks | scripts/security-check.sh | ✅ ALL PASS (21 checks, re-run 14 Nov; npm audit skipped — endpoint unreachable from VM) |
| Proof project | Internship Tracker | ✅ 9/9 tests pass (verified by re-run) |
| OpenClaw gateway | 2026.11.3 | ✅ Dashboard HTTP 200 on 127.0.0.1:18789; agent turns with 0.6b cannot complete on this VM |
| goose / OpenCode | 1.59.0 / 1.19.5 | ✅ Installed; coding jobs with 0.6b fail on this VM — need 8B/Gemini on laptop |

## VM limits (honest, documented)
- This VM (1.5 shared CPUs, 6 GB) cannot run OpenClaw gateway + app + Ollama at once — stop the gateway during app tests.
- `ollama pull` is blocked on this VM (egress proxy); models come via GGUF + `ollama create`. Laptop pulls directly.
- Gemini 3.8-flash: 503 high demand (10 + 12 Nov). Groq: untested, no key.
- No desktop, no phone, no second node on this VM — the live paths for vision, desktop control, ADB, Telegram/WhatsApp, and two-node sync are UNPROVEN until the laptop/cloud runs them.
- Chromium launches and renders on this VM, but the egress proxy rejects its CONNECT tunnels — external `goto` is unproven here only.

## Still needs Ankush
- His Windows laptop install (Node 24.22.1, WSL2, Ollama qwen3:8b) + `npx playwright install chromium` — see SETUP.md (Phases B–E section)
- His Gemini key in .env.local (secure form only) + Groq key later — unlocks live native function calling AND live screen vision
- Desktop agent run on the laptop: `node desktop-agent.js` (second PowerShell window)
- Telegram bot token via @BotFather; spare number for WhatsApp (never primary)
- Oracle Cloud account (cloud node behind Tailscale) + `SYNC_PEER_URL`/`SYNC_TOKEN` for sync
- Android phone + authorised USB/wireless debugging, for live phone control

## Files
- `app/` — the working system: README, SECURITY, server/brain/tools/db, vision/screen/desktop/phone/telegram/whatsapp/browser/queue/sync/routines/freeze, desktop-agent.js, public frontend, tests (71/71), TEST-REPORT, security-check
- `research/` — personal-ai-laptop-phone-cloud-2026-11-11.md, efficiency-2026-11-12.md, alternatives-2026-11-12.md, competitive-chatgpt-muse-2026-11-12.md, computer-use-phone-cloud-spec-2026-11-14.md (Phases B–E spec — BUILT 14 Nov, live paths marked)
- `projects/proof-internship-tracker/` — 9/9 tests, real full-stack proof project
- `skills/coding-agent.md` — OpenCode primary, goose fallback
- `GITHUB.md` — repo prep; repo is PUBLIC at https://github.com/ankushsingh21123-blip/personal-ai
