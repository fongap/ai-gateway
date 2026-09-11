# Public Model Status

The status shown on the public dashboard is a **read-only service projection**. It is not the same thing as the isolate-local scheduling state and must never become a routing input.

## Two different concepts

### Runtime Availability

`src/runtime/availability.ts` summarizes what the current Worker isolate knows about candidate availability: Tier 1 observation/cooldown state and Tier 2/3 reliability state.

Scheduler and reliability logic may use this runtime state.

### Public Model Status

`src/runtime/model-status.ts` combines current runtime availability with persisted recent-success evidence so the public page does not incorrectly label every model as “unobserved” after an isolate restart.

The direction is one-way:

```text
Runtime state + D1 observability
            ↓
Public Model Status
            ↓
Dashboard HTML
```

Public Model Status never feeds Scheduler, Reliability, Transport, Protocol, Conversion, Hedge, Cooldown, or Failover.

## Dashboard display allowlist

`DASHBOARD_MODELS` is an optional non-secret Worker **text variable** that controls which logical models appear in the public dashboard's **模型状态** section.

Example:

```text
DASHBOARD_MODELS=Code-Ultra,Code-Max,Code-Pro,Ultra,Max,Pro,Air
```

Rules:

- unset or empty → show the full public model catalog;
- configured → show only matching public models;
- matching is case-insensitive and trims whitespace;
- official logical-model casing is preserved in the UI;
- unknown names are ignored and never create fake rows;
- duplicates are removed;
- the configured CSV order becomes the dashboard display order.

This variable is presentation-only. It does **not** change `/v1/models`, model registration, access-key allowlists, routing, model-family fallback, health decisions, D1 collection, or usage statistics. Existing `MODELS_CONFIG` visibility rules are applied first, so this allowlist cannot re-expose a model already hidden by registry configuration.

## Status states

| State | Meaning |
| --- | --- |
| `available` | A credible currently/recently usable path exists |
| `degraded` | Recent success exists but current candidates are all unavailable |
| `unobserved` | Configuration exists but there is not enough current/recent evidence |
| `unavailable` | No serving candidate exists, or candidates are explicitly unavailable with no recent success evidence |

A cold isolate with no D1 evidence should not be transformed into a false global outage claim.

## Recent evidence

The persisted evidence path reuses token-usage storage under `src/observability/token-usage-store.ts` and its submodules. The model-status projection queries recent per-model request evidence from the existing D1 aggregation rather than creating a second health database.

The current evidence window is 24 hours. Only real persisted request evidence is used; missing upstream usage is not fabricated merely to color the public status page.

## D1 failure behavior

Public status is fail-open as a presentation feature:

- no D1 binding → continue with runtime evidence;
- D1 read failure → continue without persisted evidence;
- empty recent-evidence result → do not invent success;
- presentation failure must not break the request-routing hot path.

A D1 problem must not automatically mark every model as available or unavailable.

## Privacy boundary

The public projection is model-level only. It must not expose:

- node ids;
- provider/tier/protocol/surface internals;
- upstream base URLs or credentials;
- cooldown/failure-reason internals;
- TTFT values;
- request bodies or user data.

The public status contract exists for service presentation, not operator debugging.

## Performance boundary

Recent model evidence is loaded as a shared query/cache input for dashboard rendering rather than one database query per node/model. Public status must stay outside the scheduler hot path.

## Source files

- `src/runtime/availability.ts` — isolate-local availability projection.
- `src/runtime/model-status.ts` — public model-state decision logic.
- `src/dashboard/model-status-view.ts` — dashboard-only display filtering and rendering.
- `src/observability/token-usage-store.ts` and `src/observability/token-usage-store/` — persisted usage/evidence access.
- dashboard modules — presentation only.

Any future status signal that is intended to affect routing must be designed as a separate reliability feature rather than quietly reusing this public projection.