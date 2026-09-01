# Deployment

ai-gateway deploys from GitHub Actions. Push to `main` (or run the workflow manually) and the deploy job validates the configuration, syncs Worker variables and secrets, applies D1 migrations, publishes the Worker, and runs live health checks.

The configuration source is the GitHub repository's **Variables** (non-sensitive) and **Secrets** (credentials). The Cloudflare Dashboard is never a daily configuration surface; the deploy job owns every runtime variable (`keep_vars: false`) and does not retain Dashboard drift.

---

## 1. First-time deployment

1. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
2. Create a Cloudflare KV namespace for Tier 1 session affinity and copy its 32-character namespace ID.
3. Create the **Variables** and **Secrets** listed in §2 and §3, including `TIER1_AFFINITY_KV_ID`.
4. Push to `main` (or run the **Deploy** workflow from the Actions tab).

The deploy job runs a **preflight** check first. If any required Variable or Secret is missing, the workflow **fails** with a clear `ERROR:` line naming the exact missing item — it never silently skips.

The order inside the job is:

```
checkout → setup Node → npm ci
  → Preflight deployment configuration
  → npm run verify
  → Validate runtime configuration
  → Wrangler deploy --dry-run
  → Cloudflare authentication check
  → Synchronize Worker Secrets
  → Apply D1 migrations (if TOKEN_STATS_D1_ID is set)
  → Deploy Worker
  → Verify deployed gateway
  → Deployment summary
```

Any verification or validation step that fails blocks every subsequent step — the Worker, its Secrets, and D1 are never touched.

---

## 2. GitHub Variables

Variables hold non-sensitive configuration. Create them under **Settings → Secrets and variables → Actions → Variables**.

| Variable | Required | Notes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | yes | Resource identifier, not a credential. |
| `GATEWAY_PUBLIC_BASE_URL` | yes | `https://` URL of the deployed Worker (no trailing `/v1`). |
| `TOKEN_STATS_D1_ID` | optional | D1 database ID. When set, D1 migrations are applied automatically. |
| `TIER1_AFFINITY_KV_ID` | yes when Tier 1 is configured | Cloudflare KV namespace ID used by the required `TIER1_AFFINITY` binding. Affinity must work across Worker isolates; preflight fails if this is missing. |
| `TIER1_NODES_CONFIG_01` … `TIER1_NODES_CONFIG_10` | at least one tier variable total | JSON array of node configs for tier 1. The fixed range goes to `_10`; raise it in `.github/workflows/deploy.yml` if you need more. |
| `TIER2_NODES_CONFIG_01` … `TIER2_NODES_CONFIG_10` | optional | Same shape, tier 2. |
| `TIER3_NODES_CONFIG_01` … `TIER3_NODES_CONFIG_10` | optional | Same shape, tier 3. |
| `MODELS_CONFIG` | optional | Model registry overrides; the registry supplies conservative defaults if absent. |
| `POLICIES_CONFIG` | optional | Attempt budgets and per-tier policy; defaults apply if absent. |
| `DEPLOY_ENABLED` | only on Forks | Set to `true` to opt a Fork into the deploy job. Ignored on the main repository. |

Each `TIER*_NODES_CONFIG_XX` value is a JSON array of node objects:

```json
[
  {
    "id": "nvidia-01",
    "provider": "nvidia",
    "base_url": "https://integrate.api.nvidia.com/v1",
    "priority": 10,
    "models": { "general-air": "deepseek-ai/deepseek-v3.1" },
    "limits": { "concurrency": 3, "rpm": 40 }
  }
]
```

Sharding rules:

- The deploy job splits long tier arrays into `_01`, `_02`, … shards automatically; you only see this on the Cloudflare side. The fixed range of 10 shards per tier is a safety limit; raise it in the workflow if you need more.
- A single shard must be smaller than 4500 bytes.
- Set the actual content directly as the Variable value — paste the JSON.
- **Do not** put credentials inside `TIER*_NODES_CONFIG_*`. The `forbidden_fields` list rejects `token`, `credential`, `api_key`, `apikey`, `authorization`, `password`, `secret`.

`MODELS_CONFIG` and `POLICIES_CONFIG` are plain JSON objects, e.g.:

```json
{ "fast": { "max_attempts": 5 }, "stable": { "max_attempts": 3 } }
```

The generated Wrangler config binds the namespace as:

```jsonc
"kv_namespaces": [
  { "binding": "TIER1_AFFINITY", "id": "<TIER1_AFFINITY_KV_ID>" }
]
```

