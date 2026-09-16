#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  loadRuntimeConfig, normalizeRuntimeConfig, normalizeNodeConfigJsonText,
  validateGatewayRuntime, buildWranglerConfig, withStaleNodeSecretsRemoved,
  collectVarsFromEnv, collectSecretsFromEnv, buildRuntimeFromEnv, preflight,
  buildDeploymentSummary,
} from '../scripts/github-deployment-config.mjs';

const currentNode = (id = 'node-a') => ({
  id,
  provider: 'mock',
  base_url: 'https://provider.example.com/v1',
  models: { 'code-pro': 'upstream-code-pro' },
});

function fixture() {
  return {
    vars: {
      TIER1_NODES_CONFIG_01: [currentNode()],
      GATEWAY_ACCESS_MODELS_AIR: 'code-pro',
      MODELS_CONFIG: { 'code-pro': { policy: 'default' } },
      POLICIES_CONFIG: { default: { max_attempts: 5 } },
    },
    secrets: {
      GATEWAY_ACCESS_KEY_AIR: 'gateway-key',
      TIER1_NODES_SECRETS_01: { 'node-a': 'upstream-key' },
    },
  };
}

const loaded = loadRuntimeConfig(JSON.stringify(fixture().vars), JSON.stringify(fixture().secrets));
const cfg = validateGatewayRuntime(loaded);
assert.equal(cfg.ready, true);
assert.equal(cfg.nodesUsable, 1);
assert.equal(JSON.parse(loaded.vars.TIER1_NODES_CONFIG_01)[0].provider, 'mock');
assert.equal(JSON.parse(loaded.secrets.TIER1_NODES_SECRETS_01)['node-a'], 'upstream-key');

assert.throws(
  () => normalizeRuntimeConfig({ vars: { ...fixture().vars, GATEWAY_ACCESS_KEY_AIR: 'nope' }, secrets: fixture().secrets }),
  /credentials belong in secrets/,
);
assert.throws(
  () => normalizeRuntimeConfig({ vars: fixture().vars, secrets: { GATEWAY_ACCESS_KEY_AIR: 'x' } }),
  /TIER\[123\]_NODES_SECRETS|TIER[123]_NODES_SECRETS/,
);
assert.throws(
  () => validateGatewayRuntime(normalizeRuntimeConfig({
    vars: {
      ...fixture().vars,
      MODELS_CONFIG: { 'code-pro': { policy: 'missing' } },
      POLICIES_CONFIG: {},
    },
    secrets: fixture().secrets,
  })),
  /references unknown policy/,
);

const wrangler = buildWranglerConfig(loaded.vars, 'd1-id', 'kv-id');
assert.equal(wrangler.keep_vars, false);
assert.equal(wrangler.vars.TIER1_NODES_CONFIG_01, loaded.vars.TIER1_NODES_CONFIG_01);
assert.equal(wrangler.d1_databases[0].database_id, 'd1-id');
assert.deepEqual(wrangler.kv_namespaces, [{ binding: 'TIER1_AFFINITY', id: 'kv-id' }]);
assert.ok(path.isAbsolute(wrangler.main));
assert.ok(path.isAbsolute(wrangler.d1_databases[0].migrations_dir));

assert.deepEqual(
  withStaleNodeSecretsRemoved(loaded.secrets, [
    { name: 'TIER1_NODES_SECRETS_01' },
    { name: 'TIER1_NODES_SECRETS_02' },
    { name: 'UNRELATED_SECRET' },
  ]),
  { ...loaded.secrets, TIER1_NODES_SECRETS_02: null },
);

function envFixture() {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    TOKEN_STATS_D1_ID: 'd1-id',
    TIER1_AFFINITY_KV_ID: 'kv-id',
    GATEWAY_PUBLIC_BASE_URL: 'https://gw.example.com',
    RATE_LIMIT_COOLDOWN_MS: '15000',
    FIRST_EVENT_TIMEOUT_MS: '15000',
    MODELS_CONFIG: JSON.stringify({ 'code-pro': { policy: 'default' } }),
    POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5 } }),
    TIER1_NODES_CONFIG_01: JSON.stringify([currentNode()]),
    GATEWAY_ACCESS_KEY_AIR: 'gw-key',
    GATEWAY_ACCESS_MODELS_AIR: 'code-pro',
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'node-a': 'upstream-key' }),
  };
}

{
  const repaired = normalizeNodeConfigJsonText('[{"id":"a","models":{"label":"A、B"}}、{"id":"b"}]');
  assert.equal(repaired, '[{"id":"a","models":{"label":"A、B"}},{"id":"b"}]');
  assert.equal(normalizeNodeConfigJsonText('[{"id":"a"、}]'), '[{"id":"a"}]');
}

