# Piplet (Personal AI) — build status (14 Nov 2026, ~16:45 IST)

Full working, $0, full stack wired up — frontend + backend + database + server + cyber checks.
Scope: compete with ChatGPT and Muse (12 Nov 01:24 IST) — a public AI assistant product, not just a personal tool.
Phases B–E (computer use, phone, offline queue + cloud sync, routines) built 14 Nov from `research/computer-use-phone-cloud-spec-2026-11-14.md` — real code, tested, with the live paths honestly marked UNPROVEN below.
Product expansion built 14 Nov (same day): Settings/API keys end to end, 20 tools, replay log, fast routing, notifications, clipboard/window control, key refusal in chat channels, one-command setup + doctor, security hardening — see `SYSTEM-DESIGN.md`, `PRIVACY.md`, `docs/TOOLS.md`, `docs/CUSTOMIZE.md`, `docs/API-KEYS.md`.
Improvement cycle 17 Nov 2026: 4 more tools (24 total: `create_approval`, `file_info`, `append_file`, `recent_activity`), redirect-safe `web_fetch` (every hop re-validated), multilingual UI (English/Hindi/Telugu, chrome only), chat-first layout with node-append rendering + pending indicator. 143/143 tests, 35 security checks — see `app/tests/TEST-REPORT.md`.
Improvement cycle 2, 17–18 Nov 2026: hash-chained audit log (`app/audit.js`: every entry hashes the previous, `GET /api/audit/verify`, run receipts as JSON/Markdown) + eval harness (15 golden tasks, `node scripts/run-eval.js`, deterministic across repetitions) + `npm test` removed from the shell allowlist (the `run_tests` tool is the sanctioned path). 155/155 tests, 35 security checks — see `app/tests/TEST-REPORT.md`.
Improvement cycle 3, 18 Nov 2026: skills system (`app/skills.js`: `skills/<name>/SKILL.md` folders, progressive disclosure, hash-pinned human approval in `skills/approved.json`, `skills/_drafts/` ignored, approve-skill CLI — no API approval endpoint) + 5 first skills (`coding-agent`, `goose`, `reply-mirroring`, `eval-checklist`, `safe-web-research`, all active) + `GET /api/skills` + Skills and Audit panels in the UI. 177/177 tests, 37 security checks — see `app/tests/TEST-REPORT.md`.
Improvement cycle 4, 18 Nov 2026: Memory v2 (`app/memory.js`: timestamped facts in `memory_facts` + FTS5 index, scope/topic/source on every fact, contradiction supersession with history kept, hard-delete forget, edit-with-history, strict per-scope filtering; recall returns citations + history) + 4 memory tools (28 total) + `GET/POST/PUT/DELETE /api/memory` + Memory panel in the UI (view/forget/inline edit, 9 new i18n keys × English/Hindi/Telugu) + 3 eval tasks (18 total). Recall is FTS5 keyword-based, not vectors — the sqlite-vec alternative was unavailable without new infrastructure; the decision is documented in `memory.js`. 196/196 tests, 39 security checks — see `app/tests/TEST-REPORT.md`.
Audit-fix cycle 5, 18 Nov 2026: fixed the deep audit (`audit-2026-11-18.md`) in severity order — H-1 search secrets leak, H-2 symlink escape, H-4 app-write gate (agent self-modification removed; see `docs/CUSTOMIZE.md`), H-3 Telegram fail-closed, M-4 WhatsApp allowlist, H-15 port-in-use exit, H-16 SQLite busy_timeout, H-11 turn budget + M-19 shared cap + M-1 freeze gating, H-12 status caching, H-13 usage accounting + Groq budget, H-14 routing on raw text, H-5 configured order, frontend H-6/H-7/H-8/H-9/H-10, M-7 dotenv-as-data, M-21 max_actions clamp, M-24 error mapping, M-26 audit failure counting + 2 eval tasks (20 total). 223/223 tests, 58 security checks, UI verified in real Chromium — see `app/tests/TEST-REPORT.md`. Remaining audit items (Mediums/Lows + honest gaps vs Codex/Claude Code) are listed in the audit report's Findings and Fix-queue sections; nothing from the unfixed list is claimed fixed.
Verify-fix cycle (push gate), 18 Nov 2026: skill-loaded turns through local Ollama failed end-to-end (shared 60 s timeout vs ~140 s measured) — Ollama now has its own generation cap (`OLLAMA_NUM_PREDICT`, default 512) and timeout (`OLLAMA_TIMEOUT_MS`, default 180 s); the suite now runs test files serially (`--test-concurrency=1`) after two shared-DB flakes. 228/228 tests (two consecutive green runs), 58 security checks, 20/20 eval deterministic, 43/43 live API checks + 11/11 real-Chromium UI checks on throwaway DBs — see `app/tests/TEST-REPORT.md`.

