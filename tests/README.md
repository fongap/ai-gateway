# Tests

All executable test and contract suites live under `tests/`. Repository tooling lives under `scripts/`; production Worker code lives under `src/`.

Tests remain lightweight Node scripts so the repository does not need a test-framework runtime dependency.

## Layout

```text
tests/
├── run-unit.mjs                         ordered unit/contract registry
├── *-test.mjs                           unit and executable contract suites
├── integration-test.mjs                 integration suite
├── stress-test.mjs                      stress/reliability suite
├── scheduler-stability-test.mjs         scheduler stability suite
├── codex-contract-test.mjs              Codex compatibility contract
├── claude-contract-test.mjs             Claude compatibility contract
├── provider-discovery-ssrf-guard-test.mjs
└── mock-d1-database.mjs                 shared D1 test helper
```

`tests/run-unit.mjs` is the source of truth for the ordered unit/contract suite list. Do not duplicate a hard-coded suite count in documentation.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run test:unit` | Run suites registered in `tests/run-unit.mjs` |
| `npm run test:all` | Unit + scheduler stability + integration + stress + Codex + Claude contracts |
| `npm run test:integration` | Run the integration suite |
| `npm run test:conversion` | Run protocol conversion tests |
| `npm run validate:merge` | Merge-gate validation |
| `npm run validate:deploy` | Full production validation including `test:all` |
| `npm run check:deploy` | Wrangler Worker bundle dry-run |

## Boundary

A file belongs in `tests/` when its purpose is to verify behavior and it is not used as an operator/CI tool on its own. A file belongs in `scripts/` when it performs repository maintenance, configuration, validation, installation, deployment, discovery, or other executable tooling independent of a test suite.

To add a unit/contract suite:

1. add `tests/<name>-test.mjs` and make failures exit non-zero;
2. register it in `UNIT_TESTS` in `tests/run-unit.mjs` when it belongs to the merge suite;
3. run `npm run test:unit`;
4. update the responsible canonical document if the test changes a public or architectural contract.

Tests are executable contracts. Do not weaken a contract merely to make an unrelated implementation change pass.
