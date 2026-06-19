# Security Policy

## Reporting a vulnerability

If you've found a security vulnerability in Bulwark, **please do not open a public issue**.

Email **jakewyatt3@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce it
- The version of Bulwark affected
- Any suggested mitigation

You can expect:

- An acknowledgement within **48 hours**
- A status update within **7 days**
- Coordinated disclosure once a fix is available

## What counts as a vulnerability

- Authentication or authorisation bypass on proxy endpoints
- Leakage of provider API keys, user tokens, or cached prompts/responses across tenants
- Cost-cap bypass that allows spend beyond a configured budget
- Remote code execution, prompt injection that escalates privileges, or supply-chain risks in dependencies
- Anything that lets a caller affect a different caller's budget, cache, or quota state

## What does not count

- Issues in third-party LLM providers — report those to the providers directly
- Self-inflicted misconfigurations (e.g. running Bulwark with `MAX_COST_USD=999999`)
- Theoretical issues with no practical exploit path

## Supported versions

Bulwark is pre-1.0. Only the `main` branch is supported. Security fixes are released as point updates against the latest `main`.

## Acknowledgements

If you'd like public credit for a responsible disclosure, let me know in your report. Otherwise the fix lands quietly and your name stays out of it — your choice.
