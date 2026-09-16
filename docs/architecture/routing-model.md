# Routing model

Routing is constrained by **protocol + surface + model + tier**. Native requests enter only nodes that explicitly support the active protocol and surface; converted fallback requests enter the target protocol pool only after conversion succeeds.

Tier order is a product invariant:

```text
Tier 1 → Tier 2 → Tier 3
```

Tier 1 is free/effectively free capacity and the primary daily layer. Tier 2 is reserved for future membership/subscription entitlement capacity. Tier 3 is paid API capacity kept as protected final fallback.

OpenAI Chat Completions ↔ Anthropic Messages fallback is evaluated only after the native route is exhausted. OpenAI Responses remains Native Only for protocol conversion.

## Model registry and nodes

The Model Registry owns logical-model policy and declared capabilities. Runtime nodes own provider metadata, base URL, protocol, surfaces, logical→upstream model mapping, priority, and the bound credential.

Node `limits` are not part of the schema. Provider capacity comes from observed runtime signals rather than operator-supplied RPM/concurrency guesses.

Credentials bind by **Tier + node id**. Config and Secret shard suffixes are independent partition numbers.

Static node `priority` is meaningful for Tier 2/3 and deliberately ignored by Tier 1 P2C. Tier 1 may still use request priority derived from the authenticated access group as a bounded score factor.

## Logical-model family fallback

Logical-model fallback is separate from protocol fallback. Protocol fallback changes wire protocol/surface for the same logical model; family fallback changes the logical model while preserving the client route and requested-model identity.

The closed family policy is:

```text
Code-Ultra → Code-Max → Code-Pro
Code-Max   → Code-Pro → Code-Ultra
Code-Pro   → Code-Max → Code-Ultra

Ultra → Max → Pro
Max   → Pro → Ultra
Pro   → Max → Ultra

Air → Pro → Max → Ultra
```

Code models never cross into the non-Code family. `Air` may move upward; `Ultra / Max / Pro` never fall back down to `Air`.

`max_attempts` is the request-wide hard ceiling and family planning never raises it. First-round family allocation widens before it deepens. Compatible families get at most a bounded second evaluation round, and that round may use only budget left from the same request.

Every model pass runs native Tier 1 → Tier 2 → Tier 3 first and, when configured, the supported cross-protocol fallback for that same effective model. Model changes never create fresh logical-attempt, dispatch, hedge, or wall-clock budgets.

A model-shaped 404 isolates the failing node/model mapping. An authorized compatible sibling may still be tried inside the same request budget.

Family retry planning is failure-domain aware: aliases on the same configured node/account that resolve to the same upstream model share one request-local failure domain. Once spent, that domain does not consume another logical attempt or reserve phantom future wall-clock escape time.

All-transient bounded family exhaustion is retryable; it means the request plan was exhausted, not that every account in the deployment was proven unavailable.

## Tier 1: Eligibility → Affinity → P2C

Tier 1 has no independent attempt cap. It uses the request-wide budget, optional explicit per-tier cap, current dispatchability, and wall-clock failover budget.

```text
Eligibility
   ↓
soft session Affinity
   ↓
P2C sample
   ↓
bounded score comparison
   ↓
live inFlight record
   ↓
real upstream request
   ↓
passive TTFT / failure-state update
```

There is no full-pool latency sort.

### Eligibility

A Tier 1 node must:

- be `tier-1`;
- match protocol and surface;
- serve the requested logical model;
- not be disabled or in an active account/model/upstream-model cooldown;
- not be blocked by half-open single-probe state;
- satisfy an explicit positive `max_in_flight` ceiling when one was deliberately configured.

Heat protection remains ranking-only and never turns the last healthy candidate into an artificial hard failure.

### Soft session affinity

Clients may provide `x-session-id` (8–128 characters). The gateway hashes it before storing a Tier 1 account binding in `TIER1_AFFINITY`.

Affinity is a score bias, not sticky routing. It cannot bypass eligibility, cooldown, or health state.

### P2C score

When more than one candidate exists, Tier 1 samples two distinct eligible accounts and chooses the lower bounded score. Signals include:

- passive per-account/model TTFT;
- current in-flight pressure;
- half-open recovery state;
- soft affinity;
- exploration for unobserved nodes;
- provider + upstream-model multi-key rate-limit heat;
- bounded request priority.

