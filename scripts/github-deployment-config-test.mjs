import assert from 'node:assert/strict';
import path from 'node:path';
import {
  loadRuntimeConfig, normalizeRuntimeConfig, validateGatewayRuntime, buildWranglerConfig, withStaleNodeSecretsRemoved,
  collectVarsFromEnv, collectSecretsFromEnv, buildRuntimeFromEnv, preflight, buildDeploymentSummary,
} from './github-deployment-config.mjs';

function fixture() {
  return {
    vars: {
      TIER1_NODES_CONFIG_01: [{
        id: 'node-a', base_url: 'https://provider.example.com/v1',
        models: { 'code-pro': 'upstream-code-pro' }, limits: { concurrency: 1, rpm_mode: 'hard' },
      }],
      MODELS_CONFIG: { 'code-pro': { policy: 'default' } },
      POLICIES_CONFIG: { default: { max_attempts: 5 } },
    },
    secrets: { GATEWAY_ACCESS_KEY_AIR: 'gateway-key', TIER1_NODES_SECRETS_01: { 'node-a': 'upstream-key' } },
  };
}

const runtime = loadRuntimeConfig(JSON.stringify(fixture().vars), JSON.stringify(fixture().secrets));
const cfg = validateGatewayRuntime(runtime);
assert.equal(cfg.ready, true);
assert.equal(cfg.nodesUsable, 1);
assert.equal(JSON.parse(runtime.vars.TIER1_NODES_CONFIG_01)[0].id, 'node-a');
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

const wrangler = buildWranglerConfig(runtime.vars, 'd1-id', 'kv-id');
assert.equal(wrangler.keep_vars, false);
assert.equal(wrangler.vars.TIER1_NODES_CONFIG_01, runtime.vars.TIER1_NODES_CONFIG_01);
assert.equal(wrangler.d1_databases[0].database_id, 'd1-id');
assert.deepEqual(wrangler.kv_namespaces, [{ binding: 'TIER1_AFFINITY', id: 'kv-id' }]);
assert.ok(path.isAbsolute(wrangler.main), 'entry point must be absolute (config lives in RUNNER_TEMP)');
assert.ok(path.isAbsolute(wrangler.d1_databases[0].migrations_dir), 'migrations_dir must be absolute');

assert.deepEqual(
  withStaleNodeSecretsRemoved(runtime.secrets, [{ name: 'TIER1_NODES_SECRETS_01' }, { name: 'TIER1_NODES_SECRETS_02' }, { name: 'UNRELATED_SECRET' }]),
  { ...runtime.secrets, TIER1_NODES_SECRETS_02: null },
);

// ---- Individual GitHub Variables / Secrets collected from env ----

function envFixture({ legacy = false } = {}) {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    TOKEN_STATS_D1_ID: 'd1-id',
    TIER1_AFFINITY_KV_ID: 'kv-id',
    GATEWAY_PUBLIC_BASE_URL: 'https://gw.example.com',
    RATE_LIMIT_COOLDOWN_MS: '15000',
    FIRST_EVENT_TIMEOUT_MS: '15000',
    MODELS_CONFIG: JSON.stringify({ 'code-pro': { policy: 'default' } }),
    POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5 } }),
    TIER1_NODES_CONFIG_01: JSON.stringify([{ id: 'node-a', base_url: 'https://provider.example.com/v1', models: { 'code-pro': 'up' } }]),
    CLOUDFLARE_API_TOKEN: 'cf-token',
    GATEWAY_ACCESS_KEY_AIR: 'gw-key',
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'node-a': 'upstream-key' }),
  };
  if (legacy) {
    delete env.TIER1_NODES_CONFIG_01;
    delete env.MODELS_CONFIG;
    delete env.POLICIES_CONFIG;
    delete env.RATE_LIMIT_COOLDOWN_MS;
    delete env.FIRST_EVENT_TIMEOUT_MS;
    delete env.GATEWAY_ACCESS_KEY_AIR;
    delete env.TIER1_NODES_SECRETS_01;
    env.GATEWAY_CONFIG = JSON.stringify({
      TIER1_NODES_CONFIG_01: env.TIER1_NODES_CONFIG_01 || JSON.stringify([{ id: 'node-a', base_url: 'https://provider.example.com/v1', models: { 'code-pro': 'up' } }]),
      MODELS_CONFIG: { 'code-pro': { policy: 'default' } },
      POLICIES_CONFIG: { default: { max_attempts: 5 } },
    });
    env.GATEWAY_SECRETS_CONFIG = JSON.stringify({ GATEWAY_ACCESS_KEY_AIR: 'gw-key', TIER1_NODES_SECRETS_01: { 'node-a': 'upstream-key' } });
  }
  return env;
}

