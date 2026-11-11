# Models — what works, what doesn't (11 Nov 2026)

## Gemini (primary brain) — WORKING
- `gemini-3.6-flash` — works (default in `~/workspace/custom-connectors/custom.gemini/bin/gemini.py`).
- `gemini-3.5-flash-lite` — works (fallback named in the 10 Nov triage run).
- `gemini-2.5-flash` — GONE for new users (404). Do not use.
- `gemini-3.8-flash` — returned 503 (high demand) on 10 Nov. Avoid.
- Key: created 10 Nov 2026 15:08 IST in AI Studio, project AgroX, name
  `muse-email-triage-2026-11-10`. Value is never in any file/chat — Ankush
  supplies it via the secure form on his laptop.

## Groq (fallback) — NOT TESTED
- Needs a free-tier key. No signup was done on Ankush's behalf. Ankush creates
  it himself at console.groq.com when he wants the fallback.

## Ollama local — WORKING (small model only, on this VM)
- Ollama 0.40.16 at `~/ollama/bin/ollama`, server on 127.0.0.1:11434.
- `qwen3:0.6b` (Qwen3-0.6B-Q8_0.gguf, 639 MB, from Hugging Face) — answers
  short prompts via API in 14–26 s. Too small for agent tool-use or coding.
- `qwen3:8b` — the laptop model (5.2 GB, needs ~6 GB RAM). Could NOT be pulled
  on this VM: `ollama pull` is blocked by the VM's egress proxy (Ollama's client
  bypasses the proxy; curl works). Laptop should pull it directly.
- Context: OpenClaw's base prompt is ~15,000 tokens. Minimum workable context
  for an OpenClaw turn is 16,384; the laptop should use 32,768 (the default).
  Goose's prompt is ~3,771 tokens — needs ≥ 8,192 context.
