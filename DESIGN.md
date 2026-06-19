# Bulwark — Design

> Status: living document. v1 shipped, v1.x in flight. Reflects what's actually in the repo, not aspiration. PRs and comments welcome.

## Goal

**Stop your AI bill before it stops you.**

Bulwark is a drop-in HTTP proxy between your app and an LLM provider (OpenAI, Anthropic, Gemini). One line in your SDK swaps the base URL to Bulwark, you keep using the same SDK, and Bulwark enforces three things the providers won't:

1. **Hard daily and monthly USD caps** per API key — request rejected with 429 once the cap is hit, until the window resets.
2. **Bedtime Mode** — block requests during the key's configured sleeping window when today's spend has already hit 2× the rolling 7-day daily baseline. Stops a runaway overnight job from blowing the budget.
3. **Exact-match caching** — deterministic requests return cached responses instead of paid completions, with a configurable TTL.

## Non-goals (today)

- Bulwark is not an inference engine — it proxies to providers, it does not run models.
- Bulwark is not an observability platform — it emits structured usage records; visualisation belongs downstream.
- Bulwark is not a prompt template / versioning tool.
- Bulwark is not (yet) an agent runtime — that's adjacent territory.

## Runtime

**Cloudflare Workers** is the only supported runtime today. The code uses Workers-specific primitives (`crypto.subtle`, KV bindings, `ctx.waitUntil`, `ExecutionContext`, Hyperdrive). Porting to Node.js / Docker is a future-work item, not a current capability.

Persistent state lives in two stores:

| Store | What lives there | Why |
|---|---|---|
| **Workers KV** | API key records, spend counters, Bedtime baselines, cache entries, recent usage | Sub-50ms reads from the hot path |
| **Hyperdrive → Neon Postgres** *(optional)* | Full historical usage records | Analytics, audit, longer retention than KV TTL |

If `HYPERDRIVE` is unbound, Postgres writes are silently skipped. KV is required.

## Architecture

```
Your App ──Bearer bwk_<id>_<secret>──▶ ┌──────────────────────────────┐
         ──x-provider-key: sk-...──▶ │      Cloudflare Worker       │
                                     │                              │
                                     │  auth → caps → bedtime →     │
                                     │  cache → forward upstream    │
                                     │                              │
                                     └────────────┬─────────────────┘
                                                  │
                       ┌──────────────────────────┼──────────────────────────┐
                       ▼                          ▼                          ▼
              OpenAI / Anthropic /        Workers KV                Hyperdrive →
              Gemini upstream             (hot state, cache,         Neon Postgres
                                          counters, baselines)       (full records)
```

### Request pipeline (per hot path)

Implemented in `src/index.ts` → `proxyRequest()`:

1. **Authenticate** — `auth.ts` parses `Bearer bwk_<keyId>_<secret>`, looks up the key record in KV (`apikey:{keyId}`), verifies the SHA-256 hash, and enforces the monthly request quota for the key's tier.
2. **Spend caps** — `caps.ts` reads `spend:daily:{keyId}:{yyyymmdd}` and `spend:monthly:{keyId}:{yyyymm}`. If either ≥ the cap, return 429 with `daily_cap_exceeded` / `monthly_cap_exceeded` and the `resets_at` ISO timestamp.
3. **Bedtime Mode** — `bedtime.ts` checks `record.bedtimeEnabled` (with a KV override at `bedtime:enabled:{keyId}`). If enabled AND the current time is in the key's sleeping window (timezone-aware, default 11pm–7am local) AND today's spend ≥ 2× the 7-day rolling baseline, return 429 with `bedtime_mode_active`.
4. **Cache lookup** — `cache.ts` computes `SHA-256(provider + model + canonical-sorted body)`. Non-streaming requests check `cache:{hex}` in KV; on hit, return the stored response with `x-bulwark-cache: hit` and record a cache-hit usage row with `costUsd = 0`. Streaming requests skip cache entirely.
5. **Forward to upstream** — provider-specific header building (`Authorization: Bearer ...` for OpenAI, `x-api-key` for Anthropic, `Authorization`/query-param for Gemini), then `fetch(upstreamUrl)` with the original body.
6. **Parse usage** — `extractUsage()` reads `prompt_tokens` / `input_tokens` / `promptTokenCount` depending on provider. `pricing.ts` computes USD cost from the per-million-token table (`getModelPricing` does longest-prefix model matching so `gpt-4o-mini-2024-07-18` resolves to `gpt-4o-mini`).
7. **Record usage** — `usage.ts` runs via `ctx.waitUntil()` (fire-and-forget): parallel writes to (a) `spend:daily`/`spend:monthly` counters, (b) the monthly request counter, (c) `usage:recent:{keyId}` rolling window of last 50 records, and (d) Postgres if Hyperdrive is bound. An `anomalyFlag` is set on the record when projected daily spend > 3× baseline.

