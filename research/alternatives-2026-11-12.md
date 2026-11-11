# Alternatives research — Ankush Singh's personal AI

**Date checked:** 12 Nov 2026 (all web checks this day; free tiers change often — re-check each vendor's own pricing/docs page before relying on a limit)
**Owner:** Ankush Singh — BSc CS, Scaler School of Technology, 2nd year, Bengaluru / Hyderabad, India
**Rule for the whole project:** **$0 for everything.** No paid signups, no spending, no Connects, no paid tools/subscriptions.
**Status:** Research only. **Nothing was submitted, signed up for, paid for, or contacted. No account was created. No app code was edited.** No repo was copied or presented as his own — every project below keeps its own licence and credit.
**Baseline being compared against:** `~/workspace/research/personal-ai-laptop-phone-cloud-2026-11-11.md` (11 Nov 2026) and the working app in `~/workspace/personal-ai/app/` — Node/Express + SQLite, `brain.js` (Gemini free → Groq free → Ollama local), `tools.js` (deny-first allowlist: `list_files`, `read_file`, `write_note`, `run_command`), `server.js` (loopback-only, token auth, approvals that never execute). Base choice in that file: **OpenClaw gateway + goose coding agent + Gemini primary / Groq fallback / Ollama offline**.

## TL;DR — what actually changes

1. **The base choice survives.** OpenClaw (~392k stars, MIT) is still the right gateway. Nothing found beats it for laptop + phone + cloud at $0.
2. **The coding agent does NOT survive.** OpenCode (~211–224k stars, MIT, 75+ providers, terminal + server + API) is now clearly stronger than goose (~55k stars) — bigger community, more providers, runs over SSH on a cloud VM, and is the default engine other orchestrators embed. **Swap goose → OpenCode as the coding agent.**
3. **The brain order has a bug in it.** Gemini `gemini-3.6-flash` free tier is **~20 requests/day** (per-project, AI Studio, Oct 2026 readings) — the current app will exhaust its primary brain in a morning of agent loops. `gemini-3.5-flash-lite` gets **~500 requests/day**. **Flip the order: Flash-Lite first for routine turns, 3.6/3.8 Flash reserved for hard turns, Groq second.** Also add `gemini-3.8-flash` (newest free Flash, Oct 2026) to the model list.
4. **The app's tool-calling is the weakest link, not the model.** `brain.js` asks the model to return JSON in free text and parses it; small local models often don't. Native function-calling (Gemini function declarations, Groq/OpenAI-compatible `tools` parameter, Ollama `tools`) is strictly better and is the single highest-leverage code change. BFCL (Berkeley Function-Calling Leaderboard, Nov 2026) has Claude Opus 4.5 top at 77.5% overall; open models trail (Qwen3 235B ~52%, Qwen3 32B ~49%) — which is exactly why the free cloud models, not a local 8B, must stay primary.
5. **Memory is the second-biggest upgrade.** The app today has SQLite notes + message history only. mem0 (Apache-2.0, ~68k stars, Nov 2026) extracts durable facts and retrieves them — or, cheaper and simpler, **sqlite-vec** inside the existing SQLite file. Either beats flat Markdown notes.
6. **Voice: Kokoro stays for English, but it cannot do Hindi.** Kokoro is English-only; Qwen3-TTS (Apache-2.0, Jan 2026) does 10 languages but **not Hindi** either. For Hindi/Telugu/Kannada voice the $0 answer is still **Piper** (47 languages, 900+ voices) or Gemini's free TTS models — verify the Hindi voice before promising it.
7. **Browser: add Playwright MCP, not browser-use, first.** Playwright MCP (Apache-2.0, ~36k stars) gives any MCP client a browser via the accessibility tree with no vision model and no extra tokens; browser-use (~108k stars, MIT, 89.1% WebVoyager) is the heavyweight for open-ended web jobs. Both beat hand-rolled Playwright scripts.
8. **Cloud: Oracle still #1, Northflank Sandbox is now the confirmed #2.** Koyeb's free tier closed to new users (Feb 2026, Mistral acquisition); Fly.io has no free tier for new orgs; Render free sleeps after 15 min and its free Postgres expires after 30 days. Northflank Sandbox (2 services + 1 DB + 2 cron jobs, always-on, no sleeping) is the real $0 backup.
9. **Hermes Agent's learning loop is the one idea worth stealing, not the whole product.** Its Curator writes reusable skills from experience (MIT, ~251–261k stars). The app can copy the *pattern* — a nightly job that writes a Markdown skill from the day's successful runs — without switching gateways.
10. **Desktop GUI clicking stays a NO for v1.** OSWorld 2.0 (Jun 2026 paper, arXiv 2606.29537): best agent completes only 20.6% of long desktop workflows outright. Screenshot→click is research-grade; API/shell/browser tools are the shippable route. Agent Zero's Docker desktop is the sandbox for it later, not v1.

**Verdict key:** ADOPT = change the app/plan now · WATCH = track, adopt when a trigger fires · SKIP = does not beat the current choice · KEEP = current choice confirmed.

---

## 0. Gaps found in the current app (read first — these drive the adoptions)

| # | Gap in `~/workspace/personal-ai/app/` | Evidence | Fix (see Top 10) |
|---|---|---|---|
| G1 | Gemini primary `gemini-3.6-flash` ≈ **20 req/day** free; an agent loop burns that in <1 hour | AI Studio rate-limit readings, Oct 2026: 3.8/3.6 Flash 5 RPM / 20 RPD; Flash-Lite 10 RPM / 500 RPD (scriptbyai.com, boredlisted.com, Oct 2026). Google no longer prints numbers in docs — per-project in AI Studio, not guaranteed. | #1: Flash-Lite first, 3.6/3.8 Flash for hard turns only; add `gemini-3.8-flash` |
| G2 | `brain.js` Ollama call sets `num_ctx: 2048` — below Ollama's own 4,096 default, and the research file says agents need ≥32,768 | `brain.js` `options: { num_ctx: 2048 }`; Ollama default 4,096 silently truncates; agents/coding need ≥64k per Ollama guidance | #2: set `num_ctx: 32768` (or 65536 on 16 GB RAM) |
| G3 | Tool use is free-text JSON parsing, not native function-calling | `server.js` `TOOL_LIST` prompt + `JSON.parse(result.text)`; comment admits "small local models often don't" return JSON | #2: native `tools` parameter per provider |
| G4 | No memory beyond raw message history + notes; no retrieval | `db.js`/`server.js`: messages, jobs, notes, approvals, audit_log only | #4: mem0 or sqlite-vec |
| G5 | No browser tool at all — no Playwright, no MCP | `tools.js` allowlist has no browser tool; research file lists Playwright as "planned" | #3: Playwright MCP |
| G6 | Coding agent is goose, now outclassed | goose ~55k stars vs OpenCode ~211–224k, 75+ providers, server mode | #5: OpenCode replaces goose |
| G7 | No skill-learning loop; every day starts from zero | No curator/skill-writing job anywhere in app | #8: nightly skill-writer (Hermes pattern) |
| G8 | No voice in/out in the app at all | No STT/TTS route in `server.js` | #9: faster-whisper + Kokoro/Piper |
| G9 | Brain chain has no OpenRouter/Mistral fallback | Only Gemini → Groq → Ollama | #6: OpenRouter `:free` as 4th fallback |
| G10 | `GEMINI_MODELS` lacks `gemini-3.8-flash`; 2.5-flash correctly absent | `brain.js` lists 3.6 + 3.5-lite only | #1: add 3.8-flash |

---

## 1. Master comparison table

Stars are GitHub stars **as reported in the cited sources, Oct–Nov 2026** — they measure attention, not quality, and they move daily. "Beats current?" is judged against the 11 Nov baseline (OpenClaw + goose + Gemini/Groq/Ollama + SQLite notes + no browser/voice/memory layer).

| # | Alternative | Licence | Stars (Nov 2026, as reported) | $0 / free-tier limits | Laptop | Phone | Cloud / always-on | Beats current choice? | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **OpenClaw** (current gateway) | MIT | ~392.7k (Oct 22, 2026, GitHub API via coworkosapp.com) | $0 software; model cost only; no paid tier/hosted service | Yes — Win/macOS/Linux, WSL2 | Yes — WhatsApp (Baileys QR), Telegram, Discord, Slack, Signal, iMessage, 20+ channels | Gateway runs on any machine kept on | Baseline — nothing beats it as gateway | **KEEP** |
| 2 | **OpenCode** (coding agent — replaces goose) | MIT | ~211–224k (Oct–Nov 2026; 220,501 on Oct 23) | $0 software; 75+ providers; pay only model tokens, or $0 with Ollama | Yes — terminal TUI, runs over SSH | Via OpenClaw/SSH, no native phone UI | Yes — server mode, API + OpenAPI spec | Yes — 4× goose's stars, 75+ vs 15+ providers, server/API, default engine in orchestrators | **ADOPT** |
| 3 | **goose** (current coding agent) | Apache-2.0 | ~55k (Oct 2026; v1.59.0 Nov 10, 2026) | $0 software; 15+ providers, 70+ MCP extensions; Ollama $0 | Yes — Rust CLI + desktop app | No | No | Baseline — still good, but outclassed by OpenCode; keep as fallback | **KEEP as fallback** |
| 4 | **Hermes Agent** (Nous Research) | MIT | ~251–261k (Oct 4: 251,001; Nov 6: 261k) | $0 software; model cost; runs on laptop / $5 VPS / serverless | Yes | Yes — Telegram/Discord/Slack/WhatsApp/Signal via gateway | Yes — designed for a server | Learning loop (Curator) beats OpenClaw's manual skills; as a whole gateway it duplicates OpenClaw | **ADOPT the pattern, WATCH the product** |
| 5 | **DeepSeek Harness (dsh)** | MIT | ~243–249k (Oct 4: 242,936; Oct 14: 249.1k) | $0 software; model cost; any OpenAI-compatible endpoint incl. Ollama | Yes — Node/TypeScript, `npx @deepseek-ai/dsh web` | No native channel | No | Architecturally interesting (everything-is-a-plugin, Cordis) but **developer preview, no security audit, breaking changes promised** | **WATCH** |
| 6 | **Agent Zero** | MIT | ~19.4–19.8k (Oct 2026; v2.15 Nov 1, 2026) | $0 software; model cost or $0 with Ollama | Yes — Docker container with XFCE Linux desktop + browser | No | Where Docker runs | Only option with a real sandboxed desktop + sub-agents; heavy, Docker-required, README warns "can be dangerous", CVEs in 2026 | **WATCH (v2 sandbox)** |
| 7 | **OpenHands** | MIT | ~89.8k (Oct 2, 2026) | $0 software; cloud free individual tier | Yes — now Agent Canvas control centre | No | Docker/VM backends, scheduled + webhook automations | Strong autonomous coding + sandboxing, but coding-only, not a personal gateway | **WATCH** |
| 8 | **Cline** | Apache-2.0 | ~70.8k (Oct 23, 2026) | $0; bring-your-own-key | Yes — VS Code extension | No | No | Best in-editor agent; not a gateway, not phone/cloud | **SKIP** (for this project; fine as his editor tool) |
| 9 | **Codex CLI** (OpenAI) | Apache-2.0 (CLI) | ~127–131k (Oct 2026) | CLI $0; models need ChatGPT Plus ($20/mo from Sep 2026) or API | Yes — terminal | No (Slack only, cloud tasks) | Cloud sandbox for code | Great coder, but paid model + no phone; OpenClaw already has an official Codex plugin (Beta, Sep 2026) | **SKIP as base; WATCH plugin** |
| 10 | **Gemini CLI** | Apache-2.0 | ~107.6k (Oct 2026) | $0 CLI; Gemini free tier as above | Yes — terminal | No | No | Same free brain, different shell; no advantage over OpenCode + Gemini | **SKIP** |
| 11 | **Cindy** | (reported open source; verify licence in repo before use) | ~9.7k (Nov 2026, per 11 Nov file) | $0 software | Yes | Yes — remote desktop from phone, session handoff across devices | Your computer becomes your server | The phone-remote-desktop feature Ankush wants, but **beta** per its own README | **WATCH** |
| 12 | **LangGraph / LangChain** | MIT | LangGraph ~37–44.6k; LangChain ~142k (2026) | $0 library; LangSmith Developer $0 (1 seat), Plus $39/seat/mo | Yes (Python/TS) | No (library, not product) | Yes — durable execution, survives crash | Best for stateful long runs + human-in-the-loop pauses — exactly the app's approval model. But: a framework, not a product; the app is small enough that a plain loop + SQLite still wins today | **WATCH** (adopt when jobs get long/multi-step) |
| 13 | **Mastra** | Apache-2.0 core (`ee/` paid) | ~28.5–29.4k (Nov 7, 2026) | $0 core; Mastra Cloud free, Teams $250/mo | Yes — TypeScript-native, 40+ providers | No | Yes — workflows suspend/resume, pluggable memory | **The best framework fit for this app** (TypeScript, same stack as the app) if/when the hand-rolled loop is replaced | **WATCH** (top framework candidate) |
| 14 | **CrewAI** | MIT core | ~56–57k (2026) | $0 core; AMP Basic $0, 50 exec/mo | Yes (Python) | No | Yes | Role-based crews map neatly onto Ankush's teams (research/build/check/publish) — but Python, and hidden control flow makes debugging hard | **WATCH** |
| 15 | **AutoGen → Microsoft Agent Framework** | MIT | AutoGen ~60k | $0 | Yes (Python/.NET) | No | Yes | **AutoGen is in maintenance mode** (repo says so); successor Microsoft Agent Framework 1.0 shipped Apr 2026 | **SKIP AutoGen; WATCH MAF** |
| 16 | **smolagents** (Hugging Face) | Apache-2.0 | ~29.6–30.3k (Nov 2026) | $0; no hosted tier | Yes (Python) | No | No | Minimal, auditable, code-as-actions — elegant, but Python and stateless by default; overkill to port a working Node app | **SKIP** |
| 17 | **Pydantic AI** | MIT | ~20.3–21.1k (Nov 2026) | $0; Logfire from $0 | Yes (Python) | No | Yes | Type-safe agents; Python-only, wrong stack for this Node app | **SKIP** |
| 18 | **OpenAI Agents SDK** | MIT | ~28–30.6k (Nov 2026) | $0 library; models paid | Yes (Python/TS) | No | Yes | Leanest SDK, but OpenAI-model-centric; no $0 advantage | **SKIP** |
| 19 | **browser-use** | MIT | ~105–108k (Aug–Oct 2026) | $0 library; model tokens only; cloud product paid | Yes (Python; TS SDK too) | No | Yes | **89.1% WebVoyager** (vendor-reported, GPT-4o) — best open browser agent for open-ended web jobs; Playwright/Chromium underneath | **ADOPT (phase 2, for web jobs)** |
| 20 | **Playwright MCP** (Microsoft) | Apache-2.0 | ~34–36k (2026) | $0 | Yes | No | Yes | Accessibility-tree browser as MCP tools — **no vision model, no extra tokens**, deterministic; the cheapest way to give the agent a browser | **ADOPT (first)** |
| 21 | **Stagehand** (Browserbase) | MIT | ~21.8–23.8k (2026) | $0 SDK; Browserbase cloud freemium (1 browser-hr/mo) | Yes (TypeScript) | No | Yes | `act()/extract()/observe()` on Playwright; **v3 uses CDP directly, 44% faster on shadow DOM/iframes, caches results** — best TS fit; repeat runs can skip the LLM entirely | **ADOPT (TS path, with Playwright MCP)** |
| 22 | **Skyvern** | AGPL-3.0 self-hosted core | ~21–23.2k (2026) | $0 self-host (AGPL); cloud paid | Yes (Python/TS SDKs) | No | Yes | Vision-first, Planner-Actor-Validator, 85.85% WebVoyager v2 (vendor-reported); **AGPL copyleft** — selling a product built on it has licence consequences; heaviest token use (~30–50k tokens/10 steps, images) | **SKIP** (AGPL + token cost) |
| 23 | **Playwright** (library) | Apache-2.0 | (upstream; not counted here) | $0 | Yes | No | Yes | Deterministic browser automation; the substrate under 19–22 — keep for scripted, repeatable jobs | **KEEP** |
| 24 | **mem0** | Apache-2.0 | ~64–68.3k (Nov 2, 2026) | OSS $0; Platform free tier 10k adds + 1k retrievals/mo (first 30 days), then own-key; Starter/Pro were $19/$249 — **pricing changed Oct 2026, re-check** | Yes (Python/TS lib or self-hosted server) | No | Yes | Extract-and-retrieve memory; LoCoMo 92.5 / LongMemEval 94.4 **vendor-reported on managed platform**, SDK differs; **graph memory removed from OSS Apr 2026 (Platform-only)**; telemetry on by default (set `MEM0_TELEMETRY=false`); add-only extraction keeps stale facts | **ADOPT (self-hosted, with eyes open)** |
| 25 | **sqlite-vec** | Apache-2.0 (dual MIT) | (small, focused repo; stars not the point) | $0; `npm install sqlite-vec` | Yes — pure C, runs anywhere SQLite runs incl. WASM | n/a | Yes | Vector search **inside the existing SQLite file** — zero new infra, one portable file; pre-v1, expect breaking changes; stable release brute-force only (ANN indexes in alpha); last push 2026-05-18 per Nov 10 sync | **ADOPT (simplest memory upgrade)** |
| 26 | **LanceDB** | Apache-2.0 | (embedded vector DB) | $0; embedded, no server | Yes | n/a | Yes | Disk-based columnar, native BM25+vector hybrid, IVF-PQ/HNSW; best when corpus outgrows SQLite; concurrent-write conflicts need app retries | **WATCH** |
| 27 | **ChromaDB** | Apache-2.0 | (embedded/server) | $0; `pip install` | Yes | n/a | Yes | Fastest RAG prototype DX, but single-writer embedded, no quantization, memory blow-up at scale; guides now call it prototype-only | **SKIP** |
| 28 | **Qdrant** | Apache-2.0 | (server) | $0 self-hosted; needs Docker process | Yes | n/a | Yes | Production RAG (quantization, filtering, sub-20ms p95); overkill for a single-user agent today | **WATCH** |
| 29 | **pgvector** | PostgreSQL licence (open) | (Postgres extension) | $0 if Postgres already runs | Yes | n/a | Yes | One SQL command away if Postgres exists; the app uses SQLite, so this means adding Postgres — not worth it yet | **SKIP** |
| 30 | **Kokoro-82M TTS** | Apache-2.0 | (model, not repo stars) | $0, runs on CPU, ~300 MB | Yes | n/a | Yes | Best $0 English TTS quality (MOS 4.2/5 in its weight class, TTS Arena #1 in class); **English only, no voice cloning** | **KEEP for English** |
| 31 | **Qwen3-TTS** (Alibaba, Jan 22, 2026) | Apache-2.0 | (model) | $0 weights; GPU preferred (~4–8 GB VRAM) | Yes | n/a | Yes | 0.6B/1.7B, **10 languages, 3-second voice cloning, VoiceDesign from text**, ~97 ms first-packet (vendor test); **no Hindi**; no watermark/consent controls — clone only with permission | **ADOPT (multilingual voice, not Hindi)** |
| 32 | **Piper TTS** | GPL-3.0 (current repo; original archived repo was MIT) | (engine) | $0; real-time on Raspberry Pi, no GPU | Yes | n/a | Yes | **47 languages, 900+ voices**, fastest/lightest local TTS; GPL-3.0 copyleft on the engine — check before selling a product containing it; voice packages carry their own licences | **ADOPT for Hindi/Indian languages (verify voice first)** |
| 33 | **Chatterbox TTS** | MIT | (model) | $0; GPU 4 GB+ | Yes | n/a | Yes | Voice cloning from ~5–10 s, 23+ languages, every clip watermarked; good clone quality in blind tests | **WATCH** (clone + watermark is the responsible choice) |
| 34 | **Whisper / faster-whisper STT** | MIT (Whisper) | (model) | $0 local; Groq serves Whisper at 20 RPM / 2k req/day free, $0.04/hr paid | Yes | n/a | Yes | `whisper-large-v3-turbo` (809M) ≈ large-v3 accuracy, several× faster; faster-whisper int8 ≈ 3 GB GPU; CPU small models fine for short clips | **ADOPT (faster-whisper local; Groq Whisper as fallback)** |
| 35 | **Gemini free TTS / STT** | Google terms | n/a | Free tier includes TTS + transcription models (Oct 2026 pricing page) | Via API | n/a | n/a | $0 multilingual voice incl. Indian languages (verify per-model); free-tier prompts train Google's products — no private/customer data | **WATCH** (verify Hindi voice + limits in AI Studio) |
| 36 | **OpenRouter `:free` models** | (aggregator) | n/a | $0; **20 RPM, 50 req/day** (1,000/day after a one-time ≥$10 credit purchase — that purchase breaks the $0 rule, so plan on 50/day); some free-model providers train on prompts | Via API | n/a | n/a | 17–18 `:free` IDs (Oct 22, 2026), incl. Gemma 4, Nemotron 3; **free DeepSeek/Qwen/Kimi/gpt-oss variants are NOT on the free list anymore (Oct 2026)** | **ADOPT as 4th fallback (50/day)** |
| 37 | **Mistral free mode** (La Plateforme → Mistral AI Studio) | (provider) | n/a | $0, no card; ~1B tokens/month org-wide shared cap (reported Apr–Oct 2026, verify); **free-mode prompts may be used for training unless opted out** | Via API | n/a | n/a | Mistral Medium/Large/Small, Codestral, Devstral — strong coders; org-wide cap means one project can eat the allowance | **ADOPT as 5th fallback (with training opt-out checked)** |
| 38 | **SambaNova Cloud free tier** | (provider) | n/a | Docs describe free tier (no payment method): 20 RPM, 20 req/day, 200k tokens/day per model (Llama-3.3-70B, DeepSeek V3.1/V3.2, gpt-oss-120b, Gemma 4 31B) | Via API | n/a | n/a | **Conflicting reports Oct 2026:** one source says card + bought credits required since ~14 Aug 2026; rate-limit docs still describe a free tier. **Unverified — test before relying on it** | **WATCH (verify first)** |
| 39 | **Cerebras** | (provider) | n/a | **Trial only: $5 credit, 30 days, card required** — not $0-forever | Via API | n/a | n/a | Fastest inference (Llama 3.3 70B, gpt-oss-120b, Qwen3-235B); trial expiry + card = fails the $0 rule | **SKIP** |
| 40 | **Cloudflare Workers AI** | (provider) | n/a | Free tier exists (verify current limits); Workers 100k req/day free | Via API | n/a | Yes — serverless, no idle | Good for small inference + cron-ish jobs; 10 ms CPU/request limit — not a long-running agent host | **WATCH** |
| 41 | **Oracle Cloud Always Free** (current cloud pick) | (provider) | n/a | **$0 forever: 2 OCPU / 12 GB ARM (A1), 200 GB storage, 10 TB egress/mo**; halved from 4/24 on Jun 15, 2026, enforced Aug 18, 2026 | n/a | n/a | **Yes — VM never sleeps** | Still the best $0 always-on host; risks confirmed Oct 2026: A1 often out of capacity; **idle reclaim if CPU+network+memory all <20% (p95) for 7 days**; accounts idle 30+ days may be suspended; card needed for hold | **KEEP** |
| 42 | **Northflank Sandbox** | (provider) | n/a | **$0: 2 services, 1 DB, 2 cron jobs, up to $20/mo resources; always-on, no sleeping**; card verified at signup (per some guides; pricing page says no card — verify at signup) | n/a | n/a | **Yes — does not sleep** | The only other confirmed $0 always-on host; smallest paid plan $2.70/mo (0.1 vCPU/256 MB) | **ADOPT as cloud backup** |
| 43 | **Render Free** | (provider) | n/a | $0, 750 hrs/mo | n/a | n/a | **No — sleeps after 15 min idle**, ~1 min cold start; **free Postgres expires 30 days after creation** (+14-day grace, then deleted) | Fine for a demo, not for an always-on agent | **SKIP for hosting; KEEP for demos** |
| 44 | **Fly.io** | (provider) | n/a | **No free tier for new orgs** (retired Oct 2024); trial 2 Machine-hours or 7 days only | n/a | n/a | Yes, metered; smallest Machine ~$2.02–2.19/mo | **Cheapest paid always-on floor** if Oracle + Northflank both fail — needs Ankush's approval to pay | **WATCH (paid fallback)** |
| 45 | **Railway** | (provider) | n/a | $5 trial credit, 30 days; then Hobby $5/mo; new free plan $1 credit/mo reported Oct 2026 — verify | n/a | n/a | Yes while credit lasts | Not $0-forever | **SKIP** |
| 46 | **Koyeb** | (provider) | n/a | **Free tier CLOSED to new users** (Mistral acquisition announced Feb 17, 2026); new floor $29/mo | n/a | n/a | — | Dead as a $0 option — remove from any plan that still lists it | **SKIP (closed)** |
| 47 | **Hetzner CX22** | (provider) | n/a | ~€4.35/mo — not $0 | n/a | n/a | Yes | Cheapest *reliable* VPS if he ever pays | **WATCH (paid fallback)** |
| 48 | **Tailscale** | (free personal plan) | n/a | $0 personal | Yes | Yes (phone app) | Yes — tunnel, no public ports | Already in the plan; still the right way to connect laptop ↔ cloud ↔ phone with the gateway on 127.0.0.1 | **KEEP** |
| 49 | **n8n** | (fair-code / Sustainable Use licence — **not OSI open source**; 206k stars Oct 2026) | ~206k (Oct 2, 2026) | $0 self-hosted | Yes | Via webhooks/apps | Yes — self-host | Best visual workflow automation (already used for Nova Explains machine); licence is source-available, not open — fine to *use*, be careful about *selling* it as part of a product | **KEEP for workflows; do not rebrand as his own** |
| 50 | **MCP (Model Context Protocol)** | (open spec, Anthropic-donated to AAIF) | n/a | $0 | Yes | n/a | Yes | The standard plug for tools: Playwright MCP, mem0 MCP, filesystem, Gmail — one protocol instead of one-off integrations per tool | **ADOPT as the tool-plug standard** |
| 51 | **A2A (Agent2Agent protocol)** | (open spec) | n/a | $0 | Yes | n/a | Yes | Agent-to-agent handoff (e.g. gateway ↔ coding agent ↔ browser agent); Agent Zero and MAF support it; still maturing | **WATCH** |

---

## 2. Category deep-dives

### 2.1 Agent frameworks — the base does not change, the coding agent does

- **OpenClaw stays.** ~392.7k stars (GitHub API, Oct 22, 2026), MIT, OpenClaw Foundation (501(c)(3), no paid tier, no hosted service, no token). One gateway, 20+ channels, native apps, weekly releases. Sharp edges confirmed Oct 2026: a one-click RCE (CVE-2026-25253, patched Jan 2026), 1,000+ malicious skills pulled from the registry, 1,799 security reports since Jan 2026 (722 fixed, 14 critical, all disclosed). Posture stays: loopback bind + `openclaw security audit` + allowlist. Its official Codex plugin (Beta, late Sep 2026) is the cheap way to borrow Codex later without paying for a second brain.
- **OpenCode replaces goose.** OpenCode (anomalyco/opencode, MIT) ~211.4k stars Oct 2 → 220,501 Oct 23 → ~224k Nov 3, 2026; 75+ providers via AI SDK/Models.dev; terminal TUI + desktop + **server mode with an OpenAPI spec and SDK** — that server mode is what the personal-AI app actually wants (the gateway can call it over HTTP instead of shelling out to a CLI). v1.19.x, Oct 2026. Claude-subscription login was removed Mar 2026 after Anthropic's legal request — Claude needs an API key now, which is fine: the app uses Gemini/Groq/Ollama anyway. goose stays installed as fallback: it is still excellent (Apache-2.0, AAIF/Linux Foundation since Apr 2026, v1.59.0 Nov 10, 2026, 70+ MCP extensions, adversary-mode review of sensitive tool calls since Mar 2026), and its Ollama guidance (32 GB RAM baseline for larger models; Qwen3-Coder emits valid JSON tool calls only with ≲5 tools, issue #6883) is a useful warning for any local-model setup.
- **Hermes Agent: steal the loop, not the product.** Nous Research, MIT, launched Feb 25, 2026; 251,001 stars Oct 4 → ~254k mid-Oct → 261k Nov 6, 2026; #1 on OpenRouter token rankings (1.73T tokens in one day's count). The Curator runs every 15 tool calls and after complex tasks: reflects, writes a Markdown skill file, loads it next run. Vendor-adjacent reports claim ~40% faster research tasks with self-created skills (TokenMix; not independently re-run — treat as directional). Risk noted in the wild: self-written skills can drift (one reported case: 69% of 2.6M tokens wasted after 3 weeks; model-collapse literature says even 1/1000 synthetic data can trigger drift — Shumailov et al., Nature 2024). So: copy the pattern with a **human-reviewed** skill file, never auto-accept learned skills into the allowlist.
- **DeepSeek Harness (dsh): the most interesting thing to watch.** MIT, launched Aug 13, 2026, fastest-starred project in GitHub history (95k stars in 48 hours; 242,936 Oct 4; 249.1k Oct 14). Everything-is-a-plugin on the Cordis framework (paper: *A Programming Paradigm for Spatiotemporal Composability*). Points at any OpenAI-compatible endpoint incl. Ollama. But: **developer preview, no GitHub releases, no security audit, README warns in capitals of breaking changes**, session logs upload to DeepSeek on the official API by default. Revisit at v1.0 / first audit.
- **Agent Zero: the v2 sandbox.** MIT, ~19.8k stars, v2.15 Nov 1, 2026. Full Linux desktop in Docker (XFCE + browser + LibreOffice), sub-agents, MCP + A2A, Codex-plan sign-in by OAuth. v3 (previewed Aug 2026) moves agent code into separate sandboxes. Use case here is narrow and real: run untrusted repos / GUI jobs in the container instead of on Ankush's laptop. Not v1 — Docker + backups + its own CVE history (CVE-2026-4307/4308, CVE-2026-47119, CVE-2026-51852/51853 in 2026) say "sandbox first".
- **Frameworks for later (not now):** LangGraph 1.2.17 (Oct 24, 2026) is the right call when jobs become long-running with human-in-the-loop pauses and crash recovery; Mastra is the TypeScript-native equivalent and the best framework fit for this Node app; CrewAI maps onto the Nova teams structure but hides control flow; AutoGen is **maintenance mode — do not start new work on it** (Microsoft Agent Framework 1.0, Apr 2026, is the successor). The honest rule from the literature: **for a single agent with <10 tools, a while-loop + function-calling LLM + hand-written tools is sufficient** — that is what the app already is. Don't adopt a framework until the job list outgrows the loop.

### 2.2 Computer use — the honest state of the art

- **Desktop GUI clicking is not shippable yet.** OSWorld 2.0 (paper Jun 26, 2026, arXiv 2606.29537; 108 long workflows, median human time ~1.6 hrs, ~318 tool calls/task): best config (Claude Opus 4.8, max thinking) completed **20.6% outright, 54.8% partial**. The Oct 5, 2026 leaderboard shows 44.3% on a later bug-fix release — not comparable across releases. OSWorld 1.0/Verified (369 tasks) is saturated at the top (Opus 4.7 reported 82.3–90.19%), which is why OSWorld 2.0 was built. Conclusion stands: **API/shell/browser first; screenshot→click only for a named app with no API, with Ankush present.**
- **Browser is shippable, with supervision.** WebVoyager (586 live-site tasks): browser-use 89.1% (vendor-reported, GPT-4o), OpenAI CUA 87%; WebArena (transactional): CUA 58.1% vs human ~78–95%. Production web systems sit at 50–60% on WebArena; information retrieval + form-filling on known sites runs 80–90%. Every vendor benchmark here is **self-reported on different suites with different judges** — treat as marketing, not measurement; the app should keep its own pass/fail log per site.
- **Adoption order for the browser:** (1) **Playwright MCP** — accessibility tree, no vision tokens, deterministic, Apache-2.0, `npx @playwright/mcp@latest`; note its `browser_run_code_unsafe` core tool is RCE-equivalent by its own docs, so run it with the same deny-first posture as shell. (2) **Stagehand** (TypeScript, MIT) for repeatable jobs — v3 is CDP-native, caches `act()/observe()/extract()` so repeat runs skip the LLM. (3) **browser-use** (Python, MIT) for open-ended web research jobs. Skip Skyvern for this product: AGPL-3.0 copyleft + ~30–50k tokens per 10 steps.
- **Papers / benchmarks to cite when asked:** OSWorld 2.0 (arXiv 2606.29537, Jun 2026); WebVoyager (live websites); WebArena (Jul 2023 paper, multi-step transactional web tasks); BFCL v4 (UC Berkeley Gorilla, ICML 2025; Apache-2.0 harness `bfcl-eval` on PyPI); τ²-bench / τ-bench (multi-turn tool use); Terminal-Bench 2.1 (coding-agent eval; Qwen3.8 27B reported 79.8% in an Artificial Analysis run, Oct 2026).

### 2.3 Models — the brain chain, fixed

Free-tier numbers below are **per-provider docs as read Oct 2026 by the cited guides**; Google no longer prints Gemini numbers in docs (per-project in AI Studio, not guaranteed), Groq prints its own.

| Provider / model | Free limits (Oct 2026) | Card? | Trains on prompts? | Role in the chain |
|---|---|---|---|---|
| **Gemini 3.5 Flash-Lite** (`gemini-3.5-flash-lite`) | ~10 RPM, 250k TPM, **500 req/day** | No | **Yes — free-tier prompts used to improve Google's products** | **NEW primary for routine turns** |
| **Gemini 3.6 Flash** (`gemini-3.6-flash`) | ~5 RPM, 250k TPM, **20 req/day** | No | Yes | Hard turns only (was primary — demote) |
| **Gemini 3.8 Flash** (`gemini-3.8-flash`) | ~5 RPM, 250k TPM, **20 req/day** | No | Yes | Hard turns; newest free Flash — add to list |
| **Gemini 3.1 Flash-Lite** | ~10 RPM, 250k TPM, 500 req/day; shutdown May 7, 2027 | No | Yes | Spare Flash-Lite |
| **Gemma 4** (`gemma-4-31b-it` etc.) | Free of charge | No | (per model card) | Open-weight spare via Gemini API |
| **Groq `openai/gpt-oss-120b`** | **30 RPM, 1,000 req/day, 8k TPM, 200k tokens/day**; cached tokens don't count; ~261–525 tok/s measured Oct 2026 | No | No (per Groq) | **Fallback 1 — confirmed, keep** |
| **Groq `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`** | Same 30/1,000/8k/200k | No | No | Fallback 1b — qwen3.8-27b is a **preview, may be discontinued at short notice** |
| **Groq Whisper `whisper-large-v3`** | 20 RPM, 2k req/day (28.8k audio-sec/day per one guide) | No | — | STT fallback |
| **OpenRouter `:free`** | 20 RPM, **50 req/day** (1,000/day only after ≥$10 credit purchase — breaks $0 rule) | No | Depends on model provider | **NEW fallback 2** |
| **Mistral free mode** | ~1B tokens/month org-wide shared (reported; verify in admin panel); ~60 RPM | No | **Yes unless opted out** | **NEW fallback 3** |
| **SambaNova** | Docs: 20 RPM, 20 req/day, 200k tokens/day/model | **Disputed — reports of card required since Aug 2026** | — | Verify before use |
| **Ollama local** | $0, unlimited, offline | — | No (local) | Privacy/offline fallback — see §2.4 |

**What this means in practice:** the current chain (Gemini 3.6 Flash → Groq → Ollama) gives ~20 good turns/day before falling back. The fixed chain (Flash-Lite → 3.6/3.8 Flash for hard turns → Groq → OpenRouter `:free` → Mistral → Ollama) gives ~500 + 20 + 20 + 1,000 + 50 + Mistral ≈ **1,500+ free turns/day** before touching local. Never send customer/private data on Gemini free tier or Mistral free mode (training opt-in); route those turns to Groq or Ollama.
**Also note:** Gemini 2.5 Flash/Pro are **not** retired but API access is limited to developers who previously used them; `gemini-2.5-flash` is 404 for new users — correctly absent from the app. Gemini 3.7-flash / 3.5-flash deprecated Oct 8, 2026 (now route to 3.8/3.6). Gemini 4 Argon is paid-only.

### 2.4 Local models (Ollama) — pick by RAM, keep tools few

- **16 GB RAM (Ankush's likely laptop): `gpt-oss:20b` is the pick.** ~14 GB, ~140 tok/s on a 16 GB GPU (RTX 4080 test, Mar 2026), native function calling, Apache-2.0, SWE-bench Verified 60.7 at high reasoning (OpenAI model card). Finished all 5 test tasks in OpenCode on a 48 GB Mac (Waymaker test, Nov 10, 2026). **Replace `qwen3:8b` with `gpt-oss:20b` as the local default.**
- **8 GB RAM: `qwen3.5:9b`** (~6.6–7.6 GB; BFCL-V4 66.1, τ²-bench 79.1 per model card, Oct 2026) — the current `qwen3:8b` is one generation behind; `qwen3:0.6b` in the VM is a smoke-test toy, not an agent brain.
- **24 GB GPU / 32 GB Mac: `qwen3.8:27b`** (~18 GB; Terminal-Bench 2.1 73.0 card / 79.8 independent run; SWE-bench Pro 61.7) — best all-round local agent model Oct 2026. Coding: `qwen3.6:27b` (SWE-bench Verified 77.2) or Meta Muse Glimmer 30B (~76).
- **Rules that matter more than the model name:** keep the tool list **≤5 tools** for small models (Qwen3-Coder breaks above ~5 tools); set context **≥32,768** (Ollama default 4,096 silently truncates — the app's 2,048 is worse); MoE models (gpt-oss 20B: 3.6B active params; Qwen3 30B-A3B: 3B active) are much faster than dense models the same size. CPU-only 7B is 3–8 tok/s — usable for short jobs only.
- **BFCL reality check (Nov 11, 2026, BenchLeader):** Claude Opus 4.5 77.5% overall top; Gemini 3 Pro 72.5%; GLM-4.6 (thinking, open) 72.4%; Qwen3 235B 52.1%; Qwen3 32B 48.7%. Small local models are far behind frontier on tool-calling — local stays a fallback, not the primary, exactly as the 11 Nov file said.

### 2.5 Voice — STT/TTS

- **STT: faster-whisper local first, Groq Whisper second.** `whisper-large-v3-turbo` (MIT, 809M) ≈ large-v3 accuracy, several× faster; faster-whisper int8 ≈ 3 GB GPU; small models on CPU handle short clips in 1–2 s. Groq Whisper free: 20 RPM / 2k req/day.
- **TTS English: Kokoro stays.** Kokoro-82M, Apache-2.0, ~300 MB, CPU, 96× real-time on GPU, MOS 4.2/5, TTS Arena #1 in its class; **English only, no cloning**. Serve via Kokoro-FastAPI (OpenAI-compatible) or Speaches (adds faster-whisper + Piper in one server).
- **TTS multilingual + cloning: Qwen3-TTS.** Apache-2.0, Jan 22, 2026, 0.6B/1.7B, 10 languages (EN, ZH, JA, KO, DE, FR, RU, PT, ES, IT), 3-second cloning (Base), 9 preset voices (CustomVoice), voice-from-text (VoiceDesign, 1.7B), ~97 ms first packet (vendor test), now the default TTS in Hugging Face's speech-to-speech pipeline. **No Hindi. No watermark, no consent flow** — clone only with documented permission, label synthetic audio.
- **TTS Indian languages: Piper is the $0 answer, with a check.** Piper: 47 languages, 900+ voices, real-time on a Pi, no GPU. Current repo is **GPL-3.0** (original MIT repo archived 2025) — GPL matters if the voice engine ships inside a product he sells; using it for his own videos/agent is fine. **Verify a Hindi (and Telugu/Kannada) voice exists and sounds right before promising it** — the Casano Bangalore videos already use Helio TTS for this; Piper is the local fallback, not a proven replacement. Chatterbox (MIT, 23+ languages, cloning from ~5–10 s, **every clip watermarked**) is the responsible cloning choice if Qwen3-TTS's lack of watermarking is a concern.
- **Note for Nova Explains:** Kokoro's English-only limit is already known (10 Nov: Kokoro HF download failed twice from this VM; Helio TTS in use). Qwen3-TTS needs a GPU (~4–8 GB VRAM) — not a VM job; test on the laptop.

### 2.6 Memory / RAG — two adoptions, in order

1. **sqlite-vec first (simplest).** `npm install sqlite-vec`, one `vec0` virtual table in the existing `personal-ai.db`, embeddings from a small local model (e.g. FastEmbed / `all-MiniLM-L6-v2`, ONNX, no GPU). Keeps everything in one portable SQLite file, no new process. Limits: pre-v1 (expect breaking changes), stable release is brute-force (fine <100k vectors; ~1.7 s at 100k×1024 in one Go benchmark, single-digit ms <50k chunks), ANN indexes (IVF/DiskANN) still alpha, last push May 18, 2026. Pin `0.1.9` (stable), not the `0.1.10-alpha` line.
2. **mem0 second (when memory needs to be smart, not just searchable).** Apache-2.0, ~67.7k stars Oct 21 → 68.3k Nov 2, 2026; 2M PyPI downloads/month, 11 releases in 90 days (Oct 12, 2026). `add`/`search` API, self-hostable with Postgres+pgvector or embedded store. Caveats: headline benchmarks are managed-platform numbers; **graph memory is Platform-only since Apr 2026**; extraction is now add-only (stale facts persist — needs a pruning job); telemetry on by default; a cross-tenant session-scoping leak was disclosed Oct 20, 2026 (self-hosted single-user use is unaffected in practice, but keep it updated). Skip Chroma (prototype-only reputation now, single-writer, no quantization); watch LanceDB (disk-based, hybrid BM25+vector) and Qdrant (production) for when the corpus grows past SQLite.

### 2.7 Phone channels — Telegram first is still right, WhatsApp risk confirmed

- **Telegram Bot API: official, free, zero ban risk.** BotFather token, ~5 min setup. Confirmed again Jul–Oct 2026 guides: the zero-risk channel. **This stays the test channel and the recommended daily driver until WhatsApp is proven safe on a spare number.**
- **WhatsApp via Baileys: real, ToS-violating, unpredictable ban risk.** Confirmed by multiple Jul 2026 guides: every QR-pairing tool (OpenClaw included) impersonates a WhatsApp Web linked device; WhatsApp's ToS prohibits automated/unauthorised access; Meta bans unpredictably (same-day bans reported in Baileys issue tracker; no reliable timetable); enforcement concentrates on spam-like behaviour (bulk sends, cold outreach, brand-new numbers at high velocity). A personal assistant answering inbound messages at human volume on an established number is a smaller target — **but never zero**. Rules stand: spare number only, never the primary; allowlist Ankush only; no bulk sends. **WhatsApp Business Cloud API** is the official route — paid per conversation, business-only, and Meta's Business Solution Terms restrict AI providers when a general-purpose assistant is the primary service — not $0, not for this project.
- **Signal:** OpenClaw supports it; official-ish via signal-cli, but phone-number registration + worse bot UX than Telegram. Watch only.
- **No change to the app's allowlist design** — it already does the right thing (token auth, deny-first). The phone channel is an OpenClaw-layer decision, not an app-code change.

### 2.8 Cloud $0 hosts — Oracle #1, Northflank #2, Koyeb dead

- **Oracle Always Free: keep as v2 target.** 2 OCPU / 12 GB ARM (halved Jun 15, 2026, enforced Aug 18, 2026), 200 GB storage, 10 TB egress, 2 AMD micro VMs, home region permanent, Mumbai (ap-south-1) if capacity allows. Idle reclaim: CPU + network + memory all <20% (95th percentile) over 7 days → reclaim; accounts idle 30+ days may be suspended; A1 often out of stock. Mitigation is already in the plan: scheduled jobs keep it non-idle, log in regularly, keep a laptop restore copy.
- **Northflank Sandbox: adopt as the backup test.** 2 services + 1 DB + 2 cron jobs, always-on ("no sleeping"), up to $20/mo resources; smallest paid $2.70/mo. Build minutes/storage allowance not published — verify at signup. Koyeb's free tier closed Feb 2026 (Mistral acquisition) — **remove Koyeb from the plan**.
- **Render Free:** sleeps after 15 min idle, ~1 min cold start; free Postgres **expires 30 days after creation** (14-day grace, then deleted with data). Demo only.
- **Fly.io:** no free tier for new orgs; trial 2 Machine-hours or 7 days; smallest Machine ~$2.02–2.19/mo — cheapest paid floor, needs Ankush's approval.
- **Railway:** $5 trial credit / 30 days, then $5/mo Hobby. Not $0.
- **Cloudflare Workers (100k req/day free):** useful for small stateless jobs/webhooks, not a long-running gateway (10 ms CPU/request). Watch as a companion, not a host.
- **This VM (Muse compute):** not a 24/7 host — unchanged.

### 2.9 Orchestration / plumbing

- **MCP is the tool-plug standard now.** One protocol for Playwright MCP, mem0 MCP, filesystem, Gmail — instead of a bespoke integration per tool. The app's `tools.js` allowlist maps cleanly onto MCP tool definitions; a future `tools.js` can expose the same 4 tools over MCP with the same deny-first rules. **Adopt MCP as the interface for every new tool.**
- **Cron/scheduling:** keep node-cron / system cron in the app; OpenClaw already ships scheduled jobs. No new tool needed. Northflank's 2 free cron jobs are a cloud-side alternative.
- **Tailscale:** keep — free personal plan, still the right tunnel (no public ports, gateway on 127.0.0.1).
- **n8n:** keep for visual workflows (Nova machine already uses it); note its licence is fair-code/Sustainable Use, **not OSI open source** — fine to use, don't sell it as his own code.

---

## 3. Top 10 adoptions (ranked by leverage for Ankush)

### #1 — Fix the brain order: Flash-Lite first, add 3.8 Flash, keep Groq (ADOPT — today, 30 min)
**Why:** the primary brain dies after ~20 turns/day. Flash-Lite gives ~500/day for routine turns; 3.6/3.8 Flash (20/day each) are reserved for hard turns.
**What to change in the app (`brain.js`):**
- `GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash']` — try Lite first; add a `hard` flag on `ask()` that starts at 3.8/3.6 Flash instead.
- Log per-model usage counts per day in SQLite (new table or `jobs` model field — already logged) and warn at 400 Lite / 15 Flash turns.
- Never send customer/private data on Gemini free tier (training opt-in) — route those turns to Groq/Ollama; add a comment to that effect in `brain.js`.
- Re-check AI Studio rate limits monthly; Google does not publish them.

### #2 — Native function-calling + bigger Ollama context (ADOPT — today, half a day)
**Why:** free-text JSON parsing is the app's weakest link; BFCL shows tool-calling is a distinct skill and small models fail at it most when the format is ad-hoc.
**What to change in the app (`brain.js`, `server.js`, `tools.js`):**
- Gemini: pass `tools: [{ functionDeclarations: [...] }]` (one declaration per allowlisted tool, with JSON Schema args) instead of the `TOOL_LIST` text prompt; parse `functionCall` from the response.
- Groq/OpenRouter/Mistral: pass `tools: [...]` in the OpenAI-compatible chat payload; parse `tool_calls`.
- Ollama: pass `tools: [...]` in `/api/chat`; keep the JSON fallback for models that don't emit tool calls.
- Set Ollama `num_ctx: 32768` (was 2048) in `brain.js`; make it env-overridable (`OLLAMA_NUM_CTX`, default 32768; 65536 if RAM ≥16 GB).
- Cap the tool list at 5 tools for local models (see §2.4); cloud models can take the full list.
- Add a test: `tests/test.js` — a mocked tool-call round-trip per provider (no live key needed).

### #3 — Add a browser: Playwright MCP first, Stagehand second (ADOPT — this week, half a day)
**Why:** the app has no browser tool; internship/gig/YouTube research jobs are web jobs. Playwright MCP costs no vision tokens and is deterministic.
**What to change in the app:**
- Run Playwright MCP as a sidecar (`npx @playwright/mcp@latest`) and add a `browse` tool to `tools.js` that calls it (allowlisted actions only: navigate, snapshot, click, type, extract — never `browser_run_code_unsafe`, which is RCE-equivalent).
- Add Stagehand (`act`/`extract`/`observe`) for repeatable jobs (internship listings, YouTube Studio checks) where its cache lets repeat runs skip the LLM.
- Add browser-use (Python) later, only for open-ended web research that MCP + Stagehand can't do.
- Keep the existing rule: never bypass Cloudflare Turnstile / bot checks; a blocked site goes to Ankush in his own browser. Log every browser run's pass/fail per site in `jobs`.

### #4 — Memory: sqlite-vec now, mem0 next (ADOPT — this week, half a day + later)
**Why:** the app forgets everything except raw history; retrieval over notes/jobs is the difference between an assistant and a chatbot.
**What to change in the app (`db.js`, new `memory.js`):**
- `npm install sqlite-vec` (pin `0.1.9`, stable — not the `0.1.10-alpha` line); add a `vec0` table to `personal-ai.db` for note/job embeddings; embed with a local ONNX model (FastEmbed `all-MiniLM-L6-v2`, no GPU).
- Add a `recall(query)` tool: FTS5 keyword + sqlite-vec vector search fused in SQL; call it before every brain turn and inject the top 3–5 memories into the prompt.
- Later: evaluate self-hosted mem0 (Apache-2.0) as a replacement for the hand-rolled extractor — only after sqlite-vec proves the retrieval habit; set `MEM0_TELEMETRY=false`; keep graph memory out (Platform-only anyway); add a pruning job for stale facts (mem0's add-only extraction keeps them otherwise).

### #5 — Swap the coding agent: OpenCode replaces goose (ADOPT — this week, 1 hour)
**Why:** 4× the community, 75+ providers, server mode with an API — the gateway can call it over HTTP instead of shelling out.
**What to change in the app / plan:**
- Install OpenCode on the laptop (`opencode`); point it at Gemini/Groq/Ollama (75+ providers incl. local).
- Update `~/workspace/personal-ai/skills/goose.md` → `skills/opencode.md`: "build via `opencode run <task>` (server mode) or `opencode` TUI; run tests; report repo path + test result; never push without Ankush's yes."
- Update `/api/status` in `server.js`: check OpenCode server instead of (or as well as) `goose --version`.
- Keep goose installed as fallback; keep its adversary-mode lesson (independent review of sensitive tool calls) as a rule in `permissions.json`.
- Research-file update: the 11 Nov file's §3 decision "Coding agent: goose" is superseded.

### #6 — Add OpenRouter `:free` + Mistral free mode as fallbacks 4–5 (ADOPT — today, 1 hour)
**Why:** ~50 + ~1B-token/month (org-shared) extra free turns/day behind Groq; the chain should never stop, just switch.
**What to change in the app (`brain.js`):**
- Add `openrouter(prompt)` (base `https://openrouter.ai/api/v1`, model e.g. `google/gemma-4-31b-it:free` — verify the `:free` list at the time, it rotates; Oct 2026 list had 17–18 IDs) and `mistral(prompt)` (base `https://api.mistral.ai/v1`, model `mistral-small-latest` or `mistral-medium-latest` — verify free-mode eligibility) after Groq in the chain.
- Keys in `.env.local` (`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`), git-ignored, never in chat.
- Mistral: check the training opt-out before first use; never send private data on free mode without it.
- SambaNova: do NOT add until the card-requirement conflict (Oct 2026) is resolved by a live test.

### #7 — Swap the local model: `gpt-oss:20b` on 16 GB RAM (ADOPT — this week, 1 hour)
**Why:** `qwen3:8b` is a generation behind and weaker at tool-calling; `gpt-oss:20b` is the measured best 16 GB local agent model (native function calling, ~140 tok/s on GPU, SWE-bench 60.7).
**What to change in the app / laptop:**
- `ollama pull gpt-oss:20b`; set `OLLAMA_MODEL=gpt-oss:20b` (env already supported in `brain.js`).
- On 8 GB RAM use `qwen3.5:9b` instead; on 24 GB+ use `qwen3.8:27b`.
- Keep `qwen3:0.6b` only as the VM smoke-test model; never present it as an agent brain.
- Re-run the brain test (`POST /api/brain/test`, provider `ollama`) after the swap and record the result in `logs/`.

### #8 — Copy Hermes' Curator: a nightly skill-writer job (ADOPT — this week, half a day)
**Why:** the only Hermes feature with no OpenClaw equivalent, and it compounds: the agent gets better at Ankush's actual workflows (internships, Nova, agency) instead of starting from zero daily.
**What to change in the app:**
- New cron job (daily, after the last run): read today's `jobs` + `audit_log` from SQLite, ask the brain (Flash-Lite, cheap) "what worked, what failed, write/update one Markdown skill in `skills/learned/`"; **never auto-apply** — learned skills land as drafts for Ankush to approve, and never touch `permissions.json` or the allowlist.
- Cap: one skill file per workflow, dated, with the evidence (job IDs) cited in it.
- Guardrail from the Hermes risk reports: if a learned skill contradicts an existing rule, flag it, don't merge it.

### #9 — Voice in/out: faster-whisper + Kokoro (English) + Piper (Hindi check) (ADOPT — next week, half a day)
**Why:** phone control is text today; voice notes from WhatsApp/Telegram are the natural next input, and Nova voiceovers are already a workflow.
**What to change in the app:**
- Add `POST /api/voice/transcribe` (faster-whisper local, `whisper-large-v3-turbo` or small on CPU; Groq Whisper as fallback) and `POST /api/voice/speak` (Kokoro-FastAPI for English; Piper for Hindi — **verify the Hindi voice first**).
- Keep Kokoro's known limit in mind: its HF voice-model download failed twice from this VM (10 Nov) — run voice on the laptop, not this VM.
- Qwen3-TTS: test on the laptop (needs GPU) for multilingual cloning later; **do not use for Hindi** (not supported) and never clone a voice without documented permission.

### #10 — Cloud backup test: Northflank Sandbox (ADOPT — after Phase 5 passes, 1 hour)
**Why:** Oracle is still #1 but capacity + idle-reclaim are single points of failure; Northflank is the only other confirmed $0 always-on host.
**What to change in the plan (no app code):**
- After the laptop Phase-5 jobs pass, deploy the same gateway + app to Northflank Sandbox (2 services: gateway + app; 1 DB: keep SQLite file on the volume; 2 cron jobs: internship + Nova runs) as a live backup test for 7 days.
- If Northflank's unpublished build-minute/storage limits bite, report and fall back to Oracle-only; do not pay without Ankush's decision (paid floor: Fly.io ~$2/mo, Render Starter $7/mo, Hetzner ~€4.35/mo).

---

## 4. What stays exactly as it is (KEEP)

- **OpenClaw as the gateway** — no alternative beats it for laptop + phone + cloud at $0.
- **Gemini → Groq → Ollama brain philosophy** — only the order and the model names change (#1, #6, #7).
- **$0 rule, deny-first permissions, allowlist Ankush-only, approval-before-send/spend/delete, secrets in `.env.local`** — every alternative above was judged against these; none of them weakens them.
- **Oracle Always Free as the v2 cloud target; Tailscale as the tunnel; laptop-first, prove-then-cloud order.**
- **Playwright (deterministic scripts) and n8n (visual workflows)** — complements, not replacements.
- **Telegram first, WhatsApp second on a spare number only** — the ban-risk evidence got stronger, not weaker.

## 5. What to explicitly NOT do (SKIP list, with reasons)

| Skip | Why |
|---|---|
| AutoGen for new work | Maintenance mode; Microsoft Agent Framework is the successor |
| Skyvern as the browser agent | AGPL-3.0 copyleft + ~30–50k tokens/10 steps; browser-use/Stagehand are cheaper and permissively licensed |
| ChromaDB for memory | Prototype-only reputation now; single-writer, no quantization, memory blow-up |
| Cerebras as a brain | $5 trial, 30 days, card required — fails the $0-forever rule |
| Koyeb as a host | Free tier closed to new users Feb 2026 |
| Railway / Fly.io free as "free forever" | Trial-only for new accounts; Fly.io is the *paid* fallback (~$2/mo), not a free host |
| DeepSeek Harness as the daily driver | Developer preview, no security audit, breaking changes promised |
| Agent Zero as v1 | Docker-heavy, "can be dangerous" by its own README, CVE history in 2026 — sandbox for untrusted work later |
| Desktop screenshot→click agent as v1 | OSWorld 2.0: 20.6% full completion for the best agent — research-grade |
| Cline / Claude Code / Codex as the base | Great coders, wrong shape (editor/terminal-only, paid models, no phone/cloud gateway) |
| SambaNova until verified | Conflicting Oct 2026 reports on whether a card is now required |
| Selling anything built on n8n / Skyvern / Piper-GPL as "his own code" | Licence: n8n is fair-code (not OSI), Skyvern AGPL, Piper engine GPL-3.0 — use freely, credit and comply, don't rebrand |

## 6. Research notes / honesty box

- **Star counts are attention, not quality.** OpenClaw 392k vs Agent Zero 19k does not mean OpenClaw is 20× better at a job — it means 20× more people starred it. Every verdict above uses stars as one signal alongside licence, maintenance (last release/push), $0 fit, and laptop+phone+cloud coverage.
- **Vendor benchmarks are self-reported.** browser-use 89.1% WebVoyager, Skyvern 85.85%, mem0 LoCoMo 92.5 / LongMemEval 94.4, Hermes "40% faster with skills", Qwen3-TTS 97 ms first packet — all vendor or vendor-adjacent numbers, different suites, different judges, not independently re-run here. The app should keep its own pass/fail log per job and per site.
- **Free tiers changed during 2026 and will change again.** In this research alone: Oracle halved A1 (Jun 2026), Koyeb closed free (Feb 2026), GitHub Models retired (Jul 30, 2026), Cerebras/SambaNova added card requirements (Aug 2026), Gemini stopped publishing per-model limits, OpenRouter's `:free` list rotated (DeepSeek/Qwen/Kimi/gpt-oss removed, Oct 2026). **Re-check every limit in the vendor's own docs/AI Studio/console before relying on it.**
- **Unverified claims in this file:** SambaNova's current card requirement (conflicting sources); Mistral's ~1B tokens/month free-mode cap (reported, shown in admin panel — verify); Northflank's build-minute/storage allowance (unpublished); Hermes' 40% skill speed-up (not independently re-run); Piper Hindi voice quality (unverified by ear — same rule as the Casano videos: Ankush listens once per language first).
- **Model names rotate fast.** `gemini-3.8-flash` is newest free Flash as of Oct 2026; `gemini-2.5-flash` is 404 for new users; Qwen generations moved 3 → 3.5 → 3.6 → 3.8 during 2026. Always check AI Studio / Ollama library for the current tag before hard-coding.

## 7. Sources (checked 12 Nov 2026)

- OpenClaw / Hermes / DeepSeek Harness stars & comparison: https://blog.sandbase.ai/deepseek-harness-vs-openclaw-vs-hermes-2026/ · https://coworkosapp.com/research/open-source-ai-agents-2026/ · https://www.agent37.com/blog/openclaw-vs-codex · https://todofor.ai/blog/best-open-source-ai-agents-2026
- Hermes Agent: https://www.truefoundry.com/blog/what-is-hermes-agent · https://slomka.pro/blog/hermes-agent-review-nous-research-s-self-improving-ai-agent · https://www.mackenziebowes.com/research/top-ai-agent-harnesses-survey
- DeepSeek Harness: https://aifoss.dev/blog/deepseek-harness-dsh-agent-review-2026/ · https://vdf.ai/blog/deepseek-harness/ · https://www.eesel.ai/blog/deepseek-harness
- goose: https://aitoolanalysis.com/goose-ai-review/ · https://www.promptquorum.com/power-local-llm/goose-review · http://localaimaster.com/blog/goose-ollama-local-agent
- OpenCode / Cline / Codex CLI: https://openalternative.co/blog/best-open-source-ai-coding-agents · https://www.morphllm.com/comparisons/opencode-vs-cline · https://octomind.run/blog/open-source-ai-agents · https://upstash.com/kb/opencode-vs-pi-vs-gemini-cli-vs-crewai-vs-goose-9-agent-harnesses-compared
- Agent Zero: https://mausbot.com/blog/open-source-ai-agent-apps-compared · https://www.bestgithubrepositories.com/best/open-source-ai-agents · https://www.reviewramble.com/github-repos/agent-zero
- Frameworks: https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/langgraph-vs-crewai-vs-autogen-agent-frameworks · https://gravity.fast/blog/open-source-ai-agent-frameworks/ · https://aireviewrating.com/articles/best-open-source-ai-agent-frameworks · https://resources.rework.com/tools/ai-agents/best-open-source-ai-agent-frameworks-2026
- Browser agents: https://rpabotsworld.com/browser-use-open-source-ai-browser-agent-rpa-guide/ · https://menuagentic.com/blogs/browser-use-vs-stagehand-vs-skyvern-vs-playwright-mcp · https://www.digitalapplied.com/blog/open-source-browser-computer-use-agents-2026 · https://changegamer.ai/resources/computer-use-browser-automation
- Benchmarks / papers: https://metarix.io/ai-agent-benchmarks-compared · https://benchlm.ai/benchmarks/osworld2 · https://www.benchleader.com/benchmarks/bfcl_overall · https://qaskills.sh/blog/bfcl-berkeley-function-calling-leaderboard-guide-2026 · OSWorld 2.0 paper arXiv 2606.29537 (Jun 2026)
- Gemini free tier: https://iimagined.ai/blog/gemini-api-free-tier-limits · https://www.scriptbyai.com/gemini-api-free-tier-limits/ · https://boredlisted.com/gemini-free-tier-limits · https://dev.to/hassann/gemini-api-free-tier-in-2026-limits-models-and-when-you-get-billed-4081
- Groq free tier: https://apidog.com/blog/free-ai-api/ · https://weneedai.net/groq-free-tier-limits/ · https://localaimaster.com/blog/groq-api-free-guide · https://toolfreebie.com/groq-fastest-free-ai-api/
- Other free LLM APIs: https://openrouter.ai/blog/tutorials/free-llm-apis-compared/ · https://verna.one/free-llm-apis · https://grokified.com/blog/free-llm-api · https://newsroom.sgit.ai/articles/free-models-your-own-key.html
- Local models / Ollama: https://runitlocal.io/learn/best-local-model-for-agents-and-tool-calling · https://www.promptise.com/guides/view/best-local-llm-for-ai-agents · https://www.glukhov.org/llm-performance/benchmarks/choosing-best-llm-for-ollama-on-16gb-vram-gpu/ · https://docs.waymakerone.com/mcp/local-models
- Voice: https://rakazo.com/voice-providers/self-hosted/ · https://www.promptquorum.com/power-local-llm/piper-vs-kokoro-tts · https://texttolab.com/blog/open-source-text-to-speech · https://localaimaster.com/blog/best-local-tts-models · https://www.therundown.ai/tools/qwen3-tts
- Memory / vector DBs: https://skilldirectory.dev/blog/best-github-repos-ai-agent-memory · https://www.reviewramble.com/github-repos/mem0 · https://hindsight.vectorize.io/blog/2026/08/11/open-source-agent-memory-systems · https://d-central.tech/self-hosted-vector-databases/ · https://aifoss.dev/blog/pgvector-vs-chroma-vs-qdrant-local-rag-2026/ · https://hysenlabs.com/projects/asg017-sqlite-vec
- WhatsApp / Telegram: https://openclaw-easy.com/blog/whatsapp-ai-bot-ban-risk.html · https://openclaw.direct/blog/whatsapp-ban-openclaw-telegram-setup · https://zenvanriel.com/ai-engineer-blog/openclaw-whatsapp-risks-engineers-guide/
- Cloud $0 hosts: https://www.aicassindra.com/blogs/cloud/oci_free_tier.html · https://prodogon.com/blog/devops/deploy-free-app-oracle/ · https://www.toolbistro.com/radar/oracle-cloud-free-tier · https://toolfreebie.com/koyeb-free-tier-alternatives/ · https://www.prompttoprod.app/best/heroku-alternatives/ · https://agentdeals.dev/hosting-pricing

*Prior baseline (not web): `~/workspace/research/personal-ai-laptop-phone-cloud-2026-11-11.md` (11 Nov 2026) and `~/workspace/personal-ai/app/` (`brain.js`, `tools.js`, `server.js`, `package.json`) as read 12 Nov 2026. No code was edited, no account created, no money spent, no one contacted for this research.*
