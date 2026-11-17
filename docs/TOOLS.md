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

## 2. Chat tools (24) — `tools.js` + `brain.js` declarations

| Tool | What it does | Gate |
|---|---|---|
| `list_files` | List a workspace directory | Workspace-confined, symlinks refused |
| `read_file` | Read a workspace file (20k chars) | Secret/DB paths denied |
| `write_note` | Save a note to memory | — |
| `edit_file` | Exact old→new replacement, `.bak` backup first | Workspace-confined |
| `create_file` | Create a NEW file (refuses if it exists) | Workspace-confined, 100KB cap |
| `search_files` | Content search in the workspace | Skips node_modules/.git/data, 500 files / 20 matches |
| `search_notes` | Search saved notes | — |
| `web_fetch` | Fetch an https page, text only (5k chars) | Public URLs only, no private IPs, every redirect hop re-validated (max 3) |
| `create_approval` | Record a DRAFT approval request (action + exact details) | Draft only — approving never executes; a human sends/posts/spends |
| `file_info` | Metadata for one file/dir: type, size, modified, line count | Read-only, no contents, secret paths denied |
| `append_file` | Append 1..10KB to an EXISTING file | Workspace-confined; refuses new files (use `create_file`) |
| `recent_activity` | Last 1..20 audit-log rows, newest first | Read-only, args/results truncated; local-only log |
| `run_command` | One of 7 read-only commands | Exact argv, `execFile`, no shell |
| `run_tests` | Run the full test suite on port 3199, return pass/fail | One run at a time; required before claiming a self-modification works |
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

## 6. Deliberately left out — and why

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
| Arbitrary shell commands | `run_command` is 7 exact read-only commands. A shell escape hatch (Open Interpreter / Codex style) is the single biggest blast radius in an agent; we do not ship one. |
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

## 7. Evidence note — small local models and tool use

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
