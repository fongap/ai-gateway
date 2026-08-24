[简体中文](README.md) | [English](README_EN.md)

# AI Agent Node Scheduler

**Personal AI Agent Resource Scheduling Layer**


[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-43853d?logo=node.js&logoColor=white)](package.json)

A personal AI agent resource scheduling layer running on Cloudflare Workers. It manages multiple AI providers through a `tier-1 / tier-2 / tier-3` three-tier node model, giving Coding Agents, office Agents, and local AI apps a low-cost, reliable entry point with automatic failover.

- OpenAI Chat Completions: `/v1/chat/completions`
- Anthropic Messages / Claude Code: `/v1/messages`
- Anthropic Token Count: `/v1/messages/count_tokens`

## Why this project exists

AI agents need to manage multiple providers, resource tiers, reliability characteristics, and rate limits at the same time. Keeping those differences inside every agent leads to scattered configuration and duplicated failure handling.

AI Agent Node Scheduler provides one entry point to:

- hide providers and API keys behind the Node abstraction, avoiding vendor lock-in;
- schedule across `tier-1 → tier-2 → tier-3` tier pools automatically, preferring free resources;
- fail over to same-tier or higher-tier nodes on node failures;
- expose both OpenAI and Anthropic-compatible endpoints;
- support long-running agents with streaming and tool calls;
- deploy an edge scheduling layer without servers or databases.

## Architecture

```
Logical Model (MODELS_CONFIG)
    ↓
Policy (POLICIES_CONFIG)
    ↓
Node Scheduler
    ↓
Node Pool (TIER1_NODES_CONFIG_01..)
    ↓
Provider / Account / API Key
```

### Three-tier Node Pool

| Tier | Positioning | Traits | Default role |
|------|-------------|--------|--------------|
| `tier-1` | Free pool | Lowest cost, uncertain stability | First choice |
| `tier-2` | Paid pool | Higher stability | Main fallback |
| `tier-3` | Plus pool | Highest reliability, highest cost | Critical tasks, long coding runs |

Default order: `tier-1 → tier-2 → tier-3`. Higher-tier nodes never preempt tier-1 nodes by being faster. Critical tasks can reverse the order via policy (`tier-3 → tier-2 → tier-1`).

### Code structure

```text
src/
├─ index.js                   Main entry (Node Scheduler request handling)
├─ config/
│  ├─ nodes.js                Node config loader + node model mapping
│  ├─ models.js               Logical model loader
│  ├─ policies.js             Policy loader
│  └─ node-state.js           Node runtime state management
├─ scheduler/
│  ├─ selector.js             Node selector (tier/priority/health/latency)
│  └─ router.js               Route planner
├─ reliability/
│  ├─ health.js               Health response builder
│  ├─ circuit.js              Lightweight circuit breaker
│  └─ retry.js                Retry budget + timeout splitting
├─ stream/
│  └─ guard.js                First Event Guard
└─ protocol/
   ├─ openai.js               OpenAI protocol utilities
   └─ anthropic.js            Anthropic protocol utilities
```

## Features

- **Three-tier node scheduling**: tier-1/tier-2/tier-3 pools ranked by workload/model/tier/priority/cooldown/circuit/concurrency/health/latency;
- OpenAI and Anthropic-compatible endpoints;
- Default route and method allowlist;
- Per-node 429 cooldown with Retry-After support — never disables a whole provider;
- Lightweight circuit breaker for 503/502/504 after 3 consecutive failures;
- First Event Guard: streaming failover allowed before the first valid event, forbidden after it;
- Split timeouts: `UPSTREAM_HEADERS_TIMEOUT` / `FIRST_EVENT_TIMEOUT` / `STREAM_IDLE_TIMEOUT`;
- Retry budget: tier-1 ≤2, tier-2 ≤1, tier-3 ≤1, total ≤5;
- Client cancellation does not penalize node health;
- Per-host model aliases, capabilities, and independent `invoke_url` values;
- Non-streaming and streaming conversion, images, and tool calls;
- Public `/version`; protected `/v1/models`, `/health`, `/metrics`;
- Optional Cloudflare Analytics Engine events.

