# Tooling

`scripts/` contains repository, operator, CI, configuration, deployment, validation, and provider-discovery tools. It is not a home for Worker runtime code, tests, or benchmarks.

## Supported entry points

| Purpose | Entry point |
| --- | --- |
| First-time local bootstrap | `scripts/install.sh` / `scripts/install.ps1` |
| Reconfigure an existing local/operator deployment | `scripts/reconfigure.sh` / `scripts/reconfigure.ps1` |
| Direct local code deploy | `npm run deploy` |
| Local Worker development | `npm run dev` |
| Cloudflare login / identity / tail | `npm run cf:login`, `npm run cf:whoami`, `npm run tail` |
| Configuration inspection | `npm run config:check`, `npm run config:show`, `npm run config:diff` |
| Provider Discovery | `npm run discovery:check`, `npm run discovery:summary` and the manual workflow |
| Version synchronization | `npm run version:sync` |

Production deployment remains repository-driven through GitHub Actions. Local entry points are operator tools; they do not replace the production CI gate.

## Wrangler ownership

`scripts/cloudflare-wrangler.mjs` is the single repository owner of the pinned Wrangler version and the common direct-CLI behavior. It also enforces the required Tier 1 affinity binding and D1 migration-before-Worker ordering for real local deploys.

Do not copy the Wrangler version into package scripts, installers, reconfiguration scripts, or new wrappers. Route Cloudflare CLI calls through `cloudflare-wrangler.mjs`.

## Configuration tooling

- `config-cli.mjs` inspects, validates, displays, and compares operator configuration.
- `node-config-shards.mjs` owns node-config/secret shard validation and planning primitives.
- `plan-node-configuration.mjs` exposes those primitives as a CLI.
- `github-deployment-config.mjs` bridges GitHub Variables/Secrets into the production deployment payload.
- `deploy-gate-decision.mjs` decides whether a completed CI run is eligible to deploy.

`wrangler.jsonc` is tracked baseline configuration. Operator-specific Worker name, bindings, and local variables belong in the gitignored `wrangler.user.jsonc`; bootstrap tooling must not rewrite the tracked baseline.

## Validation tooling

The repository uses focused executable checks under `scripts/`, including syntax, version, deployment configuration, migrations, documentation, links, and secret scanning. Tests for these tools live under `tests/`.

## Operator probes

`health-check.*`, `models-check.*`, and `metrics-check.*` are deliberately small platform-native Shell/PowerShell probes. They remain separate so credentials can be prompted without introducing a cross-platform interactive dependency or a large abstraction for three simple endpoints.

## Provider Discovery

`scripts/provider-discovery/` is a read-only advisory subsystem for capability snapshots, normalization, diffs, runtime consistency checks, reporting, and SSRF protection. It does not mutate Runtime Node configuration or join the AI request hot path.

## What does not belong here

- Worker runtime code → `src/`
- executable tests/contracts/test-only helpers → `tests/`
- performance measurement → `benchmark/`
- persistent configuration examples → `config/`
- D1 schema changes → `migrations/`
- long-lived design and policy documentation → `docs/`

Do not add compatibility aliases such as `setup-and-deploy.*`, `update.*`, or duplicate `deploy.*` wrappers when an existing supported entry point already owns the action.
