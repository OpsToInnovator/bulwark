# Contributing to Bulwark

Thanks for thinking about contributing. Bulwark is an LLM API cost-guard proxy — hard spend caps, semantic caching, provider fallback, Bedtime Mode. The goal is simple: stop your AI bill before it stops you.

This doc covers how to get the project running locally, how to open a useful issue, and what a good PR looks like.

## Getting started

### Prerequisites

- **Node.js** v20+
- **npm** v10+
- A **Cloudflare Workers** account (Bulwark runs on Workers via `wrangler`)
- API keys for at least one LLM provider you want to proxy (OpenAI, Anthropic, Gemini)

### Local setup

```bash
git clone https://github.com/OpsToInnovator/bulwark.git
cd bulwark
npm install
cp .dev.vars.example .dev.vars   # add your provider keys here
npx wrangler dev
```

The proxy will start on `http://localhost:8787` by default. Point your LLM client at that URL instead of `api.openai.com` / `api.anthropic.com` / etc.

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
3. Make the change, add tests, run `npm test` and `npm run lint`
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
