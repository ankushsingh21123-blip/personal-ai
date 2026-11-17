# System design V2 — Piplet target architecture (18 Nov 2026)

TARGET document. This describes where Piplet is heading, not what is
shipped today. The shipped architecture is `SYSTEM-DESIGN.md` (V1).
Nothing in this file is built yet. Research grounding:
`research-channels-apps-design-2026-11-18.md` and
`research-cycle-2026-11-17.md`.

Design rule, unchanged from V1: **the model proposes, the executor
enforces.** No prompt, no model output, and no page/screen/chat content
can change a rule. V2 adds surfaces (channels, desktop app, phone app)
around the SAME single brain, single executor, single database — it
does not duplicate them.

## 1. Target architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ SURFACES (all talk to the same brain + executor + audit log)        │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Web UI   │  │ Desktop  │  │ Phone /  │  │ Telegram │  │WhatsApp│ │
│  │ (PWA-    │  │ app      │  │ tablet   │  │ bot      │  │(spare  │ │
│  │  ready)  │  │(Electron │  │(PWA →    │  │(grammY,  │  │number, │ │
│  │          │  │ Windows  │  │ React    │  │ polling, │  │Baileys │ │
│  │          │  │ first)   │  │ Native)  │  │ owner-   │  │gated)  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │ only)    │  └────┬───┘ │
│       │             │             │        └────┬─────┘       │     │
│       └──────┬──────┴──────┬──────┘             │             │     │
│              │             │        ┌───────────▼─────────────▼──┐  │
│              │             │        │ CHANNEL GATEWAY (new)      │  │
│              │             │        │ allowlist · pairing ·      │  │
│              │             │        │ rate caps · tool scoping   │  │
│              │             │        │ per sender/channel ·       │  │
│              │             │        │ payload-locked approvals   │  │
│              │             │        └─────────────┬──────────────┘  │
│              ▼             ▼                      ▼                 │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │ server.js (Express, loopback-first) — auth · rate limits ·   │   │
│  │ CSP · body validation · audit/verify + receipt endpoints     │   │
│  └──────┬──────────────┬──────────────┬──────────────┬──────────┘   │
│         │              │              │              │              │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────────┐   │
│  │ brain.js    │ │ tools.js   │ │ SQLite     │ │ skills/ (new)  │   │
│  │ providers + │ │ deny-first │ │ messages/  │ │ curated        │   │
│  │ function    │ │ executor   │ │ jobs/notes │ │ SKILL.md +     │   │
│  │ calling     │ │ 24 tools   │ │ approvals/ │ │ human-reviewed │   │
│  │ + routing   │ │ + MCP      │ │ audit log  │ │ curator,       │   │
│  │             │ │ client     │ │ (hash-     │ │ progressive    │   │
│  │             │ │ (planned)  │ │ chained)   │ │ disclosure     │   │
│  └──────┬──────┘ └─────┬──────┘ └────────────┘ └────────────────┘   │
│         │              │                                             │
│  ┌──────▼──────────────▼─────────────────────────┐                    │
│  │ screenLoop · browser.js · phone.js · queue ·  │                    │
│  │ routines · freeze · replay · sync (as V1)     │                    │
│  └────────────────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────────┘
                              │ sync (HTTPS + token, Tailscale)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ OPTIONAL CLOUD NODE — same code, another peer. Holds queue +        │
│ routines + sync records. NEVER holds keys or screenshots. Works     │
│ while the laptop is off.                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.1 What is new vs V1

| Piece | V1 (shipped) | V2 (target) |
|---|---|---|
| Surfaces | Web UI only (loopback) | Web UI (PWA-ready) + Electron desktop + phone/tablet (PWA → React Native) + Telegram + WhatsApp (gated) |
| Channel gateway | Telegram polling bot + WhatsApp guards, unit-tested only | One gateway module: deterministic allowlist, pairing, rate caps, per-sender tool scoping, payload-locked approvals — in front of the model |
| Skills | `skills/coding-agent/SKILL.md` only | Curated SKILL.md system, progressive disclosure, human-reviewed curator, no auto-install of third-party skills ever (Agent Skills open format) |
| Tools | 24 deny-first tools | Same executor + MCP client (deny-first) + MCP server; MCP adds capabilities, never bypasses approvals |
| Audit | Hash-chained log + receipts (API) | Same + UI panel + tiered autonomy + per-workflow kill switch |
| Memory | Notes + messages | Memory v2: sqlite-vec + timestamped facts + contradiction handling + user forget/edit (human-readable Markdown first, vector second) |
| Design | Functional web UI, EN/HI/TE chrome | Shared design language across all surfaces (§4), anti-slop review gate |
| Evals | 15-task golden harness, deterministic | Same harness extended per surface + channel-behaviour evals (allowlist, pairing, rate caps) |

