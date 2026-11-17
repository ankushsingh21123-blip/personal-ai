# Piplet — desktop app (Electron, Windows-first)

The desktop app is the same Piplet server, brain, tools, memory,
skills, approvals, freeze, routines, queue, replay and audit chain —
plus computer-use — wrapped in a native app window. One download, one
install, no terminal, no Node install needed to run it.

**Status (18 Nov 2026, branch `electron-app`):** built and verified
end-to-end on Linux (see "Verified" below). The Windows zip is built
but has NOT been run on Windows yet — the first Windows run is
Ankush's laptop step, with the checklist below. (The NSIS installer
can only be built on Windows or with wine; see "Build".)

## What runs where

| Piece | Where it runs |
|---|---|
| App window + tray + menus | Electron shell (`app/electron/main.js`) |
| Web UI (chat, Settings, approvals, audit, …) | Same `app/public/` frontend, served on loopback |
| Server, brain, tools, memory, skills, computer-use | Same `app/*.js` code, required in-process by the shell |
| SQLite database | OS user-data dir (below), same schema as `npm start` |
| Keys (`.env.local`) | OS user-data dir, mode 600 on Linux/macOS |
| Skills working copy | OS user-data dir `skills/` (copied once from the bundle; your approvals are never overwritten) |

The shell adds NO agent powers: it is a local UI host (window, tray,
single-instance lock, clean shutdown). The renderer is sandboxed with
context isolation and exactly one IPC channel (the session token, so
the UI never prompts for it). The window can only show the app's own
loopback UI; external links open in the system browser.

**Data locations** (Electron `userData`):

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Piplet\` |
| Linux | `~/.config/Piplet/` |

Inside: `data/personal-ai.db`, `data/shots/`, `.env.local`, `skills/`,
`app.log`. Deleting the folder resets the app completely (database,
keys, skills copy, log). Back up `.env.local` + `data/` before
deleting if you want to keep anything.

## Build (from this repo)

```bash
cd app
npm install            # pulls Electron + electron-builder (dev) + grammy
npm run electron       # dev run: app window, code from this checkout
npm run dist:linux     # AppImage + tar.gz  -> app/dist/
npm run dist:win       # NSIS installer + zip -> app/dist/ (needs Windows, or wine on Linux)
npm run dist:win-zip   # zip only (the wine-less Linux path to a Windows build)
npm run dist           # both (cross-builds Windows from Linux, unsigned; NSIS step needs wine)
```

**NSIS installers need `wine` on Linux.** electron-builder runs the
NSIS compiler under wine, and wine is not installed on the build VM
(and its Debian packages are unreachable from there). On Linux without
wine, `npm run dist:win` builds the zip, then fails at the NSIS step
with a clear `spawn wine ENOENT` error — use `npm run dist:win-zip`
for the zip alone. On Windows, `npm run dist:win` builds both. The
zip is a complete portable app: extract and run `Piplet.exe`, no
install step, same user-data locations as the installed app.

**No code signing ($0 rule).** The builds are unsigned — there is no
signing certificate. Consequences, honestly:

- **Windows:** SmartScreen shows "Windows protected your PC" on first
  run. Click **More info → Run anyway**. This is expected for unsigned
  software and goes away only with a paid certificate ($129+/yr) or
  Microsoft Store distribution (free individual registration, Store
  re-signs — a future step, needs Ankush's identity verification).
- **Windows builds made on Linux** skip exe branding
  (`signAndEditExecutable: false` in `app/package.json`): applying the
  custom icon + version metadata to `Piplet.exe` needs `wine`, which
  the build VM does not have. The zip build works fully; the
  `Piplet.exe` inside shows the default Electron icon, while the
  window and tray icons inside the running app are Piplet's own
  (loaded at runtime from `icon.png`). To ship a fully branded exe,
  build on Windows (`npm run dist:win` there) or install wine on the
  build machine and remove that flag.
- **Linux:** AppImage runs after `chmod +x`; no signing concept.
- **macOS:** not built. Would need a $99/yr Apple Developer account
  for a smooth install; unsigned macOS builds are a later decision.

## Install on the Windows laptop (Ankush's steps)

1. **Download** `Piplet-1.0.0-win.zip`, extract it anywhere (e.g.
   `C:\Users\Ankush\Piplet\`), and run `Piplet.exe` inside. No install
   step. (An NSIS installer exists as a build target, but it can only
   be built on Windows or with wine — see "Build" above. The zip and
   the installer run the identical app.) On the SmartScreen warning:
   **More info → Run anyway** (unsigned, see above). Pin `Piplet.exe`
   to Start / Taskbar if you want it always at hand.
2. **Launch Piplet.** The window opens on the chat UI. No token prompt
   appears — the app manages its own session token. Closing the window
   hides Piplet to the system tray (the agent keeps running: routines,
   queue, Telegram). **Quit** from the tray menu (right-click the tray
   icon → Quit Piplet).
3. **First chat.** Type in the chat box and send. With no keys set, the
   brain tries Gemini (no key → skipped) → Groq (no key → skipped) →
   Ollama local. If Ollama is not installed, the reply will fail with
   "brain failed" — that means step 4 or 5 is needed, not that the app
   is broken.
4. **Add a key (recommended):** Settings → paste your **Gemini API key**
   (free tier, from Google AI Studio) → Save. Keys are stored only in
   `%APPDATA%\Piplet\.env.local`, never synced, never logged. Never
   paste a key in chat. Groq (free tier) is the optional fallback key.
5. **Or install Ollama (local, no key):** download `OllamaSetup.exe`
   from https://ollama.com/download, run it, then in PowerShell:
   `ollama pull qwen3:8b`. Piplet talks to Ollama on
   `http://127.0.0.1:11434` automatically. (8 GB RAM minimum for 8b;
   use `qwen3:4b` on a tight machine.)
