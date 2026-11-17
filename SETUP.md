# Piplet (Personal AI) — laptop setup guide (Phase 0–2)

**Owner:** Ankush Singh · **Cost:** $0 — no paid signups, no spending, no Connects.
**Stack:** OpenClaw (gateway) + goose (coding agent) · Brain order: Gemini free → Groq free → Ollama local (qwen3:8b). Any API key works — OpenAI and Anthropic are optional extras via `.env.local` (see "Any API key" below); the $0 chain needs no paid key.
**Status:** built and tested on the Muse VM on 11 Nov 2026. See `tests/` for the evidence.
The VM is weaker than a laptop (1.5 shared CPUs, 6 GB cgroup RAM) — anything that was
slow or blocked there is flagged below with the laptop expectation.

## What you need before you start

- Your Windows laptop (16 GB RAM recommended; 8 GB minimum — qwen3:8b needs ~6 GB).
- A Telegram account (phone step, Phase 4). WhatsApp comes later, on a **spare number only**.
- Your Gemini API key — the one already created 10 Nov 2026 in AI Studio, project AgroX,
  key name `muse-email-triage-2026-11-10`. You will paste it into a secure form / into
  OpenClaw's onboarding prompt on your own laptop. **Never paste it in chat.**
- ~10 GB free disk (models + Node + WSL2).

## Step 0 — install the base tools (PowerShell, run as Ankush)

```powershell
winget install OpenJS.NodeJS.LTS        # Node 22 LTS (OpenClaw needs 22+)
winget install Git.Git
winget install Python.Python.3.12
wsl --install -d Ubuntu                  # WSL2 Ubuntu — the agent runs here
```

Close and re-open PowerShell, then check:

```powershell
node --version   # want v22.x
npm --version
git --version
python --version
wsl --status
```

If `winget` is missing, install the tools from their sites: nodejs.org (22 LTS),
git-scm.com, python.org, and enable WSL2 from "Turn Windows features on or off".

## Step 1 — Ollama (local brain)

1. Download `OllamaSetup.exe` from https://ollama.com/download and run it.
   Ollama runs as a Windows service and auto-starts on login.
2. In PowerShell, set the big context window (Ollama's default 4096 silently truncates
   agent prompts — this bit us on the VM):

```powershell
[System.Environment]::SetEnvironmentVariable("OLLAMA_CONTEXT_LENGTH", "32768", "User")
$env:OLLAMA_CONTEXT_LENGTH = "32768"
```

3. Restart Ollama (right-click the Ollama tray icon → Quit, then start it again),
   then pull the model and test it:

```powershell
ollama pull qwen3:8b
ollama run qwen3:8b "Say hello in one sentence, then stop."
```

If qwen3:8b is too slow on 8 GB RAM, use `qwen3:4b` instead (`ollama pull qwen3:4b`).
On the VM we could not pull any model from `registry.ollama.ai` — the VM's egress
proxy blocks Ollama's direct connection (curl works, Ollama's client does not).
**Your laptop has normal internet, so `ollama pull` should work directly.**
If it ever fails on the laptop, the fallback is: download the GGUF from
Hugging Face (`Qwen/Qwen3-8B-GGUF`, file `Qwen3-8B-Q4_K_M.gguf`) and
`ollama create qwen3:8b -f Modelfile` with `FROM <path-to-gguf>` — exactly how
we got a model onto the VM (see `tests/job4-gateway-local.md`).

## Step 2 — project folder + identity files

```powershell
mkdir $HOME\personal-ai\memory, $HOME\personal-ai\logs, $HOME\personal-ai\projects, $HOME\personal-ai\skills
cd $HOME\personal-ai
git init
@(".env.local", "node_modules/", ".openclaw/") | Set-Content .gitignore -Encoding utf8
```

Copy these files from this workspace into `$HOME\personal-ai`:
`AGENT.md`, `permissions.json`, `skills/goose/SKILL.md`.
Put your Gemini key in `.env.local` as `GEMINI_API_KEY=...` (secure form only).

Working model names, verified 10–11 Nov 2026: **`gemini-3.6-flash`**,
**`gemini-3.5-flash-lite`**. `gemini-2.5-flash` is gone for new users (404).
`gemini-3.8-flash` returned 503 (high demand) on 10 Nov.