### 1.2 What does NOT change

One repo, one package. One deny-first executor, one DB schema, one auth
path — these exist exactly once. The desktop agent stays a second
*process* in the same package sharing `validateAction()`. The browser
path keeps its permanent rule: NO submit/post/send action; the agent
fills and screenshots, a human submits. No bulk/mass messaging
capability anywhere. No credential/OTP/payment automation anywhere.
No telemetry of any kind.

## 2. Components

### 2.1 Brain (unchanged core, extended)

`brain.js` keeps: multi-provider chain (Gemini, OpenAI-compatible,
Anthropic, Groq, Ollama), native function calling from one declaration
source, deterministic fast routing (OFF by default), measured
`latencyMs` per turn. V2 additions, each behind the existing executor:

- **Skills loader** — reads curated `SKILL.md` files, discloses the
  short description list first, loads full skill content only when
  relevant, never loads an unapproved skill. Skills can carry
  `scripts/` — treat install as code execution: human review + recorded
  approval before activation, no ClawHub-style open registry.
- **Memory v2** — timestamped facts in SQLite with sqlite-vec retrieval,
  contradiction handling (new fact vs old fact surfaced, never silently
  overwritten), user forget/edit. Human-readable Markdown export first;
  vector search second. Explicit caps (Codex-style 32 KiB guidance for
  instruction files; Claude-style <200-line guidance for standing
  context) before reaching for heavier machinery.
- **MCP client (deny-first)** — speaks MCP to external tool servers;
  every MCP tool call passes through `tools.execute()` validation and
  the approval queue. MCP is a capability protocol, not an auth/audit
  layer — Piplet adds its own approvals, sandboxing, budgets, logging.
  **MCP server** — exposes Piplet's own tools to other agents under the
  same deny-first rules.

### 2.2 Channel gateway (new module)

One gateway in front of all chat channels. Deterministic, no model
involvement in allow/deny decisions:

1. **Allowlist check** — sender numeric ID + channel + (for groups)
   group ID against allowlists. Unknown → dropped and logged, never
   shown to the model. Default-deny. Owner ID(s) only at first.
2. **Pairing** — unknown sender gets a pairing request queued to the
   owner only (code expiring in 1 hour, max 3 pending per channel
   account). Pairing for DMs never grants group access. Owner powers
   (approving risky actions) are separate from being allowed to chat.
3. **Rate caps** — per-recipient cooldowns, per-chat send caps, burst
   limits, 429 backoff, bot-loop protection, global kill switch
   (freeze). Telegram free limits (~1 msg/s per chat, 20/min per
   group, ~30/s bulk) are generous for 1-user use — still queue sends.
4. **Tool scoping** — owner DM = full tools (still approval-gated for
   irreversible acts); any other chat = read-only/answer-only or
   nothing. Group mentions never inherit owner shell/file tools.
5. **Payload-locked approvals** — the approval queue stores the exact
   payload + context + reasoning, locked (e.g. HMAC) between approval
   and execution so it cannot mutate; the executor runs only the locked
   payload; every tool call in a chain is gated, not just the first
   plan step.
6. **Untrusted input handling** — quoted/forwarded content and group
   history are data, never instructions. Filter supplemental context
   to allowlisted senders where possible. Keys pasted in chat are
   refused, never stored, never forwarded (already in V1 — kept).
7. **Audit** — every allow/deny/approval/send logged with sender,
   chat, payload hash, decider, into the hash-chained audit log.

### 2.3 Channels

**Telegram (first).** grammY (TypeScript, MIT per secondary sources —
verify LICENSE) + long polling. No domain needed, works behind NAT.
Bot created via `@BotFather`; token in env/secret storage; `/revoke`
if leaked. Privacy mode left ON; group adds disabled unless explicitly
wanted; mention required in any group. Message splitting at 4,096
chars. Webhook mode later only if a public HTTPS endpoint exists
(webhook secret-token validation mandatory).

