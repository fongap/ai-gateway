[简体中文](README.md) | [English](README_EN.md)

# Smart Edge Gateway

**智能边缘网关**


[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-43853d?logo=node.js&logoColor=white)](package.json)

A lightweight AI API gateway running on Cloudflare Workers. It unifies multiple OpenAI-compatible upstream providers and exposes:

- OpenAI Chat Completions: `/v1/chat/completions`
- Anthropic Messages / Claude Code: `/v1/messages`
- Anthropic Token Count: `/v1/messages/count_tokens`

Requests use the Primary endpoint pool first. The two-level Fallback chain is activated only after all eligible Primary attempts fail.

## Why this project exists

AI applications often depend on multiple model providers with different model IDs, reliability characteristics, and rate limits. Keeping those differences inside every client leads to duplicated configuration and inconsistent failure handling.

Smart Edge Gateway provides one entry point to:

- decouple clients from provider-specific settings;
- expose both OpenAI and Anthropic-compatible endpoints;
- switch to backup routes after Primary exhaustion;
- map model aliases, capabilities, and invoke URLs by hostname;
- deploy an edge routing layer without operating a standalone server.

## Dashboard preview

![Smart Edge Gateway dashboard](docs/screenshots/dashboard.png)

## Architecture

![Smart Edge Gateway architecture](docs/architecture.svg)

Primary handles normal traffic. Fallback is not part of normal rotation and is attempted only after Primary exhaustion. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Features

- OpenAI and Anthropic-compatible endpoints;
- a default route and method allowlist that blocks arbitrary upstream management APIs;
- HTTPS-only Primary and Fallback upstreams by default;
- Primary rotation, bounded retries, health scoring, hard concurrency limits, and true cooldown exclusion;
- two-level Fallback routing after Primary exhaustion;
- per-host model aliases, capabilities, and independent `invoke_url` values;
- non-streaming and streaming conversion, images, and tool calls;
- common Claude Code and parallel tool-call patterns;
- public `/version` endpoint;
- protected `/v1/models` with Primary failover and configured-model fallback;
- protected `/health` and `/metrics` endpoints;
- optional Cloudflare Analytics Engine events.

## Scope and limitations

This project provides a stable entry point for multiple OpenAI-compatible upstreams. It is not an official Anthropic proxy, and it cannot create native Anthropic thinking signatures, exact token accounting, or unsupported protocol semantics on behalf of a third-party model.

`/health` and `/metrics` expose local state from the current Worker isolate. They are not globally aggregated Cloudflare totals and are not a billing dashboard. Streaming requests remain active until the response body ends or the client cancels.

The gateway forwards a client-supplied `Idempotency-Key`, but retries still cannot guarantee idempotency across all third-party providers. If an upstream accepted a request but the gateway timed out before response headers arrived, a later retry may cause a duplicate call or duplicate charge.

## Repository layout

```text
.
├─ src/index.js                  Complete Worker source
├─ config/                       Model mapping examples
├─ scripts/                      Deployment, verification, and release scripts
├─ docs/                         Deployment, configuration, architecture, screenshots
├─ .github/workflows/            CI and GitHub Release workflows
├─ .github/ISSUE_TEMPLATE/       Issue forms
├─ wrangler.jsonc                Wrangler configuration
├─ package.json                  npm commands and pinned Wrangler invocations
├─ package-lock.json             Reproducible dependency lock file
├─ README.md                     Chinese documentation
├─ README_EN.md                  English documentation
├─ SECURITY.md                   Vulnerability reporting policy
├─ CONTRIBUTING.md               Contribution guide
├─ OPEN_SOURCE_CHECKLIST.md      Release checklist
└─ LICENSE                       MIT License
```

## Quick deployment

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

### Linux / macOS

```bash
chmod +x scripts/*.sh
./scripts/install.sh
```

The script checks Node.js, installs dependencies, signs in to Cloudflare, collects configuration, writes credentials to a temporary file, uploads the Worker and secrets together, and removes the temporary file after deployment.

Real credentials are not stored in the repository.

## Automatic deployment from GitHub to Cloudflare

### One Worker

1. Push this repository to GitHub;
2. create or select the target Worker in Cloudflare;
3. connect this repository and the production branch `main` under **Settings → Builds**;
4. use these build settings:

```text
Root directory: /
Build command: npm run build
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

5. add `GATEWAY_ACCESS_KEY` and `PRIMARY_API_TOKENS` under that Worker's **Settings → Variables and Secrets**;
6. retry the initial deployment or push another commit.

### Deploy multiple Workers from one repository

The same source repository can be connected to multiple Workers without copying the repository or changing Cloudflare's default deploy command.

For example, create and connect:

```text
ai-gateway-01
ai-gateway-02
ai-gateway-03
```

Connect every Worker to the same GitHub repository and keep Cloudflare's automatically populated settings:

```text
Root directory: /
Build command: npm run build
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

Workers Builds on Wrangler v3 and later uses `WRANGLER_CI_OVERRIDE_NAME` to match the currently connected Worker automatically. Workers such as `ai-gateway-01` and `ai-gateway-02` can deploy from one repository without per-Worker environments or wrapper scripts.

