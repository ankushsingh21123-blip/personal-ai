# Job 4 — OpenClaw gateway agent turn (local Ollama brain)

**Date:** 11 Nov 2026, ~10:08–10:28 UTC (15:38–15:58 IST)
**Setup:** OpenClaw 2026.11.2 gateway on 127.0.0.1:18789 (PID 6412, dashboard HTTP 200),
model `ollama/qwen3:0.6b` (Qwen3-0.6B-Q8_0.gguf, 639 MB, imported from Hugging Face —
`ollama pull` cannot work on this VM, see below).
**Task:** `openclaw agent -m "In one sentence, what is this agent for? Answer from AGENT.md only.
Do not use any tools, do not change anything."`

## Result: FAILED on this VM (VM limit, not a stack failure)

| Attempt | Context | Outcome |
|---|---|---|
| 1 | 32,768 (OpenClaw default) | llama-server OOM-killed: `llama-server process has terminated: signal: killed`. 6 retries, 2m04s. |
| 2 | 2,048 (Modelfile) | Same OOM kill. Root cause found: the **server env var `OLLAMA_CONTEXT_LENGTH=32768` overrode the Modelfile** — the runner still loaded with `-c 32768` (confirmed in the serve log: `n_ctx_seq (32768)`). |
| 3 | 2,048 (server restarted, env 4096) | Same OOM kill. New root cause: **OpenClaw's request itself asks for 32,768** (`contextTokens: 32768` in `~/.openclaw/openclaw.json`, `models.providers.ollama.models[0]`). The request-level num_ctx beats both Modelfile and server env. |
| 4 | 4,096 (patched `contextTokens`/`contextWindow` to 4096 via `openclaw config patch`) | No more OOM — but OpenClaw enforces a **minimum context of 4,000** and the base prompt alone is ~15,000 tokens: `Context overflow: prompt too large for the model.` |
| 5 | 8,192, fresh session | Still overflow. Gateway log: `request (14856 tokens) exceeds the available context size (8192 tokens)`. OpenClaw's base prompt (system prompt + all tool schemas + injected workspace docs) is **~15,000 tokens**. |
| 6 | 16,384, fresh session, maxTokens 512 | Prompt fits. CPU prefill ~46–52 tok/s → ~5 min for 15K tokens. After 10m17s: `The model did not produce a response before the model idle timeout.` Fix named by the error: raise `models.providers.<id>.timeoutSeconds`. Not retried — the VM's 1.5 shared CPUs make this a ~12-min turn for a 0.6b answer; not worth it. |

## What was proven

- Gateway starts, binds loopback only, dashboard HTTP 200 on 127.0.0.1:18789.
- Onboarding completes once a model exists (`ok: true`, `authChoice: ollama`).
- Ollama inference works via API: `/api/generate` and `/api/chat` both answer
  in 14–26 s with a small prompt (see Job 4b below).
- The exact config knobs are known: `models.providers.ollama.models[0].contextTokens`
  / `contextWindow` (set with `openclaw config patch --stdin`, full object required —
  a partial patch fails validation: `models[0].name: Invalid input`).

## Job 4b — Ollama direct API (PASSED)

- `POST /api/generate` qwen3:0.6b, "Say hello in one sentence, then stop." →
  `Hello, how are you today? Stop.` in 25.8 s (load 19.7 s, 97 tokens @ ~16.7 tok/s).
- `POST /api/chat` with `options.num_ctx: 2048` → `Hello! Stop.` in 14 s.
- Note: `ollama run` with a prompt arg hangs waiting on stdin in scripts — use the
  API or `ollama run ... < /dev/null`.

## Why `ollama pull` fails on this VM (root cause, verified)

- Direct (no-proxy) connection to `registry.ollama.ai` fails instantly (HTTP 000).
- The VM routes outbound traffic through an authenticated egress proxy; curl uses it,
  Ollama's client does not, so every `ollama pull` dies with
  `pull model manifest: Get "https://registry.ollama.ai/v2/token?...": EOF`
  (2 attempts, 10 min each, zero blobs). Same for OpenClaw onboard's `gemma4` download
  (`Ollama pull stalled: no data received for 300s`).
- Workaround used: `curl` the GGUF from Hugging Face
  (`Qwen/Qwen3-0.6B-GGUF`, `Qwen3-0.6B-Q8_0.gguf`, 639,446,688 bytes, magic `GGUF`)
  then `ollama create qwen3:0.6b -f Modelfile` with `FROM <path>`.
- **This is VM-only. Ankush's laptop has normal internet — `ollama pull qwen3:8b`
  should work directly there.**

## Laptop expectation

16 GB RAM + qwen3:8b + 32,768 context: the same turn should finish in 1–2 minutes.
If a turn ever times out on the laptop, raise
`models.providers.ollama.timeoutSeconds` (and `agents.defaults.timeoutSeconds`)
in `~/.openclaw/openclaw.json`.
