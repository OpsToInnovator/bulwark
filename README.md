# Bulwark

> **"Stop your AI bill before it stops you."**  
> Drop-in LLM proxy with hard spend caps, Bedtime Mode, and exact-match caching.

Change one line in your app. Get cost guards that no provider offers.

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

---

## Local Development

### Prerequisites

- Node.js ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A Cloudflare account (free tier is fine for dev)

### 1. Install

```bash
git clone <your-repo>
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

Use `src/auth.ts`'s `generateKey("testkey01")` (call from a small script) to get
the `rawKey` and `hash`.

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

Update `wrangler.toml` with the Hyperdrive `id`.

Run the SQL schema (see `src/usage.ts` comments) on your Neon DB.

### 4. Deploy

```bash
wrangler deploy
```

Your worker is live at `https://bulwark.<your-subdomain>.workers.dev`.

### 5. Custom domain

In the Cloudflare dashboard → Workers → your worker → Triggers → add a custom domain
so users hit `https://api.yourdomain.com`.

---

## How Users Swap Their Base URL

This is the whole point. One-line change per SDK:

**OpenAI Python SDK:**
```python
from openai import OpenAI
client = OpenAI(
    api_key="bwk_<keyId>_<secret>",          # your Bulwark key
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

## Pricing Tiers

| Tier | Price | Requests/mo | Logs |
|---|---|---|---|
| Free | $0 | 10K | 7 days |
| Indie | $19/mo | 250K | 30 days |
| Team | $79/mo | 2M | 90 days |
| Pro | $249/mo | Unlimited | 90 days |

---

## Environment Variables

Set in `wrangler.toml` `[vars]` or via `wrangler secret put`:

| Variable | Default | Description |
|---|---|---|
| `CACHE_TTL_SECONDS` | `3600` | KV cache TTL in seconds |
| `BEDTIME_WAKE_HOUR` | `7` | Fallback wake hour (0–23 UTC) if not set per key |
| `STRIPE_WEBHOOK_SECRET` | — | Stripe webhook signing secret (Week 2) |
| `ENVIRONMENT` | `development` | `development` \| `production` |

Secrets (set with `wrangler secret put`):

| Secret | Description |
|---|---|
| `STRIPE_API_KEY` | Stripe live/test secret key (for `stripe.ts` — Week 2) |

---

## Roadmap

- **v1 (this build):** Hard caps, Bedtime Mode, exact-match cache, multi-provider routing, usage tracking, Stripe stub
- **v1.1:** Semantic/embedding cache, anomaly alerts (email/Slack), per-user dashboard
- **v1.2:** Stripe full integration, webhook handlers, customer portal
- **v2:** BYO Postgres (Pro tier), SSO, Slack/Discord alert hooks
