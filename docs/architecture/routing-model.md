# Routing model

Routing is always constrained by **protocol + surface + model + tier**. Native requests enter only nodes that explicitly support the active protocol and surface; converted fallback requests enter the target protocol pool only after conversion succeeds.

Tier order is fixed:

```text
Tier 1 → Tier 2 → Tier 3
```

OpenAI Chat Completions ↔ Anthropic Messages fallback is evaluated after the native route is exhausted. OpenAI Responses remains Native Only.

## Model Registry and nodes

The Model Registry owns logical model policy and declared capabilities. Runtime nodes own upstream routing facts: provider metadata, base URL, protocol, surfaces, logical→upstream model mapping, priority, limits, and the bound credential.

Credentials bind by **Tier + node id**. `TIER*_NODES_CONFIG_XX` and `TIER*_NODES_SECRETS_XX` suffixes are independent shard numbers; they are not positional pairs.

`priority` remains meaningful for Tier 2/3. Tier 1 deliberately ignores static priority.

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
claim RPM/concurrency slot
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
- have isolate-local concurrency capacity;
- have hard-RPM admission capacity when hard RPM is configured;
- not have known exhausted quota state.

Eligibility is a hard gate. Heat protection never makes an otherwise ineligible node eligible.

### Soft session affinity

Clients may provide `x-session-id` (8–128 characters). The gateway hashes it before using it as a KV key and stores the Tier 1 account binding in `TIER1_AFFINITY` with a 30-minute TTL.

Affinity is a score bias, not sticky routing. The cold/healthy base factor is `0.85`. It can help preserve provider-side locality without forcing requests to a hot or unavailable key.

### P2C score

When more than one candidate exists, Tier 1 samples two distinct eligible accounts and chooses the lower score. The score combines bounded factors for:

- passive per-`(account, model)` TTFT;
- current concurrency load;
- half-open recovery state;
- explicit quota-near-limit state;
- soft affinity;
- exploration for unobserved nodes;
- RPM headroom heat protection.

Success rate is **not** a positive score/reward signal. This avoids concentrating traffic on a currently successful key until it becomes the next rate-limited hotspot.

### Passive TTFT

TTFT is learned only from real requests. The first valid observation initializes the value; later observations use EWMA alpha `0.25`. Unknown nodes remain eligible and receive a small exploration opportunity.

Tier 1 does not run background latency probes.

## Tier 1 heat protection

Heat protection spreads load before a key reaches its hard limit, without creating another quota system.

### RPM headroom

Hard-RPM admission uses a tiny smooth token bucket. While a key still has a dispatchable token but its headroom is reduced, selection receives an RPM penalty from `1.0` up to at most `1.20`.

This is a **soft score effect**. The existing hard RPM gate remains the final admission authority.

### Affinity decay

Heat is the maximum of current RPM-headroom pressure and concurrency pressure. As heat rises, the affinity factor moves linearly from `0.85` toward neutral `1.0`.

Affinity never turns into an independent negative penalty. A hot affinity account merely loses its preference.

### Hedge spare-capacity gate

A Tier 1 hedge twin is optional latency work. It is allowed only when the candidate has visible spare capacity:

- RPM pressure `<= 0.50`;
- concurrency pressure `< 0.75`.

Primary requests do not use these soft hedge thresholds. If only one eligible primary candidate remains, heat protection does not hard-block it.

### What heat protection does not do

It does not add:

- success-rate weighting;
- dynamic concurrency learning;
- cross-isolate global coordination;
- new environment variables;
- new node configuration fields;
- Tier 2/3 behavior changes.

## Tier 2 and Tier 3

Tier 2/3 continue to use the existing selector and `node-state.ts` reliability model. Their selection may use priority, active-request load, health/circuit state, cooldown, and latency preference according to the existing scheduler implementation.

They do not read Tier 1 TTFT, Tier 1 affinity, or Tier 1 heat state.

## Attempt budget

`max_attempts` is the request-wide logical-attempt ceiling. `tier_attempts` can explicitly cap individual tiers. When a tier has no explicit cap, the current budget-split policy allocates the remaining logical attempts among dispatchable tiers.

`budget_split` supports:

- `even` / `null` — preserve tier priority and give surplus to the first dispatchable unbounded tier;
- `weighted` — distribute remaining budget among unbounded dispatchable tiers by live candidate count.

Explicit `tier_attempts` wins over budget splitting. The sum of explicit tier caps must not exceed `max_attempts`.

## Failover budget

`FAILOVER_BUDGET_MS` limits the entire request wall clock; the current default is **60 seconds**. New attempts stop when the remaining budget cannot safely fit another try.

The budget starts when the gateway receives the request. Protocol fallback does not receive a fresh clock.

## Hedge

Reactive hedge starts one twin when the current logical attempt has not committed before the configured delay. The current `HEDGE_DELAY_MS` default is **3 seconds**; `0` disables it.

Important semantics:

- the twin is the same logical attempt and does not consume another `max_attempts` slot;
- it does consume a physical dispatch and is bounded by the request dispatch ceiling;
- the twin uses the same protocol and surface as the primary;
- the loser cancelled after a peer commit is neutral;
- a twin's genuine timeout/server failure remains a real failure;
- Tier 1 twins additionally pass the heat spare-capacity gate.

## RPM and concurrency

`limits.rpm` defaults to hard shaping. Tier 1 hard RPM is isolate-local smooth admission; when no capacity remains, the node is not dispatchable. `rpm_mode: "soft"` keeps best-effort semantics.

`limits.concurrency` is isolate-local shaping. Neither value is a claim of globally accurate provider-account quota.

When the optional Cloudflare rate-limiting binding is configured, hard-RPM dispatch receives an additional distributed per-location check. It remains approximate rather than a globally consistent account quota.

See [Reliability model](reliability-model.md) for cooldown, 429 recovery, and failure accounting.
