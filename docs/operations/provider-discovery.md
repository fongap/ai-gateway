# Provider Discovery (v1.1)

> Runtime Node Config = production fact.
> Discovery Catalog = external observation / auxiliary fact.

Provider Discovery tracks Provider **protocol capability**, **surface support**, and **base URL** state across the ecosystem used by the gateway. It exists to answer, in plain prose:

- Which Providers support which protocols?
- Does Provider X support OpenAI Chat Completions? OpenAI Responses?
- Does Provider X support Anthropic Messages? Anthropic `count_tokens`?
- What base URL does Provider X use for each protocol?
- Where did each piece of information come from?
- How did Provider capability change compared with the previous snapshot?
- Is current Runtime Node configuration consistent with the Catalog?

It does **not** mutate Runtime Node configuration, the Model Registry, Worker Variables, or Worker Secrets. Discovery Catalog output is **advisory only**.

## Boundary

```text
Provider Capability
        ↓
Discovery Catalog
        ↓
Semantic Diff
        ↓
GitHub Report
        ↓
Human Review
        ↓
Node / Model Registry Config
```

The Catalog is read by humans and CI alike; nothing in the request hot path imports it. The Runtime request hot path (`src/request/handler.js` → `src/scheduler/` → `src/transport/`) is intentionally untouched by Discovery and never reads from `scripts/provider-discovery/*`.

## Catalog schema (v1.1)

```json
{
  "schema_version": "1.1",
  "providers": {
    "<provider>": {
      "openai": {
        "supported": true,
        "base_url": "https://api.example.com/v1",
        "surfaces": ["chat_completions"],
        "evidence": "configured"
      },
      "anthropic": {
        "supported": null,
        "base_url": null,
        "surfaces": [],
        "evidence": "unknown"
      }
    }
  }
}
```

Three-state support: `true` (supported), `false` (verified-unsupported), `null` (unknown / not confirmed). Surface absence is `unknown`, **never** `unsupported` (§四 of v1.1).

### Surfaces

| Protocol    | Allowed surfaces                                  |
|-------------|---------------------------------------------------|
| `openai`    | `chat_completions`, `responses`                   |
| `anthropic` | `messages`, `count_tokens`                        |

`count_tokens` is advisory in the Catalog: the Runtime Node schema (`src/config/nodes.js`) does not currently model it as a `surfaces` entry, so the Runtime consistency layer does not emit a Runtime conflict on `count_tokens` mismatches. The Catalog still records it.

### Evidence levels

| Level        | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `configured` | From operator-maintained configuration (Discovery snapshot, runtime)   |
| `official`   | From the Provider's official documentation                              |
| `verified`   | Confirmed via a safe metadata endpoint (`GET /models`, official docs)   |
| `unknown`    | No reliable source available                                            |

`verified` is **never** claimed by code that performs generation requests. Discovery never POSTs to `/v1/chat/completions`, `/v1/responses`, or `/v1/messages`.

## Local CLI

`scripts/provider-discovery.mjs`:

```bash
# Validate and inspect a snapshot.
npm run discovery:check

# Print a short protocol/surface capability summary.
npm run discovery:summary

# Subcommands (the script also accepts these directly):
node scripts/provider-discovery.mjs check-snapshot <catalog.json>
node scripts/provider-discovery.mjs summary       <catalog.json>
node scripts/provider-discovery.mjs diff          <before.json> <after.json> \
                                                [--out FILE] [--json-out FILE]
node scripts/provider-discovery.mjs runtime-check <catalog.json> <runtime-view.json> \
                                                [--json-out FILE]
```

### Exit codes

| Code | Meaning                                                          |
|------|------------------------------------------------------------------|
| 0    | Success, no P0/P1 issues                                         |
| 1    | Generic failure (bad args, missing files)                        |
| 2    | At least one P0 or P1 Runtime consistency warning emitted        |

## Semantic diff

`scripts/provider-discovery/diff.js` produces a stable, sorted diff with severity tagging:

| Kind                          | Default severity |
|-------------------------------|------------------|
| `protocol_support_changed`    | P1 (true→false/null), P2 (false/null→true) |
| `surface_support_changed`     | P1 (supported→unknown), P2 (unknown→supported) |
| `base_url_changed`            | P3 (metadata only) |

Severity buckets per §十二 of v1.1:

| Priority | Meaning                                                                  |
|----------|--------------------------------------------------------------------------|
| **P0**   | Runtime in use, Catalog marks it unsupported                              |
| **P1**   | Confirmed removal, Runtime capability mismatch, supported→unsupported, supported→unknown |
| **P2**   | New capability, missing model, new model                                  |
| **P3**   | Other metadata change                                                    |

