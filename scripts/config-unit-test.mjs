#!/usr/bin/env node
// Unit tests for the config layer: shard index parsing, fail-fast Node schema,
// wildcard-vs-invalid `models` semantics, and the Model Registry.
import assert from 'node:assert/strict';
import {
  loadGatewayConfig, collectShards, TIER_SHARD_PATTERN, SECRET_SHARD_PATTERN,
} from '../src/config/nodes.js';
import {
  loadModelRegistry, modelRegistryEntry, servesModel, isWildcardNode,
} from '../src/config/registry.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

function makeEnv({ tier1, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY: 'k',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(secrets ? { NODE_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

// ---- Shard index capture groups -------------------------------------------

test('collectShards parses the correct index group per shard kind', () => {
  const secretShards = collectShards(
    { NODE_SECRETS_01: '{}', NODE_SECRETS_09: '{}', NODE_SECRETS_12: '{}' },
    SECRET_SHARD_PATTERN, 'NODE_SECRETS_', 'NODE_SECRETS_01', 1, [],
  );
  assert.deepEqual(secretShards.map((s) => s.index).sort((a, b) => a - b), [1, 9, 12]);
  assert.ok(secretShards.every((s) => Number.isInteger(s.index)), 'secret index must be a number, never NaN');

  const tierShards = collectShards(
    { TIER2_NODES_CONFIG_03: '[]' },
    TIER_SHARD_PATTERN, 'TIER2_NODES_CONFIG_', 'TIER2_NODES_CONFIG_01', 2, [],
  );
  assert.equal(tierShards[0].tierNumber, 2);
  assert.equal(tierShards[0].index, 3);
});

test('malformed shard name is flagged instead of silently ignored', () => {
  const diags = [];
  collectShards(
    { TIER1_NODES_CONFIG_01: '[]', TIER1_NODES_CONFIG_XX: '[]' },
    TIER_SHARD_PATTERN, 'TIER1_NODES_CONFIG_', 'TIER1_NODES_CONFIG_01', 2, diags,
  );
  assert.equal(diags.length, 1);
  assert.match(diags[0], /malformed shard name/);
});

// ---- models: wildcard vs invalid ------------------------------------------

test('models missing or explicit {} is a wildcard', () => {
  const missing = loadGatewayConfig(makeEnv({ tier1: [node('a', { models: undefined })], secrets: { a: 'x' } }));
  assert.deepEqual(missing.nodes[0].models, {});
  const empty = loadGatewayConfig(makeEnv({ tier1: [node('a', { models: {} })], secrets: { a: 'x' } }));
  assert.deepEqual(empty.nodes[0].models, {});
  assert.equal(empty.status, 'ready');
});

test('filled-but-invalid models map is a config error, NOT a wildcard', () => {
  const bad = loadGatewayConfig(makeEnv({ tier1: [node('bad', { models: { 'general-air': 123 } })], secrets: { bad: 'x' } }));
  assert.equal(bad.nodes.length, 0);
  assert.ok(bad.diagnostics.some((d) => d.includes('models')), `expected a models diagnostic, got ${bad.diagnostics}`);
});

test('scalar / boolean models value is rejected, never emptied into wildcard', () => {
  for (const value of ['deepseek', 5, true]) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('s', { models: value })], secrets: { s: 'x' } }));
    assert.equal(cfg.nodes.length, 0, `models=${JSON.stringify(value)} must not become a wildcard`);
    assert.ok(cfg.diagnostics.some((d) => d.includes('models')), 'must produce a models diagnostic');
  }
});

// ---- fail-fast Node schema -------------------------------------------------

test('unknown top-level field (prioirty typo) is rejected', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('b', { prioirty: 5 })], secrets: { b: 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('prioirty')), `expected unknown-field diagnostic, got ${cfg.diagnostics}`);
});

test('unknown limits field (concurency typo) is rejected', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('b', { limits: { concurency: 2 } })], secrets: { b: 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('concurency')), `expected limits diagnostic, got ${cfg.diagnostics}`);
});

test('invalid priority / concurrency / rpm are rejected with a named diagnostic', () => {
  const priority = loadGatewayConfig(makeEnv({ tier1: [node('p', { priority: -1 })], secrets: { p: 'x' } }));
  assert.equal(priority.nodes.length, 0);
  assert.ok(priority.diagnostics.some((d) => d.includes('priority')));
  const concurrency = loadGatewayConfig(makeEnv({ tier1: [node('c', { limits: { concurrency: 0 } })], secrets: { c: 'x' } }));
  assert.equal(concurrency.nodes.length, 0);
  assert.ok(concurrency.diagnostics.some((d) => d.includes('concurrency')));
  const rpm = loadGatewayConfig(makeEnv({ tier1: [node('r', { limits: { rpm: 'abc' } })], secrets: { r: 'x' } }));
  assert.equal(rpm.nodes.length, 0);
  assert.ok(rpm.diagnostics.some((d) => d.includes('rpm')));
});

test('valid priority defaults to 100 and concurrency to 2', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('ok')], secrets: { ok: 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.nodes[0].priority, 100);
  assert.equal(cfg.nodes[0].limits.concurrency, 2);
});

// ---- Model Registry --------------------------------------------------------

test('registry builds capability + policy from MODELS_CONFIG and fills conservative defaults', () => {
  const env = makeEnv({
    tier1: [node('a', { models: {} })],
    secrets: { a: 'x' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({
        'code-pro': { policy: 'fast', capabilities: { vision: true }, reasoning_efforts: ['high'] },
      }),
    },
  });
  const reg = loadModelRegistry(env);
  assert.equal(reg['code-pro'].policy, 'fast');
  assert.equal(reg['code-pro'].capabilities.vision, true);
  assert.deepEqual(reg['code-pro'].reasoning_efforts, ['high']);
  const def = modelRegistryEntry(env, 'unknown-model');
  assert.equal(def.capabilities.tools, true);
  assert.equal(def.capabilities.vision, false, 'unknown models must be conservative (no vision)');
});

test('servesModel treats empty models as wildcard, mapped as explicit', () => {
  assert.equal(isWildcardNode(node('w', { models: {} })), true);
  assert.equal(servesModel(node('w', { models: {} }), 'anything'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'only'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'other'), false);
});

if (!process.exitCode) console.log(`config unit tests passed (${passed}).`);
else process.exit(1);
