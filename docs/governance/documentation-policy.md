# Documentation policy

## Canonical language

Long-lived project documentation is English-canonical.

- `README.md` is the canonical repository landing page.
- Additional translations are optional. Localized root READMEs use `README.<locale>.md`, identify the English canonical document, and do not introduce independent behavior, configuration, or policy claims.
- Files under `docs/` use lowercase English `kebab-case.md`, except conventional `README.md` files.

## Source-of-truth model

Documentation explains executable behavior; it does not define behavior by itself.

When evidence conflicts, use this order:

1. Runtime code, configuration parsers/schemas, tests, and GitHub workflows determine current executable behavior.
2. Canonical current documentation summarizes that behavior and must be corrected when it drifts.
3. Git history, Pull Requests, Issues, commits, and human-created tags/Releases preserve historical context.

[product-policy.md](product-policy.md) is the governance authority for product scope, Tier roles, clean replacement, simplicity, and human-owned release identity.

Do not copy a transient implementation plan into a permanent policy document. Do not keep completed migration plans in `docs/governance/` solely for history.

## Document ownership

| Change area | Canonical documentation |
| --- | --- |
| Product scope, Tier roles, clean replacement, release identity | `docs/governance/product-policy.md` |
| `src/config/*` | `docs/operations/configuration.md` |
| `src/scheduler/*` | `docs/architecture/routing-model.md` |
| `src/reliability/*` | `docs/architecture/reliability-model.md` |
| `src/transport/*`, `src/protocol/*`, `src/conversion/*` | `docs/architecture/protocol-model.md` |
| `src/stream/*` | `docs/architecture/protocol-model.md`, `docs/architecture/reliability-model.md` |
| `src/runtime/*` public projection | `docs/operations/public-model-status.md` |
| Provider Discovery behavior | `docs/operations/provider-discovery.md` |
| deployment workflow / Wrangler bindings | `docs/operations/deployment.md` |
| supported local tooling entry points | `scripts/README.md` |
| test layout and execution | `tests/README.md` |
| repository settings / About metadata | `docs/operations/github-repository-settings.md` |
| top-level module layout | `docs/architecture/repository-layout.md` |
| CI and quality gates | `docs/governance/quality-policy.md` |
| dependency/toolchain policy | `docs/governance/dependency-policy.md` |
| public landing-page summary | `README.md` |

A behavior-changing PR updates its responsible canonical document in the same PR. A documentation-only PR may correct drift without changing runtime behavior.

## Current contract vs. history

Architecture and operations documents describe the **current contract**. Do not create numbered project-release copies, `latest`, `final`, or `new` variants of long-lived documents.

Project release numbering is not stored in documentation. If the operator wants a named release, a human creates a Git tag or GitHub Release manually. Current docs remain unnumbered and describe only the current contract.

Do not keep old runtime/configuration contracts alive merely because a retired implementation used them. History belongs in Git, not in compatibility branches inside current code.

## Avoid duplicated facts

High-drift values should have one executable owner whenever practical.

- Node requirement: `package.json.engines.node`.
- Runtime variable names/defaults: `src/config/runtime-vars.ts`.
- Error-kind vocabulary: `src/reliability/classify.ts`.
- Unit-suite registry: `tests/run-unit.mjs`.
- Wrangler pin: `scripts/cloudflare-wrangler.mjs`.
- Deployment identity: CI-selected Git commit SHA, exposed as `/health.build`.

Project release numbering deliberately has **no executable owner**. It is human-created outside the source contract when needed.

## README policy

`README.md` should answer, in this order:

1. what the gateway is and that it is intentionally scoped to household/individual/small-team use;
2. what protocols and reliability behavior it currently supports;
3. how to start and configure it;
4. where to find architecture, operations, governance, and security.

README may summarize permanent Tier roles, but [product-policy.md](product-policy.md) owns those rules.

Localized READMEs are reader-facing mirrors, not additional sources of truth.

## Documentation checks

The repository validates documentation through:

- `scripts/docs-check.mjs` — directory, naming, localized-README, and internal-link rules;
- `scripts/link-check.mjs` — Markdown link integrity;
- `tests/docs-contract-test.mjs` — executable guards against known architecture and configuration drift;
- `tests/product-policy-contract-test.mjs` — executable guard for permanent product scope, Tier roles, clean replacement, human-owned release identity, and simplicity rules.

A green docs check does not prove every sentence is current. Reviewers must still compare changed claims with their executable source.

## Deletion policy

Delete a long-lived document when its responsibility no longer exists or has been absorbed elsewhere. Git history is the archive. Do not keep obsolete documents merely to preserve historical narrative.
