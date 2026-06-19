# Bulwark

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.json)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com/)
[![Tests](https://img.shields.io/badge/tests-vitest-6e4aff.svg)](./tests)
[![Discussions](https://img.shields.io/badge/Discussions-open-2ea44f.svg)](https://github.com/OpsToInnovator/bulwark/discussions)
[![GitHub stars](https://img.shields.io/github/stars/OpsToInnovator/bulwark?style=social)](https://github.com/OpsToInnovator/bulwark)

> **Stop your AI bill before it stops you.**
> Drop-in LLM proxy with hard spend caps, Bedtime Mode, and exact-match caching.

Change one line in your app. Get cost guards no provider offers.

---

## 30-second quickstart

```python
# Before — direct to OpenAI
client = OpenAI(api_key="sk-...")

# After — through Bulwark
client = OpenAI(
    api_key="bwk_<keyId>_<secret>",                # your Bulwark key
    base_url="https://api.yourdomain.com/v1",      # your Bulwark Worker
    default_headers={"x-provider-key": "sk-..."},  # your OpenAI key
)
```

That's the whole integration. Now you get:

- **Hard daily and monthly USD caps** — `429` the moment a cap is hit, with a `resets_at` timestamp
- **Bedtime Mode** — auto-block during sleeping hours if today's spend already hit 2× your 7-day baseline
- **Exact-match caching** — repeated prompts return cached responses, free
- **Anomaly flag** — usage records flagged when projected spend > 3× baseline
- **Provider-agnostic** — OpenAI, Anthropic, Gemini today

What it looks like when a cap trips:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
x-bulwark-cap-type: daily

{
  "error": "daily_cap_exceeded",
  "message": "Daily spend cap of $5.00 reached. Resets at 2026-06-20T00:00:00Z.",
  "resets_at": "2026-06-20T00:00:00Z"
}
```

---

## How it compares

Bulwark is purpose-built for **cost containment at the proxy layer**. If you need something else, here are honest pointers:

| Tool | Primary focus | Bulwark overlap |
|---|---|---|
| **[LiteLLM](https://github.com/BerriAI/litellm)** | Unified SDK across 100+ providers, virtual keys, budgets | Overlaps on budgets; LiteLLM is broader, Bulwark is narrower and hard-cap-strict |
| **[Helicone](https://github.com/Helicone/helicone)** | Observability + analytics for LLM traffic | Complementary — pipe Bulwark's usage events into Helicone for dashboards |
| **[OpenRouter](https://openrouter.ai/)** | Routing + provider marketplace | Sits *above* Bulwark in the stack — Bulwark can proxy OpenRouter too |
| **[Vellum](https://www.vellum.ai/) / [PromptLayer](https://promptlayer.com/)** | Prompt management + versioning | Different problem; complementary |
| **Agent-runtime caps** (Cursor / Aider / Velocity) | Budget enforcement *inside* the agent | Complementary — runtime caps reason about whole tasks, Bulwark enforces hard limits regardless of caller. See [Velocity Discussion #24](https://github.com/ishandutta2007/Velocity/discussions/24) for the architectural split. |

The honest summary: **if your bill is being eaten by retries, runaway loops, or untrusted callers, Bulwark stops the bleeding. If you need provider routing or analytics dashboards, pair it with a tool that does those.**

---

## Architecture

```
Your App
   │
   │  Authorization: Bearer bwk_<keyId>_<secret>
   │  x-provider-key: sk-...  (your provider key, never stored)
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                         │
│                                                              │
│  ┌─────────┐   ┌──────────┐   ┌────────────┐   ┌────────┐  │
│  │  auth   │──▶│   caps   │──▶│  bedtime   │──▶│ cache  │  │
│  │(KV key  │   │(KV daily/│   │(KV rolling │   │(SHA-256│  │
│  │ lookup) │   │ monthly  │   │ baseline)  │   │  KV)   │  │
│  └─────────┘   └──────────┘   └────────────┘   └────────┘  │
│                                                     │        │
│                              cache hit ◀────────────┘        │
│                              cache miss                       │
│                                   │                          │
│  ┌──────────────────────────────┐  │                          │
│  │         Router               │◀─┘                         │
│  │  /v1/chat/completions        │                            │
│  │  /v1/messages                │                            │
│  │  /v1beta/models/:m/generate  │                            │
│  │  POST /v1/bedtime (toggle)   │                            │
│  │  GET  /health                │                            │
│  └──────────────────────────────┘                            │
│          │                                                   │
│          ▼                                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Upstream provider  (OpenAI / Anthropic / Gemini)     │  │
│  └───────────────────────────────────────────────────────┘  │
│          │                                                   │
│          ▼                                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  usage.ts — compute cost, write KV counters,          │  │
│  │  fire-and-forget to Postgres via Hyperdrive           │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
          │                          │
          ▼                          ▼
   Workers KV                 Hyperdrive → Neon Postgres
  (hot counters,             (full usage records,
   cache, baselines)          analytics, logs)
```

**Request pipeline per hot path:**
1. `auth.ts` — validate `bwk_` key from KV, check monthly request quota for tier
2. `caps.ts` — read daily + monthly spend counters; 429 if either cap exceeded
3. `bedtime.ts` — if enabled + in sleeping window + spend ≥ 2× baseline → 429
4. `cache.ts` — SHA-256 hash of (provider, model, body); return KV hit if present
5. Forward to upstream with `x-provider-key`
6. Parse token usage from response → `pricing.ts` → compute cost
7. `usage.ts` — update KV counters; async write to Postgres; raise anomaly flag if spend > 3× baseline

For the full design rationale (including why we accept bounded overspend on Workers KV instead of using reservations), see **[DESIGN.md](./DESIGN.md)**.

---

## Local Development

### Prerequisites

- Node.js ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A Cloudflare account (free tier is fine for dev)

### 1. Install

```bash
git clone https://github.com/OpsToInnovator/bulwark.git
cd bulwark
npm install
```

### 2. Create KV namespace

```bash
wrangler kv:namespace create BULWARK_KV
wrangler kv:namespace create BULWARK_KV --preview
```

Copy the `id` and `preview_id` into `wrangler.toml`.

### 3. Run locally

```bash
wrangler dev
# Worker runs at http://localhost:8787
```

KV reads/writes go to a local in-memory store during `wrangler dev`.

### 4. Seed a test API key

```bash
# Generate a key and store it in local KV
wrangler kv:key put --binding=BULWARK_KV "apikey:testkey01" '{
  "keyId": "testkey01",
  "keyHash": "<sha256-of-your-raw-key>",
  "ownerId": "you",
  "tier": "indie",
  "dailyCapUsd": 5.0,
  "monthlyCapUsd": 50.0,
  "bedtimeEnabled": false,
  "wakeHour": 7,
  "timezone": "America/New_York",
  "createdAt": "2026-01-01T00:00:00Z",
  "active": true
}'
```

Use `src/auth.ts`'s `generateKey("testkey01")` (call from a small script) to get the `rawKey` and `hash`.

### 5. Make a test request

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer bwk_testkey01_<secret>" \
  -H "x-provider-key: sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

Check for `x-bulwark-cache: miss` on first call, `hit` on repeat calls.

---

## Deployment

### 1. Authenticate with Cloudflare

```bash
wrangler login
```

### 2. Create production KV

```bash
wrangler kv:namespace create BULWARK_KV
```

Update `wrangler.toml` with the production `id`.

### 3. (Optional) Set up Hyperdrive for Postgres

```bash
# Provision a Neon database, then:
wrangler hyperdrive create bulwark-db \
  --connection-string="postgres://user:pass@host/dbname"
```

Update `wrangler.toml` with the Hyperdrive `id`. Run the SQL schema (see `src/usage.ts` comments) on your Neon DB.

### 4. Deploy

```bash
wrangler deploy
```

Your worker is live at `https://bulwark.<your-subdomain>.workers.dev`.

### 5. Custom domain

In the Cloudflare dashboard → Workers → your worker → Triggers → add a custom domain so users hit `https://api.yourdomain.com`.

---

## Swap your base URL — three SDKs

This is the whole point. One-line change per SDK:

**OpenAI Python SDK:**
```python
from openai import OpenAI
client = OpenAI(
    api_key="bwk_<keyId>_<secret>",                # your Bulwark key
    base_url="https://api.yourdomain.com/v1",
    default_headers={"x-provider-key": "sk-..."},  # your OpenAI key
)
```

**Anthropic Python SDK:**
```python
import anthropic
client = anthropic.Anthropic(
    api_key="bwk_<keyId>_<secret>",
    base_url="https://api.yourdomain.com",
    default_headers={"x-provider-key": "sk-ant-..."},
)
```

**Gemini (REST):**
```
POST https://api.yourdomain.com/v1beta/models/gemini-2.0-flash:generateContent
Authorization: Bearer bwk_<keyId>_<secret>
x-provider-key: AIza...
```

**curl / any HTTP client:**
```bash
curl https://api.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer bwk_<keyId>_<secret>" \
  -H "x-provider-key: sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

---

## Running Tests

```bash
npm test
# or
npx vitest run
```

Test coverage:
- `tests/pricing.test.ts` — cost math, model lookup, prefix matching, unknown models
- `tests/caps.test.ts` — daily/monthly cap enforcement, spend accumulation
- `tests/cache.test.ts` — SHA-256 key hashing, KV store/retrieve, streaming exclusion
- `tests/bedtime.test.ts` — baseline rolling average, toggle, threshold math

---

## KV Key Namespace Reference

| Key pattern | Contents | TTL |
|---|---|---|
| `apikey:{keyId}` | `BulwarkKeyRecord` JSON | permanent |
| `usage:req:{keyId}:{yyyymm}` | monthly request count | 35 days |
| `spend:daily:{keyId}:{yyyymmdd}` | daily USD spend (float string) | 26 hours |
| `spend:monthly:{keyId}:{yyyymm}` | monthly USD spend (float string) | 35 days |
| `bedtime:enabled:{keyId}` | `"1"` or `"0"` toggle override | 1 year |
| `bedtime:baseline:{keyId}` | rolling avg USD/day (float string) | 90 days |
| `bedtime:days:{keyId}` | JSON array of last 7 daily totals | 90 days |
| `cache:{sha256hex}` | cached response JSON | `CACHE_TTL_SECONDS` (default 3600s) |
| `usage:recent:{keyId}` | last 50 `UsageRecord` JSON | 7 days |

---

## Configuration

### Environment variables — set in `wrangler.toml` `[vars]`

| Variable | Default | Description |
|---|---|---|
| `CACHE_TTL_SECONDS` | `3600` | KV cache TTL in seconds |
| `BEDTIME_WAKE_HOUR` | `7` | Fallback wake hour (0–23) used when not set per key |
| `ENVIRONMENT` | `development` | `development` \| `production` |

### Secrets — set with `wrangler secret put`

| Secret | Description |
|---|---|
| `STRIPE_API_KEY` | Stripe live/test secret key — activates the Stripe metered-billing stub in `src/stripe.ts` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret — required for webhook handler |

---

## Roadmap

v1 has shipped (everything listed above). Active and upcoming work is tracked in **[ROADMAP.md](./ROADMAP.md)** — currently focused on reserved-vs-confirmed accounting via Durable Objects, provider fallback chains, semantic cache, and Stripe live integration.

---

## Contributing

Bulwark is AGPL-3.0 and welcomes contributors. Start here:

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — local setup, issue + PR etiquette, code style
- **[DESIGN.md](./DESIGN.md)** — architecture rationale, the post-hoc-accounting tradeoff, open design questions
- **[Discussions](https://github.com/OpsToInnovator/bulwark/discussions)** — design conversations and open-ended questions
- **[Issues](https://github.com/OpsToInnovator/bulwark/issues)** — bugs, features, `good first issue` work
- **[SECURITY.md](./SECURITY.md)** — private vulnerability disclosure

If you're building anything in the LLM cost / agent-runtime / API-reliability space, I want to talk. Open an Issue or Discussion and let's compare notes.

---

## License

[AGPL-3.0](./LICENSE) — you can use, modify, and self-host Bulwark freely. If you modify Bulwark and run the modified version as a network service, your modifications must be made available under AGPL-3.0 too. Calling Bulwark over HTTP from a separate service is unaffected.
