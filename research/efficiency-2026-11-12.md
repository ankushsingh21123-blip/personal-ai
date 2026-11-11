# Personal AI — efficiency research: how to beat Codex / Muse at $0

**Owner:** Ankush Singh — BSc CS, Scaler School of Technology, Bengaluru / Hyderabad
**Date checked:** 12 Nov 2026 (all web claims below are dated; free tiers change fast — re-check each vendor's own page before relying on a limit)
**Scope:** the working app in `~/workspace/personal-ai/app/` (Node/Express + SQLite, `brain.js` → `tools.js` → `server.js`), built on the stack from `~/workspace/research/personal-ai-laptop-phone-cloud-2026-11-11.md` (OpenClaw gateway + goose coding agent; brain Gemini free → Groq free → Ollama local).
**Rule:** **$0 for everything.** No paid signups, no spending, no accounts created, no one contacted for this research. Nothing in the app was edited — this file is research + a ranked change list only.
**Honesty note:** "Beat Codex / Muse" is the wrong claim if it means "out-code GPT-6 / Claude on hard tasks" — no free model does that (see §5). The claim that *is* true and winnable: **a personal agent that is faster, cheaper ($0), and more useful *for Ankush's actual jobs* (internships, gigs, agency, Nova Shorts, scholarships) than a paid general coding agent**, because it is specialised, always-on, phone-controlled, and remembers his workflows. That is what the top 10 below optimise for.

---

## What the app does today (read 12 Nov 2026 — the baseline)

From `app/brain.js`, `app/tools.js`, `app/server.js`, `app/package.json`:

- **Brain:** single plain-text prompt per turn → Gemini REST `generateContent` (`gemini-3.6-flash` → `gemini-3.5-flash-lite`) → Groq chat completions (`openai/gpt-oss-120b`) → Ollama `/api/chat` (`qwen3:0.6b` on this VM, `qwen3:8b` on the laptop). Sequential fallback, 120 s timeout, no retry-after / 429 handling.
- **Tool use:** the model must emit JSON text (`{"reply":…,"actions":[…]}`) which `server.js` parses with `JSON.parse`; if parsing fails, the whole text becomes the reply and **no tools run**. Small local models frequently fail this. There is **no native function/tool calling** on any provider, even though Groq and Gemini both offer it free.
- **Tools (4 only):** `list_files`, `read_file`, `write_note` (SQLite), `run_command` (7 allowlisted commands). No file **edit/write**, no **web search/fetch**, no git write, no goose call from the app. Send/post/spend/delete correctly go to approvals only.
- **Memory:** messages, jobs, notes, approvals, audit log are all stored in SQLite — but **`agentTurn()` never reads them back**. Every turn is stateless: the model sees only the system prompt + the one user message. No conversation history, no memory recall, no compaction.
- **Context:** Ollama call hard-codes `num_ctx: 2048` in `brain.js` — below the 4,096 default and far below the 32,768–65,536 Ollama itself recommends for agents (see §3). Tool results are truncated to 2,000 chars, max 5 actions, run **sequentially** in a `for` loop.
- **No streaming, no caching, no parallelism, no sub-agents, no skills, no plan mode, no per-task model routing.** Rate limit is a simple in-memory 60 req/min.

That baseline is a solid, safe v1. The gaps above are exactly where the efficiency wins live — most of them are code changes, not new services, and all are $0.

---

## 1. Ranked recommendations — top 10

Ordered by (gain ÷ effort), all $0. "What to change" names the exact file/function.

### #1 — Switch the brain to native function calling (biggest single win)

**What to change:** in `brain.js`, stop asking the model to emit JSON text. Use each provider's real tool-calling API and pass the 4 tools as a schema:
- **Groq:** OpenAI-compatible chat completions already in use — add `tools: [...]` + `tool_choice: "auto"` to the same request, then loop on `tool_calls` instead of `JSON.parse`. Free, same endpoint.
- **Gemini:** use the OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai/` (documented, free tier) with the same `tools` array, instead of the REST `generateContent` text call. Or use Gemini's native `functionCalling` via `generateContent` — either way, stop parsing prose.
- **Ollama:** `/api/chat` already supports `tools` natively — pass the schema; only models with the `tools` label on ollama.com will use it (check before pulling).
- Keep the text-JSON path only as a last-resort fallback for a model that returns no `tool_calls`.

**Expected gain:** tool-use reliability jumps from "works when the model feels like emitting valid JSON" to "works by construction". This is the #1 reason small local models look dumb in the current app — they can call tools fine when the API does the parsing, but they mangle hand-written JSON. Anthropic's own measurements (reported Nov 2026): tool-search/deferred loading cut one setup's upfront tool overhead from ~77K tokens to ~8.7K and lifted MCP-eval accuracy on Opus 4.5 from 79.5% → 88.1%. The mechanism (fewer, schema-enforced calls) applies at any scale.
**$0 cost:** yes — same free endpoints, no new account.
**Risk:** low-medium. Requires rewriting `agentTurn()` in `server.js` into a real loop (model → tool_calls → execute → feed results back → model again, cap ~8 rounds). Must keep the deny-first `tools.execute()` gate — native tool calling must never bypass it. Test with `qwen3:0.6b` first: if it still can't call tools, route tool-heavy turns to Gemini/Groq and keep Ollama for plain chat.

### #2 — Promote Gemini 3.8 Flash to primary brain (free, newer, 1M context)

**What to change:** in `brain.js`, change `GEMINI_MODELS` to `['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']`. Same for the `gemini.py` helper call (`--model gemini-3.6-flash` → `gemini-3.8-flash`). One-line change + a test call.

**Expected gain:** Gemini 3.8 Flash (GA 2 Sep 2026, Google's recommended Flash for new projects) is the highest-ranked model on any provider's free tier — BenchLM dataset 11 Nov 2026 scores it 66.6 overall vs 62.4 for 3.6 Flash; multiple OpenClaw guides (Oct 2026) call it the #1 free agent model. Context window 1,048,576 input / 65,536 output tokens vs the 32K window of the free Gemini *app* (the API free tier is a different, larger allowance — do not confuse the two). Better tool-calling and reasoning than 3.6 for the same $0.
**$0 cost:** yes — "Free of charge" on the Gemini API Free Tier (Google pricing page, read 28 Oct / 1 Nov 2026). Paid price $0.75/$3.75 per 1M in/out through 31 Dec 2026, doubling 1 Jan 2027 — irrelevant while on the free tier, but note the date.
**Risk:** low. Free-tier rate limits are **not published** — Google shows them per project in AI Studio and they "are not guaranteed"; RPD resets midnight Pacific. If 3.8 429s, the existing fallback chain (3.6 → Flash-Lite → Groq → Ollama) already handles it. **Verify in AI Studio** that 3.8 Flash answers on Ankush's existing project before relying on it. Also: free-tier prompts may be used to improve Google's products — never send client/private data on it (already the standing rule).

### #3 — Fix the Ollama context trap: `num_ctx: 2048` → 32768 minimum (one-line fix, large effect)

**What to change:** in `brain.js` `ollama()`, `options: { num_ctx: 2048, … }` → `num_ctx: 32768`. On the laptop, also set `OLLAMA_CONTEXT_LENGTH=32768` (or 65536) as a server env var / Modelfile `PARAMETER num_ctx 32768`, because the per-request value and the server default interact and the server default on CPU-only / low-VRAM machines is 4,096. Confirm with `ollama ps` (CONTEXT column).

**Expected gain:** at 2,048 tokens the system prompt + tool schemas + one file read already overflow, and Ollama **silently truncates** — the agent then loops, forgets instructions, or emits prose instead of tool calls. Ollama's own docs (via integration guides checked Oct–Nov 2026) say agents/coding tools need **≥64,000** tokens; 16–32K is where tool calling "stops misbehaving", 64K is where it gets comfortable. This single number is very likely why local runs feel broken.
**$0 cost:** yes.
**Risk:** low, but KV-cache memory grows roughly linearly with `num_ctx` — on a 16 GB laptop, 32K is safe; 64K may OOM with an 8B model. Use 32768 on the laptop, 65536 only if RAM allows. Also upgrade the local model (see #4) — `qwen3:0.6b` on this VM is a toy; it cannot do tool-calling reliably at any context size.

### #4 — Upgrade the local model: `qwen3:8b` → `qwen3-coder:30b` on the laptop, `gpt-oss:20b` as the 16 GB fallback; add Groq `qwen/qwen3.8-27b` as a free cloud fallback

**What to change:** laptop Ollama: `ollama pull qwen3-coder:30b` (~19 GB, 256K native context, MoE 30B total / 3.3B active per token, `tools` label on ollama.com). If disk/RAM won't take it, `gpt-oss:20b` (~14 GB, 128K context, runs within 16 GB per OpenAI). In `brain.js`, make the Groq fallback try `qwen/qwen3.8-27b` first and `openai/gpt-oss-120b` second (both same free limits: 30 RPM / 1,000 RPD / 8K TPM / 200K TPD).

**Expected gain:** `qwen3:8b` (general chat model) is the wrong tool for an agent; `qwen3-coder:30b` is the consensus best local coding-agent model of 2026 (multiple guides, Aug–Nov 2026) and the MoE design makes it fast for its size. On Groq, `qwen3.8-27b` is repeatedly ranked the best free option — "strong for coding", ~500 tok/s-class speeds — ahead of `gpt-oss-120b` (BenchLM 11 Nov 2026: Qwen3.8-27b 54.4 vs gpt-oss-120b 32.0 overall; treat single-benchmark scores as directional, not gospel). Qwen3.8 (the newer family, Aug 2026, Apache-2.0) is also the best free *local* LLM overall per TechVerdict (Nov 2026): Qwen3.8 27B is #1 of 142 open models in its size class on the Artificial Analysis Intelligence Index (34 vs 58 for Claude Opus 5.5 — still far behind frontier, but the best that fits hardware a person can buy).
**$0 cost:** yes — Ollama local is free; Groq free tier unchanged.
**Risk:** medium. `qwen3-coder:30b` needs ~19 GB download + ~24 GB VRAM (or 32 GB+ unified RAM) for comfort; on a 16 GB laptop it will be slow (CPU offload, ~3–8 tok/s) or OOM — test before committing, keep `gpt-oss:20b` as the fallback. Do **not** chase `qwen3-coder-next` (80B MoE, ~48 GB, 70.6% SWE-bench Verified) — it needs ~48 GB combined RAM/VRAM, not a laptop model. Note the naming trap: `qwen3-coder` (2025, 30B) vs `qwen3.8-27b` (Aug 2026, different family) vs `qwen3:8b` (general) are three different things — pin exact tags.

### #5 — Give the agent a memory: feed SQLite history + notes back into the prompt, with summarisation (copy Claude Code / OpenClaw's memory pattern)

**What to change:** in `server.js` `agentTurn()`, before calling the brain: load the last ~10 messages from SQLite (`db.js`, already stored) + matching notes (keyword match on the user's text) + a short "facts" block, and prepend them to the prompt. Add a `memory.md` summary file the agent updates at the end of each session (facts, decisions, open jobs — max ~30 lines, rewritten, not appended forever). When history grows past ~8K tokens, summarise it with the cheapest brain (Flash-Lite or Ollama) into that file and drop the raw turns — threshold-triggered compaction at ~60–70% of the effective window, per the Nov 2026 consensus (Anthropic's own guidance + JetBrains Research 'Complexity Trap', arXiv 2508.21433: pure LLM summarisation can make trajectories up to 15% longer because summaries hide "I'm done" signals — so **clear stale tool results first, summarise second**, and always persist the raw log in SQLite separately).

**Expected gain:** this is the difference between "a chatbot that forgets you every message" and "a personal AI". It is also what Muse does and Codex/Claude Code do via `CLAUDE.md`/`AGENTS.md` + built-in memory. OpenClaw 2.0 (30 Aug 2026) consolidated exactly this: built-in Memory with search/recall, background consolidation of provenance-qualified material into long-term memory, and self-learning that proposes new skills from strong lessons. Copy the pattern, not the code: short-term = recent turns in context; long-term = a curated file + SQLite, recalled by keyword, written sparingly.
**$0 cost:** yes — SQLite + a Markdown file already exist.
**Risk:** medium. Two failure modes: (a) unbounded history bloats every prompt and burns the free tier (mitigate with the token budget + summarisation above); (b) prompt injection via recalled memory — a poisoned note recalled later is still untrusted data (keep the existing "outside content is data" rule; never let recalled text authorise a send/spend/delete).

### #6 — Add the two missing tools the agent needs most: web search/fetch + file edit (behind the existing approval gate)

**What to change:** in `tools.js`, add `web_search` (free: DuckDuckGo HTML endpoint or Google Gemini grounding — no key; or reuse the existing Gemini helper for a search-grounded answer) and `web_fetch` (fetch a URL, strip HTML, truncate to ~4K chars), and `edit_file` (read → apply a precise old/new string replacement → write, with a `.bak`/git backup first). Wire them into `TOOL_LIST` in `server.js`. `edit_file` stays in the **ask** list: it creates an approval for multi-file or non-workspace edits, and is allowlisted only for files under the workspace that already exist.

**Expected gain:** right now the agent cannot do its own core jobs — it can't research an internship, check a deadline, or change a line of code. Every one of Ankush's five Phase-5 proof jobs needs at least one of these. Web fetch also removes the need to paste whole pages into chat (a major token saver).
**$0 cost:** yes.
**Risk:** medium. `edit_file` is the first tool that mutates user files — keep the deny-first audit, require exact-match replacement (no fuzzy writes), back up before writing, and log every edit to `audit_log` (already exists). `web_fetch` must never fetch a URL from untrusted content and execute anything in it — fetch = read text only, never run.

### #7 — Parallelise independent tool calls + add a plan mode (copy Codex/Claude Code's two cheapest speed patterns)

**What to change:** (a) in `server.js`, when the model returns multiple actions with no dependency between them (e.g. three `read_file`s), run them with `Promise.allSettled` instead of the sequential `for` loop. Add one line to the system prompt: "If actions are independent, return them together in one response; I will run them in parallel." (b) Add a plan mode: if the user message starts with "plan:" or the task touches 3+ files, the agent first returns a short plan (steps + files + risks) and waits for "go" before executing — store the plan as a pending approval, reuse the existing approvals table.

**Expected gain:** latency. Sequential tool calls are the slowest part of any agent loop — each is a full model round-trip. Codex's own community measured GPT-5.6 *serialising* independent calls and inflating token use 27–45% until an explicit batching directive was added (GitHub issue #35050, Jul 2026; codex.danielvaughan.com, Jul 2026). The fix is literally a prompt instruction + `Promise.allSettled`. Plan mode (Claude Code's most-recommended pattern, May–Jun 2026 guides) prevents the agent burning the whole free-tier budget on a misread task — it surfaces misinterpretation before execution.
**$0 cost:** yes.
**Risk:** low. Parallel calls must still respect the audit log and the allowlist; cap at 5 concurrent (already the actions cap). Plan mode adds one round-trip of latency on big tasks — worth it, since a wrong 10-step run costs far more.

### #8 — Add a fourth free brain as insurance: OpenRouter `:free` (and note the two backups) — but never hard-code a model ID

**What to change:** in `brain.js`, add an `openrouter` provider at the end of the chain (after Ollama), calling `https://openrouter.ai/api/v1/chat/completions` with model `openrouter/free` (the auto-router over whatever `:free` models exist that day) and `OPENROUTER_API_KEY` from `.env.local`. No card needed for `:free` models.

**Expected gain:** resilience. Free tiers die without notice — GitHub Models was retired 30 Jul 2026; Groq shut down its Llama models 16 Aug 2026; `qwen/qwen3-coder:free` and `openai/gpt-oss-120b:free` both disappeared from OpenRouter between Jul–Oct 2026. A fourth provider means the agent keeps answering when any one vendor changes its tier. OpenRouter `:free` limits (checked 10 Nov 2026): 20 req/min, **50 req/day** (1,000/day only after a one-time ≥$10 credit purchase — **do not buy it; the $0 rule forbids it**, so treat this as a 50/day emergency provider). The `openrouter/free` router ID is the key trick: it survives model rotation, where a pinned `:free` ID breaks.
**$0 cost:** yes — no card, no purchase. (The $10 credit bump is explicitly *not* recommended.)
**Risk:** low-medium. Free models on OpenRouter are best-effort, can be slow/crowded, and the lineup rotates — hence `openrouter/free`, never a pinned ID. Other $0 backups worth knowing, not wiring yet: **SambaNova Cloud** free tier (20 req/day per model, 200K tokens/day per model — DeepSeek V3.1, gpt-oss-120b, Llama-3.3-70B) and **Cloudflare Workers AI** (10,000 Neurons/day, `gpt-oss-120b`). Both verified Oct–Nov 2026; add only if a second provider dies.

### #9 — Add "Code Mode" for multi-step work: let the model write one small script instead of 10 tool calls (copy the pattern Anthropic / OpenAI / Cloudflare / goose all shipped in 2026)

**What to change:** add a `run_script` tool in `tools.js`: the model writes a short Node script (read-only first version: it may call only the existing allowlisted tools via a tiny `tools` object injected into the script — `listFiles()`, `readFile()`, `search()`), the server runs it in a sandboxed `vm` context with a 10 s timeout and no `require`/`fs`/`child_process` access, and only the script's final return value goes back to the model. Only enable it for tasks with loops, filters, or ≥3 chained calls.

**Expected gain:** the largest *token* saving available. Anthropic (Nov 2025, "Code execution with MCP"): a 20-employee expense check dropped from 200KB of raw data to 1KB of results in context; complex research tasks fell from 43,588 → 27,297 tokens on average (**37% cut**); one workflow fell from ~150,000 tokens to ~2,000 (**98.7%**). Cloudflare (Sep 2025, Feb 2026): its whole API as one-tool-per-endpoint MCP cost 1,170,523 tokens vs 1,069 for two Code Mode tools — a 99.9% cut; Code Mode is now default in its MCP portals (Mar 2026). Goose ships it as a platform extension since v1.17.0 (Dec 2025). For Ankush this matters because the binding constraint is the free tier's token/day cap (Groq 200K/day; Gemini unpublished) — fewer tokens per task = more tasks per day.
**$0 cost:** yes — Node's built-in `vm` module, no dependency.
**Risk:** **high if done carelessly — this is the one recommendation to implement last and test hardest.** Running model-written code is an untrusted-code boundary: without a real sandbox it is a prompt-injection hole (a web page could make the agent write a script that exfiltrates `.env`). Mitigations, in order: (1) v1 is read-only and can only call the injected tool functions — no `fs`, no network, no shell; (2) 10 s timeout + output cap; (3) log the script text to `audit_log`; (4) never enable a write-capable version without a separate review. If in doubt, skip this and take the gains from #1–#8 first.

### #10 — Adopt OpenClaw's Nov 2026 upgrades in the gateway layer: Knowledge Scribes + Advisor + request-bound approvals (don't rebuild the gateway — upgrade it)

**What to change:** on the laptop, upgrade OpenClaw to the current stable line (v2026.11.x) and turn on: (a) **Knowledge Scribes** — first-class knowledge capture and reusable scribe workflows across agents/sessions (new in v2026.11.5-beta.1, 4 Nov 2026); use it for the Nova Shorts / internship / agency playbooks instead of re-explaining them each session. (b) **Advisor** (v2026.10.10, 3 Nov 2026) — suggests course corrections mid-task; the app equivalent is a "did this go off-track?" check after 3 failed tool calls (add a counter in `agentTurn()` that stops and asks Ankush instead of looping). (c) **Request-bound approvals** — OpenClaw 2.0 (30 Aug 2026) binds each approval to the exact request, command, session and person, and keeps credential values write-only; mirror this in `server.js` by storing the exact tool + args + requester in the approvals row (today it stores only action + details text).

**Expected gain:** less re-explaining (Scribes ≈ the skills pattern in #5, but in the gateway where WhatsApp/phone sessions live), fewer wasted loops (Advisor ≈ a 3-strike rule), and approvals that can't be replayed against a different command (a real security gain). Also relevant: **Multiplayer** (5 Nov 2026, free, MIT) — multiple people share one agent/workspace/context with a shared queue — *do not* enable it for Ankush's personal agent (allowlist is Ankush-only), but note it as the future team feature if he ever sells a team version. **PRs from chat** (same beta) is the pattern to copy for "push this proof project to GitHub" — prepare → review → publish from the conversation.
**$0 cost:** yes — all in the free MIT-licensed software; the model is still BYO.
**Risk:** low-medium. v2026.11.5-beta.1 is a **beta** — upgrade the laptop gateway to the latest *stable* (v2026.11.3, 10 Nov 2026: fixes-only, credential isolation, private subagent results kept out of streamed replies) and wait for the beta line to stabilise before taking Scribes. Pin the version; don't track `openclaw@latest` blindly.

---

## 2. The free-model table, as verified 12 Nov 2026

| Model | Where | Free-tier limit (verified) | Context | Best for | Verdict for this app |
|---|---|---|---|---|---|
| **gemini-3.8-flash** | Gemini API (AI Studio) | Free of charge; RPM/TPM/RPD **not published** — shown per project in AI Studio; RPD resets midnight Pacific | 1,048,576 in / 65,536 out | Primary brain, tool-calling, long context | **New primary (#2)** |
| gemini-3.6-flash | Gemini API | Same free tier, unpublished limits | 1M (per model page family) | Fallback 1 | Keep as fallback |
| gemini-3.5-flash-lite | Gemini API | Same free tier | 1M (family) | Cheap summarisation/compaction | Keep — use for #5 summaries |
| **qwen/qwen3.8-27b** | Groq free | 30 RPM / 1,000 RPD / 8K TPM / **200K TPD** | 131,072 | Best free Groq model, coding | **New Groq primary (#4)** |
| openai/gpt-oss-120b | Groq free | Same 30/1,000/8K/200K | 131,072 | General fallback, ~500 tok/s claimed (measured 261–525 tok/s, Aug–Oct 2026) | Keep as Groq fallback |
| openai/gpt-oss-20b | Groq free | Same 30/1,000/8K/200K | 131,072 | Fast, small | Spare |
| qwen3-coder:30b | Ollama local | Your hardware only | 256K native | Local coding agent | **New laptop local (#4)** |
| gpt-oss:20b | Ollama local | Your hardware only | 128K | Local on 16 GB laptop | Local fallback |
| `openrouter/free` | OpenRouter `:free` | 20 RPM / **50 req/day** (1,000/day only after $10 credit — do not buy) | Varies (router) | Emergency 4th provider | **New insurance (#8)** |
| DeepSeek V3.1 / gpt-oss-120b | SambaNova free | 20 req/day per model, 200K tok/day per model | Varies | Backup only | Note, don't wire yet |
| gpt-oss-120b | Cloudflare Workers AI | 10,000 Neurons/day | 128K | Backup only | Note, don't wire yet |

**Binding constraints to design around:** Groq's 8K tokens/min is hit long before its 1,000 req/day (8K TPM = ~8 seconds of gpt-oss-120b at full speed, then 429s — Groq returns `retry-after`; the app currently has **no 429 handling**, so add: on 429, wait the `retry-after` seconds, then fall to the next provider). Gemini's unpublished limits mean the app must treat *any* Gemini 429 as "switch provider immediately", not "retry". Free-tier prompts on Gemini may be used to improve Google's products — keep private/client data off it.

**What changed since the 11 Nov research file:** `gemini-3.8-flash` is now confirmed (not just "verify in AI Studio") as GA since 2 Sep 2026, free tier, 1M context, and the top-ranked free-tier model. `qwen3.8-27b` (Aug 2026 family) is confirmed as the better Groq pick than `gpt-oss-120b`. The 11 Nov file's "Gemini 3.6 Flash is the newest free Flash" framing is now outdated — 3.8 supersedes it. `gemini-2.5-flash` is gone (deprecated; routes to Flash-Lite from 1 Dec 2026) — the app already avoids it, correctly.

---

## 3. Agent patterns to copy (from Codex / Claude Code / Muse — patterns, not code)

| Pattern | Who does it | What it is | How it maps to this app |
|---|---|---|---|
| **Perceive → reason → act, but prefer APIs over screenshots** | Codex, Claude computer use, Muse | Screenshot/click is the slow fallback; file/shell/browser-API tools are the fast path | Already the app's stance — keep it. Never build a GUI clicker for v1. |
| **Plan mode before action mode** | Claude Code (`/plan`, Shift+Tab) | Read-only exploration + proposed plan → human approves → execute | #7 — cheapest safety + token win |
| **Skills (SKILL.md, on-demand loading)** | Claude Code, Codex, OpenClaw Scribes | A workflow written once, loaded only when the trigger matches; never in the base prompt | #5/#10 — Nova Shorts, internship, agency playbooks as `skills/*.md`, loaded by keyword |
| **Sub-agents: fan out, summarise back** | Claude Code Task tool, Codex subagents (client + server-side multi-agent, GPT-5.6, Jul 2026) | A child agent does noisy work in its own context and returns only a summary; parent context stays clean | Future: run "research 3 internships" as 3 parallel goose/OpenClaw sub-tasks and merge summaries. **Caution from Codex docs:** sub-agents consume *more* total tokens than a single-agent run — parallelise breadth (independent research), never dependency chains, max 3 lanes. Not a v1 change; note for v2. |
| **Model routing per lane** | Codex (Sol/Terra/Luna tiers), Claude Code (cheap model for discovery, frontier for judgement) | Cheap/fast model for mechanical work, strong model for decisions | Free-tier version: Flash-Lite/Ollama for summarise/classify, 3.8 Flash for decisions, Groq Qwen for code. Add a `route` hint in `agentTurn()` — no new provider needed. |
| **Hooks: deterministic guardrails** | Claude Code PreToolUse/PostToolUse hooks | A script that *always* runs before/after a tool — block `rm -rf`, auto-format, log | The app already has this in spirit (`tools.js` deny-first + `audit()`). Copy the *shape*: a `preTool` check function in `tools.js` that every tool passes through, so a new tool can't accidentally skip the gate. |
| **Approvals bound to the exact request** | OpenClaw 2.0, Claude Code permissions (deny → ask → allow) | An approval is for one command, one session, one person — not a blanket "yes" | #10 — store exact tool+args in the approvals row |
| **Adversary / reviewer agent** | Goose adversary mode (Mar 2026) | A silent independent reviewer evaluates every sensitive tool call before execution, at the semantic level | Future v2: before any `edit_file` or approval-creating call, a second cheap-model pass asks "does this exfiltrate, destroy, or exceed scope?" — free (Flash-Lite), and it mirrors the existing human-approval rule. |
| **Context compaction + tool-result clearing** | Claude Code auto-compact, Anthropic server-side compaction | Clear stale tool results first; summarise only at 60–70% window use; keep the raw log elsewhere | #5 |
| **Programmatic tool calling / Code Mode** | Anthropic, OpenAI (GPT-5.6, Jul 2026), Cloudflare, Goose v1.17+ | Model writes one program that calls tools; only the final result enters context | #9 — biggest token saving, implement last |
| **Gateway + sessions + scheduled jobs + approval gate** | Muse (pattern only — no public codebase) | One process holds sessions/memory/credentials; tools for shell/files/browser/email/calendar; crons run while the user is away; human gate before anything irreversible | Already the app's architecture (`server.js` + SQLite + jobs table). The missing piece is the cron runner — the jobs table exists but nothing schedules it yet; add a tiny `setInterval`/node-cron loop for the 09:00 internship run when the laptop gateway is up. |
| **Computer-use safety line** | All three | Agent never approves security/admin/OTP prompts, never logs in as admin, never bypasses bot checks | Already in the app's rules — keep, and keep it in `AGENT.md` |

## 4. What NOT to copy

- **Don't copy their models or their spend.** Claude Code averages ~$6/day per developer (Anthropic data, Mar 2026); Codex GPT-5.6 Sol is $5/$30 per 1M in/out. Ankush's budget is $0 — the free-tier design *is* the product.
- **Don't copy Codex's server-side multi-agent or Ultra mode.** Ultra spawns 23–25 sub-sessions and ignores batching directives (community measurement, Jul 2026) — on a free tier that is a quota-burn machine.
- **Don't copy "auto" permission modes.** Claude Code's `auto`/`dontAsk`/`--dangerously-skip-permissions` exist for throwaway containers, not a machine with real data. The app's deny-first + human approval is the right call.
- **Don't chase the newest model weekly.** GPT-6.1 Sol/Terra/Astra (Sep–Oct 2026) and Gemini 4 Argon are paid-only flagships. Track them for the ranking, don't build on them.

## 5. Verified vs rumour — honesty ledger

| Claim | Status |
|---|---|
| Gemini 3.8 Flash free tier, 1M context, GA 2 Sep 2026 | **Verified** — Google pricing + model pages, read 28 Oct / 1 Nov 2026 by multiple independent guides; BenchLM 11 Nov 2026 |
| Groq gpt-oss-120b / qwen3.8-27b: 30 RPM, 1,000 RPD, 8K TPM, 200K TPD | **Verified** — Groq rate-limits page, re-checked 20 Oct, 27 Oct, 10 Nov 2026 by three independent sources |
| Groq ~500 tok/s for gpt-oss-120b | **Measured, variable** — 261–525 tok/s across Aug–Oct 2026 tests; shared free capacity fluctuates with load |
| OpenRouter `:free`: 20 RPM, 50 req/day, no card | **Verified** — OpenRouter limits page + live models API, checked 10 Nov 2026 |
| OpenClaw v2026.11.5-beta.1 (4 Nov 2026): Knowledge Scribes, Postgres data plane, PRs from chat | **Verified** — official release notes via changelog aggregator; beta status noted |
| OpenClaw Multiplayer (5 Nov 2026), free + MIT | **Verified** — Foundation launch post, reported 5–6 Nov 2026 |
| Goose v1.55 (16 Oct 2026): auto-compaction cap 225K tokens; v1.57 (28 Oct 2026) allowlist HTTPS | **Verified** — official release notes |
| Goose adversary mode (Mar 2026), Code Mode since v1.17 (Dec 2025) | **Verified** — goose docs / architecture write-ups, updated 11 Nov 2026 |
| Anthropic programmatic tool calling: 37% avg token cut; 150K → 2K tokens on one workflow | **Verified as vendor-reported** — Anthropic's own engineering posts (Nov 2025); independent test (AIMultiple, cited Oct 2026) found a 77% cut but 2.2× more output tokens — net saving is real but smaller than the headline |
| Codex GPT-5.6 serialisation inflating tokens 27–45% | **Community-measured, not vendor-confirmed** — GitHub issue #35050 (Jul 2026) + replication; treat as directional |
| Qwen3.8-27B "best free local LLM 2026" | **Reviewer verdict, not a fact** — TechVerdict (Nov 2026) + Artificial Analysis index; vendor benchmarks (61.7 SWE-bench Pro, 89.2 GPQA) are vendor numbers |
| "Gemini free tier: 250–1,500 req/day" | **Unverified / unofficial** — Google does not publish these; any source quoting exact Gemini free RPM/RPD numbers is guessing from AI Studio screenshots. The app must not plan around them. |
| Oracle Always Free A1 capacity / idle-reclaim, Render sleep, Fly.io ~$2/mo | **Unchanged from 11 Nov research** — not re-verified in this pass; re-check before the cloud move |

## 6. Suggested implementation order (for the parent agent / Ankush)

1. **This week, ~1 hour total:** #2 (3.8 Flash — one line + test), #3 (`num_ctx` 32768 — one line), #7 (parallel calls + plan mode — small).
2. **Next:** #1 (native function calling — the real rewrite; test with Groq first, it is the easiest endpoint), #6 (web search/fetch + edit_file).
3. **Then:** #5 (memory recall + compaction), #4 (local model upgrade — needs his laptop + disk/RAM check first), #8 (OpenRouter insurance).
4. **Last:** #9 (Code Mode — only after #1 is stable and the sandbox is reviewed), #10 (OpenClaw upgrade to stable v2026.11.3; Scribes when the beta line stabilises).
5. **Do not do in this round:** sub-agent fan-out, adversary reviewer, cron runner — note them for v2; each needs its own test pass.

## Sources (checked 12 Nov 2026; all public web, no sign-in)

- OpenClaw v2026.11.5-beta.1 release notes — https://agentbreakingchanges.com/tools/openclaw/v2026.11.5-beta.1/
- OpenClaw changelog, Nov 2026 — https://openclawlaunch.com/changelog
- OpenClaw Multiplayer (5 Nov 2026) — https://superpowerdaily.com/posts/openclaw-adds-multiplayer-so-teams-can-work-with-the-same-ai-agent
- OpenClaw 2.0 analysis, updated 10 Nov 2026 — https://cellcog.ai/blog/openclaw-2-0/
- OpenClaw v2026.10.10 (Advisor, 3 Nov 2026) — http://blockchain.news/ainews/openclaw-v2026-10-10-adds-advisor-and-split-speech-release-analysis
- Goose v1.55.0 (16 Oct 2026) / v1.57.0 (28 Oct 2026) — https://agentbreakingchanges.com/tools/goose/v1.55.0/ and https://agentbreakingchanges.com/tools/goose/v1.57.0/
- Goose MCP-native architecture + adversary mode, updated 11 Nov 2026 — https://codex.danielvaughan.com/2026/04/07/goose-mcp-native-architecture/
- Code Mode (Cloudflare / Anthropic / OpenAI / Goose), checked 7 Nov 2026 — https://codewithnishant.dev/free/code-mode-ai-agents/
- Code execution with MCP: measure before rewriting — https://muvon.io/blog/code-execution-with-mcp
- Gemini 3.8 Flash pricing + free tier (read 28 Oct, checked 3 Nov 2026) — https://toollist.ai/v4/blog/gemini-20-flash-google-launch
- Gemini 3.8 Flash pricing (10 Oct 2026) — https://usagebox.com/articles/gemini-3-8-flash-pricing-free-tier-2026
- Google AI Studio pricing (1 Nov 2026) — https://www.datastudios.org/post/google-ai-studio-pricing-free-access-usage-limits-api-costs-and-production-billing-in-early-2026
- Gemini app limits (32K free / 128K Plus / 1M Pro) — https://whizi.io/resources/gemini-conversation-too-long/
- Groq free tier, re-checked 20 Oct / 10 Nov 2026 — https://localaimaster.com/blog/groq-api-free-guide ; https://weneedai.net/groq-free-tier-limits/ ; https://ficelle.ai/providers/groq/
- Best free LLMs, BenchLM dataset 11 Nov 2026 — https://benchlm.ai/best/free-llm
- Free LLM APIs compared (checked 21 Oct 2026) — https://flatkey.ai/blog/free-llm-apis-2026
- Best free local LLM 2026: Qwen3.8 27B — https://www.techverdict.io/articles/best-free-local-llm-2026
- OpenClaw free models, verified 9 Oct 2026 — https://www.betterclaw.io/blog/openclaw-best-free-model
- OpenRouter free models, checked 10 Nov 2026 — https://aifree.dev/learn/free-openrouter-models ; https://dev.to/lightningdev123/openrouters-free-model-apis-in-2026-working-with-request-limits-instead-of-token-caps-413f
- Claude Code best practices: skills, subagents, hooks, plan mode (May–Jun 2026) — https://www.clarista.io/blog/claude-code-best-practices ; https://ai.rundatarun.io/ai-development-agents/claude-code-best-practices ; https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo/
- Codex subagents + GPT-5.6 Code Mode serialisation fix (Jul–Sep 2026) — https://www.supercode.sh/en/blog/guides/codex-subagents ; https://codex.danielvaughan.com/2026/07/26/gpt56-code-mode-serialisation-fix-batching-tool-calls-codex-cli-token-savings/
- Context compaction pattern for long-running agents (2026) — https://www.agentnative.dev/patterns/context-compaction-pattern-for-long-running-agents
- Context engineering 2026 (compaction vs caching) — https://yt-insights-explorer.rmax.ai/videos/context-engineering-in-2026-louis-francois-bouchard-omar-solano-samridhi-vaid-towards-ai-wp3hjuxd918/index.html
- Ollama context trap + qwen3-coder:30b (checked 26 Oct 2026) — https://www.ssdnodes.com/learn/use-ollama-with-your-coding-agent ; https://localaimaster.com/blog/opencode-ollama-setup
- Qwen3-Coder-Next local setup (Jun 2026) — https://aifoss.dev/blog/qwen3-coder-next-local-setup-guide-2026/
- Prior research (11 Nov 2026, base for this file) — `~/workspace/research/personal-ai-laptop-phone-cloud-2026-11-11.md`
- App files read 12 Nov 2026 — `~/workspace/personal-ai/app/{brain.js,tools.js,server.js,package.json}`

*Nothing was edited in the app, no account was created, no money was spent, no one was contacted. All recommendations are $0 code/config changes or free-tier usage.*