Affinity keys contain a SHA-256 digest of the client-supplied `x-session-id`, never the raw session value. Values contain only the safe Tier 1 account ID and expire after 30 minutes.

---

## 3. GitHub Secrets

Secrets hold credentials. Create them under **Settings → Secrets and variables → Actions → Secrets**.

| Secret | Required | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yes | Cloudflare deploy token. |
| `GATEWAY_ACCESS_KEY` | yes | Bearer token clients send to the gateway. |
| `NODE_SECRETS_01` … `NODE_SECRETS_20` | at least one | JSON object `{ "node-id": "credential" }`. The fixed range is 20; raise it in the workflow if you need more. |

`NODE_SECRETS_XX` value shape:

```json
{ "nvidia-01": "nvapi-xxxxxxxx", "openrouter-01": "sk-or-xxxxxxxx" }
```

Multiple credentials in a single shard are fine; the deploy job packs shards until the 4500-byte Cloudflare limit is reached, so prefer bundling related credentials.

**Never** store the `GATEWAY_ACCESS_KEY` or `NODE_SECRETS_XX` values in commit history, issues, or chat logs.

---

## 4. Add a new node

1. Edit the matching `TIER*_NODES_CONFIG_XX` Variable — append the new node object, or split into a new shard if the existing shard is near 4500 bytes.
2. Add the credential to a `NODE_SECRETS_XX` Secret (or create a new one if the shard is full).
3. Push to `main` (or run the Deploy workflow).

Nothing else needs to change. No other Variable, Secret, or shard is touched.

---

## 5. Edit a node

Modify the matching `TIER*_NODES_CONFIG_XX` Variable. Common changes:

- **URL or model mapping** → edit the node JSON, push.
- **Priority / limits** → edit the node JSON, push. Priority affects Tier 2/3 only; Tier 1 P2C ignores it.

The Secret is untouched unless the credential itself is being rotated (see §6).

---

## 6. Rotate one API key

1. Edit the `NODE_SECRETS_XX` Secret that contains the node. Update the value to a new JSON object with the new credential.
2. Push to `main` (or run the Deploy workflow).

Other `NODE_SECRETS_XX` shards and `GATEWAY_ACCESS_KEY` are untouched. The previous credential is replaced in Cloudflare in the same deploy.

---

## 7. Rotate the Gateway Access Key

1. Edit the `GATEWAY_ACCESS_KEY` Secret in the repository.
2. Push to `main` (or run the Deploy workflow).

No `NODE_SECRETS_XX` is changed.

---

## 8. Run the workflow manually

Use **Actions → Deploy → Run workflow**. The same validation, dry-run, secret sync, migration, deploy, and health-check sequence runs.

---

## 9. Automatic deploy on `main`

The Deploy workflow runs on every push to `main` (documentation-only changes are ignored). A green check means the gateway is updated and the live health checks passed.

---

## 10. Configuration check

Before pushing, validate the local configuration files:

```bash
npm run config:check -- \
  --tier1 config/tier1-nodes.example.json \
  --tier2 config/tier2-nodes.example.json \
  --secrets config/node-secrets.example.json
```

The CLI verifies JSON format, schema, duplicate node ids, node↔credential correspondence, and shard sizes, and prints a safe summary. The same check runs inside CI; failures fail the deploy.

Inspect a deployed-shape summary of a single configuration:

```bash
npm run config:show -- --tier1 ... --secrets ...
```

Diff two configurations:

```bash
npm run config:diff -- --old-tier1 old.json --new-tier1 new.json --old-secrets old.sec --new-secrets new.sec
```

All three commands print only `configured` / `missing` for credentials — never the value.

---

## 11. Rollback

### Automatic (post-deploy health-check failure)

The Deploy workflow includes an **automatic Worker-code rollback** step. If the Worker deploys successfully but the post-deploy health check (`/health`, `/v1/models`, `count_tokens`) fails, the workflow automatically runs `wrangler rollback` to restore the **previous** Worker version, then re-runs the health check.

**What is rolled back:**
- Worker code/version only — the previous Worker bundle is re-activated.

**What is NOT rolled back:**
- **Worker variables** — the new deploy's `vars` (set by `wrangler deploy`) remain in effect. If the new deploy changed a variable that the old code does not understand, the old code may fail. This is rare in 1.x (variables are additive), but possible.
- **Worker secrets** — synchronized before deploy; not reversed by `wrangler rollback`.
- **D1 migrations** — forward-only; never auto-reversed.

If the rollback health check also fails, the workflow exits with an error and manual intervention is required.

### Manual (code or configuration rollback)

1. Revert the commit on `main` (or push a new commit that restores the previous Variable / Secret values).
2. The next Deploy restores the Worker to the previous code and the previous runtime variables.