{
  const env = envFixture();
  env.TIER1_NODES_CONFIG_01 = JSON.stringify([currentNode()]).replace(/}]$/, '}、]');
  const built = buildRuntimeFromEnv(env);
  assert.equal(validateGatewayRuntime(built.runtime).ready, true);
  assert.ok(preflight(env).warnings.some((w) => w.includes('full-width JSON punctuation')));
}

{
  const built = buildRuntimeFromEnv(envFixture());
  assert.equal(validateGatewayRuntime(built.runtime).ready, true);
  assert.equal(built.runtime.vars.RATE_LIMIT_COOLDOWN_MS, '15000');
  assert.equal(JSON.parse(built.runtime.secrets.TIER1_NODES_SECRETS_01)['node-a'], 'upstream-key');
}

{
  const env = envFixture();
  const vars = collectVarsFromEnv(env).vars;
  const secrets = collectSecretsFromEnv(env).secrets;
  assert.ok('TIER1_NODES_CONFIG_01' in vars);
  assert.ok(!('TIER1_NODES_CONFIG_01' in secrets));
  assert.ok('TIER1_NODES_SECRETS_01' in secrets);
  assert.ok(!('TIER1_NODES_SECRETS_01' in vars));
  assert.ok('GATEWAY_ACCESS_MODELS_AIR' in vars);
  assert.ok('GATEWAY_ACCESS_KEY_AIR' in secrets);
  assert.ok(!('GATEWAY_ACCESS_KEY_AIR' in vars));
}

{
  const env = envFixture();
  env.TIER1_NODES_CONFIG_02 = '';
  env.TIER1_NODES_SECRETS_02 = '';
  assert.ok(!('TIER1_NODES_CONFIG_02' in collectVarsFromEnv(env).vars));
  assert.ok(!('TIER1_NODES_SECRETS_02' in collectSecretsFromEnv(env).secrets));
}

{
  const result = preflight(envFixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
}

{
  const env = envFixture();
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.GATEWAY_PUBLIC_BASE_URL;
  delete env.TIER1_NODES_CONFIG_01;
  delete env.TIER1_NODES_SECRETS_01;
  delete env.GATEWAY_ACCESS_KEY_AIR;
  delete env.CLOUDFLARE_API_TOKEN;
  const result = preflight(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('CLOUDFLARE_ACCOUNT_ID')));
  assert.ok(result.errors.some((e) => e.includes('GATEWAY_ACCESS_KEY_<GROUP>')));
  assert.ok(result.errors.some((e) => e.includes('No TIER')));
}

{
  const env = envFixture();
  delete env.MODELS_CONFIG;
  delete env.POLICIES_CONFIG;
  const result = preflight(env);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('MODELS_CONFIG')));
  assert.ok(result.warnings.some((w) => w.includes('POLICIES_CONFIG')));
}

{
  const built = buildRuntimeFromEnv({
    ...envFixture(),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'other-node': 'key' }),
  });
  assert.throws(() => validateGatewayRuntime(built.runtime), /no credential|no matching node|invalid/i);
}

{
  const summary = buildDeploymentSummary({
    config: cfg,
    runtime: loaded,
    d1Configured: 'd1-id',
    affinityKvConfigured: 'kv-id',
    removedSecretShards: 1,
  });
  for (const fragment of ['Deployment completed', 'Nodes: 1/1 usable', 'Models: 1', 'Status: ready', 'OK']) assert.ok(summary.includes(fragment), fragment);
  for (const secret of ['upstream-key', 'gateway-key', 'Bearer', 'authorization']) assert.ok(!summary.includes(secret), `summary leaks ${secret}`);
}

{
  const env = envFixture();
  env.TIER1_NODES_CONFIG_10 = env.TIER1_NODES_CONFIG_01;
  env.TIER1_NODES_CONFIG_11 = env.TIER1_NODES_CONFIG_01;
  env.TIER1_NODES_SECRETS_10 = env.TIER1_NODES_SECRETS_01;
  env.TIER1_NODES_SECRETS_11 = env.TIER1_NODES_SECRETS_01;
  assert.ok('TIER1_NODES_CONFIG_10' in collectVarsFromEnv(env).vars);
  assert.ok(!('TIER1_NODES_CONFIG_11' in collectVarsFromEnv(env).vars));
  assert.ok('TIER1_NODES_SECRETS_10' in collectSecretsFromEnv(env).secrets);
  assert.ok(!('TIER1_NODES_SECRETS_11' in collectSecretsFromEnv(env).secrets));
}

console.log('github deployment config tests passed.');
