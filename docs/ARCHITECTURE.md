# Architecture

## Design goals

One question gates every feature: does it make more upstream quota usable, more reliably, with less Worker CPU, in a more predictable way? If not, it is out of scope.

## Overview

The gateway natively speaks exactly **two** protocol families — OpenAI and Anthropic. Any service offering an OpenAI-compatible or Anthropic-compatible API can join as a node. The gateway does NOT convert between protocols, does NOT route across protocol boundaries, and does not fail over from an OpenAI node to an Anthropic node (or back).

```text
Client (OpenAI / Anthropic SDK)
   ↓  auth (timing-safe), route allowlist, body limits
Request pipeline (src/request/handler.js)
   ↓  route → (protocol, surface): openai chat|responses, anthropic messages
Config Layer (src/config)          ← parses env shards ONCE per isolate
   ↓  Runtime Node { id, tier, provider, protocol, surfaces, baseUrl, credential, priority, models, limits }
Scheduler (src/scheduler)
   ↓  Tier 1: Eligibility → Affinity → P2C; Tier 2/3: existing selector
Reliability (src/reliability)      ← Tier 1 account/model state; legacy Tier 2/3 node state
Transport (src/transport)          ← openai.js / anthropic.js: native path, headers, stream semantics
   ↓
Upstream providers (native endpoint of the SAME protocol + surface)
```

## Responsibility split

```text
Model Registry (src/config/registry.js)   →  logical model, its policy + capabilities
Node (src/config/nodes.js)                →  logical model → upstream model, protocol + surfaces
Transport (src/transport)                 →  HOW to talk to the upstream (path, headers, stream semantics)
Provider quirks (src/config/provider-quirks.js) → known wire-format compatibility differences
Scheduler (src/scheduler)                 →  decides WHICH node gets a request
Reliability (src/reliability)             →  whether a node is currently usable
```

`src/transport/*` never schedules a node; `src/scheduler` and `src/reliability` never parse protocol events or know which wire format an upstream speaks. `provider` is metadata only (dashboard / metrics / diagnostics / quirks) — it never decides the transport. The Model Registry owns model capability; no transport or provider label ever claims it.

## Config Layer → Runtime Node

`src/config/nodes.js` merges `TIER{1,2,3}_NODES_CONFIG_01..99` Worker text variables with `NODE_SECRETS_01..99` Worker Secrets and produces Runtime Nodes:

- Tier is derived only from the variable prefix; the node JSON cannot declare it.
- Credential lookup happens here and nowhere else. Downstream modules only ever see `runtimeNode.credential`.
- `protocol` (`openai` | `anthropic`) decides the wire format, upstream endpoint, auth header and protocol headers. `surfaces` declares which endpoints the node really serves (`openai`: `chat_completions` and/or `responses`; `anthropic`: `messages`); the scheduler hard-filters on both. `provider` is a free-form label for diagnostics only and never influences the transport.
- Legacy migration: a node without `protocol` defaults to `openai` and without `surfaces` to the protocol's default surface, emitting a **deprecated** diagnostic — the node still builds and the gateway is not marked invalid.
- Structural conflicts (duplicate ids, duplicate credential keys) mark the configuration `invalid`; nodes without credentials are excluded (`degraded` if others remain).
- Fail-fast node schema: unknown node/limits fields, invalid `protocol`/`surfaces`/`priority`/`concurrency`/`rpm`, and a filled-but-invalid `models` map are rejected with a named diagnostic (a bad `models` map is **never** silently emptied into a wildcard). Only a missing or explicitly-empty `models` is a wildcard.
- The result is cached for the isolate lifetime; env vars never change while an isolate is alive.

## Scheduler

Protocol, surface, model, and tier are always hard gates. An OpenAI request never reaches an Anthropic node, and Tier 2/3 never enters the Tier 1 scheduler.

### Tier 1: Eligibility → Affinity → P2C

Tier 1 has one deliberately small decision path:

```text
Eligibility → soft session affinity → sample two eligible accounts
→ compare simple scores → real upstream request → passive TTFT/failure update
→ retry within Tier 1 → existing Tier Router → Tier 2 → Tier 3
```

Eligibility is network-free and requires the account to serve the protocol/surface/model, be enabled, be outside account/model cooldown, have isolate-local concurrency and hard-RPM capacity, and not have a known exhausted quota. Cooldown is strict: there is no fail-open selection of a blocked account.

