# Security — Ankush's Personal AI

## Threat model
A personal agent with shell + files + web + phone access can send, spend, delete and leak. This app copies the Claude Code / Codex model: deny-first, approval before anything irreversible, secrets never in chat/files, outside content treated as data.

## Controls (all tested — see tests/test.js and scripts/security-check.sh)
- **Network:** binds `127.0.0.1` only, never `0.0.0.0`. No CORS. No public ports. Tailscale only for cloud (Phase 6).
- **Auth:** `X-Anku-Token` on every `/api` route except `/api/health`. Token is a 64-hex random value generated on first start, stored in `.env.local` (mode 600, git-ignored). Wrong/missing token → 401 (tested).
- **Rate limit:** 60 req/min/IP on `/api/chat` and `/api/tools` → 429 after.
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
Rotate it immediately (Google AI Studio / Groq console), check `audit_log` in the SQLite DB, and tell Ankush which key and when.