6. **Browser / computer-use (optional):** needs the Playwright Chromium
   browser binary once. Install Node.js LTS (https://nodejs.org), then
   in PowerShell: `npx playwright install chromium`. Piplet's browser
   sessions and computer-use then work. Desktop input on Windows uses
   the built-in CDP path where available; `xdotool`/`ydotool` are
   Linux-only and unproven on Windows — desktop control beyond the
   browser is best-effort until proven on the laptop.
7. **Telegram (optional):** in Telegram, message `@BotFather`,
   `/newbot`, copy the token. In Piplet Settings: paste the token, save,
   message your bot once, then set the numeric chat id in Settings.
   Until the chat id is set, the bot answers NOBODY (fail-closed).
   Transport can be switched to `grammy` in Settings (takes effect on
   restart); default `polling` works the same. WhatsApp stays
   **deferred** — no safe $0 ToS-clean path; do not link your main
   number.
8. **Desktop agent (optional, Windows desktop control):** the
   `desktop-agent.js` second process is NOT auto-started by the app in
   this version. Run it from a repo checkout per SETUP.md (Phases B–E)
   if you want full desktop control. The app's screen/browser APIs work
   without it; the agent adds OS-level input.

**Updating:** replace the extracted folder with a newer zip (or
re-run a newer installer) — the user-data folder (database, keys,
skills) lives outside the app folder and is untouched. There is no
auto-updater in this version; updates are manual.

**Uninstall:** delete the extracted folder. The `%APPDATA%\Piplet\`
data folder is left behind — delete it by hand for a full reset.

## Troubleshooting

- **App won't start / blank window:** open `%APPDATA%\Piplet\app.log`
  (or the tray menu → "Open app log") and read the last lines. The log
  holds the server output, including the port it picked.
- **"Brain failed" replies:** no provider answered. Check Settings:
  add a Gemini key (step 4) or install Ollama (step 5). Use the
  per-provider **Test** button to see which provider works.
- **Two Piplet icons / "already running":** the app is
  single-instance. A second launch focuses the running window instead
  of starting a second copy. Check the system tray.
- **Freeze:** the Freeze button (UI, tray menu, or `/freeze` on
  Telegram) stops every loop instantly and survives restarts.
  Unfreeze from the same places.
- **Port conflicts:** none expected — the shell picks a free loopback
  port on every launch, so the app never fights another copy or a dev
  server over port 3100.
- **Playwright / browser errors:** run `npx playwright install
  chromium` once (step 6). The app's doctor (`npm run doctor` in a
  repo checkout) checks for the browser binary.

## Verified (18 Nov 2026, rebased on main 2a2911a incl. computer-use)

- Full suite: **263/263** (`bash app/tests/run-tests.sh`)
- Security checks: **78/78** (`bash app/scripts/security-check.sh`;
  npm audit skipped — endpoint unreachable from the VM, re-run on
  the laptop)
- Eval harness: **23/23**, deterministic (`node app/scripts/run-eval.js`)
- Packaged Linux app, live under Xvfb
  (`node app/scripts/verify-electron-app.js`): **27/27** — window
  opens and renders, server auto-starts, session token generated,
  app.log written, real chat round-trip, tool call, memory write +
  recall, settings persist across restart, freeze blocks/unblocks,
  audit chain verifies, 5 skills approved, clean SIGTERM shutdown +
  restart on the same data. Re-run against the **extracted AppImage**:
  **27/27 again**.
- Windows zip: **built, contents verified** (`Piplet.exe` +
  `resources/app.asar` + `resources/skills/`), **not executed** (no
  Windows host on the build VM). NSIS installer: **blocked on wine**
  (see "Build" above) — build it on Windows. First Windows run is the
  laptop checklist above.

## Files

- `app/electron/main.js` — shell: window, tray, single instance, server
  lifecycle, shutdown, navigation guards.
- `app/electron/preload.js` — one-channel bridge (session token).
- `app/electron/paths.js` — user-data paths, free-port pick, skills
  copy-once (unit-tested, no Electron import).
- `app/electron/icon.png` / `icon.ico` — rendered from `app/public/logo.svg`.
- `app/scripts/verify-electron-app.js` — packaged-app E2E verifier.
- `app/telegram-core.js` — Telegram gating/commands shared by both
  transports; `app/telegram-grammy.js` — grammY poller.
- `app/package.json` → `"build"` — electron-builder config.