P2C samples two distinct eligible accounts and chooses the lower score; one candidate is selected directly. There is no full-pool performance ordering. The score contains only passive per-`(account, model)` TTFT, capacity-relative current load, recovery/quota factors, a soft affinity factor, and a small UNKNOWN exploration factor. Tier 1 ignores static `priority`, legacy health score, LRU, node-level latency/TTFT, and probe freshness. It therefore does **not** promise the globally fastest account on every request.

The client may supply `x-session-id` (8–128 characters). Because this deployment has no evidence of isolate-sticky session routing, affinity is stored in the required `TIER1_AFFINITY` Cloudflare KV binding with a 30-minute TTL. The raw session ID is SHA-256 hashed before it becomes a key. KV is read once per client request and written only after the first successful Tier 1 request or an approved successful migration; Tier 2/3 success never changes it. Affinity is a `0.85` score multiplier, not a hard binding. Every 10 requests or 5 minutes, the affinity account may be compared with that round's P2C winner; it migrates only when the affinity score is over `1.5×` worse and the winner completes the real request successfully. No shadow request is sent.

Passive TTFT starts at upstream attempt dispatch and ends at the first meaningful model output. OpenAI Chat requires non-empty content/reasoning/tool-call output, Responses requires a non-empty supported output delta, and Anthropic requires non-empty text/thinking/tool-input delta. Headers, heartbeats, lifecycle events, metadata, role-only deltas, empty output, and failed attempts do not create samples. State starts as `ttftEwma=null, sampleCount=0`; the median known TTFT (or a neutral default) is used only during score calculation and is never written back. The first observation is assigned directly; later samples use EWMA alpha `0.25`. One value over `4×` EWMA is clamped, while the second consecutive high value is accepted raw so real degradation becomes visible.

Tier 1 attempts share the request's existing wall-clock deadline and are hard-capped at three. Before a retry, a conservative remaining-time check may exhaust Tier 1 early and hand control back to the Tier Router. Tier 2/3 keep the existing selector, reliability state, per-tier budgets, and fallback behavior.

### Tier 2 / Tier 3

Tier 2 and Tier 3 continue to use the legacy dynamic candidate selector and `node-state.js`: priority, active requests, health band, LRU, latency preference, cooldown, and circuit breaker. They are intentionally not trained by Tier 1 TTFT and never read or write Tier 1 affinity.

**Rotation vs fallback + per-tier budget**: staying in the same tier is rotation; moving to tier N+1 happens only when the current tier yields no candidate or spends its per-tier budget. Tiers remain hard precedence. Budgets are allocated over currently dispatchable tiers, `tier_attempts` can override them, and the global `max_attempts` and `FAILOVER_BUDGET_MS` still cap the whole request. Independently, Tier 1 never exceeds three logical attempts.

**RPM semantics**: `limits.rpm` defaults to **hard** — an exhausted node is not a fallback candidate and, within a single Worker isolate, the gateway never knowingly exceeds the configured quota; full exhaustion yields 503 + Retry-After at the RPM minute boundary. `"rpm_mode":"soft"` restores best-effort behavior. When a `QUOTA_RATE_LIMITER` Rate Limiting binding is bound, hard-RPM dispatches additionally pass a distributed (per-Cloudflare-location) fixed-window check (denied → rotate, no node penalty). That check is approximate and per-location, not a strict global/account quota. Concurrency remains isolate-local shaping.

**Failover budget**: the whole request is bounded by `FAILOVER_BUDGET_MS` (default 240s). Time starts when the gateway receives the request; before each new attempt the remaining budget is checked and live attempt capacity is recomputed from dispatchable nodes constrained by the remaining tier/shared caps. The dispatcher assigns one fair wall-clock slice to the LOGICAL attempt and turns it into an absolute deadline; receiving response headers and waiting for the first SSE event consume that same slice instead of each receiving a fresh allowance. Header and first-event waits remain capped by their configured timeouts (with 20s and 5s helper floors that never extend the absolute deadline). A one-node pool therefore keeps its configured wait, while a stalled HTTP connection or silent HTTP-200 SSE stream cannot starve later candidates. When the budget is exhausted the gateway stops rotating and returns a terminal 504 with an attempt count. Client abort is privileged; after the first client-visible event transparent failover remains unsafe, so an interruption emits one route-specific error event and closes without a success marker.

