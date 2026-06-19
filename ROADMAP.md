# Bulwark — Roadmap

> Living document. Reflects shipped state honestly. 🟢 Done is in the repo today; 🟡 In Progress is being actively worked on; 🔵 Next is the queued work; 🟣 Later is on the radar but not yet committed.

## v1.0 — Core proxy (shipped)

🟢 **All of the below is in `main` today and tested:**

- HTTP proxy on Cloudflare Workers (`wrangler dev` / `wrangler deploy`)
- **OpenAI** adapter — `POST /v1/chat/completions`
- **Anthropic** adapter — `POST /v1/messages`
- **Gemini** adapter — `POST /v1beta/models/:model/generateContent` (passthrough)
- Bulwark API key auth (`bwk_<keyId>_<secret>`) with SHA-256 hash verification
- **Per-key daily + monthly USD caps** — 429 with `cap_exceeded` codes and `resets_at` timestamps
- **Bedtime Mode** — timezone-aware sleeping-window block when today's spend ≥ 2× 7-day rolling baseline
- `POST /v1/bedtime` toggle endpoint
- **Exact-match KV cache** with canonical-key hashing; streaming requests bypass cache
- **Pricing table** for OpenAI, Anthropic, Gemini with longest-prefix model matching
- **Usage tracking** — KV hot counters + optional Hyperdrive/Neon Postgres for full records
- **Anomaly flag** on usage records when projected daily spend > 3× baseline
- **Tier system** — free / indie / team / pro with per-tier monthly request quotas and feature gates
- **Stripe metered billing stub** — HMAC webhook validator complete, usage reporting wired (activates with `STRIPE_API_KEY`)
- Test suite (`vitest`) covering pricing, caps, cache, bedtime — 53 tests passing as of last commit
- AGPL-3.0 licensed

## v1.1 — Operational hardening (next)

🟡 **In progress / 🔵 next:**

- 🔵 **Reserved-vs-confirmed budget accounting** — replace the current read-before/write-after model with an explicit reservation step to bound concurrent-overspend windows. Likely implementation: per-key **Durable Object** acting as the single writer for budget state, with reservation TTLs to handle in-flight crashes. KV stays as the read-cache for the hot path.
- 🔵 **Provider fallback chains** — configurable per key: on 429 / 5xx / timeout from primary, try the next provider in the chain. Respects `Retry-After` when honest.
- 🔵 **Circuit breaker per provider** — track per-adapter health in shared state (DO or KV with TTL), jittered re-entry on recovery to avoid thundering herd.
- 🔵 **Semantic cache** — embedding-based nearest-neighbour cache lookup for prompts where exact match is too strict. Already gated in tier config; needs an embedding model and a vector store (D1 + cosine, or Vectorize).
- 🔵 **Webhook fan-out** — emit each usage record to a customer-configured webhook URL. Lets users wire Bulwark into their own observability stack without polling Postgres.
- 🔵 **Anomaly alerts** — push the `anomalyFlag === true` records out via webhook + email/Slack on opt-in.

## v1.2 — Billing and admin

🔵 **Next once v1.1 lands:**

- Stripe full integration — flip the stub to live, batch usage reporting via Cron Trigger or DO timer.
- Stripe webhook handler for subscription lifecycle (new customer → key provisioning, cancellation → key disable, dunning → soft warning headers).
- Customer portal (Stripe-hosted first, Bulwark UI later).
- Admin dashboard — read-only view of keys, current spend, recent usage. Workers + minimal HTML, no SPA framework.
- Per-key dashboard for end users to see their own usage / set caps / toggle Bedtime.

## v1.3 — Pro tier features

🟣 **Later:**

- **BYO Postgres** — customer-supplied connection string, full usage records routed to their database instead of Bulwark's. Already gated in tier config.
- **SSO** — Workforce SSO via OIDC/SAML for the admin UI. Already gated in tier config.
- **Multi-project support** — multiple keys under one ownerId with project-scoped budgets and roll-up reporting. Already gated in tier config.
- **Audit log** — record every key creation, budget change, Bedtime toggle.

## v2 — Beyond a single proxy

🟣 **Later, not yet scoped:**

- **Cost-aware routing** — if both providers can handle the request, prefer the cheaper one within a quality envelope.
- **Latency-aware routing** — fall back from a slow provider to a faster one when p95 latency budget is at risk.
- **Self-hosted multi-runtime** — port to Node.js + Docker for users who can't or won't deploy on Workers. Requires abstracting away `crypto.subtle`, KV, `ctx.waitUntil`, Hyperdrive.
- **SDK helpers** — thin wrappers around OpenAI / Anthropic SDKs that pre-set `base_url` and `x-provider-key` from Bulwark config files. Optional, never required (the whole point is "no SDK changes needed").
- **Bulwark Cloud** — managed hosted offering on top of the same open-source core. Same AGPL terms for self-hosters.

## Explicitly out of scope

These come up periodically and the answer is no, with reasoning:

- **Running inference locally.** Bulwark is a proxy, not an inference server. Use llama.cpp / vLLM / Ollama for that and put Bulwark in front of them if needed.
- **Prompt templating, versioning, or A/B testing.** Adjacent territory (Helicone, PromptLayer, others). Not Bulwark's lane.
- **Built-in dashboards / charts as a primary feature.** Bulwark emits clean records; visualisation belongs in Grafana / Metabase / whatever you already use. The admin UI in v1.2 is operational, not analytical.
- **Building an agentic IDE / agent runtime.** That's Velocity / Aider / Cursor / Open Velocity territory. Bulwark sits *in front of* those, enforcing budgets regardless of which agent is calling.

## How to influence the roadmap

- Open a [Discussion](https://github.com/OpsToInnovator/bulwark/discussions) to propose a new item, argue priority, or push back on something.
- Open an [Issue](https://github.com/OpsToInnovator/bulwark/issues) when an item is concrete enough to scope and implement.
- Items move 🟣 → 🔵 → 🟡 → 🟢 based on what actually gets shipped, not what's planned.
