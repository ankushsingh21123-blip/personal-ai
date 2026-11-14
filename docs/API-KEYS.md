# API keys — where to get them, what is actually free

**Verified 14 Nov 2026** from the providers' own pages (sources at the bottom).
Free tiers change often — if a limit below disagrees with the provider's
page today, the provider's page wins. Nothing here was invented: where a
claim could not be verified from an official page, it says so.

## The rule first

- Add keys **only in the Settings page** of the web UI (loopback-only,
  token auth). Keys are written to `.env.local` (mode 600, git-ignored),
  never logged, never synced to the cloud node, never committed.
- **Never paste a key in chat** — web chat, Telegram, or WhatsApp. The chat
  channels refuse key-shaped messages and point you to Settings.
- If a key ever leaks, rotate it immediately in that provider's console.
- Key shapes (prefixes only — never a real key): Gemini `AIza…`, OpenAI
  `sk-…`, Anthropic `sk-ant-…`, OpenRouter `sk-or-v1-…`, Groq `gsk_…`,
  Hugging Face `hf_…`.

## How Piplet uses keys

Piplet has five built-in provider slots: **Gemini**, **Groq**, **OpenAI /
custom OpenAI-compatible endpoint**, **Anthropic**, and **Ollama** (local,
no key). Set the order in Settings (`BRAIN_PROVIDERS`); providers with no
key are skipped. The **OpenAI / custom** slot takes any OpenAI-compatible
endpoint: base URL + model + key. That is how OpenRouter, Cerebras,
SambaNova, Hugging Face Inference Providers, and a local OpenAI-compatible
server plug in. Use the **Test** button on each provider after adding a key
— it makes one real call and records the result.

## Free sources (verified)

### 1. Google AI Studio — Gemini API (free tier)

- Get a key: https://aistudio.google.com/api-keys
- **Free tier exists.** New users get a default Cloud project + key after
  accepting the terms. No credit card is stated as required for the Free
  tier itself. Paid upgrade means linking billing + a minimum $5 prepay.
- What is on Free changes by model. The pricing page checked 14 Nov 2026
  listed `gemini-4-hydrogen` and `gemini-3.8-flash` on Free, and
  `gemini-4-carbon` / `gemini-4-argon` NOT on Free. Grounding with Google
  Search/Maps is not available on Free.
- Per-model Free request limits (RPM/RPD) could **not** be verified from
  the official pages in this check — check
  https://aistudio.google.com/rate-limit before relying on a number. The
  rate-limits page gave specific Free numbers only for one model family
  (Gemini Decision 1: 200 RPM / 50,000 TPM / 10,000 RPD), states limits
  are per-project, reset at midnight Pacific, and are "not guaranteed".
- **Data gotcha:** on the Free tier, Google states your data is "Used to
  improve our products: Yes"; on Paid: "No". Do not send anything
  sensitive through the Free tier.
- Piplet note: the app's Gemini defaults (`gemini-3.5-flash-lite`, then
  `gemini-3.6-flash`) were the working models measured on 10–12 Nov 2026.
  `gemini-3.8-flash` returned 503 (high demand) in our own tests on 10 and
  12 Nov. Model availability varies with demand — if a call fails, check
  the pricing/rate-limit pages.
- Sources: pricing https://aistudio.google.com/docs/pricing ;
  rate limits https://aistudio.google.com/docs/rate-limits ;
  billing https://aistudio.google.com/docs/billing — all checked 14 Nov 2026.

### 2. Groq (free tier)

- Get a key: https://console.groq.com/keys
- **Free tier exists.** No payment method is required for the Free tier
  itself (a payment method is only needed to upgrade to the Developer
  tier, which is pay-as-you-go).
- Per-model Free limits could **not** be verified — the official
  rate-limits page contradicts itself (one table's numbers are labelled
  as Developer-plan base limits while another page gives different
  Developer numbers), so **no Free RPM/RPD/TPM number is quoted here**.
  Check https://console.groq.com/docs/rate-limits for the current
  per-model table. Do not trust older blog numbers.
- Groq also offers an OpenAI-compatible endpoint
  (`https://api.groq.com/openai/v1`), so a Groq key can be used through
  Piplet's custom-endpoint slot too.
- Data-use terms were not verified from an official page in this check —
  no claim is made here.
- Sources: billing FAQs https://console.groq.com/docs/billing-faqs ;
  models https://console.groq.com/docs/models ;
  rate limits https://console.groq.com/docs/rate-limits — all checked 14 Nov 2026.

### 3. OpenRouter — `:free` models (free, capped)

- Get a key: https://openrouter.ai/keys (also `/settings/keys`)
- **Free models exist.** Models with a `:free` variant cost $0. One key
  works for free and paid models. No credit card is needed for free use.
- Limits (verified): `:free` variants are capped at **20 requests/minute
  and 50 requests/day**, rising to **1,000/day once the account has bought
  $10 of credits** (the higher cap starts at $9). Failed attempts count
  toward the daily cap. A negative balance blocks free models.
