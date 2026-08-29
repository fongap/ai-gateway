import assert from 'node:assert/strict';
import {
  parseRuntimeConfig, normalizeRuntimeConfig, validateGatewayRuntime, buildWranglerConfig, withStaleNodeSecretsRemoved,
} from './github-runtime-config.mjs';

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
    secrets: { GATEWAY_ACCESS_KEY: 'gateway-key', NODE_SECRETS_01: { 'node-a': 'upstream-key' } },
  };
}

const runtime = normalizeRuntimeConfig(parseRuntimeConfig(JSON.stringify(fixture())));
const cfg = validateGatewayRuntime(runtime);
assert.equal(cfg.ready, true);
assert.equal(cfg.nodesUsable, 1);
assert.equal(JSON.parse(runtime.vars.TIER1_NODES_CONFIG_01)[0].id, 'node-a');
assert.equal(JSON.parse(runtime.secrets.NODE_SECRETS_01)['node-a'], 'upstream-key');

assert.throws(
  () => normalizeRuntimeConfig(parseRuntimeConfig(JSON.stringify({ ...fixture(), vars: { ...fixture().vars, GATEWAY_ACCESS_KEY: 'nope' } }))),
  /credentials belong in secrets/,
);
assert.throws(
  () => normalizeRuntimeConfig(parseRuntimeConfig(JSON.stringify({ ...fixture(), secrets: { GATEWAY_ACCESS_KEY: 'x' } }))),
  /NODE_SECRETS/,
);
assert.throws(
  () => validateGatewayRuntime(normalizeRuntimeConfig(parseRuntimeConfig(JSON.stringify({
    ...fixture(), vars: { ...fixture().vars, MODELS_CONFIG: { 'code-pro': { policy: 'missing' } }, POLICIES_CONFIG: {}, },
  })))),
  /references unknown policy/,
);

const wrangler = buildWranglerConfig(runtime.vars, 'd1-id');
assert.equal(wrangler.keep_vars, false);
assert.equal(wrangler.vars.TIER1_NODES_CONFIG_01, runtime.vars.TIER1_NODES_CONFIG_01);
assert.equal(wrangler.d1_databases[0].database_id, 'd1-id');

assert.deepEqual(
  withStaleNodeSecretsRemoved(runtime.secrets, [{ name: 'NODE_SECRETS_01' }, { name: 'NODE_SECRETS_02' }, { name: 'UNRELATED_SECRET' }]),
  { ...runtime.secrets, NODE_SECRETS_02: null },
);
console.log('github runtime config tests passed.');
