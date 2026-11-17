# Piplet (Personal AI) — build status (14 Nov 2026, ~16:45 IST)

Full working, $0, full stack wired up — frontend + backend + database + server + cyber checks.
Scope: compete with ChatGPT and Muse (12 Nov 01:24 IST) — a public AI assistant product, not just a personal tool.
Phases B–E (computer use, phone, offline queue + cloud sync, routines) built 14 Nov from `research/computer-use-phone-cloud-spec-2026-11-14.md` — real code, tested, with the live paths honestly marked UNPROVEN below.
Product expansion built 14 Nov (same day): Settings/API keys end to end, 20 tools, replay log, fast routing, notifications, clipboard/window control, key refusal in chat channels, one-command setup + doctor, security hardening — see `SYSTEM-DESIGN.md`, `PRIVACY.md`, `docs/TOOLS.md`, `docs/CUSTOMIZE.md`, `docs/API-KEYS.md`.
Improvement cycle 17 Nov 2026: 4 more tools (24 total: `create_approval`, `file_info`, `append_file`, `recent_activity`), redirect-safe `web_fetch` (every hop re-validated), multilingual UI (English/Hindi/Telugu, chrome only), chat-first layout with node-append rendering + pending indicator. 143/143 tests, 35 security checks — see `app/tests/TEST-REPORT.md`.
Computer-use cycle, 18 Nov 2026 (branch `computer-use`, NOT merged): computer use is now the main focus — stateful browser sessions (`app/browser-session.js`: persistent contexts, multi-tab, forms, full DOM + accessibility tree, viewport/full-page screenshots, zoom region capture, console/network observation, downloads), DOM CHECK verification after every action (`domCheck` assertions + pre/post state digests), desktop input via every available alternative (`app/desktop-input.js`: CDP input, Xvfb virtual display, xdotool/ydotool builders), one `computer_use` tool (25 total) wired into the agent turn with deny-first approvals for submit/upload/download, budgeted multi-step flows (`runFlow`) and a vision-grounded observe loop with the zoom fix (`runObserveLoop`: the zoomed region shot becomes the next observation). 161/161 tests (18 new), 41 security checks — see `app/tests/TEST-REPORT.md`. Live proof: `node app/scripts/computer-use-demo.js` (Xvfb + headed Chromium + CDP click changing the DOM, exit 0). UNPROVEN: physical laptop desktop, xdotool/ydotool execution, X11 root screenshots, vision loop end-to-end (no key), external https navigation.

