#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodesArray, parseJsonFile } from './node-config-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('wrangler.jsonc'));

assert.equal(config.keep_vars, true);
assert.equal(config.main, 'src/index.ts');
assert.equal(config.secrets, undefined);
assert.equal(config.env, undefined);
assert.equal(config.vars, undefined);
assert.ok(Array.isArray(config.triggers?.crons) && config.triggers.crons.includes('0 3 * * *'));
assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'package-lock.json is required for npm ci');

const tooling = [
  'scripts/install.sh', 'scripts/install.ps1',
  'scripts/reconfigure.sh', 'scripts/reconfigure.ps1',
  'scripts/node-config-shards.mjs', 'scripts/plan-node-configuration.mjs',
  'scripts/cloudflare-wrangler.mjs', 'scripts/github-deployment-config.mjs',
];
for (const file of tooling) assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment/tooling file: ${file}`);

for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
  const source = read(file);
  assert.match(source, /--secrets-file/);
  assert.match(source, /keep-vars/);
  assert.match(source, /plan-node-configuration\.mjs/);
  assert.match(source, /TIER1_AFFINITY/);
  assert.match(source, /cloudflare-wrangler\.mjs/);
  assert.match(source, /wrangler\.user\.jsonc/);
}
for (const file of ['scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  assert.match(source, /--secrets-file/);
  assert.match(source, /plan-node-configuration\.mjs/);
  assert.match(source, /TIER1_AFFINITY/);
  assert.match(source, /cloudflare-wrangler\.mjs/);
}

const accessGroups = ['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT'];
const standaloneAccessKeyPattern = /GATEWAY_ACCESS_KEY(?!_)/;
for (const file of ['scripts/install.sh', 'scripts/install.ps1', 'scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  const source = read(file);
  for (const group of accessGroups) assert.ok(source.includes(group), `${file} must expose ${group}`);
  assert.match(source, /GATEWAY_ACCESS_KEY_/);
  assert.match(source, /GATEWAY_ACCESS_MODELS_/);
  assert.doesNotMatch(source, standaloneAccessKeyPattern);
}
for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
  const source = read(file);
  assert.match(source, /At least one Gateway Access Group Key/);
  assert.doesNotMatch(source, /GATEWAY_ACCESS_MODELS_[^\n]*[=:][^\n]*["']\*["']/);
}

const pkg = JSON.parse(read('package.json'));
for (const scriptName of ['deploy', 'tail', 'cf:login', 'cf:whoami']) {
  assert.match(pkg.scripts?.[scriptName] || '', /cloudflare-wrangler\.mjs/);
}
assert.match(pkg.scripts?.deploy || '', /cloudflare-wrangler\.mjs\s+deploy/);

const wranglerTool = read('scripts/cloudflare-wrangler.mjs');
assert.match(wranglerTool, /wrangler@4\.114\.0/, 'Wrangler pin has one tooling owner');
for (const file of ['package.json', 'scripts/install.sh', 'scripts/install.ps1', 'scripts/reconfigure.sh', 'scripts/reconfigure.ps1']) {
  assert.doesNotMatch(read(file), /wrangler@\d+\.\d+\.\d+/, `${file} must not duplicate the Wrangler pin`);
}
for (const token of ['migrations', 'apply', 'TOKEN_STATS_DB', '--remote', '--dry-run', 'TIER1_AFFINITY']) {
  assert.ok(wranglerTool.includes(token), `cloudflare-wrangler.mjs must include ${token}`);
}

for (const removed of [
  'scripts/deploy.sh', 'scripts/deploy.ps1',
  'scripts/update.sh', 'scripts/update.ps1',
  'scripts/setup-and-deploy.sh', 'scripts/setup-and-deploy.ps1',
]) {
  assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} must not return as duplicate lifecycle tooling`);
}

