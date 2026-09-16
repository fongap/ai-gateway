# Configuration

Production configuration is delivered from GitHub Actions into Cloudflare Workers. Non-sensitive account configuration belongs in repository Variables; credentials belong in Secrets. The Cloudflare Dashboard is not the canonical day-to-day configuration source.

## Sources

| Source | Purpose |
| --- | --- |
| `TIER{1,2,3}_NODES_CONFIG_01..10` | Non-secret account/node definitions |
| `TIER{1,2,3}_NODES_SECRETS_01..10` | Tier-scoped credentials keyed by node id |
| `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | Gateway access keys |
| `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | Per-group logical-model allowlists |
| `MODELS_CONFIG` | Optional logical-model metadata/capabilities |
| `POLICIES_CONFIG` | Attempt, hedge, timeout and Tier 1 admission policy |

`src/config/runtime-vars.ts` is the single source for runtime variable defaults and ranges.

## Access groups

The five independent groups are `AIR`, `PRO`, `MAX`, `ULTRA`, and `AGENT`. A configured group uses both:

```text
GATEWAY_ACCESS_KEY_<GROUP>
GATEWAY_ACCESS_MODELS_<GROUP>
```

Groups do not inherit from one another. An empty model allowlist grants zero models.

## Node configuration

Node JSON describes an account/endpoint, not protocol implementation details.

Required fields:

```text
id
provider
base_url
models
```

Optional field:

```text
priority
```

Example:

```json
{
  "id": "nvidia-01",
  "provider": "nvidia",
  "base_url": "https://integrate.api.nvidia.com/v1",
  "priority": 10,
  "models": {
    "Code-Max": "upstream-code-model"
  }
}
```

Rules:

- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$` and is globally unique.
- `tier` is not a node field; the Variable prefix owns the tier.
- credentials never appear in node JSON.
- `provider`, `base_url`, and `models` are required.
- `base_url` must be absolute HTTPS unless insecure HTTP is explicitly enabled.
- `priority`, when present, is a non-negative integer JSON number. Tier 2/3 may use it; Tier 1 does not use static node priority as a P2C score.
- `models` is an object mapping logical model → upstream model. `{}` is only an intentional catalog-bounded wildcard.
- `protocol`, `surfaces`, `limits`, credential fields, and other unknown fields are rejected.

There is one current node shape. No alternate or compatibility schema is retained.

## Provider wire profiles

Protocol and API surfaces are Provider capabilities and are defined once in `src/config/provider-profile.ts`:

- `provider: "anthropic"` → Anthropic protocol, `messages` surface.
- `provider: "openai"` → OpenAI protocol, `chat_completions` and `responses` surfaces.
- other providers → OpenAI-compatible `chat_completions` surface.

If a Provider needs a different wire contract, change its Provider profile. Do not repeat structural protocol/surface fields across every account.

OpenAI Responses remains Native Only. Chat/Messages protocol fallback remains bidirectional where conversion is safe:

```json
{
  "anthropic:messages": ["openai:chat_completions"],
  "openai:chat_completions": ["anthropic:messages"]
}
```

## Credential shards

Credential shards are JSON objects keyed by node id:

```json
{
  "nvidia-01": "credential-value",
  "nvidia-02": "credential-value"
}
```

Config and Secret shard suffixes are independent. Binding is by **Tier + node id**, not by matching shard suffix.

## Tier roles

Routing order is fixed:

```text
Tier 1 → Tier 2 → Tier 3
```

- Tier 1: free/effectively free capacity; primary reliability focus.
- Tier 2: reserved for future membership/subscription entitlement capacity.
- Tier 3: paid API capacity; protected final fallback.

## Runtime variables

Current numeric tunables are owned by `src/config/runtime-vars.ts`:

- `UPSTREAM_HEADERS_TIMEOUT_MS`
- `FIRST_EVENT_TIMEOUT_MS`
- `STREAM_IDLE_TIMEOUT_MS`
- `RATE_LIMIT_COOLDOWN_MS`
- `AUTH_FAIL_COOLDOWN_MS`
- `MAX_BODY_BYTES`
- `FAILOVER_BUDGET_MS`
- `HEDGE_DELAY_MS`
- `MAX_HEDGES_PER_REQUEST`
- `GATEWAY_KEY_RPM`

Other current variables include `ALLOWED_ORIGIN`, `STREAM_INCLUDE_USAGE`, `STREAM_USAGE_INCLUDE_OFF_PROVIDERS`, `ANTHROPIC_COUNT_TOKENS_MODE`, `LOG_LEVEL`, `PROTOCOL_FALLBACKS`, `EXPOSE_UPSTREAM_INFO`, `FAKE_STREAM_PROTECTION`, and `ALLOW_INSECURE_HTTP_UPSTREAM`.

## Capacity and reliability

Tier 1 uses observed runtime facts rather than guessed Provider quotas:

- live in-flight work;
- actual rate-limit responses, including quota-shaped HTTP 413;
- bounded adaptive cooldown and `Retry-After`;
- provider-model heat;
- passive TTFT;
- affinity, request priority and circuit state;
- optional explicit `POLICIES_CONFIG.max_in_flight` safety ceiling.

`GATEWAY_KEY_RPM` protects gateway access keys; it is not a Provider quota model.

## Policies

Example:

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

`max_attempts` is the request-wide logical-attempt ceiling. Tier caps must fit inside it. There is one cross-tier allocation model: hard Tier precedence. `budget_split`, weighted allocation, and alternate tier-budget modes are not part of the current policy schema and are rejected as unknown fields.

## Request timing

`FAILOVER_BUDGET_MS` is one wall-clock budget for the whole request. Native tiers, protocol fallback, model-family fallback and bounded re-checks do not reset it. A physical dispatch shares one absolute attempt deadline across headers, first meaningful output, body assembly and bounded diagnostic reads. A hedge twin inherits that deadline.

## Deployment identity

Deployment identity is the Git commit SHA injected as `GITHUB_SHA` and exposed by authenticated `/health` as `build`. Named releases, when wanted, are created manually by a human as Git tags / GitHub Releases.

## Local validation

```bash
npm run config:check
npm run validate:merge
```
