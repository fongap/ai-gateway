# Routing model

Routing is always constrained by **protocol + surface + model + tier**. Native requests enter only nodes that explicitly support the active protocol and surface; converted fallback requests enter the target protocol pool only after conversion succeeds.

Tier order is fixed:

```text
Tier 1 → Tier 2 → Tier 3
```

OpenAI Chat Completions ↔ Anthropic Messages fallback is evaluated after the native route is exhausted. OpenAI Responses remains Native Only for protocol conversion.

## Model Registry and nodes

The Model Registry owns logical model policy and declared capabilities. Runtime nodes own upstream routing facts: provider metadata, base URL, protocol, surfaces, logical→upstream model mapping, priority, and the bound credential.

Node `limits` are retired from active routing. Existing syntactically-valid legacy `limits` objects are accepted temporarily for migration safety but no longer define Provider capacity and should be removed from maintained configuration.

Credentials bind by **Tier + node id**. `TIER*_NODES_CONFIG_XX` and `TIER*_NODES_SECRETS_XX` suffixes are independent shard numbers; they are not positional pairs.

`priority` remains meaningful for Tier 2/3. Tier 1 deliberately ignores static priority.

## Logical-model family fallback

Logical-model fallback is a bounded request-orchestration layer around the existing scheduler. It is separate from protocol fallback: protocol fallback changes the wire protocol/surface for the **same** logical model, while model-family fallback changes the logical model while preserving the client route and client-facing requested-model identity.

The closed fallback policy is:

```text
Code-Ultra → Code-Max → Code-Pro
Code-Max   → Code-Pro → Code-Ultra
Code-Pro   → Code-Max → Code-Ultra

Ultra → Max → Pro
Max   → Pro → Ultra
Pro   → Max → Ultra

Air → Pro → Max → Ultra
```

The most equivalent pairs are therefore `Code-Max ↔ Code-Pro` and `Max ↔ Pro`. `Code-*` never crosses into the non-Code family. `Air` may move upward, but `Ultra` / `Max` / `Pro` never fall back down to `Air`.

For a configured three-model family, the first evaluation round reserves logical attempts as **3 / 2 / 1** in the requested model's fallback order. `Air` uses **3 / 1 / 1 / 1** across its one-way upward chain. Family requests therefore receive at least six request-wide logical attempts when a compatible sibling actually exists. A lone family-shaped alias with no configured sibling keeps its normal policy budget.

Compatible families still get at most two evaluation rounds. The second round exists only to re-check a model that may have recovered while sibling pools were being tried, is capped to one attempt per pass, and can spend only request budget left unused by the first round. `Air` is excluded from its second round, preserving the one-way-up rule. There is no unbounded cycle.

Every model pass runs the normal native-first Tier 1 → Tier 2 → Tier 3 path and, when configured, the existing cross-protocol fallback for that same effective model. All passes share logical-attempt, dispatch, hedge, and `FAILOVER_BUDGET_MS` ceilings; switching models never creates a fresh wall-clock budget or an unlimited retry loop.

A model-shaped 404 (`model_missing`) is a mapping/capability fact rather than transient capacity exhaustion. It remains isolated to the failing model mapping and does not trigger model-family fallback.

When a complete family sweep fails only for transient reasons such as 429, 5xx, network failure, headers/first-event timeout, or stream interruption, the gateway returns retryable `503` with a short `Retry-After`. Coding clients can then retry the turn instead of stopping for manual continuation. Auth/config/client/model-mapping failures remain terminal.

## Tier 1: Eligibility → Affinity → P2C

<!-- Tier 1 没有独立 attempt 上限 -->

Tier 1 has no independent attempt cap. It uses the shared request attempt budget, per-tier policy, current dispatchability, and wall-clock failover budget.

The Tier 1 decision path is intentionally bounded:

```text
Eligibility
   ↓
soft session Affinity
   ↓
P2C: sample two eligible accounts
   ↓
compare bounded scores
   ↓
record live inFlight
   ↓
real upstream request
   ↓
passive TTFT / failure state update
```

There is no full-pool latency sort.

### Eligibility

A Tier 1 node must:

- be `tier-1`;
- match protocol and surface;
- serve the requested logical model;
- not be disabled or in an active account/model/upstream-model cooldown;
- not be blocked by HALF_OPEN single-probe state;
- not have known exhausted quota state.

A guessed `limits.concurrency` or `limits.rpm` value is not an active eligibility rule. Real runtime evidence decides availability. Heat protection remains ranking-only and never turns a healthy last candidate into an artificial hard failure.

### Soft session affinity

Clients may provide `x-session-id` (8–128 characters). The gateway hashes it before using it as a KV key and stores the Tier 1 account binding in `TIER1_AFFINITY` with a 30-minute TTL.

Affinity is a score bias, not sticky routing. The cold/healthy base factor is `0.85`. It can help preserve provider-side locality without forcing requests to a hot or unavailable key.

### P2C score

When more than one candidate exists, Tier 1 samples two distinct eligible accounts and chooses the lower score. The score combines bounded factors for:

- passive per-`(account, model)` TTFT;
- current live inFlight pressure;
- half-open recovery state;
- explicit quota-near-limit state when observed;
- soft affinity;
- exploration for unobserved nodes;
- provider + upstream-model multi-key 429 heat.

