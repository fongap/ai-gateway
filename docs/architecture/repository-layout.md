# Repository layout

The repository has one durable owner for each class of work: Worker runtime, tests, tooling, configuration examples, migrations, benchmarks, and documentation. Physical placement should make that ownership obvious.

```text
src/                         Cloudflare Worker runtime
├── config/                  environment parsing, nodes, Model Registry, policies, provider quirks, version
├── scheduler/               Tier 1 P2C/affinity and Tier 2/3 candidate selection
├── reliability/             failure classification, cooldowns, quota/heat/state
├── transport/               upstream paths, headers, native transport behavior
├── protocol/                client validation, CORS, protocol-specific request/error behavior
├── conversion/              Chat Completions ↔ Anthropic Messages conversion only
├── stream/                  first-event guards, SSE parsing, stream lifecycle
├── request/                 request orchestration, tier loop, fallback, attempt boundary
│   └── attempt/             dispatch, hedge, success, outcome, attempt observability
├── observability/           logs, metrics, D1/token usage, safe diagnostics
├── runtime/                 runtime availability and read-only public model status
└── dashboard/               public/operator presentation

tests/                       all executable test/contract code
├── run-unit.mjs             canonical ordered unit/contract registry
├── *-test.mjs               unit and executable contract suites
├── integration-test.mjs     integration suite
├── stress-test.mjs          stress/reliability suite
├── scheduler-stability-test.mjs
├── codex-contract-test.mjs  Codex compatibility contract
├── claude-contract-test.mjs Claude compatibility contract
└── mock-d1-database.mjs     shared test helper

scripts/                     repository/operator/CI tooling
├── check-*.mjs              validation tools
├── *-check.mjs              focused repository checks
├── config-cli.mjs           configuration inspection/diff CLI
├── node-config-shards.mjs   node configuration planning/sharding
├── github-deployment-config.mjs
├── cloudflare-wrangler.mjs  pinned Wrangler wrapper and deploy behavior
├── install.* / update.* / deploy.* / reconfigure.*
└── provider-discovery/      read-only provider catalog/diff/report implementation

config/                      public configuration examples
benchmark/                   performance benchmarks
migrations/                  ordered D1 migrations
docs/                        long-lived current documentation
├── architecture/            durable system boundaries and invariants
├── operations/              current configuration/deployment/operator procedures
└── governance/              rules for changing and validating the system

.github/
├── workflows/               CI, Deploy, Provider Discovery
├── ISSUE_TEMPLATE/
├── pull_request_template.md
└── dependabot.yml
```

## Ownership rules

`src/` contains only code that is part of the Worker product/runtime. Test-only helpers and executable contracts belong in `tests/`. Repository, deployment, installation, configuration, discovery, and validation tools belong in `scripts/`.

A file is a **test** when its primary purpose is to verify behavior and failure is meaningful only as test evidence. A file is a **script/tool** when operators, CI, or maintainers invoke it to perform an independent repository action. Tests may exercise tools in `scripts/`; the tool itself does not move into `tests/`.

`benchmark/` remains separate because a benchmark measures performance rather than asserting correctness. `migrations/` remains separate because migration order and immutability are deployment contracts, not test fixtures.

## Runtime boundaries

- `config` builds trusted internal configuration from external environment data.
- `scheduler` chooses an eligible node; it does not call providers directly.
- `reliability` records availability/failure state; it does not convert protocols.
- `request` orchestrates domain modules; it should not duplicate their logic.
- `transport` owns upstream HTTP semantics after a node is selected.
- `conversion` owns only the explicit Chat ↔ Messages bridge.
- `observability` and public runtime projections do not feed historical/D1 evidence back into routing unless that contract is explicitly redesigned.

## Tier 1 ownership

- `src/scheduler/tier1-scheduler.ts` — Eligibility → Affinity → P2C selection and slot claim.
- `src/scheduler/tier1-affinity.ts` — hashed session binding, cache, and escape decision.
- `src/reliability/tier1-state.ts` — isolate-local RPM, in-flight, TTFT, cooldown, half-open, quota state.
- `src/reliability/tier1-heat.ts` — bounded RPM-headroom/affinity/hedge heat protection.

Tier 2/3 retain their separate scheduler/reliability path.

## Conversion ownership

`src/conversion/result.ts` adds fidelity, diagnostics, and structured-output strategy around the direct converters. It does not introduce a universal protocol IR and does not make OpenAI Responses convertible.

## File rules

- `tests/` is the only normal home for executable tests and test-only helpers.
- `scripts/` must not accumulate `*-test.mjs` files.
- `docs/**/*.md` uses lowercase `kebab-case.md` except conventional `README.md`.
- `.dev.vars`, `.env*`, `secrets*.json`, and `wrangler.user.jsonc` remain local/gitignored.
- A new top-level directory requires a durable responsibility that does not overlap an existing owner.
- Do not create `new`, `final`, `latest`, or version-suffixed copies of an existing responsibility.
