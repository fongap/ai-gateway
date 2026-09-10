# Governance

The governance documents define how ai-gateway is changed. They are intentionally narrower than architecture documentation: governance controls the engineering process; it does not redefine runtime behavior.

## Principles

1. English is the canonical language for long-lived project documentation.
2. Runtime code, schemas, tests, and workflows remain the executable source of truth.
3. One long-lived document owns one responsibility.
4. Current behavior is documented without historical version labels unless the version is itself the subject.
5. Temporary plans, migration status, and completed work do not become permanent governance documents.
6. Rules are updated in place rather than copied into `latest`, `final`, `new`, or version-suffixed files.
7. History belongs in Git, Pull Requests, Issues, `CHANGELOG.md`, tags, and existing GitHub Releases.
8. Documentation changes must not be used to smuggle in runtime behavior changes.

## Governance documents

| Document | Authority |
| --- | --- |
| [development-policy.md](development-policy.md) | Branches, PRs, refactors, module boundaries, change discipline |
| [quality-policy.md](quality-policy.md) | CI gates, test expectations, security checks, production validation |
| [dependency-policy.md](dependency-policy.md) | npm, GitHub Actions, Wrangler, and dependency-update rules |
| [version-policy.md](version-policy.md) | Version source, stable-tag discipline, deployment/build identity |
| [documentation-policy.md](documentation-policy.md) | Canonical language, document ownership, synchronization rules |

## Document classes

| Directory | Purpose |
| --- | --- |
| `docs/architecture/` | Durable design boundaries and runtime invariants |
| `docs/operations/` | Current operator procedures and repository settings |
| `docs/governance/` | Rules for changing, validating, documenting, and versioning the system |

Completed migration plans are historical evidence, not permanent governance. If their facts remain relevant, those facts must be moved into the appropriate current architecture, operations, or governance document before the migration document is removed.

See [Documentation policy](documentation-policy.md) for the code-to-document mapping and drift rules.
