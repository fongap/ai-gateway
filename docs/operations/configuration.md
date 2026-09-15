# Configuration

Production configuration is delivered from GitHub Actions into Cloudflare Workers. Non-sensitive configuration belongs in repository Variables; credentials belong in Secrets. The Cloudflare Dashboard is not the canonical day-to-day configuration source.

## Configuration sources

| Source | Purpose |
| --- | --- |
| `TIER{1,2,3}_NODES_CONFIG_01..10` | Non-secret node definitions for each tier |
| `TIER{1,2,3}_NODES_SECRETS_01..10` | Tier-scoped credentials keyed by node id |
| `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | Client gateway access keys |
| `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | Per-access-group logical-model allowlists |
| `MODELS_CONFIG` | Optional logical-model metadata/capability/policy configuration |
| `POLICIES_CONFIG` | Request-attempt, hedge, timeout and optional Tier 1 admission policy |
| runtime variables | Timeouts, failover, stream, CORS, logging, and related tunables |

`src/config/runtime-vars.ts` owns recognized non-sensitive runtime variables and numeric defaults/ranges.

## Gateway access groups

The runtime uses five independent access groups:

```text
AIR
PRO
MAX
ULTRA
AGENT
```

Each configured group uses both:

```text
GATEWAY_ACCESS_KEY_<GROUP>
GATEWAY_ACCESS_MODELS_<GROUP>
```

Rules:

- at least one grouped gateway key must be configured;
- groups do not inherit from one another;
- a configured key with a missing or empty model allowlist grants zero models;
- model allowlists are CSV values and may use `*` where supported by the access-key parser.

## Node configuration

Current node JSON is explicit. Required fields are:

```text
id
provider
protocol
surfaces
base_url
models
```

`priority` is optional and defaults to `100`. No other node fields are accepted.

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
  }
}
```

### Node rules

- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$` and is globally unique.
- `tier` is not accepted inside node JSON; tier comes from the Variable prefix.
- credential-bearing fields are rejected.
- `provider` is required and non-empty.
- `protocol` is required and is exactly `openai` or `anthropic`.
- `surfaces` is required and non-empty. OpenAI supports `chat_completions` and `responses`; Anthropic supports `messages`.
- `base_url` must be an absolute HTTPS URL unless insecure HTTP is explicitly enabled.
- `priority`, when present, is a non-negative integer JSON number. Tier 2/3 use it; Tier 1 does not use static node priority as a P2C score.
- `models` is required and must be an object mapping logical model → upstream model. Arrays and string-coercion shapes are rejected. `{}` is only an intentional catalog-bounded wildcard.
- `limits` is not part of the schema and is rejected. Provider capacity is learned from runtime evidence rather than guessed node RPM/concurrency values.
- unknown node fields are rejected.

There is no fallback shape for missing `provider`, `protocol`, `surfaces`, or `models`.

## Credential shards

A credential shard is a JSON object:

```json
{
  "nvidia-01": "credential-value",
  "nvidia-02": "credential-value"
}
```

Credentials bind by **Tier + node id**. Config and Secret shard suffixes are independent partition numbers; they do not pair. A node declared in `TIER1_NODES_CONFIG_03` may receive its credential from `TIER1_NODES_SECRETS_01` when tier and node id match.

## Tier roles

The routing order is fixed:

```text
Tier 1 → Tier 2 → Tier 3
```

Their product roles are also fixed:

- Tier 1: free/effectively free capacity and the primary reliability focus.
- Tier 2: reserved for future membership/subscription entitlement capacity. Do not treat it as another generic API-key pool in examples or new designs.
- Tier 3: paid API capacity kept as protected final fallback.

## Runtime variables

Current numeric tunables from `src/config/runtime-vars.ts`:

| Variable | Default | Range | Meaning |
| --- | ---: | ---: | --- |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 15000 | 5s–600s | Time to upstream response headers |
| `FIRST_EVENT_TIMEOUT_MS` | 30000 | 5s–600s | Time to first meaningful stream event |
| `STREAM_IDLE_TIMEOUT_MS` | 120000 | 10s–600s | Maximum idle interval in an active stream |
| `RATE_LIMIT_COOLDOWN_MS` | 30000 | 1s–600s | General non-Tier-1 rate-limit cooldown input |
| `AUTH_FAIL_COOLDOWN_MS` | 3600000 | 1min–7d | Auth-failure credential cooldown |
| `MAX_BODY_BYTES` | 20971520 | 1KB–100MB | Request-body limit |
| `FAILOVER_BUDGET_MS` | 60000 | 1s–900s | Whole-request failover wall clock |
| `HEDGE_DELAY_MS` | 3000 | 0–600s | Reactive hedge delay; `0` disables |
| `MAX_HEDGES_PER_REQUEST` | 1 | 0–3 | Physical hedge twins per request |
| `GATEWAY_KEY_RPM` | 0 | 0–100000 | Per-isolate gateway-access-key 60s sliding-window cap; `0` disables |

