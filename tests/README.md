# Tests

The runtime is protected by layered unit, integration, stress, protocol, deployment, and client-compatibility contracts. Test files intentionally remain lightweight Node scripts instead of introducing a runtime or test framework dependency.

## Layout

```text
tests/
├── run-unit.mjs     # ordered unit-suite runner
└── README.md

scripts/
├── *-test.mjs       # unit and contract suites
├── integration-test.mjs
├── stress-test.mjs
├── codex-contract-test.mjs
└── claude-contract-test.mjs
```

`tests/run-unit.mjs` is the source of truth for the current unit-suite list. Do not duplicate a hard-coded suite count in documentation.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run test:unit` | Run the suites registered in `tests/run-unit.mjs` |
| `npm run test:all` | Unit + scheduler stability + integration + stress + Codex + Claude contracts |
| `npm run validate:merge` | Merge-gate validation: syntax, version, deployment config, migrations, unit tests, security, docs, types, links |
| `npm run validate:deploy` | Full production validation including `test:all` |
| `npm run check:deploy` | Wrangler Worker bundle dry-run |

## Adding a unit suite

1. Add `scripts/<name>-test.mjs` and make failures exit non-zero.
2. Register it in `UNIT_TESTS` in `tests/run-unit.mjs`.
3. Run `npm run test:unit`.
4. If the test encodes a public or architectural behavior, update the responsible canonical document in the same PR.

Tests are executable contracts. Do not weaken a contract merely to make an unrelated implementation change pass.
