# Configuration

Production configuration is delivered from GitHub Actions into Cloudflare Workers. Non-sensitive configuration belongs in repository **Variables**; credentials belong in **Secrets**. The Cloudflare Dashboard is not the canonical day-to-day configuration source.

## Configuration sources

| Source | Purpose |
| --- | --- |
| `TIER{1,2,3}_NODES_CONFIG_01..10` | Non-secret node definitions for each tier |
| `TIER{1,2,3}_NODES_SECRETS_01..10` | Tier-scoped credentials keyed by node id |
| `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | Client gateway access keys |
| `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | Per-access-group logical-model allowlists |
| `MODELS_CONFIG` | Optional logical-model metadata/capability/policy configuration |
| `POLICIES_CONFIG` | Request-attempt and hedge policy configuration |
| runtime variables | Timeouts, failover, stream, CORS, logging, and related tunables |

`src/config/runtime-vars.ts` is the source of truth for recognized non-sensitive runtime variables and their numeric defaults/ranges. Sensitive values are deliberately excluded from that registry.

## Gateway access groups

The runtime uses five independent access groups:

```text
AIR
PRO
MAX
ULTRA
AGENT
```

Each group has:

```text
GATEWAY_ACCESS_KEY_<GROUP>
GATEWAY_ACCESS_MODELS_<GROUP>
```

Rules:

- at least one grouped gateway key must be configured for the gateway to be usable;
- groups do not inherit from one another;
- a configured key with a missing/empty model allowlist grants **zero models**;
- model allowlists are CSV values and may explicitly use `*` where supported by the access-key parser;
- no ungrouped legacy gateway key is required by the current runtime.

This is fail-closed by design.

## Node configuration

Example OpenAI-compatible node:

```json
{
  "id": "nvidia-01",
  "provider": "nvidia",
  "protocol": "openai",
  "surfaces": ["chat_completions"],
  "base_url": "https://integrate.api.nvidia.com/v1",
  "priority": 10,
  "models": {
    "Code-Max": "upstream-code-model"
  },
  "limits": {
    "concurrency": 3,
    "rpm": 40,
    "rpm_mode": "hard"
  }
}
```

Example Anthropic node:

```json
{
  "id": "anthropic-01",
  "provider": "anthropic",
  "protocol": "anthropic",
  "surfaces": ["messages"],
  "base_url": "https://api.anthropic.com",
  "priority": 10,
  "models": {
    "Code-Max": "claude-compatible-model"
  },
  "limits": {
    "concurrency": 2
  }
}
```

### Node rules

- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$` and is globally unique.
- `tier` is rejected inside node JSON; tier comes from the variable prefix.
- credential-bearing fields such as `token`, `api_key`, `credential`, `authorization`, `password`, or `secret` are rejected.
- `protocol` is `openai` or `anthropic`.
- OpenAI surfaces are `chat_completions` and/or `responses`.
- Anthropic runtime node surface is `messages`.
- `base_url` must be an absolute HTTPS URL unless insecure HTTP is explicitly enabled.
- `priority` defaults to `100`; it is used by Tier 2/3 and ignored by Tier 1 P2C.
- `models` maps logical model name → provider-facing model name. An empty object is the runtime wildcard form, bounded by the gateway's known-model/catalog rules where applicable.
- allowed `limits` fields are `concurrency`, `rpm`, and `rpm_mode`.
- `rpm_mode` accepts `hard`, `local_hard`, or `soft`; hard/local_hard are isolate-local best-effort hard shaping, not provider-global quota.
- unknown node or limits fields are rejected instead of silently ignored.

Missing `protocol` or `surfaces` can still use deprecated compatibility defaults; operators should declare both explicitly.

## Credential shards

A credential shard is a JSON object:

```json
{
  "nvidia-01": "credential-value",
  "nvidia-02": "credential-value"
}
```

Credentials bind by **Tier + node id**. Config and Secret shard suffixes do **not** pair. For example, a node declared in `TIER1_NODES_CONFIG_03` may receive its credential from `TIER1_NODES_SECRETS_01` as long as the tier and node id match.

The `01..10` suffix is only a transport/sharding boundary for GitHub Actions.

## Runtime variables

Current numeric tunables from `src/config/runtime-vars.ts`:

| Variable | Default | Range | Meaning |
| --- | ---: | ---: | --- |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 15000 | 5s–600s | Time to upstream response headers |
| `FIRST_EVENT_TIMEOUT_MS` | 30000 | 5s–600s | Time to first meaningful stream event |
| `STREAM_IDLE_TIMEOUT_MS` | 120000 | 10s–600s | Maximum idle interval in an active stream |
| `RATE_LIMIT_COOLDOWN_MS` | 30000 | 1s–600s | General rate-limit cooldown input |
| `AUTH_FAIL_COOLDOWN_MS` | 3600000 | 1min–7d | Auth-failure credential cooldown |
| `MAX_BODY_BYTES` | 20971520 | 1KB–100MB | Request-body limit |
| `FAILOVER_BUDGET_MS` | 60000 | 1s–900s | Whole-request failover wall clock |
| `HEDGE_DELAY_MS` | 3000 | 0–600s | Reactive hedge delay; `0` disables |
| `MAX_HEDGES_PER_REQUEST` | 1 | 0–3 | Physical hedge twins per request |
| `GATEWAY_KEY_RPM` | 0 | 0–100000 | Per-isolate gateway-access-key 60s sliding-window cap; `0` disables |

String variables:

- `ALLOWED_ORIGIN` — empty by default; CORS is not broadly enabled unless configured.
- `STREAM_INCLUDE_USAGE` — default `auto`.
- `STREAM_USAGE_INCLUDE_OFF_PROVIDERS` — provider exclusion list for usage hints.
- `ANTHROPIC_COUNT_TOKENS_MODE` — default `approximate`.
- `LOG_LEVEL` — default `info`.
- `PROTOCOL_FALLBACKS` — empty/unset means the built-in fallback chain.

Boolean variables, all default `false`:

- `EXPOSE_UPSTREAM_INFO`
- `FAKE_STREAM_PROTECTION`
- `ALLOW_INSECURE_HTTP_UPSTREAM`

## Protocol fallback

Unset/empty `PROTOCOL_FALLBACKS` resolves to:

```json
{
  "anthropic:messages": ["openai:chat_completions"],
  "openai:chat_completions": ["anthropic:messages"]
}
```

Set `PROTOCOL_FALLBACKS=disable` for Native-Only Chat/Messages behavior, or provide an explicit JSON mapping to override the default. OpenAI Responses remains Native Only regardless.

Unsupported conversion routes are configuration errors rather than implicit best-effort conversions.

## Tier 1 RPM and heat protection

Tier 1 hard RPM uses isolate-local smooth token-bucket admission. The runtime also derives a bounded heat signal from current RPM headroom and concurrency:

- lower RPM headroom can softly increase a candidate's P2C score before the hard gate;
- session-affinity preference decays toward neutral under heat;
- optional hedge twins require spare headroom.

This behavior has **no additional configuration variables**. The existing node `limits.rpm`, `limits.rpm_mode`, and `limits.concurrency` remain the only inputs. There is no success-rate weight and no dynamic concurrency setting.

## Policies

`POLICIES_CONFIG` is a per-policy object referenced by model configuration. Important fields include:

```json
{
  "default": {
    "max_attempts": 5,
    "tier_attempts": null,
    "hedge": { "enabled": true },
    "first_event_timeout_ms": null,
    "budget_split": null
  }
}
```

- `max_attempts` is the request-wide logical-attempt ceiling.
- `tier_attempts` optionally caps individual tiers.
- `hedge.enabled`, optional delay/tier fields control reactive hedge policy.
- `first_event_timeout_ms` can override the global first-event timeout per model/policy.
- `budget_split` supports the current `even`/`weighted` allocation semantics.

Explicit tier caps are authoritative and must fit within `max_attempts`.

## Cloudflare bindings and deployment identifiers

Deployment-level identifiers are handled separately from runtime tunables, including:

- `CLOUDFLARE_ACCOUNT_ID`
- `GATEWAY_PUBLIC_BASE_URL`
- optional `TOKEN_STATS_D1_ID`
- `TIER1_AFFINITY_KV_ID` when Tier 1 affinity is configured

Runtime bindings may include:

- `TIER1_AFFINITY` KV — hashed session binding, 30-minute TTL;
- `TOKEN_STATS_DB` D1 — token-usage persistence and recent public-status evidence;
- optional `QUOTA_RATE_LIMITER` — additional distributed per-location RPM shaping.

None of these should be described as a globally exact provider-account concurrency/quota system.

## Local validation

Use the repository CLI/scripts before deployment:

```bash
npm run config:check
npm run validate:merge
npm run check:deploy
```

See [Deployment](deployment.md) for the production bridge and [Routing model](../architecture/routing-model.md) for how the resulting runtime node fields are used.