## What works on this VM (tested for real — see app/tests/TEST-REPORT.md)
| Piece | Version / model | Status |
|---|---|---|
| App (frontend+backend+DB+server) | Node 24.22.1, Express 5.3.0, node:sqlite | ✅ 228/228 tests pass, ~95 s serial (22 live Phase A + 30 provider unit + 37 Phases B–E + 42 product-expansion + 12 improvement-cycle + 12 cycle-2 + 22 cycle-3 + 19 cycle-4 + 27 cycle-5 + 5 cycle-6, 18 Nov) |
| Multi-provider brain (Phase A) | Gemini, Groq, OpenAI/OpenAI-compatible, Anthropic, Ollama | ✅ Chain + fallback proven; OpenAI/Anthropic unit-tested-only (no live key on VM) |
| Settings / API keys | `settings.js` + `/api/settings/*` + Settings UI | ✅ Write/remove/order/test round-trips proven live; masked previews only; keys in `.env.local` (600), never synced/logged; cloud-provider test calls unproven (no keys) |
| Native function calling | Gemini `functionDeclarations` + OpenAI `tools` + Anthropic `tools` → deny-first tools, 2 rounds max, 5 calls/round | ✅ Wired: schemas derived from one declaration source (28 tools), malformed/undeclared calls dropped; `agentLoopMulti` tries native providers in chain order; live end-to-end needs his keys on the laptop (Phase A2, unit-tested-only) |
| Fast routing | Deterministic classifier, local-first for routine text only | ✅ Unit-tested + fallback proven; OFF by default; routing decision + latency recorded per turn |
| Replay log | Sessions + PNG shots + verified replay | ✅ Record/retrieve/purge + verified-replay semantics proven (mocked + live HTTP); live screen replay needs the laptop |
| Notifications | Local inbox, UI + API | ✅ Proven live (create/read/unread) |
| Clipboard / windows | `clipboard.js`, `windows.js` | ⏳ Unit-tested with injected runners — NO live desktop on VM |
| Gemini (primary brain) | gemini-3.5-flash-lite first, gemini-3.6-flash fallback | ✅ Works via VM helper. 3.8-flash: 503 (12 Nov), 2.5-flash: 404 |
| Ollama local | qwen3:0.6b (VM only) | ✅ Answers short prompts (~10 s); too small for agent tool-calling |
| Groq fallback | openai/gpt-oss-120b | ⏳ Not tested — no key created (Ankush creates it himself) |
| Screen vision (Phase B) | Gemini/OpenAI/Anthropic image input + grounded actions | ⏳ Unit-tested with mocked fetch — NO live round-trip proven (no key, no desktop on VM) |
| Desktop control (Phase B) | `desktop-agent.js` (Windows, PowerShell/.NET) + `screenLoop` | ⏳ Loop + validation unit-tested with mocks; agent refuses to start on Linux — LIVE execution needs the laptop |
| Browser use | Playwright 1.65.1 + Chromium headless shell 159.0.8154.6 | ✅ Launch + render + read + screenshot + element-first actions (snapshot/click_ref/type_ref/find_text) proven live on a local page; external `goto` UNPROVEN here (VM egress proxy rejects Chromium tunnels — works on the laptop) |
| Phone control (Phase C) | ADB allowlist + per-session enable + iOS label | ⏳ Unit-tested with mock executor — NO live device on VM; iOS honestly labelled messaging-only |
| Telegram (phone-as-remote) | Polling bot, chat-locked | ⏳ Commands + gating + key refusal + `/providers` unit-tested with mocked API — NO live run (no token on VM) |
| WhatsApp scaffolding | Baileys guards only | ⏳ Guards + key refusal unit-tested — no package, no number, no account; spare-number confirmation mandatory |
| Offline queue (Phase D) | SQLite outbox, backoff 1m/5m/15m/1h/6h | ✅ Proven live: enqueue/drain/retry/dead + restart survival (new DB connection) |
| Sync (Phase D) | Last-write-wins + conflicts surfaced | ✅ Merge unit-tested, push/pull live-tested single-node; two-node UNPROVEN (needs cloud node) |
| Routines (Phase E) | Daily/interval schedules, run lock, missed policy | ✅ Proven live: tick, lock, dry run, CRUD API; schedule strings (`"09:00 mon-fri"`, `"every 30m"`) supported; a routine can never send/post/spend/delete |
| Freeze (instant stop) | Persisted in SQLite | ✅ Proven live: stops screen/phone/browser/routine/queue loops, survives restart |
| Setup + doctor | `setup-app.sh` / `setup-app.ps1`, `app/doctor.js` | ✅ Doctor passes on the VM (adb skipped); `.sh` dry-run tested; `.ps1` + full `.sh` run UNPROVEN (need the laptop) |
| Security checks | scripts/security-check.sh + `.githooks/pre-push` | ✅ ALL PASS (58 checks, re-run 18 Nov; npm audit skipped — endpoint unreachable from VM) |
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
- His Gemini key in .env.local (secure form only) + Groq key later — unlocks live native function calling AND live screen vision; OpenAI/Anthropic keys unlock their native tool loops too (Phase A2)
- Desktop agent run on the laptop: `node desktop-agent.js` (second PowerShell window)
- Telegram bot token via @BotFather; spare number for WhatsApp (never primary)
- Oracle Cloud account (cloud node behind Tailscale) + `SYNC_PEER_URL`/`SYNC_TOKEN` for sync
- Android phone + authorised USB/wireless debugging, for live phone control

