# Contributing to Bulwark

Thanks for thinking about contributing. Bulwark is an LLM API cost-guard proxy — hard spend caps, semantic caching, provider fallback, Bedtime Mode. The goal is simple: stop your AI bill before it stops you.

This doc covers how to get the project running locally, how to open a useful issue, and what a good PR looks like.

## Getting started

### Prerequisites

- **Node.js** v20+
- **npm** v10+
- **PostgreSQL** — `wrangler dev` will not start without one (see below)
- API keys for at least one LLM provider you want to proxy (OpenAI, Anthropic, Gemini)

You do not need a Cloudflare account to develop locally. `wrangler dev` runs the
Worker in a local runtime, and the placeholder KV and Hyperdrive ids in
`wrangler.toml` are fine there. You only need an account to `npm run deploy`.

### Local setup

```bash
git clone https://github.com/OpsToInnovator/bulwark.git
cd bulwark
npm install
cp .dev.vars.example .dev.vars   # only needed if you are touching billing
```

`wrangler.toml` declares a Hyperdrive binding, so `wrangler dev` refuses to boot
until you point it at a local Postgres. Create a database, apply the schema, and
export the connection string:

```bash
createdb bulwark   # on a stock Debian/Ubuntu install: sudo -u postgres createdb -O "$USER" bulwark
psql bulwark -c '
  CREATE TABLE IF NOT EXISTS usage_records (
    request_id        TEXT PRIMARY KEY,
    key_id            TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INT  NOT NULL,
    completion_tokens INT  NOT NULL,
    cost_usd          NUMERIC(12,8) NOT NULL,
    cache_hit         BOOLEAN NOT NULL,
    anomaly_flag      BOOLEAN NOT NULL,
    latency_ms        INT NOT NULL,
    timestamp         TIMESTAMPTZ NOT NULL,
    http_status       INT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_records_key_id_timestamp
    ON usage_records(key_id, timestamp DESC);'

export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://localhost:5432/bulwark"
npm run dev
```

On wrangler v4 that variable is named `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`.

The proxy starts on `http://localhost:8787`. Point your LLM client at that URL
instead of `api.openai.com` / `api.anthropic.com` / etc.

### Making your first request

Every proxy route needs a Bulwark key, which lives in KV — a fresh clone has
none, so requests 401 until you seed one. Keys are `bwk_<keyId>_<secret>` and KV
stores the SHA-256 of the whole string under `apikey:<keyId>`:

```bash
KEY_ID=devkey01
SECRET=$(openssl rand -hex 12)
KEY="bwk_${KEY_ID}_${SECRET}"
HASH=$(printf '%s' "$KEY" | openssl dgst -sha256 -hex | awk '{print $NF}')

npx wrangler kv key put --binding BULWARK_KV --local --preview "apikey:${KEY_ID}" "$(cat <<EOF
{"keyId":"${KEY_ID}","keyHash":"${HASH}","ownerId":"dev","tier":"free",
 "dailyCapUsd":5,"monthlyCapUsd":50,"bedtimeEnabled":false,"wakeHour":7,
 "timezone":"UTC","createdAt":"$(date -u +%FT%TZ)","active":true}
EOF
)"
echo "$KEY"
```

`--preview` matters: `wrangler dev` reads the `preview_id` namespace, so a key
written without it is invisible to the dev server.

Then call the proxy, passing your own provider key through. Bulwark never stores
it — it is read from the `x-provider-key` header per request and forwarded:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "authorization: Bearer $KEY" \
  -H "x-provider-key: $OPENAI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

### Running tests

```bash
npm test          # one-off
npm run test:watch  # watch mode
```

Tests use [Vitest](https://vitest.dev/). New behaviour should land with tests.

## Opening an issue

Before you open an issue, please check:

1. Existing [open issues](https://github.com/OpsToInnovator/bulwark/issues) — yours may already be tracked
2. The [Discussions tab](https://github.com/OpsToInnovator/bulwark/discussions) — questions and design conversations live there, not in issues
3. The [README](./README.md) and [DESIGN.md](./DESIGN.md) — your question may already be answered

Use the right template:

- **🐛 Bug report** — something behaves incorrectly
- **✨ Feature request** — something you want Bulwark to do
- **❓ Question** — consider posting to Discussions instead

Good issues include: what you expected, what happened, how to reproduce, your Bulwark version and runtime (Workers / Node / Docker), and any relevant logs.

## Opening a pull request

1. **Open or comment on an issue first** for non-trivial changes — saves us both time
2. Fork, branch off `main` with a descriptive name (`feat/per-key-budgets`, `fix/anthropic-429-retry`)
3. Make the change, add tests, run `npm test` and `npm run type-check`
4. Open the PR with a clear description: what changed, why, and how to verify
5. Link the issue in the PR description (`Closes #123`)

### Style

- TypeScript strict mode, no `any` unless justified in a comment
- Small, focused commits — easier to review and revert
- Comments explain *why*, not *what*

### Review

I review PRs personally. Expect a response within a few days. I might ask for changes, suggest a different approach, or merge as-is — all three are normal.

## Areas that need help

Browse issues labelled [`good first issue`](https://github.com/OpsToInnovator/bulwark/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and [`help wanted`](https://github.com/OpsToInnovator/bulwark/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) for the current focus.

## License

By contributing, you agree your contributions are licensed under [AGPL-3.0](./LICENSE) — the same license as the rest of Bulwark.

## Code of conduct

Be direct. Be kind. Assume good faith. Disagreement is fine; condescension and personal attacks aren't.
