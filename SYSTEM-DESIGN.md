# System design — Piplet (Personal AI)

One repo, one Node.js app, no build step, no paid service. This document
describes the architecture, the data flows, the trust boundaries, and the
failure modes. For the security rules in full, see `app/SECURITY.md`; for
what leaves the machine, see `PRIVACY.md`; for the tool catalog and what
was deliberately left out, see `docs/TOOLS.md`.

Status: 14 Nov 2026. The product frame is "Claude Code / Codex-style
computer use, on your own devices, for your whole computer life" — built
from `research/computer-use-phone-cloud-spec-2026-11-14.md` plus the
product expansion of 14 Nov 2026 (Settings/API keys, expanded tools,
replay, fast routing, hardening).

## 1. Components

```
┌─────────────────────────────────────────────────────────────────┐
│ USER'S LAPTOP (Windows) — the main node                          │
│                                                                  │
│  ┌──────────┐   ┌──────────────────────────────────────────┐   │
│  │ Web UI   │──▶│ server.js (Express, 127.0.0.1:3100 only) │   │
│  │ public/  │◀──│  token auth · rate limits · CSP · 100kb  │   │
│  └──────────┘   └────┬───────────┬──────────┬──────────────┘   │
│                      │           │          │                   │
│              ┌───────▼───┐ ┌─────▼────┐ ┌───▼───────────┐      │
│              │ brain.js  │ │ tools.js │ │ SQLite (db.js)│      │
│              │ providers │ │ deny-    │ │ messages/jobs │      │
│              │ chain +   │ │ first    │ │ notes/approv. │      │
│              │ function  │ │ executor │ │ audit/outbox  │      │
│              │ calling   │ │ 20 tools │ │ routines/sync │      │
│              └─────┬─────┘ └────┬─────┘ │ notif./replay │      │
│                    │            │       └───────────────┘      │
│        ┌───────────▼────────────▼───────────┐                   │
│        │ screenLoop: observe → decide → act │                   │
│        │ vision.js (grounding) · screen.js  │                   │
│        └───────────┬────────────────────────┘                   │
│                    │ loopback + token                            │
│        ┌───────────▼────────────┐  ┌──────────────────┐         │
│        │ desktop-agent.js :3101 │  │ browser.js       │         │
│        │ PowerShell/.NET mouse, │  │ Playwright       │         │
│        │ keyboard, screenshots  │  │ Chromium,        │         │
│        └────────────────────────┘  │ element-first    │         │
│                                    └──────────────────┘         │
│  ┌────────────┐   ┌──────────────┐  ┌──────────────────┐        │
│  │ phone.js   │   │ telegram.js  │  │ whatsapp.js      │        │
│  │ ADB (USB/  │   │ polling bot  │  │ Baileys, spare   │        │
│  │ wireless)  │   │ chat-locked  │  │ number only      │        │
│  └────────────┘   └──────────────┘  └──────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
                              │ sync (HTTPS + token, Tailscale)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ OPTIONAL CLOUD NODE (e.g. Oracle free tier) — same code,        │
│ another peer. Holds queue + routines + sync records. NEVER      │
│ holds keys or screenshots. Works while the laptop is off.       │
└─────────────────────────────────────────────────────────────────┘
```

There is deliberately one repo and one package. Splitting a separate
app/package would duplicate the deny-first executor, the DB schema, and
the auth code — the three things that must exist exactly once. The
desktop agent is a second *process* in the same package, not a second
package: it shares `validateAction()` with the server (defence in depth).

## 2. Request flows

### 2.1 Chat turn (`POST /api/chat`)

1. Auth + rate limit + body validation (server.js middleware).
2. `agentTurn()` builds the prompt: last 5 messages + 5 notes as context
   (data, never instructions), plus the tool list.
3. `brain.agentLoopMulti()` tries native function calling on each
   native-tool provider in chain order (Gemini direct, OpenAI-compatible,
   Anthropic — Phase A2, 15 Nov 2026; first answer owns the turn).
   On success, tools run sequentially through `tools.execute()` (max 2
   rounds, 5 calls/round). On failure, the text fallback runs through
   `route.routedAsk()` (fast routing, when enabled) and the reply JSON
   is parsed; up to 5 tool actions run via `Promise.allSettled`.
