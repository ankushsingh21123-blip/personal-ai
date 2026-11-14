# Ankush's Personal AI — full working, $0

**Owner:** Ankush Singh — BSc Computer Science, Scaler School of Technology, 2nd year, Bengaluru / Hyderabad, India.
**Goal:** a personal AI that competes with ChatGPT and Muse — fast computer use, understands what the user wants and does it, on laptop + phone + cloud, works when the user is offline, $0 / free for Indian students/founders on WhatsApp. That gap is real: no exact laptop+phone+cloud $0 match exists. Build it for himself first, prove it, then sell the same system to other students/founders.

**Status (14 Nov 2026, VM build):** full stack wired up and tested — see `tests/TEST-REPORT.md`. Frontend + backend + SQLite database + server, all working end-to-end, 71/71 tests passing (22 live-server + 12 mocked provider unit tests + 37 Phases B–E tests). Phases B–E built: screen vision, desktop control (laptop agent), phone control (Android ADB + iOS honestly labelled), browser use (Playwright), offline queue + sync, routines, freeze, Telegram/WhatsApp scaffolding. Live paths needing the laptop/keys are marked UNPROVEN in the test report — nothing live is claimed that wasn't observed. OpenClaw gateway reinstalled (2026.11.3) and running; goose 1.59.0 installed.

## What it is

- **App (this folder):** Node 24 + Express + `node:sqlite` + static frontend. One server, one database, one UI — all wired up, no mocks.
  - `server.js` — backend: chat, tools, jobs, notes, approvals, audit, status, freeze, queue, routines, screen, phone, browser, sync, channels + the routines/outbox scheduler
  - `brain.js` — model providers, configurable chain: any API key the user supplies works (Gemini, Groq, OpenAI / OpenAI-compatible, Anthropic, Ollama local). Default order: Gemini free → Groq free → Ollama local; override with `BRAIN_PROVIDERS` in `.env.local`.
  - `tools.js` — deny-first tools: list/read files, write notes, edit files (with backup), web fetch (read-only), allowlisted shell commands
  - `db.js` — SQLite: messages, jobs, notes, approvals, audit_log, outbox, routines, routine_runs, sync_conflicts, settings
  - `vision.js` — screen vision: image input to Gemini/OpenAI/Anthropic + grounded-action parsing/validation (unit-tested, no live round-trip proven)
  - `screen.js` — screenshot capture backends (Windows .NET via the desktop agent, Linux scrot/import, macOS screencapture) + screen-state cache
  - `desktop.js` + `desktop-agent.js` — desktop control: validated screen actions + the observe→decide→act→re-observe loop (caps, stop rules, latency measurement); the agent is a laptop-only Windows process (PowerShell/.NET, loopback + token, on-screen indicator, UAC refusal)
  - `phone.js` — Android ADB control (exact-argv allowlist, per-session enable with TTL) + the honest iOS label (messaging only)
  - `telegram.js` — Telegram bot (polling, chat-locked, /status /freeze /approve commands); `whatsapp.js` — Baileys scaffolding with hard guards (spare number only, package + explicit confirmation required)
  - `browser.js` — Playwright headless browser use (https-only, no private IPs, no password typing, NO submit action — a human submits)
  - `queue.js` — durable offline outbox (atomic claims, backoff, stale-claim sweep, freeze-aware drain); `sync.js` — last-write-wins sync with surfaced conflicts
  - `routines.js` — scheduled routines (daily/interval, run lock, missed policy, approval rules only stricter); `freeze.js` — persisted instant-stop
  - `public/` — frontend: chat, jobs, approvals, notes, status, freeze button, queue, routines
- **Bases (kept, credited, not copied as his own):** OpenClaw (MIT, gateway + phone channels) + goose (Apache-2.0, coding agent) + Ollama (MIT, local model). See `../research/personal-ai-laptop-phone-cloud-2026-11-11.md` for the full architecture, licences and sources.
- **Brain order (tested for real, model named in every test):**
  1. Gemini free — `gemini-3.5-flash-lite` first for routine turns (~500 req/day reported, unverified), `gemini-3.6-flash` next for hard turns. `gemini-2.5-flash` is 404, never used. `gemini-3.8-flash` tested 12 Nov 2026: **503 high demand** — not used until it answers. Native function calling lives on this path (13 Nov 2026) — unit-tested, no live round-trip proven (no key on the VM).
  2. Groq free — `openai/gpt-oss-120b` (30 RPM / 1,000 req/day / 200k tok/day). Needs a free key Ankush creates himself — no key was created here, so Groq is **not tested yet**.
  3. Ollama local — `qwen3:8b` on the laptop (16 GB RAM), `qwen3:0.6b` on this VM only (too small for agent tool-calling — proven in `../tests/job4-gateway-local.md` / `job5-goose-hello-proof.md`).
  4. **Any API key (Phase A, 14 Nov 2026):** `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL` for any OpenAI-compatible endpoint, `OPENAI_MODEL`) and `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`) plug into the same chain. Chain order via `BRAIN_PROVIDERS` (e.g. `gemini,openai,anthropic,groq,ollama`); providers with no key are skipped. Both new paths are **unit-tested-only** (mocked fetch, `tests/providers.test.js`) — **no live round-trip proven**, no key on the VM. They are optional; the $0 chain works without them. See `.env.example` for every variable.