- Use it in Piplet through the custom-endpoint slot: base URL
  `https://openrouter.ai/api/v1`, model = a `:free` slug. The free-model
  list changes often — verify the exact slug is live at
  https://openrouter.ai/collections/free-models before using it. (The
  Nov 2026 list showed Nemotron 3 family models at $0/M, but model names
  did not fully render in the check — re-check live, do not copy names
  from this guide.)
- **Data gotcha:** OpenRouter logs metadata only by default, but
  provider-side retention varies and free endpoints can log prompts. Use
  `data_collection: "deny"` / ZDR routing for private content.
- Sources: free models https://openrouter.ai/collections/free-models ;
  pricing https://openrouter.ai/pricing ;
  FAQ https://openrouter.ai/docs/faq — all checked 14 Nov 2026.

### 4. Ollama — local, no key, $0

- Download: https://ollama.com/download
- **No key at all.** Official wording: "Use cloud models with an API key,
  or run models locally without one" / "No API key required." No
  request/token limits locally — speed depends on your hardware. Large
  models are slow without a strong GPU; do not expect frontier quality
  from a small local model.
- **Gotcha — cloud vs local:** Ollama cloud models (names ending
  `:cloud`) DO need sign-in + a key (https://ollama.com/settings/keys)
  and "need usage credits or a paid plan". Local models need neither.
- On Linux, run `ollama serve` if the server is not running;
  `ollama run <model>` downloads and chats.
- Source: quickstart https://docs.ollama.com/quickstart (updated
  12 Nov 2026) — checked 14 Nov 2026.

### 5. Cerebras — free TRIAL only (not a permanent free tier)

- Account + key via Cerebras Cloud. Pricing page:
  https://www.cerebras.ai/pricing
- **$5 one-time promotional credit, expiring 30 days after activation,
  and adding a valid payment method is required.** Access pauses when the
  credit expires or runs out unless pay-as-you-go credits are bought.
  Older (2024–2025) claims of a permanent free tier are superseded — do
  not rely on them.
- Trial rate limits (verified, rate-limits doc updated 13 Nov 2026):
  `gpt-oss-120b` 5 RPM / 30K uncached TPM / 90K total TPM / 1M per hour /
  1M per day; `qwen-3.8-27b` 300 RPM / 150K–750K TPM, no hourly/daily caps.
- OpenAI-compatible API — works through Piplet's custom-endpoint slot.
- Sources: pricing https://www.cerebras.ai/pricing ;
  rate limits https://inference-docs.cerebras.ai/support/rate-limits —
  both checked 14 Nov 2026.

### 6. Cohere — free trial/evaluation keys (capped, integration caveat)

- Get a key: https://dashboard.cohere.com/api-keys
- Trial keys are limited to **1,000 API calls/month**. Chat API trial:
  20 requests/minute (Command A+, A Reasoning, A Translate, A Vision, A,
  R+, R, R7B, North Mini Code). Whether a credit card is required for a
  trial key could not be verified — check
  https://docs.cohere.com/docs/rate-limits#trial-key-limitations
- **Integration caveat:** the Cohere API is not OpenAI-compatible by
  default (Chat V2 / Chat Completions variants exist), so it is NOT a
  one-click custom endpoint in Piplet — integration effort is unverified.
  Listed here only because the trial exists.
- Sources: rate limits https://docs.cohere.com/docs/rate-limits
  (updated 27 Aug 2026); pricing doc
  https://docs.cohere.com/docs/how-does-cohere-pricing-work — both checked
  14 Nov 2026.

### 7. SambaNova (SambaCloud) — free tier, thin verification

- API keys in the SambaCloud portal (`cloud.sambanova.ai`).
- Free tier capped at **20 requests/day per model** (single statement,
  fetched from an integration guide — the full Free-tier rate-limit table
  could not be verified). "Link a payment method to move to the Developer
  Tier." An older blog claim of "$5 free credits" on signup was not
  re-verified — do not rely on it.
- OpenAI-compatible base URL `https://api.sambanova.ai/v1/chat/completions`
  — works through Piplet's custom-endpoint slot.
- Source: https://docs.sambanova.ai/docs/en/integrations/vapi
  (updated 13 Nov 2026) — checked 14 Nov 2026.

### 8. GitHub Models — free prototyping, public preview (stale-docs caveat)

- Endpoint `https://models.github.ai`; auth via GitHub PAT. Exact
  key-creation steps were **not** verified in this check.
- Free rate-limited prototyping in public preview. Published tiers:
  low tier / Copilot Free — 15 RPM, 150/day, 8,000 input / 4,000 output
  tokens per request, 5 concurrent; high tier — 10 RPM, 50/day, same
  token caps, 2 concurrent; higher Copilot plans get higher daily caps.
- **Staleness caveat:** the docs copy checked was 128 days old and the
  page says public preview, subject to change. Re-check before relying
  on these numbers.
- Source: https://docs.github.com/en/github-models/prototyping-with-ai-models
  — searched 14 Nov 2026, crawl stale.

