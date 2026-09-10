# Troubleshooting

Start with evidence from the failing boundary: configuration validation, CI job/step, `/version` build identity, sanitized gateway logs, and the aggregated `failure_kinds`. Do not rotate or rewrite unrelated configuration until the failing layer is identified.

## Configuration failures

### Gateway is `unconfigured`

Check that:

- at least one `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` Secret is configured;
- its matching `GATEWAY_ACCESS_MODELS_<GROUP>` Variable is present and non-empty;
- at least one `TIER{1,2,3}_NODES_CONFIG_XX` Variable exists;
- usable nodes have credentials in a `TIER{1,2,3}_NODES_SECRETS_XX` Secret for the same tier.

A group key with an empty model allowlist intentionally grants zero models.

### `No TIER{1,2,3}_NODES_CONFIG_XX Variable is configured`

Add at least one valid tier config shard containing a JSON array of nodes. The suffix is only a shard number.

### Missing node credential

Credentials bind by Tier + node id. They do not need to be in a Secret shard with the same suffix as the Config shard.

Example:

```text
TIER1_NODES_CONFIG_03 contains node "nvidia-01"
TIER1_NODES_SECRETS_01 may contain {"nvidia-01":"..."}
```

If the tier differs, the credential is invalid for that node.

### `MODELS_CONFIG` / `POLICIES_CONFIG` invalid

These auxiliary configs are validated fail-fast. Check malformed JSON, unknown fields, invalid values, and model→policy references to policy names that do not exist.

Use:

```bash
npm run config:check
npm run validate:merge
```

## Deployment failures

### Preflight fails

Use the exact missing Variable/Secret named by the job. Do not add unrelated placeholders merely to make preflight continue.

### D1 migration fails

The Worker is not deployed after a required migration failure. Inspect the migration error first; do not bypass migration ordering.

### Worker deploy succeeds but verification fails

The workflow attempts Worker rollback. Check the `Verify deployed gateway`, rollback, and rollback-verification steps separately.

If rollback verification also fails, the previous Worker may not be healthy or external configuration/upstream state may have changed. Stop automatic retries and inspect the deployed build/configuration evidence.

### Docs-only change did not deploy

This is expected when the triggering `main` commit changes only Markdown files and/or `docs/**`. The deploy gate intentionally skips Worker deployment for documentation-only changes.

## Runtime HTTP failures

### 400 / other client-class 4xx

The current failure taxonomy treats terminal request-invalid 4xx as `client` and stops the logical request. The gateway does not currently claim provider-specific 400 compatibility classification and automatic rotation for every such error.

Check:

- whether the selected upstream actually supports the request field;
- whether the request reached a native or converted fallback path;
- structured-output/tool fields and provider wire compatibility;
- sanitized upstream error text where available.

Do not assume a 400 means the key itself is unhealthy.

### 429 Too Many Requests

Check:

- node `limits.rpm` / `rpm_mode`;
- current concurrency pressure;
- `Retry-After` if the provider sends it;
- whether the rate limit is model-scoped or account-scoped;
- whether multiple Worker isolates/PoPs are sharing the same upstream key;
- optional Cloudflare distributed rate-limiting binding status.

Tier 1 uses smooth isolate-local RPM admission, scoped cooldown/backoff, recovery gating, and heat protection. These controls reduce local hot spots but do not create a globally exact provider quota.

### 502 Bad Gateway

Use `failure_kinds` and attempt diagnostics to identify whether the dominant issue is:

- `server`
- `network`
- `headers_timeout`
- `first_event_timeout`
- `stream_interrupted`
- `model_missing`
- `endpoint_not_found`
- conversion failure / unsupported fallback semantics

A converted fallback still returns the original client's error envelope.

### 503 Service Unavailable

Common causes:

- gateway configuration is invalid/unconfigured;
- all eligible nodes are temporarily unavailable;
- all hard-RPM capacity is exhausted;
- all matching protocol/surface/model candidates are blocked.

Use authenticated `/health` and sanitized runtime diagnostics.

### 504 Gateway Timeout

The request-wide `FAILOVER_BUDGET_MS` was exhausted or no safe attempt remained within the wall-clock budget. Inspect upstream headers/first-event latency and the number of attempted nodes before increasing the budget.

## Model problems

### Model not listed or unavailable

Check the logical model name against node `models` mappings and optional `MODELS_CONFIG`. Provider-facing model ids may differ from the gateway's logical model aliases.

A model-shaped upstream 404 uses a short upstream-model-specific cooldown; it should not permanently poison the logical alias after remapping.

### Claude Code / Anthropic Messages fallback problem

Check whether the model has an Anthropic native node first. If native nodes are exhausted and fallback is enabled, the request may convert to OpenAI Chat.

The conversion bridge is intentionally not full Anthropic semantic emulation. Features such as thinking history/control, context-management controls, provider-native tools, and some tool hints may be degraded or rejected. Debug conversion diagnostics expose fixed categories without request content.

### OpenAI Responses problem

Confirm:

- node `protocol` is `openai`;
- `surfaces` contains `responses`;
- the upstream actually supports `/v1/responses`.

Responses is Native Only. There is no Responses→Chat or Responses→Messages conversion fallback.

### Structured output fallback

The conversion strategy is conservative:

- positive native capability evidence can use native JSON Schema;
- synthetic Tool mode additionally needs a response-side unwrap adapter;
- unknown target capability uses Prompt emulation.

The current generic runtime fallback path therefore defaults unknown targets to Prompt rather than forcing an unsupported `response_format`.

## Tier 1 routing diagnosis

A fast key is not guaranteed to receive most traffic. Tier 1 deliberately balances TTFT with current local pressure.

If a previously preferred affinity key receives less traffic, check whether:

- its RPM headroom is low;
- its concurrency is elevated;
- its affinity advantage has decayed toward neutral;
- it is in cooldown/recovery/half-open state;
- hedge spare-capacity gating excluded it from optional twin work.

This is expected heat-protection behavior and does not by itself mean the key is failing.

## Streaming problems

### Headers timeout

No upstream response headers arrived before `UPSTREAM_HEADERS_TIMEOUT_MS`. Check network/provider responsiveness.

### First-event timeout

Headers arrived but no meaningful protocol-specific output appeared before `FIRST_EVENT_TIMEOUT_MS`. Lifecycle-only SSE events do not necessarily commit the response.

### Stream interruption

A stream can commit successfully and later truncate. After commit, the gateway does not transparently replay the request to another provider because duplicate partial output would be unsafe.

## Safe evidence collection

Never include live credentials, full authorization headers, private upstream URLs, prompts/request bodies, or user data in an Issue or public log sample. See [SECURITY.md](../../SECURITY.md).
