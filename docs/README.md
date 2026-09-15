# ai-gateway documentation

This documentation describes the current repository contract. It is organized by responsibility so runtime facts, operating procedures, and governance rules do not compete as equal sources of truth.

## Documentation model

```text
docs/
├── architecture/     durable system boundaries and invariants
├── operations/       current configuration, deployment, and troubleshooting procedures
└── governance/       product boundary and rules for changing, validating, and documenting the system
```

History belongs in Git, Pull Requests and commits. Human-created tags or GitHub Releases may be used when the operator wants a named release; project release numbering is not maintained in source documentation.

## Architecture

| Document | Responsibility |
| --- | --- |
| [overview.md](architecture/overview.md) | System boundaries, request flow, fixed tier roles, and source-of-truth ownership |
| [protocol-model.md](architecture/protocol-model.md) | Native protocols, Chat ↔ Messages fallback, conversion fidelity, streaming boundaries |
| [routing-model.md](architecture/routing-model.md) | Tier routing, Tier 1 P2C, affinity, heat protection, attempts, hedge |
| [reliability-model.md](architecture/reliability-model.md) | Failure classification, cooldown, rate-limit recovery, TTFT, circuit behavior |
| [repository-layout.md](architecture/repository-layout.md) | Repository and module responsibilities |
| [calendar-heatmap.md](architecture/calendar-heatmap.md) | Dashboard calendar-heatmap contract |

## Operations

| Document | Responsibility |
| --- | --- |
| [configuration.md](operations/configuration.md) | Node, access-group, model, policy, and runtime configuration |
| [deployment.md](operations/deployment.md) | CI-to-production workflow, D1 migration, commit-SHA verification, rollback |
| [troubleshooting.md](operations/troubleshooting.md) | Configuration and runtime failure diagnosis |
| [provider-discovery.md](operations/provider-discovery.md) | Read-only provider capability observation |
| [public-model-status.md](operations/public-model-status.md) | Read-only public status projection |
| [github-repository-settings.md](operations/github-repository-settings.md) | Intended GitHub settings and canonical About metadata |

## Governance

| Document | Responsibility |
| --- | --- |
| [README.md](governance/README.md) | Governance index and authority model |
| [product-policy.md](governance/product-policy.md) | Household/small-team scope, Tier roles, clean replacement, human-owned release identity, simplicity boundary |
| [development-policy.md](governance/development-policy.md) | Branch, PR, refactor, clean-replacement, and architecture-change rules |
| [quality-policy.md](governance/quality-policy.md) | CI, tests, security, deployment identity, and production gates |
| [dependency-policy.md](governance/dependency-policy.md) | Dependency and toolchain update policy |
| [documentation-policy.md](governance/documentation-policy.md) | English-canonical documentation and code-to-doc synchronization |

## Authority order

Product direction is governed first by [product-policy.md](governance/product-policy.md): implementation must not silently expand ai-gateway beyond its household/individual/small-team scope or redefine the fixed Tier 1/2/3 roles.

For current executable behavior inside that product boundary, resolve conflicts in this order:

1. Runtime code, schemas, configuration parsers, tests, and workflows define what the repository actually does.
2. Canonical current documentation explains that behavior and must be corrected when it drifts.
3. Git history, PRs and commits explain how the current state was reached.

Documentation must not invent a capability that is absent from runtime, and runtime changes must not silently violate product policy.

## Entry points

- [README.md](../README.md) — canonical project landing page.
- [README.zh-CN.md](../README.zh-CN.md) — Simplified Chinese reader-facing mirror.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contribution workflow.
- [SECURITY.md](../SECURITY.md) — vulnerability reporting and secret-handling rules.
