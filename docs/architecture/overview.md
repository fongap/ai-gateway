# Architecture overview

ai-gateway is a Cloudflare Workers aggregation gateway designed to make a pool of heterogeneous AI APIs and credentials behave like one predictable endpoint without hiding protocol boundaries or inventing global guarantees the runtime does not have.

## Design goals

A runtime feature should improve at least one of these properties without materially damaging the others:

- upstream quota utilization;
- request success and recovery behavior;
- tail-latency control;
- protocol compatibility;
- operational predictability;
- Worker hot-path cost.

The project prefers bounded, local mechanisms over global coordination unless production evidence shows local shaping is insufficient.

## Request flow

```text
Client
  ↓
Authentication + route/body validation
  ↓
Request orchestration
  ↓
Native protocol/surface candidate pool
  ↓
Tier 1 → Tier 2 → Tier 3
  ↓
Optional Chat Completions ↔ Anthropic Messages fallback
  ↓
Protocol-specific response / stream
```

OpenAI Chat Completions and Anthropic Messages are Native First. Only after the native pool is exhausted may the configured cross-protocol fallback run. OpenAI Responses is Native Only.

## Module ownership

```text
Model Registry     logical model policy and declared capabilities
Node config         upstream address, protocol, surfaces, model mapping, limits, credential binding
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

These boundaries are intentional. Transport does not select nodes. Scheduler and Reliability do not parse provider wire events. Provider labels are metadata and known-quirk selectors, not a substitute for model capability declarations.

## Current invariants

- Native OpenAI Chat targets `/v1/chat/completions` upstream.
- Native OpenAI Responses targets `/v1/responses` upstream.
- Native Anthropic Messages targets `/v1/messages` upstream.
- The built-in conversion matrix is only OpenAI Chat Completions ↔ Anthropic Messages.
- OpenAI Responses does not enter cross-protocol conversion.
- Native retry and conversion fallback share the same logical-attempt and wall-clock failover budget.
- A hedge twin remains in the primary request's protocol and surface.
- Tier 1 uses Eligibility → soft Affinity → P2C with passive TTFT and bounded heat protection.
- Tier 2/3 remain separate from Tier 1 adaptive state.
- Short-lived scheduler/reliability state is isolate-local best-effort and disappears with the isolate.
- D1 token usage is observability, not a routing authority.
- `TIER1_AFFINITY` KV stores only hashed session affinity and does not make routing globally sticky.
- Provider Discovery is read-only advisory tooling.
- Public Model Status is a read-only projection and never feeds Scheduler or Reliability.

## Configuration authority

- Runtime variable names/defaults: `src/config/runtime-vars.ts`.
- Node parsing and credential binding: `src/config/nodes.ts` and related config modules.
- Logical model policy/capabilities: `src/config/registry.ts`.
- Protocol fallback matrix: protocol fallback config/conversion modules and their contract tests.
- Failure taxonomy: `src/reliability/classify.ts`.

Architecture documentation summarizes these sources; it must be corrected when executable behavior changes.

## Persistence boundaries

D1 and KV are deliberately outside the critical scheduling decision path where possible.

- `TIER1_AFFINITY` KV: short-lived session binding, 30-minute TTL.
- Token-usage D1: persisted usage aggregation and recent public-status evidence.
- Tier 1 TTFT, in-flight, cooldown, RPM bucket, half-open state: isolate-local memory.
- Tier 2/3 health/circuit/concurrency state: isolate-local memory.

The gateway does not claim cross-PoP globally accurate concurrency or provider-account quota from these local states.

See [Protocol model](protocol-model.md), [Routing model](routing-model.md), and [Reliability model](reliability-model.md) for the detailed contracts.
