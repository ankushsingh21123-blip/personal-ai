# Piplet — Channels, Apps & Design Research (18 Nov 2026)

Research-only phase. Public sources only, past → recent, with sources and
dates. Nothing here was built, signed up for, or paid for. $0 spent.
Licence claims are as reported by the cited sources — re-check each repo's
`LICENSE` file before depending on it commercially. This is not legal advice.

Companion document: `SYSTEM-DESIGN-V2.md` (target architecture + phased
build order). Current shipped architecture: `SYSTEM-DESIGN.md`.

Status of Piplet at research time: 155/155 tests, 35 security checks, 24
deny-first tools, hash-chained audit log, eval harness, multilingual UI
(English/Hindi/Telugu). Existing channel code: Telegram polling bot
(chat-locked, unit-tested, no live run) and WhatsApp Baileys guards only
(no package, no number). See `STATUS.md`.

---

## 1. Channels: WhatsApp + Telegram

### 1.1 Ranked recommendation

| Rank | Path | Verdict |
|---|---|---|
| 1 | Telegram via grammY (TypeScript) + long polling, owner-only allowlist | Ship first. Free, no verification, no per-message cost, works behind NAT, minutes to a working bot. |
| 2 | Telegram via python-telegram-bot | Only if the Telegram side is Python. Equally capable. |
| 3 | Telegram via Telegraf | Do not start new work on it. Works, but stale on Bot API versions. |
| — | WhatsApp | DEFER as a primary channel. No safe, $0, ToS-clean path for a general-purpose personal AI in India right now (see §1.3). |
| — | WhatsApp self-test only | Baileys on a **spare number only**, owner-only, low volume, Telegram fallback. Real ban/logout risk. Never the main personal number. |
| — | WhatsApp official (Cloud API) | Only later, with a registered business + verification + payment method + a fresh read of Meta §4.7. Not $0 beyond a small free allowance. |

### 1.2 Telegram — Bot API

**How it works.** A bot is created by chatting with `@BotFather`
(`/newbot`, display name + username ending in `bot`). BotFather returns a
token. No phone number is needed for the bot itself; a Telegram account
is needed to talk to BotFather. The token is a password: anyone holding
it controls the bot. Keep it in env/secret storage, never in a repo;
`/revoke` issues a new token and kills the old one immediately.

Inbound updates arrive by **long polling** (`getUpdates`, outbound-only,
works on a laptop/behind NAT, no domain needed) or **webhook** (`setWebhook`,
Telegram POSTs to a public HTTPS URL). They are mutually exclusive —
polling fails with 409 while a webhook is set, and two processes polling
one token fight each other. Webhooks need valid SSL and ports 443/80/88/
8443; a webhook secret-token header can reject forged requests. Pending
updates are held ~24h.

**A bot cannot start a conversation.** A user must message it first or add
it to a group. After that it can reply and send later messages to people
who started it. It cannot cold-message strangers from a phone-number
list. If blocked, sends fail — stop retrying. Bots never see messages
from other bots (loop prevention). Message text limit 4,096 chars —
split longer replies.

**Rate limits** (official Bots FAQ, crawled 17 Nov 2026): ~1 msg/second
per single chat (short bursts tolerated, then 429); max 20 msgs/minute
per group; ~30 msgs/second bulk across all chats, free. Paid broadcasts
(up to 1,000/second, 0.1 Telegram Stars per message over the free rate,
≥100,000 Stars balance + ≥100,000 MAU) are irrelevant for a solo agent.
Piplet implication: implement a send queue with 429 backoff and per-chat
delay; never send in a tight loop.

**Groups.** Privacy mode is ON by default: a privacy-mode bot in a group
only receives commands addressed to it, replies to its messages,
mentions, messages sent via it, and service messages — not general
chatter. It receives all group messages only if privacy mode is disabled
(`/setprivacy`) or it is a group admin; a privacy change applies only to
groups joined afterwards. Channels: bot must be admin to receive posts.
For a solo personal agent: leave privacy on, consider disabling group
adds entirely, require a mention in any group it joins.

**Libraries** (all talk to the same Bot API, so capabilities and rate
limits are identical — the difference is language, maintenance, docs,
licence):

| Library | Language | Licence | Notes |
|---|---|---|---|
| grammY (recommended) | TypeScript/JS, Node + Deno | MIT (reported second-hand — verify `LICENSE` in repo) | Middleware-based, official plugin ecosystem (sessions, conversations, menus, auto-retry, storage). Tracks new Bot API versions quickly. Used by OpenClaw and Hanzo Bot for Telegram. |
| Telegraf | TypeScript/JS, Node | MIT (GitHub API record) | Historically the Node default. READMEs found declare Bot API 6.0–6.9 support, several versions behind; Oct 2026 comparison reports no npm release in a long time. Fine to keep running; poor choice for new work. |
| python-telegram-bot | Python 3.10+, async | LGPLv3 (README/PyPI wording) | ConversationHandler, polling + webhook runners, ~29k stars, ~1M downloads/month (Aug 2026 guide). Applications merely using the library need not be LGPL, but check before bundling into a closed product. One Aug 2026 blog called it GPL-3.0; that appears wrong. |

None of the three ships an allowlist or approval system. Allowlisting by
chat/user ID, approval queues, and rate caps must be built as
middleware/filters in Piplet's own code, in front of the LLM (§1.4).

User-account automation (acting as a user, reading other chats) needs
MTProto/TDLib — a different stack with different ban risks. Out of scope,
not recommended.

### 1.3 WhatsApp — official vs unofficial

**A. Official: WhatsApp Business Platform / Cloud API (Meta).**
Meta-hosted API over the Graph API. Inbound by webhook, replies over
HTTPS. The old On-Premises API expired 23 Oct 2025 — Cloud API is now
the only official option.

- **Cost — India, rate card effective 1 Oct 2026 (before GST; 18% GST
  noted by secondary sources):** marketing ₹0.8631, utility ₹0.1150,
  authentication ₹0.1150, authentication-international ₹2.4971 per
  delivered message. Service (free-form) replies inside the 24h window:
  first 1,000/month per number free, then ₹0.1150 each. Per-message
  billing replaced per-conversation billing on 1 Jul 2025. No licence
  fee; inbound user-to-business messages are not charged. A solo user
  under 1,000 service replies/month sending no templates could be
  near-$0 on Meta fees, but that is not a $0 product path once
  templates, overage, hosting, and any BSP/platform fee are counted.
- **24-hour window:** opens when a user messages/calls; each new user
  message/call resets it to 24h. Inside: free-form text/media/buttons.
  Outside: only pre-approved **template messages** (Marketing / Utility /
  Authentication), submitted to Meta for review. Business-initiated
  contact needs the user's opt-in; every opt-out request must be
  honoured. Automated chats must offer prompt, clear escalation to a
  human (Business Messaging Policy, last updated 23 Sep 2026).
- **Approval/verification:** Meta business portfolio + WhatsApp Business
  Account + Meta developer app; a phone number that can receive an
  SMS/voice OTP and is not already registered on WhatsApp (must be
  deleted first, except a newer co-existence flow via Embedded Signup —
  details not fully verified); display-name review. **Business
  verification** (legal name + address/phone proof: incorporation/GST/
  PAN/Udyam/bank statement/utility bill, website, ideally a domain
  email; name must match documents exactly) typically takes 2–5 business
  days, sometimes up to 14. Sources conflict on whether any real-number
  sending is possible before verification; the safer reading is: test
  number first, verification planned before real use. Messaging limits
  start at 250 unique users/24h (business-initiated only), rising
  automatically to 2,000 / 10,000 / 100,000 / unlimited on quality +
  volume. Throughput ~80 msgs/second per number by default.
- **Free test tier:** test account + test number, no payment method,
  limited to 5 manually-added recipient numbers. Development only.
- **AI-Provider rule (§4.7) — the blocker.** Since 15 Jan 2026, Meta's
  WhatsApp Business Platform terms (§4.7, last modified 23 Sep 2026)
  prohibit AI providers offering a general-purpose assistant as the
  primary product via the official platform, with exceptions only for
  Italy/EEA, Brazil and Türkiye. India is not excepted. A business's own
  support agent (AI incidental to that business) is treated as allowed.
  Whether a solo self-hosted personal assistant counts as barred is NOT
  settled by any published Meta ruling found — Meta decides in its sole
  discretion. Do not assume the official path is available for Piplet
  until the current terms are re-read. Platform data (including derived/
  aggregate forms) may not be used to create/train/improve AI systems,
  with a narrow exception for a business fine-tuning a model for its
  exclusive use.

**B. Unofficial: Baileys and whatsapp-web.js.** Both impersonate
WhatsApp Web as a linked device. Both are free code. Neither is
sanctioned by Meta. Architecture does not grant ban immunity; behaviour
matters more than library choice.

| Library | How it works | Licence | Notes |
|---|---|---|---|
| Baileys (`@whiskeysockets/baileys`) | TypeScript, speaks the WhatsApp Web multi-device protocol directly over WebSocket. No browser. Light (~50MB RAM class, sub-second start), suited to servers/many sessions. Actively pushed (last push 1 Nov 2026; ~11.6k stars). Mid-2026: 6.7.x stable, 7.x in RC with breaking changes — pin an exact version, re-check before adopting. | MIT for Baileys itself, with a wrinkle: its `libsignal` dependency is GPLv3; maintainers state they are migrating to a Rust replacement. Check the dependency tree before closed distribution. | Auth: QR scan or 8-digit pairing code from Linked Devices. Session credentials persist in auth-state files; the app must save credentials on every update. README disclaimer: not affiliated with WhatsApp; maintainers do not condone ToS-violating use, discourage stalkerware/bulk/automated messaging. |
| whatsapp-web.js | JavaScript driving a real headless Chromium running WhatsApp Web via Puppeteer, calling the web client's internal functions. Near-full web-client parity; ~22k stars; Node 18+. | Apache-2.0 (README/docs) | Cost: a full browser per session (hundreds of MB RAM, seconds to start), fragile to WhatsApp Web changes. README is blunt: WhatsApp does not allow bots or unofficial clients, blocking cannot be ruled out, not totally safe. |

**Ban risk — honestly.**

- WhatsApp's ToS prohibit bulk/auto-messaging and auto-dialing, creating
  accounts by unauthorised/automated means, and reverse-engineering or
  building substantially-similar software. WhatsApp may suspend/terminate
  access at any time. Its Help Center says using an unofficial app can
  lead to a temporary ban and then a permanent one.
- Escalation: (1) *Restricted* — temporary limits, user reports cite
  ~6–24h after bursts; (2) *Temporarily banned* — in-app notice with a
  timer; continuing can make it permanent; (3) *Banned* — the number
  cannot use WhatsApp at all; appeal only via in-app "Request a review"
  (or Business Support Home for API numbers). Only WhatsApp can lift a
  ban; no vendor can unban for a fee. Reviews are described as mostly
  completed within 24h, but treat a ban as losing the number and its
  conversations.
- Most-reported triggers: cold outbound to strangers, fresh numbers
  automating on day one, machine-speed sending without human-like gaps,
  high block/report rates, multiple simultaneous sessions. WhatsApp
  publishes NO thresholds and NO ban-rate data — any "safe X messages/
  day" figure is folklore. One vendor analysis claiming 68% of 600+
  Indian SMB accounts using unofficial tools were banned within 12
  months is a single commercial source; treat as weak evidence.
