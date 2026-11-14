# TEST-REPORT — Ankush's Personal AI app (full stack, wired up)

## Latest run — 14 Nov 2026, ~16:30 IST (this VM)
- Command: `bash tests/run-tests.sh` (starts the live server on 127.0.0.1:3100, runs `node --test tests/test.js tests/providers.test.js tests/phases.test.js`, stops it)
- Node: v24.22.1, Express 5.3.0, Playwright 1.65.1 + Chromium headless shell 159.0.8154.6, Ollama 0.40.16 (qwen3:0.6b)
- **Result: 71 passed, 0 failed, 0 skipped, exit 0, 27.0 s** (22 live-server Phase A tests + 12 mocked provider unit tests + 37 new Phases B–E tests)

New in this run: Phases B–E built from `research/computer-use-phone-cloud-spec-2026-11-14.md` — screen vision (`vision.js`, Gemini/OpenAI/Anthropic image input + grounded-action parsing), screen capture (`screen.js`), desktop control (`desktop.js` + laptop-only `desktop-agent.js`, PowerShell/.NET, loopback + token), phone control (`phone.js`, ADB allowlist + per-session enable + iOS honestly labelled), Telegram bot (`telegram.js`, polling, chat-locked), WhatsApp scaffolding (`whatsapp.js`, guards only — spare-number confirmation mandatory), browser use (`browser.js`, Playwright, no submit action), offline queue (`queue.js`, SQLite outbox, backoff 1m/5m/15m/1h/6h, stale-claim sweep), sync (`sync.js`, last-write-wins, conflicts surfaced), routines (`routines.js`, daily/interval schedules, run lock, missed policy), freeze (`freeze.js`, persisted instant-stop), and the server wiring + frontend panels (freeze button, queue, routines). New tests #35–71 (`tests/phases.test.js`): 28 unit tests (mocked fetch / injected drivers) + 9 live API tests. **Live-proven on this VM:** browser launch + render + read + screenshot (real Chromium, local page, 1.9 s); queue persistence across a new DB connection (restart survival); routine tick + lock + dry run; sync push/pull round-trip; freeze persistence. **UNPROVEN live (no key / desktop / phone / second node here):** vision round-trips (mocked fetch only), desktop-agent execution (Windows-only, refuses to start on Linux), ADB control (no device), Telegram/WhatsApp live runs (no token/number), two-node sync (merge logic unit-tested, endpoints live-tested single-node), external browser `goto` (VM egress proxy rejects Chromium CONNECT tunnels — launch + local render proven; `goto` works on the laptop, no proxy there). Failures found and fixed in this loop: (1) `queue.enqueue` with `maxAttempts: 0` silently defaulted to 5 — now validated; (2) `routines.runRoutine` double-parsed an already-parsed schedule (`"[object Object]" is not valid JSON`) — schedule normalised once; (3) a vision test read the wrong mocked-fetch call array. Security checks re-run same session: **ALL PASS** (21 checks + npm audit skipped — endpoint unreachable from this VM, as before; checks extended to the new modules: desktop-agent loopback, WhatsApp guards, sensitive-action refusal, freeze checks, wa-auth git-ignore).

Measured latencies this run (VM numbers, not laptop numbers — the thinking step is model-bound, per spec §2.1): Ollama qwen3:0.6b turn 10.2 s; Gemini chat turn (helper) 11.8 s; browser launch + render + read + screenshot 1.9 s; screenLoop step latencies are recorded per step (capture/ground/act ms) in the loop result. No "faster than all models" claim is made anywhere — the speed design (small local model for routine steps, frontier only for plan/recover/judge) is in the spec, and the loop measures rather than promises.

## Earlier run — 14 Nov 2026, ~00:30 IST (this VM)
- Command: `bash tests/run-tests.sh` (starts the live server on 127.0.0.1:3100, runs `node --test tests/test.js tests/providers.test.js`, stops it)
- Node: v24.22.1, Express 5.3.0, Ollama 0.40.16 (binary reinstalled to `~/ollama` this session — the VM replacement had wiped it; the qwen3:0.6b model blobs survived in `~/.ollama`)
- **Result: 34 passed, 0 failed, 0 skipped, exit 0, 22.9 s** (22 live-server tests + 12 mocked provider unit tests)

