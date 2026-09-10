import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const deploy = read('.github/workflows/deploy.yml');
const ci = read('.github/workflows/ci.yml');
const exampleVars = read('.dev.vars.example');
const workerVarsExample = read('config/worker-vars.example.json');

assert.equal(pkg.private, true, 'package.json must stay private');
assert.equal(pkg.type, 'module', 'package.json must stay ESM');
assert.ok(pkg.engines?.node, 'package.json must declare a Node engine');

for (const script of ['validate:merge', 'validate:deploy', 'check:deployment-config', 'migrations:check']) {
  assert.ok(pkg.scripts?.[script], `package.json missing required script: ${script}`);
}

assert.match(ci, /npm run validate:merge/, 'CI must run validate:merge');
assert.match(ci, /npm run validate:deploy/, 'CI must define validate:deploy');
assert.match(deploy, /workflow_run:/, 'Deploy must remain driven by CI workflow_run');
assert.match(deploy, /npm run migrations:check/, 'Deploy must validate migrations');
assert.match(deploy, /github-deployment-config\.mjs/, 'Deploy must use the canonical deployment config helper');

const standaloneAccessKeyPattern = /\bGATEWAY_ACCESS_KEY\b(?!_(?:AIR|PRO|MAX|ULTRA|AGENT)\b)/;
for (const [name, text] of [
  ['.dev.vars.example', exampleVars],
  ['config/worker-vars.example.json', workerVarsExample],
  ['.github/workflows/deploy.yml', deploy],
]) {
  assert.doesNotMatch(text, standaloneAccessKeyPattern, `${name} must not use the removed standalone gateway access-key variable`);
}

for (const group of ['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT']) {
  assert.match(deploy, new RegExp(`GATEWAY_ACCESS_KEY_${group}`), `Deploy must inject GATEWAY_ACCESS_KEY_${group}`);
  assert.match(deploy, new RegExp(`GATEWAY_ACCESS_MODELS_${group}`), `Deploy must inject GATEWAY_ACCESS_MODELS_${group}`);
}

const configShardPattern = /TIER[123]_NODES_CONFIG_(?:0[1-9]|10)/;
const secretShardPattern = /TIER[123]_NODES_SECRETS_(?:0[1-9]|10)/;
assert.match(deploy, configShardPattern, 'Deploy must handle node config shards');
assert.match(deploy, secretShardPattern, 'Deploy must handle node secret shards');

// Deployment/runtime configuration must not regress to old architecture vocabulary.
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
