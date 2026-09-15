# Product policy

This document defines permanent product and architecture rules for ai-gateway. Runtime implementation may evolve, but changes must stay inside these boundaries unless this policy is explicitly revised first.

## Product scope

ai-gateway is a private AI API gateway for a household, an individual operator, or a small trusted team.

It is not a public SaaS gateway, enterprise API-management platform, reseller platform, billing system, or general multi-tenant control plane. Features that mainly serve those products are out of scope.

The product should remain simple to deploy, simple to understand, and simple to operate. Prefer a small number of explicit concepts over generalized frameworks, extension layers, compatibility shims, or speculative abstractions.

## Tier roles

### Tier 1 — free-token capacity

Tier 1 is the primary long-term operating layer and carries free or effectively free token capacity from multiple providers/accounts.

Its first priority is sustained availability. Tier 1 must remain stable, efficient, safe, and continuously usable under uneven quotas, rate limits, latency variation, and provider failures.

Tier 1 engineering should prioritize:

- multi-key and multi-provider resilience;
- adaptive recovery from real rate-limit/failure evidence;
- bounded load spreading rather than a single preferred key;
- predictable failover and stream safety;
- low hot-path overhead;
- protection against one bad account/provider degrading the whole pool;
- observability that distinguishes useful traffic from retry/fallback/hedge amplification.

Do not add speculative global coordination, guessed provider limits, or complex optimization machinery without production evidence that the simpler local design is insufficient.

### Tier 2 — membership/subscription entitlement capacity

Tier 2 is reserved for future adapters that expose AI capacity obtained through user membership or subscription entitlements.

Do not turn Tier 2 into another generic API-key pool. Keep it dormant and simple until a concrete subscription-entitlement adapter exists.

### Tier 3 — paid API capacity

Tier 3 is reserved for paid API capacity used as the final protected fallback layer.

Do not spend Tier 3 capacity to compensate for avoidable Tier 1 instability. Tier 3 should remain predictable, bounded, and easy to reason about.

## Clean replacement policy

ai-gateway maintains one current contract. It does not preserve retired configuration names, old fields, superseded internal contracts, or historical behavior.

When the design changes:

1. change the canonical implementation;
2. update schemas, tests, documentation, examples, and deployment configuration in the same change;
3. delete the superseded path;
4. do not add aliases, dual-read/dual-write paths, deprecation windows, compatibility switches, or shims solely to keep retired ai-gateway behavior alive;
5. use Git history and Pull Requests for history rather than carrying old behavior forward in runtime code.

Operator guidance may explain what must change, but runtime must not keep the retired contract alive after the change is accepted.

This rule does **not** remove intentional compatibility with external client/upstream protocols such as OpenAI Chat/Responses and Anthropic Messages. Protocol compatibility is a current product capability.

## Release identity rule

Project release numbering is human-owned only.

- Source files, configuration, documentation, tests, CI and runtime endpoints must not contain, generate, infer, synchronize, bump, or validate a project release number.
- `package.json` and lock metadata do not carry a project release number.
- Runtime deployment identity is the Git commit SHA exposed through authenticated `/health` and used by deployment verification.
- When a named release is desired, a human creates the Git tag or GitHub Release manually.
- Automation must never create or advance release numbering on behalf of the operator.

Dependency numbers, runtime requirements, protocol identifiers, migration sequence numbers, dates, and other technical identifiers are not project release numbering and remain explicit where required.

## Simplicity rule

Every new capability must justify itself for a household or small trusted team.

Default decision order:

1. Tier 1 reliability and continuous availability;
2. security and protocol correctness;
3. operational simplicity;
4. efficient use of free capacity;
5. clear Tier 2 / Tier 3 fallback boundaries;
6. extensibility only when a concrete use case already exists.

Prefer deletion over preserving obsolete transitional design. Prefer one current mechanism over old/new parallel mechanisms. Prefer an explicit adapter over a general plugin framework. Prefer local bounded state over distributed coordination until production evidence requires otherwise.

The project should not add, unless its product scope is deliberately changed first:

- public multi-tenancy;
- user billing or metering for resale;
- enterprise organization/RBAC hierarchies;
- marketplace/plugin ecosystems;
- generic workflow/orchestration platforms;
- speculative provider abstraction layers;
- cluster-wide quota coordination without measured need;
- compatibility layers whose only purpose is preserving retired ai-gateway behavior.

## Change review rule

Every architecture or feature PR must be checked against this policy. If a change increases complexity, it must state which concrete household/small-team problem it solves and why a simpler implementation is insufficient.

A change that conflicts with this policy must revise this document first; implementation must not silently redefine the product.
