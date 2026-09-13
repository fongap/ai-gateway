import assert from 'node:assert/strict';
import path from 'node:path';
import {
  loadRuntimeConfig,
  normalizeRuntimeConfig,
  normalizeNodeConfigJsonText,
  validateGatewayRuntime,
  buildWranglerConfig,
  withStaleNodeSecretsRemoved,
  collectVarsFromEnv,
  collectSecretsFromEnv,
  buildRuntimeFromEnv,
  preflight,
  buildDeploymentSummary,
} from '../scripts/github-deployment-config.mjs';

const strictNode = (id = 'node-a') => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  base_url: 'https://provider.example.com/v1',
  models: { 'code-pro': 'upstream-code-pro' },
});

function fixture() {
  return {
    vars: {
      TIER1_NODES_CONFIG_01: [strictNode()],
      MODELS_CONFIG: { 'code-pro': { policy: 'default' } },
      POLICIES_CONFIG: { default: { max_attempts: 5 } },
    },
    secrets: {
      GATEWAY_ACCESS_KEY_AIR: 'gateway-key',
      TIER1_NODES_SECRETS_01: { 'node-a': 'upstream-key' },
    },
  };
}

const runtime = loadRuntimeConfig(JSON.stringify(fixture().vars), JSON.stringify(fixture().secrets));
const cfg = validateGatewayRuntime(runtime);
assert.equal(cfg.ready, true);
assert.equal(cfg.nodesUsable, 1);
assert.equal(JSON.parse(runtime.vars.TIER1_NODES_CONFIG_01)[0].protocol, 'openai');
assert.deepEqual(JSON.parse(runtime.vars.TIER1_NODES_CONFIG_01)[0].surfaces, ['chat_completions']);
assert.equal(JSON.parse(runtime.secrets.TIER1_NODES_SECRETS_01)['node-a'], 'upstream-key');

assert.throws(
  () => normalizeRuntimeConfig({ vars: { ...fixture().vars, GATEWAY_ACCESS_KEY_AIR: 'nope' }, secrets: fixture().secrets }),
  /credentials belong in secrets/,
);
assert.throws(
  () => normalizeRuntimeConfig({ vars: fixture().vars, secrets: { GATEWAY_ACCESS_KEY_AIR: 'x' } }),
  /TIER[123]_NODES_SECRETS/,
);
assert.throws(
  () => validateGatewayRuntime(normalizeRuntimeConfig({
    vars: { ...fixture().vars, MODELS_CONFIG: { 'code-pro': { policy: 'missing' } }, POLICIES_CONFIG: {} },
    secrets: fixture().secrets,
  })),
  /references unknown policy/,
);
assert.throws(
  () => validateGatewayRuntime(normalizeRuntimeConfig({
    vars: { ...fixture().vars, TIER1_NODES_CONFIG_01: [{ ...strictNode(), limits: { rpm: 10 } }] },
    secrets: fixture().secrets,
  })),
  /unknown field "limits"/,
);

const wrangler = buildWranglerConfig(runtime.vars, 'd1-id', 'kv-id');
assert.equal(wrangler.keep_vars, false);
assert.equal(wrangler.vars.TIER1_NODES_CONFIG_01, runtime.vars.TIER1_NODES_CONFIG_01);
assert.equal(wrangler.d1_databases[0].database_id, 'd1-id');
assert.deepEqual(wrangler.kv_namespaces, [{ binding: 'TIER1_AFFINITY', id: 'kv-id' }]);
assert.ok(path.isAbsolute(wrangler.main));
assert.ok(path.isAbsolute(wrangler.d1_databases[0].migrations_dir));

assert.deepEqual(
  withStaleNodeSecretsRemoved(
    runtime.secrets,
    [{ name: 'TIER1_NODES_SECRETS_01' }, { name: 'TIER1_NODES_SECRETS_02' }, { name: 'UNRELATED_SECRET' }],
  ),
  { ...runtime.secrets, TIER1_NODES_SECRETS_02: null },
);

function envFixture() {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    TOKEN_STATS_D1_ID: 'd1-id',
    TIER1_AFFINITY_KV_ID: 'kv-id',
    GATEWAY_PUBLIC_BASE_URL: 'https://gw.example.com',
    RATE_LIMIT_COOLDOWN_MS: '15000',
    FIRST_EVENT_TIMEOUT_MS: '15000',
    MODELS_CONFIG: JSON.stringify({ 'code-pro': { policy: 'default' } }),
    POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5 } }),
    TIER1_NODES_CONFIG_01: JSON.stringify([strictNode()]),
    CLOUDFLARE_API_TOKEN: 'cf-token',
    GATEWAY_ACCESS_KEY_AIR: 'gw-key',
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'node-a': 'upstream-key' }),
  };
}

{
  const repaired = normalizeNodeConfigJsonText(
    '[{"id":"a","provider":"p","protocol":"openai","surfaces":["chat_completions"],"base_url":"https://a.example","models":{"label":"A、B"}}、{"id":"b"}]',
  );
  assert.ok(repaired.includes('A、B'), 'punctuation inside strings is preserved');
  assert.ok(repaired.includes('},{"id":"b"}'), 'separator punctuation outside strings becomes comma');
  assert.equal(
    normalizeNodeConfigJsonText('[{"id":"a","models":{"x":"y"}、}]'),
    '[{"id":"a","models":{"x":"y"}}]',
    'trailing full-width punctuation before a closer is removed',
  );
}