- **Logout ≠ ban.** A dropped session with the phone app opening
  normally is usually just a session loss; a restricted/banned notice
  *in the phone app* is enforcement. Distinguish them before panicking.
- Session behaviour (Baileys official wiki, updated 19 May 2026):
  Baileys does not auto-reconnect — the app must handle it. A `401 /
  loggedOut` close means the session was revoked and reconnecting loops
  forever; delete auth state and scan a fresh QR. Other disconnect
  reasons are safe to retry. Malformed chat-state updates can log out
  *all* linked devices. Secondary guides add: WhatsApp logs out all
  linked devices if the primary phone goes unused ~14 days, and drops an
  idle linked device after ~30 days — plausible, exact thresholds NOT
  verified in official docs. QR codes expire quickly and regenerate;
  repeated unscanned QRs look bot-like.
- Practical rule used by public agent projects (e.g. OpenClaw): keep
  volume low, never bulk/unsolicited, use a secondary number, keep
  Telegram as fallback. OpenClaw's docs warn Meta has banned numbers
  for automated use and users report bans and unstable sessions.

### 1.4 Credentials checklist

| Path | What Ankush must supply/do |
|---|---|
| Telegram (any library) | Telegram account; chat with `@BotFather`, `/newbot`; paste token into env/secret store; message the bot once (`/start`); owner numeric chat/user ID for the allowlist. No phone number for the bot, no verification, no payment. Optional: `/setjoingroups` off, privacy mode left on, `/setcommands`. Revoke via `/revoke` if leaked. Polling needs no domain; webhook needs public HTTPS + cert. |
| WhatsApp Cloud API | Meta/Facebook account; developer registration; business portfolio; WhatsApp Business Account; Meta app with WhatsApp product; dedicated phone number + SMS/voice OTP; business-verification documents; payment method for real use; webhook HTTPS endpoint + verify token; system-user/permanent access token; approved templates for outbound-outside-window. Test number first (5 recipients, no payment). Re-read §4.7 before building. |
| Baileys | A phone with WhatsApp on the chosen number; QR scan or pairing code from Linked Devices; persistent auth-state storage on the server; server with outbound WebSocket access. Spare number only. Expect periodic re-scans. Never commit auth state. |
| whatsapp-web.js | Same phone + QR scan; server able to run headless Chromium; persistent session storage. Same spare-number warning, plus browser resource cost. |

**Viable for a solo $0 build in India:** Telegram — fully. Baileys —
$0 cash, viable only as a self-test on a spare number with accepted
risk. Cloud API — viable for development on the test number at $0;
production needs business docs, a spare number, payment, and a §4.7
decision.

### 1.5 Deny-first safety patterns (from public open-source agents)

None of the messaging libraries enforces these — they are patterns to
build in Piplet's gateway layer, BEFORE the model sees input or any send
executes:

1. **Allowlist at the gateway, deterministically.** OpenClaw (docs
   checked against v2026.10.4, 18 Oct 2026) checks sender/channel
   allowlists before a message reaches the agent: unknown senders are
   dropped and logged, never shown to the model. DM policies: `pairing`
   (default), `allowlist`, `open`, `disabled`; group policy defaults to
   `allowlist` (fail-closed). For Piplet: default-deny, owner numeric
   ID(s) only; groups need an explicit group allowlist + sender
   allowlist + mention requirement.
2. **Pairing / approval for new people, never auto-trust.** OpenClaw
   pairing: unknown sender gets a 6-digit code expiring in 1 hour (max 3
   pending per channel account); the owner approves from CLI. Pairing
   for DMs does not grant group access. Owner powers are separate from
   merely being allowed to chat. Piplet equivalent: unknown chat → no
   reply, no tool access, queued pairing request to the owner only.
3. **Approval queue for every irreversible action.** LangGraph/LangChain
   human-in-the-loop: `interrupt()` / `interrupt_before` pauses
   execution, checkpoints state, resumes only on explicit approve/
   reject/edit. Stronger pattern from HITL guides: durable approval
   queue storing the *exact* payload + context + reasoning, payload
   cryptographically locked (e.g. HMAC) between approval and execution
   so it cannot mutate, executor runs only the locked payload, every
   tool call in a chain gated. Apply to: any outbound message to a
   non-owner, any spend, any delete/mutation, any send outside an
   existing approved conversation.
4. **Never auto-send to new chats; rate-limit everything.** OpenClaw
   bot-loop protection (~20 events/60s per bot pair + cooldown).
   Per-recipient cooldowns, per-chat send caps, burst limits, 429
   backoff, human-like pacing on WhatsApp, global kill switch. Treat
   quoted/forwarded content and group history as untrusted input
   (prompt injection via other people's messages is explicitly called
   out in OpenClaw's security docs).
5. **Tool scoping per sender/channel.** OpenClaw tool profiles
   (`minimal`/`coding`/`messaging`/`full`), sender-scoped tools,
   exec-approval toggles: a group mention from a non-owner must never
   inherit the owner's shell/file tools. Piplet: owner DM = full (still
   approval-gated for irreversible acts); any other chat = read-only/
   answer-only or nothing.
6. **Secrets + audit.** Tokens in env/secret storage, git-ignored auth
   state, revoke-and-rotate procedure documented, every allow/deny/
   approval/send logged with sender, chat, payload hash, decider.
   Webhook secret-token validation on Telegram; signed/verified
   webhooks on WhatsApp Cloud API.

Sources §1: Telegram Bots FAQ (official), crawled 17 Nov 2026,
core.telegram.org/bots/faq; grammY comparison docs, crawled 17 Nov 2026,
grammy.dev/resources/comparison; Baileys troubleshooting wiki, updated
19 May 2026, baileys.wiki; Square Cloud Telegram library comparison, Oct
2026; python-telegram-bot README/PyPI (LGPLv3), Nov 2026; Telegraf GitHub
API record (MIT); WhatsApp India pricing summaries of Meta 1 Oct 2026
card (chatmitra.com, sharprays.com, reputoo.com), Sep–Nov 2026; WhatsApp
24h window/templates, bulsulabs.com, 5 Nov 2026; WhatsApp verification/
setup India, codingclave.com, 29 Oct 2026; Meta §4.7 analyses, Oct 2026
(vectalk.com.br, infiq.in, autoesta.com); Baileys guide, 18 Jun 2026;
Baileys vs whatsapp-web.js vs Cloud API, squarecloud.app, 22 Oct 2026;
whatsapp-web.js docs (Apache-2.0 + ban disclaimer), docs.wwebjs.dev;
ban explainer, wasender.dev, 29 Oct 2026; OpenClaw channel docs
(clawdocs.org, v2026.10.4) + group-chat safety guides; LangGraph HITL
patterns (openlegion.ai, agentnative.dev).

---

## 2. Apps: desktop + phone/tablet

Key framing: Piplet already has Node/Express + SQLite + web frontend,
and its ambition includes screen/phone/browser control, routines and an
offline queue. A PWA can be a companion/control UI, but it cannot be the
agent host that controls a machine.

### 2.1 Ranked recommendations

**Desktop (as the Piplet host):**
1. **Electron** — reuses the most existing code; screen capture, global
   shortcuts, tray, autostart and full Node/SQLite access built in.
   Penalty is size/memory.
2. **Tauri 2** — far smaller/lighter, more secure by default, plus
   iOS/Android from one codebase, but the backend must be rewritten in
   Rust or bundled as a Node sidecar (which erases much of the size
   win). Best as a later rewrite, not the first desktop build for a
   solo JS/TS dev.
3. **PWA (installed web app)** — $0, instant distribution, 100%
   frontend reuse, but no global shortcuts, no reliable autostart/
   background agent work, no silent screen capture/control, only
   picker-gated, Chromium-only file access. Excellent companion, not a
   desktop agent host.

**Phone/tablet (as the Piplet companion first):**
1. **PWA first, then React Native (Expo)** when native-only features
   are needed — PWA ships today for $0; React Native is the
   lowest-learning-curve native step for a JS/TS dev.
2. **React Native / Expo** — MIT, TypeScript, reuses API client/logic/
   types, full camera/files/share-sheet/SQLite via native modules, free
   push via FCM/APNs/Expo Push.
3. **PWA/TWA as the store app** — credible on Android via Trusted Web
   Activity; not credible as a full iOS store app (no official PWA path,
   thin wrappers risk App Store Guideline 4.2 rejection). iOS PWA =
   Home Screen install only.
4. **Flutter** — strong framework, but last for this dev: new Dart
   language + widget model, least reuse of existing TS/React code.
   Choose only for a fresh, pixel-identical UI across mobile + desktop.

### 2.2 Desktop comparison

| | Electron | Tauri 2 | PWA (installed) |
|---|---|---|---|
| Licence | MIT | MIT / Apache-2.0 (dual) | None — web standards |
| Language / backend | JS/TS + Node.js, bundled Chromium | JS/TS frontend + Rust core, OS WebView | JS/TS in browser |
| Typical bundle | ~80–200 MB; minimal ~85–150 MB | ~2–10 MB; minimal ~3 MB | No download; web bundle + browser cache |
| Idle memory (empty/small app) | ~85–300 MB across sources; real apps 280–400 MB resident in one Nov 2026 benchmark roundup | ~30–110 MB idle; real apps ~95–170 MB resident | Browser-tab memory |
| Cold startup | ~1–2 s (one careful benchmark: 1.0–1.4 s) | ~0.2–0.7 s; under 0.5 s commonly quoted | Browser launch + page load |
| Warm startup | ~250–300 ms in one benchmark | ~250–310 ms — gap largely disappears warm | N/A |
| Files | Full Node `fs`, arbitrary paths (with OS permissions) | `fs` plugin, capability-scoped; default app-data folders only, wider access must be explicitly allowed | File System Access API Chromium-only; picker-based; no arbitrary access |
| Screen capture | Built-in `desktopCapturer` + `getUserMedia` | No official screen-capture plugin found; needs Rust crates / native code + OS permission | `getDisplayMedia` only with user picker/gesture; cannot capture silently or control |
| Screen/keyboard control | Possible via Node native modules + OS Accessibility permissions; not built-in | Possible via Rust crates such as `enigo`; needs Accessibility permissions; not built-in | No |
| Notifications | Built-in `Notification`, tray, click/actions | `notification` plugin (all 5 platforms) | Web Push + Notifications API; iOS only after Home Screen install (16.4+) |
| Autostart | Login-item APIs (widely documented; not confirmed from an official doc snippet in this pass) | `autostart` plugin, desktop only | Windows/Edge: user can tick auto-start at install; not reliable cross-platform agent autostart |
| Global shortcuts | Built-in `globalShortcut`, works unfocused; conflicts fail silently; macOS may need Accessibility permission | `global-shortcut` plugin, desktop only | No |
| Tray / menu-bar | Built-in `Tray` | Via plugins/window APIs; tray support exists in Tauri ecosystem (not separately verified) | No |
| Auto-update (free) | `update.electronjs.org` for public GitHub repos + GitHub Releases (macOS builds must be signed); or `electron-updater` + electron-builder via GitHub Releases/S3/static host. Built-in `autoUpdater` is Windows/macOS only, no Linux | `updater` plugin, Windows/macOS/Linux (AppImage); signature verification mandatory; `latest.json` via GitHub Releases using `tauri-action` | Redeploy the site; service worker updates |
| Well-known apps | VS Code, Slack, Discord, Figma desktop, Notion, Linear, Postman, WhatsApp Desktop, Spotify, Signal, Claude desktop, AnythingLLM, Cherry Studio | Jan, Hoppscotch (reported 165 MB → 8 MB migration), GitButler, Spacedrive, AppFlowy, Clash Verge, Modrinth App | Twitter Lite/X, Starbucks ordering, Pinterest mobile web, Uber m.uber.com, Flipkart Lite, MakeMyTrip — mostly 2017–2021 case studies; live behaviour today not re-verified |
| Maturity | Largest ecosystem, most production proof | Stable since Oct 2024 (v2), 2.11 line mid-2026; desktop production-ready per multiple 2026 reviews; mobile newer | Mature web platform; capability varies sharply by browser/OS, iOS narrowest |

