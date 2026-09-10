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

Discovery never needs to POST generation requests merely to decide whether a provider should be considered supported.

## Runtime consistency

The runtime comparison uses a sanitized projection such as:

```text
id
provider
protocol
surfaces
base_url
```

Credentials are excluded.

Warnings are advisory and severity-ranked. A base-URL difference is a difference, not proof that either URL is invalid.

## CLI

```bash
npm run discovery:check
npm run discovery:summary

node scripts/provider-discovery.mjs check-snapshot <catalog.json>
node scripts/provider-discovery.mjs summary <catalog.json>
node scripts/provider-discovery.mjs diff <before.json> <after.json> [--out FILE] [--json-out FILE]
node scripts/provider-discovery.mjs runtime-check <catalog.json> <runtime-view.json> [--json-out FILE]
```

Exit code `2` indicates a high-priority runtime consistency warning; it is not an automatic runtime mutation signal.

## Workflow

`.github/workflows/provider-discovery.yml` is manually runnable and intentionally decoupled from required merge CI so third-party metadata instability cannot block normal PRs.

Required CI validates the Discovery implementation with offline tests. External observation remains an explicit operator workflow.

## Security

Discovery must never:

- load or persist API credentials, authorization headers, cookies, or user request data;
- synthesize a provider URL from an untrusted provider name;
- use credential-bearing URLs;
- perform destructive or configuration-writing actions;
- become a runtime dependency of `src/request`, `src/scheduler`, `src/reliability`, `src/transport`, `src/protocol`, `src/conversion`, or `src/stream`.

The catalog is evidence for review, not an authority above the running configuration.