**Hedged dispatch (reactive per-try hedge)**: when a logical attempt has not committed within `HEDGE_DELAY_MS` (default 6s; `0` disables), ONE twin attempt is launched against the next-best candidate and the two race; the first committed response wins and the loser is aborted. The twin is an extra executioner of the SAME logical attempt, not an attempt of its own: it charges neither `max_attempts` nor the tier budget, and it INHERITS the logical attempt's absolute deadline (no fresh slice — one logical attempt has two executioners but one time budget). Hedging is bounded by `MAX_HEDGES_PER_REQUEST` (default 1) and a hard dispatch ceiling of `max_attempts + max_hedges_per_request` upstream calls, so decoupling the twin from the attempt budget cannot open unbounded fan-out. A loser cancelled only because its peer committed is NEUTRAL — no health penalty, no cooldown, no circuit failure and no `failure_kinds` entry — while a twin that genuinely times out or receives a 5xx on its own is recorded as a real failure. Both hedged sides failing consume exactly one logical attempt, and every failure kind is named precisely: `headers_timeout` (no HTTP status, status=0) vs `first_event_timeout` (HTTP 200 received, no valid SSE event, status=200). Client-visible exhausted responses expose only counts (`attempts` = logical attempts, plus `dispatches` and `hedges`) and the aggregate `failure_kinds` map — never node ids or topology.

## Reliability model (src/reliability)

Tier 1 uses `tier1-state.js`; Tier 2/3 continue using `node-state.js`. The two state systems are intentionally separate.

Tier 1 account scope contains in-flight count, account disable/cooldown, and explicit quota state. Model scope contains disable/cooldown, `normal → cooldown → half_open → disabled` recovery, consecutive failures/outliers/rate limits, and passive TTFT. A 401/403 disables the account; `model_not_found` disables only that account/model pair. An ambiguous 429 defaults to model scope and records `scope_ambiguous_429`, avoiding accidental loss of the same account's other models. `Retry-After` is honored; a missing header uses model-scoped exponential backoff. Ordinary timeout/5xx failures use three-failure hysteresis; an expired cooldown becomes half-open on a real request, requires two successes to return to normal, and one half-open failure immediately re-enters cooldown. There are no active recovery probes.

Streaming holds the Tier 1 in-flight slot after headers, after the first token, and for the complete stream. Completion, cancellation, reader error, or idle timeout releases it through an idempotent token exactly once. Short-lived Tier 1 runtime state is isolate-local and best-effort. Cross-isolate strong consistency is deliberately not added to the hot path; only session affinity uses KV.

Tier 2/3 retain the legacy node-local health, latency, active-request slots, cooldown, and circuit state machine:

Error classification (`classify.js`) is shared. The table below is the retained Tier 2/3 mapping; Tier 1 maps those kinds into the account/model state described above:

| Outcome | Action | Cooldown | Counts toward circuit |
|---|---|---|---|
| 429 (+Retry-After) | rotate | Retry-After clamped [1s, 600s] | no |
| 401/403 | rotate | AUTH_FAIL_COOLDOWN_MS | no |
| 400/413/415/422 | stop | none | no |
| 404 | rotate | 5s | no |
| 5xx, network, headers/first-event timeout | rotate | none | **yes** |
| client abort, hedge-loser cancellation | neutral | none | no |

Tier 2/3 circuit breaker: consecutive-failure state machine (CLOSED → OPEN after 3 counted failures → HALF_OPEN after the open period → single probe → CLOSED on success / OPEN on failure). Only transient failures count; any success resets the counter and closes the circuit. Counters are time-bounded so incidents days apart cannot chain into a trip.

Mid-stream truncation counts as a transient failure (it drives the 3-consecutive circuit counter) and additionally applies a health penalty under the `stream` key (same tier as a network failure), so a node that keeps truncating degrades in candidate ordering before the circuit opens.

Concurrency slots are claimed in `acquireSlot` (atomic with eligibility checks) and released exactly once on every path via success/failure/neutral outcome recording.

All short-lived runtime state (Tier 1 passive TTFT/in-flight/cooldown and Tier 2/3 health/circuit/concurrency/RPM) is **isolate-local** and best-effort; it resets on isolate restart and is not a global or provider-wide quota.

Failed attempts are aggregated into `failure_kinds` (kind counts only, no node ids). The exhausted response derives its terminal status from the dominant kind — `rate_limit` → 429, `headers_timeout`/`first_event_timeout` → 504, otherwise 502 — instead of from whatever the last attempt happened to be, and exposes the aggregate map so operators can tell how a request failed without enabling full topology exposure.

Local Anthropic `count_tokens` is a script-aware conservative approximation (ASCII ≈ chars/4, CJK ≈ 1 token/char, denser for tool JSON, fixed allowance for images), not a tokenizer.

## Streaming boundary (src/stream)