Notes: empty-app benchmarks exaggerate the gap — once a real React
frontend loads, the memory gap narrows to roughly 1.2–3× rather than
10× (Nov 2026 Arg0 benchmark roundup). Bundle/download size is the one
gap with no debate: roughly 10–25× smaller for Tauri. Tauri uses
WebView2 (Windows), WKWebView (macOS/iOS), WebKitGTK (Linux), so
rendering can differ per OS; Electron ships the same Chromium
everywhere. Tauri requires Rust for backend logic; first Rust builds
are slow (tens of seconds to minutes cold). For a solo JS/TS dev with a
working Express backend, that is the main Tauri cost, not price ($0).

### 2.3 Phone/tablet comparison

| | React Native (+ Expo) | Flutter | PWA / TWA |
|---|---|---|---|
| Licence | MIT (React Native + Expo) | BSD-3-Clause | None — web standards; TWA tooling is Google's Bubblewrap/PWABuilder |
| Language | JavaScript/TypeScript + React | Dart + Flutter widgets | JS/TS + existing web frontend |
| Learning curve for JS/TS dev | Low–medium; React transfers directly; official docs steer new projects to Expo | Moderate–high; Dart reads like TypeScript but is niche (5.9% vs 66% JS / 43.6% TS in 2025 Stack Overflow survey, as quoted Oct 2026); typically 2–4 weeks to comfort per one 2026 comparison | None — same codebase |
| Platforms | iOS + Android core; web/TV via Expo; Windows/macOS via Microsoft's RN | iOS, Android, web, Windows, macOS, Linux | Every browser; Android store via TWA; iOS Home Screen only; Microsoft Store accepts PWAs |
| Camera / files / share sheet | Full, via Expo modules / native libraries, with OS permission flows | Full, via first-party/community plugins (`camera`, `file_picker`, `share_plus`) | Camera via `getUserMedia`/file input; share via Web Share API + share-target manifest; file access picker-gated, Chromium-strongest, iOS weakest |
| Offline | Full offline with local SQLite (`expo-sqlite`), AsyncStorage, sync-on-reconnect logic you write | Full offline with `sqflite`/Drift, sync logic you write | Service worker + Cache API + IndexedDB; works offline after first load; iOS has no Background Sync — queued work must send while app is open; storage eviction risk under pressure (exact iOS behaviour disputed — see §5) |
| Push (free) | FCM + APNs free delivery; Expo Push free (600/sec/project cap quoted); needs store memberships | FCM + APNs free delivery | Web Push free via own server; Android full; iOS 16.4+ only after Home Screen install, visible notifications only |
| Background work | Native background tasks/fetch, with OS limits | Native background tasks, with OS limits | Heavily constrained; Background/Periodic Sync Chromium-only heuristics, absent on iOS; cannot run arbitrary work while closed |
| Phone control / automation | No framework gives general control of other apps; Accessibility/automation APIs restricted and store-policy-sensitive | Same restriction | Same restriction, plus browser sandbox |
| App size | Not verified — no reliable current typical APK/IPA figures found | Not verified (same) | Smallest: no native binary except the TWA shell (Android) |

**Store fees** (corroborated by multiple Oct–Nov 2026 secondary summaries
quoting official pages; re-check at enrolment — official fee pages were
not fetched directly in this pass):
- **Apple Developer Program: $99 USD/year** (individual or organisation;
  Enterprise $299/yr separate). Fee waivers only for eligible
  nonprofits/accredited schools/government — not individuals. Needed
  for App Store, TestFlight, and macOS Developer ID signing/
  notarisation.
- **Google Play Console: $25 USD one-time**, no annual renewal, no
  per-app charge. Must be 18+; prepaid cards not accepted; fee
  non-refundable if identity/card data is invalid. New personal
  accounts created after 13 Nov 2023 must run a closed test with ≥12
  opted-in testers for 14 continuous days before production access;
  organisation accounts are exempt.

**TWA specifics:** a TWA is real Chrome running the PWA fullscreen, not
a WebView — service worker, storage, cookies and push behave as on the
web. Requires HTTPS + manifest + service worker, a Digital Asset Links
file at `/.well-known/assetlinks.json`, and Bubblewrap or PWABuilder.
Gotcha: Play App Signing re-signs the bundle, so the SHA-256 fingerprint
in `assetlinks.json` must be Google's signing key, not the upload key,
or users see a URL bar. Requires Chrome 72+; falls back to a Custom Tab
without a supported browser. Digital goods sold in a Play-distributed
TWA must use Google Play Billing (via Digital Goods API).

**Apple wrapper warning:** Apple has no official PWA-to-App-Store
route. A native shell that only loads a website is liable to rejection
under Guideline 4.2 (minimum functionality); reviewers look for real
app behaviour beyond what mobile Safari does.

### 2.4 Code reuse from Node/Express + SQLite (most → least)

1. **PWA:** frontend reused as-is; backend stays a server. Add manifest
   + service worker + offline cache/queue. No rewrite.
2. **Electron:** frontend reused as-is; Express backend runs in the
   main process or as a local server; SQLite file stays local with a
   Node SQLite driver. New code is mainly the shell (window, tray,
   shortcuts, updater, IPC/preload bridge). This is why Electron wins
   for Piplet v1 desktop despite its size.
3. **React Native:** UI must be rebuilt in React Native components
   (React/TS knowledge transfers, DOM/CSS does not); business logic,
   API client, types, validation and queue/sync logic can be shared.
   Backend stays an API; phone-side SQLite is a separate local store
   needing sync design — not the same database file as the desktop.
4. **Tauri:** frontend reused as-is; backend must be rewritten as Rust
   commands + plugins (e.g. `tauri-plugin-sql` with SQLite via `sqlx`),
   OR the Express app bundled as a sidecar binary (Tauri docs: sidecars
   must be self-contained; a Node app needs a stock Node binary + JS as
   a resource, or a compiled standalone binary via a packager such as
   `pkg`). The sidecar route preserves Express code but adds
   per-architecture binaries, process management, port/socket handling,
   and largely defeats Tauri's size advantage. One production example
   (sqlui-native) does exactly this: Tauri v2 + Node.js sidecar.
5. **Flutter:** least reuse — Dart rewrite of UI and logic; only the
   HTTP API contract and SQLite schema concepts transfer.

### 2.5 Free tooling for building/signing/distributing — honest limits

**Code signing (the real $0 breaker):**
- **macOS:** $99/yr Apple Developer Program is the only route to a
  Developer ID certificate for distribution outside the App Store;
  notarisation required for Developer ID software built after 1 Jun
  2019 (macOS 10.15+). No cheaper legitimate alternative found.
- **Windows (outside the Store):** cheapest reputable 1-year prices
  found, checked Oct–Nov 2026: SSL.com OV $129/yr, EV $349/yr; other
  vendors quoted $219–$715/yr OV and $287–$972/yr EV depending on
  source/term. Since Jun 2023 private keys must live on FIPS 140-2
  Level 2 hardware / HSM / cloud HSM (USB token sometimes included,
  sometimes ~$379 extra — check the SKU). Since 1 Mar 2026,
  certificates last at most 460 days. Since 2024, EV no longer
  bypasses SmartScreen on first download — both OV and EV build
  reputation over time; EV is reported to build it faster, not
  instantly. Re-check before buying.
- **Azure Artifact Signing (formerly Trusted Signing):** $9.99/month,
  5,000 signatures included then $0.005 each, no hardware token,
  CI-friendly — but eligibility was reported as restricted (originally
  US/Canadian/EU/UK businesses with 3+ years' history; 2025 expansion
  to individual developers in US/Canada). **India eligibility NOT
  verified** — do not assume Ankush qualifies.
- **Microsoft Store (the $0 Windows path):** individual developer
  registration is free worldwide (fee removed Sept 2025; Microsoft
  Learn confirms no registration fees for either account type via the
  new onboarding flow). Store re-signs MSIX packages, hosts binaries
  and handles updates at $0. Identity verification (government ID +
  selfie) is required. Recommended $0 Windows distribution route; does
  not help macOS or direct-download distribution.
- **SignPath Foundation:** reported to offer free OV-level signing for
  qualifying open-source projects via managed CI. Eligibility and
  current availability **not verified** — check before relying on it.
- **Unsigned shipping:** possible on both desktop OSes; users see
  SmartScreen/Gatekeeper warnings and must explicitly bypass. One indie
  report (Crawlix, 2026) estimated 15–25% download loss — single-source
  anecdote, not a verified benchmark.

**GitHub Actions (builds):** public repos — standard GitHub-hosted
runners free and unlimited (no minute cap). Private repos on GitHub
Free: $12/month of included compute (≈2,000 standard Linux minutes;
3,000 on Pro/Team, 50,000 on Enterprise Cloud); 500 MB artifact/package
storage on Free. Overage rates quoted Sept–Oct 2026: Linux $0.006/min,
Windows $0.010/min, macOS $0.062/min. Free-tier concurrency: 20 jobs,
max 5 macOS. Larger/GPU runners always billed, even on public repos.
Self-hosted runners free of per-minute GitHub charges (a planned
$0.002/min charge announced Dec 2025 was postponed, had not taken
effect in sources checked Sept–Oct 2026). Keep the Piplet repo public
for builds if acceptable, or budget the $12 allowance carefully for
macOS builds. GitHub Releases hosting for installers/updater feeds is
free within normal repo limits (release-asset limits not verified).

**Expo / EAS (React Native builds):** Expo SDK/CLI/Expo Go are MIT and
free; local builds always free but iOS local builds need a Mac + Xcode.
EAS Free plan: 15 Android + 15 iOS cloud builds/month, 1 concurrent
build, 45-min timeout, low-priority queue (Expo warns of 90+ min waits
at peak), OTA updates to 1,000 MAU. Paid: Starter $19/mo, Production
$199/mo. EAS cloud builds are the $0 way to build iOS without owning a
Mac, within the free quota. Codemagic free tier (500 Mac mini M2
minutes/month) mentioned in one Oct 2026 comparison only — not
independently verified.

Other free tooling: `electron-builder` / Electron Forge, Tauri CLI +
`tauri-action`, Bubblewrap, PWABuilder — all $0 open-source tooling.
PWA distribution needs only HTTPS hosting. Push delivery via FCM/APNs/
Web Push is $0; the server storing tokens and sending messages is the
builder's own hosting cost.

**What no phase gives for free:** true "control my phone/computer"
automation. Desktop automation needs per-OS Accessibility/screen-
recording permissions and user consent; phone automation is sandbox-
and policy-limited on iOS and Android. Budget permission UX + policy
checks as their own workstream; do not promise phone control from a
PWA/TWA.

