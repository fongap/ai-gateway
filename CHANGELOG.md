# Changelog

This file records concise release-level changes. Current architecture and operating rules live in `docs/`.

## 1.3.5 - 2026-09-13

### Changed

- **Reliability semantics convergence**: model-family fallback stays inside the authenticated Gateway Key model scope; model-scoped 404s can continue bounded compatible-sibling fallback; streaming failover commits only after meaningful model output.
- **Capacity model cleanup**: removed node-level `limits`, guessed RPM admission, and configured concurrency ceilings from runtime scheduling. Live in-flight pressure remains a soft ranking signal; 429 recovery remains scoped to provider + key-slot.
- **Hedge and timeout contracts**: a configured hedge object is enabled unless explicitly set to `enabled:false`; policy first-event timeout cannot exceed the request-wide failover budget.
- **Configuration continuity**: omitted node `protocol` / `surfaces` retain the established defaults (`openai` + `chat_completions`, or `messages` for an explicit Anthropic protocol), so existing production node variables remain valid.
- **Maintenance**: removed stale migration-era comments and contradictory documentation without changing runtime scheduling or protocol behavior.

### Fixed

- HTTP 200 responses with invalid protocol bodies now rotate and count as upstream failures instead of remaining neutral.
- HTTP success accounting uses the complete 2xx range rather than only status 200.
- Migration CREATE scanning handles every matching statement rather than only the first matching offset.
- Authorization-scoped family fallback cannot widen the caller's permitted model set.

## 1.3.4 - 2026-09-12

### Changed

- Tier 1 adaptive 429 recovery uses the `15s → 30s → 1m → 2m → 5m → 15m → 30m → 60m` ladder when no stronger recovery signal exists.
- 429 state is isolated to `(provider, key-slot)` and burst-time duplicate 429s do not accelerate the ladder.
- Upstream `Retry-After` acts as a minimum recovery floor and never shortens learned cooldown.

## 1.3.3 - 2026-09-12

### Changed

- Model-family exhaustion caused only by transient capacity failures returns retryable `503`.
- `Retry-After` for family exhaustion reflects the earliest compatible sibling recovery time.

### Fixed

- Internal failure accounting preserves the real 429 cause even when the client-facing response is normalized to `503`.
- Family retryability is limited to explicitly transient failure classes.

## 1.3.2 - 2026-09-11

### Added

- Added bounded logical-model family fallback for Code, general, and one-way Air upgrade chains.
- Added provider + upstream-model 429 heat as a bounded soft ranking signal.

### Changed

- Model-family fallback shares the existing request attempt, dispatch, hedge, and wall-clock budgets.
- Required PR correctness coverage was expanded across scheduler, integration, compatibility, and reliability contracts.

### Fixed

- Daily Token totals are rebuilt from retained hourly data for completed UTC+8 day buckets.
- Model-shaped 404 isolation remains scoped to the affected mapping.

## 1.3.1 - 2026-09-09

### Changed

- Tier 1 RPM admission moved to a smoother token-bucket implementation for the then-active node-limit model.
- 429 recovery gained post-cooldown shaping and stricter account/model scoping.

## 1.3.0 - 2026-09-09

### Added

- Added bounded OpenAI Chat ↔ Anthropic Messages protocol fallback; OpenAI Responses remains native-only.
- Added build identity to `/version`, adaptive per-tier attempt budgeting, protocol-matrix coverage, and deployment correctness contracts.

### Changed

- Deployment workflows pin the triggering SHA and use one validated deploy path with rollback verification.
- TypeScript checking was expanded across request, config, reliability, and scheduler layers.

### Removed

- Removed the older protocol-conversion/profile implementation that was superseded by native OpenAI/Anthropic transport boundaries.

## 1.2.6 - 2026-09-06

### Changed

- Hardened the production gate, D1 migration ordering, rollback evidence, documentation governance, and typed request boundaries.
- Corrected Dashboard evidence windows, TTFT aggregation, calendar heatmap rendering, and canonical model display.

## 1.2.4 - 2026-08-29

### Fixed

- Deployment now blocks before D1 migration/Worker publish when validation fails.
- D1 query caching, bounded response reads, public error redaction, model-stat retention, and streaming memory guards were hardened.
- Added daily scheduled cleanup for retained model statistics.

## 1.2.3 - 2026-08-27

### Changed

- Replaced fallback-reserve heuristics with explicit per-tier attempt budgets.
- `MODELS_CONFIG` and `POLICIES_CONFIG` became fail-fast configuration surfaces.

### Fixed

- Fixed split UTF-8 decoding in streaming, endpoint-vs-model 404 classification, distributed limiter budget accounting, and Anthropic stream completion handling.

## 1.2.2 - 2026-08-27

### Fixed

- Prevented a wide failing Tier 1 from consuming the entire cross-tier request budget.
- Corrected model-scoped 404 cooldown, real blocking `Retry-After`, distributed limiter accounting, and client-abort stress coverage.

## 1.2.1 - 2026-08-26

### Fixed

- Hardened node capacity enforcement, streaming relay completion, first-event error detection, model capability defaults, and half-open/circuit accounting.

### Changed

- Unified configuration readiness semantics and reduced topology leakage in client responses.
- Split request authentication, routing, and error-building responsibilities into dedicated modules.

## 1.2.0 - 2026-08-26

### Fixed

- Closed half-open probe leaks and invalid-model-map wildcard behavior.
- Added fail-fast node schema validation and a request-wide failover budget.

### Added

- Added the Model Registry, topology-hiding controls, and expanded integration/reliability regression coverage.

## Historical 6.x line

### 6.1.0 - 2026-08-25

- Added the first full OpenAI Responses surface, provider capability/profile descriptors, contract coverage for Codex/Claude clients, and a public status homepage.

### 6.0.0 - 2026-08-24

- Redesigned node configuration and secret separation, removed the earlier token-in-URL configuration model, unified routing/reliability boundaries, and established dynamic candidate selection with guarded streaming.

## Historical 5.x line

### 5.14.0 - 2026-08-06

- Hardened route validation, secret/config checks, streaming safety, response bounds, deployment scripts, and fallback handling.

### 5.13.0 - 2026-08-06

- Added safe update behavior, HTTPS/route protections, stricter model routing, and fallback health controls.

### 5.12.0 - 2026-08-06

- Added the model-list endpoint, public version endpoint, release/validation automation, bilingual documentation, and deployment packaging support.

### 5.11.0 - 2026-08-06

- Established the AI-Gateway project identity, unified gateway access configuration, and organized the public Cloudflare Workers project structure.