Success rate is **not** a positive score/reward signal. This avoids concentrating traffic on a currently successful key until it becomes the next rate-limited hotspot.

### Passive TTFT

TTFT is learned only from real requests. The first valid observation initializes the value; later observations use EWMA alpha `0.25`. Unknown nodes remain eligible and receive a small exploration opportunity.

Tier 1 does not run background latency probes.

## Tier 1 heat protection

Heat protection spreads load using facts observed at runtime and softly reacts when several independent credentials hit the same provider-facing model at once, without creating another guessed quota system.

### Live inFlight pressure

Current in-flight work is ranking-only. Pressure rises smoothly with live work and contributes a bounded soft score factor. A busier account therefore loses to a comparable idle peer more often, but it remains eligible if healthy and can still serve when alternatives are unavailable.

This replaces operator-guessed concurrency ceilings as the primary load signal.

### Provider-model 429 heat

Distinct-key 429 evidence is aggregated isolate-locally by `(provider, upstream model)` over a short 90-second window. One or two affected keys are neutral; three independent keys apply a mild `1.15` score factor and four or more apply `1.35`.

This signal changes ranking only. It never makes a candidate ineligible, never creates a provider-wide cooldown, and never changes the existing key/model 429 cooldown semantics. Real successes decay the evidence one observation at a time so recovered cohorts return to normal ranking quickly.

### Affinity decay

As live pressure or observed heat rises, the affinity factor moves from its `0.85` preference toward neutral `1.0`.

Affinity never turns into an independent negative penalty. A hot affinity account merely loses its preference.

### Hedge spare-capacity gate

A Tier 1 hedge twin is optional latency work. It is suppressed before primary traffic when the candidate is already visibly busy or recovering from rate pressure. Primary requests do not use this hedge-only threshold.

If only one eligible primary candidate remains, heat protection does not hard-block it.

### What heat protection does not do

It does not add:

- success-rate weighting;
- guessed dynamic concurrency limits;
- cross-isolate global coordination;
- new environment variables;
- new node capacity fields;
- hard removal of the last healthy primary candidate.

## Tier 2 and Tier 3

Tier 2/3 continue to use the existing selector and `node-state.ts` reliability model. Their selection may use priority, active-request load, health/circuit state, cooldown, and latency preference according to the existing scheduler implementation.

Active request count is a soft ranking signal here as well; configured legacy concurrency no longer makes a healthy node ineligible.

Tier 2/3 do not read Tier 1 TTFT, Tier 1 affinity, or Tier 1 provider-model heat state.

## Attempt budget

`max_attempts` is normally the request-wide logical-attempt ceiling. `tier_attempts` can explicitly cap individual tiers. When a tier has no explicit cap, the current budget-split policy allocates logical attempts among dispatchable tiers.

Configured model families are the bounded exception: when at least one compatible sibling exists, the family orchestration requires a six-attempt minimum to guarantee its first-round `3 / 2 / 1` contract. This is still one finite request budget, not a fresh budget per model.

`budget_split` supports:

- `even` / `null` — preserve tier priority and give surplus to the first dispatchable unbounded tier;
- `weighted` — distribute remaining budget among unbounded dispatchable tiers by live candidate count.

Explicit `tier_attempts` wins over tier budget splitting inside each model pass. The sum of explicit tier caps must not exceed the policy's configured `max_attempts`. Model-family and protocol fallback still share one wall-clock request boundary.

## Failover budget

`FAILOVER_BUDGET_MS` limits the entire request wall clock; the current default is **60 seconds**. New attempts stop when the remaining budget cannot safely fit another try.

The budget starts when the gateway receives the request. Neither protocol fallback nor model-family fallback receives a fresh clock.

## Hedge

Reactive hedge starts one twin when the current logical attempt has not committed before the configured delay. The current `HEDGE_DELAY_MS` default is **3 seconds**; `0` disables it.

Important semantics:

- the twin is the same logical attempt and does not consume another logical-attempt slot;
- it does consume a physical dispatch and is bounded by the request dispatch ceiling;
- the twin uses the same protocol and surface as the primary;
- the loser cancelled after a peer commit is neutral;
- a twin's genuine timeout/server failure remains a real failure;
- Tier 1 twins additionally pass the soft spare-capacity gate.

## Capacity signals

Node-level `limits.concurrency`, `limits.rpm`, and `limits.rpm_mode` are retired from active capacity control because many providers do not publish stable per-key limits. Existing syntactically-valid legacy objects are accepted during migration but should be deleted.

Active routing instead uses:

- live inFlight pressure for soft load balancing;
- real 429 responses and `Retry-After` for cooldown/recovery;
- provider-model multi-key 429 heat;
- circuit state and counted transient failures;
- passive TTFT;
- explicit quota evidence when the runtime can actually observe it.

`GATEWAY_KEY_RPM` remains separate gateway-access protection and does not claim to represent a Provider account quota. Optional Cloudflare rate-limiting infrastructure is likewise not a globally exact Provider-capacity source.

See [Reliability model](reliability-model.md) for cooldown, 429 recovery, and failure accounting.
