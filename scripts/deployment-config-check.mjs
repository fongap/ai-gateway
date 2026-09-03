import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodesArray, assertSecretsObject, buildPlan, parseJsonFile } from './node-config-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('wrangler.jsonc'));

assert.equal(config.keep_vars, true, 'wrangler.jsonc must set keep_vars=true');
assert.equal(config.main, 'src/index.js');
assert.equal(
  config.secrets,
  undefined,
  'wrangler.jsonc must not block the first deployment before runtime Secrets can be configured',
);
assert.equal(config.env, undefined, 'no per-Worker environments');
assert.equal(config.vars, undefined, 'wrangler.jsonc must not carry node config vars; they belong in wrangler.user.jsonc (generated)');
assert.ok(
  Array.isArray(config.triggers?.crons) && config.triggers.crons.includes('0 3 * * *'),
  'wrangler.jsonc must schedule the daily per-model statistics cleanup',
);
assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'package-lock.json is required for npm ci');

// New-schema deployment files must exist.
for (const file of [
  'scripts/install.sh', 'scripts/install.ps1',
  'scripts/update.sh', 'scripts/update.ps1',
  'scripts/reconfigure.sh', 'scripts/reconfigure.ps1',
  'scripts/node-config-shards.mjs', 'scripts/plan-node-configuration.mjs',
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment file: ${file}`);
}

for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
  const source = read(file);
  assert.match(source, /secret['", ]+bulk|secret bulk/, `${file} must deploy secrets via secret bulk`);
  assert.match(source, /keep-vars/, `${file} must preserve remote vars`);
  assert.match(source, /plan-node-configuration\.mjs/, `${file} must shard node configs via the shared planner`);
  assert.match(source, /TIER1_AFFINITY/, `${file} must configure the required Tier 1 affinity KV binding`);
}
for (const file of ['scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  assert.match(source, /secret['", ]+bulk|secret bulk/, `${file} must update runtime secrets without code changes`);
  assert.match(source, /plan-node-configuration\.mjs/, `${file} must shard node configs via the shared planner`);
  assert.match(source, /TIER1_AFFINITY/, `${file} must preserve or configure the Tier 1 affinity KV binding`);
}
for (const file of ['scripts/update.sh', 'scripts/update.ps1', 'scripts/deploy.sh', 'scripts/deploy.ps1']) {
  const source = read(file);
  assert.match(source, /keep-vars|scripts\/deploy\.sh|deploy\.ps1/, `${file} must preserve remote vars (directly or via deploy script)`);
}
for (const file of ['scripts/deploy.sh', 'scripts/deploy.ps1']) {
  assert.match(read(file), /TIER1_AFFINITY/, `${file} must refuse a deploy without the required affinity KV binding`);
}

// Deploy scripts must apply D1 migrations when the operator config has a
// TOKEN_STATS_DB binding, so migrations are never skipped locally even when
// the GitHub Actions deploy workflow is the only path that applies them.
for (const file of ['scripts/deploy.sh', 'scripts/deploy.ps1']) {
  const source = read(file);
  assert.match(source, /migrations apply|migrations.*apply/i, `${file} must apply D1 migrations`);
  assert.match(source, /TOKEN_STATS_DB/i, `${file} must check for TOKEN_STATS_DB binding before migrating`);
}

// The package.json deploy entry goes through cloudflare-wrangler.mjs. That wrapper
// must also migrate before a real deploy, otherwise the most obvious local
// deployment command can publish code before its schema exists.
const packageJson = JSON.parse(read('package.json'));
assert.match(packageJson.scripts?.deploy || '', /cloudflare-wrangler\.mjs\s+deploy/, 'npm run deploy must use cloudflare-wrangler.mjs');
const runWranglerSource = read('scripts/cloudflare-wrangler.mjs');
for (const token of ['migrations', 'apply', 'TOKEN_STATS_DB', '--remote', '--dry-run']) {
  assert.ok(runWranglerSource.includes(token), `cloudflare-wrangler.mjs must include ${token} migration/deploy handling`);
}
assert.match(runWranglerSource, /TIER1_AFFINITY/, 'cloudflare-wrangler.mjs must enforce the affinity KV binding on real deploys');

const workflowSource = read('.github/workflows/deploy.yml');
assert.match(workflowSource, /github\.repository\s*==\s*'fongap\/ai-gateway'\s*\|\|\s*vars\.DEPLOY_ENABLED\s*==\s*'true'/, 'deploy job must run for the main repo or forks opted in via DEPLOY_ENABLED');
assert.doesNotMatch(workflowSource, /if:\s*vars\.GATEWAY_CONFIG\s*!=\s*''/, 'deploy must not be gated on a business config variable; missing config must FAIL not SKIP');
assert.match(workflowSource, /node scripts\/github-deployment-config\.mjs preflight/, 'deploy workflow must run a preflight check before verify');
assert.match(workflowSource, /prepare --from-env/, 'deploy workflow must read individual GitHub Variables / Secrets from the environment');
assert.match(workflowSource, /TIER1_NODES_SECRETS_01:/, 'deploy workflow must inject individual credential shards via a fixed range');
assert.match(workflowSource, /TIER1_NODES_CONFIG_01:/, 'deploy workflow must inject individual node-config shards via a fixed range');
assert.match(workflowSource, /TIER1_AFFINITY_KV_ID:/, 'deploy workflow must inject the Tier 1 affinity KV namespace id');
assert.match(workflowSource, /GATEWAY_CONFIG:/, 'deploy workflow must keep the legacy GATEWAY_CONFIG blob as a deprecated fallback');
assert.match(workflowSource, /GATEWAY_SECRETS_CONFIG:/, 'deploy workflow must keep the legacy GATEWAY_SECRETS_CONFIG blob as a deprecated fallback');
assert.match(workflowSource, /--secrets-file|secret bulk/, 'deploy workflow must deploy Worker Secrets (atomic via --secrets-file or legacy via secret bulk)');
assert.match(workflowSource, /github-deployment-config\.mjs health-check/, 'deploy workflow must verify the deployed gateway over its public API');
assert.doesNotMatch(workflowSource, /deploy[^\n]*--keep-vars/, 'CI deployment must not preserve Dashboard runtime-variable drift');
assert.ok(fs.existsSync(path.join(root, 'scripts/github-deployment-config.mjs')), 'GitHub deployment config bridge is required');
assert.ok(fs.existsSync(path.join(root, 'config/worker-vars.example.json')), 'Worker text-variable example is required');
assert.ok(fs.existsSync(path.join(root, 'config/gateway-secrets.example.json')), 'Worker Secret example is required');

// The new schema forbids legacy artifacts anywhere in deploy tooling.
for (const file of ['scripts/install.sh', 'scripts/install.ps1', 'scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  assert.doesNotMatch(source, /PRIMARY_API_TOKENS|FALLBACK_API_TOKEN|MODEL_MAPPING/, `${file} must not reference removed legacy variables`);
  assert.doesNotMatch(source, /TIER[123]_NODES_CONFIG(?![_\d])['"]/ , `${file} must not create un-suffixed legacy node config variables`);
}

// The shipped config/ examples must always be valid new-schema configs and
// demonstrate the intended multi-key / multi-account / multi-model layout.
const configDir = path.join(root, 'config');
const tier1 = parseJsonFile(path.join(configDir, 'tier1-nodes.example.json'));
const tier2 = parseJsonFile(path.join(configDir, 'tier2-nodes.example.json'));
const secrets = parseJsonFile(path.join(configDir, 'node-secrets.example.json'));
assertNodesArray(tier1, 'config/tier1-nodes.example.json');
assertNodesArray(tier2, 'config/tier2-nodes.example.json');
assertSecretsObject(secrets, 'config/node-secrets.example.json');
buildPlan({ tiers: { 1: tier1, 2: tier2 }, secretsMap: secrets });
assert.ok(tier1.length >= 2, 'tier-1 example must demonstrate multiple keys');
assert.ok(
  new Set(tier1.map((n) => n.provider)).size >= 2 || new Set(tier1.map((n) => n.priority)).size >= 2,
  'tier-1 example must demonstrate multiple providers or preference levels',
);
const logicalModels = new Set(tier1.flatMap((n) => Object.keys(n.models || {})));
assert.ok(logicalModels.size >= 2, 'tier-1 example must demonstrate multiple logical models');
JSON.parse(fs.readFileSync(path.join(configDir, 'models.example.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(configDir, 'policies.example.json'), 'utf8'));

// Source tree must not contain legacy concepts.
const srcFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) srcFiles.push(full);
  }
}
walk(path.join(root, 'src'));
const legacyPattern = /(token@|free-pool|paid-tier|"plus"|TIER\d_NODES_CONFIG as Secret)/i;
for (const file of srcFiles) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, legacyPattern, `${file} contains legacy architecture references`);
}

console.log('Deployment configuration check passed.');