String variables:

- `ALLOWED_ORIGIN` — empty by default.
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

Set `PROTOCOL_FALLBACKS=disable` for Native-Only Chat/Messages behavior, or provide an explicit supported mapping. OpenAI Responses remains Native Only.

Unsupported conversion routes are configuration errors. Conversion is skipped before dispatch when it would drop high-risk semantic state such as provider-native tool state/history, thinking history, context management, or a tool-result error marker.

## Runtime capacity and heat protection

Tier 1 capacity is shaped from facts the gateway can observe:

- live in-flight work is a soft ranking signal by default;
- `POLICIES_CONFIG.max_in_flight` is an explicit isolate-local safety ceiling for a known per-account contract; unset, `0`, or `null` means no hard ceiling;
- real rate-limit responses drive cooldown/recovery behavior, including providers that encode throughput quota errors as quota-shaped HTTP 413;
- Tier 1 adaptive rate-limit cooldown follows bounded escalation when post-cooldown recovery still fails;
- upstream `Retry-After` is honored as a floor;
- provider-model heat, passive TTFT, affinity, request priority and circuit state may influence Tier 1 P2C ranking;
- hedge work yields before primary traffic when spare capacity is low.

No local ceiling is presented as a cluster-wide Provider quota. `GATEWAY_KEY_RPM` protects gateway access keys; it is separate from Provider capacity.

## Model-family fallback

Compatible logical aliases share the original request wall-clock and logical-attempt budgets. `max_attempts` is always the request-wide hard ceiling; family fallback never raises it.

Rules include:

- Code aliases stay inside the Code family;
- general `Max / Pro / Ultra` stay inside that family;
- `Air` moves only upward through `Air → Pro → Max → Ultra`;
- request-local failure-domain deduplication prevents aliases that resolve to the same node/account + upstream model from burning repeated attempts;
- model-shaped 404 isolates that node/model mapping while an authorized compatible sibling may still be tried;
- all-transient bounded family exhaustion remains retryable.

## Policies

Current `POLICIES_CONFIG` fields are:

```json
{
  "default": {
    "max_attempts": 5,
    "tier_attempts": null,
    "hedge": { "enabled": true, "tiers": ["tier1"] },
    "first_event_timeout_ms": null,
    "max_in_flight": null
  }
}
```

- `max_attempts`: integer 1–8; hard request-wide logical-attempt ceiling.
- `tier_attempts`: optional explicit caps for `tier1`, `tier2`, `tier3`; total must fit inside `max_attempts`.
- `hedge`: optional `enabled`, `delay_ms`, and `tiers` controls.
- `first_event_timeout_ms`: integer 5000–600000 and cannot exceed `FAILOVER_BUDGET_MS`.
- `max_in_flight`: `null`, `0`, or a non-negative integer JSON number; positive values are Tier 1 isolate-local admission ceilings.

There is one cross-tier allocation model: hard Tier precedence. `budget_split`, weighted allocation, and alternate tier-budget modes are not part of the current policy schema and are rejected as unknown fields.

## Request timing semantics

`FAILOVER_BUDGET_MS` is one wall-clock budget for the whole request. Native tiers, protocol fallback, model-family fallback and bounded re-checks never reset it.

The attempt allocator preserves bounded future escape time for later dispatchable nodes and reachable compatible family passes. Already-spent duplicate failure domains do not reserve phantom future time.

For each physical upstream dispatch, response headers, first meaningful output, successful body assembly, and bounded non-2xx diagnostic-body reads share the same absolute attempt deadline. A hedge twin inherits that deadline instead of receiving a fresh one.

## Deployment identifiers and bindings

Deployment-level identifiers include:

- `CLOUDFLARE_ACCOUNT_ID`
- `GATEWAY_PUBLIC_BASE_URL`
- optional `TOKEN_STATS_D1_ID`
- `TIER1_AFFINITY_KV_ID` when Tier 1 affinity is configured

Runtime bindings may include:

- `TIER1_AFFINITY` KV — hashed session binding;
- `TOKEN_STATS_DB` D1 — token-usage persistence and recent public-status evidence.

Deployment identity is the Git commit SHA injected as `GITHUB_SHA` and exposed by authenticated `/health` as `build`. Project release numbering is not a runtime/configuration field.

## Local validation

```bash
npm run config:check
npm run validate:merge
npm run check:deploy
```

See [Deployment](deployment.md) and [Routing model](../architecture/routing-model.md).
