# Bulwark — Design

> Status: living document. Pre-1.0. Architecture is converging but specifics will move. PRs and comments welcome.

## Goal

Stop your AI bill before it stops you.

Bulwark sits between your application and an LLM provider (OpenAI, Anthropic, Gemini, OpenRouter, others) and enforces three things the provider won't:

1. **Hard spend caps** — per key, per workspace, per user, globally. Reserved-vs-confirmed accounting so concurrent retries don't oversubscribe a budget.
2. **Semantic caching** — repeated or near-identical prompts return cached responses, not paid completions.
3. **Provider fallback** — if a model 429s or errors, route to a configured fallback chain rather than retrying into the same wall.

A fourth pillar — **Bedtime Mode** — lets you cap spend hard during off-hours so a runaway background job can't drain a month's budget overnight.

## Non-goals

- Bulwark is not an observability platform. It emits clean events; visualisation belongs elsewhere.
- Bulwark is not an inference engine. It proxies to providers; it does not run models.
- Bulwark is not opinionated about your auth layer. Bring your own.
- Bulwark is not a prompt management tool. It can cache prompts; it does not template, version, or A/B them.

## Architecture overview

```
                        ┌────────────────────┐
   App / SDK ─────────► │   Bulwark Proxy    │ ────► OpenAI / Anthropic / Gemini / etc.
                        │ ┌────────────────┐ │
                        │ │ Auth & Routing │ │
                        │ ├────────────────┤ │
                        │ │ Budget Guard   │ │ ◄──► Distributed state (Redis / KV)
                        │ ├────────────────┤ │
                        │ │ Cache Layer    │ │ ◄──► Cache store (Redis / R2 / D1)
                        │ ├────────────────┤ │
                        │ │ Fallback Chain │ │
                        │ ├────────────────┤ │
                        │ │ Event Emitter  │ │ ────► Webhooks / logs / metrics
                        │ └────────────────┘ │
                        └────────────────────┘
```

Runtime target: **Cloudflare Workers** (primary), Node.js (for self-hosted Docker), with a clean adapter boundary so the core proxy logic is runtime-agnostic.

## Budget enforcement — the core problem

The naive design — check budget, call provider, decrement budget on response — falls apart under concurrency. Three calls all see "budget available", all dispatch, all return, and you've overspent by 3x.

Bulwark uses **reserved-vs-confirmed accounting**:

1. **Reserve worst-case cost** before dispatching the call. Worst-case = `max_tokens × output_price + input_tokens × input_price`.
2. **Hold the reservation** for the duration of the call (plus a short TTL on timeout).
3. **Convert to confirmed** when the provider returns actual usage. Release the delta back to the budget.
4. **Forfeit on timeout** — the reservation stays held until the TTL expires, preventing immediate retry-into-overspend.

This means three concurrent calls against a budget with room for two will see the third correctly rejected at reservation time, not after the fact.

### Distributed state

Single-process reservation is straightforward in memory. Multi-replica deployments need shared state.

Bulwark uses a **shared backing store** (Redis for self-hosted; Cloudflare KV / Durable Objects for Workers) with:

- **CAS-style reservation** on a per-budget key — multiple replicas competing for the same budget see consistent reservation state
- **TTL'd holds** so a replica crash doesn't permanently lock a budget
- **Adapter-scoped cooldown keys** so a provider 429 in replica A puts replica B and C on the same cooldown, preventing distributed thundering-herd recovery

This is the same pattern the rest of the LLM proxy / API reliability ecosystem is converging on. See related discussion in the [Meridian thread](https://www.reddit.com/r/Backend/comments/1u66wng/every_api_has_different_errors_pagination_rate/) for the broader design space.

## Caching

Two tiers:

1. **Exact match** — keyed on `(model, normalised messages, temperature, top_p)`. Hash, look up, return on hit. Cheap, fast.
2. **Semantic match** *(planned)* — embed the prompt, find nearest-neighbour cached prompts within a configurable distance threshold. Return the cached response if confidence is high.

Caching is **opt-in per route or per key**. Defaults are conservative — no surprise cache hits on freshness-sensitive endpoints.

## Provider fallback

Configured per-key as an ordered list:

```jsonc
{
  "primary": "openai:gpt-4o",
  "fallback": [
    { "provider": "anthropic", "model": "claude-3-5-sonnet" },
    { "provider": "gemini", "model": "gemini-1.5-pro" }
  ],
  "fallback_triggers": ["429", "5xx", "timeout"]
}
```

Fallback is **circuit-breaker aware** — once a provider trips, the breaker holds it in cooldown for a window (with jittered re-entry) rather than retrying every call.

## Event emission

Every request emits a structured event:

```jsonc
{
  "request_id": "req_...",
  "key_id": "key_...",
  "route": "/v1/chat/completions",
  "provider_attempts": [
    { "provider": "openai", "model": "gpt-4o", "status": 429, "ms": 120 },
    { "provider": "anthropic", "model": "claude-3-5-sonnet", "status": 200, "ms": 1840 }
  ],
  "reserved_usd": 0.0420,
  "confirmed_usd": 0.0118,
  "cached": false,
  "budget_remaining_usd": 4.91,
  "ts": "2026-06-19T01:58:33Z"
}
```

Events go to: webhook (configurable), structured logs, and optionally a metrics backend. Bulwark itself does not store events — that's downstream's job.

## Open design questions

- Should budget enforcement live inside the agent runtime (where it can reason about whole-task plans) or in front of the model layer (where it can enforce hard caps regardless of caller)? Bulwark sits in the second camp; agentic platforms like Velocity sit in the first. The honest answer is probably **both**, with a clean handoff.
- Semantic cache distance threshold — global default vs per-route configurable. Currently leaning per-route.
- How to surface cost telemetry to the *caller* without leaking absolute budget state — partial reveal? Buckets? TBD.

## Glossary

- **Reservation** — provisional hold on budget for an in-flight call
- **Confirmation** — actual usage-based debit, replaces the reservation
- **Bedtime Mode** — time-window-scoped budget overrides for off-hours protection
- **Adapter** — per-provider implementation layer (OpenAI adapter, Anthropic adapter, etc.)
- **Cooldown** — circuit-breaker state for a provider that recently failed
