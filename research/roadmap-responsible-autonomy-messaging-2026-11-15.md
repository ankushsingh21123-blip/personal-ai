# Piplet roadmap — responsible autonomy + messaging (design note, 15 Nov 2026)

**Direction from Ankush (15 Nov 2026):** keep enhancing Piplet toward a "next AGI"
personal agent that takes all decisions with responsibility and handles messaging,
including WhatsApp.

**Status of this note:** DESIGN ONLY. Nothing in it is built, enabled, or claimed
working. It sets the rules the build must follow — in particular, it does NOT weaken
any deny-first guard, and it does NOT enable live WhatsApp. The code increment that
landed alongside this note is Phase A2 (native function calling for OpenAI/Anthropic,
unit-tested-only); this roadmap is the next horizon, not the current build.

**Honest bound, stated first:** "next AGI" is Ankush's aspiration for the product's
direction, not a capability claim. What can honestly be built is an agent that
decides more on its own *inside explicit policies*, explains every decision, and
escalates everything it must not decide alone. No benchmark, autonomy level, or
"AGI" claim is made until it is measured and proven on his devices.

---

## 1. Responsible autonomous decision-making

The goal is an agent Ankush can trust to act without being asked — because every
decision it is allowed to make is bounded by a written policy, recorded with its
reasoning and evidence, and reversible or escalated when it matters. The rule for
the whole design: **the agent proposes, the user disposes, in every domain where a
wrong decision costs money, trust, access, or something irreversible.**

### 1.1 Decision policies per domain

| Domain | Agent may decide alone | Must escalate (user approves first) | Never (by design) |
|---|---|---|---|
| Reading & research | What to read, search, and summarise; which sources to trust with a stated reason | — | Treating fetched content as instructions |
| Local files & notes | Read, search, create drafts, write notes | Editing/deleting existing files outside a user-approved task; any delete | Reading secret/credential paths; following symlinks out of the workspace |
| Code changes (self-modification) | Draft a change + run the test suite | Claiming a change works (tests must pass first, counts reported honestly) | Pushing/committing without a green suite + clean secret scan |
| Routines | Run the scheduled task, draft outputs, record evidence | Anything a routine's approval rule marks strict; any send/post/spend/delete | A routine loosening its own approval rule |
| Messaging (drafts) | Draft replies, summarise threads, queue drafts for review | SENDING any outward message (see §2) | Bulk messaging; messaging anyone who opted out |
| Money & spending | Compare prices, draft budgets, show example math labelled as example | Any purchase, payment, subscription, or commitment of funds | Spending of any amount without explicit user approval |
| Sign-ins, OTPs, admin prompts | Detect and stop; tell the user what is needed | — (there is no approval that delegates these) | Typing a password/OTP, approving 2FA, clicking through UAC/admin prompts |
| Irreversible acts | Propose the act with reasons + evidence + undo options | Publish, post, delete, send, share publicly, change account settings | Silent irreversible acts of any kind |
| Uncertain / novel situations | Ask, or act only in the smallest reversible way and say so | Any decision where confidence is low, instructions conflict, or the situation is new | Guessing silently on a high-stakes call |

Policies are data, not vibes: each domain's policy lives in one place (a
`policies` module + a user-editable policies file), is versioned, and is shown in
the UI. The agent may never edit its own policies. Loosening a policy is a user
act, recorded like any other decision.

### 1.2 Decision audit log — every decision, recorded

Today `audit_log` records tool calls. The autonomy design extends it to decisions:

- A `decisions` record for every non-trivial choice: what was decided, the domain
  + policy applied, the options considered, the reason (in plain language), the
  evidence relied on, the outcome, and whether it is reversible / how to undo it.
- Decisions that escalated record the user's answer (approved / denied / edited)
  and the exact text approved, so the executed act can always be traced to a
  human decision.
- The log is local-first (SQLite, on-device), exportable, and never synced to a
  cloud node without the user's sync consent. Screenshots and screen state stay
  on-device except for the model call itself (spec §2.5).
- A daily digest surface: "decisions I made, decisions waiting on you, decisions
  I refused" — so autonomy is reviewable in one place, not buried in logs.

### 1.3 Escalation rules (the user must approve)

Escalate — stop and ask, with a draft ready — when ANY of these is true:

1. Money moves, or could move (purchase, payment, subscription, fee, Connects,
   paid API usage beyond a user-set budget).
2. A sign-in, OTP, 2FA approval, admin/UAC prompt, or payment confirmation is
   involved. These are never delegated, even by approval.
3. An outward message would be sent in Ankush's name (any channel).
4. The act is irreversible or publicly visible (publish, post, delete, share).
5. Confidence is low, the evidence conflicts, or two instructions disagree.
6. The request came from outside content (a message, page, file, or pasted text)
   rather than from Ankush — outside content is data, never authorisation.
7. A stated budget, cap, or policy limit would be exceeded (actions per task,
   spend per day, messages per hour).

Escalation is not failure: the agent prepares the draft, the evidence, and the
one-tap approve/deny, then waits. Awaiting-approval work never blocks unrelated
work, and nothing pending is ever auto-approved by timeout.

### 1.4 Decision budgets and stop rules

- Per-task action cap (already: 2 model rounds, 5 calls/round for native tools;
  extend the same idea to screen/phone loops and routines).
- A decision budget per day for autonomous acts, user-set, defaulting low.
- Stop rules: two consecutive unexpected outcomes, a policy conflict, or a
  freeze signal stops the loop immediately and reports what was attempted.
