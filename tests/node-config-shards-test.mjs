#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {
  buildPlan, assertNodesArray, assertSecretsObject,
  MANAGED_VAR_PATTERN, MANAGED_SECRET_PATTERN, MAX_SHARD_NUMBER,
} from '../scripts/node-config-shards.mjs';

const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: 'https://api.example.com/v1',
  priority: 10,
  models: { 'general-air': 'model-a' },
  ...extra,
});

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`FAIL: ${name}`); console.error(error?.stack || error); process.exitCode = 1; }
}

test('valid plan shards current nodes and tier-scoped secrets', () => {
  const plan = buildPlan({ tiers: { 1: [node('a'), node('b')], 2: [node('c')] }, secretsMap: { a: 'cred-a', b: 'cred-b', c: 'cred-c' } });
  assert.ok(plan.vars.TIER1_NODES_CONFIG_01.startsWith('[{'));
  assert.ok(plan.vars.TIER2_NODES_CONFIG_01.startsWith('[{'));
  assert.ok(plan.secrets.TIER1_NODES_SECRETS_01);
  assert.ok(plan.secrets.TIER2_NODES_SECRETS_01);
  for (const value of Object.values(plan.vars)) JSON.parse(value);
  for (const value of Object.values(plan.secrets)) JSON.parse(value);
});

test('credential fields and tier field are rejected', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a', { token: 'x' })] } }), /forbidden credential field/);
  assert.throws(() => buildPlan({ tiers: { 1: [node('a', { tier: 'tier-1' })] } }), /must not declare "tier"/);
});

test('node ids must be unique inside and across tiers', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a'), node('a')] } }), /duplicate node id/);
  assert.throws(() => buildPlan({ tiers: { 1: [node('a')], 2: [node('a')] } }), /duplicate node id.*across/i);
});

test('provider base_url and models are explicit required fields', () => {
  for (const field of ['provider', 'base_url', 'models']) {
    const n = node('a');
    delete n[field];
    assert.throws(() => assertNodesArray([n]), new RegExp(field));
  }
});

test('protocol and surfaces are provider-owned, not node fields', () => {
  assert.throws(() => assertNodesArray([node('a', { protocol: 'openai' })]), /unknown field "protocol"/);
  assert.throws(() => assertNodesArray([node('a', { surfaces: ['chat_completions'] })]), /unknown field "surfaces"/);
});

test('base_url must be valid https without credentials', () => {
  assert.throws(() => assertNodesArray([node('a', { base_url: 'http://api.example.com' })]), /https:\/\//);
  assert.throws(() => assertNodesArray([node('a', { base_url: 'https://u:p@example.com' })]), /username\/password/);
  assert.throws(() => assertNodesArray([node('a', { base_url: 'not-a-url' })]), /invalid base_url/);
});

test('priority accepts only non-negative integer numbers', () => {
  assert.throws(() => assertNodesArray([node('a', { priority: '10' })]), /priority/);
  assert.throws(() => assertNodesArray([node('a', { priority: 1.5 })]), /priority/);
  assert.throws(() => assertNodesArray([node('a', { priority: -1 })]), /priority/);
  assert.doesNotThrow(() => assertNodesArray([node('a', { priority: 0 })]));
});

test('models accepts object only; explicit empty object is wildcard', () => {
  assert.doesNotThrow(() => assertNodesArray([node('a', { models: {} })]));
  assert.throws(() => assertNodesArray([node('a', { models: undefined })]), /models is required/);
  assert.throws(() => assertNodesArray([node('a', { models: ['m'] })]), /models is required/);
  assert.throws(() => assertNodesArray([node('a', { models: { m: 1 } })]), /models\["m"\]/);
});

test('retired limits and unknown fields are rejected', () => {
  assert.throws(() => assertNodesArray([node('a', { limits: { concurrency: 2 } })]), /unknown field "limits"/);
  assert.throws(() => assertNodesArray([node('a', { prioirty: 5 })]), /unknown field "prioirty"/);
});

test('node without credential and orphan credential both fail planning', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('a')] }, secretsMap: {} }), /no credential/);
  assert.throws(() => buildPlan({ tiers: { 1: [node('a')] }, secretsMap: { a: 'x', ghost: 'y' } }), /no matching node/);
});

test('secret object is strict', () => {
  assert.throws(() => assertSecretsObject([]), /JSON object/);
  assert.throws(() => assertSecretsObject({ a: '' }), /non-empty string/);
  assert.throws(() => assertSecretsObject({ 'BAD ID': 'x' }), /valid node id/);
});

test('oversized entry fails before producing invalid shards', () => {
  assert.throws(() => buildPlan({ tiers: { 1: [node('big', { provider: 'x'.repeat(5000) })] }, secretsMap: { big: 'x' } }), /exceeds the .*-byte shard limit/);
});

test('stale managed shard lists are computed', () => {
  const plan = buildPlan({
    tiers: { 1: [node('a')] }, secretsMap: { a: 'x' },
    existingVarNames: ['TIER1_NODES_CONFIG_01', 'TIER1_NODES_CONFIG_02', 'TIER3_NODES_CONFIG_01'],
    existingSecretNames: ['TIER1_NODES_SECRETS_01', 'TIER1_NODES_SECRETS_02', 'GATEWAY_ACCESS_KEY'],
  });
  assert.deepEqual(plan.deleteVars, ['TIER1_NODES_CONFIG_02', 'TIER3_NODES_CONFIG_01']);
  assert.deepEqual(plan.deleteSecrets, ['TIER1_NODES_SECRETS_02']);
});

test('managed patterns cover current shards only', () => {
  assert.ok(MANAGED_VAR_PATTERN.test('TIER2_NODES_CONFIG_07'));
  assert.ok(MANAGED_SECRET_PATTERN.test('TIER1_NODES_SECRETS_03'));
  assert.ok(!MANAGED_SECRET_PATTERN.test('GATEWAY_ACCESS_KEY'));
  assert.ok(!MANAGED_SECRET_PATTERN.test('TIER1_NODES_SECRETS_11'));
});

test('planner never emits shard index above 10', () => {
  assert.equal(MAX_SHARD_NUMBER, 10);
  const nodes = Array.from({ length: 240 }, (_, i) => node(`n${i}`));
  const secretsMap = Object.fromEntries(nodes.map((n) => [n.id, 'x']));
  const plan = buildPlan({ tiers: { 1: nodes }, secretsMap });
  for (const key of [...Object.keys(plan.vars), ...Object.keys(plan.secrets)]) {
    const match = /(\d{2})$/.exec(key);
    assert.ok(match);
    assert.ok(Number(match[1]) >= 1 && Number(match[1]) <= 10, key);
  }
});

if (process.exitCode) process.exit(1);
console.log(`node-config-shards tests passed (${passed}).`);