Sources §2: devtoolpicks.com Tauri vs Electron (3 Jul 2026); arg0.app
benchmark roundup (10 Nov 2026); Tauri plugins-workspace README + plugin
docs; Electron docs (keyboard shortcuts, tray); Apple fee summaries
(appranker.net, superapp.dev 12 Oct 2026); Google fee + 12-tester gate
(magora-systems.com 13 Oct 2026, ontesters.com 10 Oct 2026); signing
costs (dawloom.com 13 Oct 2026, crawlix.app); Microsoft Store free
(learn.microsoft.com, betanews 12 Sep 2025); auto-update strategies
(dawloom.com 7 Nov 2026); PWA capabilities (learn.microsoft.com,
progressivewebapps.com Sept 2026, wavxsolutions.in 2 Oct 2026); TWA
(dev.to/markusbnet 21 May 2026); React Native vs Flutter comparisons
(2026); GitHub Actions pricing (macrostack.net 14 Oct 2026, latchkey.dev
12 Nov 2026); EAS pricing (dawloom.com 13 Oct / 7 Nov 2026).

---

## 3. Frontend design that feels human-made

### 3.1 Ranked stack recommendation

1. **Pick this:** React + Next.js + Tailwind CSS v4 + shadcn/ui (Base UI
   default) + Lucide + Motion (CSS first) + Recharts via shadcn/ui
   charts + self-hosted variable fonts via Fontsource. All $0 /
   permissive licences; you own the copied component source so you can
   de-genericise it; accessibility behaviour comes from the primitives;
   fits Ankush's existing React/Next.js/Tailwind stack. The warmth must
   come from *your* tokens, type pairing, copy and details — the
   default shadcn look on its own is now a convergence tell.
2. **If Piplet needs a fully custom design system:** Tailwind v4 +
   Radix Primitives or Base UI directly (no shadcn skin), same
   fonts/icons/motion. More work, more distinctiveness, full control
   over radius/border/shadow/colour.
3. **If multi-framework matters later:** Ark UI (React/Vue/Solid,
   state-machine based) instead of Radix/Base UI. Do not pick this just
   for Piplet web alone — smaller ecosystem than shadcn/Base UI in 2026
   sources.

