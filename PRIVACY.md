# Privacy — Piplet, plain English

Piplet runs on your own devices. There is no account, no telemetry,
no analytics, and no tracking. This page says what stays on your machine,
what leaves it, and what you control. Last updated 14 Nov 2026.

## What stays on your machine

- **Your API keys and tokens.** They live in one file, `app/.env.local`,
  on the device where you entered them. That file is never committed to
  the repo, never synced to another device, never logged, and never
  shown back in full — the Settings page shows only the last 4
  characters. Keys are never accepted in chat, Telegram, or WhatsApp:
  a pasted key is refused, never stored, never forwarded.
- **Your screenshots.** Screen captures stay in `app/data/shots/` on the
  device that took them, except for one thing: the model call itself.
  When the agent needs to see the screen, the screenshot is sent to the
  AI provider you configured (Gemini, OpenAI, Anthropic, or your local
  Ollama) as part of that one request, so the model can decide the next
  action. Screenshots are never synced to the cloud node, never put in
  the repo, and are pruned to the latest 200. You can purge any session
  (screenshots included) from the Replay panel.
- **Your database.** Chat history, jobs, notes, approvals, the audit
  log, routines, and notifications live in a SQLite file on the device.
  Only four tables sync to another device you configured (see below).
- **Your clipboard.** Clipboard reads are capped, audit-logged by length
  only (never content), and never synced or stored anywhere except the
  agent's immediate reply when you asked for it.
- **WhatsApp auth state.** The Baileys session lives in `app/data/wa-auth/`
  on the laptop, git-ignored, and is never copied anywhere.

## What leaves the machine, and to where

| What | To where | When |
|---|---|---|
| Your prompt (+ recent chat + notes as context) | The AI provider(s) in your configured order (e.g. Google AI Studio, Groq, OpenAI, Anthropic), or your local Ollama (stays on-device) | Every chat turn, routine run, and queued brain call |
| A screenshot | The vision provider you configured, as part of one model call | Only during screen grounding (observe → decide → act) |
| A URL you asked to fetch | That website, as a normal page request | Only `web_fetch` / browser `goto` actions you or a routine asked for |
| Sync records (messages, jobs, notes, approvals only) | The sync peer URL you configured (your own cloud node) | Only when a sync push/pull runs, and only with your sync token |
| Telegram / WhatsApp messages | Telegram's / WhatsApp's servers, to your configured chat only | Only when you message the bot, or it replies to you |
| Nothing else | — | — |

There is no telemetry, no crash reporting, no analytics, no advertising
identifier, and no phone-home. The app makes no network request except
the ones in the table above, plus the ones you explicitly ask for.

## What the agent will never do

- Type a password, read an OTP, click a UAC/admin prompt, or confirm a
  payment. It stops and asks you to do it yourself.
- Send, post, spend, delete, or publish anything. Those intents become
  a pending approval (a draft). Approving records your decision — it
  still does not execute the act. You send it.
- Message anyone in bulk, or message anyone you did not configure.
- Read secret files (`.env`, `.ssh`, credentials, the database file
  itself) through its tools — those paths are denied in code.

## What you control

- **Freeze** — one button (web UI, Telegram `/freeze`, or the desktop
  indicator) stops every loop instantly. It survives restarts.
- **Keys** — add, replace, or remove any key in Settings. Removing a
  key deletes it from `.env.local` immediately.
- **Replay** — view every recorded screen session step by step, and
  purge any session (rows + screenshots) with one click.
- **Notifications** — a local inbox; nothing is pushed anywhere.
- **Channels** — Telegram and WhatsApp are off unless you configure
  them. WhatsApp requires an explicit spare-number confirmation and
  carries ban risk — your primary number must never be used.
- **Sync** — off unless you set a peer URL + token. Screenshots and
  keys never sync even when sync is on.
- **Your data** — everything is in `app/data/` and `app/.env.local`.
  Delete those and the agent forgets everything. No copy exists
  anywhere else unless you made one.

## For other users of this open-source project

The same rules apply to anyone who runs it: their keys, screenshots,
and data stay on their devices under the same code. Nothing in the
repo phones home, and the security checks (`bash app/scripts/security-check.sh`)
verify the git-ignored private paths, the secret scans, and the
loopback-only binding before every push.
