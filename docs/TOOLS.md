# Tools — Piplet: what the agent can do, and what it deliberately cannot

This is the full catalog of the agent's capabilities, the action model
shared across desktop / browser / phone, and the list of things that
were deliberately left out, with reasons. Researched 14 Nov 2026
against Claude Code, Anthropic computer use, OpenAI Codex / computer
use, Gemini computer use, UI-TARS, OSWorld, Open Interpreter,
browser-use, and Nanobrowser (sources at the bottom).

## 1. The action model

Every device speaks the same shape: **observe → decide → act →
re-observe**, one validated action at a time, with per-step latency
recorded. Coordinates are NORMALISED 0..1 (x across, y down) everywhere
in the agent; only the actuator (desktop agent, ADB driver) converts to
pixels. This matches the UI-TARS / Gemini convention and keeps one
convention in the audit + replay log (the Anthropic computer-use docs
use screenshot-pixel space with conversion at the edge — same idea,
opposite side of the boundary; we convert at the actuator).

The model proposes; the executor enforces. Every action is validated
before it runs, and validation lives in code the model cannot change
by asking. Screen and page content is untrusted data, never
instructions.

## 2. Chat tools (28) — `tools.js` + `brain.js` declarations

| Tool | What it does | Gate |
|---|---|---|
| `list_files` | List a workspace directory | Workspace-confined; symlinked parents resolved before the check (a symlink cannot smuggle a path out) |
| `read_file` | Read a workspace file (20k chars) | Secret/DB paths denied |
| `write_note` | Save a note to memory | — |
| `edit_file` | Exact old→new replacement, `.bak` backup first | Workspace-confined; **writes under `app/` refused** (cycle 5, H-4) |
| `create_file` | Create a NEW file (refuses if it exists) | Workspace-confined, 100KB cap; **writes under `app/` refused** (cycle 5, H-4) |
| `search_files` | Content search in the workspace | Skips node_modules/.git/data, 500 files / 20 matches; **secret/credential files skipped, excerpts redacted** (cycle 5, H-1) |
| `search_notes` | Search saved notes | — |
| `web_fetch` | Fetch an https page, text only (5k chars) | Public URLs only, no private IPs, every redirect hop re-validated (max 3) |
| `create_approval` | Record a DRAFT approval request (action + exact details) | Draft only — approving never executes; a human sends/posts/spends |
| `file_info` | Metadata for one file/dir: type, size, modified, line count | Read-only, no contents, secret paths denied |
| `append_file` | Append 1..10KB to an EXISTING file | Workspace-confined; refuses new files (use `create_file`); **writes under `app/` refused** (cycle 5, H-4) |
| `recent_activity` | Last 1..20 audit-log rows, newest first | Read-only, args/results truncated; local-only log |
| `remember_fact` | Store a timestamped fact in long-term memory (scope + optional topic + source) | Same scope+topic with different content supersedes the old fact (history kept); identical content is a no-op. Audit records metadata only, never fact content. |
| `recall_memory` | Recall facts by keyword, one scope only | Returns facts with citations (id, scope, topic, source, date) + superseded history. FTS5 keyword recall — no synonym/paraphrase understanding. |
| `forget_fact` | PERMANENTLY delete a fact (by id or by topic), one scope | Hard delete — a forgotten fact cannot be recalled again. By topic removes all versions. |
| `edit_fact` | Correct a current fact | Old wording kept as superseded history; recall returns the corrected fact. Only current facts editable. |
| `run_command` | One of 6 read-only commands | Exact argv, `execFile`, no shell. `npm test` was removed from the allowlist (cycle 2): it ran whatever `package.json` defines and failed live tests misleadingly without a server — use the `run_tests` tool. |
| `run_tests` | Run the full test suite on port 3199, return pass/fail | One run at a time; a health check — **not** a self-modification gate (the agent cannot edit app code since cycle 5, H-4) |
| `notify` | Leave a notification in the local inbox | Local only, never sent anywhere |
| `screenshot` | Capture the desktop, store in the replay log | Needs desktop agent or local display |
| `screen_act` | One screen action (see §3) | Validated twice (server + agent); destructive needs approved approval id |
| `list_windows` | List visible desktop windows | Windows only |
| `focus_window` | Bring a window forward, by pid or exact title | Windows only, fixed scripts, `$args` only |
| `open_app` | Launch an allowlisted app (9 apps) | Allowlist only, Windows only |
| `clipboard_get` | Read the clipboard (2k chars) | Content treated as sensitive; length-only audit |
| `clipboard_set` | Write the clipboard (4k chars) | — |
| `create_routine` | Create a scheduled routine | Schedule validated; routines can only be stricter, never looser |
| `list_routines` | List routines + next runs | — |