`guard.js` implements the single first-event guard: it consumes the upstream SSE stream until a committing event — with a **per-protocol "first real output" judgment** — or timeout, abort, malformed data, or a JSON **error envelope** (`{"error":{...}}` counts as a failure, so a zero-output HTTP-200 stream still rotates), and returns a replayable response. The two protocol families deliberately do not share one judgment:

- **OpenAI Chat Tier 1** commits only on non-empty content, reasoning, or tool-call output. Tier 2/3 retain the original parseable-event boundary.
- **OpenAI Responses** commits only on `response.*.delta` events — lifecycle events (`response.created`, `output_item.added`, …) are NOT commit points.
- **Anthropic Messages** commits only on native content deltas (`text_delta` / `thinking_delta` / `input_json_delta`) — `message_start`, block start/stop, `ping` and `message_delta` never commit.

The predicates are defined by the transports (`src/transport/openai.js`, `src/transport/anthropic.js`). The guard runs on **every** streaming path before any byte reaches the client; before the commit point the request can still fail over, after it transparent failover is forbidden — a mid-stream death delivers already-buffered bytes and closes cleanly while hidden guard state preserves a reader exception for telemetry. The tracked stream distinguishes `missing_completion_marker` (clean EOF without the marker), `idle_timeout`, and `reader_error`, feeding the gateway stream counters in `/metrics`, and appends at most one protocol-shaped interruption event. A native Responses `response.failed` terminal event is never followed by a duplicate `event: error`; injected interruption errors continue the observed `sequence_number`. Node identity (node, provider, model, duration, bytes, marker seen) is logged server-side only as a `[stream-interrupted]` line.

The shared SSE scanner feeds the guard, the native stream→object assemblers and the tracked passthrough so each SSE line is parsed exactly once. Model-name rewriting on passthrough streams knows where the model lives per protocol (chat: top-level `data.model`; Responses: `data.response.model`; Anthropic: `data.message.model`), skips lines that cannot contain `"model"`, and is skipped entirely when logical == upstream model.

## Transport layer (src/transport) and native protocol paths

Each client surface maps to a (protocol, surface) pair and is forwarded to the **native** upstream endpoint of that same pair — no cross-protocol or cross-surface conversion exists:

```text
Client /v1/chat/completions → OpenAI transport    → upstream /v1/chat/completions
Client /v1/responses        → OpenAI transport    → upstream /v1/responses
Client /v1/messages         → Anthropic transport → upstream /v1/messages
```

`transport/openai.js` owns the OpenAI upstream paths (`OPENAI_SURFACE_PATH`), the `Authorization: Bearer` header shape, and the Responses first-real-output predicate. `transport/anthropic.js` owns the `/v1/messages` path, the native auth header (`x-api-key`, never `Authorization: Bearer`), `anthropic-version` (forwarded or defaulted) and `anthropic-beta` passthrough, and the Anthropic first-real-output predicate. `transport/index.js` dispatches per protocol (`resolveUpstreamPath`, `buildUpstreamHeadersFor`). Client auth material never reaches the upstream for either protocol.

`src/config/provider-quirks.js` holds known wire-format compatibility differences only — e.g. whether `stream_options.include_usage` may be added to a streaming OpenAI-chat request (it never applies to Responses or Anthropic bodies). It decides nothing structural: not the protocol, not the upstream path, not the transport.

Defensive stream↔object helpers per protocol live beside their wire formats (`src/protocol/responses/native-stream.js`, `src/stream/anthropic-native.js`): a streaming upstream + non-stream client assembles the final object; a JSON upstream + streaming client synthesizes a well-formed SSE lifecycle. Both run entirely before the first client-visible byte, so failures still rotate.

## OpenAI Responses protocol (`src/protocol/responses`)

`/v1/responses` is a **native** surface: the client's request is forwarded verbatim (model substituted) to the upstream `/v1/responses` endpoint and the upstream's native Responses event sequence is relayed. There is no Chat Completions conversion anywhere in this path.

- Validation (`index.js`): minimum contract only (`model` + `input`); field-level semantics are the upstream's job, so provider-level features (`mcp_servers`, `tools`, `reasoning`, …) pass through natively.
- Streaming: the guarded native stream is tracked directly (`response.completed`/`incomplete` completion markers, `response.failed` failure marker); the model field is rewritten inline at `response.model`.
- Errors (`events.js`): OpenAI Responses envelope `{ error: { message, type, param, code } }`. Terminal errors (any HTTP error other than 429/503) carry `x-should-retry: false`; 429/503 stay retryable via Retry-After.

