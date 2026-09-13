# Reliability model

ai-gateway separates Tier 1 adaptive account/model state from the Tier 2/3 node-state system. Both are short-lived best-effort runtime state unless an explicitly documented Cloudflare persistence primitive is involved.

## Tier 1 state

Tier 1 state is isolate-local and scoped deliberately:

- **Account scope** — in-flight count, account cooldown, consecutive account-level rate limits, rate-limit recovery gate, explicit quota state.
- **Model scope** — TTFT EWMA, failure/cooldown/half-open state, explicitly model-scoped rate limits/outliers, recovery gate.
- **Upstream-model scope** — short cooldown for provider-facing model-missing responses so a logical alias remap does not inherit stale 404 state.
- **Provider + key-slot scope** — adaptive 429 cooldown for one configured credential. A runtime node id is the non-secret key-slot identity; raw credentials are never stored in the adaptive state key.
- **Provider + upstream-model scope** — short-lived distinct-key 429 evidence used only as a soft ranking signal when several independent credentials hit the same provider-facing model at once.

An isolate restart clears this adaptive state. The gateway does not claim provider-wide state consistency.

## Capacity signals

Active node capacity is not defined by operator-guessed `limits.concurrency` or `limits.rpm` values. The configuration parser accepts syntactically valid legacy `limits` only as migration compatibility and emits a deprecation diagnostic; those values are not the production capacity model.

Routing reacts to evidence the gateway can actually observe:

- live in-flight work is a **soft** ranking signal rather than a hard guessed ceiling;
- real 429 responses create key-local cooldown and recovery state;
- provider-model 429 evidence adds bounded soft heat when several independent keys hit the same shared capacity limit;
- TTFT, affinity, circuit state and recent transient failures influence ranking/recovery;
- optional hedge work is suppressed before primary traffic when live pressure is already high.

`GATEWAY_KEY_RPM` is separate. It protects client gateway access keys and is not a guessed Provider/Node quota.

## 429 handling

429 is a temporary capacity signal. Tier 1 keeps the remaining credential pool available while the affected key learns its own recovery interval.

For a `(provider, key-slot)` without a usable explicit recovery signal, the adaptive ladder is:

```text
15s -> 30s -> 1m -> 2m -> 5m -> 15m -> 30m -> 60m
```

Tier 1 behavior:

- adaptive cooldown state is strictly scoped to `(provider, key-slot)`; one key never cools an entire Provider or logical model;
- escalation occurs only when a recovery request still receives 429 **after the previous cooldown has expired**;
- extra 429 responses from requests already in flight during the same cooldown do not advance the stage or restart the local timer;
- an explicit upstream `Retry-After` is a **minimum floor**: it may extend the current cooldown but never shorten the learned adaptive stage;
- an ambiguous provider 429 defaults to the account/key scope because a runtime node represents one credential; explicit model-scoped evidence remains model-scoped for the Tier 1 eligibility state;
- a 429 never creates a logical-model-wide cooldown: other keys serving the same logical model remain eligible;
- one or two distinct keys hitting 429 do not change provider-model ranking;
- three or more distinct keys hitting 429 for the same `(provider, upstream model)` within the short evidence window add only a soft cohort penalty; remaining keys stay eligible;
- after cooldown, the first real admission is a controlled recovery probe; the same scope is gated immediately to suppress a local recovery stampede;
- the normal recovery gate is at least 5 seconds; legacy migration-only RPM metadata may lengthen that compatibility gate but is not an active capacity configuration surface;
- a real successful recovery clears the corresponding consecutive-429 state and resets the adaptive `(provider, key-slot)` ladder;
- rotate to other eligible capacity while one key/scope is blocked.

When every key serving a logical model is temporarily cooling, the gateway reports the earliest real recovery time. As soon as the earliest key's cooldown expires, the next real request becomes its controlled recovery probe; no model-wide lockout is added on top of key cooldowns.

Success rate is not used as a positive routing reward. Recovery is driven by direct failure/rate-limit evidence and real subsequent requests.

## Heat protection

Tier 1 heat is deliberately soft and bounded:

- live in-flight pressure can weaken affinity and demote a busy candidate but never hard-block the only healthy capacity;
- Tier 1 hedge candidate concurrency pressure must be `< 0.75`;
- provider-model 429 evidence window: `90s`;
- 1–2 distinct rate-limited keys: neutral factor `1.00`;
- 3 distinct rate-limited keys: mild factor `1.15`;
- 4+ distinct rate-limited keys: stronger factor `1.35`;
- repeated 429s from the same key count once in the evidence window;
- each real success removes at most one recent distinct-key 429 observation, so recovered capacity returns to normal ranking quickly.

Legacy RPM-headroom helpers may still exist in compatibility code, but production node configuration no longer supplies guessed node RPM as an active routing fact.

Provider-model heat is keyed by the real provider-facing model, not the gateway logical alias. It never hard-blocks a provider or model and does not change eligibility, attempt budgets, account cooldowns, P2C sampling, TTFT scoring, affinity storage, or Tier 2/3 behavior. If a heated cohort is the only usable capacity, Tier 1 still dispatches to it.

## Passive TTFT

TTFT is recorded per `(account, logical model)` from a real upstream attempt to the first meaningful model output.

- initial state is unobserved;
- first observation initializes the value;
- subsequent observations use EWMA alpha `0.25`;
- one extreme sample is bounded relative to the current EWMA, while consecutive extreme samples are allowed to expose persistent degradation;
- there are no active background probes.

A hedge loser cancelled because its peer already committed is neutral and must not poison TTFT/failure state as if it independently failed.

