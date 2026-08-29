# Configuration

> This document describes the current 1.x configuration schema. In production, deliver Worker text variables and Worker Secrets through the encrypted GitHub runtime configuration package; Cloudflare Dashboard editing is a local/manual recovery path only.

## Production configuration source: GitHub runtime configuration package

The production deployment workflow reads one encrypted GitHub repository secret named `GATEWAY_RUNTIME_CONFIG`. Its schema is shown in [`config/github-runtime.example.json`](../config/github-runtime.example.json):

- `vars` — Worker text variables, including `TIER*_NODES_CONFIG_XX`, `MODELS_CONFIG`, `POLICIES_CONFIG`, and optional runtime parameters.
- `secrets` — Worker Secrets: only `GATEWAY_ACCESS_KEY` and `NODE_SECRETS_01..99`.

Structured values may be written naturally as JSON arrays/objects in the package; the deployment workflow serializes them to Worker environment strings. The deployment bridge enforces the 4.5 KB per-value shard limit and calls the runtime configuration loader before it synchronizes anything to Cloudflare. See [Deployment](DEPLOYMENT.md) for one-time GitHub setup and push-to-`main` deployment.

## Worker Secrets (Wrangler / Cloudflare Dashboard “Secret”)

| Configuration item | Required | Content |
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

## Worker text variables (Cloudflare Dashboard “Text” / JSON variables)

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
- `provider`: a free-form label used for diagnostics and to derive a Provider compatibility Profile. All upstreams are reached through the same OpenAI Chat Completions path today, so every profile reports Chat `native` and Responses/Messages `convert` — no profile claims a false `native` `/v1/messages`, `/v1/responses`, or Gemini endpoint. The profile id is only a compatibility hint for `/v1/models`. The profile never carries credentials, circuit state, cooldowns, health, concurrency or tier — and it is **not** the source of model capability (that is the Model Registry below).
- `models`: object mapping logical → upstream model names. Missing or explicitly-empty `{}` = wildcard (serves every registry model). A filled-but-invalid map (non-string value, bad structure) is a **config error** — the node is excluded with a diagnostic, never silently emptied into a wildcard.
- Unknown node fields (`prioirty`) and unknown `limits` fields (`concurency`) are rejected; invalid `priority` / `limits.concurrency` / `limits.rpm` are rejected with a named diagnostic.
- `limits.concurrency`: integer ≥ 1, default `2`.
- `limits.rpm`: optional per-minute request quota for the key (e.g. `25`). Semantics are controlled by `limits.rpm_mode`:
  - **hard（默认，显式配置了 `rpm` 即生效）** — an isolate-local cap rather than a verified upstream/account limit: within a single Worker isolate the gateway never knowingly exceeds the configured count, an exhausted node is skipped this minute, the tier falls through, and if every candidate is exhausted the client receives `503` + `Retry-After` pointing at the RPM minute boundary.
  - **soft** — the legacy best-effort behavior: exhausted nodes remain last-resort candidates so a lone capped node still serves instead of failing.
- `limits.rpm_mode`: `"hard"`(default) | `"soft"`. Any other value is rejected.

> **Scope of `limits.*` and reliability state**: `limits.concurrency`, `limits.rpm`, cooldowns, circuit/health and RPM counters are **isolate-local** — per Cloudflare Worker isolate, best-effort shaping. They are **not** global hard limits and **not** provider-wide or cluster-accurate quotas. They are reset whenever an isolate restarts and must not be relied on for billing or per-key accounting.

### Optional distributed rate shaping (per-location)

