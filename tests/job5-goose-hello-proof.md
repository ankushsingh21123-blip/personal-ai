# Job 5 — goose hello-proof build (local Ollama brain)

**Date:** 11 Nov 2026, ~10:30–10:45 UTC (16:00–16:15 IST)
**Setup:** goose 1.59.0, provider ollama, model qwen3:0.6b (Q8_0, 639 MB),
config `~/.config/goose/config.yaml` (`GOOSE_PROVIDER: ollama`,
`GOOSE_MODEL: qwen3:0.6b`, `GOOSE_MODE: auto`).
**Task:** `goose run --text "Create a small Node.js + Express + SQLite app with one
page that says Hello, Ankush, and one API route /api/health that returns {ok:true}.
Add a README, a .gitignore that ignores .env.local, and npm test that checks /api/health."`
in `~/workspace/personal-ai/projects/hello-proof/`.

## Result: FAILED on this VM (model too small, not a goose failure)

- **First run:** instant error — `request (3771 tokens) exceeds the available
  context size (2048 tokens)`. Goose's own system prompt is 3,771 tokens; the
  model was loaded with `num_ctx 2048` from the Modelfile.
- **Fix:** Modelfile `num_ctx` raised to 8192, model recreated
  (`ollama show` confirms `num_ctx 8192`).
- **Second run (900 s timeout):** ran the full 15 minutes, then killed by `timeout`.
  The 0.6b model looped calling goose's `create_app` tool, printing
  `Created app 'hello-ankush'!` then `Created app 'node-ak'!` — but **zero files
  were created** in the project directory, no code was written, no tests ran.
  The model generated ~322 tokens per turn at ~12 tok/s across 266 tasks and
  never produced a valid file write.

## Conclusion

- goose itself works (starts, connects to Ollama, runs sessions, calls tools).
- **qwen3:0.6b cannot do multi-step coding work.** It cannot hold the plan,
  emit valid tool calls in sequence, or write files. This is expected — 0.6b
  is a toy model for this job.
- **The laptop must use qwen3:8b** (the plan's model) or Gemini free tier as the
  goose brain. Re-run this exact command on the laptop; pass mark is
  `npm test` passing, app on localhost:3000, `/api/health` → `{"ok":true}`,
  `.env.local` git-ignored.

## Notes

- In goose 1.59, `goose run` takes **no positional argument** — use
  `goose run --text "..."` or `goose run -i file.txt`.
  (First attempt failed with `error: unexpected argument ... found`.)
- Goose's system prompt is ~3,771 tokens — any model/context below ~8K tokens
  fails immediately. Keep `num_ctx` ≥ 8192 for goose.
