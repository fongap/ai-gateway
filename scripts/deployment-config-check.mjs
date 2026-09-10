import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodesArray, assertSecretsObject, buildPlan, parseJsonFile } from './node-config-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('wrangler.jsonc'));

assert.equal(config.keep_vars, true, 'wrangler.jsonc must set keep_vars=true');
assert.equal(config.main, 'src/index.ts');
assert.equal(config.secrets, undefined, 'wrangler.jsonc must not block the first deployment before runtime Secrets can be configured');
assert.equal(config.env, undefined, 'no per-Worker environments');
assert.equal(config.vars, undefined, 'wrangler.jsonc must not carry node config vars; they belong in wrangler.user.jsonc (generated)');
assert.ok(
  Array.isArray(config.triggers?.crons) && config.triggers.crons.includes('0 3 * * *'),
  'wrangler.jsonc must schedule the daily per-model statistics cleanup',
);
assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'package-lock.json is required for npm ci');

for (const file of [
  'scripts/install.sh', 'scripts/install.ps1',
  'scripts/reconfigure.sh', 'scripts/reconfigure.ps1',
  'scripts/node-config-shards.mjs', 'scripts/plan-node-configuration.mjs',
  'scripts/cloudflare-wrangler.mjs', 'scripts/github-deployment-config.mjs',
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment/tooling file: ${file}`);
}

for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
  const source = read(file);
  assert.match(source, /--secrets-file/, `${file} must deploy secrets via --secrets-file`);
  assert.match(source, /keep-vars/, `${file} must preserve remote vars`);
  assert.match(source, /plan-node-configuration\.mjs/, `${file} must shard node configs via the shared planner`);
  assert.match(source, /TIER1_AFFINITY/, `${file} must configure the required Tier 1 affinity KV binding`);
  assert.match(source, /cloudflare-wrangler\.mjs/, `${file} must route Cloudflare CLI actions through the canonical Wrangler wrapper`);
  assert.match(source, /wrangler\.user\.jsonc/, `${file} must write operator configuration to wrangler.user.jsonc`);
}
assert.doesNotMatch(
  read('scripts/install.sh'),
  /writeFileSync\(["']wrangler\.jsonc["']/i,
  'scripts/install.sh must not mutate tracked wrangler.jsonc',
);
assert.doesNotMatch(
  read('scripts/install.ps1'),
  /WriteAllText\(\$configPath/i,
  'scripts/install.ps1 must not mutate tracked wrangler.jsonc',
);

for (const file of ['scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  assert.match(source, /--secrets-file/, `${file} must update runtime secrets using --secrets-file`);
  assert.match(source, /plan-node-configuration\.mjs/, `${file} must shard node configs via the shared planner`);
  assert.match(source, /TIER1_AFFINITY/, `${file} must preserve or configure the Tier 1 affinity KV binding`);
  assert.match(source, /cloudflare-wrangler\.mjs/, `${file} must route Cloudflare CLI actions through the canonical Wrangler wrapper`);
}

const accessGroups = ['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT'];
const standaloneAccessKeyName = 'GATEWAY_ACCESS_' + 'KEY';
const standaloneAccessKeyPattern = new RegExp(`${standaloneAccessKeyName}(?!_)`);
for (const file of ['scripts/install.sh', 'scripts/install.ps1', 'scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  for (const group of accessGroups) {
    assert.ok(source.includes(group), `${file} must expose the ${group} access group`);
  }
  assert.match(source, /GATEWAY_ACCESS_KEY_/, `${file} must configure Group Keys`);
  assert.match(source, /GATEWAY_ACCESS_MODELS_/, `${file} must configure Group Models`);
  assert.doesNotMatch(source, standaloneAccessKeyPattern, `${file} must not create or rotate the legacy single access key`);
}
for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
  const source = read(file);
  assert.match(source, /At least one Gateway Access Group Key/, `${file} must fail when no Group Key is configured`);
  assert.doesNotMatch(source, /GATEWAY_ACCESS_MODELS_[^\n]*[=:][^\n]*["']\*["']/, `${file} must not default any Group Models to wildcard access`);
}

const packageJson = JSON.parse(read('package.json'));
for (const scriptName of ['deploy', 'tail', 'cf:login', 'cf:whoami']) {
  assert.match(
    packageJson.scripts?.[scriptName] || '',
    /cloudflare-wrangler\.mjs/,
    `npm script ${scriptName} must use scripts/cloudflare-wrangler.mjs`,
  );
}
assert.match(packageJson.scripts?.deploy || '', /cloudflare-wrangler\.mjs\s+deploy/, 'npm run deploy must use cloudflare-wrangler.mjs');

const runWranglerSource = read('scripts/cloudflare-wrangler.mjs');
assert.match(runWranglerSource, /wrangler@4\.114\.0/, 'cloudflare-wrangler.mjs must own the pinned Wrangler version');
for (const file of ['package.json', 'scripts/install.sh', 'scripts/install.ps1', 'scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  assert.doesNotMatch(read(file), /wrangler@\d+\.\d+\.\d+/, `${file} must not duplicate the Wrangler version pin`);
}
for (const token of ['migrations', 'apply', 'TOKEN_STATS_DB', '--remote', '--dry-run']) {
  assert.ok(runWranglerSource.includes(token), `cloudflare-wrangler.mjs must include ${token} migration/deploy handling`);
}
assert.match(runWranglerSource, /TIER1_AFFINITY/, 'cloudflare-wrangler.mjs must enforce the affinity KV binding on real deploys');

for (const removed of [
  'scripts/deploy.sh', 'scripts/deploy.ps1',
  'scripts/update.sh', 'scripts/update.ps1',
  'scripts/setup-and-deploy.sh', 'scripts/setup-and-deploy.ps1',
]) {
  assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} must not return as a duplicate lifecycle entry point`);
}

