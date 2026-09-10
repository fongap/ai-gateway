# Documentation policy

## Canonical language

Long-lived project documentation is English-canonical.

- `README.md` is the canonical repository landing page.
- Additional translations are optional. Localized root READMEs use `README.<locale>.md` (for example `README.zh-CN.md`), must identify the English canonical document, and must not introduce independent behavior, configuration, or policy claims.
- Files under `docs/` use lowercase English `kebab-case.md`, except conventional `README.md` files.

## Source-of-truth model

Documentation explains executable behavior; it does not define behavior by itself.

When evidence conflicts, use this order:

1. Runtime code, configuration parsers/schemas, tests, and GitHub workflows determine current executable behavior.
2. Canonical current documentation summarizes that behavior and must be corrected when it drifts.
3. `CHANGELOG.md`, Git tags, existing GitHub Releases, Pull Requests, Issues, and commits preserve historical context.

Do not copy a transient implementation plan into a permanent policy document. Do not keep completed migration plans in `docs/governance/` solely for history.

## Document ownership

| Change area | Canonical documentation |
| --- | --- |
| `src/config/*` | `docs/operations/configuration.md` |
| `src/scheduler/*` | `docs/architecture/routing-model.md` |
| `src/reliability/*` | `docs/architecture/reliability-model.md` |
| `src/transport/*`, `src/protocol/*`, `src/conversion/*` | `docs/architecture/protocol-model.md` |
| `src/stream/*` | `docs/architecture/protocol-model.md`, `docs/architecture/reliability-model.md` |
| `src/runtime/*` public projection | `docs/operations/public-model-status.md` |
| Provider Discovery tooling | `docs/operations/provider-discovery.md` |
| deployment workflow / Wrangler bindings | `docs/operations/deployment.md` |
| repository settings / About metadata | `docs/operations/github-repository-settings.md` |
| top-level module layout | `docs/architecture/repository-layout.md` |
| CI and quality gates | `docs/governance/quality-policy.md` |
| dependency/toolchain policy | `docs/governance/dependency-policy.md` |
| version/tag mechanism | `docs/governance/release-policy.md` |
| public API surface or project positioning | `README.md` |

A behavior-changing PR updates its responsible canonical document in the same PR. A documentation-only PR may correct drift without changing runtime behavior.

## Current contract vs. history

Architecture and operations documents describe the **current contract**. Avoid headings such as “v1.3.0 routing”, “latest architecture”, or “final configuration” in long-lived documents.

Use version labels only where version identity matters, for example:

- `CHANGELOG.md` entries;
- Git tags;
- existing historical GitHub Releases;
- compatibility notes tied to a real version boundary;
- an active migration document that will be removed when the migration is complete.

Do not create parallel documents named `*-v2.md`, `*-latest.md`, `*-final.md`, `*-new.md`, `misc.md`, or `temp.md`.

## Avoid duplicated facts

High-drift values should have one executable owner whenever practical.

- Software version: `package.json.version`.
- Node requirement: `package.json.engines.node`.
- Runtime variable names/defaults: `src/config/runtime-vars.ts`.
- Error-kind vocabulary: `src/reliability/classify.ts`.
- Unit-suite registry: `tests/run-unit.mjs`.
- Wrangler pin: `scripts/cloudflare-wrangler.mjs`.

Documentation may summarize these values, but should point back to the owner and must be updated when the summary changes. README badges that can read an executable source directly should prefer that over a duplicated hard-coded value.

## README policy

`README.md` should answer, in this order:

1. what the gateway is;
2. what protocols and reliability behavior it currently supports;
3. how to start and configure it;
4. where to find architecture, operations, governance, security, and history.

Keep implementation-detail inventories out of the README when a dedicated document already owns them.

Localized READMEs are reader-facing mirrors, not additional sources of truth. They should follow the canonical README structure closely enough to remain easy to synchronize, while links to architecture, operations, governance, security, and history continue to target the canonical English documents.

## Documentation checks

The repository validates documentation through:

- `scripts/docs-check.mjs` — directory, naming, localized-README, and internal-link rules;
- `scripts/link-check.mjs` — Markdown link integrity;
- `scripts/docs-contract-test.mjs` — guards against known architecture and configuration drift.

A green docs check does not prove every sentence is current. Reviewers must still compare changed claims with their executable source.

## Deletion policy

Delete a long-lived document when its responsibility no longer exists or has been absorbed elsewhere. Git history is the archive. Do not keep obsolete documents merely to preserve historical narrative.