**WhatsApp (deferred, gated).** No primary-channel build until the
§4.7 decision is re-read and a spare number exists. When built:
Baileys on a spare number only, owner-only, low volume, Telegram as
fallback; session handling per Baileys wiki (no auto-reconnect;
`401/loggedOut` → delete auth state, fresh QR); auth state git-ignored
and never committed; human-like pacing; hard volume caps; logout-vs-
ban distinction surfaced in the UI. Official Cloud API only later,
with business verification + payment method + template approvals +
human-escalation path, and only after a fresh §4.7 read. whatsapp-web.js
is the fallback only if full Web parity matters more than resource use
(full Chromium per session, same ban risk).

**Web UI (always).** The loopback web UI stays the trusted
configuration surface (Settings, approvals, audit, receipts). PWA
readiness (manifest, icons, service worker, offline shell, IndexedDB
queue) is added so the same UI installs on desktop and phone browsers
at $0 with no store.

### 2.4 Desktop app (Electron, Windows first)

The Electron shell wraps the existing app: same frontend, Express
backend in the main process or as a local server, SQLite file local
with a Node SQLite driver. New shell code only: window, tray, global
shortcut, autostart, notifications, screen capture via
`desktopCapturer`, updater via GitHub Releases. Distribution: Microsoft
Store as MSIX (free individual registration, Store re-signs/hosts/
updates at $0; identity verification with government ID + selfie
required) to dodge Windows cert costs; direct-download unsigned builds
trigger SmartScreen warnings. macOS: ship unsigned first (Gatekeeper
friction), pay $99/yr Apple Developer only when macOS users justify
it. Tauri rewrite only if download size/idle memory/startup become
evidenced user complaints AND Rust capacity exists — not the first
build. The desktop agent (`desktop-agent.js`) and screen loop keep
their V1 validation; the Electron shell adds no new automation powers.

### 2.5 Phone / tablet app (PWA first, React Native later)

Phase 1: installed PWA + Android TWA (Trusted Web Activity) reusing
the web UI as-is; iOS stays Home Screen install. Phase 2 (only on a
concrete trigger — reliable background sync, widgets, share extension,
durable offline SQLite, or App Store presence): React Native (Expo),
TypeScript, sharing API client/logic/types/validation/queue-sync code
with the web app; UI rebuilt in React Native components; phone-side
SQLite is a separate local store needing sync design (not the same
database file as the desktop). Push via FCM/APNs directly or Expo Push
(both $0 delivery). No phase promises general phone control: phone
automation is sandbox- and policy-limited on iOS and Android, and
PWA/TWA cannot control other apps. Flutter is not the path (least
reuse for a TS/React codebase).

### 2.6 Cloud node (unchanged from V1)

Same code, another peer (e.g. Oracle free tier behind Tailscale). Holds
queue + routines + sync records. NEVER holds keys or screenshots. Works
while the laptop is off. Sync: last-write-wins per record, capped
pulls, conflicts surfaced, local data never silently overwritten.
Synced tables ONLY: messages, jobs, notes, approvals. NEVER synced:
settings, outbox, audit_log, notifications, screen sessions/steps,
keys, DB file, `wa-auth/`, `data/shots/`.

## 3. Trust boundaries (V2 additions to V1 §3)

| Boundary | Rule |
|---|---|
| Channel gateway | Deterministic allowlist/pairing/rate/tool-scope checks run BEFORE the model sees anything. No model output can widen channel access. |
| Chat content (all channels) | Untrusted data, never instructions. Quoted/forwarded/group content is filtered to allowlisted senders where possible. Keys/OTPs in chat refused, never stored/forwarded. |
| Skill content | Data + code. A skill is inert until human-reviewed and approval-recorded. Skill scripts run only through the executor with the same deny-first rules. No third-party skill auto-install, ever. |
| MCP servers | Untrusted until configured by the owner. Every MCP tool call passes executor validation + approvals. MCP server descriptions are data, never instructions. |
| Memory facts | Data. Retrieved facts never override standing rules, deny lists, or approvals. Contradictions surface to the user. |
| Desktop shell (Electron) | Trusted only as a local UI host. It adds window/tray/shortcut/update powers, no new agent powers. IPC/preload bridge is allowlisted; no `nodeIntegration` in renderer. |
| Phone app | Untrusted network, trusted device. Talks to the brain only over authenticated HTTPS + token. Phone-side SQLite holds a sync copy, never keys. |
| Sync peer | As V1: authenticated by token, records still validated, conflicts surfaced. |
| Model output / screen / page / fetched content | As V1: data, never instructions. Hard blocks unchanged. |

Hard blocks enforced in the executor (not the prompt), in every path,
unchanged from V1: no credential/OTP/admin/payment automation; approvals
for the irreversible (approving records the decision only, never
executes); no bulk/mass messaging; no shell escape hatch (`run_command`
allowlist only); no submit/post/send in the browser path; freeze stops
every loop and survives restart.

