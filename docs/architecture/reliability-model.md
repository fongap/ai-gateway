# Reliability model

ai-gateway separates Tier 1 adaptive account/model state from the Tier 2/3 node-state system. Both are short-lived best-effort runtime state unless an explicitly documented Cloudflare persistence primitive is involved.

## Tier 1 state

Tier 1 state is isolate-local and scoped deliberately:

- **Account scope** — in-flight count, account cooldown, rate-limit recovery gate, explicit quota state.
- **Model scope** — TTFT EWMA, failure/cooldown/half-open state, consecutive rate limits/outliers, recovery gate.
- **Upstream-model scope** — short cooldown for provider-facing model-missing responses so a logical alias remap does not inherit stale 404 state.

An isolate restart clears this adaptive state. The gateway does not claim provider-wide state consistency.

## Smooth hard-RPM admission

Tier 1 hard `limits.rpm` uses an isolate-local token bucket instead of a calendar-minute counter.

- refill rate: `rpm / 60s`;
- burst capacity: at most 2 tokens;
- RPM below 2 uses capacity 1;
- `rpm_mode: "soft"` bypasses the hard Tier 1 bucket behavior.

Heat protection observes the remaining local headroom and may softly spread selection before the hard gate is reached. The hard admission rule remains authoritative.

## 429 handling

429 is a capacity signal, not a reason to reward another key permanently.

Tier 1 behavior:

- honor an explicit `Retry-After` when available;
- otherwise use bounded exponential backoff with jitter;
- scope explicit account-level limits to the account;
- otherwise default ambiguous 429 handling to model scope and record the ambiguity;
- after cooldown, gate the first recovery admission for one RPM interval at the same scope;
- do not push the shared RPM bucket into the future;
- rotate to other eligible capacity while the limited scope is blocked.

Success rate is not used as a positive routing reward. Recovery is driven by direct failure/rate-limit evidence and real subsequent requests.

## Heat protection

`src/reliability/tier1-heat.ts` provides a bounded pre-limit signal used by Tier 1 routing:

- RPM headroom score factor: at most `1.20`;
- affinity bias decays toward neutral as RPM/concurrency heat rises;
- Tier 1 hedge candidate RPM pressure must be `<= 0.50`;
- Tier 1 hedge candidate concurrency pressure must be `< 0.75`.

These thresholds affect optional selection/hedge behavior. They do not replace the existing hard RPM, concurrency, cooldown, or eligibility gates, and they do not apply a new hard block to a primary request.

## Passive TTFT

TTFT is recorded per `(account, logical model)` from a real upstream attempt to the first meaningful model output.

- initial state is unobserved;
- first observation initializes the value;
- subsequent observations use EWMA alpha `0.25`;
- one extreme sample is bounded relative to the current EWMA, while consecutive extreme samples are allowed to expose persistent degradation;
- there are no active background probes.

A hedge loser cancelled because its peer already committed is neutral and must not poison TTFT/failure state as if it independently failed.

## Cooldown and half-open recovery

Tier 1 transient failure state uses conservative recovery rather than active probes.

- transient timeout/server failures can accumulate toward cooldown;
- an expired cooldown transitions to half-open only when a real request next evaluates the node/model;
- half-open admits a constrained real probe;
- repeated successful probes restore normal state;
- a half-open real failure re-enters cooldown.

Authentication failures use a long account-scoped cooldown so a rotated credential can recover without permanently disabling the isolate while repeated rejected requests are suppressed.

## Failure classification

`src/reliability/classify.ts` owns the closed failure vocabulary. Consumers should use the exported classification helpers/constants rather than inventing new string literals.

| Kind | Typical cause | Request action | Failure penalty |
| --- | --- | --- | --- |
| `rate_limit` | HTTP 429 | rotate / cooldown | not circuit-counted |
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

Tier 2/3 continue to use `node-state.ts` for active requests, health/circuit state, cooldown, and selection inputs. They do not read Tier 1 TTFT, affinity, RPM bucket, or heat state.

## Streaming lifecycle

A Tier 1 in-flight slot remains held through headers, first output, and the active stream. Completion, cancellation, reader error, or idle timeout must release it exactly once.

The first-event guard defines the failover boundary:

- before meaningful output commits, a failed attempt may rotate within the request budget;
- after output commits, transparent replay/failover is unsafe and is not attempted.

Commit semantics are protocol-specific; see [protocol-model.md](protocol-model.md).

## Circuit behavior

Transient failures drive the existing circuit/cooldown model; rate limits, auth failures, client errors, and hedge race losses are not treated as equivalent server failures.

The design intentionally distinguishes “this credential is temporarily limited”, “this model mapping is missing”, “this endpoint is bad”, and “this upstream is transiently failing”. Collapsing those into one generic failure counter would cause unnecessary pool loss.

## Distributed rate shaping

An optional Cloudflare Rate Limiting binding can add distributed per-location fixed-window admission for hard RPM. This is a useful second guard but is still not a strictly global provider-account quota.

Global concurrency coordination is not implemented. Adding Durable Objects or another strong coordination layer requires evidence that the current isolate-local shaping is insufficient and that the extra latency/complexity is justified.

## Observability boundary

D1 token-usage persistence and Public Model Status are observational. They do not feed success rates, historical request counts, or public status back into candidate scoring.
