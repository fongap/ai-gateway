# Contributing

ai-gateway favors focused, evidence-backed changes over broad rewrites. Runtime behavior, protocol compatibility, routing, reliability, and deployment semantics are treated as explicit contracts.

## Development setup

```bash
git clone https://github.com/fongap/ai-gateway.git
cd ai-gateway
npm ci
npm run validate:merge
npm run check:deploy
```

Use Node.js **>=22.18.0**.

## Pull requests

1. Create a focused branch using `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `ci/`, or `chore/`.
2. Keep one primary objective per PR.
3. Add or update regression coverage for behavior changes.
4. Update the canonical documentation in the same PR when behavior, configuration, deployment, protocol, or operational semantics change.
5. Run `npm run validate:merge` and `npm run check:deploy`.
6. Use squash merge after required checks pass.

PR descriptions should state the problem, behavior change, verification, compatibility impact, resource impact, and security impact. A refactor must state whether external behavior changed; behavior-preserving refactors must not quietly alter scheduler, protocol, timeout, cooldown, fallback, or configuration semantics.

## Repository ownership

- `src/` — Cloudflare Worker runtime.
- `tests/` — executable tests, contracts, and test-only helpers.
- `scripts/` — repository, CI, configuration, installation, deployment, and discovery tooling.
- `benchmark/` — performance measurements.
- `migrations/` — ordered D1 schema changes.
- `docs/` — long-lived architecture, operations, and governance documentation.

Do not place test files back under `scripts/`; tests may exercise scripts, but tooling and verification have separate owners.

## Documentation responsibilities

`README.md` is the canonical project landing page. The documentation tree is English-canonical:

- [Architecture](docs/architecture/overview.md) — durable design boundaries and invariants.
- [Operations](docs/operations/configuration.md) — configuration and deployment procedures.
- [Governance](docs/governance/README.md) — development, quality, dependency, version/tag, and documentation policy.
- [CHANGELOG.md](CHANGELOG.md), Git tags, PRs, commits, and existing GitHub Releases — historical evidence.

GitHub Releases are not part of the normal future service-version lifecycle. Stable source boundaries use Git tags under the [version/tag policy](docs/governance/version-policy.md).

Do not create temporary `latest`, `final`, `new`, or version-suffixed copies of long-lived documentation. Update the responsible document directly.

## Core governance

- [Development policy](docs/governance/development-policy.md)
- [Quality policy](docs/governance/quality-policy.md)
- [Dependency policy](docs/governance/dependency-policy.md)
- [Version/tag policy](docs/governance/version-policy.md)
- [Documentation policy](docs/governance/documentation-policy.md)

## Security

Never commit or paste live API keys, bearer tokens, authorization headers, private upstream URLs, request bodies, or user data. Report vulnerabilities through the private process described in [SECURITY.md](SECURITY.md).