## Files
- `app/` — the working system: README, SECURITY, server/brain/tools/db/audit/skills/memory, eval harness (`eval-tasks.js`, `eval-runner.js`, `scripts/run-eval.js`), vision/screen/desktop/phone/telegram/whatsapp/browser/queue/sync/routines/freeze, settings/secrets/notify/replay/route/clipboard/windows/doctor, desktop-agent.js, public frontend (incl. `i18n.js`: English/Hindi/Telugu), tests (228/228), TEST-REPORT, security-check
- `SYSTEM-DESIGN.md` — architecture, data flow, trust boundaries, failure modes; `PRIVACY.md` — plain-English privacy; `docs/` — API-KEYS, TOOLS, CUSTOMIZE
- `setup-app.sh` / `setup-app.ps1` — one-command laptop setup (+ dry-run); `.githooks/pre-push` — secret scan before every push
- `research/` — personal-ai-laptop-phone-cloud-2026-11-11.md, efficiency-2026-11-12.md, alternatives-2026-11-12.md, competitive-chatgpt-muse-2026-11-12.md, computer-use-phone-cloud-spec-2026-11-14.md (Phases B–E spec — BUILT 14 Nov, live paths marked; Phase A2 built 15 Nov), roadmap-responsible-autonomy-messaging-2026-11-15.md (design note: decision policies + audit + escalation, WhatsApp phased plan — NOT built/enabled)
- `projects/proof-internship-tracker/` — 9/9 tests, real full-stack proof project
- `skills/coding-agent/SKILL.md` — OpenCode primary, goose fallback
- `GITHUB.md` — repo prep; repo is PUBLIC at https://github.com/ankushsingh21123-blip/personal-ai
