# Customize Piplet by talking to the agent

Piplet is open source, and the agent can change it while you talk
to it. You ask for a behaviour change in plain words; the agent edits
the code, runs the tests, and reports what changed. Two gates never
move: **deny-first** (the agent can only use the allowlisted tools) and
**tests-must-pass** (a change is not done until the suite passes).

## The flow

1. **Ask.** In the chat (web UI, Telegram, or a routine), describe the
   change: "make the chat reply shorter", "add a routine that checks
   the queue every morning", "change the default provider order",
   "make the status page show the replay count".
2. **The agent reads first.** It uses `read_file` / `search_files` to
   find the code that owns the behaviour, instead of guessing.
3. **The agent edits.** `edit_file` (exact old→new, with a `.bak`
   backup written first) or `create_file` (new files only). Edits stay
   inside the workspace; secret paths are denied.
4. **The agent runs the tests.** `run_tests` executes the full suite
   (`tests/run-tests.sh`) on a separate port and returns pass/fail
   counts. The agent MUST run it before claiming the change works, and
   MUST report the counts honestly — including failures.
5. **The agent reports.** What file changed, what behaviour changed,
   and the test result. If tests fail, the agent says so and either
   fixes the change (and re-runs the tests) or leaves the code as it
   found it and explains what blocked it.
6. **You review and commit.** The agent does not commit or push — the
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

If you genuinely want to change one of those as the repo owner, edit
the code yourself in your editor, run the tests and the security
checks, and commit — the agent will not do it for you, by design.
That restriction is what makes "open source, change it by talking"
safe: the agent can change behaviour, but it cannot change the rules
that keep it safe.

## What changes well this way

- Prompt wording, reply style, default provider order, routine
  schedules, notification text, UI labels and panels, new notes or
  documentation, new read-only tools that fit the existing patterns.
- Anything with a test: if you ask for a new behaviour, ask the agent
  to add a test for it too — "add a test that proves it" is part of
  the flow, not an extra.

## Example

> You: "When a routine finishes, leave a notification saying it ran."
>
> Agent: reads `routines.js` and `server.js`, adds a `notify` call in
> the routine runner, adds a unit test, runs `run_tests` (113 pass),
> and reports: "Changed `app/server.js` routineRunner + added a test
> in `app/tests/product.test.js`. Tests: 113 pass, 0 fail. Review with
> `git diff`."