{
  const env = envFixture();
  env.TIER1_NODES_CONFIG_01 = '[{"id":"node-a","provider":"mock","protocol":"openai","surfaces":["chat_completions"],"base_url":"https://provider.example.com/v1","models":{"code-pro":"up"}、}]';
  const built = buildRuntimeFromEnv(env);
  assert.equal(validateGatewayRuntime(built.runtime).ready, true);
  const pf = preflight(env);
  assert.ok(pf.warnings.some((w) => w.includes('full-width JSON punctuation')));
}

{
  const built = buildRuntimeFromEnv(envFixture());
  const validated = validateGatewayRuntime(built.runtime);
  assert.equal(validated.ready, true);
  assert.equal(built.runtime.vars.RATE_LIMIT_COOLDOWN_MS, '15000');
  assert.equal(built.runtime.vars.FIRST_EVENT_TIMEOUT_MS, '15000');
  assert.equal(JSON.parse(built.runtime.secrets.TIER1_NODES_SECRETS_01)['node-a'], 'upstream-key');
}

{
  const vars = collectVarsFromEnv(envFixture()).vars;
  const secrets = collectSecretsFromEnv(envFixture()).secrets;
  assert.ok('TIER1_NODES_CONFIG_01' in vars);
  assert.ok(!('TIER1_NODES_CONFIG_01' in secrets));
  assert.ok('TIER1_NODES_SECRETS_01' in secrets);
  assert.ok(!('TIER1_NODES_SECRETS_01' in vars));
  assert.ok(!('GATEWAY_ACCESS_KEY_AIR' in vars));
}

{
  const env = envFixture();
  env.GATEWAY_ACCESS_KEY_MAX = 'max-secret';
  env.GATEWAY_ACCESS_MODELS_MAX = 'Max,Code-Max';
  const vars = collectVarsFromEnv(env).vars;
  const secrets = collectSecretsFromEnv(env).secrets;
  assert.equal(vars.GATEWAY_ACCESS_MODELS_MAX, 'Max,Code-Max');
  assert.equal(secrets.GATEWAY_ACCESS_KEY_MAX, 'max-secret');
}

{
  const r = preflight(envFixture());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
}

{
  const env = envFixture();
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.GATEWAY_PUBLIC_BASE_URL;
  delete env.TIER1_NODES_CONFIG_01;
  delete env.TIER1_NODES_SECRETS_01;
  delete env.GATEWAY_ACCESS_KEY_AIR;
  delete env.CLOUDFLARE_API_TOKEN;
  const r = preflight(env);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('CLOUDFLARE_ACCOUNT_ID')));
  assert.ok(r.errors.some((e) => e.includes('GATEWAY_ACCESS_KEY_<GROUP>')));
  assert.ok(r.errors.some((e) => e.includes('No TIER')));
}

{
  const env = envFixture();
  delete env.MODELS_CONFIG;
  delete env.POLICIES_CONFIG;
  const r = preflight(env);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('MODELS_CONFIG')));
  assert.ok(r.warnings.some((w) => w.includes('POLICIES_CONFIG')));
}

{
  const built = buildRuntimeFromEnv({
    ...envFixture(),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'other-node': 'key' }),
  });
  assert.throws(
    () => validateGatewayRuntime(built.runtime),
    /node.*has no credential|credential.*has no matching node|degraded|invalid/i,
  );
}

{
  const summary = buildDeploymentSummary({
    config: cfg,
    runtime,
    d1Configured: 'd1-id',
    affinityKvConfigured: 'kv-id',
    removedSecretShards: 1,
  });
  for (const fragment of ['Deployment completed', 'Nodes: 1/1 usable', 'Models: 1', 'Node secret shards: 1', 'Status: ready', 'OK']) {
    assert.ok(summary.includes(fragment), `summary contains "${fragment}"`);
  }
  for (const forbidden of ['upstream-key', 'gateway-key', 'Bearer', 'authorization']) {
    assert.ok(!summary.includes(forbidden));
  }
}

{
  const env = envFixture();
  env.TIER1_NODES_CONFIG_10 = env.TIER1_NODES_CONFIG_01;
  env.TIER1_NODES_CONFIG_11 = JSON.stringify([strictNode('node-11')]);
  env.TIER1_NODES_SECRETS_10 = env.TIER1_NODES_SECRETS_01;
  env.TIER1_NODES_SECRETS_11 = JSON.stringify({ 'node-11': 'upstream-key-11' });
  const vars = collectVarsFromEnv(env).vars;
  const secrets = collectSecretsFromEnv(env).secrets;
  assert.ok('TIER1_NODES_CONFIG_10' in vars);
  assert.ok(!('TIER1_NODES_CONFIG_11' in vars));
  assert.ok('TIER1_NODES_SECRETS_10' in secrets);
  assert.ok(!('TIER1_NODES_SECRETS_11' in secrets));
}

assert.throws(
  () => normalizeRuntimeConfig({
    vars: { ...fixture().vars, TIER1_NODES_CONFIG_11: [strictNode('node-11')] },
    secrets: fixture().secrets,
  }),
  /TIER1_NODES_CONFIG_11|shard index out of range/i,
);

console.log('github deployment config tests passed.');