### Why post-hoc accounting, not reservations

The current model is **read-before, write-after**: caps are checked before forwarding, the actual cost is added after the upstream response returns. This is documented honestly in `caps.ts`:

> Fire-and-forget is acceptable (minor over-spend on race condition is better than blocking the hot path).

Tradeoff in plain English: under heavy concurrency, multiple in-flight requests can all see "budget available" before any of them have written their cost back. In practice this overshoot is bounded (≤ N concurrent requests × cost-per-request, typically pennies) and the next request blocks correctly.

The alternative — **reserved-vs-confirmed accounting** — requires atomic CAS-style operations on the budget key. Workers KV is eventually consistent and doesn't expose true atomic increment, so a real reservation system on the hot path needs either Durable Objects, a Redis-backed shared store, or a different runtime altogether. That's a **Phase 2** item, not the current architecture. See `ROADMAP.md`.

## API key model

Keys are stored in KV at `apikey:{keyId}` as `BulwarkKeyRecord` (`src/types.ts`):

```ts
{
  keyId, keyHash,             // SHA-256 of raw key for constant-time verify
  ownerId, tier,              // free | indie | team | pro
  dailyCapUsd, monthlyCapUsd, // 0 = disabled
  bedtimeEnabled, wakeHour, timezone,
  createdAt, active,
}
```

Tier config (`TIER_CONFIGS` in `types.ts`) controls monthly request quota and feature gates (semantic cache, multi-project, BYO Postgres, SSO). Tier limits are checked in `auth.ts` after key verification.

## Caching

Two design choices worth knowing:

1. **Streaming requests are never cached.** `isCacheable()` returns false when `body.stream === true`. The response is a token stream, not a JSON blob — there's nothing meaningful to store.
2. **Cache keys are canonicalised.** Object keys are sorted recursively before hashing so `{model: "gpt-4o", temperature: 0}` and `{temperature: 0, model: "gpt-4o"}` produce the same cache key.

Cache TTL is configured via the `CACHE_TTL_SECONDS` env var (default 3600s).

Semantic / embedding-based cache is **not implemented**. It's flagged in the tier config as a feature gate, but the implementation lands in v1.1.

## Bedtime Mode (the hero feature)

The non-obvious one. Worth unpacking because it's what differentiates Bulwark from a generic budget proxy.

**The problem:** a runaway background job at 2am can drain a week's budget before you wake up. A simple daily cap helps but only after the cap is already hit. Bedtime Mode trips earlier — *before* you blow the cap — using the user's own historical pattern as the trigger.

**How it works:**

- Maintain a rolling 7-day history of daily spend per key (`bedtime:days:{keyId}` as a JSON array of last 7 totals).
- Compute the rolling mean as a baseline (`bedtime:baseline:{keyId}`).
- During the key's configured **sleeping window** (default 11pm–7am in the key's timezone, derived from `wakeHour`), if today's spend has already reached `2× baseline`, return 429 with `bedtime_mode_active`.
- The user can override via `POST /v1/bedtime { "enabled": false }`, which writes `bedtime:enabled:{keyId} = "0"` and bypasses the check until manually re-enabled.
- New keys with no baseline yet are unblocked (lets the first day establish a baseline).

