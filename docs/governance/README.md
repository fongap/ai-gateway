# Governance

The governance documents define how ai-gateway is changed. Governance controls engineering process; it does not redefine runtime behavior.

## Principles

1. English is the canonical language for long-lived project documentation.
2. Runtime code, schemas, tests, and workflows remain the executable source of truth.
3. One long-lived document owns one responsibility.
4. Temporary plans, migration status, and completed work do not become permanent governance documents.
5. Rules are updated in place rather than copied into `latest`, `final`, `new`, or numbered project-release files.
6. History belongs in Git, Pull Requests, Issues, and human-created tags/Releases when needed.
7. Documentation changes must not be used to smuggle in runtime behavior changes.
8. Product scope and long-term Tier responsibilities are governed by [product-policy.md](product-policy.md); implementation must stay inside that boundary.
9. Retired ai-gateway behavior is not preserved through compatibility shims. The repository carries one current contract; Git carries history.
10. Project release numbering is human-owned. Source, configuration, docs, tests, CI and runtime do not generate, infer, synchronize or validate it.

## Governance documents

| Document | Authority |
| --- | --- |
| [product-policy.md](product-policy.md) | Product scope, Tier 1/2/3 roles, clean replacement, human-owned release identity, simplicity boundary |
| [development-policy.md](development-policy.md) | Branches, PRs, refactors, module boundaries, change discipline |
| [quality-policy.md](quality-policy.md) | CI gates, test expectations, security checks, production validation |
| [dependency-policy.md](dependency-policy.md) | npm, GitHub Actions, Wrangler, and dependency-update rules |
| [documentation-policy.md](documentation-policy.md) | Canonical language, document ownership, synchronization rules |

## Document classes

| Directory | Purpose |
| --- | --- |
| `docs/architecture/` | Durable design boundaries and runtime invariants |
| `docs/operations/` | Current operator procedures and repository settings |
| `docs/governance/` | Rules for changing, validating and documenting the system |

Completed migration plans are historical evidence, not permanent governance. If their facts remain relevant, move those facts into the appropriate current architecture, operations, or governance document before removing the migration document.

See [Documentation policy](documentation-policy.md) for the code-to-document mapping and drift rules.