**Avoid as the base:** MUI / Ant Design (heavy, instantly recognisable,
paid tiers for advanced MUI X); GitHub Primer or Shopify Polaris as the
visual base (brand-tied / admin-tied — study them, don't wear them);
Tailwind Plus (paid, new sign-ups closed per Sept 2026 reporting);
Highcharts (paid for commercial use) and ApexCharts (dual licence).

Note: Piplet's current frontend is dependency-free vanilla JS
(`app/public/`). Adopting the React/Next.js stack is a rewrite decision
for a later phase (see SYSTEM-DESIGN-V2.md), not a drop-in change. The
principles in §3.2 apply to any stack, including the current one.

### 3.2 Principles: human/crafted vs AI-generic

The strongest public framing found is Anthropic's `frontend-design`
skill (public repo `anthropics/skills`, SKILL.md commit `dbd4588`,
9 Oct 2026, Apache 2.0) and secondary write-ups of it. Core idea, in
our words: AI output converges on the most common patterns in training
data, so distinctiveness has to be *planned* before building — a short
design plan (palette, type roles, layout concept, principles) reviewed
against the brief for generic defaults.

**Five default looks to avoid** (per Anthropic skill summaries, Oct
2026): (a) warm cream + high-contrast serif + terracotta accent;
(b) near-black + one acid-bright accent; (c) broadsheet hairline /
zero-radius newspaper layout; (d) identical rounded SaaS cards with one
radius and one soft shadow plus gradient washes; (e) template chrome —
tracked-out ALL-CAPS eyebrows over every heading, middle-dot meta
strings, mono labels everywhere, an arrow on every link. A brief that
explicitly asks for one of these wins; otherwise don't spend free
choices on them. Related convergence analysis names Inter/Roboto,
purple gradients on white, predictable hero → features → CTA, minimal
animation; advice: take a strong position on axes like density, warmth,
and expressiveness — "the middle is the worst place to be."

**Concrete principles:**

1. **One coherent idea per screen.** One focal point, one primary
   action. Typography, colour, material and motion support the same
   thesis. One strong authored moment over many unrelated effects.
   Deliberate contrast/asymmetry beats neutralised "cleanliness."
2. **Typography carries personality.** One family, or two clearly
   distinct. Choose deliberately, not the default you'd reach for on
   any project. Clear type scale with intentional weight/width/spacing.
   Default line length under ~80 characters; serif body gets slightly
   more line-height than sans. Avoid: accenting a single headline word
   in a different colour/italic, ALL-CAPS labels as a default,
   unnecessary eyebrow labels above content.
3. **Spacing = rhythm, not decoration.** Token scale (8pt base, 4pt
   half-step), fewer values, used consistently. Proximity before
   containers: related items sit closer than unrelated items; hierarchy
   through size/weight/placement/contrast before pills/labels. Minimum
   tap targets: 44pt iOS / 48dp Android.
4. **Colour restraint.** A dominant neutral base + one sharp accent
   used sparingly outperforms evenly spread palettes. Give colour a job
   (e.g. interactivity only, or one semantic meaning) and don't let it
   decorate. Gradients need a reason: a meaningless purple/blue wash is
   a top slop tell. Check every text/background pair for WCAG AA
   (4.5:1 normal text, 3:1 large text / UI components).
5. **Real content first.** Design sections from the product's story and
   usage flow, not a default landing-page sequence. Show real product
   behaviour / honest placeholders; never manufacture proof (fake
   testimonials, fake stats, fake logos). Art-direct imagery and icons
   to the subject. Copy must be specific: name the object, the cause,
   the next step.
6. **Motion must explain something.** Motion is for state, causality,
   hierarchy, continuity or spatial change — not decoration. Keep
   micro-interactions short (one practitioner guide puts the "feels
   like lag" threshold around 300–400ms on phones), subtle, survivable
   on the 50th use. Always provide a resting state that makes sense
   with no motion, and honour `prefers-reduced-motion`. Avoid staggered
   fade-up of every section as a default.
7. **Empty / loading / error states are content, not gaps.** Each
   needs: what is empty/why, what belongs here, one direct next action.
   Distinguish first-use, user-cleared ("all caught up"), no-results
   (offer clear-filters, not create), and error/permission states.
   Never a dead end, never blame language, never illustration alone.
8. **Opinionated defaults, visible craft in details.** Real hover/focus/
   pressed/disabled states, considered focus rings, honest microcopy,
   keyboard paths, pixel-level consistency (one radius system, one
   border/shadow language, one depth model — depth only where there is
   a real layering model). "Superficial competence" — looks finished at
   a glance, empty after 30 seconds — is the failure mode.
9. **Warmth for Piplet specifically (synthesis, not a source claim):**
   warmth from copy tone, generous but purposeful spacing, warm
   neutrals used as *one* deliberate base (not cream+terracotta by
   reflex), a human type pairing, and small honest details (e.g. "last
   run", real timestamps, plain-language explanations of what the agent
   did/why) — not from stock warmth signifiers like gradients, blobs,
   or emoji decoration. Decide the warm axis explicitly in the design
   plan and commit to it.

### 3.3 Public design systems studied (principles only; no assets copied)

| System | What to take | Caution |
|---|---|---|
| Material Design 3 (Google) | Tokens + meaningful motion + 8dp grid / 4dp sub-grid; accessibility built into tokens; material metaphor (light/shadow for hierarchy) | Full Material look reads "Android/Google" instantly. Take the system discipline, not the skin. Material 3 Expressive (2025) details only seen in secondary summaries. |
| Apple HIG | Clarity, deference, depth + consistency; adaptive/semantic colours; Dynamic Type. 2025–26 "Liquid Glass" era: hierarchy/harmony/consistency, never critical text directly on unmodified glass, honour Reduce Transparency / Increase Contrast | Guidance + UI kits, not a token repo to copy. Do not imitate glassmorphism as decoration. SF Pro is Apple's font — do not ship it. |
| GitHub Primer | Restraint: small reusable component set, base-8 spacing, colour for meaning/signals, dense app-UI patterns, strong accessibility. Start small (<20 components), add only repeated patterns. Code packages MIT; brand/logo assets under separate terms | Visual style is GitHub's brand. Study foundations/patterns; don't clone the look. |
| Shopify Polaris | Consistency, accessibility-first, design tokens, content standards, one primary action per page, card = one concern | Built for Shopify Admin, not customer-facing products. Licence: sources conflict (open source vs "Shopify License") — not verified; check the repo before any reuse. |
| Linear / Vercel / Geist (public writing; no single official principles doc found) | Clarity over decoration, restraint as confidence, typography as foundation, generous whitespace, near-monochrome base + one deliberate accent, real product shown beautifully, motion with intent, craft in hover/empty/microcopy. Geist: 3 weights with strict roles, aggressive negative tracking at display sizes, shadow-as-border, double-ring focus, blue reserved for interactivity | This aesthetic is now heavily copied — using it verbatim risks reading as generic dev-tool slop. Take the discipline, choose Piplet's own accent/type/voice. Linear's official principles page was not located; this row rests on secondary analysis. |
| Radix UI | Headless primitives: behaviour, keyboard handling, focus management, ARIA, no styling — you bring the visual design. MIT | Unstyled = you must design everything. A feature for distinctiveness, a cost in time. |

Also noted, not recommended as Piplet's base: Meta's Astryx design
system (open-sourced Nov 2026, MIT, React 19, 150+ components, still in
beta per 10–15 Nov 2026 reporting) and Vercel Labs UI SDK (0.1.0-beta.1,
12 Nov 2026, Apache-2.0). Both too new/beta to bet on; watch only.

### 3.4 Free tools / libraries (licences per sources — re-check on adoption)

**Components & primitives:** shadcn/ui (MIT, copy-paste React you own;
default primitive changed to Base UI in July 2026, Radix still
supported; default look is ubiquitous — re-tokenise it); Radix UI /
Radix Primitives (MIT, unstyled accessible React primitives, stable
1.x); Base UI `@base-ui/react` (MIT, new shadcn default, broader
coverage than Radix, attribute-based styling — pick for a new React
design system in 2026); Headless UI (MIT, Tailwind Labs, 16 React
components v2.1 + 10 Vue v1.7, designed for Tailwind); Ark UI (MIT,
headless state-machine components for React/Vue/Solid, 45+ components —
only if multi-framework matters); React Aria Components (Apache 2.0,
deep accessibility + i18n — licence not double-checked against Adobe
repo in this pass). MUI core / Mantine / Ant Design / Chakra UI v3: MIT
core, paid tiers exist (MUI X) — avoid paid tiers under the $0 rule;
otherwise too heavy/recognisable.

**CSS:** Tailwind CSS v4 (MIT; v4 Jan 2025 = Rust Oxide engine,
CSS-first config, cascade layers; Tailwind Labs joined Shopify,
announced 9 Sept 2026, Tailwind staying MIT; Tailwind Plus / ui.sh
closed to new sign-ups — do not confuse core (free) with Plus (paid)).
Plain CSS / custom properties always the fallback for tokens,
`prefers-reduced-motion`, logical properties, scroll-driven animation.

**Fonts & delivery:** Google Fonts catalogue generally SIL OFL 1.1
(some Apache 2.0; Ubuntu fonts under Ubuntu Font Licence) — the source
of truth is each family's own licence file in `google/fonts`; never
assume. Fontsource (npm packages, delivery layer only — upstream
licence still applies; keep licence + copyright notices) for
self-hosting, version-pinned, no runtime Google request, subsetted
`unicode-range` files — recommended for Piplet (offline/privacy
friendly). Geist Sans / Geist Mono (SIL OFL 1.1, variable; convergence
risk — very common in 2025–26 dev tools). Noto family (SIL OFL 1.1 —
see §3.5). Anek family (Ek Type, Mumbai; SIL OFL 1.1; 10 scripts incl.
Latin, Devanagari, Telugu, drawn to share proportions/weight/colour;
variable width + weight — strong warm/coherent multiscript candidate).
`next/font` self-hosts Google fonts at build time if Piplet stays on
Next.js. Font pairing recommendation: (a) warm multiscript — Anek Latin
+ Anek Devanagari + Anek Telugu + an OFL mono for code/logs (verify
licence); or (b) precise — Geist Sans + Geist Mono + Noto Sans
Devanagari UI + Noto Sans Telugu UI. Do not ship 3+ display families.
Avoid Inter/Roboto as the "safe default" (named convergence traps).
Any serif display face (e.g. Fraunces) must have its OFL status checked
first — not verified in this pass.

**Icons** (keep the licence/copyright notice with distributed files;
company logos are trademark, not covered by icon licences): Lucide
(ISC, functionally as permissive as MIT; some Feather-origin icons
carry MIT notice too — keep licence file; 1,900–2,100+ icons, count
varies by source/date); Phosphor Icons (MIT, same icon in 6 weights);
Heroicons (MIT, ~316 icons, 4 styles, best at small sizes); Tabler
Icons (MIT, ~6,000+); Material Symbols (Apache 2.0, variable
weight/fill/grade). Warning from one guide: Remix Icon moved to a
custom licence in early 2026 and css.gg v2.1.2+ is non-commercial —
avoid both without fresh licence checks.

**Motion:** CSS transitions/keyframes/scroll-driven animations (web
standard, free — default for 80% of Piplet motion; zero bundle cost;
easiest to gate on `prefers-reduced-motion`). Motion (formerly Framer
Motion; package `motion`, MIT, independent open source; Motion+ $399
one-time per one source is a separate paid product — do not need it;
springs, gestures, layout animations, `useReducedMotion()` —
recommended JS animation library). GSAP (Webflow-owned, closed source;
free Standard Licence since GSAP 3.13, Apr 2025, incl. formerly paid
plugins; restriction on visual/no-code animation tools competing with
Webflow; Motion.dev claims Webflow can terminate the licence at its
discretion — licence text NOT read directly, verify before shipping).
React Spring / Anime.js (MIT per Nov 2026 guide; not deeply verified).

**Charts:** Recharts via shadcn/ui charts (MIT — default; composable
SVG React charts, inherits Tailwind/CSS-variable theming; SVG slows
with many thousands of points; no candlestick series). Apache ECharts
+ `echarts-for-react` (Apache 2.0 / MIT wrapper — large datasets, maps,
gauges; heavier, config-object API). Tremor (licence conflict: most
2026 guides Apache 2.0, one says MIT — verify in repo). Chart.js /
Nivo / visx / Victory / D3 (MIT; D3 ISC). Avoid without legal check:
ApexCharts (dual Community/Commercial — free only under $2M revenue
per Nov 2026 reporting), Highcharts ($185/dev/year), MUI X Charts /
AG Charts advanced tiers (paid). For Piplet: start with Recharts/
shadcn charts; hand-roll tiny sparklines in SVG where a library is
overkill; ECharts only for heavy/dense data.

**Free design-review / accessibility tools:** axe DevTools (free
extension, axe-core open source — first-pass scan every page); Lighthouse
(Chrome DevTools + CLI/CI, free open source — 0–100 scores, signal not
verdict); WAVE (WebAIM, free — visual overlay, catches things axe
misses and vice versa); WebAIM Contrast Checker + Chrome DevTools
colour picker + TPGi Colour Contrast Analyser (free — AA 4.5:1 normal /
3:1 large + UI components; AAA 7:1 / 4.5:1; test every token pair
including hover/disabled); Pa11y / Lighthouse CI (free open source —
automated a11y in CI); NVDA (free, Windows) + VoiceOver (built-in) +
keyboard-only pass (automated testing catches only ~57% of issues by
volume per Deque analysis cited in one guide — always do a manual
smoke pass); Chrome DevTools Rendering panel (emulate
`prefers-reduced-motion`, forced colours, vision deficiencies).

### 3.5 Multilingual UI — English / Hindi / Telugu

All three are left-to-right. No RTL mirroring needed, but use CSS
logical properties anyway so a future RTL language doesn't require a
rewrite.

- **Use a harmonised multiscript family, not three unrelated fonts.**
  Two verified OFL routes: (1) Noto: Noto Sans (Latin) + Noto Sans
  Devanagari + Noto Sans Telugu, 1,000+ languages / 150+ scripts,
  designed for cross-script harmony; (2) Anek (Ek Type): Latin/
  Devanagari/Telugu (+7 more scripts) drawn to share proportions,
  stroke weight and colour, variable width + weight.
- **Noto "UI" variants matter.** For Indic scripts, Noto ships
  `UI`-suffixed families optimised for apps/websites with limited
  vertical space: more compact vertically, same line height as base
  Noto Sans. Noto docs advise UI fonts for interfaces, non-UI fonts
  for documents: `Noto Sans Devanagari UI` / `Noto Sans Telugu UI`
  for Piplet chrome, full families for long-form/document views.
- **Indic scripts need more vertical room.** Devanagari, Telugu and
  Bengali need space for marks above and below the line; cramped
  leading is the most common multilingual layout mistake per an Oct
  2026 Indian-fonts guide. Telugu stacks subscript consonants below
  the baseline. Practical rules: give Indic text larger `line-height`
  than Latin (test, don't guess — start ~1.6–1.7 for Indic body vs
  ~1.5 Latin, adjust by eye); never clip with fixed heights,
  `overflow:hidden`, or aggressive `line-clamp` without testing real
  Indic strings; test at small sizes (12–14px) where conjuncts fail
  first.
- **Complex shaping is real — test with real words.** Devanagari and
  Telugu use OpenType shaping: syllable clusters, half-forms, conjuncts
  (2–5 consonant combinations), reordering matras, reph/ra forms.
  Browsers handle this via shaping engines (HarfBuzz/ICU) *if* the font
  implements the OpenType features correctly. Test with real Hindi/
  Telugu words containing conjuncts, and mixed Latin + Indic in one
  sentence. Prefer fonts with documented conjunct coverage (Noto,
  Anek). Avoid `letter-spacing` and faux bold/italic on Indic text,
  and avoid splitting Indic strings character-by-character in JS
  (e.g. per-letter animations) — test explicitly with real text before
  shipping (not all verified against primary sources).
- **Plan for expansion, especially short strings.** W3C-published IBM
  guidance (English → European languages): ≤10 chars can expand
  200–300%, 11–20 chars 180–200%, 21–30 chars 160–180%, 31–50 chars
  140–160%, 70+ chars ~130%. General rule: plan ~30–50% expansion
  everywhere. **Hindi/Telugu-specific expansion percentages were not
  verified** — do not assume European figures transfer; measure with
  real translations. Buttons, tabs, toggles and menu items are most
  exposed. Use `min-inline-size` instead of `width` on buttons/labels;
  let containers grow vertically; allow wrapping; never truncate as
  the expansion strategy. Use pseudo-locale testing before real
  translations arrive.
- **W3C quick tips (apply all):** UTF-8 everywhere + declare encoding;
  declare document language (`lang="en"` / `hi` / `te`) and mark
  internal language changes (accessibility, `:lang()` styling, search,
  speech synthesis); separate presentation (CSS) from content so
  per-script styling can differ without markup changes; don't bake
  text into images; check imagery/examples for cultural bias.
- **Locale formatting:** dates, times, numbers, currency (₹) and
  pluralisation differ by locale (`en-IN`, `hi-IN`, `te-IN`).
  Externalise all strings, use locale-aware formatting, never
  concatenate translated fragments into sentences. (i18n library
  choice — e.g. `next-intl`, `react-i18next`, `Intl` APIs — out of
  scope, not compared in this pass.)
- **Language switching UX:** one obvious switcher, persist the choice,
  don't auto-switch on content language alone, keep URLs shareable per
  locale if web-first. Test the *longest* translation on critical
  strings in all three languages before calling a screen done.

### 3.6 Anti-slop review checklist (use on every screen)

**First-glance (30 seconds):** could this screen be pasted into an
unrelated product unchanged? (If yes, it fails.) Does it match one of
the five default looks (§3.2) without the brief asking? Exactly one
focal point and one primary action? Would a screenshot be identifiable
as Piplet without the logo?

**Typography:** 1–2 families only, clearly distinct roles; no Inter/
Roboto/system default by reflex. Clear scale, consistent weights; no
single-word headline accent; no ALL-CAPS label default; no eyebrow
above every heading. Line length <80 chars; adequate line-height, esp.
Hindi/Telugu. Hierarchy via size/weight/placement/contrast, not pills
and labels everywhere.

**Colour & material:** neutral base + one accent with a defined job;
accent not decorative. No meaningless purple/blue gradient, no
glassmorphism/blur decoration, no gradient wash behind cards. One
radius system, one border language, one shadow/depth model; depth only
where layering is real. Every text/background pair passes WCAG AA;
disabled/hover states checked too.

**Layout & components:** spacing only from the token scale (8pt/4pt);
proximity shows relationships before containers do. No rows of
identical cards with identical icons/shadows. No generic hero →
features → testimonials → CTA unless the product story demands it. No
lorem-ish/placeholder copy; no fake stats, testimonials, logos, or
"trusted by". Icons from one set, one weight language; no mixing
Lucide + emoji + stock illustrations.

**Motion & interaction:** every animation explains state/causality/
hierarchy/continuity; no staggered fade-up of everything. Durations
short; no looping motion without pause/stop/hide; no flashing >3×/
second. `prefers-reduced-motion: reduce` honoured in CSS *and* JS;
resting state makes sense with zero motion. Real hover/focus/pressed/
disabled/loading states; visible focus rings; keyboard-only path works.

**Copy & states:** copy sounds written for this moment: specific nouns,
named objects, plain language. Empty/loading/error states each have
cause + what-belongs-here + one next action; first-use ≠ no-results ≠
error. Errors say what happened, why, and what to do next; no blame
language; no dead ends. Buttons say what they do ("Save reminder", not
"Submit").

**Multilingual & accessibility gate (before merge):** axe DevTools +
Lighthouse + WAVE run; critical/serious issues fixed. Screen tested in
EN + HI + TE with real text (conjunct-heavy words included); no
clipping/overflow; buttons/tabs wrap or grow. `lang` attributes
correct; font stack includes script companions; line-height adequate
for Indic text. Colour is never the only signal.

**Slop smell test:** suspect any choice that (a) could be pasted
elsewhere unchanged, (b) repeats a familiar generated pattern,
(c) conflicts with neighbouring sections/system, (d) communicates no
information/state/action/hierarchy/brand meaning, or (e) competes with
content or weakens trust. Judge the visible result, not whether AI
made it.

Sources §3: Anthropic `frontend-design` skill (anthropics/skills,
dbd4588, 9 Oct 2026, Apache 2.0) via uichemy.com, aicraftbook.com,
prompthackers.co, autogineer.com; eliteai.tools convergence analysis;
akilima.tech no-ai-design-slop; sircharles.design; studiomaydit.com
(5 Jul 2026); getdesignmd.org Vercel breakdown; Material Design /
Apple HIG / Primer / Polaris public docs via secondary summaries;
hextaui.com UI SDK vs Base UI vs Radix (Nov 2026); ui.minidev.pro
comparisons (30 Sept / 15 Oct 2026); wiztechnoz.com Tailwind/Shopify
(14 Sept 2026); motion.dev; convertstuff.online icon guide (15 Nov
2026); fonts.google.com/noto; notofonts.github.io; ektype.in/anek;
fonts.thesixty2.com (24 Oct 2026); w3.org/International/quicktips;
learn.microsoft.com Telugu shaping; wcag.world (2 Sept 2026);
webbrowserbot.com; dev.to/agentkit.

---

## 4. Competitors — PUBLIC docs/repos only

**Method and limits.** No closed-source internals were decoded,
reverse-engineered, or inspected — no binaries, no private code. Three
official pages were fetched directly (crawled 17 Nov 2026): Antigravity
browser docs, Claude Code "Extend" docs, Grok API overview. Everything
else is a secondary summary of an official page, with its check date.
Where public sources conflict, the conflict is stated rather than
resolved. "Grok" and "Codex" are each several products sharing a name;
conflating them is the main error to avoid. Nothing in this section
uses internal product knowledge.

### 4.1 Per-product summary

| Product (vendor) | What it is, per public docs | Computer use / sandbox | Skills / extensions | Memory / context (public) | Channels (public) | Pricing as publicly stated |
|---|---|---|---|---|---|---|
| Codex (OpenAI) | Coding agent: CLI + IDE extension + ChatGPT desktop/web/mobile + cloud agent | OS sandbox + approval policy, separate controls; network off by default locally; cloud runs in isolated containers | `SKILL.md` skills + plugins + MCP servers in `config.toml`; `AGENTS.md` instructions | `AGENTS.md` (static) + opt-in "Memories" (generated summaries); compaction configurable | Terminal, IDE, desktop, web, iOS; GitHub review + Slack integration; no WhatsApp/Telegram hosting stated | No standalone price; bundled in ChatGPT plans. Secondary summaries of OpenAI pricing page, 1–7 Nov 2026: Free $0, Go $8, Plus $20, Pro $100/$200/$500, Business $20–25/seat. CLI itself free (Apache-2.0) but inference needs a plan or API key |
| Claude Code (Anthropic) | Terminal/IDE/desktop/web coding agent; Claude models only | Sandbox OFF by default, Bash-commands only; permission modes + allow/ask/deny rules; deny rules hold in all modes | Fullest public extension model: skills, subagents, hooks, MCP, plugins/marketplaces; `CLAUDE.md` | `CLAUDE.md` hierarchy + managed memory; `/compact`, `/clear`, `/context`, auto-compact settings; subagents isolate context | Terminal, IDEs, desktop, web; headless/CI use. MCP can reach Slack etc., but no native WhatsApp/Telegram hosting stated | No standalone price; included in paid Claude plans. Summaries of claude.com/pricing, 5–14 Nov 2026: Pro $20/mo ($17 annual), Max $100, Ultra $200; Free excludes it; or pay-per-token API billing |
| Antigravity (Google) | Agent-first coding platform: desktop App + CLI (`agy`) + IDE + extensions + Python SDK; Gemini-first | Permission presets (Default / Request Review / Auto / Turbo); terminal sandbox on Default (macOS/Linux), no internet by default; browser subagent with site/upload/download gates, no credential/payment/CAPTCHA entry | Open Agent Skills `SKILL.md` format; rules (`GEMINI.md`/`AGENTS.md` + `.agents/rules/`); MCP via MCP Store / `mcp_config.json`; browser subagent | Rules files reloaded each session; `/context`, `/compact`, checkpoints/rewind; auto-compaction exists, threshold NOT published in docs found | Desktop app, CLI, IDE, editor extensions. No chat-app channels stated | $0 individual plan with basic weekly limits, per Google pricing page as summarised Oct–Nov 2026; higher limits via Google AI Pro (~$20/mo) and Ultra ($100/$200 tiers reported); unlimited Tab completions on all plans |
| Grok (xAI) | Three surfaces: (a) chatbot, (b) API, (c) Grok Build CLI + Grok Bot agent — see §4.4 | Build CLI: sandbox OFF by default, Landlock/Seatbelt profiles. Bot: persistent shared cloud Linux VM with browser/filesystem/terminal | Build: Claude-style skills/plugins/hooks/MCP + Rhai workflows + subagents + ACP. Bot: Plugins/connectors + skills + routines + MCP | Build: resumable sessions + memory search (details sparse). Bot: memory/files/browser sessions/preferences persist; no inspection/export/API documented | Chatbot: grok.com, X, mobile apps. Build: terminal. Bot: macOS/Windows/iOS apps only; no WhatsApp/Telegram/Slack/Phone stated | API (official page, updated 22 Oct 2026): Grok 4.7 $2/1M input, $6/1M output, 500K context. Build: needed SuperGrok/X Premium+ at beta launch (25 May 2026). Bot: 14-day trial then $200/mo reported from docs summaries (single-source — verify) |
| Instinct (Spear Street Technology) | Invite-only personal agent you text/call; no app of its own | Publicly: "cloud computer + browser + accounts you connect" only. NO public sandbox/approval spec found | NO public skills/plugin/MCP docs found | Marketing only ("understands what's important"). NO public memory mechanism found | iMessage, WhatsApp, SMS, phone calls; group chats in early access (Oct 2026 reporting); web workspace + Mac app mentioned in terms; no mobile app | Free during private beta; NO published price. Invite/waitlist only. Terms last revised 26 Aug 2026 per secondary reading |
| Muse (Meta) | Personal agent with persistent cloud computer; launched 8 Sep 2026 | Marketing/help: isolated "Secure VM" Linux computer with browser/files; approvals before sensitive actions; activity trail. NO public sandbox config spec found | Connectors to third-party services described publicly. NO public SKILL.md/MCP developer docs found in this pass | Marketing: remembers details/goals over time; optional memory import from Meta apps; training opt-out stated. NO public memory-file/compaction docs found | Muse apps (iOS/Android/Mac), web at muse.ai, WhatsApp chat (same account/memory). US + Canada only, 18+. WhatsApp is a chat front-door; no public claim it reads your other chats or messages contacts | Free tier with weekly usage limit + Power $20/mo (500M tokens/week) and Maximum $100/mo (3B/week), per Meta help page as reported 30 Sep–6 Nov 2026. "Limited testing"; free-tier token number not published by Meta (100M figure is press-reported, not official) |

### 4.2 Codex (OpenAI)

**Computer use / safety.** Public docs (summarised Oct 2026) separate
two controls: (1) the OS-enforced sandbox — what commands can
technically touch; (2) the approval policy — when Codex must pause and
ask. Sandbox modes: `read-only`, `workspace-write` (default in
version-controlled folders; writes limited to workspace + temp, network
off), and `danger-full-access` (no limits; docs steer this to
containers/VMs only). Approval policies include `on-request` (ask only
when leaving the sandbox) and `never` (never ask, still sandbox-bound;
for CI/scripts), plus a granular form. Enforcement is described as
OS-level: Seatbelt on macOS, `bwrap` on Linux, three Windows
implementations. Folders such as `.git`, `.agents` and `.codex` stay
read-only even in `workspace-write`, per secondary summaries. Codex
Cloud: tasks run in OpenAI-managed isolated containers, two-phase setup
(network on) then offline agent phase unless internet is enabled. The
CLI, IDE extension and desktop app share `~/.codex/config.toml`;
`/permissions` switches modes.

**Skills / extensions.** Skills are folders with a `SKILL.md` file,
at project level (`.agents/skills/`) and user level
(`~/.codex/skills/`). OpenAI's plugin docs describe a skill as
complementing an MCP server: the server holds live data/auth/actions,
the skill holds the repeatable workflow; a plugin can bundle skills,
and a skill can declare an MCP dependency. MCP servers via `codex mcp
add` or `[mcp_servers.*]` in `config.toml`, shared between CLI and IDE
extension. OpenAI hosts a public docs-only MCP server at
`developers.openai.com/mcp`.

**Memory / context.** Two layers: (1) `AGENTS.md` — layered discovery
from global `~/.codex/AGENTS.md` down through repo directories, default
32 KiB cap with truncation; (2) "Memories" — Codex summarises prior
sessions in the background into files under the Codex home directory
and reads them in later sessions, off by default. **Conflict flagged:**
one secondary source gives the path as `~/.codex/memories/` with a
`MEMORY.md` file; another (checked 10 Nov 2026) gives
`$CODEX_HOME/memories_v2/`. Treat the exact path as unverified. One
source states Memories was unavailable at launch in the EEA/UK/
Switzerland. Built-in web search and auto-compaction are tunable in
`config.toml`.

**Open vs closed.** The Codex CLI source is public under Apache-2.0 in
`openai/codex` (Rust; public since 16 Apr 2025). The models and the
Codex Cloud service are proprietary and were NOT inspected.

### 4.3 Claude Code (Anthropic)

**Computer use / safety.** File tools, search, shell execution and web
access on the user's machine. Permission modes (Oct–Nov 2026
summaries): `default`/manual (reads only without asking),
`acceptEdits`, `plan` (no edits until a plan is approved), `auto`
(classifier-reviewed; starting mode for interactive terminal/VS Code
sessions since v2.1.283, where supported), `dontAsk` (only pre-approved
tools), `bypassPermissions` (docs: isolated containers/VMs only; also
`--dangerously-skip-permissions`). Allow/ask/deny rules via
`/permissions`; deny rules apply in every mode. The built-in sandbox is
**off by default** — enabled via `/sandbox` or `sandbox.enabled`. It
wraps Bash commands only (Seatbelt on macOS; bubblewrap + socat on
Linux/WSL2; no sandbox on native Windows). By default, sandboxed
commands may write only to the working directory + temp, reach the
network only through a local proxy whose allowed-domains list starts
empty, but may still *read* broadly, including credential files, unless
explicitly denied. Claude's own file tools, hooks and MCP servers run
outside this sandbox and follow permission rules instead.

**Skills / extensions — verified from official docs fetched directly.**
The official "Extend Claude Code" page (fetched 17 Nov 2026) defines:
`CLAUDE.md` (persistent context every session), skills (reusable
knowledge/workflows, invocable as `/name` or auto-loaded when relevant,
runnable in main context or forked into a subagent), MCP (external
services/tools), subagents (isolated context, summary returned),
dynamic workflows (scripts running many subagents), hooks
(deterministic handlers at lifecycle events: `PreToolUse`,
`PostToolUse`, `SessionStart`, `Stop`, `PreCompact`), and
plugins/marketplaces (packaging layer bundling skills, hooks,
subagents, MCP servers, namespaced as `/plugin:skill`). The docs' own
rule of thumb: `CLAUDE.md` is advice, hooks are enforcement; keep
`CLAUDE.md` under 200 lines and move reference material to skills or
`.claude/rules/`. Skills live in `.claude/skills/<name>/SKILL.md`;
subagents in `.claude/agents/`; MCP via `claude mcp add`, `.mcp.json`,
`~/.claude.json`.

**Memory / context.** `CLAUDE.md` files merge hierarchically
(enterprise → user `~/.claude/CLAUDE.md` → project `./CLAUDE.md`). A
managed `MEMORY.md` is described in one secondary source as capped at
the first 200 lines / 25 KB loaded at session start — single-source,
treat as unverified. Context tools: `/clear`, `/compact [focus]`,
`/context`, `/autocompact`, `/rewind` (checkpoints), settings
`autoCompactEnabled` / `autoCompactWindow` (100K–1M tokens). Subagents
keep exploration out of the main window. No cross-device/cloud memory
sync described in the docs summaries found.

**Open vs closed.** Claude Code itself is proprietary; internals not
inspected. What is open: the MCP specification/SDKs and the Agent
Skills format, both under the Linux Foundation's Agentic AI Foundation
(see §4.6).

### 4.4 Antigravity (Google)

**Computer use / safety.** Agents plan, edit code, run terminal
commands and test in a browser, with the user reviewing plans/diffs.
Permission presets: Default (sandbox on, commands inside it run
without asking, macOS/Linux), Request Review (sandbox off, every
command asks), Auto, Turbo (no limits; docs steer away from main
machines). Terminal sandbox has no internet by default; package
installs need approval or an allow rule. Browser work is delegated to
a `browser` subagent in its own isolated context window: it opens
pages, clicks, types, scrolls, reads console/network output, captures
screenshots/video. In the App (v2.30.0+, personal Google accounts) it
uses a built-in side-panel browser with an isolated persistent cookie
profile; in CLI/IDE/enterprise it drives local Chrome (v144+) via the
Chrome DevTools MCP server. The official browser page fetched directly
states the always-on protections: no credential, payment or CAPTCHA
entry (identity-provider and payment-processor pages blocked from
actuation; payment/sign-in/iframes masked from screenshots/snapshots);
site-navigation approvals per URL with per-port `localhost` isolation
and sensitive Google subdomains always needing their own rule; file
uploads limited to staged files (≤20 files, 50 MiB each, 100 MiB
total) with one-time confirmation even under Turbo; executable/script
downloads blocked; the subagent has no workspace/shell tools and no
arbitrary in-page JavaScript in the built-in browser; network
diagnostics strip cookies/auth headers/tokens. Sign-in/CAPTCHA/MFA
pauses the agent and hands the tab to the user.

**Skills / extensions.** Open Agent Skills format: folder with
`SKILL.md` (required `description`, optional `name` defaulting to
folder name). Workspace skills in `<root>/.agents/skills/`; global
skills under `~/.gemini/` paths that differ slightly between App and
CLI (sources list `~/.gemini/antigravity-cli/skills/`,
`~/.gemini/skills/`, `~/.gemini/config/skills/` — verify against the
current skills page). Rules: workspace `AGENTS.md`/`GEMINI.md` plus
`.agents/rules/*.md` (triggers: always-on, model-decision, glob,
manual); global `~/.gemini/AGENTS.md` / `GEMINI.md` /
`~/.gemini/config/rules/`. MCP: MCP Store in App Settings, plus
`~/.gemini/config/mcp_config.json` (global) and
`.agents/mcp_config.json` (workspace); remote servers use `serverUrl`.
The CLI is the successor to Gemini CLI (`agy` command).

**Memory / context.** Standing instructions come only from the rules
files above, re-read each session; nothing in the docs found describes
cross-session learned memory. Context handling: `/context`,
`/clear`/`/new`, `/compact` (with preservation instructions), `/fork`,
`/rewind`, checkpoints; auto-compaction summarises older turns into
checkpoints. **Dispute note:** a Nov 2026 forum thread alleges, from
binary inspection, that auto-compaction is clamped near 256K tokens
despite a ~1M advertised window. This was NOT verified, no binary was
inspected, and it is not relied on — the public docs found do not
publish a compaction threshold. Treat the threshold as not publicly
verifiable from docs.

**Channels / pricing.** App, CLI, IDE, VS Code extension, Python SDK.
No chat-app channels stated. One comparison notes third-party models
(Claude Sonnet/Opus 4.6, GPT-OSS-120b) were marked "will be removed on
18 Nov 2026" from the free tier — i.e. today — leaving Gemini 3.8
Flash; verify on the live models page before relying on it.

**Open vs closed.** Antigravity is a proprietary Google product;
internals not inspected.

### 4.5 Grok (xAI) — three surfaces

**(a) Grok chatbot.** Consumer assistant on grok.com, in X, and in
mobile apps. Public docs found say little about its agent internals
beyond chat, voice, image/video. No computer-use/sandbox/skills spec
found for the chatbot itself.

**(b) Grok API.** Official overview page (updated 22 Oct 2026, fetched
directly): Responses API as the primary interface, OpenAI-compatible
REST at `api.x.ai/v1`, function calling, structured outputs, web/X
search, code execution, files/collections, remote MCP, image/video and
voice APIs, batch API, prompt caching and context compaction (named as
features; compaction mechanics not detailed). Flagship Grok 4.7: 500K
context, $2/1M input, $6/1M output. No persistent-memory product
described on the overview page.

**(c) Grok Build (coding CLI).** Announced 25 May 2026 (early beta for
SuperGrok/X Premium+); source published 15–16 Jul 2026; v1.0.0 ~7 Aug
2026; changelog to v1.0.70 (23 Oct 2026) per secondary summaries. Reads/
edits a repo, runs shell commands, searches the web, tracks tasks in a
full-screen TUI, runs headless for scripts/CI, serves ACP for editors.
Permissions and sandbox are separate, as in Codex/Claude Code: modes
Ask (default), Auto (classifier), `dontAsk`, Always-approve (`--yolo`);
allow/ask/deny rules with deny winning; plan mode gates edits until
approval. The OS sandbox is **off by default**; profiles `workspace`,
`devbox`, `read-only`, `strict` use Landlock (Linux, kernel 5.13+) and
Seatbelt (macOS), applied at process start; child-process network
blocking is Linux-only (seccomp) and a no-op on macOS; if a built-in
profile cannot apply, Grok warns and continues unsandboxed (custom
deny-list profiles refuse to start instead). Environment filtering can
exclude `*KEY*`/`*SECRET*`/`*TOKEN*` variables. Extensions mirror
Claude Code's vocabulary: skills, plugins, hooks (including
`PreToolUse`), MCP servers (`grok mcp`), subagents, plus Rhai
workflows (`.grok/workflows/*.rhai`, enabled by default, fan-out to
background subagents) and worktrees. Memory: resumable sessions and a
memory-search tool are named; no `GROK.md`/memory-file spec was found
— do not assume one. The Rust harness/TUI source is public under
Apache-2.0 in `xai-org/grok-build` (~840K–1M lines reported); read-only
mirror synced from an internal monorepo, external PRs/issues disabled,
model weights closed.