Diff output is invariant to:

- Provider key order in source JSON
- Surface array order
- Trailing slash on base URL pathname
- `/models` endpoint result ordering

## Runtime consistency check

`scripts/provider-discovery/runtime-check.js` compares a sanitized Runtime Node projection against the Catalog and emits warnings. The runtime view is intentionally a *projection* — `id`, `provider`, `protocol`, `surfaces`, `base_url` only — and **must never** include credentials.

The check is read-only. It never:

- Disables a node
- Deletes a node
- Modifies `protocol`, `surfaces`, or `base_url`
- Changes a tier
- Touches the Model Registry

Warnings are sorted P0 → P3 and printed to stdout (or written to `--json-out`).

`base_url` differences are reported as **differs** (not **invalid**). The check never claims the configured URL is dead — that would require positive evidence Discovery does not gather.

## Reports

### `changes.md`

`scripts/provider-discovery/report.js#formatChangesMarkdown` writes a human-readable Markdown report with sections:

- `## Changed` — grouped by provider, each change is one bullet.
- `## Added` / `## Removed` — provider-level transitions.
- `## Runtime consistency` — sorted warning list.
- `## Catalog snapshot` — one row per (provider, protocol).
- `## Notes` — v1.1 invariants pinned.

### GitHub Action Summary

`formatActionSummary` writes a short summary suitable for `$GITHUB_STEP_SUMMARY`:

```text
# Provider Discovery

Providers checked: 4

## Protocol support (supported only)

- OpenAI Chat: 3
- OpenAI Responses: 1
- Anthropic Messages: 2
- Anthropic count_tokens: 1

## Catalog changes

- Added providers: 0
- Removed providers: 0
- Protocol changes: 0
- Surface changes: 0
- Base URL changes: 0

## Runtime consistency

- Runtime configuration warnings: P0=0, P1=0, P2=0, P3=0
```

When P0 warnings are present, the Summary surfaces an explicit callout.

## Workflow

`.github/workflows/provider-discovery.yml` runs the pipeline on a nightly schedule (04:00 UTC) and on `workflow_dispatch`. It:

1. Reads the previous and current catalog snapshot.
2. Normalizes both.
3. Computes the diff.
4. Runs the Runtime consistency check.
5. Uploads `changes.md`, JSON artifact, and runtime warnings as a single Artifact.

The workflow is **not** part of required CI (`npm run verify`). It is intentionally decoupled so that a flaky third-party endpoint cannot break PR merges. Required CI only runs the unit-test path (`scripts/provider-discovery-test.mjs`), which is offline.

## Security

The Discovery module never:

- Reads or persists secrets (Authorization headers, API keys, bearer tokens, cookies).
- Synthesizes URLs from provider names.
- Performs active probes (POST generation requests, speed tests, health probes).
- Modifies production configuration.

Credential-bearing URLs (`user:pass@host`) and credential-like tokens (`sk-…`, `ghp_…`, `AKIA…`) in the `base_url` field are dropped with a warning. The runtime-view loader only reads fields explicitly projected from Runtime Node config; `credential` (the secret field) is never loaded.

## Module layout

```
scripts/
├── provider-discovery.mjs               # CLI driver
├── provider-discovery-test.mjs          # unit test (offline)
└── provider-discovery/
    ├── catalog-schema.js                # schema constants + validation
    ├── normalize.js                     # normalize / sort / canonicalize
    ├── diff.js                          # semantic diff + severity
    ├── runtime-check.js                 # Runtime consistency check
    ├── report.js                        # changes.md + Action Summary formatters
    ├── load-snapshot.js                 # snapshot + runtime view loaders
    ├── index.js                         # public re-exports
    └── samples/
        ├── catalog.example.json         # example catalog
        └── runtime-view.example.json    # example sanitized runtime view
```

The Discovery module never imports from `src/runtime`, `src/scheduler`, `src/transport`, `src/request`, `src/reliability`, `src/stream`, `src/conversion`, `src/observability`, or `src/protocol`. This is enforced by an invariant test.

## Tests

`scripts/provider-discovery-test.mjs` covers:

- Provider Capability schema (tri-state, surfaces, evidence)
- Normalization (stable sort, secret-stripping, base URL canonicalization)
- Diff semantics (added/removed/changed; severity mapping)
- Runtime consistency (mismatch, base URL drift, no auto-mutation)
- Report formatters (markdown, summary, JSON)
- Security invariants (no secrets in any output path)
- Boundary invariants (no coupling to runtime hot path)

Run with:

```bash
node scripts/provider-discovery-test.mjs
```

The test is part of `npm run verify` via `npm run test:required`.