## NOT free — do not mistake these for free tiers

- **Hugging Face Inference Providers — no free tier.** The official
  pricing page states included monthly credits for free users: **None**
  (extra usage requires a credits purchase). PRO is $2.00/month;
  Team/Enterprise $2.00/seat/month; pay-as-you-go with no markup on
  provider rates. Older claims of $0.10/month free credits are
  contradicted by the current official page. It is OpenAI-compatible and
  works through the custom-endpoint slot — as a paid option.
  Source: https://huggingface.co/docs/inference-providers/pricing —
  checked 14 Nov 2026.
- **Mistral — ambiguous, do not present as a free API tier.** Current
  docs say "Free mode… doesn't include API access. Creating API keys and
  using the API require billing activation and pay-as-you-go." A Mistral
  news post (Oct 2026) says "Free API usage remains available on the
  Experiment plan". The two conflict; free API access is unverified.
  `labs-` models "are free of charge" but carry no data-collection
  opt-out and are not for production. Check
  https://docs.mistral.ai/admin/billing-usage/usage-limits before
  assuming anything free.
  Sources checked 14 Nov 2026: billing/usage-limits doc, help article
  (updated 12 Aug 2026), Mistral news, model lifecycle doc.
- **Together AI — not free.** "Together AI does not currently offer free
  trials. Access requires a minimum $5 credit purchase." API keys are not
  available on the limited free tier.
  Sources: https://support.together.ai/articles/1862638756-changes-to-free-tier-and-billing-july-2025
  and https://support.together.ai/articles/4999040689-where-to-find-your-api-key
  — checked 14 Nov 2026.

## Paid providers, represented honestly

Piplet works fully without these. They are optional, only if you already
have a key or choose to pay. Piplet never asks you to buy anything.

### OpenAI (paid, pay-as-you-go)

- Get a key: https://platform.openai.com/api-keys (Settings → API keys;
  project keys, secret shown once). Caveat: no official key-creation page
  was directly opened in this check; the URL is corroborated by multiple
  third-party guides citing official docs.
- **No free tier was verified from an official page.** The rate-limits
  doc lists usage tiers including one labelled "Free ($100/month, allowed
  geography)", but no general free-credit/free-tier claim was verified.
  A "$5 minimum credit purchase" claim is third-party only — unverified.
- Prices listed on the pricing page 14 Nov 2026, per 1M tokens
  (input / output): `gpt-6-luna` $0.10 / $0.50; `gpt-6.1-terra`
  $1.00 / $5.00; `gpt-6.1-sol` $2.00 / $10.00; `gpt-6-astra`
  $10.00 / $50.00. Prices change — check live. Piplet's default
  `OPENAI_MODEL` is `gpt-4o-mini`; change it in Settings.
- Sources: pricing https://developers.openai.com/api/docs/pricing ;
  rate limits https://developers.openai.com/api/docs/guides/rate-limits —
  both checked 14 Nov 2026.

### Anthropic / Claude API (paid, per-token)

- Get a key: Claude Console https://platform.claude.com/settings/keys
  (keys start `sk-ant-…`, shown only once; API at
  `https://api.anthropic.com`).
- **No free API tier was found advertised on official pages.**
  Third-party checks (Oct 2026) state no free trial balance / no free
  API tier. A "$5 minimum credit purchase" claim is third-party only —
  unverified.
- Prices per 1M tokens (list-price PDF effective 9 Nov 2026): Opus 5.5
  $4 / $20; Fable 5.2 $8 / $40. The Sonnet 5.5 price conflicted across
  sources ($1/$5 vs $2/$10) and is **not quoted here** — check live.
- Sources: key guide https://platform.claude.com/docs/en/get-api-key ;
  Opus page https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5 ;
  list-price PDF https://assets.claude.com/a04aca860a54b7323e33f449706e9b43680e1346.pdf
  — all checked 14 Nov 2026.

## Custom endpoints — your own key, your own model

In Settings, the **OpenAI / custom OpenAI-compatible endpoint** row takes:

1. **Base URL** — e.g. `https://openrouter.ai/api/v1`,
   `https://api.groq.com/openai/v1`, a Cerebras/SambaNova/Hugging Face
   OpenAI-compatible URL, or a local server (loopback `http://` URLs are
   allowed for local servers only).
2. **Model** — the exact model slug the endpoint serves.
3. **Key** — your key for that endpoint (or any placeholder the local
   server accepts, if it needs no key).

Then press **Test**. If the test fails, the recorded error (redacted) tells
you whether the URL, model, or key is wrong. Piplet never sends a key to
anywhere except the endpoint you configured, and only inside that
provider's API call.

## If a free tier runs out

Piplet's chain falls through to the next provider automatically. If every
cloud provider is exhausted or unreachable, the local Ollama model still
answers on-device, and cloud-dependent work queues in the offline outbox
until the connection (or quota) returns. The Settings page shows each
provider's last test result so you can see what is actually reachable.
Never pay to fix a quota problem — switch providers or wait for the reset.