**(d) Grok Bot (always-on agent, beta from 11 Aug 2026).** Separate
product from the chatbot, API and Build. Named Bots are messaged like
colleagues and work on **one persistent cloud Linux VM per account**
(shared by all your Bots — docs state files, browser sessions and
logins are shared and Bots are not a security boundary), with a
browser, filesystem and terminal. Bots use connectors/MCP where an API
exists and GUI driving ("computer use") where it does not; named Bots
keep memory, files, browser sessions and preferences across turns, can
save a demonstrated workflow as a routine, run on schedule, and hand
work to each other in group chats. Connectors shown as Plugins (Gmail,
Calendar, Drive, OneDrive, Outlook, Teams, SharePoint, Salesforce
named in summaries); `@` attaches a connector, `/` references a saved
skill; custom MCP servers must be publicly reachable (or tunnelled).
**No public API, webhook or programmatic surface** as of 22 Aug–Sep
2026 summaries; a Cursor account is mandatory and it runs on Cursor
infrastructure. Apps: macOS, Windows, iOS; no Linux desktop app,
Android "coming", enterprise waitlisted. Model powering a Bot is
undisclosed with no picker. No memory inspection/export/deletion or
retention duration publicly documented. Pricing reported as 14-day
trial then $200/mo — single-source, verify before use.