### Any API key (Phase A, 14 Nov 2026) — optional, $0 chain unchanged

The brain is a provider chain, not Gemini-only. Any of these keys can be added
to `.env.local` (git-ignored, never paste a key in chat). Providers with no key
are skipped automatically; the $0 chain (Gemini free → Groq free → Ollama
local) keeps working with none of these set.

```text
OPENAI_API_KEY=       # only if you already have an OpenAI key
OPENAI_BASE_URL=      # optional, default https://api.openai.com/v1 — set to ANY
                      # OpenAI-compatible endpoint (a local server, another
                      # provider that speaks the chat-completions format)
OPENAI_MODEL=         # optional, default gpt-4o-mini — set to whatever your
                      # key's account supports
ANTHROPIC_API_KEY=    # only if you already have an Anthropic key
ANTHROPIC_MODEL=      # optional, default claude-haiku-4-5
ANTHROPIC_MAX_TOKENS= # optional, default 1024 (the Anthropic API requires it)
BRAIN_PROVIDERS=      # optional chain order, comma-separated, e.g.
                      # gemini,openai,anthropic,groq,ollama — unset means the
                      # default order (gemini-direct, gemini-vm-helper, groq,
                      # ollama). Unknown names are ignored.
```

Honest status: the OpenAI and Anthropic paths are unit-tested with mocked
responses only — no live key exists on the build VM, so no live round-trip is
proven for either. Test yours on the laptop with
`POST /api/brain/test {"provider":"openai"}` (or `"anthropic"`) once the key
is in `.env.local`. Native function calling exists only on the Gemini direct
path today; the other providers use the JSON-text fallback.

## Step 3 — OpenClaw (gateway)

```powershell
npm install -g openclaw@latest
openclaw --version
openclaw onboard --install-daemon
```

Onboarding prompts (pick these):
- **Quick Start**
- **Gemini first** — paste your key when asked (stored in the OS credential
  store / `~/.openclaw`, never in chat). **Ollama second.**
- **Gateway bind: 127.0.0.1 only** — refuse 0.0.0.0 if offered.

Verify: open http://localhost:18789/ — the dashboard loads and the gateway shows RUNNING.

On the VM, onboarding first failed because no Ollama model existed yet
(it tried to download `gemma4` and the pull stalled). **Pull the model first
(Step 1), then onboard.** On the laptop, with the model present, onboarding
completes in under a minute.

Then run the Phase 2 test:

```powershell
openclaw agent -m "List the files in your workspace, then read AGENT.md and tell me in 2 sentences what this agent is for. Do not change anything."
```

Pass mark: it lists the files and answers from AGENT.md. (On the VM this turn
could not complete — see `tests/job4-gateway-local.md` for the exact VM limit.
On a 16 GB laptop with qwen3:8b it should finish in 1–2 minutes.)

## Step 4 — goose (coding agent)

1. Install goose from https://github.com/block/goose/releases (Windows installer).
2. Configure it:

```powershell
goose configure
# Provider: ollama  ->  Model: qwen3:8b
# (or Provider: gemini, if your goose version offers it)
```

3. Run the first proof project (must pass before anything else):

```powershell
mkdir $HOME\personal-ai\projects\hello-proof; cd $HOME\personal-ai\projects\hello-proof
goose run --text "Create a small Node.js + Express + SQLite app with one page that says Hello, Ankush, and one API route /api/health that returns {ok:true}. Add a README, a .gitignore that ignores .env.local, and npm test that checks /api/health."
npm install; npm test
```

Pass mark: `npm test` passes, the app runs on localhost:3000,
`/api/health` returns `{"ok":true}`, and `.env.local` is git-ignored.
On the VM, goose with the tiny qwen3:0.6b model could not do this build
(see `tests/job5-goose-hello-proof.md`). qwen3:8b on the laptop is the
real coding brain; Gemini free tier is the fallback if Ollama is slow.

Note: in goose 1.59, `goose run` takes **no positional argument** — use
`goose run --text "..."` or `goose run -i file.txt`.

## Step 5 — the 5 real jobs (Phase 1 gate)

