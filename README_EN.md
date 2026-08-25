[简体中文](README.md) | [English](README_EN.md)

# ai-gateway

**AI aggregation gateway — many APIs, many keys, many models, one stable endpoint**

> ⚠️ **Breaking Change**: this release redesigned node configuration and secret management (`TIERx_NODES_CONFIG_*` plain variables + `NODE_SECRETS_*` secrets). The legacy `token@base_url` / embedded-credential format is gone. Existing deployments must re-run configuration.

## What problem it solves

Aggregate upstream APIs and keys — free or paid, prone to rate limits, outages and jitter — into one stable, lightweight, self-healing AI endpoint. Every node plays its own role: rotation spreads load, cooldowns isolate rate limits, circuit breakers self-heal, tiers provide fallback. Clients see a single endpoint.

```text
many APIs · many keys · many models
        ↓
   ai-gateway
        ↓
node selection / load spreading (priority + concurrency)
429 isolation / Retry-After cooldowns
failure rotation / circuit breaker
auto recovery / HALF_OPEN single probe
streaming first-event guard
        ↓
clients see a single stable endpoint
```

- OpenAI Chat Completions: `/v1/chat/completions`
- Anthropic Messages / Claude Code: `/v1/messages`
- Anthropic token count: `/v1/messages/count_tokens`

No database, Redis, KV state sync, multi-tenancy, billing, or semantic cache. Runtime state is best-effort, isolate-local memory.

## Quick start

```bash
git clone https://github.com/fongap/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh     # Windows: powershell scripts/install.ps1
```

### Node config (plain variables, never credentials)

Typical setups are **multi-key, multi-account, multi-model**. This tier-1 example mixes three providers across four accounts serving three logical models:

```json
[
  { "id": "nvidia-01", "provider": "nvidia", "base_url": "https://integrate.api.nvidia.com/v1", "priority": 10,
    "models": { "general-air": "deepseek-ai/deepseek-v3.1", "code-pro": "qwen/qwen3-coder-480b" },
    "limits": { "concurrency": 3, "rpm": 40 } },
  { "id": "nvidia-02", "provider": "nvidia", "base_url": "https://integrate.api.nvidia.com/v1", "priority": 10,
    "models": { "general-air": "deepseek-ai/deepseek-v3.1" },
    "limits": { "concurrency": 3, "rpm": 40 } },
  { "id": "glm-01", "provider": "zhipu", "base_url": "https://open.bigmodel.cn/api/paas/v4", "priority": 20,
    "models": { "general-air": "glm-4.7", "code-max": "glm-4.7" },
    "limits": { "concurrency": 2, "rpm": 30 } }
]
```

Matching credentials secret (`NODE_SECRETS_01`):

```json
{ "nvidia-01": "nvapi-xxx", "nvidia-02": "nvapi-yyy", "glm-01": "zzzz.id" }
```

**Layout conventions** (how the scheduler earns its keep):

| Scenario | Configuration | Effect |
|----------|---------------|--------|
| Multiple accounts of one provider / same-tier keys | same tier, **equal priority** | LRU rotates traffic across keys; first 429 appears only after the combined quota is spent |
| Preference within a tier | different `priority` (10 before 20) | lower value first; higher takes over only when lower is busy/cooling/open |
| Backup / paid keys | lower tier | tiers are hard precedence: tier-2 is never touched while tier-1 has an eligible node |
| One node serving several models | multiple `models` entries | each logical model maps to a different upstream name per node |
| Catch-all node | `"models": {}` wildcard | serves any logical model |

Complete ready-to-edit examples live in [`config/`](config/).

Variable layout:

```text
TIER1_NODES_CONFIG_01..   tier-1 pool (plain vars, JSON arrays)
TIER2_NODES_CONFIG_01..   tier-2 pool
TIER3_NODES_CONFIG_01..   tier-3 pool (last resort)
NODE_SECRETS_01..         Secrets: { "node-id": "credential" }
GATEWAY_ACCESS_KEY        Secret: client access key
```

- Tier comes only from the variable prefix; a `tier` field in node JSON is rejected.
- Shards stay under the 5 KB variable limit (4500-byte cap) and split at node boundaries.
- Duplicate IDs, missing/orphan credentials, invalid URLs fail before deployment.

### Scheduling behavior

| Scenario | Behavior |
|----------|----------|
| Selection | single O(n) pass per attempt: priority ASC → activeRequests ASC → health (band) → lastUsedAt (LRU rotation across equal-priority keys) → latency ASC |
| Concurrency | parallel requests spread across concurrency-limited nodes |
| 429 | cools only the failing node, honors Retry-After (seconds/HTTP-date, clamped 1s–600s) |
| 401/403 | credential problem: long node-local cooldown, excluded from the request |
| 400/413/415/422 | client error: returned immediately, no node rotation |
| 5xx/network/timeout | failure accounting → same-tier rotation → circuit after 3 consecutive |
| Tier fallback | next tier only when the current tier has no eligible node left |
| Recovery | cooldown expiry re-enters the pool; OPEN → HALF_OPEN single probe → CLOSED |
| Streaming | nodes may rotate before the first valid event only |

### Configuration states

`unconfigured` / `invalid` / `degraded` / `ready` — surfaced via `GET /health`.

### Runtime knobs (all optional)

`MAX_BODY_BYTES`, `UPSTREAM_HEADERS_TIMEOUT_MS`, `FIRST_EVENT_TIMEOUT_MS`, `STREAM_IDLE_TIMEOUT_MS`, `RATE_LIMIT_COOLDOWN_MS`, `AUTH_FAIL_COOLDOWN_MS`, `ALLOWED_ORIGIN` (CORS off by default), `EXPOSE_UPSTREAM_INFO`, `FAKE_STREAM_PROTECTION`, `ALLOW_INSECURE_HTTP_UPSTREAM`, `MODELS_CONFIG`, `POLICIES_CONFIG`, `LOG_LEVEL`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Security model

- Bearer / `x-api-key` auth with timing-safe SHA-256 comparison.
- Strict header allowlist; upstream Authorization is built only from the runtime node credential.
- HTTPS-only upstreams by default; `redirect: 'manual'`.
- Credentials never appear in responses, logs or diagnostics.
- Use Cloudflare WAF / Rate Limiting rules for platform-level protection.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for internals and [benchmark/benchmark.mjs](benchmark/benchmark.mjs) for measuring gateway overhead.

## License

[MIT](LICENSE)
