# Personal AI — computer use, phone + cloud spec

**Owner:** Ankush Singh — BSc CS, Scaler School of Technology, Bengaluru / Hyderabad
**Date:** 14 Nov 2026
**Status:** BUILT 14 Nov 2026. Phase A (multi-provider brain) was implemented 14 Nov; Phases B–E were built the same day from this spec — see `app/vision.js`, `app/screen.js`, `app/desktop.js`, `app/desktop-agent.js`, `app/phone.js`, `app/telegram.js`, `app/whatsapp.js`, `app/browser.js`, `app/queue.js`, `app/sync.js`, `app/routines.js`, `app/freeze.js`, and `app/tests/phases.test.js` (71/71 tests pass). Honest status, unchanged from §2: the live paths for vision, desktop-agent execution, ADB control, Telegram/WhatsApp, two-node sync, and external browser `goto` are UNPROVEN on the VM (no key / desktop / phone / second node / Chromium-capable egress here) — see `app/tests/TEST-REPORT.md` for exactly what was observed live and what was unit-tested with mocks. Nothing in this repo claims otherwise.
**Rule:** **$0 for everything.** No paid signups, no spending. Providers that need a paid key are optional — the $0 path (Gemini free → Groq free → Ollama local) always stays working without them.

---

## 1. Ankush's direction, verbatim (14 Nov 2026, 00:03 IST)

> "And personal ai wht i said it do it prfctly wht i said exctly and not only gemini any api key thy cn use and add full control computer use and desktop use and phone use ai cn see it read it work fr it faster than all model milisec moving cursir working so fast extly wht the user wana thinking and doing it same like codex computer use but fir the phone laptop cloud computer if wwe offline the work not gona stop and the same browser use and all same like muse and strawberry ai and the things with all thing routines and all. Bro I cn give a suggestion u make it like it can be codex computer use in Claude and in own devices not only laptop fr phone too"

Read faithfully, the requirements are:

1. **Any API key** — the user can plug in any provider's key, not Gemini-only.
2. **Full computer use** — desktop control + phone control, not chat-only.
3. **The AI can SEE the screen, READ it, and work on it** — vision + grounding + action.
4. **Fastest possible action loop** — millisecond cursor movement and fast working, acting exactly as the user intends.
5. **Codex-style computer use, but for phone + laptop + cloud computer** — the same agent across his own devices.
6. **Offline-resilient** — if the connection drops, the work must NOT stop.
7. **Browser use and everything, like Muse / agentic AIs** — full agentic capability, not a chatbot.
8. **Routines and automations included** — recurring jobs, not only one-off chats.

His suggestion, kept as the product frame: **"Codex computer use in Claude, on own devices, not only laptop, for phone too."** I.e. the capability shape of a frontier computer-use agent, running on hardware he owns, across laptop and phone.

---

## 2. Honest engineering bounds (read before building)

These are stated plainly because the direction contains claims no honest build can promise as fact. The design below respects them; nothing in this repo may claim otherwise.