## What works on this VM (tested for real — see app/tests/TEST-REPORT.md)
| Piece | Version / model | Status |
|---|---|---|
| App (frontend+backend+DB+server) | Node 24.22.1, Express 5.3.0, node:sqlite | ✅ 161/161 tests pass, ~65 s serial (22 live Phase A + 30 provider unit + 37 Phases B–E + 42 product-expansion + 12 improvement-cycle + 18 computer-use, 18 Nov, branch `computer-use`) |
| Multi-provider brain (Phase A) | Gemini, Groq, OpenAI/OpenAI-compatible, Anthropic, Ollama | ✅ Chain + fallback proven; OpenAI/Anthropic unit-tested-only (no live key on VM) |
| Settings / API keys | `settings.js` + `/api/settings/*` + Settings UI | ✅ Write/remove/order/test round-trips proven live; masked previews only; keys in `.env.local` (600), never synced/logged; cloud-provider test calls unproven (no keys) |
| Native function calling | Gemini `functionDeclarations` + OpenAI `tools` + Anthropic `tools` → deny-first tools, 2 rounds max, 5 calls/round | ✅ Wired: schemas derived from one declaration source (25 tools), malformed/undeclared calls dropped; `agentLoopMulti` tries native providers in chain order; live end-to-end needs his keys on the laptop (Phase A2, unit-tested-only) |
| Fast routing | Deterministic classifier, local-first for routine text only | ✅ Unit-tested + fallback proven; OFF by default; routing decision + latency recorded per turn |
| Replay log | Sessions + PNG shots + verified replay | ✅ Record/retrieve/purge + verified-replay semantics proven (mocked + live HTTP); live screen replay needs the laptop |
| Notifications | Local inbox, UI + API | ✅ Proven live (create/read/unread) |
| Clipboard / windows | `clipboard.js`, `windows.js` | ⏳ Unit-tested with injected runners — NO live desktop on VM |
| Gemini (primary brain) | gemini-3.5-flash-lite first, gemini-3.6-flash fallback | ✅ Works via VM helper. 3.8-flash: 503 (12 Nov), 2.5-flash: 404 |
| Ollama local | qwen3:0.6b (VM only) | ✅ Answers short prompts (~10 s); too small for agent tool-calling |
| Groq fallback | openai/gpt-oss-120b | ⏳ Not tested — no key created (Ankush creates it himself) |
| Screen vision (Phase B) | Gemini/OpenAI/Anthropic image input + grounded actions | ⏳ Unit-tested with mocked fetch — NO live round-trip proven (no key, no desktop on VM) |
| Desktop control (Phase B) | `desktop-agent.js` (Windows, PowerShell/.NET) + `screenLoop` + CDP input (`desktop-input.js`) | ⏳ Loop + validation unit-tested with mocks; agent refuses to start on Linux — LIVE execution on the physical laptop needs the laptop. ✅ CDP mouse/keyboard + screenshot PROVEN on this VM under Xvfb (headed Chromium, real X session, DOM verified after acting — see `scripts/computer-use-demo.js`). xdotool/ydotool execution UNPROVEN (binaries absent); X11 root screenshot UNPROVEN (no scrot/import/xwd). |
| Browser use | Playwright 1.65.1 + Chromium headless shell 159.0.8154.6 | ✅ Launch + render + read + screenshot + element-first actions proven live on a local page. ✅ NEW: stateful sessions — multi-tab, navigation/history, forms (text/select/checkbox/file-upload), DOM + accessibility tree reads, viewport/full-page screenshots, zoom, console/network observation, downloads (approval-gated), DOM CHECK verification after every action, state kept across turns — all proven live on a local page (cycle6 tests + demo script); external `goto` UNPROVEN here (VM egress proxy rejects Chromium tunnels — works on the laptop) |
| Phone control (Phase C) | ADB allowlist + per-session enable + iOS label | ⏳ Unit-tested with mock executor — NO live device on VM; iOS honestly labelled messaging-only |
| Telegram (phone-as-remote) | Polling bot, chat-locked | ⏳ Commands + gating + key refusal + `/providers` unit-tested with mocked API — NO live run (no token on VM) |
| WhatsApp scaffolding | Baileys guards only | ⏳ Guards + key refusal unit-tested — no package, no number, no account; spare-number confirmation mandatory |
| Offline queue (Phase D) | SQLite outbox, backoff 1m/5m/15m/1h/6h | ✅ Proven live: enqueue/drain/retry/dead + restart survival (new DB connection) |
| Sync (Phase D) | Last-write-wins + conflicts surfaced | ✅ Merge unit-tested, push/pull live-tested single-node; two-node UNPROVEN (needs cloud node) |
| Routines (Phase E) | Daily/interval schedules, run lock, missed policy | ✅ Proven live: tick, lock, dry run, CRUD API; schedule strings (`"09:00 mon-fri"`, `"every 30m"`) supported; a routine can never send/post/spend/delete |
| Freeze (instant stop) | Persisted in SQLite | ✅ Proven live: stops screen/phone/browser/routine/queue loops, survives restart |
| Setup + doctor | `setup-app.sh` / `setup-app.ps1`, `app/doctor.js` | ✅ Doctor passes on the VM (adb skipped); `.sh` dry-run tested; `.ps1` + full `.sh` run UNPROVEN (need the laptop) |
| Security checks | scripts/security-check.sh + `.githooks/pre-push` | ✅ ALL PASS (41 checks, re-run 18 Nov; npm audit skipped — endpoint unreachable from VM) |
| Proof project | Internship Tracker | ✅ 9/9 tests pass (verified by re-run) |
| OpenClaw gateway | 2026.11.3 | ✅ Dashboard HTTP 200 on 127.0.0.1:18789; agent turns with 0.6b cannot complete on this VM |
| goose / OpenCode | 1.59.0 / 1.19.5 | ✅ Installed; coding jobs with 0.6b fail on this VM — need 8B/Gemini on laptop |