## Model Registry (`src/config/registry.js`)

The registry is the single source of truth for a logical model's policy and capability (`capabilities.tools/reasoning/vision/stream`, `reasoning_efforts`), fed from `MODELS_CONFIG`. `/v1/models` enumerates registry models served by at least one node, reports `api_backends` (the `provider` labels, or `apiBackend: "mixed"` when multiple providers serve it) and the union of node `surfaces` — it never fabricates a single backend and never derives capability from a provider label.

## Anthropic protocol (`src/protocol/anthropic.js`)

`/v1/messages` is a **native** surface: the request is forwarded verbatim to the upstream `/v1/messages` endpoint and the upstream's native Anthropic SSE lifecycle (`message_start` … `message_stop`) is relayed. `count_tokens` stays a local approximation. Errors keep the Anthropic envelope `{ type: 'error', error: { type, message } }`. Claude Code compatibility is pinned by the contract tests (text, streaming, thinking blocks, `tool_use`/`tool_result`, `stop_reason`, `anthropic-version`/`anthropic-beta` forwarding, error shapes).

## State boundaries

Health, cooldowns, circuits, concurrency and RPM counters are isolate-local best-effort. No KV/Durable Objects are used, and there is **no D1 on the AI request hot path**. This means scheduling decisions are per-isolate; that is accepted in exchange for zero-latency, zero-cost state. `limits.concurrency`/`limits.rpm` are isolate-local shaping, not global hard limits or provider-wide accurate quotas.

The only durable, cross-isolate state is the **optional** token-usage hourly aggregate: a single Cloudflare D1 binding (`TOKEN_STATS_DB`) written off-path via `ctx.waitUntil()` and read only by the public homepage. It is fail-open — a missing or failing binding never affects request handling, fallback, node health, circuit breaker, scheduler, concurrency counting or stream completion, and it is never a startup requirement. Token counts are upstream-reported usage only; missing usage is never estimated.

## Module map

```text
src/
├─ index.js                  worker entry: counting + top-level error boundary
├─ config/
│  ├─ env.js                 env read helpers
│  ├─ timeouts.js            ALL timeout/cooldown defaults & Retry-After parsing
│  ├─ nodes.js               shard merge → Runtime Node (protocol/surfaces) + status
│  ├─ models.js              MODELS_CONFIG (cached): policy + optional capabilities
│  ├─ registry.js            Model Registry: logical-model capability (defaults)
│  ├─ policies.js            POLICIES_CONFIG: max_attempts + tier_attempts (cached)
│  └─ provider-quirks.js     wire-format compatibility differences (stream_options…)
├─ scheduler/
│  └─ scheduler.js           protocol+surface+model triple filter, tier grouping
├─ reliability/
│  ├─ node-state.js          isolate-local state + circuit state machine
│  └─ classify.js            error classification → action/cooldown/counted
├─ transport/
│  ├─ index.js               protocol dispatch: upstream path + headers
│  ├─ openai.js              OpenAI paths/headers + Responses first-output rule
│  └─ anthropic.js           /v1/messages path, x-api-key headers, first-output rule
├─ protocol/
│  ├─ http.js                CORS, errors, URL join, body reads
│  ├─ openai.js              OpenAI Chat validation + helpers
│  ├─ anthropic.js           Anthropic validation/errors/count_tokens
│  └─ responses/             OpenAI Responses (validation, SSE events, errors,
│                            native stream↔object helpers) — never schedules nodes
├─ stream/
│  ├─ guard.js               first-event guard + shared SSE scanner
│  ├─ anthropic-native.js    Anthropic stream↔object assemble/synthesize
│  ├─ assemble.js            stream → full OpenAI object (fake-stream mode)
│  └─ track.js               stream telemetry + idle-timeout + model rewrite + usage scan
├─ request/
│  ├─ handler.js             orchestration, attempt loop, per-route success paths
│  ├─ auth.js                access-key digest + constant-time comparison
│  ├─ router.js              route allowlist / path normalization
│  └─ errors.js              protocol-shaped errors, Retry-After, topology policy
├─ observability/
│  ├─ logger.js, gateway-stats.mjs          counters, client stream accounting, stream interruption counters
│  ├─ token-usage.mjs                       isolate-local token observability (normalize/record/summarize)
│  ├─ token-usage-store.mjs                 optional D1 hourly aggregation (persist/query/normalizeHour) — fail-open
│  └─ diagnostic-endpoints.mjs              /health /metrics /version /v1/models
└─ dashboard/pages.js        browser pages
```