For an emergency stop without a new push, use **Actions → Deploy → Run workflow** with the previous commit selected via `git checkout <sha>` followed by `git push`. A `git revert` + `git push` is the normal path.

The deploy job also cleans up `NODE_SECRETS_XX` shards that are no longer referenced by the current configuration, so a rollback that legitimately removes shards does not leave orphans in Cloudflare.

---

## 12. Troubleshooting

**`ERROR: CLOUDFLARE_ACCOUNT_ID is missing from GitHub Repository Variables.`**
Set the Variable (§2). The preflight name is the exact missing key.

**`ERROR: GATEWAY_ACCESS_KEY is missing from GitHub Repository Secrets.`**
Set the Secret (§3).

**`ERROR: No TIER{1,2,3}_NODES_CONFIG_XX Variable is configured.`**
Add at least one tier-config Variable with valid JSON (§2).

**`ERROR: No NODE_SECRETS_XX Secret is configured.`**
Add at least one `NODE_SECRETS_01` Secret with a JSON object `{ "node-id": "credential" }` (§3).

**`D1 persistence disabled: TOKEN_STATS_D1_ID is not configured.`**
Expected and harmless if you do not need durable token stats. To enable, set the `TOKEN_STATS_D1_ID` Variable.

**`GATEWAY_CONFIG is deprecated.` / `GATEWAY_SECRETS_CONFIG is deprecated.`**
You are still using the old single-blob format. Migrate to the individual Variables and Secrets (§2, §3). Use `npm run config:migrate` to generate the manifest.

**Health check fails with `remote /health is not ready`.**
Inspect `wrangler tail` for the deployed Worker. The access key in the `GATEWAY_ACCESS_KEY` Secret must match the one the runtime sees (Cloudflare Secret list shows the current value). A stale cache or an incomplete `secrets bulk` can cause this — re-run the workflow.

**Worker deploy succeeds but `/v1/models` returns empty.**
The current `TIER*_NODES_CONFIG_XX` declares nodes whose `models` map is empty (a wildcard) or whose `MODELS_CONFIG` registry overrides are invalid. Run `npm run config:check` locally to surface the exact error.

---

## 13. Migrating from the legacy single-blob format

The previous design used one Variable (`GATEWAY_CONFIG`) and one Secret (`GATEWAY_SECRETS_CONFIG`) as big JSON blobs. They still work, but emit a deprecation warning and will be removed in a future release.

To migrate:

1. Parse the existing blobs:

   ```bash
   npm run config:migrate -- \
     --gateway-config old-gateway-config.json \
     --gateway-secrets old-gateway-secrets.json \
     --out ./migrated
   ```

   This writes one file per shard into `./migrated/` (except `GATEWAY_ACCESS_KEY`, which is not written unless you also pass `--include-access-key`).

2. In the GitHub repository, create the individual Variables and Secrets from the file names. Each file's contents go into the matching entry.

3. Remove `GATEWAY_CONFIG` and `GATEWAY_SECRETS_CONFIG` from the repository only **after** the new Variables and Secrets are in place and a Deploy has succeeded end to end (preflight, dry-run, real deploy, `/health`, `/v1/models`, `count_tokens`, and a real model call).

The deploy job never mixes the two formats: when individual Variables / Secrets are present, the legacy blob is ignored. When only the blob is present, the deploy reads the blob and prints a deprecation warning. Both formats cannot both be authoritative at once.

Do not delete `GATEWAY_CONFIG` or `GATEWAY_SECRETS_CONFIG` before a successful end-to-end deploy on the new individual format.

---

## 14. Branch protection (manual one-time setup)

`main` triggers auto-deploy — it must not accept unreviewed or force-pushed commits. GitHub Rulesets are configured in **Settings → Rules → Rulesets** and cannot be set from the repository itself. Complete this once:

1. **Settings → Rules → Rulesets → New ruleset → Target: branch `main`**
2. Enable:
   - **Require a pull request before merging** — at least 1 approval; the author may not self-approve.
   - **Require status checks to pass** — select `verify` (from the `CI` workflow) and `Deploy` (from the `Deploy` workflow). Optionally require the branch to be up to date.
   - **Block force push** — `main` history must be append-only.
   - **Block branch deletion** — `main` must never be deleted.
3. **Settings → General → Pull Requests → Allow squash merge** (recommended); disable "Allow merge commits" and "Allow rebase merge" if a linear history is preferred.

These settings protect against human error, AI agents, automation scripts, and accidental direct pushes. They apply even for a single-maintainer repository.