## 4. Shared design language (all surfaces)

One design language, implemented per surface (web CSS tokens, Electron
same web UI, React Native StyleSheet tokens derived from the same
values). The full research is in
`research-channels-apps-design-2026-11-18.md` §3.

**Design plan (decide before building, review against §3.2 of the
research doc):** palette (dominant neutral base + ONE accent with a
defined job — interactivity only), type roles (one family or two
clearly distinct; see font decision below), layout concept (one focal
point, one primary action per screen), principles (real content first,
motion explains something, spacing as rhythm on an 8pt/4pt token
scale). Avoid the five default looks (cream+terracotta, near-black+
acid, broadsheet, identical SaaS cards, template chrome) unless the
brief explicitly asks for one.

**Tokens:** spacing on an 8pt base / 4pt half-step, fewer values, used
consistently; one radius system, one border language, one shadow/depth
model (depth only where layering is real); colour pairs checked to
WCAG AA (4.5:1 normal, 3:1 large/UI) including hover/disabled states;
tap targets 44pt iOS / 48dp Android minimum.

**Typography:** font decision — (a) warm multiscript: Anek Latin +
Anek Devanagari + Anek Telugu + an OFL mono for code/logs (verify
licence); or (b) precise: Geist Sans + Geist Mono + Noto Sans
Devanagari UI + Noto Sans Telugu UI. Self-host via Fontsource
(version-pinned, no runtime Google request). Indic text gets larger
`line-height` than Latin (start ~1.6–1.7 vs ~1.5, adjust by eye with
real text); never clip Indic strings with fixed heights or aggressive
`line-clamp` without testing conjunct-heavy words; no `letter-spacing`
or faux bold/italic on Indic text; never split Indic strings
character-by-character for animation. `lang` attributes correct
(`en`/`hi`/`te`); CSS logical properties throughout; locale-aware
formatting (`en-IN`, `hi-IN`, `te-IN`); plan ~30–50% text expansion,
measured with real translations (Hindi/Telugu-specific expansion %
unverified). One obvious language switcher, choice persisted.

**Components:** behaviour primitives separate from skin — Base UI
(MIT, shadcn/ui default since July 2026) or Radix Primitives (MIT)
for a new React system; shadcn/ui (MIT, copy-paste, owned source)
re-tokenised, never shipped in default skin. Icons from ONE set, one
weight language: Lucide (ISC) default; Phosphor (MIT) if multiple
weights needed. Charts: Recharts via shadcn charts (MIT) default;
hand-rolled SVG sparklines where a library is overkill; ECharts
(Apache 2.0) only for heavy data. Motion: CSS first; Motion (MIT)
for JS animation; every animation explains state/causality/hierarchy/
continuity; `prefers-reduced-motion` honoured in CSS and JS; resting
state makes sense with zero motion.

**Copy & states:** specific nouns, named objects, plain language;
buttons say what they do. Empty/loading/error states each have cause +
what-belongs-here + one next action; first-use ≠ no-results ≠ error;
errors say what happened, why, what to do next; no blame language, no
dead ends. No fake stats, testimonials, logos, or "trusted by" —
ever. Warmth comes from copy tone, purposeful spacing, and honest
details (real timestamps, plain-language explanations of what the
agent did/why) — not gradients, blobs, or emoji decoration.

**Review gate (before any UI merges):** the anti-slop checklist in
research doc §3.6 (first-glance test, typography, colour/material,
layout, motion, copy/states, multilingual + accessibility gate) +
axe DevTools + Lighthouse + WAVE + keyboard-only + screen-reader smoke
pass + EN/HI/TE real-text test. Automated testing catches only ~57%
of a11y issues by volume (Deque analysis cited in research) — the
manual pass is mandatory.

**Stack note:** the current frontend is dependency-free vanilla JS.
Adopting React/Next.js + Tailwind + shadcn is a rewrite decision for
the desktop/phone phase, not a drop-in change. The principles above
apply to the current stack immediately; the component stack applies
when the rewrite is explicitly scheduled.

## 5. Performance design (measured, never claimed)

As V1 §6, extended: per-turn `latencyMs`, per-step screen-loop latency,
and per-surface measurements (PWA load, Electron cold/warm start,
channel round-trip) recorded, never asserted. No "faster than X" claim
appears anywhere in the product or docs. Element-first browser actions
stay the main latency/cost saving. Channel sends are queued with
backoff; no tight loops. Eval harness (§6) is the regression gate for
every phase.

