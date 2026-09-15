# Reliability model

ai-gateway separates Tier 1 adaptive account/model state from the Tier 2/3 node-state system. Both are short-lived best-effort runtime state unless an explicitly documented Cloudflare persistence primitive is involved.

## Tier 1 state

Tier 1 state is isolate-local and deliberately scoped:

- **Account scope** — in-flight count, account cooldown, rate-limit recovery state, and account health.
- **Model scope** — TTFT EWMA, failure/cooldown/half-open state, and recovery state.
- **Upstream-model scope** — short cooldown for provider-facing model-missing responses so a logical alias remap does not inherit stale 404 state.
- **Provider + key-slot scope** — adaptive 429 cooldown for one configured credential. The runtime node id is the non-secret key-slot identity; raw credentials are never stored in the adaptive state key.
- **Provider + upstream-model scope** — short-lived distinct-key 429 evidence used only as a soft ranking signal when several independent credentials hit the same provider-facing model at once.

An isolate restart clears this adaptive state. The gateway does not claim provider-wide state consistency.

## Capacity signals

Provider capacity is learned from observed runtime evidence. The node schema has no `limits`, node RPM, or guessed per-node concurrency fields. The removed `limits` field is a hard schema boundary: any node that still contains it is invalid configuration and is rejected rather than interpreted. Tier 1 also has no hard concurrency ceiling by default; policy `max_in_flight` is an optional isolate-local operator guard for a known per-account contract.

Routing uses signals the gateway can actually observe:

- live in-flight work is a **soft** ranking signal by default, never a guessed hard ceiling;
- an explicit positive `max_in_flight` may hard-limit Tier 1 local admission for that policy; unset, `0`, or `null` leaves admission uncapped;
- real 429 responses create key-local adaptive cooldown and recovery state;
- provider-model 429 evidence adds bounded soft heat when several independent keys hit the same shared capacity limit;
- TTFT, affinity, circuit state, and recent transient failures influence ranking and recovery;
- optional hedge work is suppressed before primary traffic when live pressure is already high.

`max_in_flight` is deliberately not described as Provider-global capacity: multiple Cloudflare isolates can serve the same account independently. It is a local safety override, not a replacement for adaptive 429/cooldown learning.

`GATEWAY_KEY_RPM` is separate. It protects client gateway access keys; it is not Provider/Node capacity configuration.

## 429 handling

429 is a temporary capacity signal. Tier 1 keeps the remaining credential pool available while the affected key learns its own recovery interval.

For a `(provider, key-slot)` without a stronger explicit recovery signal, the adaptive ladder is:

```text
15s -> 30s -> 1m -> 2m -> 5m -> 15m -> 30m -> 60m
```

Tier 1 behavior:

- adaptive cooldown is scoped strictly to `(provider, key-slot)`; one key never cools an entire Provider or logical model;
- escalation occurs only when a recovery request still receives 429 after the previous cooldown expired;
- extra 429 responses from requests already in flight during the same cooldown do not advance the stage or restart the timer;
- an explicit upstream `Retry-After` is a minimum floor: it may extend the current cooldown but never shorten the learned adaptive stage;
- a 429 does not create a logical-model-wide cooldown; other keys serving the same logical model remain eligible;
- one or two distinct keys hitting 429 do not change provider-model ranking;
- three or more distinct keys hitting 429 for the same `(provider, upstream model)` within the evidence window add only a soft cohort penalty; remaining keys stay eligible;
- after cooldown, the first real admission is the controlled recovery request for that key;
- a real successful recovery clears the corresponding 429 state and resets the adaptive ladder;
- while one key is blocked, routing rotates to other eligible capacity.

When every key serving a logical model is temporarily cooling, the gateway reports the earliest real recovery time. No model-wide lockout is added on top of key-local cooldowns.

Success rate is not used as a positive routing reward. Recovery is driven by direct failure/rate-limit evidence and real subsequent requests.

## Heat protection

Tier 1 heat is deliberately soft and bounded by default:

- live in-flight pressure can weaken affinity and demote a busy candidate but does not hard-block primary traffic unless the operator explicitly configured `max_in_flight`;
- a Tier 1 hedge candidate must have concurrency pressure `< 0.75`;
- provider-model 429 evidence window: `90s`;
- 1–2 distinct rate-limited keys: factor `1.00`;
- 3 distinct rate-limited keys: factor `1.15`;
- 4+ distinct rate-limited keys: factor `1.35`;
- repeated 429s from the same key count once in the evidence window;
- each real success removes at most one recent distinct-key 429 observation.

Provider-model heat is keyed by the provider-facing model, not the gateway logical alias. It never changes eligibility, attempt budgets, account cooldowns, affinity storage, or Tier 2/3 behavior. If a heated cohort is the only usable capacity, Tier 1 still dispatches to it unless an explicit local admission ceiling is occupied.

## Passive TTFT

TTFT is recorded per `(account, logical model)` from a real upstream attempt to the first meaningful model output.

- initial state is unobserved;
- first observation initializes the value;
- subsequent observations use EWMA alpha `0.25`;
- one extreme sample is bounded relative to the current EWMA, while consecutive extreme samples may expose persistent degradation;
- there are no active background probes.

A hedge loser cancelled because its peer already committed is neutral and must not poison TTFT or failure state.

## Cooldown and half-open recovery

Transient timeout/server failures use conservative circuit recovery. Rate-limit recovery uses the separate provider+key adaptive cooldown described above.

- transient timeout/server failures can accumulate toward circuit opening;
- an expired circuit/cooldown is reconsidered only when a real request evaluates the node/model;
- half-open admits a constrained real probe;
- success restores normal circuit state;
- a half-open counted failure reopens the circuit;
- 429 recovery uses key-local adaptive cooldown rather than the transient-failure circuit backoff.

