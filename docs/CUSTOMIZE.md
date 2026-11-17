# Customize Piplet by talking to the agent

Piplet is open source, and the agent helps you change it while you talk
to it. You ask for a behaviour change in plain words; the agent reads
the code, drafts the change, and verifies it with the tests — but
**edits to the app's own code are made by you, the human, in your
editor** (see the note below). Two gates never move: **deny-first**
(the agent can only use the allowlisted tools) and **tests-must-pass**
(a change is not done until the suite passes).

> **Why the agent cannot edit app code (audit fix, 18 Nov 2026).**
> Tool writes to the `app/` directory — code, tests, and the served
> frontend — are refused (`assertWritablePath` in `app/tools.js`). The
> `run_tests` tool executes the test script, so if the agent could
> rewrite that script or the tests, a single bad turn could reach
> arbitrary code execution, or overwrite the frontend for stored XSS +
> token theft. The agent may still *read* app code to reason about it,
> and it may write workspace files outside `app/` (notes, docs,
> routines, memory). The skills approval manifest and git hooks are
> likewise human-only. Code changes stay human-applied, agent-verified.

## The flow

1. **Ask.** In the chat (web UI, Telegram, or a routine), describe the
   change: "make the chat reply shorter", "add a routine that checks
   the queue every morning", "change the default provider order",
   "make the status page show the replay count".
2. **The agent reads first.** It uses `read_file` / `search_files` to
   find the code that owns the behaviour, instead of guessing.
3. **The agent drafts.** It describes the exact change (file, old text
   → new text) in chat, or writes the draft as a note / workspace file
   outside `app/` for you to review. For non-code changes — routines,
   notes, docs, provider order, memory facts — it applies the change
   directly with its tools.
4. **You apply code changes.** Paste the agent's draft into your editor
   (or edit it yourself). The agent cannot write `app/` files, by
   design — see the note above.
5. **The agent runs the tests.** `run_tests` executes the full suite
   (`tests/run-tests.sh`) on a separate port and returns pass/fail
   counts. The agent MUST run it before claiming the change works, and
   MUST report the counts honestly — including failures.
6. **The agent reports.** What changed, what behaviour changed, and the
   test result. If tests fail, the agent says so and either drafts a
   fix (for you to apply, then it re-runs the tests) or explains what
   blocked it.
7. **You review and commit.** The agent does not commit or push — the
   shell allowlist has read-only git commands only (`git status`,
   `git diff --stat`). You review with `git diff`, and commit when
   you are happy. The pre-push hook scans for secrets before any push.

## What the agent will refuse to change

The safety gates are not customizable by talking to the agent. It must
refuse any request to:

- Remove or weaken token auth, loopback binding, rate limits, CSP,
  input validation, or the secret scans.
- Add a send/post/spend/delete/publish tool, a submit action in the
  browser, a shell escape hatch, or any credential/OTP/payment
  automation.
- Weaken the deny-first executor, the approval flow, or the freeze.
- Put a key, token, or secret into code, docs, chat, or a file.
- Skip the tests, or claim success with failing tests.
- Write to the app's code, tests, served frontend, skills manifest,
  or git hooks — these are refused by the write gate, not just by rule.

If you genuinely want to change one of those as the repo owner, edit
the code yourself in your editor, run the tests and the security
checks, and commit — the agent will not do it for you, by design.
That restriction is what makes "open source, change it by talking"
safe: the agent can propose behaviour changes, but it cannot change
the rules that keep it safe, or the code that enforces them.

## What changes well this way

- Prompt wording, reply style, default provider order, routine
  schedules, notification text, UI labels and panels, new notes or
  documentation, new read-only tools that fit the existing patterns.
- Anything with a test: if you ask for a new behaviour, ask the agent
  to draft a test for it too — "add a test that proves it" is part of
  the flow, not an extra.

## Example

> You: "When a routine finishes, leave a notification saying it ran."
>
> Agent: reads `routines.js` and `server.js`, drafts the `notify` call
> for the routine runner plus a unit test, and shows you the exact
> text. You paste it into your editor. The agent runs `run_tests`
> (223 pass) and reports: "Draft applied to `app/server.js`
> routineRunner + test in `app/tests/product.test.js`. Tests: 223
> pass, 0 fail. Review with `git diff`."