## Cooldown and half-open recovery

Tier 1 transient timeout/server failure state still uses conservative circuit recovery. Rate-limit recovery uses the separate provider+key adaptive cooldown described above.

- transient timeout/server failures can accumulate toward cooldown;
- an expired timeout/server cooldown transitions to half-open only when a real request next evaluates the node/model;
- half-open admits a constrained real probe;
- repeated successful probes restore normal circuit state;
- a half-open real failure re-enters cooldown;
- 429 recovery uses key-local adaptive cooldown plus a controlled recovery probe rather than the long transient-failure circuit backoff.

Authentication failures use a long account-scoped cooldown so a rotated credential can recover without permanently disabling the isolate while repeated rejected requests are suppressed.

## Failure classification

`src/reliability/classify.ts` owns the closed failure vocabulary. Consumers should use the exported classification helpers/constants rather than inventing new string literals.

| Kind | Typical cause | Request action | Failure penalty |
| --- | --- | --- | --- |
| `rate_limit` | HTTP 429 | rotate / key-or-explicit-model cooldown | not circuit-counted |
| `rate_limit_global` | distributed pre-dispatch rate limiter | rotate | not circuit-counted |
| `auth` | HTTP 401/403 | rotate / credential cooldown | not circuit-counted |
| `client` | request-invalid 4xx such as 400/413/415/422 and other terminal 4xx | stop | neutral to upstream reliability |
| `model_missing` | model-shaped 404 | rotate / upstream-model cooldown | not circuit-counted |
| `endpoint_not_found` | non-model 404 | rotate / short account cooldown | not circuit-counted |
| `server` | upstream 5xx and selected retryable HTTP statuses | rotate | circuit-counted |
| `network` | network failure | rotate | circuit-counted |
| `headers_timeout` | no upstream response headers in time | rotate | circuit-counted |
| `first_event_timeout` | headers received but no meaningful first event | rotate | circuit-counted |
| `stream_interrupted` | committed stream truncates or misses completion semantics | record interruption | circuit-counted |
| `client_abort` | client cancellation | stop/neutral | neutral |
| `invalid_base_url` | invalid upstream URL before dispatch | rotate | neutral/non-circuit |
| `upstream_200_non_json_body` | non-stream 200 with invalid body shape | terminal handling | neutral/non-circuit |
| `cancelled_after_peer_commit` | hedge loser cancelled after winner commits | neutral | neutral |
| `unknown` | guarded catch-all | rotate according to caller | conservative |

Client-class 4xx currently stop the logical request; the gateway does **not** claim that every provider-specific 400 is automatically recognized as a compatibility failure and retried elsewhere.

## Tier 2/3

Tier 2/3 continue to use `node-state.ts` for active requests, health/circuit state, cooldown, and selection inputs. Active requests are a soft load/ranking signal; configured legacy node `limits` are not the production capacity model.

## Model-family attempt budget

`max_attempts` is a request-wide **hard ceiling**. Model-family fallback shares that budget; it never silently raises it.

For a three-member family, first-round allocation widens before it deepens:

```text
max_attempts=1  requested only
max_attempts=2  requested + first sibling
max_attempts=3  1 / 1 / 1
max_attempts=4  2 / 1 / 1
max_attempts=5  3 / 1 / 1
max_attempts>=6 3 / 2 / 1, then bounded re-checks only from unused budget
```

`Air` follows the same hard ceiling across the one-way `Air -> Pro -> Max -> Ultra` chain. Any re-check round shares the same logical-attempt counter and whole-request wall-clock budget.

## Streaming lifecycle

A Tier 1 in-flight slot remains held through headers, first output, and the active stream. Completion, cancellation, reader error, or idle timeout must release it exactly once.

The first-event guard defines the failover boundary:

- before meaningful output commits, a failed attempt may rotate within the request budget;
- after output commits, transparent replay/failover is unsafe and is not attempted.

Commit semantics are protocol-specific; see [protocol-model.md](protocol-model.md).

## Protocol fallback safety

Cross-protocol fallback remains limited to OpenAI Chat Completions <-> Anthropic Messages. OpenAI Responses is native-only.

Conversion fidelity is not treated as binary success/failure. `exact` and `portable` conversions may proceed. A degraded conversion may also proceed when the loss is cosmetic or controllable, but the fallback is rejected before dispatch when conversion would drop high-risk semantic state such as provider-native tool state/history, thinking history, context management, or a tool-result error marker.

This favors a retryable failure over an HTTP-success response whose meaning materially changed in transit.

## Circuit behavior

Transient failures drive the existing circuit/cooldown model; rate limits, auth failures, client errors, and hedge race losses are not treated as equivalent server failures.

The design intentionally distinguishes “this credential is temporarily limited”, “this model mapping is missing”, “this endpoint is bad”, and “this upstream is transiently failing”. Collapsing those into one generic failure counter would cause unnecessary pool loss.

## Distributed rate shaping

Legacy/optional Cloudflare Rate Limiting infrastructure may still exist as a pre-dispatch compatibility guard for explicitly constructed runtime quotas. It is not the canonical source of Provider capacity and current node configuration does not derive capacity from guessed `limits.rpm`.

Global concurrency coordination is not implemented. Adaptive 429 recovery and provider-model heat remain isolate-local. Adding Durable Objects or another strong coordination layer requires evidence that cross-isolate recovery collisions are materially harming production and that the extra latency/complexity is justified.

## Observability boundary

D1 token-usage persistence and Public Model Status are observational. They do not feed success rates, historical request counts, or public status back into candidate scoring.
