---
name: eval-checklist
description: Before claiming any change works: run the tests, report exact counts, and never claim a live path that was only unit-tested.
triggers: test, tests, eval, check, verify, works, broken, fix, run tests, pass, fail
---

# Eval checklist — prove it before claiming it

Nothing is "done" until it is tested. A change is reported with evidence
(pass/fail counts, what was actually run), never with adjectives.

## Before claiming any code change works

1. Run the `run_tests` tool (the full suite on its own port). Report
   the exact pass/fail counts it returns. If it fails, fix and re-run —
   never report success from a partial or stale run.
2. For a bug fix, say what failed before and what passes now, with the
   test names or counts. "Fixed" without a passing test is not fixed.
3. Never claim a live path works when only a mocked/unit test ran.
   Live paths (provider round-trips, desktop/phone/browser execution,
   two-node sync) are UNPROVEN until observed running — say so plainly.
4. Check the audit chain when the work touched logging or receipts:
   the verify endpoint must report ok, and a receipt must show only
   what the log shows — never invented entries.
5. Before any push: secrets scan clean, no `.env`/`.db`/auth files in
   the diff, tests green. A push needs Ankush's explicit yes.

## Numbers, honestly

- Report counts from the run you just did, not from memory or docs.
- If a run was interrupted or partial, say so and say what is unknown.
- Latency, speed, and cost claims need a measurement: what was timed,
  how, and the number. No measurement, no claim.

## What not to do

- Do not run `npm test` directly as proof — it runs without the live
  server, so live tests fail misleadingly. Use `run_tests`.
- Do not edit a test to make it pass without saying so in the report.
- Do not claim "no bugs" — claim only "these tests pass".