## VM limits (honest, documented)
- This VM (1.5 shared CPUs, 6 GB) cannot run OpenClaw gateway + app + Ollama at once — stop the gateway during app tests.
- `ollama pull` is blocked on this VM (egress proxy); models come via GGUF + `ollama create`. Laptop pulls directly.
- Gemini 3.8-flash: 503 high demand (10 + 12 Nov). Groq: untested, no key.
- No physical desktop, no phone, no second node on this VM — the live paths for vision, Windows desktop control, ADB, Telegram/WhatsApp, and two-node sync are UNPROVEN until the laptop/cloud runs them. A VIRTUAL desktop (Xvfb) exists here and the CDP/Xvfb computer-use path is proven on it; that proves the loop, not the laptop.
- Chromium launches and renders on this VM, but the egress proxy rejects its CONNECT tunnels — external `goto` is unproven here only.

## Still needs Ankush
- His Windows laptop install (Node 24.22.1, WSL2, Ollama qwen3:8b) + `npx playwright install chromium` — see SETUP.md (Phases B–E section)
- His Gemini key in .env.local (secure form only) + Groq key later — unlocks live native function calling AND live screen vision; OpenAI/Anthropic keys unlock their native tool loops too (Phase A2)
- Desktop agent run on the laptop: `node desktop-agent.js` (second PowerShell window)
- Telegram bot token via @BotFather; spare number for WhatsApp (never primary)
- Oracle Cloud account (cloud node behind Tailscale) + `SYNC_PEER_URL`/`SYNC_TOKEN` for sync
- Android phone + authorised USB/wireless debugging, for live phone control

## Files
- `app/` — the working system: README, SECURITY, server/brain/tools/db, vision/screen/desktop/phone/telegram/whatsapp/browser/browser-session/desktop-input/computer-use/queue/sync/routines/freeze, settings/secrets/notify/replay/route/clipboard/windows/doctor, desktop-agent.js, public frontend (incl. `i18n.js`: English/Hindi/Telugu), tests (161/161), TEST-REPORT, security-check, demo script (`scripts/computer-use-demo.js`)
- `SYSTEM-DESIGN.md` — architecture, data flow, trust boundaries, failure modes; `PRIVACY.md` — plain-English privacy; `docs/` — API-KEYS, TOOLS, CUSTOMIZE
- `setup-app.sh` / `setup-app.ps1` — one-command laptop setup (+ dry-run); `.githooks/pre-push` — secret scan before every push
- `research/` — personal-ai-laptop-phone-cloud-2026-11-11.md, efficiency-2026-11-12.md, alternatives-2026-11-12.md, competitive-chatgpt-muse-2026-11-12.md, computer-use-phone-cloud-spec-2026-11-14.md (Phases B–E spec — BUILT 14 Nov, live paths marked; Phase A2 built 15 Nov), roadmap-responsible-autonomy-messaging-2026-11-15.md (design note: decision policies + audit + escalation, WhatsApp phased plan — NOT built/enabled)
- `projects/proof-internship-tracker/` — 9/9 tests, real full-stack proof project
- `skills/coding-agent.md` — OpenCode primary, goose fallback
- `GITHUB.md` — repo prep; repo is PUBLIC at https://github.com/ankushsingh21123-blip/personal-ai
