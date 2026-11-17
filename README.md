<img src="app/public/logo.svg" alt="Piplet logo" width="72" height="72">

# Piplet — your own fast personal AI, on your own devices

Piplet is a personal AI that works like a human operator, only faster: it
sees your screen, decides, acts, and re-checks — on your laptop, your
phone, and your own cloud node. It runs on hardware you own, with any API
key you choose (or none at all, fully local), for $0. No account, no
telemetry, no data leaving the machine except to the model provider you
configured.

Built by Ankush Singh (BSc Computer Science, Scaler School of Technology;
BS Data Science, BITS Pilani online) — first for himself, then for other
students and founders.

> **Name note:** the product is **Piplet**. The GitHub repo slug stays
> `personal-ai` because the URL is shared and referenced; renaming the
> repo is a decision for Ankush. The internal service id
> `ankush-personal-ai` is likewise unchanged.

## What it does

- **Computer use** — screen vision + desktop control + browser use:
  observe → decide → act → re-observe, with per-step latency and a replay
  log of every screen action with screenshots.
- **Any API key** — Gemini, Groq, OpenAI, Anthropic, Ollama local, or any
  custom OpenAI-compatible endpoint. Add keys in the Settings page only;
  chat channels refuse keys and show status only. See
  [`docs/API-KEYS.md`](docs/API-KEYS.md) for verified free sources.
- **Phone** — Android control over ADB (per-session, you allow it) and
  phone-as-remote over Telegram/WhatsApp. iOS is honestly messaging-only.
- **Offline-resilient** — durable outbox + multi-device sync; work queues
  visibly and drains when the connection returns.
- **Routines** — scheduled jobs with the same deny-first tools and
  approvals as a chat turn. A routine can never send, post, spend, or
  delete.
- **Customizable by talking to it** — ask the agent to change the app's
  behaviour; it edits code, runs the full test suite, and reports what
  changed. See [`docs/CUSTOMIZE.md`](docs/CUSTOMIZE.md).
- **Private by design** — loopback-only server, token auth, deny-first
  tools, approvals for anything irreversible, no credential/OTP/admin/
  payment automation ever. See [`PRIVACY.md`](PRIVACY.md) and
  [`app/SECURITY.md`](app/SECURITY.md).

## Quick start (laptop)

```bash
git clone https://github.com/ankushsingh21123-blip/personal-ai.git
cd personal-ai
bash setup-app.sh            # Linux/macOS/WSL — or .\setup-app.ps1 on Windows
```

Then open http://127.0.0.1:3100, add a key in **Settings** (or run fully
local with Ollama), and start chatting. Full guide: [`SETUP.md`](SETUP.md).
Verify an install any time with `npm run doctor` in `app/`.

## Docs

- [`STATUS.md`](STATUS.md) — honest build status: what is proven live,
  what is unit-tested only, what still needs a laptop/phone/keys.
- [`SYSTEM-DESIGN.md`](SYSTEM-DESIGN.md) — architecture, data flow, trust
  boundaries, failure modes.
- [`PRIVACY.md`](PRIVACY.md) — plain-English privacy: what stays, what
  leaves, and to where.
- [`docs/API-KEYS.md`](docs/API-KEYS.md) — where to get keys, what is
  actually free (verified 14 Nov 2026), paid providers, custom endpoints.
- [`docs/TOOLS.md`](docs/TOOLS.md) — every tool and action, and what was
  deliberately left out and why.
- [`docs/CUSTOMIZE.md`](docs/CUSTOMIZE.md) — change the app by talking to
  the agent; the tests-must-pass gate.
- [`app/tests/TEST-REPORT.md`](app/tests/TEST-REPORT.md) — test evidence,
  model names, timings, and the live-vs-mocked boundary.

## Status (18 Nov 2026, branch `computer-use` — not merged)

161/161 tests pass (22 live-server Phase A + 30 mocked provider unit +
37 Phases B–E + 42 product-expansion + 12 improvement-cycle + 18
computer-use), including Phase A2 native function calling for OpenAI +
Anthropic (unit-tested only, mocked fetch — no live keys on the build
VM) and 25 deny-first tools; 41 security checks pass (npm audit skipped
on the VM — endpoint unreachable, re-run on the laptop). The
computer-use cycle added stateful browser sessions (multi-tab, forms,
DOM + accessibility tree, screenshots, zoom, console/network
observation, downloads), DOM CHECK verification after every action,
desktop input via CDP/Xvfb (proven live on a virtual X11 session), the
`computer_use` tool, budgeted multi-step flows, and the zoom-fixed
observe loop. The 17 Nov cycle added 4 tools
(`create_approval`, `file_info`, `append_file`, `recent_activity`),
redirect-safe `web_fetch`, and a multilingual UI (English/Hindi/Telugu,
UI chrome only). The live paths for vision, desktop-agent execution,
ADB control, Telegram/WhatsApp, two-node sync, and external browser
navigation are **unproven** until they run on the laptop/phone/cloud —
the test report says exactly what was observed and what was mocked.
Nothing here claims otherwise.
