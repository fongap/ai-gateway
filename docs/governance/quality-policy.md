# Quality policy

Quality gates protect behavior before deployment. The repository deliberately separates the fast merge gate from the full production gate.

## CI model

### Merge gate

`validate-merge` runs for Pull Requests and pushes. It executes the canonical merge validation and a Worker bundle dry-run:

```bash
npm ci
npm run validate:merge
npm run check:deploy
```

`validate:merge` covers syntax, version consistency, deployment configuration, migration governance, unit/contract suites, secret scanning, documentation checks, TypeScript type checking, and Markdown links.

### Production gate

`validate-deploy` runs on pushes to `main`, scheduled CI, and manual CI. It executes:

```bash
npm run validate:deploy
```

`validate:deploy` includes `test:all`: the unit suite plus scheduler-stability, integration, stress, Codex, and Claude contracts.

Automatic production deployment is permitted only when a **push-triggered** `main` CI run succeeds. Scheduled and manually triggered CI runs are test-only. Manual Deploy runs its own full validation before touching production.

## Behavioral contracts

Changes that touch a behavior must preserve or deliberately update the corresponding executable contract.

High-risk areas include:

- protocol and surface routing;
- Chat Completions ↔ Anthropic Messages fallback;
- OpenAI Responses Native-Only behavior;
- streaming first-event commit points;
- Tier 1 P2C, affinity, heat protection, RPM admission, and 429 recovery;
- Tier 2/3 selection and circuit state;
- logical-attempt, dispatch, hedge, and failover budgets;
- access-group authorization and node credential binding;
- deployment ordering and rollback;
- D1 retention and public model-status projection.

Do not rewrite a contract test merely because a new implementation disagrees with it. First decide whether the intended behavior actually changed.

## Protocol quality

The current built-in protocol fallback is exactly:

```json
{
  "anthropic:messages": ["openai:chat_completions"],
  "openai:chat_completions": ["anthropic:messages"]
}
```

OpenAI Responses is Native Only. Conversion fallback shares the existing request attempt and wall-clock budget; hedge twins do not cross protocols.

Conversion diagnostics must remain categorical and non-sensitive. Request bodies, prompts, JSON Schemas, credentials, and client tool names must not enter diagnostic logs.

## Reliability quality

Tier 1 heat protection is a bounded shaping refinement, not a second quota system.

- RPM headroom may soften selection before the hard gate.
- Affinity may decay toward neutral under heat but must not become a standalone penalty.
- Optional hedge twins may be suppressed when spare capacity is low.
- Primary eligibility remains controlled by the existing hard concurrency/RPM/cooldown rules.
- Success rate is not a positive routing reward.
- The implementation must not claim globally consistent provider quota without a real global coordination mechanism.

## Security gates

`npm run security:scan` must pass. Repository and review rules must prevent live credentials or private data from entering source, examples, logs, or diagnostics.

At minimum:

- node config must reject credential fields;
- upstream credentials live only in tier-scoped Secrets;
- gateway client keys use the grouped access-key model;
- client authorization headers and cookies are never forwarded upstream;
- HTTPS is the default upstream requirement;
- `/health` and `/metrics` remain authenticated;
- sensitive request bodies are not logged.

See [SECURITY.md](../../SECURITY.md).

## Documentation quality

Canonical documentation is part of the contract surface. CI checks structure and links, but review must also check factual agreement with source code and workflows.

Do not maintain two equal README implementations. `README.md` is canonical; localized documents must point back to it.

## Version/tag quality

A stable version tag is created only after the intended `main` commit has passed the full production gate and, for deployable changes, the production deployment/verification path has succeeded. Version and tag rules are defined in [version-policy.md](version-policy.md).

GitHub Releases are not required by the current service-deployment model. Existing Releases are historical records rather than a second version authority.
