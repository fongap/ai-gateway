# Tests

All executable test and contract suites live under `tests/`. Repository tooling lives under `scripts/`; production Worker code lives under `src/`.

Tests remain lightweight Node scripts so the repository does not need a test-framework runtime dependency.

## Layout

```text
tests/
├── run-unit.mjs                         ordered fast unit/contract registry
├── *-test.mjs                           unit and executable contract suites
├── integration-test.mjs                 real Worker pipeline integration suite
├── scheduler-stability-test.mjs         deterministic scheduler stability suite
├── codex-contract-test.mjs              Codex compatibility contract
├── claude-contract-test.mjs             Claude compatibility contract
├── stress-test.mjs                      stress/reliability load suite
├── provider-discovery-ssrf-guard-test.mjs
└── mock-d1-database.mjs                 shared D1 test helper
```

`tests/run-unit.mjs` is the source of truth for the ordered fast unit/contract suite list. `package.json` is the source of truth for aggregate gates. Repository-layout governance verifies that every `*-test.mjs` is registered by one of those sources.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run test:unit` | Run fast suites registered in `tests/run-unit.mjs` |
| `npm run test:gate` | Deterministic correctness gate: unit + scheduler stability + integration + Codex/Claude contracts |
| `npm run test:all` | `test:gate` + stress/reliability load coverage |
| `npm run test:integration` | Run the integration suite |
| `npm run test:conversion` | Run protocol conversion tests |
| `npm run validate:merge` | PR/merge correctness validation using `test:gate` |
| `npm run validate:deploy` | Full production validation using `test:all` |
| `npm run check:deploy` | Wrangler Worker bundle dry-run |

## Gate policy

A correctness regression that can block deployment must be detectable before merge. Therefore scheduler stability, integration, and Codex/Claude compatibility are part of `test:gate` and run in the required PR check. Stress remains an additional deploy/nightly layer.

Do not add one-shot workflows that rewrite tests or commit test fixes automatically. Temporary repair workflows must not remain in the default branch.

## Boundary

A file belongs in `tests/` when its purpose is to verify behavior and it is not used as an operator/CI tool on its own. A file belongs in `scripts/` when it performs repository maintenance, configuration, validation, installation, deployment, discovery, or other executable tooling independent of a test suite.

To add a test suite:

1. add `tests/<name>-test.mjs` and make failures exit non-zero;
2. register it in `UNIT_TESTS` in `tests/run-unit.mjs` when it belongs to the fast unit/contract registry, or add it to the appropriate aggregate package script;
3. run `npm run test:gate` for deterministic correctness changes;
4. run `npm run test:all` when stress/reliability behavior is affected;
5. update the responsible canonical document if the test changes a public or architectural contract.

Tests are executable contracts. Do not weaken a contract merely to make an unrelated implementation change pass.