## 6. Evaluation & security gates (every phase)

- **Eval harness** (`app/eval-tasks.js`, `eval-runner.js`,
  `scripts/run-eval.js`): golden tasks, deterministic, on a throwaway
  DB, no model calls, no network. Extended per phase: channel evals
  (allowlist deny, pairing flow, rate caps, tool scoping, payload
  lock), skills evals (disclosure, approval gating, no permission
  widening), memory evals (contradiction handling, forget/edit).
- **Test suite**: full suite green before any phase is reported done.
  Flaky-test history recorded honestly in `TEST-REPORT.md`.
- **Security checks**: 35-check script + pre-push secret scan, every
  phase. npm audit re-run on the laptop (endpoint unreachable from
  the VM). New surfaces get their own checks: Electron (no
  `nodeIntegration`, allowlisted IPC, CSP), phone (no keys in the
  app bundle, token storage via OS secure storage), channels (webhook
  secret validation, auth-state git-ignore, token revoke procedure).
- **Design review gate**: §4 checklist + a11y tools, every UI change.
- **Secrets scan + review before every push.** No exceptions.

## 7. Phased build order

Each phase ships only when its evals + tests + security checks +
design gate pass. A phase that fails its checks goes back for fixes
instead of moving on. Nothing is pushed without parent review.

| Phase | What ships | Needs from Ankush (gates) | Depends on |
|---|---|---|---|
| P0 — Design language v1 (web) | Token scale, type roles, font decision implemented, anti-slop checklist adopted, EN/HI/TE layout fixes in current web UI | Font choice (Anek vs Geist+Noto UI) — his call, or Muse picks and he reviews | Nothing (current stack) |
| P1 — Channel gateway + Telegram | Gateway module (allowlist, pairing, rate caps, tool scoping, payload-locked approvals) + grammY polling bot, owner-only, channel evals | Telegram account + bot token via @BotFather (his tap, token via secure form only) + owner numeric chat ID | P0 not required; gateway design from this doc |
| P2 — Skills system | Curated SKILL.md + progressive disclosure + human-reviewed curator + 3–5 first skills + skills evals | Approval of each skill's activation (his review per skill) | Cycle 3 work (in progress) |
| P3 — Memory v2 | sqlite-vec + timestamped facts + contradiction handling + forget/edit + Markdown export + memory evals | Nothing new (local-first, $0) | P2 (skills may write facts) |
| P4 — MCP client + server | Deny-first MCP client + MCP server exposing Piplet tools under the same rules + MCP evals | Any MCP server credentials he wants connected (his taps, secure form) | P1–P3 (approvals + audit must exist first) |
| P5 — Audit UI + autonomy tiers | Verify/receipt UI panel + tiered autonomy + per-workflow kill switch | Nothing new | Cycle 2 audit log (shipped) |
| P6 — PWA-ready web | Manifest, icons, service worker, offline shell, IndexedDB queue, HTTPS deployment decision | Hosting choice (his call; $0 options only) + domain decision if any | P0 |
| P7 — Electron desktop (Windows first) | Shell (window, tray, shortcut, autostart, notifications, updater), same frontend + local Express/SQLite | Windows laptop install + Playwright Chromium (already on his list); Microsoft Store identity verification (government ID + selfie) if Store distribution chosen; $99/yr Apple Developer only if/when macOS is wanted | P6 (PWA shell reuses the same UI work); laptop install |

