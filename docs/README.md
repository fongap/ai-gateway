# ai-gateway documentation

This documentation describes the current repository contract. It is organized by responsibility so runtime facts, operating procedures, governance rules, and version history do not compete as equal sources of truth.

## Documentation model

```text
docs/
├── architecture/     durable system boundaries and invariants
├── operations/       current configuration, deployment, and troubleshooting procedures
└── governance/       rules for changing, validating, documenting, and versioning the system
```

Historical version changes belong in [CHANGELOG.md](../CHANGELOG.md), Git tags, Pull Requests, commits, and existing GitHub Releases. Completed migration plans and temporary project-status documents do not remain in the long-lived documentation tree.

## Architecture

| Document | Responsibility |
| --- | --- |
| [overview.md](architecture/overview.md) | System boundaries, request flow, and source-of-truth ownership |
| [protocol-model.md](architecture/protocol-model.md) | Native protocols, Chat ↔ Messages fallback, conversion fidelity, streaming boundaries |
| [routing-model.md](architecture/routing-model.md) | Tier routing, Tier 1 P2C, affinity, heat protection, attempts, hedge |
| [reliability-model.md](architecture/reliability-model.md) | Failure classification, cooldown, 429 recovery, TTFT, circuit behavior |
| [repository-layout.md](architecture/repository-layout.md) | Repository and module responsibilities |
| [calendar-heatmap.md](architecture/calendar-heatmap.md) | Dashboard calendar-heatmap contract |

## Operations

| Document | Responsibility |
| --- | --- |
| [configuration.md](operations/configuration.md) | Node, access-group, model, policy, and runtime configuration |
| [deployment.md](operations/deployment.md) | CI-to-production workflow, D1 migration, verification, rollback |
| [troubleshooting.md](operations/troubleshooting.md) | Configuration and runtime failure diagnosis |
| [provider-discovery.md](operations/provider-discovery.md) | Read-only provider capability observation |
| [public-model-status.md](operations/public-model-status.md) | Read-only public status projection |
| [github-repository-settings.md](operations/github-repository-settings.md) | Intended GitHub settings and canonical About metadata |

## Governance

| Document | Responsibility |
| --- | --- |
| [README.md](governance/README.md) | Governance index and authority model |
| [development-policy.md](governance/development-policy.md) | Branch, PR, refactor, and architecture-change rules |
| [quality-policy.md](governance/quality-policy.md) | CI, tests, security, and production gates |
| [dependency-policy.md](governance/dependency-policy.md) | Dependency and toolchain update policy |
| [release-policy.md](governance/release-policy.md) | Version, stable-tag, deployment/build, and historical Release rules |
| [documentation-policy.md](governance/documentation-policy.md) | English-canonical documentation and code-to-doc synchronization |

## Authority order

When documents disagree with executable behavior, resolve the conflict in this order:

1. Runtime code, schemas, configuration parsers, tests, and workflows define what the repository actually does.
2. Canonical current documentation explains that behavior and must be corrected when it drifts.
3. `CHANGELOG.md`, tags, existing Releases, PRs, and commits explain how the current state was reached.

Documentation must not invent a capability that is absent from the runtime.

## Entry points

- [README.md](../README.md) — canonical project landing page.
- [README.zh-CN.md](../README.zh-CN.md) — Simplified Chinese reader-facing mirror.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contribution workflow.
- [SECURITY.md](../SECURITY.md) — vulnerability reporting and secret-handling rules.
- [CHANGELOG.md](../CHANGELOG.md) — version history.
