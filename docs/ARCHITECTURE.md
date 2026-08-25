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

Two concerns are kept strictly apart:

```text
Scheduler / Reliability           →  decides WHICH node gets a request
Protocol / Provider Capability    →  decides HOW the gateway talks to that node
```

`src/protocol/*` never schedules a node; `src/scheduler` and `src/reliability` never parse Responses events or know which wire format an upstream speaks. Streaming event conversion is separate from the HTTP transport.

## Config Layer → Runtime Node

`src/config/nodes.js` merges `TIER{1,2,3}_NODES_CONFIG_01..99` plain variables with `NODE_SECRETS_01..99` secrets and produces Runtime Nodes:

- Tier is derived only from the variable prefix; the node JSON cannot declare it.
- Credential lookup happens here and nowhere else. Downstream modules only ever see `runtimeNode.credential`.
- Structural conflicts (duplicate ids, duplicate credential keys) mark the configuration `invalid`; nodes without credentials are excluded (`degraded` if others remain).
- The result is cached for the isolate lifetime; env vars never change while an isolate is alive.

## Scheduler: dynamic eligible candidate set

There is no static retry index. Before every attempt the eligible set is recomputed from current node state:

```
current tier → valid config → model supported → circuit available
→ cooldown expired → concurrency available → not already attempted (request-scoped Set)
```

then one O(n) pass picks the best candidate: `priority ASC → activeRequests ASC → health (band ≥10) DESC → lastUsedAt ASC (LRU) → avg latency ASC`. Health differences inside the band are treated as noise so the LRU tiebreak can rotate sequential traffic across equal-priority keys — spreading load prevents 429s instead of reacting to them. A failed node can never be retried within the same request, and a node that becomes eligible mid-request is never skipped.

**Rotation vs fallback**: staying in the same tier is *node rotation*; moving to tier N+1 happens only when tier N has no candidate left. Tiers are hard precedence — the higher-preference pool is always exhausted first.

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

Circuit breaker: consecutive-failure state machine (CLOSED → OPEN after 3 counted failures → HALF_OPEN after the open period → single probe → CLOSED on success / OPEN on failure). Only transient failures count; any success resets the counter and closes the circuit — even a 429 during a probe proves liveness. Counters are also time-bounded: a node idle for more than 5 minutes starts fresh, so incidents days apart cannot chain into a trip.

Concurrency slots are claimed in `acquireSlot` (atomic with eligibility checks) and released exactly once on every path via success/failure/neutral outcome recording.

## Streaming boundary (src/stream)

`guard.js` implements the single first-event guard: it consumes the upstream SSE stream until the first valid JSON event (or `[DONE]`, timeout, abort, malformed data) and returns a replayable response. The guard runs on **every** streaming path before any byte reaches the client. After the first event there is no transparent failover — a mid-stream death delivers already-buffered bytes and closes cleanly (the missing completion marker exposes the truncation).

A shared SSE scanner feeds both the guard and the OpenAI→Anthropic transformer so each upstream event is parsed exactly once. Model-name rewriting on passthrough streams skips lines that cannot contain `"model"` and is skipped entirely when logical == upstream model.

## OpenAI Responses protocol (`src/protocol/responses`)

`/v1/responses` is a real Responses surface, not a shim. Because the upstream is a generic chat-completions provider, the module converts in both directions:

- Inbound (`request.js`): Responses request → Chat Completions request. `input` items (message / function_call / function_call_output / reasoning), `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `instructions`, `max_output_tokens` are mapped losslessly. Unsupported host-managed tool types raise a clear 400.
- Outbound (`response.js`): Chat Completions object → Responses response object (message / reasoning / function_call items, usage, status). Reasoning items preserve a `summary` facet and, when the upstream exposes opaque `encrypted_content`, relay it verbatim rather than flattening it into reasoning_text.
- Streaming (`stream.js`): Chat Completions SSE → Responses SSE using the shared scanner, emitting the documented ordered event lifecycle (`response.created` … `response.completed`/`incomplete`/`failed`) with `sequence_number`. `events.js` owns the event framing; `reasoning.js` and `tools.js` own reasoning and function-call fidelity.
- Errors (`events.js` + `index.js`): OpenAI Responses envelope `{ error: { message, type, param, code } }`. Terminal errors (any HTTP error other than 429/503) carry `x-should-retry: false` so clients do not blind-retry a request the gateway already resolved; 429/503 stay retryable via Retry-After. Fields a generic chat-completions upstream cannot represent losslessly (`context_management`, `mcp_servers`, `extra_body`, non-`effort` `output_config.*`) are rejected with the exact field name; `stop_sequences` and `top_k` are converted rather than rejected.

Streaming failover is unchanged: the first-event guard runs on the raw upstream before `response.created` is synthesized, so no failover ever occurs after the first client-visible event.

## Provider Capability / Profile (`src/config/profiles.js`)

A node's `provider` label resolves to a static `profile` descriptor: `protocols` (native vs convert per surface) and capability flags (tools / reasoning / vision / stream) plus supported `reasoning_efforts`. Profiles never hold credentials, circuit state, cooldowns, health, concurrency or tier — those remain on the Runtime Node / Scheduler / Reliability layers. Providers that differ only by `base_url` + key + model name share the default `openai-compatible` profile; only genuine protocol-divergent providers (`anthropic-*`, `openai-*`, `gemini-*`) get a distinct profile. `/v1/models` derives its additive capability metadata from these profiles, never from model-name guesses.

## State boundaries

Health, cooldowns, circuits and counters are isolate-local best-effort. No KV/D1/Durable Objects are used. This means scheduling decisions are per-isolate; that is accepted in exchange for zero-latency, zero-cost state.

## Module map

```text
src/
├─ index.js                  worker entry: counting + top-level error boundary
├─ config/
│  ├─ env.js                 env read helpers
│  ├─ timeouts.js            ALL timeout/cooldown defaults & Retry-After parsing
│  ├─ nodes.js               shard merge → Runtime Node + configuration status
│  ├─ models.js              MODELS_CONFIG (cached)
│  ├─ policies.js            POLICIES_CONFIG: max_attempts (cached)
│  └─ profiles.js            Provider Capability/Profile descriptors (static)
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
│  └─ handler.js             auth, routing, attempt loop
├─ observability/
│  ├─ logger.js, stats.js    counters, client stream accounting
│  └─ status.js              /health /metrics /version /v1/models
└─ dashboard/pages.js        browser pages
```