Before any cloud work, the laptop agent must pass 5 real jobs:
1. Summarise a file.
2. Draft an email from mailbox data (draft only — never send without Ankush's yes).
3. Web search + summarise.
4. Build a small project with goose and run its tests.
5. A job Ankush picks himself.

The first three already passed on the VM via Gemini (see `tests/job1-3`).
Jobs 4–5 must pass on the laptop.

## Phase 4 — phone (Telegram first) — NOT in this guide's script

Do this only after the 5 jobs pass on the laptop:
1. In Telegram, message **@BotFather**, `/newbot`, name it, copy the token.
2. `openclaw channels add telegram` and paste the token when asked.
3. Test: message the bot "What is in AGENT.md?" — it should answer.
4. WhatsApp comes **second, on a spare number only** (Baileys ban risk on a
   primary number). Do not link your main WhatsApp.

## Phases B–E — computer use, phone control, offline queue, routines (built 14 Nov 2026)

The app in `app/` now includes screen vision, desktop control, phone
control, browser use, the offline queue, sync, and routines — all $0, all
deny-first. The code is built and tested on the VM; the LIVE paths need
this laptop and your keys. Nothing here is a stub, but nothing here is
proven live until you run it below.

### B — Desktop control (Windows laptop)
1. In the app folder, `npm install` (pulls Express + Playwright), then
   `npx playwright install chromium` (browser use — one download, free).
2. Put your Gemini key in `app/.env.local` (`GEMINI_API_KEY=...`) — screen
   vision uses the same key. Groq/OpenAI/Anthropic keys are optional.
3. Start the app: `npm start` (http://127.0.0.1:3100).
4. In a SECOND PowerShell window, start the desktop agent:
   `node desktop-agent.js` (listens on 127.0.0.1:3101, same token).
   It shows an on-screen indicator while controlling the desktop, with a
   Freeze button. It refuses credential/OTP/admin prompts by rule.
5. Test: open the web UI → the screen loop runs via
   `POST /api/screen/loop {"task":"..."}`. Destructive acts need an
   approved approval id — create one in the UI first.
6. Prove it: run `bash tests/run-tests.sh` — the browser test needs no
   proxy on the laptop; external `goto` works there (it cannot on the VM).

### C — Phone control (Android)
1. Install Android platform-tools, enable USB debugging on the phone,
   connect it, authorise the laptop.
2. In the web UI or API: `POST /api/phone/enable` (30-min session) — the
   phone is only touched while a session is active, and freeze stops it.
3. iOS: no screen control exists (Apple restriction) — messaging only.
4. Telegram (phone-as-remote): put `TELEGRAM_BOT_TOKEN` in `.env.local`
   and restart the server — the bot polls automatically. Set
   `TELEGRAM_CHAT_ID` after the first message so only your chat is
   answered. WhatsApp: spare number ONLY, `WHATSAPP_ENABLED=yes` +
   `WHATSAPP_SPARE_NUMBER_CONFIRMED=yes` + `npm install
   @whiskeysockets/baileys` on the laptop, then scan the QR yourself.

### D — Offline queue + cloud sync
- The outbox is automatic: jobs that need the network queue in SQLite and
  drain when the connection returns. Watch it in the web UI (Queue panel).
- Cloud node: Oracle Always Free, same app, behind Tailscale. On the
  laptop set `SYNC_PEER_URL` + `SYNC_TOKEN` (the cloud node's ANKU_TOKEN)
  in `.env.local`. Sync is last-write-wins; conflicts surface in
  `GET /api/sync/conflicts`, never silently overwritten.

### E — Routines
- Create them in the web UI (Routines panel) or `POST /api/routines`:
  daily `HH:MM` + weekdays, or an interval in minutes (≥5). Dry-run first
  (`POST /api/routines/:id/run {"dry_run":true}`). A routine can never
  send, post, spend or delete — those become pending approvals.

## Product expansion — one-command setup, Settings, doctor (built 14 Nov 2026)

### One-command setup
From the repo root, instead of the manual steps above:
- Linux/macOS/WSL: `bash setup-app.sh` (add `--dry-run` to see the plan first; `--with-ollama-model` to also pull `qwen3:8b` — off by default).
- Windows PowerShell: `.\setup-app.ps1` (add `-DryRun` to see the plan first).
Both scripts check Node/npm, install app deps, install the Chromium browser binary, create `.env.local` if missing (never overwrite), and run the doctor. They never create accounts, never download a model by default, and never touch your keys. The Windows script has NOT been run on a real laptop yet — report any error it prints.

### Doctor — verify the install
`npm run doctor` (in `app/`) checks Node version, deps, the Chromium binary, whether a brain is available (a key present OR Ollama reachable — values are never shown), `.env.local` permissions, the database, ports, and optional pieces (ADB, desktop agent). Exit 1 if anything required fails.

### Settings — API keys, provider order, channels (web UI)
Open the web UI → **Settings**. Add/edit/remove a key per provider (Gemini, Groq, OpenAI, Anthropic, or a CUSTOM OpenAI-compatible endpoint: base URL + model + key), set the provider order, toggle fast routing, and set the Telegram/sync values. Changes apply immediately (no restart) and are written to `.env.local` (mode 600, git-ignored) by a validated writer. The **Test** button on each provider makes one real call and records the result; masked previews only (last 4 characters). Keys are never logged, never synced to the cloud node, and never committed — a pre-push hook scans for them before every push.
- **Never paste a key in chat** (web chat, Telegram, or WhatsApp). Telegram and WhatsApp REFUSE key-shaped messages and point you to Settings; chat history must never hold a key. Use `/providers` on Telegram to see status only.
- Where to get keys: see `docs/API-KEYS.md` — free sources verified 14 Nov 2026 (Gemini AI Studio, Groq, OpenRouter free models, Hugging Face, Ollama local = no key), plus the paid providers represented honestly and the custom-endpoint path.

### Replay log, notifications, sync status (web UI)
- **Replay:** every screen loop records a session — each step's screenshot + action + result + latency. Open a session to view its shots and re-run it with VERIFIED replay: the agent re-checks the screen before each step and stops at the first mismatch; destructive steps need a fresh approval. Delete a session to delete its screenshots too.
- **Notifications:** the agent can create local notifications (`notify` tool); read them in the Notifications panel.
- **Sync:** the Sync panel shows the peer URL (masked), last push/pull times, and conflict count.

### Customise by talking to the agent
Ask the agent (in chat) to change the app's behaviour — e.g. "add a notes search tool" or "make routines accept 'every Friday'". It edits repo code, runs the full test suite (`run_tests`), and reports what changed. It can never commit or push (git is read-only for it); you review the diff and commit. Safety gates (auth, allowlists, refusal rules) cannot be changed this way — see `docs/CUSTOMIZE.md`.

## Phase 5–6 — cloud (only after Phase 4 passes)

- Cloud = Oracle Cloud Always Free (2 AMD VMs) or a free-tier VPS. Only after
  5 real jobs pass on the laptop. No paid tier — Fly.io/Render paid tiers are
  NOT approved. Oracle account creation is Ankush-only (needs his email + card
  verification, even for the free tier).

## VM-only quirks (do NOT apply these on the laptop)

- `npm install -g openclaw` fails on the VM with an `EPERM chown` error on
  `node-edge-tts`. Workaround used: pnpm (`pnpm add -g openclaw`). On Windows,
  use the standard `npm install -g openclaw` first.
- `ollama pull` fails on the VM (egress proxy blocks Ollama's direct connection).
  Workaround: download the GGUF via curl from Hugging Face, `ollama create`.
- `/tmp` on the VM is a 512 MB tmpfs — use `~/workspace/.tmp` for big files.
- OpenClaw's base prompt is ~15,000 tokens. Its default context (32,768) is
  right for the laptop; on the VM we had to lower it to 16,384 and the 0.6b
  model still timed out. Do NOT lower the context on the laptop.
- `ollama run` with a prompt arg can hang waiting on stdin in scripts — use
  the API (`curl http://127.0.0.1:11434/api/generate`) or `ollama run ... < /dev/null`.

## What still needs Ankush

- Run this guide on his Windows laptop (Muse cannot reach it).
- His Gemini key (secure form only) and, later, a Groq key (free tier) if he wants the fallback. OpenAI / Anthropic keys are optional extras, only if he already has them — never required, never a paid signup for this project.
- Telegram bot token (Phase 4) — he creates it via @BotFather.
- A spare phone number for WhatsApp (Phase 4, later) — never his primary.
- Oracle Cloud account (Phase 6) — only after 5 laptop jobs pass.
- His yes before any GitHub push, any email send, or any application submission.
