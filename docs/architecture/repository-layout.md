# Repository layout

The repository separates Worker runtime code, configuration examples, operational tooling, tests, migrations, and long-lived documentation. Directory ownership is part of the architecture contract.

```text
src/                         Cloudflare Worker runtime
├── config/                  env parsing, nodes, Model Registry, policies, provider quirks, version
├── scheduler/               Tier 1 P2C/affinity selection and Tier 2/3 candidate selection
├── reliability/             failure classification, Tier 1 state/heat, Tier 2/3 node state
├── transport/               upstream paths, protocol headers, native transport behavior
├── protocol/                client validation, CORS, protocol-specific request/error behavior
├── conversion/              Chat Completions ↔ Anthropic Messages conversion only
├── stream/                  first-event guards, SSE parsing, stream lifecycle
├── request/                 request orchestration, tier loop, fallback, attempt boundary
│   └── attempt/             dispatch, hedge, success, outcome, attempt observability
├── observability/           logs, metrics, D1/token usage, safe diagnostics
├── runtime/                 runtime availability and read-only public model status
└── dashboard/               public/operator presentation

scripts/                     repository tooling and executable test contracts
├── *-test.mjs               unit/contract suites
├── integration-test.mjs     integration suite
├── stress-test.mjs          stress/reliability suite
├── codex-contract-test.mjs  Codex compatibility contract
├── claude-contract-test.mjs Claude compatibility contract
├── cloudflare-wrangler.mjs  pinned Wrangler wrapper and local deploy behavior
└── provider-discovery/      read-only provider catalog/diff/report tooling

tests/
├── run-unit.mjs             canonical ordered unit-suite registry
└── README.md

config/                      public example configuration
benchmark/                   performance benchmarks
migrations/                  ordered D1 migrations
docs/                        long-lived documentation
├── architecture/
├── operations/
└── governance/

.github/
├── workflows/               CI, Deploy, Provider Discovery
├── ISSUE_TEMPLATE/
├── pull_request_template.md
└── dependabot.yml
```

## Runtime boundaries

`src/` contains Worker runtime source. Tests and operational scripts do not belong in `src/` unless they are actually imported into the Worker runtime.

Key ownership rules:

- `config` builds trusted internal configuration from untrusted/external environment data.
- `scheduler` chooses; it does not call providers directly.
- `reliability` records availability/failure state; it does not convert request protocols.
- `request` orchestrates existing domain modules; it should not copy their logic.
- `transport` owns upstream HTTP semantics after a node is chosen.
- `conversion` owns only the explicit Chat ↔ Messages bridge.
- `observability` and `runtime` projections must not feed public/D1 evidence back into routing unless a future design explicitly changes that contract.

## Tier 1 files

The current Tier 1 design is intentionally split by responsibility:

- `src/scheduler/tier1-scheduler.ts` — Eligibility → Affinity → P2C selection and slot claim.
- `src/scheduler/tier1-affinity.ts` — hashed session binding, cache, and escape decision.
- `src/reliability/tier1-state.ts` — isolate-local RPM, in-flight, TTFT, cooldown, half-open, quota state.
- `src/reliability/tier1-heat.ts` — bounded RPM-headroom/affinity/hedge heat protection.

Tier 2/3 continue to use their separate scheduler/reliability path.

## Conversion files

`src/conversion/result.ts` adds fidelity/diagnostic/structured-output strategy information around the existing direct converters. It does not create a new all-protocol IR and does not make OpenAI Responses convertible.

## Documentation layout

`docs/` contains only long-lived current documentation:

- `architecture/` — what the system is and which invariants are durable;
- `operations/` — how the current system is configured and operated;
- `governance/` — how changes are proposed, validated, documented, and released.

Temporary status, completed migrations, and historical implementation plans belong in PRs/issues/history rather than permanent docs.

## File rules

- `docs/**/*.md` uses lowercase `kebab-case.md` except conventional `README.md`.
- `scripts/*-test.mjs` is reserved for executable test/contract files.
- `.dev.vars`, `.env*`, `secrets*.json`, and `wrangler.user.jsonc` remain local/gitignored.
- A new top-level directory requires a durable responsibility that does not overlap an existing owner.
- Do not add a second directory merely to represent “new”, “final”, or version-specific copies of an existing responsibility.
