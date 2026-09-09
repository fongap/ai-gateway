# ai-gateway

**Many APIs · many keys · many models · one endpoint**

Aggregate multiple AI APIs, keys, and models behind one endpoint with rate-limit handling, failover, and protocol fallback.

Current version: **1.3.0**

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-43853d?logo=node.js&logoColor=white)
![MIT](https://img.shields.io/badge/license-MIT-2ea44f)

[Quick Start](#quick-start) · [Configuration](#configuration) · [API](#api) · [Docs](#docs) · [中文](README.md)

```mermaid
flowchart TB
    A[Request] --> B[Auth / Routing]
    B --> C[Native First]
    C --> D[Tier 1 → Tier 2 → Tier 3]
    D --> E["Protocol Fallback<br/>Chat ↔ Messages<br/>Responses: Native Only"]
    E --> F[Response]
```

## Capabilities

| Capability | Description |
| --- | --- |
| Multi-protocol | OpenAI Chat / Responses, Anthropic Messages |
| Multi-node | Multiple APIs, keys, and models behind one endpoint |
| Tier routing | Tier 1 → Tier 2 → Tier 3 |
| Failover | Switches nodes on 429, 5xx, and timeouts |
| Protocol fallback | Chat ↔ Messages; Responses stays native |
| Session affinity | Tier 1 supports cross-isolate session binding |

## Quick Start

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

For production deployment, see [docs/operations/deployment.md](docs/operations/deployment.md).

## Configuration

```json
{
  "id": "node-01",
  "provider": "example",
  "protocol": "openai",
  "surfaces": ["chat_completions"],
  "base_url": "https://api.example.com/v1",
  "priority": 10,
  "models": {
    "code": "upstream-model"
  },
  "limits": {
    "concurrency": 3,
    "rpm": 40
  }
}
```

| Configuration | Purpose |
| --- | --- |
| `TIER*_NODES_CONFIG_*` | Node configuration |
| `TIER*_NODES_SECRETS_*` | Node credentials |
| `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | Five gateway access-key groups; configure at least one for a new deployment |
| `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | Model allowlist for the corresponding group |
| `MODELS_CONFIG` | Model configuration |
| `POLICIES_CONFIG` | Routing policies |

Each Access Group is independent. When a group Key is configured, explicitly configure its Models as well; a missing or empty Models value grants that Key zero model access. The legacy `GATEWAY_ACCESS_KEY` remains only for compatibility: it is honored only when none of the five group Keys is configured and is not the recommended path for new deployments.

A Secret must belong to the same Tier as its node and bind by node id; `01..10` are shard numbers only, and Config/Secret shard suffixes do not need to match.

## API

| Method | Path | Protocol / Purpose |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/messages/count_tokens` | Anthropic Token Count |
| GET | `/v1/models` | Model list |
| GET | `/health` | Health check |

## Docs

| Topic | Document |
| --- | --- |
| Architecture | [Architecture overview](docs/architecture/overview.md) |
| Configuration | [Configuration](docs/operations/configuration.md) |
| Deployment | [Deployment](docs/operations/deployment.md) |
| Reliability | [Reliability model](docs/architecture/reliability-model.md) |
| Security | [Quality and security](docs/governance/quality-policy.md) |

## License

MIT License. See [LICENSE](LICENSE).
