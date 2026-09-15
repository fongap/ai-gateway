# Architecture overview

ai-gateway is a Cloudflare Workers AI API gateway for a household, an individual operator, or a small trusted team. It makes a pool of heterogeneous AI capacity behave like one predictable endpoint without hiding protocol boundaries or inventing global guarantees the runtime does not have.

The product boundary is governed by [Product policy](../governance/product-policy.md). It is intentionally not a public SaaS gateway, enterprise API-management platform, billing system, reseller platform, or general multi-tenant control plane.

## Design goals

The long-term design order is:

1. keep Tier 1 free-token capacity stable, efficient, safe, and continuously usable;
2. preserve protocol correctness and security;
3. keep operation simple for a household or small trusted team;
4. maximize useful free capacity without hiding retry/fallback amplification;
5. keep Tier 2 ready for membership/subscription entitlements;
6. keep Tier 3 as protected paid-API fallback capacity;
7. add extensibility only for a concrete current use case.

A runtime feature should improve at least one of these properties without materially damaging the others:

- request success and recovery behavior;
- free-capacity utilization;
- tail-latency control;
- protocol compatibility;
- operational predictability;
- security;
- Worker hot-path cost.

The project prefers bounded, local mechanisms over global coordination unless production evidence shows local shaping is insufficient. It also prefers deleting superseded mechanisms over carrying old/new implementations in parallel.

## Tier roles

Tier roles are permanent architecture boundaries, not generic priority labels.

| Tier | Long-term role | Design priority |
| --- | --- | --- |
| **Tier 1** | Free or effectively free token capacity across providers/accounts | Primary daily traffic; resilience, load spreading, 429 recovery, low cost, continuous availability |
| **Tier 2** | Membership/subscription entitlement capacity | Reserved for future subscription-entitlement adapters; not a second generic API-key pool |
| **Tier 3** | Paid API capacity | Protected final fallback; predictable and bounded use |

Tier 1 therefore receives most reliability engineering. Tier 2 and Tier 3 must stay simpler and must not accumulate Tier 1-specific adaptive machinery without a demonstrated need.

## Request flow

```text
Client
  ↓
Authentication + route/body validation
  ↓
Request orchestration
  ↓
Logical-model pass
  ↓
Native protocol/surface candidate pool
  ↓
Tier 1 → Tier 2 → Tier 3
  ↓
Optional Chat Completions ↔ Anthropic Messages fallback for the same model
  ↓
If the logical-model pool is exhausted: bounded compatible-model fallback
  ↓
At most one re-check round for recovered compatible pools
  ↓
Protocol-specific response / stream
```

OpenAI Chat Completions and Anthropic Messages are Native First. Only after the native pool is exhausted may the configured cross-protocol fallback run. OpenAI Responses is Native Only for protocol conversion.

Logical-model fallback is a separate outer orchestration layer. The closed families are `Code-Max ↔ Code-Pro → Code-Ultra`, `Max ↔ Pro → Ultra`, and one-way `Air → Pro → Max → Ultra`. Compatible families are evaluated for at most two rounds; all passes share the original attempt, dispatch, hedge, and wall-clock budgets. `max_attempts` remains the request-wide hard ceiling and is never enlarged by family fallback.

## Module ownership

```text
Model Registry     logical model policy and declared capabilities
Node config         upstream address, protocol, surfaces, model mapping, priority, credential binding
Request             native/protocol/model-family fallback orchestration and shared budgets
Scheduler           which eligible node should receive the next attempt
Reliability         whether a node/account/model is currently usable and how failures change state
Transport           how to call the selected upstream endpoint
Protocol            client request validation and protocol-specific errors
Conversion          supported Chat ↔ Messages semantic bridge
Stream              first-event guards, SSE lifecycle, commit boundary
Observability       logs, metrics, token usage, diagnostics
Runtime             runtime availability and public read-only projections
Dashboard           presentation only
```

These boundaries are intentional. Transport does not select nodes. Scheduler and Reliability do not parse provider wire events. Model-family fallback does not replace node scheduling or reliability state; it only decides which compatible logical model is evaluated next after the current pool is exhausted. Provider labels are metadata and known-quirk selectors, not a substitute for model capability declarations.

## Current invariants

- Native OpenAI Chat targets `/v1/chat/completions` upstream.
- Native OpenAI Responses targets `/v1/responses` upstream.
- Native Anthropic Messages targets `/v1/messages` upstream.
- The built-in conversion matrix is only OpenAI Chat Completions ↔ Anthropic Messages.
- OpenAI Responses does not enter cross-protocol conversion.
- `Code-Max` and `Code-Pro` are first-choice interchangeable coding aliases; `Code-Ultra` is the family-level higher fallback.
- `Max` and `Pro` are first-choice interchangeable general aliases; `Ultra` is the family-level higher fallback.
- Code aliases never fall back into non-Code aliases.
- `Air` may fall back upward to `Pro → Max → Ultra`; higher general aliases never fall back down to `Air`.
- Compatible model families get at most two evaluation rounds; there is no unbounded model loop.
- `max_attempts` is the request-wide hard ceiling; model-family fallback never enlarges it internally.
- A model-shaped 404 isolates the failing node/model mapping; an authorized compatible sibling may still be evaluated within the same request budget.
- Native retry, protocol fallback, and model-family fallback share the same logical-attempt and wall-clock failover budget.
- A hedge twin remains in the primary request's protocol and surface.
- Tier 1 uses Eligibility → soft Affinity → P2C with passive TTFT and bounded heat protection.
- Tier 2/3 remain separate from Tier 1 adaptive state.
- Short-lived scheduler/reliability state is isolate-local best-effort and disappears with the isolate.
- D1 token usage is observability, not a routing authority.
- `TIER1_AFFINITY` KV stores only hashed session affinity and does not make routing globally sticky.
- Provider Discovery is read-only advisory tooling.
- Public Model Status is a read-only projection and never feeds Scheduler or Reliability.
- ai-gateway carries one current internal/configuration contract; superseded old-version paths are removed rather than kept behind compatibility shims.

## Configuration authority

- Runtime variable names/defaults: `src/config/runtime-vars.ts`.
- Node parsing and credential binding: `src/config/nodes.ts` and related config modules.
- Logical model policy/capabilities: `src/config/registry.ts`.
- Logical-model fallback policy: `src/request/model-fallback.ts` and its contract tests.
- Protocol fallback matrix: protocol fallback config/conversion modules and their contract tests.
- Failure taxonomy: `src/reliability/classify.ts`.

Architecture documentation summarizes these sources; it must be corrected when executable behavior changes.

## Persistence boundaries

D1 and KV are deliberately outside the critical scheduling decision path where possible.

- `TIER1_AFFINITY` KV: short-lived session binding, 30-minute TTL.
- Token-usage D1: persisted usage aggregation and recent public-status evidence.
- Tier 1 TTFT, in-flight, cooldown, adaptive 429/heat, half-open state: isolate-local memory.
- Tier 2/3 health/circuit/concurrency state: isolate-local memory.

The gateway does not claim cross-PoP globally accurate concurrency or provider-account quota from these local states. Stronger coordination is not added merely because it is theoretically cleaner; it requires measured evidence that the household/small-team deployment model needs it.

See [Protocol model](protocol-model.md), [Routing model](routing-model.md), and [Reliability model](reliability-model.md) for the detailed contracts.