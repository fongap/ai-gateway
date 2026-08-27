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
import { getModelsConfigDiagnostics } from '../src/config/models.js';
import { getPoliciesConfigDiagnostics } from '../src/config/policies.js';

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

test('rpm_mode defaults to hard when rpm is set; soft is opt-in; invalid rejected', () => {
  const def = loadGatewayConfig(makeEnv({ tier1: [node('d', { limits: { rpm: 10 } })], secrets: { d: 'x' } }));
  assert.equal(def.nodes[0].limits.rpmMode, 'hard');
  const soft = loadGatewayConfig(makeEnv({ tier1: [node('s', { limits: { rpm: 10, rpm_mode: 'soft' } })], secrets: { s: 'x' } }));
  assert.equal(soft.nodes[0].limits.rpmMode, 'soft');
  const bad = loadGatewayConfig(makeEnv({ tier1: [node('b', { limits: { rpm: 10, rpm_mode: 'unlimited' } })], secrets: { b: 'x' } }));
  assert.equal(bad.nodes.length, 0);
  assert.ok(bad.diagnostics.some((d) => d.includes('rpm_mode')));
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
  // Under-report, never over-report: undeclared models claim nothing beyond
  // streaming until MODELS_CONFIG explicitly declares the capability.
  const def = modelRegistryEntry(env, 'unknown-model');
  assert.equal(def.capabilities.tools, false, 'undeclared models must not promise tools');
  assert.equal(def.capabilities.reasoning, false, 'undeclared models must not promise reasoning');
  assert.equal(def.capabilities.vision, false);
  assert.deepEqual(def.reasoning_efforts, [], 'no reasoning efforts without a declaration');
});

test('servesModel treats empty models as wildcard, mapped as explicit', () => {
  assert.equal(isWildcardNode(node('w', { models: {} })), true);
  assert.equal(servesModel(node('w', { models: {} }), 'anything'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'only'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'other'), false);
});

// ---- Strict MODELS_CONFIG / POLICIES_CONFIG diagnostics --------------------
// Auxiliary configs must be as fail-fast as the node config: malformed JSON and
// field-level errors surface as diagnostics (visible via /health) + degraded
// status instead of silently falling back to defaults.

test('malformed MODELS_CONFIG is surfaced as a degraded-config diagnostic', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('m1', { models: { 'general-air': 'up' } })],
    secrets: { m1: 'k' },
    extraEnv: { MODELS_CONFIG: '{not json' },
  }));
  assert.equal(cfg.status, 'degraded', 'a malformed MODELS_CONFIG must not stay ready');
  assert.ok(cfg.diagnostics.some((d) => d.includes('MODELS_CONFIG')), `expected MODELS_CONFIG diagnostic, got ${cfg.diagnostics}`);
});

test('MODELS_CONFIG rejects unknown capabilities and non-boolean values', () => {
  const diags = getModelsConfigDiagnostics(makeEnv({ extraEnv: {
    MODELS_CONFIG: JSON.stringify({
      'm': { capabilities: { tools: true, visionz: true, reasoning: 'yes' } },
    }),
  } }));
  assert.ok(diags.some((d) => d.includes('capabilities.visionz')), 'unknown capability key must be flagged');
  assert.ok(diags.some((d) => d.includes('capabilities.reasoning')), 'non-boolean capability must be flagged');
});

test('malformed POLICIES_CONFIG is surfaced as a degraded-config diagnostic', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('p1')],
    secrets: { p1: 'k' },
    extraEnv: { POLICIES_CONFIG: '{bad' },
  }));
  assert.equal(cfg.status, 'degraded', 'a malformed POLICIES_CONFIG must not stay ready');
  assert.ok(cfg.diagnostics.some((d) => d.includes('POLICIES_CONFIG')), `expected POLICIES_CONFIG diagnostic, got ${cfg.diagnostics}`);
});

test('POLICIES_CONFIG rejects unknown fields, invalid max_attempts, invalid tier_attempts', () => {
  const diags = getPoliciesConfigDiagnostics(makeEnv({ extraEnv: {
    POLICIES_CONFIG: JSON.stringify({
      'bad': { max_attempts: 'abc', tier_attempts: { tier1: -1, tier9: 2 }, unknown_field: 1 },
      'ok': { max_attempts: 5 },
    }),
  } }));
  assert.ok(diags.some((d) => d.includes('unknown_field')), 'unknown policy field must be flagged');
  assert.ok(diags.some((d) => d.includes('max_attempts')), 'invalid max_attempts must be flagged');
  assert.ok(diags.some((d) => d.includes('tier_attempts.tier1')), 'out-of-range tier_attempts must be flagged');
  assert.ok(diags.some((d) => d.includes('tier_attempts.tier9')), 'unknown tier key must be flagged');
});

test('a model referencing an undefined policy is a config diagnostic', () => {
  const env = makeEnv({
    tier1: [node('x1')],
    secrets: { x1: 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'missing-policy' } }),
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5 } }),
    },
  });
  const cfg = loadGatewayConfig(env);
  assert.ok(cfg.diagnostics.some((d) => d.includes('missing-policy')),
    `unknown policy reference must be flagged, got ${cfg.diagnostics}`);
});

// ---- Strict MODELS_CONFIG / POLICIES_CONFIG defaults still serve -----------
// A VALID aux config must not trip degraded, and getPolicy must still resolve.

test('valid MODELS_CONFIG + POLICIES_CONFIG resolve and stay ready', () => {
  const env = makeEnv({
    tier1: [node('g1')],
    secrets: { g1: 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast', capabilities: { tools: true } } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 6, tier_attempts: { tier1: 4, tier2: 1 } } }),
    },
  });
  const cfg = loadGatewayConfig(env);
  assert.equal(cfg.status, 'ready', 'a valid aux config must not degrade the gateway');
  assert.equal(cfg.diagnostics.length, 0, 'valid config yields no diagnostics');
});

if (!process.exitCode) console.log(`config unit tests passed (${passed}).`);
else process.exit(1);
