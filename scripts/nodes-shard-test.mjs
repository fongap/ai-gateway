#!/usr/bin/env node
// Unit tests for the sharding/planning module (scripts/nodes-shard.mjs).
import assert from 'node:assert/strict';
import {
  buildPlan, assertNodesArray, assertSecretsObject,
  MANAGED_VAR_PATTERN, MANAGED_SECRET_PATTERN,
} from './nodes-shard.mjs';

const node = (id, extra = {}) => ({
  id,
  provider: 'p',
  base_url: 'https://api.example.com/v1',
  priority: 10,
  models: { 'general-air': 'model-a' },
  limits: { concurrency: 1 },
  ...extra,
});

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

test('valid plan shards nodes and secrets at entry boundaries', () => {
  const plan = buildPlan({
    tiers: { 1: [node('a'), node('b')], 2: [node('c')] },
    secretsMap: { a: 'cred-a', b: 'cred-b', c: 'cred-c' },
  });
  assert.equal(plan.plannedVars.length >= 2, true);
  assert.ok(plan.vars.TIER1_NODES_CONFIG_01.startsWith('[{'));
  assert.equal(Object.keys(plan.secrets).length >= 1, true);
  JSON.parse(plan.vars.TIER1_NODES_CONFIG_01);
  for (const value of Object.values(plan.secrets)) JSON.parse(value);
});

test('rejects credential fields inside node configs', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a', { token: 'sk-xxx' })] } }), /forbidden credential field/);
  assert.throws(() => buildPlan({ tiers: { 1: [node('a', { api_key: 'k' })] } }), /forbidden credential field/);
});

test('rejects tier field in node configs', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a', { tier: 'tier-1' })] } }), /must not declare "tier"/);
});

test('rejects duplicate node ids', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a'), node('a')] } }), /duplicate node id/);
});

test('rejects http base_url', () => {
  assert.throws(
    () => buildPlan({ tiers: { 1: [{ ...node('a'), base_url: 'http://api.example.com/v1' }] } }),
    /https:\/\/ base_url/,
  );
});

test('rejects node without matching credential', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a')] }, secretsMap: {} }), /no credential/);
});

test('rejects orphan credentials', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a')] }, secretsMap: { a: 'x', ghost: 'y' } }), /no matching node/);
});

test('oversized single node throws', () => {
  const big = node('big', { provider: 'x'.repeat(5000) });
  assert.throws(() => buildPlan({ tiers: { 1: [big] } }), /exceeds the .*-byte shard limit/);
});

test('stale shard deletion lists are computed', () => {
  const plan = buildPlan({
    tiers: { 1: [node('a')] },
    secretsMap: { a: 'x' },
    existingVarNames: ['TIER1_NODES_CONFIG_01', 'TIER1_NODES_CONFIG_02', 'TIER3_NODES_CONFIG_01'],
    existingSecretNames: ['NODE_SECRETS_01', 'NODE_SECRETS_02'],
  });
  assert.deepEqual(plan.deleteVars.sort(), ['TIER1_NODES_CONFIG_02', 'TIER3_NODES_CONFIG_01']);
  assert.deepEqual(plan.deleteSecrets, ['NODE_SECRETS_02']);
});

test('patterns only match managed names', () => {
  assert.ok(MANAGED_VAR_PATTERN.test('TIER2_NODES_CONFIG_07'));
  assert.ok(!MANAGED_VAR_PATTERN.test('GATEWAY_ACCESS_KEY'));
  assert.ok(MANAGED_SECRET_PATTERN.test('NODE_SECRETS_03'));
  assert.ok(MANAGED_SECRET_PATTERN.test('GATEWAY_ACCESS_KEY'));
  assert.ok(!MANAGED_SECRET_PATTERN.test('MY_SECRET'));
});

test('assertNodesArray rejects malformed entries', () => {
  assert.throws(() => assertNodesArray('[]'), /JSON array/);
  assert.throws(() => assertNodesArray([{ id: 'BAD ID' }]), /invalid/);
  assert.throws(() => assertSecretsObject([]), /JSON object/);
  assert.throws(() => assertSecretsObject({ a: '' }), /non-empty string/);
});

if (!process.exitCode) console.log(`nodes-shard tests passed (${passed}/11).`);
