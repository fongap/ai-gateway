# Tests

## Layout

```
tests/
├── run-unit.mjs         # Unit test runner (loads scripts/*-test.mjs)
└── README.md            # This file
```

### Test files

Unit, integration, stress, and contract tests currently live in
`scripts/` alongside their tooling dependencies (e.g.
`mock-d1-database.mjs`). The `tests/run-unit.mjs` runner loads the
unit-test files in order and propagates the first non-zero exit code.

### npm scripts

| Script | Description |
|---|---|
| `npm run test:unit` | Run `tests/run-unit.mjs` (18 unit-test suites) |
| `npm run test:all` | Run unit + integration + stress + contract tests |
| `npm run validate:merge` | `check` + `check:version` + `check:deployment-config` + `test:unit` + `security:scan` + `check:docs` + `typecheck` |

### Adding a new unit test

1. Create `scripts/<name>-test.mjs` — it must `process.exit(1)` on
   failure.
2. Add the file path to `UNIT_TESTS` in `tests/run-unit.mjs`.
3. Run `npm run test:unit` to verify.

### File-naming convention

- `scripts/*-test.mjs` — test files (run by `npm test`).
- `scripts/*.mjs` (no `-test` suffix) — tooling scripts (deploy,
  config CLI, docs check, etc.).