Authentication failures use account-scoped cooldown so a bad credential is isolated without disabling unrelated keys.

## Failure classification

`src/reliability/classify.ts` owns the closed failure vocabulary. Consumers use the exported classification helpers/constants rather than inventing new failure strings.

| Kind | Typical cause | Request action | Reliability effect |
| --- | --- | --- | --- |
| `rate_limit` | HTTP 429 | rotate / key-local cooldown | not circuit-counted |
| `auth` | HTTP 401/403 | rotate / credential cooldown | not circuit-counted |
| `client` | request-invalid 4xx | stop | neutral to upstream reliability |
| `model_missing` | model-shaped 404 | rotate / model mapping cooldown | not circuit-counted |
| `endpoint_not_found` | non-model 404 | rotate / short node cooldown | not circuit-counted |
| `server` | upstream 5xx and selected retryable statuses | rotate | circuit-counted |
| `network` | network failure | rotate | circuit-counted |
| `headers_timeout` | no upstream response headers in time | rotate | circuit-counted |
| `first_event_timeout` | headers received but no meaningful first output | rotate | circuit-counted |
| `stream_interrupted` | committed stream truncates or misses completion semantics | record interruption | circuit-counted |
| `client_abort` | client cancellation | stop/neutral | neutral |
| `invalid_base_url` | invalid upstream URL before dispatch | rotate without budget charge | neutral/non-circuit |
| `upstream_200_non_json_body` | HTTP 200 with invalid protocol body | rotate / short cooldown | circuit-counted |
| `cancelled_after_peer_commit` | hedge loser cancelled after winner commits | neutral | neutral |
| `unknown` | guarded catch-all | rotate according to caller | conservative |

Client-class 4xx stop the logical request. The gateway does not assume every provider-specific 400 is a compatibility failure that can safely be retried elsewhere.

## Tier 2/3

Tier 2/3 use `node-state.ts` for active requests, health/circuit state, cooldown, and selection inputs. Active requests are a soft ranking signal. There is no node-level RPM or configured concurrency admission gate.

## Model-family attempt budget

`max_attempts` is a request-wide **hard ceiling**. Model-family fallback shares that budget and never raises it internally.

For a three-member family, first-round allocation widens before it deepens:

```text
max_attempts=1  requested only
max_attempts=2  requested + first sibling
max_attempts=3  1 / 1 / 1
max_attempts=4  2 / 1 / 1
max_attempts=5  3 / 1 / 1
max_attempts>=6 3 / 2 / 1, then bounded re-checks only from unused budget
```

`Air` follows the same hard ceiling across the one-way `Air -> Pro -> Max -> Ultra` chain. Family fallback candidates are also intersected with the authenticated Gateway Key model scope; internal fallback cannot widen the caller's authorization.

Every native attempt, protocol fallback, family fallback, and bounded re-check shares the same logical-attempt counter and whole-request wall-clock budget. When such a bounded family plan ends after only transient failures, the retryable 503 means the **attempt budget** was exhausted; it does not prove that every compatible account in the deployment was tested or unavailable.

## Timeout budget

`FAILOVER_BUDGET_MS` is the request-wide wall-clock ceiling for transparent recovery. A policy-level `first_event_timeout_ms` cannot exceed that request budget. Per-attempt header and first-event waits are always bounded by the remaining request and attempt deadlines.

This means a policy cannot claim a 120-second first-event wait while the whole request is configured to stop after 60 seconds; invalid combinations are rejected instead of silently behaving differently from configuration.

## Streaming lifecycle

The first-event guard defines the transparent-failover boundary:

- before meaningful model output commits, a failed attempt may rotate within the shared request budget;
- role-only, lifecycle-only, or empty deltas are not meaningful output;
- after meaningful output commits, transparent replay/failover is unsafe and is not attempted.

Tier 1 keeps its in-flight slot through headers, first output, and the active stream. Completion, cancellation, reader error, or idle timeout releases it exactly once. Client-level `activeRequests` is incremented once at the outer request boundary; stream start does not increment it again.

Commit semantics remain protocol-specific; see [protocol-model.md](protocol-model.md).

## Protocol fallback safety

Cross-protocol fallback remains limited to OpenAI Chat Completions <-> Anthropic Messages. OpenAI Responses is native-only.

Conversion fidelity is not treated as binary success/failure. `exact` and `portable` conversions may proceed. A degraded conversion may proceed only when the loss is cosmetic or explicitly safe. The fallback is rejected before dispatch when conversion would drop high-risk semantic state such as provider-native tool state/history, thinking history, context-management semantics, or tool-result error meaning.

This favors a retryable failure over an HTTP-success response whose meaning materially changed in transit.

## Circuit behavior

Transient failures drive the circuit/cooldown model; rate limits, auth failures, client errors, model mapping errors, and hedge race losses are distinct states.

The design intentionally distinguishes “this credential is temporarily limited”, “this model mapping is missing”, “this endpoint is bad”, and “this upstream is transiently failing”. Collapsing those into one generic failure counter would cause unnecessary pool loss.

## Coordination boundary

Global concurrency coordination is not implemented. Adaptive 429 recovery, provider-model heat, and optional `max_in_flight` admission are isolate-local. Adding Durable Objects or another strong coordination layer requires production evidence that cross-isolate recovery collisions materially harm reliability enough to justify the latency and complexity.

## Observability boundary

D1 token-usage persistence and Public Model Status are observational. Historical usage, success rate, and public dashboard state do not feed back into candidate scoring.
