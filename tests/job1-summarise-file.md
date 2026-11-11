# Test Job 1 — summarise a file (personal-ai research file)

## Prompt used

> Read the file ~/workspace/research/personal-ai-laptop-phone-cloud-2026-11-11.md (466 lines, the personal-AI research and build plan) and summarise it in under 250 words: the verdict, the chosen stack, the three tracks (laptop / phone / cloud), and the single biggest honest limit. Write the summary to this file. Do not invent anything not in the file.

## Result — PASSED (Gemini brain, 11 Nov 2026 ~09:41 IST)

- **Model:** `gemini-3.6-flash` via the registered Gemini connector (`gemini.py generate`), free tier. Prompt 14,176 tokens (full 466-line file inlined), reply 354 tokens, `finishReason: STOP`, modelVersion `gemini-3.6-flash`. ~11 seconds wall time.
- **Summary returned (verbatim, ~200 words):**

> **Verdict:** Building a personal AI for $0 is completely buildable without starting from scratch. The plan is to prototype on the laptop first, connect phone remote control second, and migrate to a free cloud host last.
>
> **Chosen Stack:**
> * **Gateway:** OpenClaw (local-first MIT gateway).
> * **Coding Agent:** goose (Apache-2.0 agent).
> * **Brain Tier:** Gemini API free tier (primary), Groq free tier (fallback 1), and Ollama running `qwen3:8b` locally (offline fallback/privacy).
>
> **Three Tracks:**
> * **Laptop Track (v1):** Windows 11 + WSL2 (Ubuntu) running Node.js 22, OpenClaw, goose, and Playwright for shell, file, and browser automation.
> * **Phone Track:** Remote control via WhatsApp using OpenClaw (Baileys) on a spare number, tested on Telegram first, locked strictly to Ankush's allowlisted number.
> * **Cloud Track (v2):** The same OpenClaw gateway hosted on an Oracle Cloud Always Free VM (2 OCPU / 12 GB ARM) linked securely via a private Tailscale tunnel for always-on background jobs.
>
> **Single Biggest Honest Limit:** There is no dependable, guaranteed free 24/7 always-on cloud host. Oracle Cloud Always Free often suffers from out-of-stock VM capacity and reclaims instances deemed idle for 7 days, while other free options sleep or offer limited trial credits. Achieving a fully reliable, 24/7 always-on system will eventually require paid hosting (~$2–$7/month).

- **Check:** every claim in the summary traces to the file (stack, tracks, limit). No invented facts. Word count under 250. **Job 1 PASSED.**

(Filled in after the run — model, time, word count, and the summary itself.)