New in this run: Phase A multi-provider brain (Ankush's 14 Nov direction — any API key works, not Gemini-only). `brain.js` is now a provider registry with configurable chain order (`BRAIN_PROVIDERS`, providers with no key skipped); new `openai` provider (OpenAI API + any OpenAI-compatible base URL) and `anthropic` provider (Messages API), keys from env only. New tests #23–34 (`tests/providers.test.js`, mocked fetch): request shapes, response parsing, chain order/fallback, key handling, no-key-leak checks, agentLoop fallback to the configured chain. **The OpenAI/Anthropic paths are unit-tested-only — no live round-trip proven, no key on this VM.** Live-verified paths remain the Gemini VM helper (gemini-3.5-flash-lite) and Ollama (qwen3:0.6b, 17.1 s this run). Deny-first tools, native Gemini function calling, and the JSON fallback are unchanged and still passing. Security checks re-run same session: **ALL PASS** (15 checks; npm audit skipped — endpoint unreachable from this VM, as before; secret scan extended with Anthropic/OpenAI key patterns).

## Earlier run — 13 Nov 2026, ~19:30 IST (this VM)
- Command: `bash tests/run-tests.sh` (starts the live server on 127.0.0.1:3100, runs `node --test tests/test.js`, stops it)
- Node: v24.22.1, Express 5.3.0
- **Result: 22 passed, 0 failed, 0 skipped, exit 0, 17.2 s**

New in this run: native function calling (Gemini `functionDeclarations` wired to the deny-first tools, max 2 rounds / 5 calls per round, all checks still in tools.execute; text+JSON fallback kept for the VM-helper/Groq/Ollama paths). New tests #19–22: declarations mirror the allowlisted tools exactly (and no send/post/spend/delete tool is declared); function-call responses parse into validated calls; malformed/undeclared calls are dropped; agentLoop returns the text+evidence shape on the fallback chain. Live chat test answered via `gemini-vm-helper` (gemini-3.5-flash-lite) — no GEMINI_API_KEY on this VM, so live end-to-end native calling is NOT yet proven; it needs his key on the laptop (direct REST path). Security checks re-run same session: **ALL PASS** (npm audit skipped — endpoint unreachable from this VM, as before).

## Earlier run — 12 Nov 2026, ~02:05 IST (this VM)
- Command: `bash tests/run-tests.sh` (starts the live server on 127.0.0.1:3100, runs `node --test tests/test.js`, stops it)
- Node: v24.22.1, npm 10.9.4, Express 5.3.0
- **Result: 18 passed, 0 failed, 0 skipped, exit 0, 10.4 s**

New in this run vs the 17-test run: audit Medium fixes — Gemini key now sent via `x-goog-api-key` header (not URL query), SQLite DB files blocked from `read_file`, timing-safe token compare, stricter CSP (`object-src 'none'`, `base-uri 'self'`, no `unsafe-inline`), concurrency cap of 2 on `/api/chat`, generic brain-failure error (upstream text no longer returned verbatim). New test #18 (DB read blocked) passes.

## Earlier runs
- 12 Nov ~01:50 IST: **17 passed, 0 failed, 17.2 s**
- 12 Nov ~01:30 IST: **13 passed, 0 failed, 33.2 s** (before edit_file/web_fetch/memory/parallel-tools)

| # | Test | Model / evidence |
|---|---|---|
| 1 | health: server is up, no auth needed | 200, `{"ok":true,"service":"ankush-personal-ai"}` |
| 2 | cyber: auth rejected without token | 401 |
| 3 | cyber: auth rejected with wrong token | 401 |
| 4 | status: brain order + wired components | brain order listed, OpenClaw gateway up (200), goose 1.59.0 reported |
| 5 | brain: Gemini primary answers for real | **gemini-3.5-flash-lite** (Lite-first order, 12 Nov), provider `gemini-vm-helper`, 0.98 s, text contains OK |
| 6 | brain: Ollama local fallback answers for real | **qwen3:0.6b**, provider `ollama`, 12.4 s |
| 7 | chat: perceive → reason (Gemini) → act, job + message in SQLite | Gemini, job `done`, message persisted with model recorded |
| 8 | tools: read_file + write_note | AGENT.md read, note persisted with id |
| 9 | cyber: path traversal blocked | `../../etc/passwd` → 403 |
| 10 | cyber: secret file blocked | `.env.local` → 403 |
| 11 | cyber: dangerous shell denied | `rm -rf /` → 403, never executed |
| 12 | cyber: send/post denied — approval only | `send_email` → 403; approval created pending; approving it → `executed: false` |
| 13 | tools: edit_file with backup | edit applied, `.bak` created, content verified, files cleaned up |
| 14 | tools: web_fetch reads a real https page | `https://example.com` → "Example Domain", 0.33 s |
| 15 | cyber: web_fetch blocks private URLs | `http://127.0.0.1:3100/...` → 403 |
| 16 | cyber: symlink escape blocked (H2 regression) | symlink `tests/_link-test.txt -> /etc/passwd` → 403 |
| 17 | frontend: index page served | 200, contains "Ankush's Personal AI" |

## Earlier run — 12 Nov 2026, ~01:30 IST
- **13 passed, 0 failed, 33.2 s** (before edit_file/web_fetch/memory/parallel-tools were added; Ollama took 24.9 s then).

## Failures found and fixed in this loop (build → test → debug → test again)
1. **SyntaxError in tools.js** — adding `edit_file`/`web_fetch` accidentally deleted the `case 'run_command':` header; server would not start. Fixed by restoring the header; `node --check` added to the loop.
2. **Ollama test timed out at 120 s** — OpenClaw gateway running in the background was hammering Ollama with ~15k-token prompts, starving the app. Root cause: this VM (1.5 shared CPUs, 6 GB) cannot run OpenClaw + the app + Ollama at once. Fix: stop the gateway during app tests (documented in STATUS.md); Ollama test then took 12.4 s. On the laptop (16 GB) they can run together.
3. **Security-check script false positives** — it flagged the `.env.local` token itself, and comments containing `0.0.0.0` / `exec()`. Fixed to exclude git-ignored files and comments/SQLite `db.exec`.
4. **Security audit H1–H5 (12 Nov, independent sub-agent audit)** — all fixed, see `tests/security-audit-2026-11-12.md`:
   - H1 Node patch floor (CVE-2026-111497): startup guard + `engines >=24.22.1 <25` + `.nvmrc` 24.22.1 + Express pinned to 5.3.0 exact.
   - H2 Symlink escape in `safePath`: refuse symlinks, re-check real path, skip symlinked entries in `list_files` + regression test #16.
   - H3 Predictable temp prompt file: `mkdtemp` + mode 0600 + cleanup.
   - H4 Token generation truncated `.env.local`: now appends, preserving existing keys.
   - H5 Rate limit only on 2 routes: now all `/api` routes (60/min) + `/api/brain/test` stricter (10/min).

## Security checks — 12 Nov 2026, ~01:45 IST
`bash scripts/security-check.sh` → **ALL PASS** (15 checks). npm audit skipped on this VM (audit endpoint unreachable — re-run on the laptop).

## Model tests — what was actually used
- **Gemini:** `gemini-3.5-flash-lite` (primary, Lite-first) and `gemini-3.6-flash` (fallback) — both answered for real via the connected Gemini API helper. `gemini-3.8-flash` tested 12 Nov: **503 high demand** (same as 10 Nov) — not used. `gemini-2.5-flash`: 404, never used.
- **Groq:** NOT tested — no free key was created (Ankush creates it himself at console.groq.com, no card). Code path exists in `brain.js`, provider `groq`, model `openai/gpt-oss-120b`.
- **OpenAI / Anthropic:** NOT live-tested — no key exists on this VM. Code paths exist in `brain.js` (providers `openai`, `anthropic`), covered by mocked-fetch unit tests only (`tests/providers.test.js`). Test on the laptop with `POST /api/brain/test {"provider":"openai"}` / `{"provider":"anthropic"}` once a key is in `.env.local`.
- **Ollama:** `qwen3:0.6b` on this VM — answers short prompts in 12–25 s, too small for agent tool-calling (proven 11 Nov). Laptop model is `qwen3:8b` (or `qwen3-coder:30b` per efficiency research, if RAM allows).
- **OpenCode 1.19.5:** installed, CLI works (`--version` → 1.19.5). A run with `ollama/qwen3:0.6b` produced no output in 90 s on this VM — same limit as goose, needs 8B/Gemini on the laptop.
- **OpenClaw 2026.11.3:** reinstalled, gateway dashboard HTTP 200 on 127.0.0.1:18789. Agent turns with `qwen3:0.6b` cannot complete on this VM (~15k-token base prompt, CPU prefill ~5 min, idle timeout) — proven 11 Nov, see `../tests/job4-gateway-local.md`. Laptop (16 GB, qwen3:8b, Gemini brain) should do it in 1–2 min.

## Proof project (separate, built in parallel)
- `projects/proof-internship-tracker/` — Internship Tracker, full stack, **9/9 tests passing** (verified by re-running `npm test` myself, 12 Nov ~01:45 IST, 6.0 s). See its `TEST-REPORT.md`.

## What is NOT yet proven
- Native function calling live end-to-end (needs GEMINI_API_KEY on the laptop — direct REST path; parser + declarations are unit-tested and the fallback is proven live, but no live functionCall round-trip has run yet).
- OpenAI / Anthropic live round-trips (unit-tested with mocked fetch only; need a key on the laptop).
- Vision round-trips (Gemini/OpenAI/Anthropic image input — mocked fetch only; need a key + a screen on the laptop).
- Desktop-agent execution (Windows-only; refuses to start on this VM; needs the laptop + `node desktop-agent.js`).
- ADB phone control (no device on this VM; needs his Android phone + authorised debugging).
- Telegram/WhatsApp live runs (need his bot token / spare number; guards + command handling unit-tested).
- Two-node sync (merge logic unit-tested, push/pull endpoints live-tested single-node; needs the Oracle cloud node).
- External browser `goto` on this VM (egress proxy rejects Chromium CONNECT tunnels; launch + local render + read + screenshot proven live; `goto` needs the laptop).
- Groq fallback (no key), Oracle cloud 7-day uptime (Phase 6, after Phase 5), OpenClaw agent turn with Gemini brain (needs his key on the laptop), OpenCode/goose coding job with qwen3:8b/Gemini (needs the laptop model).