### 4.6 Instinct and Muse — what is publicly verifiable is thin

**Instinct.** Product site (instinct.com) with minimal copy, terms of
service (Spear Street Technology, Inc.; last revised 26 Aug 2026 per
secondary reading), and dated reporting. Consensus across Oct–Nov 2026
secondary sources: invite-only private beta (five invites per member +
waitlist); free during beta, no published price; no mobile app;
reached via iMessage, WhatsApp, SMS and phone calls (its own phone
numbers + email address), group chats in early access from 5 Oct 2026
(TechCrunch, via comparison); settings/connections via web workspace
and a Mac app mentioned in terms; work happens on a cloud computer
with a browser using connected accounts. On WhatsApp it is a contact
you message; multiple sources state it cannot read your other chats or
use them as context. **Not publicly verifiable:** sandboxing, approval
flows, skills/plugins/MCP support, memory architecture/retention,
model identity, security model, or any developer docs. Do not infer
any of these from the "personal agent" label.

**Muse (Meta).** Public launch post 8 Sep 2026 + help/FAQ pages as
reported Sep–Nov 2026: a personal agent that turns goals into plans,
keeps working after the app closes, uses a browser and connected
services (email, calendar, travel, shopping), asks approval before
sensitive actions, with an activity trail. Each user gets a persistent
isolated Linux "Secure VM" in Meta's cloud with browser/files/storage;
a later "Confidential VM" with user-held keys was described as planned
for later in 2026 in Meta's security post as summarised — treat as
planned, not shipped, unless re-verified. Memory described only in
marketing terms (remembers details/goals; optional import of what Meta
apps know; training use on by default with opt-out, per privacy policy
summaries). Surfaces: iOS/Android apps, Mac app, web (muse.ai),
WhatsApp chat. Availability: US and Canada, 18+, "limited testing".
WhatsApp is a front-door chat sharing the same account/memory; no Meta
announcement found stating it reads other WhatsApp chats, messages
contacts, or works in groups. **Not publicly verifiable:** sandbox
configuration, skills/plugin/MCP developer surface, memory storage
format/retention/compaction, model routing, or any internals — none
inspected, no internal product knowledge used.

### 4.7 Open-source alternatives a solo builder could study or use

Licences as reported by GitHub metadata / project docs in the cited
secondary sources. **Always re-check the `LICENSE` file at time of
use** — licences and repo homes move. "Study" vs "use" matters:
several entries are harnesses/benchmarks, not drop-in personal agents.

