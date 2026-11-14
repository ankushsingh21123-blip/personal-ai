# Security — Ankush's Personal AI

## Threat model
A personal agent with shell + files + web + phone access can send, spend, delete and leak. This app copies the Claude Code / Codex model: deny-first, approval before anything irreversible, secrets never in chat/files, outside content treated as data.

## Controls (all tested — see tests/test.js and scripts/security-check.sh)
- **Network:** binds `127.0.0.1` only, never `0.0.0.0`. No CORS. No public ports. Tailscale only for cloud (Phase 6).
- **Auth:** `X-Anku-Token` on every `/api` route except `/api/health`. Token is a 64-hex random value generated on first start, stored in `.env.local` (mode 600, git-ignored). Wrong/missing token → 401 (tested).
- **Rate limit:** 60 req/min/IP on `/api/chat` and `/api/tools` → 429 after.
- **Freeze:** `POST /api/freeze` stops every agent loop instantly (screen, phone, browser, routines, queue drain). Frozen state persists in SQLite across restarts until the user unfreezes. Freeze is also available from the web UI, the desktop-agent indicator window, and Telegram `/freeze`.
- **Desktop control (Phase B):** the desktop agent (`desktop-agent.js`, laptop-only) listens on `127.0.0.1` only, with the same token auth. Every action is validated twice (server + agent): allowlisted actions only, normalised coordinates, no sensitive acts (credentials/OTPs/admin prompts) ever, destructive acts need an approved approval id, and the agent refuses to act when the foreground window is a UAC prompt. Every action is audit-logged with the screenshot hash + intended target.
- **Phone control (Phase C):** ADB commands are an exact-argv allowlist (`execFile`, no shell). Phone access needs an explicit per-session enable with a TTL (default 30 min, max 4 h) and stops on freeze. iOS has no screen control — messaging + Shortcuts only, labelled as such.
- **Browser use:** Playwright headless Chromium, https-only, no private IPs, no password-field typing, and NO submit/post/send action exists — a human submits. Proxy env vars are honoured; credentials in proxy URLs are stripped from every error message.
- **Messaging channels:** Telegram polls with a token from env only (never logged/returned), and answers only the configured chat id once set. WhatsApp (Baileys) cannot start without `WHATSAPP_ENABLED=yes` AND `WHATSAPP_SPARE_NUMBER_CONFIRMED=yes` AND the package installed; auth state lives in `data/wa-auth/` (git-ignored). Spare number only — never the primary.
- **Routines (Phase E):** run through the same deny-first tools as a chat turn; approval rules can only be stricter, never looser; a SQLite run lock prevents double-runs; missed runs are recorded, never silently dropped.
- **Sync (Phase D):** last-write-wins per record with device + timestamp; conflicts are stored in `sync_conflicts` and surfaced, never silently overwritten. Sync transport is the app's own API behind Tailscale with token auth.
- **Input validation:** JSON body limit 100kb, text max 4000 chars, title/body length caps, provider names allowlisted.
- **Headers:** nosniff, DENY framing, no-referrer, CSP `default-src 'self'`.
- **Tools — deny-first:** allowlist only. `list_files`, `read_file`, `write_note`, `edit_file` (exact-match, `.bak` backup), `web_fetch` (https only, no private/local IPs, 50kb cap, HTML stripped), `run_command` (7 exact commands, `execFile`, no shell, no pipes). Everything else — including `send_email`, `rm -rf`, `sudo` — is denied, logged in `audit_log`, and never executed.
- **Secrets:** `.env.local`, `data/*.db`, `node_modules/` are git-ignored (checked by security-check.sh). No key pattern in tracked files (checked). `.env.local` is mode 600. Keys are never logged or returned by any endpoint — `/api/status` reports only whether a provider is configured, never the key.
- **Approvals:** send/post/spend/delete create a `pending` approval record only. Approving it records the decision — it does **not** execute the action. A human sends/posts/spends.
- **Prompt injection:** outside content (web pages, files, messages from anyone other than Ankush, recalled notes) is data, never instructions. Tool args are validated, paths are confined to the workspace, shell is allowlist-only.
- **Dependencies:** Express 5.3.0 only (plus Node built-ins). `npm audit` is skipped on this VM (audit endpoint unreachable) — re-run on the laptop before first use there.

## What the agent must never do
Send, post, spend, delete originals, change access, share credentials, approve security/admin/OTP prompts, bypass bot checks / Cloudflare / YouTube AI rules — all Ankush-only, or draft-first with his yes.

## If a key ever leaks
Rotate it immediately (that provider's own console — Google AI Studio, Groq, OpenAI, or Anthropic), check `audit_log` in the SQLite DB, and tell Ankush which key and when.