1. **Cursor/action execution is milliseconds; the thinking step is not.** Moving a cursor, clicking, and typing execute in milliseconds once decided. But every *decision* — what to look at, what it means, what to do next — costs a model call, and model latency is hundreds of milliseconds to seconds, bounded by the provider, the network, and the model size. No architecture makes the thinking step "milliseconds" for frontier reasoning. **"Faster than all models" is NOT promised and must never be claimed.** What the design does instead: a **fast local model for routine actions** (click the known button, type the known text, read the known field) and **frontier models only for hard reasoning** (plan the task, recover from the unexpected, judge the result). Speed comes from spending the least thinking on the most routine steps — small local model, short prompts, cached screen state, batched actions — not from beating frontier latency.
2. **Offline means local model + queued work, not magic.** When the network drops, cloud providers are unreachable — no design changes that. Offline resilience means: (a) the local Ollama model keeps answering and acting on-device; (b) work that needs the cloud is **queued durably** (SQLite outbox) and **syncs when the connection returns**; (c) the user is told what ran offline vs what is queued. The work does not *stop*; the cloud-dependent parts *wait*, visibly.
3. **No dependable free 24/7 host is guaranteed.** Oracle Always Free is the best $0 cloud option on file, with capacity and reclaim risk; no free tier guarantees an always-on machine. The cloud computer is a *sync + queue + remote-run* node, not a promised 24/7 uptime. The laptop and phone remain the primary compute; the cloud is the relay and the backup, not the single point of failure.
4. **Phone control differs by OS — Android is feasible, iOS is heavily restricted by Apple.** Android allows ADB-class control (screen capture, tap/swipe/key events, app launch) on a device the user owns and has authorised via USB/wireless debugging. iOS does not allow general screen control or automation from a third-party agent: no public API exists to move a cursor, tap arbitrary apps, or read another app's screen. iPhone control is limited to what Apple permits (Shortcuts, share-sheet intents, app-specific integrations) and must never be presented as full control. The phone plan is Android-first; iOS gets messaging + shortcuts-grade capability only, honestly labelled.
5. **Sign-ins, OTPs, and admin prompts are NEVER automated, by design.** Passwords, one-time codes, 2FA approvals, UAC/admin prompts, and payment confirmations are the user's own acts. The agent stops and asks; it never types a credential, never reads an OTP, never clicks "Yes" on an elevation prompt. This is a safety property of the product, not a missing feature — it is what makes the agent safe to leave running on the user's own devices.
6. **Vision grounding is probabilistic.** "See the screen and click the right thing" is a model judgement over pixels. It will sometimes misread, misclick, or act on a changed UI. Every screen action must therefore be: logged with a screenshot hash + the intended target, reversible where possible, and gated — destructive or irreversible actions (delete, send, pay, publish) always go through the existing approvals flow, exactly as today's tools do. No silent screen actions on anything that cannot be undone.
7. **No benchmark is claimed until it is measured.** Latency, accuracy, and task-success numbers in this spec are targets to measure on the laptop, not results. Nothing here cites a benchmark the build has not run.

---

## 3. Phased roadmap

### Phase A — Multi-provider brain (IMPLEMENTED 14 Nov 2026, unit-tested-only for new providers)

**Goal:** any API key the user supplies works; provider order is configurable; the $0 chain keeps working with no keys at all.