## Scope and limitations

This project provides a stable entry point for multiple OpenAI-compatible upstreams. It is not an official Anthropic proxy, and it cannot create native Anthropic thinking signatures, exact token accounting, or unsupported protocol semantics on behalf of a third-party model.

`/health` and `/metrics` expose local state from the current Worker isolate. Node runtime state lives only in Worker memory — no KV, D1, or Durable Objects.

## Quick deployment

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

### Linux / macOS

```bash
chmod +x scripts/*.sh
./scripts/install.sh
```

The install script checks Node.js, runs full tests and Wrangler dry-run, confirms your Cloudflare account, validates configuration, auto-shards node configs at full node boundaries (`TIER1_NODES_CONFIG_01..`), deploys code and Secrets via restricted temporary files, and optionally verifies online endpoints. Temporary files are removed afterwards. Real credentials are never written to the repository.

### Updating an existing Worker

Update code while keeping existing runtime variables and Secrets:

```powershell
.\scripts\update.ps1
```

```bash
./scripts/update.sh
```

Modify keys, mappings, or Fallback:

```powershell
.\scripts\reconfigure.ps1
```

```bash
./scripts/reconfigure.sh
```

`wrangler.jsonc` declares `keep_vars: true`, so code updates never read or delete existing Secrets. First deployment does not require pre-existing Secrets; protected endpoints return explicit errors until configured.

## Auto-deploy from GitHub to Cloudflare

1. Push this repository to GitHub;
2. Create or select a Worker in the Cloudflare dashboard;
3. Connect this repository in the Worker's **Settings → Builds** with production branch `main`;
4. Use:

```text
Root directory: /
Build command: npm run build
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

5. Click **Save and Deploy** for the first deployment;
6. Visit `https://YOUR-WORKER.workers.dev/` — you will see the setup page;
7. Add `GATEWAY_ACCESS_KEY` and `TIER1_NODES_CONFIG_01` as Secrets in **Settings → Variables and Secrets**, then click Deploy;
8. The page auto-refreshes within 5 seconds once configuration is ready.

Multiple Workers can share one repository; each Worker keeps its own Secrets independently.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for details.

## Configuration

Configure JSON Secrets. Node configs are split into fixed two-digit numbered shards (each ≤4500 bytes, auto-split at full node boundaries):

| Variable | Purpose |
|----------|---------|
| `TIER1_NODES_CONFIG_01` | tier-1 node definition shard 1 (token embedded) |
| `TIER1_NODES_CONFIG_02` ... | Further tier-1 shards when nodes are many, consecutive numbering |
| `TIER2_NODES_CONFIG_01` ... | tier-2 node definition shards (optional) |
| `TIER3_NODES_CONFIG_01` ... | tier-3 node definition shards (optional) |
| `MODELS_CONFIG` | JSON object mapping logical models to workload/policy |
| `POLICIES_CONFIG` | JSON object defining policies |

**TIER1_NODES_CONFIG_01 example:**

```json
[
  {"id":"tier-1-node-01","tier":"tier-1","token":"sk-xxx@https://provider-a/v1","models":{"general-air":"tier-1-provider/model-air","code-pro":"tier-1-provider/code-pro"}}
]
```

Larger configs are automatically split by the install script at full node boundaries:

```text
TIER1_NODES_CONFIG_01
TIER1_NODES_CONFIG_02
TIER1_NODES_CONFIG_03
...
```

At runtime the shards are loaded in numeric order and transparently merged into one unified node pool — without affecting tier, provider, priority, models, concurrency, cooldown, circuit breaker, retry budget, or any other scheduling semantics.

**MODELS_CONFIG example:**

```json
{
  "general-air": {"workload":"general","policy":"general-fast"},
  "code-pro": {"workload":"coding","policy":"coding-stable"}
}
```