Success rate is not a positive routing reward.

### Passive TTFT

TTFT is learned only from real requests. Unknown nodes remain eligible and receive bounded exploration. Tier 1 runs no background latency probes.

## Tier 1 heat protection

Tier 1 spreads load using observable runtime facts rather than guessed provider quotas.

### Live in-flight pressure

Current in-flight work is a soft ranking signal. A busier account tends to lose against a comparable idle peer but remains usable when alternatives are unavailable.

### Provider-model rate-limit heat

Distinct-key rate-limit evidence is aggregated isolate-locally by `(provider, upstream model)` over a short window. It changes ranking only: it does not create provider-wide cooldown or remove the last healthy candidate.

Providers that encode throughput limits in non-429 status codes are normalized by reliability classification when the error body clearly identifies a rate/throughput quota. Ordinary client payload errors keep their client-error semantics.

### Affinity decay and hedge gate

Affinity preference weakens toward neutral as live pressure or heat rises. A Tier 1 hedge twin is optional latency work and yields before primary traffic when spare capacity is low.

### Deliberate limits

Tier 1 does not add:

- success-rate reward weighting;
- guessed dynamic provider concurrency limits;
- cross-isolate global coordination;
- extra capacity fields;
- hard removal of the last healthy primary candidate.

## Tier 2 and Tier 3

Tier 2/3 use the separate `node-state.ts` reliability model and the existing selector. They may consider static priority, active-request load, health/circuit state, cooldown, and latency preference.

Tier 2/3 do not consume Tier 1 TTFT, affinity, or provider-model heat state.

Their product roles remain intentionally narrow: Tier 2 is reserved for future subscription-entitlement capacity; Tier 3 is paid API fallback. Do not duplicate Tier 1 machinery into them without measured need.

## Attempt allocation

There is exactly one cross-tier allocation model.

`max_attempts` is the request-wide logical-attempt ceiling. `tier_attempts` may explicitly cap individual tiers. For each model/protocol pass:

1. tiers with no dispatchable candidate receive zero;
2. explicit `tier_attempts` caps are applied first; explicit zero disables that tier;
3. remaining dispatchable tiers receive a one-attempt baseline while budget permits, in strict Tier 1 → Tier 2 → Tier 3 order;
4. every remaining surplus attempt goes to the first adjustable dispatchable tier.

Candidate count affects selection **inside** a tier. It never redistributes request budget away from a higher tier.

There is no `budget_split`, weighted allocation, or alternate cross-tier budget mode in the current schema.

Model-family and protocol fallback share the same hard `max_attempts` and wall-clock boundary.

## Failover budget

`FAILOVER_BUDGET_MS` limits the entire request wall clock; the default is 60 seconds. Neither protocol fallback nor model-family fallback receives a fresh clock.

The attempt allocator preserves bounded escape time for later request-plan opportunities rather than equal-splitting the whole budget. Live candidates and reachable compatible family passes participate in that reserve. Known duplicate failure domains are pruned from future reserve planning.

Each physical dispatch receives one absolute attempt deadline. Header wait, first meaningful output, response assembly, and bounded non-2xx diagnostic-body reads all stay inside that deadline. A hedge twin inherits the primary logical attempt's deadline.

## Hedge

Reactive hedge starts one twin when the current logical attempt has not committed before the configured delay. `HEDGE_DELAY_MS` defaults to 3 seconds; zero disables it.

- the twin is the same logical attempt;
- it consumes one physical dispatch but not another logical-attempt slot;
- it uses the same protocol and surface as the primary;
- a loser cancelled after peer commit is neutral;
- genuine timeout/server failure remains a real failure;
- Tier 1 twins additionally pass the spare-capacity gate.

## Capacity signals

Node-level configured RPM/concurrency limits are not part of the schema. Active routing uses:

- live in-flight pressure;
- real rate-limit evidence and `Retry-After`;
- provider-model multi-key heat;
- circuit state and counted transient failures;
- passive TTFT;
- explicit positive `max_in_flight` only when the operator knows a real account contract.

`GATEWAY_KEY_RPM` is separate client-access protection and does not claim to represent Provider capacity.

See [Reliability model](reliability-model.md) for failure classification, cooldown, recovery and stream-lifecycle ownership.
