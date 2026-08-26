# Architecture

## Design goals

One question gates every feature: does it make more upstream quota usable, more reliably, with less Worker CPU, in a more predictable way? If not, it is out of scope.

## Overview

```text
Client (OpenAI / Anthropic SDK)
   ↓  auth (timing-safe), route allowlist, body limits
Request pipeline (src/request/handler.js)
   ↓
Config Layer (src/config)          ← parses env shards ONCE per isolate
   ↓  Runtime Node { id, tier, provider, baseUrl, credential, priority, models, limits, profile }
Scheduler (src/scheduler)
   ↓  dynamic eligible candidate set, recomputed before EVERY attempt
Reliability (src/reliability)      ← node-local state: cooldowns, circuit, health
Protocol / Stream (src/protocol, src/stream)
   ↓
Upstream providers
```

## Responsibility split

```text
Model Registry (src/config/registry.js)   →  logical model, its policy + capabilities
Node (src/config/nodes.js)                →  logical model → upstream model
Provider / Transport (src/config/profiles.js, src/protocol)  →  HOW to talk to the upstream
Scheduler (src/scheduler)                 →  decides WHICH node gets a request
Reliability (src/reliability)             →  whether a node is currently usable
```

`src/protocol/*` never schedules a node; `src/scheduler` and `src/reliability` never parse Responses events or know which wire format an upstream speaks. Streaming event conversion is separate from the HTTP transport. The Model Registry owns model capability; the Provider Profile never claims it.

## Config Layer → Runtime Node

`src/config/nodes.js` merges `TIER{1,2,3}_NODES_CONFIG_01..99` plain variables with `NODE_SECRETS_01..99` secrets and produces Runtime Nodes:

- Tier is derived only from the variable prefix; the node JSON cannot declare it.
- Credential lookup happens here and nowhere else. Downstream modules only ever see `runtimeNode.credential`.
- Structural conflicts (duplicate ids, duplicate credential keys) mark the configuration `invalid`; nodes without credentials are excluded (`degraded` if others remain).
- Fail-fast node schema: unknown node/limits fields, invalid `priority`/`concurrency`/`rpm`, and a filled-but-invalid `models` map are rejected with a named diagnostic (a bad `models` map is **never** silently emptied into a wildcard). Only a missing or explicitly-empty `models` is a wildcard.
- The result is cached for the isolate lifetime; env vars never change while an isolate is alive.

## Scheduler: dynamic eligible candidate set

There is no static retry index. Before every attempt the eligible set is recomputed from current node state:

```
current tier → valid config → model supported → circuit available
→ cooldown expired → concurrency available → not already attempted (request-scoped Set)
```

then one O(n) pass picks the best candidate: `priority ASC → activeRequests ASC → health (band ≥10) DESC → lastUsedAt ASC (LRU) → avg latency ASC`. Health differences inside the band are treated as noise so the LRU tiebreak can rotate sequential traffic across equal-priority keys — spreading load prevents 429s instead of reacting to them. A failed node can never be retried within the same request, and a node that becomes eligible mid-request is never skipped.

**Rotation vs fallback**: staying in the same tier is *node rotation*; moving to tier N+1 happens only when tier N has no candidate left. Tiers are hard precedence — the higher-preference pool is always exhausted first.

**RPM semantics**: `limits.rpm` defaults to **hard** — an exhausted node is not a fallback candidate and the gateway never knowingly exceeds the configured quota; full exhaustion yields 503 + Retry-After at the RPM minute boundary. `"rpm_mode":"soft"` restores best-effort behavior. When a `QUOTA_RATE_LIMITER` Rate Limiting binding is bound, hard-RPM dispatches additionally pass a real cluster-wide check (denied → rotate, no node penalty). Concurrency remains isolate-local shaping.