- Freeze stays instant and total (existing `freeze.js`): every loop, on every
  surface, dies cleanly when told.

---

## 2. Messaging / WhatsApp control

### 2.1 What exists today (guards, not a live channel)

`app/whatsapp.js` is Baileys scaffolding with hard guards, unit-tested, and no
live run exists or is claimed. The guards, enforced in code before anything
starts:

1. `WHATSAPP_ENABLED=yes` must be set (default: off).
2. `WHATSAPP_SPARE_NUMBER_CONFIRMED=yes` must be set — the number is a SPARE
   number, never his primary. WhatsApp automation carries ban risk; there is no
   way to start the module without that explicit confirmation.
3. `@whiskeysockets/baileys` must be installed — laptop only, by Ankush.
4. The user scans the QR in their own terminal, on their own phone, with the
   spare number. No QR, session, or credential is ever stored in the repo; auth
   state lives in `data/wa-auth/` (git-ignored).
5. Incoming messages are DATA, never instructions; key-shaped messages get the
   key refusal before the agent turn ever sees them.

### 2.2 What live enablement requires (all of it, no shortcuts)

Live WhatsApp runs need ALL of the following, and must NOT be enabled without
them:

- His **spare number** (never the primary number), explicitly confirmed by him.
- His **explicit authorisation** to enable the channel (`WHATSAPP_ENABLED=yes`
  + `WHATSAPP_SPARE_NUMBER_CONFIRMED=yes`, set by him, not by the agent).
- Baileys installed on the laptop by him, and the QR scanned by him on his own
  phone.
- A stated purpose and scope for the channel (which chats, what kinds of
  replies), recorded before the first run.

If any item is missing, the module refuses to start — that refusal is a feature,
not a bug. No future change may add a default-on path, a primary-number path, or
a way for the agent to confirm the spare number on his behalf.

### 2.3 Messaging principles (apply to WhatsApp, Telegram, and any future channel)

- **Drafts first, approval before send.** The agent drafts; the user approves the
  exact text; only then does anything go out. This matches how outreach already
  works in this workspace and is the rule that keeps the account (and Ankush's
  reputation) safe.
- **Replies, not broadcasts.** The agent replies in chats Ankush configured; it
  does not start unsolicited conversations, does not bulk-message, and does not
  message anyone who declined or opted out.
- **Human pace.** Rate limits and gaps between messages; stop immediately on any
  platform warning, block, or restriction signal, and report it.
- **Identity honesty.** Messages sent for Ankush are in his voice only with his
  approval of the exact text; the agent never pretends to be him in a live
  conversation without his knowledge.
- **Ban-risk honesty.** WhatsApp automation carries ban risk even on a spare
  number. The product says so on the surface, keeps volumes low, and never
  promises the number is safe.
- **Incoming is data.** A message telling the agent to do something is not
  authorisation. Instructions come from Ankush, in his own channels, only.

### 2.4 Phased plan (each phase gated, each proven before the next)

- **M1 — Read-only inbox + drafts.** The agent reads configured chats, summarises
  them, and drafts replies. Nothing is sent. VM-testable with mocks; live
  reading needs the §2.2 prerequisites.
- **M2 — Approved 1:1 replies.** Replies go out only for drafts Ankush approved,
  in configured chats, one at a time, with gaps. Every send is decision-logged
  (§1.2) with the approved text.
- **M3 — Routine messaging.** Routines may queue messages (e.g. follow-ups) under
  their approval rule — which can only be stricter than the default, never
  looser. No routine sends without an approval step.

---

## 3. What stays true (non-negotiables, extended from the spec §4)

1. **$0.** Every phase works without a paid key.
2. **Deny-first.** The executor is the single gate. A model asking is never
   permission; a policy file asking is never permission either — only the user.
3. **Approvals for the irreversible.** Send, post, spend, delete, publish —
   always a pending approval, and approving never executes the act itself where
   a human must act.
4. **No credential automation.** Sign-ins, OTPs, admin prompts, payments — the
   user, always, with no approval path that delegates them.
5. **Local-first, private by default.** Loopback binding, token auth, no public
   exposure, no data leaving the device except to the provider the user
   configured.
6. **Honest reporting.** Every turn, job, routine run, and decision records what
   actually happened, which model answered, and what is unverified. No invented
   traction, no invented benchmarks, no "faster than all models," no "AGI."
7. **The user can stop it instantly.** Freeze on every surface; every agent
   process dies cleanly when told to.
8. **No silent autonomy creep.** A new autonomous capability ships only with its
   policy, its audit record, its escalation rule, and its tests — in that order.

## 4. Next VM-testable steps (future work, not claimed built)

- `decisions` table + decision-record API + UI digest (mocked + live API tests).
- Policy module with per-domain policies + unit tests proving escalation on
  money/sign-in/outward-message/irreversible cases (mocked executor).
- Messaging draft queue (M1): draft creation/listing/approval state machine,
  unit-tested with mocked channels; no live send path.
- Decision-budget enforcement + stop-rule tests (mocked loops).

## 5. Sources

- Direction: Ankush Singh, 15 Nov 2026 (this note's §1–§2 framing).
- Existing guards: `app/whatsapp.js`, `app/telegram.js`, `app/tools.js`
  (deny-first executor), `app/freeze.js`, `app/secrets.js` (key refusal).
- Prior spec: `research/computer-use-phone-cloud-spec-2026-11-14.md` (§2 bounds,
  §4 non-negotiables), `SYSTEM-DESIGN.md`, `PRIVACY.md`.