const workflowSource = read('.github/workflows/deploy.yml');
assert.match(workflowSource, /github\.repository\s*==\s*'fongap\/ai-gateway'\s*\|\|\s*vars\.DEPLOY_ENABLED\s*==\s*'true'/, 'deploy job must run for the main repo or forks opted in via DEPLOY_ENABLED');
assert.doesNotMatch(workflowSource, /if:\s*vars\.GATEWAY_CONFIG\s*!=\s*''/, 'deploy must not be gated on a business config variable; missing config must FAIL not SKIP');
assert.match(workflowSource, /node scripts\/github-deployment-config\.mjs preflight/, 'deploy workflow must run a preflight check before verify');
assert.match(workflowSource, /prepare --from-env/, 'deploy workflow must read individual GitHub Variables / Secrets from the environment');
assert.match(workflowSource, /TIER1_NODES_SECRETS_01:/, 'deploy workflow must inject individual credential shards via a fixed range');
assert.match(workflowSource, /TIER1_NODES_CONFIG_01:/, 'deploy workflow must inject individual node-config shards via a fixed range');
assert.match(workflowSource, /TIER1_AFFINITY_KV_ID:/, 'deploy workflow must inject the Tier 1 affinity KV namespace id');
assert.doesNotMatch(workflowSource, /secrets\.TIER[123]_NODES_CONFIG/, 'deploy workflow must not read node-config from GitHub Secrets (vars only)');
assert.doesNotMatch(workflowSource, /vars\.TIER[123]_NODES_SECRETS/, 'deploy workflow must not read node-secrets from GitHub Variables (secrets only)');
assert.doesNotMatch(workflowSource, /GATEWAY_CONFIG/, 'deploy workflow must not reference legacy GATEWAY_CONFIG');
assert.doesNotMatch(workflowSource, /GATEWAY_SECRETS_CONFIG/, 'deploy workflow must not reference legacy GATEWAY_SECRETS_CONFIG');
assert.match(workflowSource, /--secrets-file|secret bulk/, 'deploy workflow must deploy Worker Secrets (atomic via --secrets-file or legacy via secret bulk)');
assert.match(workflowSource, /github-deployment-config\.mjs health-check/, 'deploy workflow must verify the deployed gateway over its public API');
assert.doesNotMatch(workflowSource, /deploy[^\n]*--keep-vars/, 'CI deployment must not preserve Dashboard runtime-variable drift');
for (const group of accessGroups) {
  assert.match(workflowSource, new RegExp(`GATEWAY_ACCESS_KEY_${group}:`), `deploy workflow must inject GATEWAY_ACCESS_KEY_${group}`);
  assert.match(workflowSource, new RegExp(`GATEWAY_ACCESS_MODELS_${group}:`), `deploy workflow must inject GATEWAY_ACCESS_MODELS_${group}`);
}
assert.ok(fs.existsSync(path.join(root, 'config/worker-vars.example.json')), 'Worker text-variable example is required');

for (const file of ['scripts/install.sh', 'scripts/install.ps1', 'scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  assert.doesNotMatch(source, /PRIMARY_API_TOKENS|FALLBACK_API_TOKEN|MODEL_MAPPING/, `${file} must not reference removed legacy variables`);
  assert.doesNotMatch(source, /TIER[123]_NODES_CONFIG(?![_\d])['"]/, `${file} must not create un-suffixed legacy node config variables`);
}

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
const accessExample = JSON.parse(fs.readFileSync(path.join(configDir, 'access-keys.example.json'), 'utf8'));
assert.ok(Object.keys(accessExample).some((name) => /^GATEWAY_ACCESS_KEY_(AIR|PRO|MAX|ULTRA|AGENT)$/.test(name)), 'access-key example must contain a current Group Key');
assert.ok(Object.keys(accessExample).some((name) => /^GATEWAY_ACCESS_MODELS_(AIR|PRO|MAX|ULTRA|AGENT)$/.test(name)), 'access-key example must contain Group Models');
assert.ok(!(standaloneAccessKeyName in accessExample), 'access-key example must not recommend the legacy single key');

const gatewaySecretsExample = JSON.parse(fs.readFileSync(path.join(configDir, 'gateway-secrets.example.json'), 'utf8'));
const workerVarsExample = JSON.parse(fs.readFileSync(path.join(configDir, 'worker-vars.example.json'), 'utf8'));
for (const group of accessGroups) {
  if (`GATEWAY_ACCESS_KEY_${group}` in gatewaySecretsExample) {
    assert.ok(
      `GATEWAY_ACCESS_MODELS_${group}` in workerVarsExample,
      `gateway-secrets.example.json Group ${group} must have matching Models in worker-vars.example.json`,
    );
  }
}

const srcFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) srcFiles.push(full);
  }
}
walk(path.join(root, 'src'));
const legacyPattern = /(token@|free-pool|paid-tier|"plus"|TIER\d_NODES_CONFIG as Secret)/i;
for (const file of srcFiles) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, legacyPattern, `${file} contains legacy architecture references`);
  assert.doesNotMatch(source, standaloneAccessKeyPattern, `${file} contains the removed standalone gateway access-key variable`);
}
for (const file of [
  'tests/integration-test.mjs',
  'tests/stress-test.mjs',
  'tests/codex-contract-test.mjs',
  'tests/claude-contract-test.mjs',
]) {
  assert.doesNotMatch(
    read(file),
    standaloneAccessKeyPattern,
    `${file} must not use the removed standalone gateway access-key fixture`,
  );
}

console.log('Deployment configuration check passed.');