**P7 status, 18 Nov 2026 (branch `electron-app`, NOT merged):** the shell
is built and verified — window, tray (Freeze toggle, app log, data
folder), single-instance lock, in-process server lifecycle, clean
shutdown, navigation guards, app.log; same frontend + local
Express/SQLite, packaged for Windows (NSIS + zip) and Linux (AppImage
+ tar.gz), unsigned ($0 rule). Packaged Linux app + extracted AppImage:
27/27 E2E checks each. NOT yet built: autostart, desktop notifications
from the shell, auto-updater (updates are manual). Windows execution,
NSIS-on-Linux (needs wine), macOS, and desktop-agent-in-app remain
unverified/undone — see `DESKTOP-APP.md`.
| P8 — Phone companion (PWA/TWA) | Installed PWA + Android TWA via Bubblewrap/PWABuilder; iOS Home Screen install | Google Play $25 one-time + 12-tester/14-day closed test (only when genuinely ready for Play); no iOS store path for pure PWA | P6 |
| P9 — React Native app | Expo app sharing logic/types, rebuilt UI, phone-side SQLite + sync design, push via FCM/APNs | Apple Developer $99/yr if iOS App Store wanted; Mac + Xcode OR EAS free quota for iOS builds; push credentials setup (his taps) | P8 trigger (background sync, widgets, share extension, durable offline, or App Store presence) |
| P10 — WhatsApp (gated) | Baileys on spare number, owner-only, low volume, Telegram fallback, session/logout handling, WhatsApp evals | Spare phone number (never primary) + QR/pairing scan (his phone) + acceptance of ban/logout risk in writing + fresh §4.7 read before any official-API consideration | P1 (gateway must exist first); spare number; risk acceptance |
| P11 — Sandboxed execution | Secrets outside the sandbox, egress allowlist, full-argv approval for shell work | Nothing new (local-first) | P4 (MCP) + audit tiers (P5) |
| P12 — Tauri rewrite (optional) | Only if size/memory/startup become evidenced user complaints AND Rust capacity exists | His explicit go-ahead (rewrites the working backend) | Evidence of complaints; never before P7 ships |

**Explicitly NOT in the build order:** bulk/mass messaging; credential/
OTP/payment automation; CAPTCHA solving; model training/fine-tuning;
multi-monitor control; desktop accessibility-tree control; iOS screen
control; page JavaScript execution; file uploads from the browser;
telemetry; any third-party skill auto-install; any closed-source
"decoding" (internals of Codex/Claude Code/Antigravity/Grok/Instinct/
Muse are not public and were not inspected — Piplet learns from
published docs and open-source alternatives only).

## 8. Failure modes (V2 additions to V1 §5)

| Failure | Behaviour |
|---|---|
| Telegram token leaked | Revoke via `/revoke`, rotate in secret store, re-pair. Old token dies immediately. |
| Telegram webhook/polling conflict | 409 → gateway logs, falls back to polling, alerts owner. Two pollers never run. |
| WhatsApp session logged out | `401/loggedOut` → delete auth state, surface "re-scan QR" in UI, Telegram fallback offered. Never auto-reconnect-loop. |
| WhatsApp number restricted/banned | Surface the in-app notice state honestly; no vendor can unban; spare number only, so the primary number is never at risk. |
| Unknown sender on any channel | Dropped + logged, never shown to the model. Pairing request queued to owner only. |
| Skill not approved | Never loads. Attempt logged. |
| Skill script tries to widen permissions | Executor denies; attempt logged in the hash-chained audit log. |
| MCP server misbehaves / lies in descriptions | Descriptions are data; every call validated + approval-gated; server can be disabled per-workflow (kill switch). |
| Memory contradiction | Surfaced to the user; old fact kept until the user resolves it. Never silently overwritten. |
| Phone app offline | Queued work sends when the app is open (iOS has no Background Sync); sync conflicts surfaced, local kept. |
| Electron updater feed unreachable | App keeps running on the current version; update deferred, never forced mid-task. |
| Store rejection (TWA / wrapper) | PWA Home Screen install remains the fallback; no functionality depends on store presence. |

## 9. Open decisions (Ankush's, not assumed)

1. Font direction: Anek multiscript vs Geist + Noto UI companions.
2. React/Next.js rewrite of the frontend vs staying dependency-free
   vanilla JS (affects P0/P6/P7 effort significantly).
3. Hosting for the PWA / cloud node (Oracle Always Free pack exists,
   signup blocked on card — see STATUS.md; alternatives unchosen).
4. Microsoft Store distribution vs direct download (identity
   verification vs SmartScreen friction).
5. Google Play $25 + 12-tester gate timing (only when the PWA is
   genuinely ready).
6. Apple Developer $99/yr — only if/when macOS desktop or iOS App
   Store is wanted. Not a $0 item; his explicit decision.
7. WhatsApp: spare number + risk acceptance, or stay Telegram-only.
8. Repo rename, licence, Piplet name checks — still undecided (see
   STATUS.md). No licence decision is assumed anywhere in V2.
9. Third-party model removal from Antigravity's free tier (marked
   18 Nov 2026) and all competitor prices/limits in the research doc
   are snapshots — re-verify on the day of any decision that depends
   on them.

## 10. Relationship to V1

`SYSTEM-DESIGN.md` stays the record of what is shipped and proven.
This file is the target. As each phase ships, its section moves from
here into V1 with measured evidence (test counts, eval results,
latency numbers, live-run status). Nothing is marked done in V1 on
the basis of this document alone.
