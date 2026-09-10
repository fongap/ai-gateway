# Development policy

## Main branch

`main` is the single long-lived development branch and the source for production deployment.

- Changes reach `main` through Pull Requests.
- Required checks must pass before merge.
- Force pushes and branch deletion should be blocked by repository rules.
- Squash merge is the intended merge strategy so `main` keeps one commit per accepted change.

The repository Ruleset is the source of truth for required review count and required status checks; do not duplicate a review-count assumption here.

## Branch names

Use a short prefix that describes the type of change:

```text
feat/      user-visible capability
fix/       defect or compatibility fix
refactor/  behavior-preserving structure change
docs/      documentation and governance
ci/        CI/workflow change
test/      tests and contracts
chore/     maintenance without product behavior change
```

## Commit messages

Use concise Conventional Commit-style subjects that describe behavior or intent rather than a file list.

```text
fix: preserve tool-result errors across fallback
docs: align routing documentation with tier1 heat protection
refactor: isolate request orchestration boundary
test: cover hard-rpm recovery after 429
```

## Pull Request scope

One PR should have one primary objective. A PR must make it possible to answer:

- What problem is being solved?
- What behavior changes?
- What behavior explicitly does not change?
- How was the change verified?
- What are the protocol, routing, latency/resource, security, and deployment impacts?
- Which canonical documents changed with the code?

Do not mix unrelated cleanup into a correctness fix. If a separate defect is discovered, record it and handle it independently unless it blocks the current objective.

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

The long-lived module responsibilities are:

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

## Runtime dependency discipline

Prefer Web Standard APIs, Node built-ins used by tooling, and small local implementations. Runtime dependencies should remain zero or minimal unless a dependency has a clear reliability/security benefit that outweighs bundle and maintenance cost.

Do not add a framework merely to reorganize code. In particular, architecture work must not introduce a DI container, service locator, repository framework, or general transformation framework without a demonstrated requirement.

TypeScript is a development/tooling choice and must not require a runtime framework. Source imports use the repository's current TypeScript/ESM conventions and must remain compatible with Node and Wrangler validation.

## Performance discipline

Do not optimize for theoretical zero allocation. Prevent measurable and unnecessary request-hot-path regression.

Review especially for:

- repeated config/env parsing;
- repeated JSON parse/stringify;
- unnecessary deep cloning or buffering;
- unnecessary D1/KV reads in the request path;
- full-pool sorting where bounded selection is sufficient;
- global coordination added without evidence that local shaping is insufficient.

For a change expected to affect the request hot path, run `npm run bench` before and after the change under the same machine, Node.js version, and comparable repository state. Use the delta as regression evidence. Benchmark absolute values are not a production SLA, cross-machine score, or provider-latency measurement. See [`benchmark/README.md`](../../benchmark/README.md).

## Breaking changes

A breaking public or configuration change requires:

1. explicit PR labeling/description;
2. migration guidance;
3. canonical documentation updates;
4. `CHANGELOG.md` entry;
5. an appropriate version change under [version-policy.md](version-policy.md).

Documentation-only wording changes and factual drift corrections do not require a version bump.

## Documentation

Follow [documentation-policy.md](documentation-policy.md). Runtime behavior changes and the document that owns that behavior should normally be updated in the same PR.