The sleeping-window check uses `Intl.DateTimeFormat` with the key's IANA timezone, so the same key behaves correctly for users in different time zones.

## Pricing table

`pricing.ts` is a hand-maintained table of model → (input $ per million, output $ per million) for OpenAI, Anthropic, and Gemini. Two practical notes:

1. **Prefix matching** — exact match first, then longest matching prefix. `gpt-4o-mini-2024-07-18` correctly resolves to `gpt-4o-mini` pricing without needing every dated variant in the table.
2. **Unknown models** — logged as a warning, recorded with `costUsd = 0` and an `unknownModel: true` flag. This is intentional: an unknown model shouldn't crash the proxy, but the gap should be visible so it gets fixed.

The table is `*** UPDATE ME ***` annotated — provider prices change quarterly and this file needs maintenance.

## Stripe metered billing

`src/stripe.ts` is a **stub today**. The HMAC-SHA256 webhook signature validator is complete; the `reportUsageToStripe` function has the full Stripe API call wired but returns early when `STRIPE_API_KEY` is unset. Going from stub → live needs:

1. A Stripe Price with `billing_scheme=per_unit` and `aggregate_usage=sum`.
2. A `subscription_item_id` stored on each customer's `BulwarkKeyRecord`.
3. A flush mechanism (Cron Trigger or Durable Object) to batch usage reports under Stripe's rate limits.

Quantity convention is documented in code: 1 unit per request (Option A) vs cost-in-microdollars (Option B). Default is A.

## Usage record schema

The full record written per request (`UsageRecord` in `types.ts`, also the Postgres row):

```ts
{
  requestId,        // req_<ts>_<random>
  keyId,
  provider,         // "openai" | "anthropic" | "gemini"
  model,
  promptTokens, completionTokens,
  costUsd,
  cacheHit,
  anomalyFlag,      // true when projected daily > 3× baseline
  latencyMs,
  timestamp,        // ISO-8601
  httpStatus,
}
```

No webhook emission today — records go to KV (recent window) and Postgres (full history). A webhook fan-out layer is a v1.1 item.

## Open design questions

- **Where should budget enforcement live: in the proxy layer (Bulwark) or in the agent runtime (Velocity, similar tools)?** Both have valid claims. The proxy sees every provider call regardless of caller and can enforce hard caps; the agent runtime can reason about whole-task plans and pre-compute worst-case spend. The honest answer is probably **both**, with a clean handoff — Bulwark enforces the cap, the agent runtime hints at expected cost up front via a header.
- **Reservation model on Workers KV.** KV's eventual consistency makes true CAS reservations expensive. Options for Phase 2: Durable Objects (one DO per key, exact ordering, higher latency), Redis-backed shared store (requires a non-Workers runtime), or accepting bounded overshoot and surfacing it in telemetry.
- **Semantic cache distance threshold.** Per-route configurable vs global default. Leaning per-route — a translation endpoint tolerates near-misses better than a financial calculation does.
- **Streaming + caching.** Currently streaming bypasses cache entirely. There's a more nuanced design where the first stream is also captured and replayed from cache on hit, but it adds complexity that v1 doesn't need.

## Glossary

- **`bwk_` key** — Bulwark API key, format `bwk_<keyId>_<secret>`
- **Provider key** — the user's underlying OpenAI/Anthropic/Gemini key, sent per-request via `x-provider-key`, never stored
- **Tier** — free / indie / team / pro, controls monthly request quota and feature gates
- **Bedtime window** — sleeping hours in the key's timezone, default 11pm–7am
- **Baseline** — rolling 7-day mean of daily USD spend for a key
- **Anomaly flag** — set on a usage record when projected daily spend > 3× baseline
- **Cap** — hard USD limit (daily or monthly) that returns 429 when reached