## How it works — perceive → reason → act

1. **Perceive:** user message (chat UI, later Telegram/WhatsApp) + last 5 messages + saved notes from SQLite (memory, read back into the prompt).
2. **Reason:** the brain (Gemini first) returns JSON `{reply, actions[]}`. If it returns prose, the server retries once asking for JSON only.
3. **Act:** tools run in parallel, deny-first. Allowed: read/list files, write notes, edit files (backup first), web fetch (https only, no private IPs), 7 allowlisted shell commands. Denied and logged: `rm -rf`, `sudo`, secret paths (`.env`, `.ssh`, credentials), send/post/spend/delete — those create a **pending approval** instead, and approving it still does NOT execute the send (a human sends it).

## Run it (laptop, Windows + WSL2 — see `../SETUP.md` for the full guide)

```bash
cd personal-ai/app
npm install
cp .env.example .env.local   # then put GEMINI_API_KEY=... in .env.local (git-ignored, never paste in chat)
npm start                     # http://127.0.0.1:3100 (loopback only)
# in another shell:
npm test                      # real tests against the live server
npm run security              # cyber checks
```

On this VM: `bash tests/run-tests.sh` (starts the server, runs `node --test tests/test.js`, stops it).

## Test it

- `tests/test.js` — 22 real tests, live server, no mocks: health, auth (no/wrong token → 401), status, Gemini brain (real call via VM helper), Ollama brain (real call), chat end-to-end with SQLite persistence, tools (read/edit/web_fetch), cyber (path traversal, secret file, dangerous shell, send tool denied + approval does not execute), frontend served, native function-calling declarations/parsing/agentLoop shape.
- `tests/providers.test.js` — 12 unit tests, mocked fetch, no server: OpenAI + Anthropic request shapes, response parsing, `BRAIN_PROVIDERS` order/fallback, key handling (no key ever returned). These prove the code paths, NOT live round-trips.
- `tests/phases.test.js` — 37 tests (28 unit + 9 live API): vision request shapes + grounded-action validation, screen capture/cache, desktop validation + loop (caps, stop rules, latency, freeze), phone ADB allowlist + session TTL + iOS label, Telegram commands + chat lock, WhatsApp guards, browser validation + injected driver + REAL Chromium launch/render/read/screenshot (local page), queue backoff/drain/restart survival, routines schedules/tick/lock/missed policy, sync merge/conflicts, and the live freeze/queue/routines/sync/phone/browser/screen/channels endpoints.
- `tests/TEST-REPORT.md` — what passed/failed, with model names and timings.
- `scripts/security-check.sh` — 21 cyber checks, all passing on 14 Nov 2026 (npm audit skipped on this VM — audit endpoint unreachable, re-run on the laptop).

## Security — read SECURITY.md

Loopback only, token auth, rate limit 60/min, 100kb body limit, security headers, no CORS, no `eval`, no shell `exec()` (execFile only), allowlist shell, deny-first tools, secrets git-ignored, `.env.local` mode 600, audit log for every tool call.

## What still needs Ankush himself

- His Windows laptop install (Node 22+, WSL2, Ollama + `ollama pull qwen3:8b`, `npx playwright install chromium`) — this VM is weaker (1.5 shared CPUs, 6 GB) and cannot substitute for it. Run the desktop agent (`node desktop-agent.js`) in a second window for live screen control.
- His Gemini key in `.env.local` (secure form only, never in chat) + Groq key later if he wants the fallback. The Gemini key also unlocks live screen vision.
- Telegram bot token via @BotFather (Phase 4, after 5 laptop jobs pass) and a **spare** number for WhatsApp (never his primary — Baileys ban risk).
- Oracle Cloud account (Phase 6, only after Phase 5 passes) — card hold is his — plus `SYNC_PEER_URL`/`SYNC_TOKEN` for the sync relay.
- Android phone + authorised USB/wireless debugging, for live phone control.
- His yes before any GitHub push, email send, or application submission. Repo is public at https://github.com/ankushsingh21123-blip/personal-ai (see `../GITHUB.md`).

## Honest limits — what it cannot beat yet

See `../research/competitive-chatgpt-muse-2026-11-12.md`. Short version: it cannot out-code frontier models on hard tasks, it is not yet always-on 24/7 for $0 (Oracle is the best $0 host, capacity/reclaim risk), and WhatsApp automation carries ban risk (spare number mandatory). What it *can* beat them on, for Ankush's actual jobs: $0 cost, phone-controlled, remembers his workflows, specialised for internships / gigs / agency / Nova Shorts / scholarships, and he owns it and can sell it. That is the product angle — not "first AI assistant", not "beats GPT on coding".
