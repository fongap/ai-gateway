import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodesArray, assertSecretsObject, buildPlan, parseJsonFile } from './nodes-shard.mjs';

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
assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'package-lock.json is required for npm ci');

// New-schema deployment files must exist.
for (const file of [
  'scripts/install.sh', 'scripts/install.ps1',
  'scripts/update.sh', 'scripts/update.ps1',
  'scripts/reconfigure.sh', 'scripts/reconfigure.ps1',
  'scripts/nodes-shard.mjs', 'scripts/manage-nodes-config.mjs',
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment file: ${file}`);
}

for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
  const source = read(file);
  assert.match(source, /secret['", ]+bulk|secret bulk/, `${file} must deploy secrets via secret bulk`);
  assert.match(source, /keep-vars/, `${file} must preserve remote vars`);
  assert.match(source, /manage-nodes-config\.mjs/, `${file} must shard node configs via the shared planner`);
}
for (const file of ['scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  assert.match(source, /secret['", ]+bulk|secret bulk/, `${file} must update runtime secrets without code changes`);
  assert.match(source, /manage-nodes-config\.mjs/, `${file} must shard node configs via the shared planner`);
}
for (const file of ['scripts/update.sh', 'scripts/update.ps1', 'scripts/deploy.sh', 'scripts/deploy.ps1']) {
  const source = read(file);
  assert.match(source, /keep-vars|scripts\/deploy\.sh|deploy\.ps1/, `${file} must preserve remote vars (directly or via deploy script)`);
}

// The new schema forbids legacy artifacts anywhere in deploy tooling.
for (const file of ['scripts/install.sh', 'scripts/install.ps1', 'scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  assert.doesNotMatch(source, /PRIMARY_API_TOKENS|FALLBACK_API_TOKEN|MODEL_MAPPING/, `${file} must not reference removed legacy variables`);
  assert.doesNotMatch(source, /TIER[123]_NODES_CONFIG(?![_\d])['"]/ , `${file} must not create un-suffixed legacy node config variables`);
}

const releaseSource = read('scripts/prepare-release.mjs');
for (const token of ['.wrangler-dry-run', 'node_modules', 'release']) {
  assert.match(releaseSource, new RegExp(token.replace(/[.*+?${}()|[\]\\]/g, '\\$&')), `Release staging must exclude ${token}`);
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