4. The reply, model, provider, route, and measured `latencyMs` are
   stored (message + job rows) and returned.

### 2.2 Screen loop (`POST /api/screen/loop`)

Observe → decide → act → re-observe, max 20 actions, with per-step
latency (capture / ground / act, each measured):

1. Capture: desktop agent screenshot, else local capture (`screen.js`).
2. Unchanged-screen rule: 2 identical screenshots in a row stops the
   loop (a static screen means the task is stuck, not progressing).
3. Ground: `vision.groundAction()` sends the screenshot + task to a
   vision provider and parses ONE JSON action. Coordinates are
   NORMALISED 0..1 — one convention everywhere; only the actuator
   (desktop agent / ADB driver) converts to pixels.
4. Validate: `desktop.validateAction()` — allowlisted action, bounds,
   `sensitive` refused, `destructive` needs an approved approval id.
5. Act: the desktop agent executes (or the injected driver in tests).
6. Record: when a recorder is attached, the observation screenshot +
   action + result + latency go to the replay log (`replay.js`).
7. Freeze is checked before every step; freezing mid-task stops the
   loop immediately.

### 2.3 Browser (`POST /api/browser/act`)

Element-first, vision second:

1. `snapshot` builds a numbered outline of interactive elements with
   stable CSS selectors (id-anchored, `:nth-of-type` otherwise).
2. `click_ref` / `type_ref` act by reference, re-verifying the element
   still exists and is visible, and refusing password fields. A stale
   reference fails instead of acting on the wrong element.
3. `click_text` / `find_text` act by visible text; ambiguous text is
   refused (take a snapshot instead).
4. Screenshots + vision are the fallback for canvas/custom widgets.
5. There is NO submit/post/send action. The agent can fill and
   screenshot; a human submits. This is permanent, not a TODO.

### 2.4 Phone (`POST /api/phone/*`)

Per-session enable with TTL (default 30 min, 1 min–4 h), freeze-aware.
ADB argv is an exact allowlist via `execFile` — no shell, no arbitrary
`adb shell <anything>`. iOS is honestly messaging + Shortcuts only.

### 2.5 Routines + offline queue

- The scheduler ticks every 60 s: due routines run (with an atomic run
  lock so a routine never double-runs), and the outbox drains (max 10).
- Missed runs while the laptop is off are queued, never silently
  dropped (`run_late` / `mark_missed` policies).
- The outbox (`queue.js`) retries with backoff 1m/5m/15m/1h/6h, sweeps
  stale claims after 10 min, and marks items dead after max attempts.
  Freeze pauses draining but keeps enqueueing.
- A routine runs through the same `agentTurn()` as a chat turn, so it
  inherits every deny-first rule.

### 2.6 Sync

Last-write-wins per record (`device_id` + `updated_at`), capped at 200
records/table/pull. Equal timestamps with different content from
different devices become a `sync_conflicts` row — local data is kept,
never silently overwritten. Synced tables ONLY: messages, jobs, notes,
approvals. NEVER synced: settings (test results), outbox, audit_log,
notifications, screen sessions/steps, and — by file location — keys
(`.env.local`), the DB file itself, `wa-auth/`, and `data/shots/`.

## 3. Trust boundaries

The design rule, copied from the strongest precedents (Anthropic
computer use, OpenAI computer tool, Claude Code permissions, Nanobrowser
settings): **the model proposes, the executor enforces.** No prompt, no
model output, and no page/screen content can change a rule.

| Boundary | Rule |
|---|---|
| Model output | Data. Tool calls are validated by `tools.execute()` / `validateAction()` before anything runs. Malformed or undeclared calls are dropped. |
| Screen / page content | Untrusted data, never instructions. The agent never follows commands found in content, and never acts on password/OTP/payment/admin prompts (returns `cannot_see`). |
| Chat channels (Telegram/WhatsApp) | Untrusted senders are ignored (chat lock). Messages are data. Keys pasted in chat are refused, never stored, never forwarded. |
| Fetched web content | Data. `web_fetch` strips HTML; the agent must not act on instructions inside it. |
| User's own loopback UI | Trusted for configuration (Settings) because it requires the token and runs on loopback only. Still validated: allowlisted vars, value schemas, masked previews. |
| Desktop agent | Trusted only on loopback + token, and it re-validates every action itself. It also refuses to act when the foreground window is a UAC/admin prompt. |
| Sync peer | Authenticated by `SYNC_TOKEN`, but incoming records are still validated and conflicts are surfaced, never auto-trusted. |