The “update `wrangler.jsonc`” banner is a configuration-sync recommendation, not a deployment failure. When one repository is connected to several differently named Workers, do not accept a PR that changes the top-level `name` to only one Worker; dismiss the banner instead.

Configure runtime Secrets independently under **Settings → Variables and Secrets** for every Worker. This allows each Worker to use different gateway access keys, Primary tokens, upstream URLs, model mappings, and Fallback settings.

The following value in `wrangler.jsonc`:

```json
"name": "ai-gateway"
```

is the repository's default name. Cloudflare overrides it with the connected Worker name during Builds, so it does not limit the number of connected Workers.

Each Worker must independently define `GATEWAY_ACCESS_KEY` and `PRIMARY_API_TOKENS` under **Settings → Variables and Secrets**. Runtime Secrets cannot be copied automatically from another Worker and must never be committed to the repository.

> Preview deployments also require both runtime Secrets on the target Worker; otherwise `secrets.required` blocks the upload.

> Store real tokens as Cloudflare Worker Secrets. Build-time variables are not a substitute for runtime Worker Secrets.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full procedure.

## Minimum configuration

| Variable | Required | Purpose |
|---|---|---|
| `GATEWAY_ACCESS_KEY` | Yes | Credential used by clients to access the gateway |
| `PRIMARY_API_TOKENS` | Yes | One or more upstream tokens; supports `Token@BaseURL` |
| `PRIMARY_BASE_URL` | Conditional | Shared upstream URL when tokens do not bind a URL |
| `MODEL_MAPPING` | No | Maps client-facing model names to actual upstream model IDs |
| `STRICT_MODEL_MAPPING` | No | Allows only configured model names when set to `true` |
| `ALLOW_UNSAFE_PROXY_ROUTES` | No | Defaults to `false`; only supported routes are exposed |
| `FAKE_STREAM_PROTECTION` | No | Defaults to `false`; non-stream reconstruction is opt-in |

Fallback requires at least:

```text
FALLBACK_API_TOKEN
FALLBACK_BASE_URL
FALLBACK_PRIMARY_MODEL
```

Secondary Fallback behavior:

```text
Unset or empty       -> disabled by default
A concrete model ID  -> enabled
Value set to off     -> explicitly disabled
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all variables.

## Client examples

### OpenAI-compatible client

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"model-alias","messages":[{"role":"user","content":"Hello"}]}'
```

### Claude Code

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://YOUR-WORKER.workers.dev",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_GATEWAY_ACCESS_KEY",
    "ANTHROPIC_MODEL": "model-alias"
  }
}
```

## Diagnostic endpoints

### Version

`/version` is public:

```bash
curl https://YOUR-WORKER.workers.dev/version
```

### Model list

```bash
curl https://YOUR-WORKER.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

The gateway tries configured Primary upstreams in order. If one upstream does not implement `/v1/models`, the next one is attempted. A successful upstream list is merged with client-facing aliases from `MODEL_MAPPING`. When no upstream exposes a model-list endpoint, configured aliases and Fallback model names can still be returned.

You can also run:

```powershell
.\scripts\models-check.ps1
```

or:

```bash
./scripts/models-check.sh
```

### Health

```bash
curl https://YOUR-WORKER.workers.dev/health \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

Or run:

```powershell
.\scripts\health-check.ps1
```

or:

```bash
./scripts/health-check.sh
```

### Metrics

```bash
curl https://YOUR-WORKER.workers.dev/metrics \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

`/health` and `/metrics` expose two current-isolate views:

- client request, success, failure, Fallback activation, and Fallback success counters;
- per-upstream attempt, success, failure, active-stream, and average time-to-response-headers metrics.

A client request can produce multiple upstream attempts, so the two groups do not match. All values reset with the isolate and are not daily global totals.

## Local verification

```bash
npm ci
npm run verify
npm run check:deploy
```

Verification includes:

- Worker JavaScript syntax;
- version consistency;
- local Markdown links;
- dashboard, `/version`, `/v1/models`, `/health`, and `/metrics` smoke tests;
- common secret-pattern scanning.

## GitHub Releases

Pushing a semantic version tag automatically triggers GitHub Actions to:

1. run `npm ci` and `npm run verify`;
2. confirm that the tag matches the `package.json` version;
3. build ZIP and TAR.GZ archives plus SHA-256 checksums;
4. create a GitHub Release and upload the assets.

```bash
git tag v5.14.0
git push origin v5.14.0
```

See [docs/RELEASE.md](docs/RELEASE.md).

## Security

- Never commit `.dev.vars`, `.env`, or `secrets*.json`;
- never paste real tokens, full authorization headers, or user request bodies into public issues;
- do not pass gateway keys in URL query parameters;
- revoke and rotate exposed credentials immediately;
- report vulnerabilities through a private GitHub Security Advisory.

See [SECURITY.md](SECURITY.md).

## Contributing

Before submitting changes:

```bash
npm ci
npm run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT License](LICENSE)
