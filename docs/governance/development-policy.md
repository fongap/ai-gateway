# Development policy

## Main branch

`main` is the single long-lived development branch and the source for production deployment.

- Changes reach `main` through Pull Requests.
- Required checks must pass before merge.
- Force pushes and branch deletion should be blocked by repository rules.
- Squash merge is the intended merge strategy so `main` keeps one commit per accepted change.

The repository Ruleset is the source of truth for required review count and required status checks.

## Branch names

Use a short prefix that describes the type of change:

```text
feat/      user-visible capability
fix/       defect or current-contract fix
refactor/  structure or simplification
docs/      documentation and governance
ci/        CI/workflow change
test/      tests and contracts
chore/     maintenance without product behavior change
```

## Commit messages

Use concise Conventional Commit-style subjects that describe behavior or intent rather than a file list.

## Pull Request scope

One PR should have one primary objective. A PR must make it possible to answer:

- What problem is being solved?
- What behavior changes?
- What behavior explicitly does not change?
- How was the change verified?
- What are the protocol, routing, latency/resource, security, and deployment impacts?
- Which canonical documents changed with the code?
- Does the change stay inside [product-policy.md](product-policy.md)?
- If complexity increased, what concrete household/small-team problem requires it?

Do not mix unrelated cleanup into a correctness fix unless it directly blocks the objective.

## Behavior-preserving refactors

A refactor that claims behavior preservation must not silently change:

- public API paths, status codes, headers, or error envelopes;
- protocol conversion or fallback order;
- stream/non-stream behavior or first-event commit semantics;
- scheduler selection semantics;
- attempt, hedge, or failover budgets;
- timeout, cooldown, half-open, or circuit behavior;
- configuration meaning or credential scope;
- D1 retention or public-status semantics.

Tests are the primary evidence of behavior preservation. Types support that evidence but do not replace runtime contracts.

## Architecture boundaries

```text
config         parse configuration; own Model Registry, policy, Runtime Node construction
scheduler      choose which eligible node receives a request
reliability    track whether a node/account/model is currently usable and how failures affect state
request        orchestrate a request across modules
transport      communicate with an upstream protocol endpoint
protocol       validate client protocol and construct protocol-specific errors
conversion     bridge only explicitly supported cross-protocol fallback semantics
stream         first-event guards, SSE parsing, stream lifecycle
observability  logs, metrics, token usage, safe diagnostics
runtime        runtime availability and read-only public status projection
dashboard      public/operator presentation
```

`src/request` is orchestration. It must not duplicate scheduler, reliability, transport, protocol, conversion, or stream domain logic.

Provider labels are metadata and known-quirk selectors. They must not become an implicit source of model capabilities.

Tier roles are fixed by [product-policy.md](product-policy.md): Tier 1 is free-token capacity and the primary reliability focus; Tier 2 is reserved for membership/subscription entitlements; Tier 3 is reserved for paid API capacity.

## Runtime dependency discipline

Prefer Web Standard APIs, Node built-ins used by tooling, and small local implementations. Runtime dependencies should remain zero or minimal unless a dependency has a clear reliability/security benefit that outweighs bundle and maintenance cost.

Do not add a framework merely to reorganize code. In particular, architecture work must not introduce a DI container, service locator, repository framework, general transformation framework, plugin marketplace, or generic control-plane abstraction without a demonstrated household/small-team requirement.

## Performance discipline

Prevent measurable and unnecessary request-hot-path regression. Review especially for repeated config/env parsing, repeated JSON work, unnecessary buffering, avoidable D1/KV reads, full-pool sorting, and speculative global coordination.

Use focused regression tests and production observability as evidence.

## Clean replacement rule

ai-gateway keeps one current contract. When a public/configuration/runtime contract changes:

1. update the canonical implementation;
2. update configuration, schema, tests, examples and documentation in the same change;
3. remove the superseded path in the same change;
4. do not add deprecated aliases, dual-read/dual-write behavior, compatibility switches, shims, or temporary old/new parallel mechanisms solely to keep retired ai-gateway behavior alive;
5. document any operator action required to adopt the new current contract;
6. record history in Git and Pull Requests, not runtime compatibility code.

External OpenAI/Anthropic protocol compatibility remains when it is part of the current product surface.

Project release numbering is not an engineering automation concern. Source, configuration, tests, docs and CI do not carry or advance it. A human may create a Git tag or GitHub Release when desired; deployment correctness is tied to commit SHA.

## Documentation

Follow [documentation-policy.md](documentation-policy.md). Runtime behavior changes and the document that owns that behavior should normally be updated in the same PR.