const workflow = read('.github/workflows/deploy.yml');
assert.match(workflow, /vars\.DEPLOY_ENABLED != 'false'/);
assert.match(workflow, /github\.repository\s*==\s*'fongap\/ai-gateway'\s*\|\|\s*vars\.DEPLOY_ENABLED\s*==\s*'true'/);
assert.match(workflow, /github-deployment-config\.mjs preflight/);
assert.match(workflow, /prepare --from-env/);
assert.match(workflow, /TIER1_NODES_SECRETS_01:/);
assert.match(workflow, /TIER1_NODES_CONFIG_01:/);
assert.match(workflow, /TIER1_AFFINITY_KV_ID:/);
assert.match(workflow, /github-deployment-config\.mjs health-check/);
assert.doesNotMatch(workflow, /secrets\.TIER[123]_NODES_CONFIG/);
assert.doesNotMatch(workflow, /vars\.TIER[123]_NODES_SECRETS/);
assert.doesNotMatch(workflow, /GATEWAY_CONFIG|GATEWAY_SECRETS_CONFIG/);
assert.doesNotMatch(workflow, /deploy[^\n]*--keep-vars/);
for (const group of accessGroups) {
  assert.match(workflow, new RegExp(`GATEWAY_ACCESS_KEY_${group}:`));
  assert.match(workflow, new RegExp(`GATEWAY_ACCESS_MODELS_${group}:`));
}

// The current repository intentionally keeps only non-secret configuration
// examples. Tier 2 is reserved for a concrete subscription-entitlement adapter,
// so there is no generic Tier 2 node example or public credential example.
for (const removedExample of [
  'config/tier2-nodes.example.json',
  'config/node-secrets.example.json',
  'config/gateway-secrets.example.json',
]) {
  assert.equal(fs.existsSync(path.join(root, removedExample)), false, `${removedExample} must stay absent`);
}
assert.ok(fs.existsSync(path.join(root, 'config/worker-vars.example.json')));

const tier1 = parseJsonFile(path.join(root, 'config/tier1-nodes.example.json'));
assertNodesArray(tier1, 'config/tier1-nodes.example.json');
assert.ok(tier1.length >= 2, 'Tier 1 example should demonstrate multiple free-capacity nodes');
for (const n of tier1) {
  for (const required of ['id', 'provider', 'protocol', 'surfaces', 'base_url', 'models']) {
    assert.ok(Object.hasOwn(n, required), `Tier 1 example node ${n.id || '?'} must explicitly declare ${required}`);
  }
  assert.equal(Array.isArray(n.models), false, 'models must use current object mapping');
}
JSON.parse(read('config/models.example.json'));
const policiesExample = JSON.parse(read('config/policies.example.json'));
assert.equal(JSON.stringify(policiesExample).includes('budget_split'), false, 'policy example must not reintroduce alternate tier allocation');
const workerVars = JSON.parse(read('config/worker-vars.example.json'));
assert.equal(Object.hasOwn(workerVars, 'GATEWAY_CONFIG'), false);
assert.equal(Object.hasOwn(workerVars, 'GATEWAY_SECRETS_CONFIG'), false);
const accessExample = JSON.parse(read('config/access-keys.example.json'));
assert.ok(Object.keys(accessExample).some((name) => /^GATEWAY_ACCESS_KEY_(AIR|PRO|MAX|ULTRA|AGENT)$/.test(name)));
assert.ok(Object.keys(accessExample).some((name) => /^GATEWAY_ACCESS_MODELS_(AIR|PRO|MAX|ULTRA|AGENT)$/.test(name)));
assert.doesNotMatch(JSON.stringify(accessExample), standaloneAccessKeyPattern);

// Runtime source must not resurrect removed config surfaces.
const srcFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|ts)$/.test(entry.name)) srcFiles.push(full);
  }
}
walk(path.join(root, 'src'));
for (const file of srcFiles) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, standaloneAccessKeyPattern, `${file} must not use standalone gateway key config`);
  assert.doesNotMatch(source, /\bbudgetSplit\b|\bbudget_split\b/, `${file} must not contain alternate tier-budget config`);
}

console.log('Deployment configuration check passed.');
