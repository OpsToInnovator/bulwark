# Bulwark — Roadmap

> Living document. Phases are ordered by priority, not by calendar. Anything in 🟢 Done has shipped; 🟡 In Progress is actively being worked on; 🔵 Next is the queue; 🟣 Later is on the radar but not committed.

## Phase 1 — Core proxy (foundations)

🟢 **Done**
- Basic request proxying to OpenAI-compatible endpoints
- Provider key management via env vars
- Cloudflare Workers deployment via `wrangler`
- Test harness with Vitest

🟡 **In progress**
- Anthropic adapter (parity with OpenAI adapter)
- Reserved-vs-confirmed budget accounting (single-replica)

🔵 **Next**
- Gemini adapter
- OpenRouter passthrough adapter
- Per-key budgets with hard cap enforcement
- Structured event emission to webhook

## Phase 2 — Distributed state

🔵 **Next**
- Redis-backed shared budget state for self-hosted deployments
- Cloudflare KV / Durable Object backend for Workers deployments
- Adapter-scoped cooldown keys (shared circuit-breaker state across replicas)
- Reservation TTL handling on timeout

🟣 **Later**
- Read-through cache for budget state to reduce hot-key contention
- Distributed lock benchmarks across Redis, KV, and DO backends

## Phase 3 — Caching

🔵 **Next**
- Exact-match cache, keyed on (model, normalised messages, sampling params)
- Per-route cache opt-in

🟣 **Later**
- Semantic cache with embedding + nearest-neighbour lookup
- Cache invalidation on prompt-template change
- Cache hit ratio telemetry

## Phase 4 — Fallback and reliability

🔵 **Next**
- Configurable fallback chains per key
- Circuit breaker per provider with jittered re-entry
- Retry-After header honouring

🟣 **Later**
- Cost-aware routing (cheaper fallback for non-critical workloads)
- Latency-aware routing
- Health-check probes for primary recovery

## Phase 5 — Bedtime Mode and time-window controls

🔵 **Next**
- Time-window budget overrides with timezone support
- Per-day-of-week budget profiles
- Holiday calendar integration *(stretch)*

## Phase 6 — Observability and admin

🟣 **Later**
- Admin UI (read-only first — keys, budgets, recent events)
- Multi-tenant key management with workspaces
- Audit log for budget changes
- SDK helpers for Node and Python

## Phase 7 — Open core / hosted

🟣 **Later**
- Hosted Bulwark Cloud — managed proxy with no infra setup
- Enterprise SSO, RBAC, audit retention
- The open-source core remains AGPL-3.0 and feature-complete for self-hosting

## Out of scope (probably forever)

- Running inference locally
- Prompt versioning or templating
- Built-in observability dashboards (we emit events; visualisation belongs elsewhere)
- Building an agentic IDE — that's adjacent work, not Bulwark's lane

## Contributing to the roadmap

- Open a [Discussion](https://github.com/OpsToInnovator/bulwark/discussions) to propose a new item or argue a priority change
- Open an [Issue](https://github.com/OpsToInnovator/bulwark/issues) once an item is concrete enough to scope
- Items move from 🟣 → 🔵 → 🟡 → 🟢 based on what actually gets worked on, not what's planned
