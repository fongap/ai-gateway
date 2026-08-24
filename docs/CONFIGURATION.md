# Configuration

> Breaking change: this document describes the 6.x configuration schema only. Old deployments must re-configure.

## Secrets (wrangler secret / dashboard "Secret")

| Variable | Required | Content |
|----------|----------|---------|
| `GATEWAY_ACCESS_KEY` | yes | Client access key for the gateway |
| `NODE_SECRETS_01..99` | yes | JSON object `{ "node-id": "credential" }`, sharded at entry boundaries |

Example `NODE_SECRETS_01`:

```json
{
  "nvidia-01": "nvapi-xxxxxxxx",
  "openrouter-01": "sk-or-xxxxxxxx"
}
```

Credentials are looked up by node `id`. A node without a credential is excluded from scheduling; a credential without a node is reported in `/health` diagnostics.

## Plain variables (dashboard "Text"/JSON variables)

### Node pools

```text
TIER1_NODES_CONFIG_01 .. _99   tier-1 pool
TIER2_NODES_CONFIG_01 .. _99   tier-2 pool
TIER3_NODES_CONFIG_01 .. _99   tier-3 pool
```

Each value is a JSON array of node objects; shards split at complete node boundaries and stay under 4500 bytes.

Node schema:

```json
{
  "id": "nvidia-01",
  "provider": "nvidia",
  "base_url": "https://integrate.api.nvidia.com/v1",
  "priority": 10,
  "models": { "general-air": "model-a", "code-pro": "model-b" },
  "limits": { "concurrency": 1 }
}
```

Rules enforced at load time:

- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$`; duplicates make the whole config `invalid`.
- Credential fields (`token`, `api_key`, `apikey`, `authorization`, `password`, `secret`, `credential`) are **rejected** — credentials belong in `NODE_SECRETS_*`.
- A `tier` field is rejected; the tier comes from the variable prefix.
- `base_url` must be an absolute URL; `https://` unless `ALLOW_INSECURE_HTTP_UPSTREAM=true`; no embedded username/password.
- `priority`: number, smaller = higher precedence, default `100`.
- `models`: object mapping logical → upstream model names. Empty/missing = wildcard.
- `limits.concurrency`: integer ≥ 1, default `2`.

### Optional

```jsonc
// MODELS_CONFIG
{ "general-air": { "policy": "fast" } }

// POLICIES_CONFIG
{ "fast": { "max_attempts": 5 } }
```

Tier order is fixed: tier-1 → tier-2 → tier-3. A lower tier is used only when the current tier has no eligible node for the request. `max_attempts` (default 5, clamp 1–8) bounds total attempts per request across all tiers.

### Runtime knobs

| Variable | Default | Range | Meaning |
|----------|---------|-------|---------|
| `MAX_BODY_BYTES` | 20971520 | 1KB–100MB | Request body limit |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 120000 | 5s–600s | Time to upstream response headers |
| `FIRST_EVENT_TIMEOUT_MS` | 60000 | 5s–600s | Streaming first-event guard timeout |
| `STREAM_IDLE_TIMEOUT_MS` | 120000 | 10s–600s | Max gap between stream chunks |
| `RATE_LIMIT_COOLDOWN_MS` | 60000 | 1s–600s | 429 cooldown without Retry-After |
| `AUTH_FAIL_COOLDOWN_MS` | 3600000 | 1min–7d | 401/403 credential cooldown |
| `ALLOWED_ORIGIN` | *(unset)* | origin or `*` | CORS is OFF unless set |
| `EXPOSE_UPSTREAM_INFO` | false | | Expose upstream host/path in diagnostics |
| `FAKE_STREAM_PROTECTION` | false | | Convert non-stream requests to streaming upstream + reassemble |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | false | | Allow http:// base_url |
| `ANTHROPIC_COUNT_TOKENS_MODE` | approximate | approximate/disabled | Local token counting |
| `ANTHROPIC_REASONING_REQUEST_MODE` | none | none/reasoning_effort/chat_template_kwargs/thinking | Reasoning passthrough style |
| `LOG_LEVEL` | info | none/error/info/debug | Logging verbosity |
| `PROJECT_REPOSITORY_URL` | — | https URL | Shown on the dashboard |

Removed in 6.x (do not set): `REQUEST_TIMEOUT_MS`, `ANTRHOPIC_MAX_BODY_BYTES`/`ANTHROPIC_MAX_BODY_BYTES`, `CACHE_ENABLED`, `CACHE_MAX_AGE_SEC`, `CACHE_MAX_BODY_BYTES`, `AE_DATASET`, `ALLOW_UNSAFE_PROXY_ROUTES`, `PRIMARY_*`, `FALLBACK_*`, `MODEL_MAPPING`, un-suffixed `TIERx_NODES_CONFIG`.

## Configuration status

Computed at config-load time and exposed on `/health` and `/version`:

| Status | Condition |
|--------|-----------|
| `unconfigured` | `GATEWAY_ACCESS_KEY` or any `TIER*_NODES_CONFIG_*` missing |
| `invalid` | Config present but zero usable nodes, or structural conflict (duplicate ids / duplicate credential keys / invalid JSON) |
| `degraded` | Some nodes unusable (e.g. missing credentials), at least one usable |
| `ready` | All declared nodes usable |

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run dev
```