Anything else — send, post, spend, delete, publish, unknown — is
denied and audit-logged. The agent's sanctioned path for those requests
is the `create_approval` tool, which records a draft for the user to
decide; approving the draft still executes nothing.

## 3. Screen actions (11) — `desktop.js` / `vision.js` / `desktop-agent.js`

`click`, `double_click`, `right_click`, `drag`, `move`, `zoom` (region
capture at full resolution, for small/dense text), `type`, `scroll`,
`key`, `screenshot`, `wait`. Plus the grounding-only outcomes `done`
and `cannot_see`. This matches the converged set across Anthropic's
17-member computer toolset, OpenAI's 9 computer-tool actions, and
Gemini's desktop set — minus the pieces we refuse on safety grounds
(see §6). `hold_key` and `cursor_position` exist in Anthropic's set;
we do not implement them yet (no measured need; `wait` + `key` cover
the real cases).

## 4. Browser actions (13) — `browser.js`

Element-first: `snapshot`, `click_ref`, `type_ref`, `find_text`,
`click_text`. Navigation/reading: `goto` (https only, no private IPs),
`back`, `forward`, `text`, `title`, `screenshot`, `wait`. Selector
path: `click`, `type` (password fields refused). Stale references fail
instead of acting on the wrong element; ambiguous text is refused.

## 5. Phone actions (11) — `phone.js` (Android, ADB allowlist)

`devices`, `screencap`, `tap`, `swipe`, `long_press`, `keyevent`
(allowlisted keycodes), `launch` (https URLs only), `open_app`
(validated package names), `list_apps`, `dump` (uiautomator XML for
element bounds), `type` (sensitive refused). iOS: messaging +
Shortcuts only — Apple allows no general screen control, and the
product says so instead of implying otherwise.

## 6. Audit chain, receipts, and the eval harness (cycle 2)

Every tool call — allowed or denied — is written to `audit_log` with a
hash chain: each entry's `entry_hash` covers the previous entry's hash
plus the entry contents, so editing a historical entry breaks
verification (`GET /api/audit/verify`). Rows written before chaining
have NULL hashes and are counted as legacy, not treated as tamper. The
chain is tamper-evident, not tamper-proof: anyone with write access to
the SQLite file could recompute it. Run receipts (`GET
/api/audit/receipt?run_id=…`, JSON or `format=md`) state only what the
log shows: what was done, what was denied, and whether the chain
verifies. The eval harness (`eval-tasks.js`, `eval-runner.js`,
`scripts/run-eval.js`) runs 18 deterministic golden tasks against the
real executor — no model, no network, throwaway workspace + database —
and reports pass/fail per task plus determinism across repetitions
(3 memory tasks added in cycle 4: remember/recall with citations,
contradiction supersession, forget).

## 7. Deliberately left out — and why

