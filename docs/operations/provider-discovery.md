# Provider Discovery

Provider Discovery is read-only operational tooling for tracking external protocol/surface evidence. It is not part of request routing and must never mutate production node configuration.

## Boundary

```text
External provider evidence
        ↓
Discovery catalog
        ↓
normalize / semantic diff
        ↓
runtime consistency report
        ↓
human review
        ↓
explicit configuration change, if justified
```

The critical rule is one-way flow: Discovery may report that runtime configuration and observed provider capability disagree; it does not disable nodes, rewrite models, change base URLs, or alter tiers automatically.

## Wire contract

Discovery reads the same account-level Node Config used by runtime: `id`, `provider`, `base_url`, `models`, and optional node `priority`. Protocol and routable surfaces are not account fields. They come from `src/config/provider-profile.ts`, which is the single Provider Wire Profile used by both runtime and Discovery.

Current wire profiles are:

- `anthropic` → Anthropic `messages`;
- `openai` → OpenAI `chat_completions` + `responses`;
- other provider names → OpenAI-compatible `chat_completions`.

A valid Node Config must not add `protocol` or `surfaces` to override this contract.

## Catalog model

The catalog records provider observations for OpenAI and Anthropic protocol families, including known base URLs and surfaces.

Support state is three-valued:

- `true` — supported by current evidence;
- `false` — evidence indicates unsupported;
- `null` — unknown/unconfirmed.

Unknown is not equivalent to unsupported.

Current catalog surfaces include:

- OpenAI: `chat_completions`, `responses`;
- Anthropic: `messages`, `count_tokens` as discovery metadata.

`count_tokens` is discovery metadata; the runtime node schema models Anthropic `messages` as the routable Anthropic surface.

## Evidence discipline

Discovery distinguishes configured/official/verified/unknown evidence according to the catalog schema. The tooling must not claim active generation verification when it only read documentation or safe metadata.

Live Model Discovery performs two bounded observations:

1. `GET /v1/models` using the configured node credential;
2. a surface probe using an intentionally invalid empty `POST {}` request.

The surface probe is not a valid generation request and must not contain a prompt, user content, or a real model workload. Its purpose is only to distinguish an existing endpoint from an unsupported endpoint by status code.

## Runtime consistency

The runtime comparison uses a sanitized projection such as:

```text
id
provider
protocol
surfaces
base_url
```

Credentials are excluded from snapshots, reports, artifacts, logs, and diffs.

Warnings are advisory and severity-ranked. A base-URL difference is a difference, not proof that either URL is invalid.

## CLI

```bash
npm run discovery:check
npm run discovery:summary

node scripts/provider-discovery.mjs check-snapshot <catalog.json>
node scripts/provider-discovery.mjs summary <catalog.json>
node scripts/provider-discovery.mjs diff <before.json> <after.json> [--out FILE] [--json-out FILE]
node scripts/provider-discovery.mjs runtime-check <catalog.json> <runtime-view.json> [--json-out FILE]
node scripts/provider-discovery.mjs live --previous <previous-models.json> --out-dir <directory>
```

Exit code `2` indicates a high-priority runtime consistency warning; it is not an automatic runtime mutation signal.

## Workflow

`.github/workflows/model-discovery.yml` runs daily at `04:15 UTC` and may also be started manually. It is intentionally decoupled from required merge CI so third-party availability cannot block normal pull requests.

The workflow temporarily receives the same Node Config variables and Node Secret shards required to authenticate provider observations. Credentials exist only in the controlled GitHub Actions environment for the duration of the run. They must never be written into discovery snapshots, artifacts, reports, logs, or repository files.

Required CI validates the Discovery implementation with offline tests. External observation remains background operational evidence, not a merge requirement and not a runtime dependency.

## Security

Discovery must never:

- persist or log API credentials, authorization headers, cookies, or user request data;
- synthesize a provider URL from an untrusted provider name;
- use credential-bearing URLs;
- follow a URL or redirect that fails structural or DNS-backed SSRF validation unless `ALLOW_PRIVATE_DISCOVERY` is explicitly enabled for a trusted private provider;
- perform destructive or configuration-writing actions;
- become a runtime dependency of `src/request`, `src/scheduler`, `src/reliability`, `src/transport`, `src/protocol`, `src/conversion`, or `src/stream`.

The catalog is evidence for review, not an authority above the running configuration.