| Capability area | Project (repo) | Licence | What it is (public) | Honest maturity / caution |
|---|---|---|---|---|
| Full personal agent (chat-app gateway) | OpenClaw — `openclaw/openclaw` (TypeScript; formerly Clawdbot/Moltbot) | MIT (OpenClaw Foundation) | Self-hosted gateway + browser Control UI; WhatsApp, Telegram, Slack, Discord, Signal, Teams, iMessage, 20+ channels; skills via ClawHub registry; swappable models incl. local via Ollama; no paid tier | Very active (v2026.10.10 on 3 Nov, v2026.11.3 on 10 Nov 2026), large community, but fast-moving and security-sensitive: critical RCE (CVE-2026-25253, WebSocket origin check) disclosed in 2026; ClawHub is open-publish with automated scans only — audit every skill. Closest architectural analogue to Piplet; study its gateway/channel/skill design, do not blindly deploy |
| Coding-agent harness (study) | Codex CLI — `openai/codex` (Rust) | Apache-2.0 | Full CLI + SDK/App Server; sandbox + approval-policy design, skills, MCP, AGENTS.md | Mature, heavily starred (~134K, Nov 2026); needs OpenAI inference (plan/API key) to run as-is; models/cloud closed. Best study target for sandbox/approval separation |
| Coding-agent harness (study) | Grok Build — `xai-org/grok-build` (Rust) | Apache-2.0 (first-party; vendored code keeps original licences) | CLI + TUI + agent runtime, skills/plugins/hooks/MCP/subagents, checkpoints | Read-only mirror, no PRs/issues; huge tree (~1M lines); useful to read, hard to contribute to or track. Model closed |
| Coding agent (use/fork) | OpenCode — `anomalyco/opencode` (ex-`sst/opencode`, TypeScript) | MIT | Model-agnostic terminal/desktop/IDE/web agent, 75+ providers via Models.dev, local models supported | Very active (~187–211K stars, Sep–Nov 2026 reports vary by date); name confusion with archived Go project (now Crush); disclosed 2026 security history — review before self-hosting. Optional paid "OpenCode Go" subscription exists; the agent itself is $0 + model costs |
| Browser automation (agent-driven) | browser-use — `browser-use/browser-use` (Python ≥3.11) | MIT (library) | AI agents driving a real browser (CDP); hosted cloud browsers available | Popular (~119–121K stars) but breaking-change-prone: v1.0 rebuilt the engine; v1.0.6 (16 Nov 2026) changed the default model to a paid gateway model (BU 4.0, $1.80/$9 per 1M tokens + browser time/traffic). Library is $0; defaults can bill. Pin versions; bring your own model |
| Browser automation (deterministic) | Playwright — `microsoft/playwright` (TypeScript + Python/.NET/Java) | Apache-2.0 | One API for Chromium/Firefox/WebKit; Test runner, Library, CLI for coding agents, MCP server with accessibility snapshots | Mature and stable (>100K stars, Nov 2026); Microsoft-maintained. No agent reasoning itself — pair with your own loop. Managed cloud browsers (Azure) are paid; the framework is $0. Already used by Piplet |
| Computer-use evaluation only | OSWorld / OSWorld-V2 — `xlang-ai/OSWorld`, `xlang-ai/OSWorld-V2` | Apache-2.0 (per benchmark listing, updated 26 Oct 2026) | Benchmark + VM harness: real Ubuntu/Windows desktops, real apps, hand-written graders (369 tasks v1; 108 long-horizon workflows v2) | Benchmark, NOT a production agent. Heavy setup (VMs, display, API keys); scores harness/step-budget sensitive; pre/post-"Verified" scores not comparable. Use to *measure* Piplet, not to build it |
| Tool protocol + SDKs | MCP — `modelcontextprotocol/*` (spec + SDKs) | Conflicting reports — verify: one Oct 2026 spec summary says Apache-2.0 for code + spec; an earlier account says MIT. Donated Dec 2025 to Agentic AI Foundation (Linux Foundation) | Open JSON-RPC 2.0 standard for clients ↔ tool/data servers; spec revision 2026-07-28; 10K+ public servers claimed at donation | The standard to build against; SDKs widely downloaded. MCP is a capability protocol, not an auth/audit layer — Piplet must add its own approvals |
| Skills format | Agent Skills — spec at agentskills.io (AAIF) | Code Apache-2.0, docs CC-BY-4.0 (per Oct 2026 report — verify in repo) | Folder + `SKILL.md` (required `name` + `description` ≤1,024 chars; optional `scripts/`, `references/`, `assets/`); progressive disclosure | Neutral standard since donation 22 Oct 2026; 70+ platforms claimed integrated. No AAIF security-review gate exists — skills can bundle executable scripts; treat install as code execution |
| Instruction files | AGENTS.md spec (AAIF) | Licence not verified — check spec repo | Cross-tool `AGENTS.md` convention read by Codex, Claude Code (fallback), Antigravity, Cursor, etc. | Converged convention, not a library. Cheapest portability win: one file read by many agents |
| Agent memory (layer) | Mem0 — `mem0ai/mem0` (Python/JS) | Apache-2.0 | Extract-and-retrieve memory API (`add`/`search`), scoped by user/agent/app/run; vector + optional graph; OpenMemory MCP server | Largest community (~60–68K stars, Aug–Nov 2026); OSS core self-hostable; hosted Platform has features/pricing of its own; sources disagree on which plans get graph memory. Needs a vector DB for production |
| Agent memory (runtime) | Letta — `letta-ai/letta` (ex-MemGPT) | Apache-2.0 | Stateful agent platform: agent edits its own core + archival memory; self-hostable server or Letta Cloud | Research-lineage project (~24–25K stars); repo churn flagged: an Oct 2026 source says source moved to `letta-ai/letta-code` and the V1 API server was retired — verify the current canonical repo before depending on it. Heavier commitment than a memory layer |
| Agent memory (graph) | Graphiti — `getzep/graphiti` | Apache-2.0 | Temporal knowledge-graph memory engine | Actively maintained; note Zep Community Edition was deprecated in 2025 — use Graphiti directly, not legacy Zep |
| Agent memory (lightweight) | Supermemory — `supermemoryai/supermemory` | MIT | Memory/context API; hosted or self-hosted single binary, incl. fully offline | Smaller/newer (~31K stars, Nov 2026); simplest self-host story of the four; less battle-testing evidence in sources found |

Not recommended as a "study and copy" target without further diligence:
any project whose licence could not be confirmed, and any
"source-available" (BSL/SSPL/Elastic) agent — none of the table entries
above fall in that bucket as reported, but re-check before commercial
use.

### 4.8 Synthesis — the documented pattern worth copying

The public pattern that repeats across every coding agent is worth
copying because it is *documented*, not because it is secret:
(1) separate the technical sandbox from the human approval policy, and
keep the sandbox default restrictive (note Claude Code and Grok Build
both ship sandbox-off-by-default and document that as a footgun —
Piplet should default the other way); (2) adopt the converged open
formats — `AGENTS.md` + `SKILL.md` + MCP — so Piplet skills remain
portable; (3) make memory files human-readable Markdown with explicit
caps (Codex 32 KiB, Claude Code's <200-line guidance) before reaching
for a vector/graph memory service; (4) for chat-app operation, OpenClaw
is the only fully open reference architecture found — study its
gateway design and its disclosed CVE history as a security checklist;
(5) for browser work, prefer deterministic Playwright/MCP control with
per-site approvals (Antigravity's published gates are the clearest
public template) over free-form GUI driving, and never let the agent
enter credentials, payments, or CAPTCHAs. The personal-agent products
(Instinct, Muse, Grok Bot) publish almost no technical detail — Piplet
cannot learn its safety design from them and should instead borrow
from the coding agents' published permission/sandbox docs.

Sources §4: official pages fetched directly — antigravity.google/docs/
browser/, code.claude.com/docs/en/features-overview, docs.x.ai/overview
(updated 22 Oct 2026) — plus official docs via search:
developers.openai.com/plugins/build/skills, developers.openai.com/learn/
docs-mcp; secondary summaries of official pages: kipt.me (Codex
approvals/sandbox, 24 Oct 2026; Antigravity guide, 28 Oct 2026),
9to5ai.tech (8–9 Oct 2026), mem0.ai Codex memory, supermemory.ai (10 Nov
2026), dev.to/aobaworks Claude Code sandbox (Oct–Nov 2026),
cybedefend.com (10 Nov 2026), aftergradient.com (8 Nov 2026),
aistackcurrent.com Grok Build (5 Nov 2026), appwrite.io (16 Jul 2026),
continuumcode.ai Grok Bot (22 Aug / 8 Sep 2026), vellum.ai Grok Bot
breakdown, usecarly.com Instinct WhatsApp (8 Nov 2026), arlo.sh
Instinct vs Muse (Oct 2026), shipwithmuse.live (Sep 2026),
plainaidaily.com (6 Nov 2026), developersdigest.tech OpenClaw guide
(28 Sep 2026), munderdiffl.in OpenCode (29 Sep 2026), fathom.news
Playwright (Nov 2026), bdemerson.com MCP spec (Oct 2026), pondero.ai
Agent Skills (23 Oct 2026), getlockstep.dev memory comparison (5 Nov
2026), discuss.ai.google.dev Antigravity compaction dispute (5 Nov
2026, existence of dispute only).

---

## 5. What could NOT be verified (consolidated)

**Channels:** grammY core LICENSE file (MIT reported second-hand);
current Telegram Bot API version (sources cite 9.2, 9.6, 10.2);
Telegram file-size limits (official FAQ as crawled: download ≤20MB,
send ≤50MB; newer secondary sources claim up to 2GB); Telegraf's
latest release date / current maintenance state; Baileys 7.x stable vs
RC status on 18 Nov 2026; whether Cloud API real-number sending works
before business verification (sources conflict); §4.7 applied to a
single-user self-hosted personal assistant (no published Meta ruling);
ban rates/thresholds, WhatsApp 14-day/30-day logout thresholds,
GST/invoicing details, INR-billing deadline, Embedded Signup
co-existence details; Meta's current Graph API version and rate-card
CSV (India prices from agreeing secondary summaries, not Meta's own
page in this pass).

**Apps:** official Apple/Google fee pages directly (fees corroborated
by multiple summaries, not fetched from developer.apple.com / Play
Console Help); current typical React Native vs Flutter binary sizes;
Electron autostart API details per OS/version; Tauri tray, Tauri
screen-capture, and Tauri mobile maturity in detail; Azure Artifact
Signing eligibility for an individual developer in India; SignPath
Foundation eligibility/availability; Codemagic free tier; 1Password's
use of Tauri; framework version numbers (secondary sources disagree:
Electron 34.x vs 44/45; Flutter 3.47 vs 4.0; React Native 0.78 vs
0.82); live PWA behaviour of named brand examples today; exact iOS PWA
storage/eviction behaviour (sources conflict); Bubblewrap licence,
GitHub Releases asset-size limits, per-OS automation-permission
specifics.

**Design:** official primary docs not directly fetched (findings rest
on public web search + secondary summaries; Linear's official
design-principles page not located); licence conflicts — Tremor
(Apache 2.0 vs MIT), Polaris (open-source vs "Shopify License"), GSAP
termination clause; icon counts / library versions drift fast;
Hindi/Telugu expansion % (no verified figures); font licences beyond
those named (Fraunces, Instrument Serif, JetBrains Mono not
licence-checked); i18n libraries, design tools (Figma/Penpot),
illustration sources not compared; nothing installed, rendered, or
screenshot-tested.

**Competitors:** any closed-source internals (model weights, system
prompts, routing, sandbox enforcement code except open harnesses,
server-side orchestration); Claude Code internals beyond documented
descriptions; Antigravity compaction thresholds/quota/model selection;
Codex Memories exact path/schema/retention/availability; Grok Bot model
identity, memory retention/export/deletion, approval details, $200/mo
price (single-source); Grok Build memory-file format existence;
Instinct — almost everything technical; Muse — almost everything
technical; cross-product benchmark/quality/speed rankings (no
benchmarks run); current prices/limits (snapshots Sep–mid-Nov 2026,
change frequently); MCP licence (Apache-2.0 vs MIT conflict);
AGENTS.md licence unverified.

**General:** live GitHub star counts, licence files, and repo statuses
were not re-verified in this pass. Benchmark scores are vendor/paper-
reported and harness-dependent. Several items rest on secondary
summaries, not primary reads — flagged inline. Re-verify every
licence, price, and limit on the day of use.