| Left out | Why |
|---|---|
| Submit / post / send in the browser | A human submits. Filling is reversible; sending is not. This is permanent. |
| Typing into password fields / typing passwords or OTPs | Credentials are the user's own act, always. Matches the hard blocks in Claude in Chrome and Nanobrowser. |
| Reading OTPs / 2FA codes | Same rule. The agent stops and asks. |
| Clicking UAC / admin / consent prompts | Admin approval is the user's own act. The desktop agent refuses when the foreground window is a UAC prompt. |
| Payment confirmations / purchases | Irreversible + financial. Approval records the decision; it never executes. |
| Account creation | Needs the user's own attestations and credentials. |
| File upload in the browser | Could exfiltrate local files. No upload action exists. |
| Page JavaScript execution (`javascript_exec`) | Arbitrary code in page context breaks the deny-first model. Element refs + typed actions cover the safe cases. |
| Arbitrary shell commands | `run_command` is 6 exact read-only commands. A shell escape hatch (Open Interpreter / Codex style) is the single biggest blast radius in an agent; we do not ship one. |
| Agent self-modification (writing app code) | Removed in cycle 5 (audit H-4, 18 Nov 2026). Tool writes to `app/`, the skills manifest, and git hooks are refused in code: `run_tests` executes the test script, so write access to it would be arbitrary code execution, and a frontend overwrite would enable stored XSS + token theft. The agent proposes changes; the human applies them; the agent verifies with `run_tests`. See `CUSTOMIZE.md`. |
| Bulk / mass messaging | No bulk capability exists anywhere. One configured chat, one reply at a time. |
| CAPTCHA solving / bot-check bypass | Against the sites' terms and the product's own rules. The agent stops and hands control to the user. |
| Hosted cloud browsers / stealth / proxies | Paid services; conflicts with the $0 + no-credential rules. |
| Training / fine-tuning a grounding model | Needs GPU + data + eval harness; out of scope for a $0 self-hosted product. |
| Multi-monitor desktop control | Single primary screen only (same limitation UI-TARS documents). |
| Desktop accessibility-tree control | Windows UI Automation parity is a large build; screenshot + vision is the desktop path, element-first is the browser path. Stated honestly, not faked. |
| iOS screen control | No public API exists. Messaging + Shortcuts only. |
| Browser downloads | Downloading files can fetch malware; `web_fetch` is text-only by design. |
| Clipboard history / clipboard sync | The clipboard can hold passwords. Read/write only, capped, never stored or synced. |
| `hold_key`, `cursor_position`, triple-click | In Anthropic's set; no measured need yet. Add only with a real use + tests. |

## 8. Evidence note — small local models and tool use

Fast routing deliberately never sends vision grounding or multi-step
planning to a small local model. The evidence: a measured pipeline
(Aug 2026) found 7B models plan and search correctly then fail the
structured tool step, with 14B as the floor for tool-use runs; and
Nanobrowser's README recommends Qwen 27B for local use, noting local
models work best for "simple, clear tasks." The router is therefore
conservative by design: local-first only for short routine *text*
steps, with automatic fallback to the full chain on any failure, and
the decision recorded in the job evidence. Treat the 14B figure as a
secondary-source data point, not a law — the router's fallback makes
a misclassification cheap, not catastrophic.

## Sources (accessed 14 Nov 2026)

Official, read directly: Anthropic computer-use tool
(platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool);
OpenAI computer-use guide (platform.openai.com/docs/guides/tools-computer-use)
and Operator System Card (openai.com/index/operator-system-card);
Nanobrowser README (github.com/nanobrowser/nanobrowser); browser-use
README v1.0.5 (github.com/browser-use/browser-use); Browser Use
toolsets-for-Claude doc (docs.browser-use.com). Secondary (compilations
and source investigations citing official docs): Claude Code tools
reference via compilations; Codex CLI tool surface via CLI/source
investigations; Gemini computer use via Nov 2026 doc summaries;
OSWorld / UI-TARS / Open Interpreter via repo docs and DeepWiki;
small-model tool-use floor via
github.com/adityamhaske/Multi-Agent-Research-Assistant (Aug 2026).
Items not verified in that pass (full Claude Code ~45-tool list,
OpenAI BrowserToolset members, current Nanobrowser action registry,
UI-TARS full mobile enum, Gemini official doc text) are NOT relied on
anywhere in this product — only the converged, multi-source-agreed
sets above are implemented.