- Provider abstraction in `app/brain.js`: one registry, one `chat(prompt)` shape per provider, keys read from env at call time, never logged or returned.
- Providers: `gemini-direct` (Gemini REST, native function calling — existing), `gemini-vm-helper` (VM-only helper — existing), `groq` (existing), **`openai`** (NEW: OpenAI API + any OpenAI-compatible base URL via `OPENAI_BASE_URL`), **`anthropic`** (NEW: Anthropic Messages API), `ollama` (existing local fallback).
- Order via `BRAIN_PROVIDERS` env var (comma-separated, e.g. `BRAIN_PROVIDERS=gemini,openai,anthropic,groq,ollama`); providers with no key are skipped; unknown names are ignored; unset means the existing default order. `ask(prompt, only)` still pins one provider for testing.
- Env vars: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`, `BRAIN_PROVIDERS`. All optional, all in `.env.local` (git-ignored), documented in `SETUP.md`, `app/README.md`, `app/.env.example`.
- **Honest status:** the OpenAI and Anthropic paths are **unit-tested-only** (mocked fetch in `app/tests/providers.test.js`). No live key exists on this VM, so **no live round-trip is proven** for either. Gemini direct native function calling is likewise unproven live (no key on the VM) — the live-verified paths remain the Gemini VM helper and Ollama. Do not claim otherwise.
- **Follow-up (Phase A2, not built):** native function calling for the OpenAI-compatible and Anthropic providers (tool schemas + tool-call loop in `agentLoop`), so every provider can act natively instead of through the JSON-text fallback. The provider interface is shaped for it (`chat()` today, `generateWithTools()` later); the deny-first executor stays the single gate either way.

### Phase B — Screen vision + desktop control (BUILT 14 Nov 2026 — live execution unproven, needs the laptop)

**Goal:** the agent sees the laptop screen, reads it, and acts on it — Codex-style computer use on the user's own desktop.

- **Capture:** screenshot the active display (OS-native capture; on Windows, via the desktop agent — see below). Screenshots stay on-device; only the model call leaves the machine, and only to the provider the user configured.
- **Vision + grounding:** the screen image + the task go to a vision-capable model (provider-configured; local vision model via Ollama where the laptop can run one). Output is a grounded action: `{action: click|type|scroll|key, x, y, text}` plus a confidence and a plain-language description of what it intends ("Click the Send button, top right").
- **Actuation:** a small desktop agent (separate process, user-installed on the laptop) that performs mouse/keyboard actions and reports back with a fresh screenshot. It accepts actions ONLY from the local server on loopback, with the same token auth as the app. It refuses credential fields, admin prompts, and payment dialogs by rule (see §2.5).
- **Loop:** observe → decide → act → re-observe, with a per-task action cap and a stop rule: if the screen does not change as expected twice in a row, stop and show the user the last screenshot + what was attempted. Every action is logged to the SQLite audit log with its intended target.
- **Speed design (per §2.1):** routine actions use the fast local model and short prompts; the frontier model is called only to plan, to recover, or to judge completion. No claim of beating frontier latency — the win is fewer frontier calls per task.
- **Safety gates (non-negotiable):** no credential/OTP/admin automation; destructive actions need approval; a visible on-screen indicator while the agent is controlling the desktop; a single keystroke / button that freezes the agent instantly.

### Phase C — Phone control (BUILT 14 Nov 2026 — live control unproven, needs his phone)

**Goal:** the same agent, on the phone — see the phone screen, act on it, and keep working when the phone is the device in hand.

- **Android (feasible):** ADB-class control on a user-owned device with USB/wireless debugging authorised by the user: screen capture (`screencap`), input events (`input tap/swipe/keyevent`), app launch, and notifications read. Same observe → decide → act loop as Phase B, same safety gates, same audit log. The phone agent runs on the phone (or on the laptop driving the phone over ADB) and talks to the same brain.
- **iOS (restricted — honest label):** no general screen control exists. iOS capability is limited to: messaging channels (Telegram/WhatsApp via the gateway), Shortcuts the user installs, and app integrations that expose actions. The product must say so on the iOS surface — never imply full iPhone control.
- **Phone-as-remote (first, before full control):** the phone already works as the control surface for the laptop/cloud agent via Telegram (Phase 4 in `SETUP.md`) — chat the agent, approve actions, see job status. Full phone *control* (Phase C) builds on top of that; it does not replace it.
- **Presence rule (Ankush's own rule, 11 Nov 2026):** phone access only when needed and only when the user allows it. The phone agent must be explicitly enabled per session, with a visible indicator while active, and must stop the moment the user takes the phone.

### Phase D — Offline queue + cloud sync (BUILT 14 Nov 2026 — queue proven live, two-node sync unproven)

**Goal:** the work does not stop when the connection drops; devices stay in sync when it returns.

- **Local-first execution:** every device runs the same app core (brain + tools + SQLite). The local Ollama model is always the last provider in the chain, so a turn can complete with no network at all.
- **Durable outbox:** any job that needs the cloud (a frontier provider call, a web fetch, a sync) is written to a SQLite outbox table first, then attempted. On failure it stays queued with its next-retry time; on reconnect, the outbox drains in order. Nothing is lost to a dropped connection, and nothing is silently skipped — the UI shows queued vs done.
- **Sync:** messages, jobs, notes, and approvals sync between laptop, phone, and the cloud node when a connection exists (last-write-wins per record with device + timestamp; conflicts surfaced, never silently overwritten). The cloud node is a relay + remote runner, not the only copy — each device keeps its own SQLite database.
- **Cloud node:** Oracle Always Free (or any $0 VPS the user already has), running the same app behind Tailscale (private network, no public exposure). Honest bound per §2.3: capacity/reclaim risk is real; the system must keep working with the cloud node down, and say so in the UI when it is.
- **Status honesty:** the UI always shows which providers are reachable, whether the device is offline, and how many jobs are queued. No silent degradation.

### Phase E — Routines (BUILT 14 Nov 2026 — proven live)

**Goal:** recurring jobs the user defines once and the agent runs on schedule, across devices.

- **Routine = schedule + task + scope + approval rule.** E.g. "every weekday 09:00, check Internshala for new matching roles and draft applications" — the routine runs the same perceive → reason → act loop as a chat turn, with the same deny-first tools and the same approvals flow for anything irreversible.
- **Definition surface:** routines are defined in the app UI (or a routines file in the workspace), stored in SQLite, and editable/deletable by the user at any time. No routine may send, post, spend, or delete without the approval step — a routine's approval rule can only make it *stricter*, never looser.
- **Scheduling:** a local scheduler in the app (no external cron service needed); on the cloud node, the same scheduler runs the routines assigned to it. If a routine's scheduled time passes while the device is offline, it runs on reconnect (or is marked missed, per the routine's setting) — never silently dropped, never double-run (a run lock in SQLite).
- **Reporting:** every routine run writes a job record with evidence, exactly like a chat turn. The user sees what ran, what it did, and what is waiting for approval — in the app and on the phone channel.

---

## 4. What stays true in every phase (non-negotiables)

1. **$0.** Every phase must work without a paid key. Paid providers are optional upgrades, never requirements.
2. **Deny-first.** The executor (`tools.js` and its screen/phone counterparts) is the single gate. A model asking is never permission.
3. **Approvals for the irreversible.** Send, post, spend, delete, publish — always a pending approval, and approving never executes the act itself. A human sends.
4. **No credential automation.** Sign-ins, OTPs, admin prompts, payments — the user, always.
5. **Local-first, private by default.** Loopback binding, token auth, no public exposure, no data leaving the device except to the provider the user configured. Screenshots and screen state stay on-device except for the model call itself.
6. **Honest reporting.** Every turn, job, and routine run records which model actually answered, what was attempted, and what is unverified. No invented traction, no invented benchmarks, no "faster than all models."
7. **The user can stop it instantly.** A freeze control on every surface, and every agent process dies cleanly when told to.

---

## 5. Sources and prior work

- Direction: Ankush Singh, 14 Nov 2026 00:03 IST (quoted in §1).
- Current build: `app/` — Node 24 + Express + SQLite, brain Gemini → Groq → Ollama, deny-first tools, native Gemini function calling (13 Nov 2026, unit-tested; no live round-trip proven — no key on the VM).
- Architecture research: `~/workspace/research/personal-ai-laptop-phone-cloud-2026-11-11.md` (OpenClaw + goose + Ollama; Gemini → Groq → Ollama brain; Telegram-first phone; Oracle + Tailscale cloud).
- Efficiency research: `research/efficiency-2026-11-12.md` (native function calling, per-task model routing, parallelism — the speed design in §2.1 follows its #1 and routing recommendations).
- Alternatives research: `research/alternatives-2026-11-12.md` (provider/model table — the source for the Phase A provider list).
- Competitive research: `research/competitive-chatgpt-muse-2026-11-12.md` (honest limits — what the product can and cannot claim against ChatGPT/Muse).
- Prior art named by Ankush (Codex computer use, Muse, "strawberry ai") is treated as a capability reference, not a codebase — nothing is copied from them; the build is original code on MIT/Apache-2.0 bases (OpenClaw, goose, Ollama), credited in `app/README.md`.
