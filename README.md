<div align="center">

# AI-Gateway

**A simple, resilient AI API gateway for a household or small trusted team.**

Cloudflare Workers · Multi-provider routing · Multi-key resilience · Tiered failover · OpenAI/Anthropic compatibility

[**English**](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/fongap/ai-gateway/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fongap/ai-gateway/actions/workflows/ci.yml)
[![Deploy](https://github.com/fongap/ai-gateway/actions/workflows/deploy.yml/badge.svg?branch=main&event=workflow_run)](https://github.com/fongap/ai-gateway/actions/workflows/deploy.yml)
![Version](https://img.shields.io/github/package-json/v/fongap/ai-gateway?label=Version)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/github/license/fongap/ai-gateway?label=License)

[Live Dashboard](https://api.135468.xyz/) · [Quick Start](#quick-start) · [Architecture](docs/architecture/overview.md) · [Configuration](docs/operations/configuration.md) · [Product Policy](docs/governance/product-policy.md)

</div>

ai-gateway turns fragmented AI capacity into one predictable API endpoint for personal, household, or small-team use. It is intentionally not a public SaaS gateway, enterprise API-management platform, billing system, or general multi-tenant control plane.

The design goal is simple: make free capacity dependable first, keep paid capacity protected, and avoid turning a private gateway into an infrastructure platform.

## Tier model

The three tiers have fixed long-term roles:

| Tier | Role |
| --- | --- |
| **Tier 1** | Free or effectively free token capacity. This is the primary daily layer and the main reliability focus. |
| **Tier 2** | Reserved for future membership/subscription entitlement capacity. It is not a second generic API-key pool. |
| **Tier 3** | Paid API capacity kept as protected final fallback. |

Tier 1 is designed for uneven quotas and unreliable free capacity: P2C load spreading, passive TTFT, live in-flight pressure, adaptive 429 cooldown, provider-model heat, circuit/recovery handling, bounded failover, and safe streaming. The objective is **stable, efficient, safe, continuously usable free capacity**, not chasing one “best” key.

Tier 2 and Tier 3 deliberately stay simpler. The project will not copy Tier 1 adaptive machinery into them unless real usage proves it necessary.

## Core capabilities

| Capability | Current behavior |
| --- | --- |
| **Multi-key resilience** | P2C selection, passive TTFT, live in-flight soft load, 429 cooldown and provider-model heat |
| **Tiered failover** | Route through **Tier 1 → Tier 2 → Tier 3** under one request-wide budget |
| **Model-family fallback** | Bounded recovery across compatible aliases without raising `max_attempts` |
| **Protocol compatibility** | Native OpenAI Chat, OpenAI Responses, and Anthropic Messages |
| **Safe protocol fallback** | OpenAI Chat ↔ Anthropic Messages only; **OpenAI Responses is Native Only** for protocol conversion |
| **Streaming safety** | First-meaningful-output commit boundary, SSE lifecycle tracking, no transparent failover after commit |
| **Usage observability** | Delivered-success evidence stays separate from physical upstream-attempt token usage |

## Architecture

```text
Client
  ↓
Auth + validation
  ↓
Logical model
  ↓
Native protocol pool
  ↓
Tier 1 → Tier 2 → Tier 3
  ↓
optional Chat ↔ Messages fallback
  ↓
bounded compatible-model fallback
  ↓
Response / stream
```

All native retries, protocol fallback, model-family fallback, and hedge work share the same request-wide attempt and wall-clock budgets. Model-family fallback never enlarges `max_attempts`.

Code aliases stay inside the Code family. `Air` may move upward to `Pro → Max → Ultra`; higher general aliases never fall back down to `Air`. A model-shaped 404 isolates the failing node/model mapping while an authorized compatible sibling may still be tried inside the same request budget.

The project prefers bounded local state over global coordination. Cross-PoP concurrency/quota coordination is not added unless production evidence shows the household/small-team deployment model actually needs it.

## No old-version compatibility layer

ai-gateway carries one current contract. When configuration, schemas, or internal contracts change, the old path is removed rather than preserved behind aliases, dual-read/dual-write logic, deprecation windows, or compatibility shims.

Git history and tags preserve old versions. Runtime code does not.

This rule does **not** remove intentional OpenAI/Anthropic protocol compatibility; those protocols are part of the current product surface.

See [Product Policy](docs/governance/product-policy.md) for the permanent rule.

## API surface

| Method | Path | Surface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible local token count |
| `GET` | `/v1/models` | Model catalog |
| `GET` | `/health` | Authenticated health diagnostics |
| `GET` | `/version` | Source version and deployed-build identity |

## Quick start

Requirements: Node.js **>=22.18.0** and a Cloudflare account for deployment.

```bash
git clone https://github.com/fongap/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh
```

Windows:

```powershell
powershell scripts/install.ps1
```

For production, use the repository-driven workflow in [Deployment](docs/operations/deployment.md).

## Configuration

| Layer | Configuration |
| --- | --- |
| Nodes | `TIER{1,2,3}_NODES_CONFIG_01..10` |
| Upstream credentials | `TIER{1,2,3}_NODES_SECRETS_01..10` |
| Gateway access | `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` |
| Model access | `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` |
| Model/request policy | `MODELS_CONFIG` · `POLICIES_CONFIG` |

Credentials bind by **Tier + node id**; Config and Secret shard suffixes are independent partition numbers and are unrelated to one another. Gateway access is fail-closed: a configured Group Key with a missing or empty corresponding `GATEWAY_ACCESS_MODELS_<GROUP>` grants no model access.

Node `limits` are not part of the active schema and are rejected. Runtime capacity is learned from real in-flight pressure, 429/cooldown, circuit state, and latency signals rather than guessed per-node ceilings.

See [Configuration](docs/operations/configuration.md) for the current schema and runtime variables.

## Production flow

```text
Pull Request
    ↓
validate-merge
    ↓
squash merge to main
    ↓
validate-deploy
    ↓
D1 migrations
    ↓
Worker deploy
    ↓
remote verification
```

Documentation-only commits are intentionally excluded from Worker redeployment.

## Documentation

| Area | Purpose |
| --- | --- |
| [Product Policy](docs/governance/product-policy.md) | Permanent scope, tier roles, simplicity and clean-replacement rules |
| [Architecture](docs/architecture/overview.md) | Runtime boundaries, routing, protocol and reliability contracts |
| [Operations](docs/operations/configuration.md) | Configuration, deployment and troubleshooting |
| [Governance](docs/governance/README.md) | Development, quality, dependency, version/tag and documentation rules |
| [CHANGELOG](CHANGELOG.md) | Version history |

English is the canonical documentation language. The [Simplified Chinese README](README.zh-CN.md) is a reader-facing translation.

## Security

Never place upstream credentials in node configuration or public logs. See [SECURITY.md](SECURITY.md).

## License

MIT License. See [LICENSE](LICENSE).