**Failover budget**: the whole request is bounded by `FAILOVER_BUDGET_MS` (default 180s). Time starts when the gateway receives the request; before each new attempt the remaining budget is checked and the attempt's own headers/first-event timeout is capped to `min(configured, remaining)`. When the budget is exhausted the gateway stops rotating and returns a terminal 504 with an attempt count instead of burning `headersTimeout × maxAttempts` (~600s worst case). Client abort is privileged, and streaming never fails over after the first client-visible event (first-event-before still rotes within budget).

## Reliability model (src/reliability)

All node runtime state lives in one isolate-local Map (`node-state.js`) — health score, EWMA latency, active-request slots, cooldown window, and the circuit state machine.

Error classification (`classify.js`) maps every upstream outcome to exactly one action:

| Outcome | Action | Cooldown | Counts toward circuit |
|---|---|---|---|
| 429 (+Retry-After) | rotate | Retry-After clamped [1s, 600s] | no |
| 401/403 | rotate | AUTH_FAIL_COOLDOWN_MS | no |
| 400/413/415/422 | stop | none | no |
| 404 | rotate | 5s | no |
| 5xx, network, headers timeout | rotate | none | **yes** |
| client abort | neutral | none | no |

Circuit breaker: consecutive-failure state machine (CLOSED → OPEN after 3 counted failures → HALF_OPEN after the open period → single probe → CLOSED on success / OPEN on failure). Only transient failures count; any success resets the counter and closes the circuit. Probe completion is centralized: a half-open probe ending in 429/401/403/404, client abort, or any neutral end is *recovered* (never left `probeInFlight=true`), closing the circuit and preserving any node-local cooldown — the node becomes schedulable again. Counters are also time-bounded: a node idle for more than 5 minutes starts fresh, so incidents days apart cannot chain into a trip.

Concurrency slots are claimed in `acquireSlot` (atomic with eligibility checks) and released exactly once on every path via success/failure/neutral outcome recording.

All node-runtime state (health, EWMA latency, cooldowns, circuit, concurrency, RPM counters) is **isolate-local** and best-effort; it is shared per worker isolate only, resets on restart, and is not a global or provider-wide quota.

## Streaming boundary (src/stream)

`guard.js` implements the single first-event guard: it consumes the upstream SSE stream until the first valid JSON event (or `[DONE]`, timeout, abort, malformed data, or a JSON **error envelope** — `{"error":{...}}` counts as a failure so a zero-output HTTP-200 stream still rotates) and returns a replayable response. The guard runs on **every** streaming path before any byte reaches the client. After the first event there is no transparent failover — a mid-stream death delivers already-buffered bytes and closes cleanly (the missing completion marker exposes the truncation).

A shared SSE scanner feeds both the guard and the OpenAI→Anthropic transformer so each upstream event is parsed exactly once. Model-name rewriting on passthrough streams skips lines that cannot contain `"model"` and is skipped entirely when logical == upstream model.

## OpenAI Responses protocol (`src/protocol/responses`)

`/v1/responses` is a real Responses surface, not a shim. Because the upstream is a generic chat-completions provider, the module converts in both directions:

- Inbound (`request.js`): Responses request → Chat Completions request. `input` items (message / function_call / function_call_output / reasoning), `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `instructions`, `max_output_tokens` are mapped losslessly. Unsupported host-managed tool types raise a clear 400.
- Outbound (`response.js`): Chat Completions object → Responses response object (message / reasoning / function_call items, usage, status). Reasoning items preserve a `summary` facet and, when the upstream exposes opaque `encrypted_content`, relay it verbatim rather than flattening it into reasoning_text.
- Streaming (`stream.js`): Chat Completions SSE → Responses SSE using the shared scanner, emitting the documented ordered event lifecycle (`response.created` … `response.completed`/`incomplete`/`failed`) with `sequence_number`. `events.js` owns the event framing; `reasoning.js` and `tools.js` own reasoning and function-call fidelity.
- Errors (`events.js` + `index.js`): OpenAI Responses envelope `{ error: { message, type, param, code } }`. Terminal errors (any HTTP error other than 429/503) carry `x-should-retry: false` so clients do not blind-retry a request the gateway already resolved; 429/503 stay retryable via Retry-After. Fields a generic chat-completions upstream cannot represent losslessly (`context_management`, `mcp_servers`, `extra_body`, non-`effort` `output_config.*`) are rejected with the exact field name; `stop_sequences` and `top_k` are converted rather than rejected.

Streaming failover is unchanged: the first-event guard runs on the raw upstream before `response.created` is synthesized, so no failover ever occurs after the first client-visible event.

## Provider compatibility profile (`src/config/profiles.js`)

A node's `provider` label resolves to a static, conservative compatibility descriptor. Because every upstream is genuinely reached through the same OpenAI Chat Completions wire format today, every profile reports `chat_completions: 'native'` and `responses`/`messages: 'convert'` — no profile claims a false native `/v1/messages`, `/v1/responses`, or Gemini endpoint. The profile `id` is a hint used only to label a backend in `/v1/models`. Profiles never hold credentials, circuit state, cooldowns, health, concurrency, tier, or model capability — model capability is owned by the Model Registry. A future `TransportAdapter` (openai-chat / anthropic / openai-responses / gemini) is deliberately not built in this release.

## Model Registry (`src/config/registry.js`)

The registry is the single source of truth for a logical model's policy and capability (`capabilities.tools/reasoning/vision/stream`, `reasoning_efforts`), fed from `MODELS_CONFIG`. `/v1/models` enumerates registry models served by at least one node and reports `api_backends` (or `apiBackend: "mixed"` when multiple backends serve it) — it never fabricates a single backend and never derives capability from a provider profile.

## State boundaries

Health, cooldowns, circuits, concurrency and RPM counters are isolate-local best-effort. No KV/D1/Durable Objects are used. This means scheduling decisions are per-isolate; that is accepted in exchange for zero-latency, zero-cost state. `limits.concurrency`/`limits.rpm` are isolate-local shaping, not global hard limits or provider-wide accurate quotas.

## Module map

```text
src/
├─ index.js                  worker entry: counting + top-level error boundary
├─ config/
│  ├─ env.js                 env read helpers
│  ├─ timeouts.js            ALL timeout/cooldown defaults & Retry-After parsing
│  ├─ nodes.js               shard merge → Runtime Node + configuration status
│  ├─ models.js              MODELS_CONFIG (cached): policy + optional capabilities
│  ├─ registry.js            Model Registry: logical-model capability (defaults)
│  ├─ policies.js            POLICIES_CONFIG: max_attempts (cached)
│  └─ profiles.js            Provider compatibility descriptors (static, honest)
├─ scheduler/
│  └─ scheduler.js           dynamic candidate selection, tier grouping
├─ reliability/
│  ├─ node-state.js          isolate-local state + circuit state machine
│  └─ classify.js            error classification → action/cooldown/counted
├─ protocol/
│  ├─ http.js                CORS, errors, header allowlist, URL join, body reads
│  ├─ openai.js              OpenAI Chat validation + helpers
│  ├─ anthropic.js           Anthropic validation/errors/count_tokens
│  ├─ convert.js             Anthropic↔OpenAI non-stream conversions
│  └─ responses/             OpenAI Responses protocol (request/response/stream/
│                            events/reasoning/tools/index) — never schedules nodes
├─ stream/
│  ├─ guard.js               first-event guard + shared SSE scanner
│  ├─ transform.js           OpenAI SSE → Anthropic SSE
│  ├─ assemble.js            stream → full OpenAI object (fake-stream mode)
│  └─ track.js               idle-timeout enforcement + node outcome tracking
├─ request/
│  ├─ handler.js             orchestration, attempt loop, per-route success paths
│  ├─ auth.js                access-key digest + constant-time comparison
│  ├─ router.js              route allowlist / path normalization
│  └─ errors.js              protocol-shaped errors, Retry-After, topology policy
├─ observability/
│  ├─ logger.js, stats.js    counters, client stream accounting
│  └─ status.js              /health /metrics /version /v1/models
└─ dashboard/pages.js        browser pages
```
