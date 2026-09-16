# Quality policy

Quality gates protect behavior before deployment. The repository separates the merge gate from the full production gate.

## CI model

### Merge gate

`validate-merge` runs for Pull Requests and pushes:

```bash
npm ci
npm run validate:merge
npm run check:deploy
```

It covers syntax, deployment configuration, migration governance, unit/contract suites, secret scanning, documentation checks, TypeScript type checking, Markdown links, and a Worker bundle dry-run.

### Production gate

`validate-deploy` runs on pushes to `main`, scheduled CI, and manual CI:

```bash
npm run validate:deploy
```

It includes the unit suite plus scheduler-stability, integration, stress, Codex, and Claude contracts.

Automatic production deployment is permitted only when a push-triggered `main` CI run succeeds. Scheduled and manually triggered CI runs are test-only. Manual Deploy runs full validation before touching production.

## Behavioral contracts

Changes that touch a behavior must preserve or deliberately update the corresponding executable contract.

High-risk areas include:

- protocol and surface routing;
- Chat Completions ↔ Anthropic Messages fallback;
- OpenAI Responses Native-Only behavior;
- streaming first-event commit points;
- Tier 1 P2C, affinity, heat protection, RPM admission, and rate-limit recovery;
- Tier 2/3 selection and circuit state;
- logical-attempt, dispatch, hedge, and failover budgets;
- access-group authorization and node credential binding;
- deployment ordering and rollback;
- D1 retention and public model-status projection.

Do not rewrite a contract test merely because a new implementation disagrees with it. First decide whether intended behavior actually changed.

## Protocol quality

The built-in protocol fallback is exactly:

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

`README.md` is canonical; localized documents must point back to it.

## Release identity quality

Automation validates **deployment identity by commit SHA**, not project release numbering. `/health.build` must match the commit being deployed before production verification succeeds.

Project release numbering is human-owned and outside automated quality gates. If a named release is desired, a human may create a Git tag or GitHub Release after the desired commit is verified. CI must not generate, infer, advance, synchronize, or validate that numbering.