**POLICIES_CONFIG example:**

```json
{
  "general-fast": {"tiers":["tier-1","tier-2"],"max_attempts":3,"retry_budget":{"tier-1":2,"tier-2":1}},
  "coding-stable": {"tiers":["tier-1","tier-2","tier-3"],"max_attempts":4,"retry_budget":{"tier-1":2,"tier-2":1,"tier-3":1}}
}
```

Example files: `config/nodes.example.json`, `config/models.example.json`, `config/policies.example.json`.

### Node naming convention

Uniform format: `{tier}-node-{number}`

```
tier-1-node-01
tier-1-node-02
tier-2-node-01
tier-3-node-01
```

Names like `key1`, `token1`, `provider-key1`, `backup-key` are not allowed. Node IDs appear in logs, errors, and health states — they must be human-readable.

## Client usage

### OpenAI-compatible

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"general-air","messages":[{"role":"user","content":"Hello"}]}'
```

### Claude Code

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://YOUR-WORKER.workers.dev",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_GATEWAY_ACCESS_KEY",
    "ANTHROPIC_MODEL": "code-pro"
  }
}
```

## Diagnostics

```bash
curl https://YOUR-WORKER.workers.dev/version

curl https://YOUR-WORKER.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"

curl https://YOUR-WORKER.workers.dev/health \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"

curl https://YOUR-WORKER.workers.dev/metrics \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

`/health` and `/metrics` provide client request stats plus per-node attempts, successes, failures, active connections, and average latency. One client request may produce multiple node attempts. All data resets when the isolate recycles.

## Reliability mechanisms

### 429 handling

Treated as node-level limits: the node cools down and traffic shifts to other same-tier or higher-tier nodes. Honors `Retry-After`. Never disables an entire provider.

### 503 handling

503/502/504 are treated as node/provider anomalies. After 3 consecutive similar failures, a lightweight circuit breaker opens for 30 seconds, then enters half-open state for probing. Never permanently disables on first failure.

### First Event Guard

HTTP 200 does not mean success for streaming requests. The gateway waits for the first valid event before confirming success and committing the response to the client. Failover is allowed before the first event (empty streams, connection resets, malformed SSE, timeouts). Transparent switching is forbidden after it, preventing duplicate tool calls and corrupted JSON.

### Retry budget

| Workload | tier-1 | tier-2 | tier-3 | Total |
|----------|--------|--------|--------|-------|
| General | ≤2 | ≤1 | – | ≤3 |
| Coding | ≤2 | ≤1 | ≤1 | ≤4 |

Total capped at 5 to prevent retry storms.

## Local verification

```bash
npm ci
npm run verify
npm run check:deploy
```

Verification includes:

- Worker JavaScript syntax;
- Version consistency;
- Markdown local links;
- Dashboard, `/version`, `/v1/models`, `/health`, `/metrics` smoke tests;
- Node config shard tests (multi-shard per tier, numeric ordering, corrupted shard isolation, duplicate ID detection, 8/20 KB auto-splitting, legacy migration, etc.);
- Node Scheduler tests (12 cases);
- Reliability tests (12 cases: 429 cooldown, 503 circuit, Retry-After, retry budget, timeout splitting, client abort, etc.);
- Common secret format scanning.

## Security

- Do not commit `.dev.vars`, `.env`, `secrets*.json`;
- Do not paste real tokens, full auth headers, or user request bodies into Issues;
- Do not pass gateway keys via URL query parameters;
- Logs must never contain API keys, tokens, prompts, or responses — only Node IDs;
- `ALLOW_UNSAFE_PROXY_ROUTES=false`, `ALLOW_INSECURE_HTTP_UPSTREAM=false`, `EXPOSE_UPSTREAM_INFO=false` are default security postures;
- Compromised keys must be revoked immediately;
- Report vulnerabilities privately through GitHub Security Advisory.

See [SECURITY.md](SECURITY.md).

## Contributing

Run before submitting:

```bash
npm ci
npm run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT License](LICENSE)