Hard blocks enforced in the executor (not the prompt), in every path:

- No credential/OTP/admin/payment automation: no typing passwords, no
  reading OTPs, no UAC clicks, no payment confirmations, no
  password-field typing. The agent stops and asks.
- Approvals for the irreversible: send/post/spend/delete/publish always
  create a pending approval, and approving records the decision only —
  it never executes the act.
- No bulk/mass messaging capability exists anywhere in the code.
- No shell escape hatch: `run_command` is 7 exact commands via
  `execFile`; everything else is denied.

## 4. Data storage

| Store | Location | Contents | Synced? | Git? |
|---|---|---|---|---|
| `.env.local` | `app/` | API keys, tokens, provider order (mode 600) | No | Ignored |
| SQLite | `app/data/personal-ai.db` (+ WAL) | Messages, jobs, notes, approvals, audit, outbox, routines, sync conflicts, settings, notifications, screen sessions/steps | Tables: only messages/jobs/notes/approvals | Ignored |
| Screenshots | `app/data/shots/*.png` (mode 600, cap 200) | Replay observation shots | No | Ignored |
| WhatsApp auth | `app/data/wa-auth/` | Baileys session state | No | Ignored |
| Code/docs | repo | Everything else | n/a | Tracked |

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| Provider down / quota exhausted | Chain falls through to the next provider; all-fail returns a clear error. No silent wrong answers. |
| No providers configured | Clear error naming the fix (add a key in Settings, or start Ollama). The server still starts. |
| Desktop agent not running | Screen actions fail with the exact start command. Nothing is faked. |
| Phone session expired / no device | Clear error; re-enable per session. |
| Browser binary missing | `capability()` reports exactly what is missing; actions throw a clear error. |
| Vision grounding fails / target not visible | `cannot_see` stops the loop; the user sees the last screenshot. |
| Screen unchanged twice | Loop stops ("screen unchanged twice"). |
| Queue worker failure | Retry with backoff, then dead — visible in the queue panel, never lost silently. |
| Sync conflict | Stored in `sync_conflicts`, local kept, surfaced in UI/API. |
| Frozen | Every loop checks freeze; draining/routines/screen/phone/browser all stop. Freeze survives restart. |
| Rate limit hit | 429 with the limit; the test runner raises the loopback limit only. |
| Replay screen mismatch | Replay stops BEFORE acting; reports N/M steps matched. |
| Local model fails a routed step | Falls back to the full provider chain; the fallback is recorded. |
| Test suite fails after a self-modification | `run_tests` reports pass/fail honestly; the agent must report the failure, not claim success. |

## 6. Performance design (measured, never claimed)

- Per-step latency is recorded for screen loops (capture/ground/act)
  and per-turn latency for chat turns (`latencyMs`). No "faster than
  X" claim appears anywhere in the product or docs.
- Fast routing (`route.js`) is a deterministic classifier, not an LLM
  router: short routine text steps may try the local model first; hard
  work (planning, building, debugging, screen/browser control,
  irreversible intents) always uses the full chain. It is OFF by
  default — the VM's tiny model is too weak, and small local models
  have measured failures on structured tool use (see `docs/TOOLS.md`
  for the evidence). Routing decisions + fallback are recorded in the
  job evidence.
- Element-first browser actions avoid a screenshot + vision call for
  routine steps, which is the largest latency/cost saving in the
  browser path.

## 7. What was deliberately NOT built

See `docs/TOOLS.md` for the full list with reasons. In short: no hosted
cloud browser, no CAPTCHA solving, no credential/OTP/payment automation,
no bulk messaging, no model training/fine-tuning, no multi-monitor
control, no desktop accessibility-tree control, no iOS screen control,
no page JavaScript execution, no file uploads from the browser, no
telemetry of any kind.