For keys that are rate-limited at the account level you can add a Cloudflare Workers Rate Limiting binding named `QUOTA_RATE_LIMITER` (binding name is what matters; consult your wrangler version's docs for the exact config syntax). When present, every dispatch to a **hard-RPM** node first performs a distributed (per-Cloudflare-location) fixed-window check; a deny rotates to the next candidate without counting a node failure and without consuming any failover budget — it charges neither `max_attempts` nor the tier's attempt slot. Without the binding this is a no-op and only isolate-local shaping applies.

> **Scope caveat**: Cloudflare Rate Limiting is counted per location, permissive and eventually consistent — it is **not** a strict global/account quota and should not be relied on for accurate accounting. Its threshold is fixed at the binding (`limit=N`, `period=60`), so it cannot express a different `limits.rpm` per node; the local hard/soft semantics remain the exact per-node source of truth. Treat it as approximate distributed shaping, and use `limits.rpm` (hard mode) for exact per-node counts.

Concurrency cannot be coordinated globally without Durable Objects, which this project deliberately does not use: `limits.concurrency` stays isolate-local by design.

### Optional token-usage persistence (Cloudflare D1)

The public homepage's 使用情况 card is the only place that needs *durable, cross-isolate* numbers. It is backed by an **optional** Cloudflare D1 binding named `TOKEN_STATS_DB`. This is a **fail-open, non-billing observability** component:

- The gateway runs correctly with **no D1 binding at all** — the binding is not a startup requirement. AI requests, fallback, rate limiting, circuit breaker and streaming are unaffected whether or not D1 is present or healthy.
- Only **hourly UTC aggregates** are stored (one row per `YYYY-MM-DDTHH:00:00Z`), updated by a single atomic `INSERT ... ON CONFLICT(hour) DO UPDATE` UPSERT. No per-request rows, no node/provider/tier/api-key/user/ip dimensions.
- Token counts are only ever the **upstream-reported** usage. Missing usage is recorded as `usage_missing` and is **never estimated** from characters/bytes.
- The homepage’s **模型使用 · 近 7 天** panel renders a compact ranked list with short horizontal comparison bars, each scaled relative to the leading model. It deliberately does not use a donut/ring chart: each row retains its exact Token and request counts, and small differences remain readable.

To enable it, add a D1 binding to the operator config (the shared `wrangler.jsonc` stays minimal — like `QUOTA_RATE_LIMITER`, the binding is added by the operator, not baked into the public template):

```jsonc
"d1_databases": [
  { "binding": "TOKEN_STATS_DB",
    "database_name": "ai-gateway-token-stats",
    "database_id": "<your-d1-database-id>" }
]
```

Create the database and apply **all** migrations in order (both use the free tier):

```bash
npx wrangler d1 create ai-gateway-token-stats
npx wrangler d1 migrations apply ai-gateway-token-stats --remote
# local (optional, uses a local SQLite file):
npx wrangler d1 migrations apply ai-gateway-token-stats --local
```

Migration files (applied in filename order — never modify an already-applied migration, only add the next number):

1. [`migrations/0001_token_usage_hourly.sql`](../migrations/0001_token_usage_hourly.sql) — global hourly aggregate (`token_usage_hourly`).
2. [`migrations/0002_token_usage_model_hourly.sql`](../migrations/0002_token_usage_model_hourly.sql) — per-model hourly aggregate (`token_usage_model_hourly`), used by the homepage's "模型使用 · 近 7 天" panel.

All supported local deployment paths (`npm run deploy`, `scripts/deploy.sh`, and `scripts/deploy.ps1`) apply remote migrations automatically when the `TOKEN_STATS_DB` binding is present, so local deployment is consistent with the GitHub Actions workflow. Migration failure aborts before Worker publication; `npm run check:deploy` remains a local dry-run and never mutates D1.

#### Scheduled cleanup (cron trigger)

The per-model table (`token_usage_model_hourly`) grows at `O(models × hours)`. To prevent unbounded growth, the Worker exports a `scheduled` handler that deletes rows older than 7 days (matching the dashboard's query window). The global `token_usage_hourly` table is **never** pruned — it powers the cumulative KPIs and must retain all historical data.

The shipped `wrangler.jsonc`, generated CI config, and newly generated operator configs enable the cleanup by default:

```jsonc
// wrangler.user.jsonc
"triggers": {
  "crons": ["0 3 * * *"]  // daily at 03:00 UTC
}
```

The cleanup is idempotent and safe to run multiple times. Existing `wrangler.user.jsonc` files created before 1.2.4 should be checked for this trigger; without it, the per-model table retains all rows indefinitely.

#### Streaming usage hint

To capture usage on OpenAI-compatible **streaming** responses (which otherwise only report usage when asked), the gateway adds `stream_options: { include_usage: true }` to the outbound request whenever the request streams and the node's Provider Profile allows it. This never changes what the client receives. It preserves an existing `stream_options` the client sent (spread first, and `include_usage` is only added when absent). Two knobs give fail-safe control without editing any node id:

- `STREAM_INCLUDE_USAGE`: `"auto"` (default, uses each provider profile capability) | `"on"` (force) | `"off"` (never add).
- `STREAM_USAGE_INCLUDE_OFF_PROVIDERS`: a comma-separated list of `provider` labels to opt out of the hint (for an upstream that rejects the field). Non-streaming requests and responses/messages conversions are covered too — the hint is applied to the converted OpenAI-chat outbound body.

> **Scope caveat**: the hourly aggregate and the streaming-usage hint are observability only. They are not billing, not per-key accounting, not quota enforcement. Token persistence is best-effort: high throughput near the free D1 write budget simply stops persisting (the gateway keeps serving); the homepage then shows the numbers that did land.

### Optional

```jsonc
// MODELS_CONFIG (also the Model Registry)
{ "general-air": { "policy": "fast" },
  "code-pro": { "policy": "stable",
                "capabilities": { "tools": true, "reasoning": true, "vision": false, "stream": true },
                "reasoning_efforts": ["low", "medium", "high"] } }

// POLICIES_CONFIG
{ "fast": { "max_attempts": 5 } }
// optional per-tier budget: { "tier1": N, "tier2": N, "tier3": N } (0 disables a tier)
{ "fast": { "max_attempts": 5, "tier_attempts": { "tier1": 3, "tier2": 1, "tier3": 1 } } }
```

The **Model Registry** is the single source of truth for a logical model's capability (`capabilities.tools/reasoning/vision/stream`) and reasoning efforts. Node mapping only says *whether a node can serve the model*; the Provider Profile only says *how to talk to the upstream*. `/v1/models` does not derive capability from the provider profile.

Tier order is fixed: tier-1 → tier-2 → tier-3. A lower tier is used only when the current tier yields no eligible candidate for the request. `max_attempts` (default 5; explicitly configured values must be an integer between 1 and 8 — anything else is rejected at load, never clamped) bounds total attempts per request across all tiers. Each tier additionally has its own attempt budget: by default `max_attempts` is split over currently-dispatchable work — a tier whose candidates are merely deferred (concurrency-saturated or hard-RPM-exhausted) reserves no budget — so every tier that actually holds a dispatchable candidate (model supported, not cooling / circuit-open) gets at least one attempt and the surplus goes to the highest (most-preferred) dispatchable tier — maximizing free/priority resource use while always keeping the paid fallback reachable and never silently starving an intermediate tier. `tier_attempts` explicitly overrides a tier's budget (`0` disables it).

### Recommended multi-key / multi-account layout

```jsonc
// TIER1_NODES_CONFIG_01 — same provider, two accounts, SAME priority:
[
  { "id": "nvidia-01", "base_url": "https://integrate.api.nvidia.com/v1", "priority": 10,
    "models": { "general-air": "deepseek-ai/deepseek-v3.1", "code-pro": "qwen/qwen3-coder-480b" },
    "limits": { "concurrency": 3, "rpm": 40 } },
  { "id": "nvidia-02", "base_url": "https://integrate.api.nvidia.com/v1", "priority": 10,
    "models": { "general-air": "deepseek-ai/deepseek-v3.1", "code-pro": "qwen/qwen3-coder-480b" },
    "limits": { "concurrency": 3, "rpm": 40 } },
  // different provider in the same tier, slightly lower preference:
  { "id": "glm-01", "base_url": "https://open.bigmodel.cn/api/paas/v4", "priority": 20,
    "models": { "general-air": "glm-4.7", "code-max": "glm-4.7" }, "limits": { "concurrency": 2 } }
]

// NODE_SECRETS_01
{ "nvidia-01": "nvapi-...", "nvidia-02": "nvapi-...", "glm-01": "..." }
```

- Same priority within a tier = LRU rotation: sequential traffic spreads across all keys, so the first 429 appears only after the *combined* quota is spent.
- Different priority = strict order; larger values take over only when smaller ones are busy/cooling/circuit-open.
- Keys you want to conserve (paid, shared) belong in a lower tier, not a higher priority number.

### Runtime knobs

| Variable | Default | Range | Meaning |
|----------|---------|-------|---------|
| `MAX_BODY_BYTES` | 20971520 | 1KB–100MB | Request body limit |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 60000 | 5s–600s | Time to upstream response headers |
| `FIRST_EVENT_TIMEOUT_MS` | 120000 | 5s–600s | Streaming first-event guard timeout |
| `STREAM_IDLE_TIMEOUT_MS` | 240000 | 10s–600s | Max gap between stream chunks |
| `RATE_LIMIT_COOLDOWN_MS` | 60000 | 1s–600s | 429 cooldown without Retry-After |
| `AUTH_FAIL_COOLDOWN_MS` | 3600000 | 1min–7d | 401/403 credential cooldown |
| `FAILOVER_BUDGET_MS` | 240000 | 5s–900s | Whole-request failover budget: total wall-clock time spent rotating across nodes for one request |
| `ALLOWED_ORIGIN` | *(unset)* | origin or `*` | CORS is OFF unless set |
| `EXPOSE_UPSTREAM_INFO` | false | | Expose upstream node/provider/tier + per-attempt detail in responses; `false` keeps client responses topology-safe |
| `FAKE_STREAM_PROTECTION` | false | | Convert non-stream requests to streaming upstream + reassemble |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | false | | Allow http:// base_url |
| `ANTHROPIC_COUNT_TOKENS_MODE` | approximate | approximate/disabled | Local token counting. The estimator is script-aware and deliberately conservative: ASCII ≈ chars/4, CJK/Kana ≈ 1 token per character, tool schemas charged denser, images a fixed ~1600-token allowance. It is an approximation, not a tokenizer |
| `ANTHROPIC_REASONING_REQUEST_MODE` | none | none/reasoning_effort/chat_template_kwargs/thinking | Reasoning passthrough style (Anthropic Messages) |
| `RESPONSES_REASONING_MODE` | reasoning_effort | reasoning_effort/chat_template_kwargs/thinking | How `/v1/responses` `reasoning` maps to a chat-completions upstream |
| `LOG_LEVEL` | info | none/error/info/debug | Logging verbosity |
| `PROJECT_REPOSITORY_URL` | — | https URL | Shown on the dashboard |

Removed legacy variables (do not set): `REQUEST_TIMEOUT_MS`, `ANTRHOPIC_MAX_BODY_BYTES`/`ANTHROPIC_MAX_BODY_BYTES`, `CACHE_ENABLED`, `CACHE_MAX_AGE_SEC`, `CACHE_MAX_BODY_BYTES`, `AE_DATASET`, `ALLOW_UNSAFE_PROXY_ROUTES`, `PRIMARY_*`, `FALLBACK_*`, `MODEL_MAPPING`, un-suffixed `TIERx_NODES_CONFIG`.

## Configuration status

Computed at config-load time and exposed on the auth-protected `/health`:

| Status | Condition |
|--------|-----------|
| `unconfigured` | `GATEWAY_ACCESS_KEY` or any `TIER*_NODES_CONFIG_*` missing |
| `invalid` | Config present but zero usable nodes, or structural conflict (duplicate ids / duplicate credential keys / invalid JSON) |
| `degraded` | Some nodes unusable (e.g. missing credentials), at least one usable |
| `ready` | All declared nodes usable |

`ready` is `true` only for `ready`/`degraded`; `invalid`/`unconfigured` refuse service (`/health` returns 503, API requests return 500). `/health` also reports `nodes_total` (declared), `nodes_usable` and `nodes_active` separately.

## /metrics

Auth-protected like `/health`, rendered in Prometheus text format. Gateway-level stream counters:

| Metric | Meaning |
|----------|---------|
| `gateway_stream_started_total` | Streams opened toward upstreams |
| `gateway_stream_completed_total` | Streams that ended with the completion marker |
| `gateway_stream_interrupted_total` | Streams that ended mid-stream; always equals the sum of the three reason counters below |
| `gateway_stream_missing_completion_marker_total` | Clean EOF without the completion marker |
| `gateway_stream_idle_timeout_total` | `STREAM_IDLE_TIMEOUT_MS` elapsed with no new chunk |
| `gateway_stream_reader_error_total` | Upstream reader threw mid-stream |

Client aborts (neutral ends) count only in `gateway_stream_started_total`. Node-level detail (node id, provider, model, duration, bytes) lives in the `/health` endpoints and server logs (`[stream-interrupted]` lines), not in `/metrics`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run dev
```