// Individual sources are collected and validate.
{
  const built = buildRuntimeFromEnv(envFixture());
  assert.equal(built.usedLegacyVars, false, 'individual vars used, not legacy');
  assert.equal(built.usedLegacySecrets, false, 'individual secrets used, not legacy');
  assert.deepEqual(built.warnings, [], 'no deprecation warnings when individual sources present');
  const c = validateGatewayRuntime(built.runtime);
  assert.equal(c.ready, true);
  assert.equal(JSON.parse(built.runtime.vars.TIER1_NODES_CONFIG_01)[0].id, 'node-a');
  assert.equal(built.runtime.vars.RATE_LIMIT_COOLDOWN_MS, '15000', 'runtime tunable passthrough');
  assert.equal(built.runtime.vars.FIRST_EVENT_TIMEOUT_MS, '15000', 'first-event tunable passthrough');
  assert.equal(JSON.parse(built.runtime.secrets.TIER1_NODES_SECRETS_01)['node-a'], 'upstream-key');
}

// Legacy blobs are read (with warnings) when individual sources are absent.
{
  const built = buildRuntimeFromEnv(envFixture({ legacy: true }));
  assert.equal(built.usedLegacyVars, true, 'legacy GATEWAY_CONFIG used');
  assert.equal(built.usedLegacySecrets, true, 'legacy GATEWAY_SECRETS_CONFIG used');
  assert.ok(built.warnings.some((w) => w.includes('GATEWAY_CONFIG is deprecated')), 'vars deprecation warning');
  assert.ok(built.warnings.some((w) => w.includes('GATEWAY_SECRETS_CONFIG is deprecated')), 'secrets deprecation warning');
  const c = validateGatewayRuntime(built.runtime);
  assert.equal(c.ready, true, 'legacy blob still produces a ready runtime');
}

// New individual sources win; legacy blobs are never merged in.
{
  const env = envFixture();
  env.GATEWAY_CONFIG = JSON.stringify({ TIER1_NODES_CONFIG_01: JSON.stringify([{ id: 'stale-node', base_url: 'https://stale.example.com/v1' }]) });
  env.GATEWAY_SECRETS_CONFIG = JSON.stringify({ GATEWAY_ACCESS_KEY_AIR: 'stale-key', TIER1_NODES_SECRETS_01: { 'node-a': 'stale' } });
  const built = buildRuntimeFromEnv(env);
  assert.equal(built.usedLegacyVars, false, 'individual vars take precedence over the legacy blob');
  assert.equal(built.usedLegacySecrets, false, 'individual secrets take precedence over the legacy blob');
  assert.equal(JSON.parse(built.runtime.vars.TIER1_NODES_CONFIG_01)[0].id, 'node-a', 'legacy node-a did not leak');
  assert.equal(built.runtime.secrets.GATEWAY_ACCESS_KEY_AIR, 'gw-key', 'legacy access key did not leak');
}

// Credentials must never appear in the vars map.
{
  const v = collectVarsFromEnv({ ...envFixture(), GATEWAY_ACCESS_KEY_AIR: 'gw-key', TIER1_NODES_SECRETS_01: JSON.stringify({ 'node-a': 'x' }) });
  assert.ok(!('GATEWAY_ACCESS_KEY_AIR' in v.vars), 'GATEWAY_ACCESS_KEY_AIR kept out of vars');
  assert.ok(!('TIER1_NODES_SECRETS_01' in v.vars), 'TIER1_NODES_SECRETS_01 kept out of vars');
}

// Empty values are skipped, not collected as empty strings.
{
  const env = envFixture();
  env.TIER1_NODES_CONFIG_02 = '';
  env.TIER1_NODES_SECRETS_02 = '';
  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  assert.ok(!('TIER1_NODES_CONFIG_02' in v.vars), 'empty variable skipped');
  assert.ok(!('TIER1_NODES_SECRETS_02' in s.secrets), 'empty secret skipped');
}

// Malformed legacy blob JSON fails clearly.
assert.throws(
  () => buildRuntimeFromEnv({ ...envFixture({ legacy: true }), GATEWAY_CONFIG: '{not json' }),
  /GATEWAY_CONFIG is not valid JSON/,
);

// Preflight passes for a complete configuration.
{
  const r = preflight(envFixture());
  assert.equal(r.ok, true, 'preflight ok for complete config');
  assert.deepEqual(r.errors, [], 'no preflight errors');
}

// Preflight FAILS (not skips) when required config is missing.
{
  const env = envFixture();
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.GATEWAY_PUBLIC_BASE_URL;
  delete env.TIER1_NODES_CONFIG_01;
  delete env.TIER1_NODES_SECRETS_01;
  delete env.GATEWAY_ACCESS_KEY_AIR;
  delete env.CLOUDFLARE_API_TOKEN;
  const r = preflight(env);
  assert.equal(r.ok, false, 'preflight fails on missing config');
  assert.ok(r.errors.some((e) => e.includes('CLOUDFLARE_ACCOUNT_ID')), 'names the missing variable');
  assert.ok(r.errors.some((e) => e.includes('GATEWAY_ACCESS_KEY_<GROUP>')), 'names the missing secret');
  assert.ok(r.errors.some((e) => e.includes('No TIER')), 'names the missing node-config shard');
  assert.ok(r.errors.some((e) => e.includes('No TIER[123]_NODES_SECRETS')), 'names the missing credential shard');
}

// MODELS_CONFIG / POLICIES_CONFIG absence is a warning, never a failure.
{
  const env = envFixture();
  delete env.MODELS_CONFIG;
  delete env.POLICIES_CONFIG;
  const r = preflight(env);
  assert.equal(r.ok, true, 'optional models/policies absence does not fail preflight');
  assert.ok(r.warnings.some((w) => w.includes('MODELS_CONFIG')), 'MODELS_CONFIG absence warned');
  assert.ok(r.warnings.some((w) => w.includes('POLICIES_CONFIG')), 'POLICIES_CONFIG absence warned');
}

// A node without a matching credential fails runtime validation.
{
  const built = buildRuntimeFromEnv({ ...envFixture(), TIER1_NODES_SECRETS_01: JSON.stringify({ 'other-node': 'key' }) });
  assert.throws(
    () => validateGatewayRuntime(built.runtime),
    /node.*has no credential|credential.*has no matching node|degraded|invalid/i,
  );
}

// The deployment summary contains safe counts only — never credential values.
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
    assert.ok(!summary.includes(forbidden), `summary never contains "${forbidden}"`);
  }
  const disabled = buildDeploymentSummary({ config: cfg, runtime, d1Configured: '', affinityKvConfigured: '' });
  assert.ok(disabled.includes('disabled'), 'D1 disabled is stated explicitly');
}

// ---- GATEWAY_ACCESS_MODELS_* as Variables (not Secrets) regression ----

// GATEWAY_ACCESS_MODELS_MAX is collected as a variable, not a secret.
{
  const env = envFixture();
  env.GATEWAY_ACCESS_KEY_MAX = 'max-secret';
  env.GATEWAY_ACCESS_MODELS_MAX = 'Max,Code-Max';
  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  assert.equal(v.vars.GATEWAY_ACCESS_MODELS_MAX, 'Max,Code-Max', 'MODELS_MAX collected in vars');
  assert.ok(!('GATEWAY_ACCESS_MODELS_MAX' in s.secrets), 'MODELS_MAX NOT in secrets');
}

// GATEWAY_ACCESS_KEY_* remains a secret, not a variable.
{
  const env = envFixture();
  env.GATEWAY_ACCESS_KEY_PRO = 'pro-secret';
  env.GATEWAY_ACCESS_MODELS_PRO = 'Pro';
  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  assert.ok(!('GATEWAY_ACCESS_KEY_PRO' in v.vars), 'KEY_PRO NOT in vars');
  assert.equal(s.secrets.GATEWAY_ACCESS_KEY_PRO, 'pro-secret', 'KEY_PRO collected in secrets');
}

// Deployment config: GATEWAY_ACCESS_MODELS_MAX appears in vars map, never in secrets.
{
  const env = envFixture();
  env.GATEWAY_ACCESS_KEY_MAX = 'max-key';
  env.GATEWAY_ACCESS_MODELS_MAX = 'Max,Code-Max';
  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  assert.ok('GATEWAY_ACCESS_MODELS_MAX' in v.vars, 'MODELS_MAX in vars map');
  assert.ok(!('GATEWAY_ACCESS_MODELS_MAX' in s.secrets), 'MODELS_MAX not in secrets map');
}

console.log('github deployment config tests passed.');
