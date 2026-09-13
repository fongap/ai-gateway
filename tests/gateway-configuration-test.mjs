#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  loadGatewayConfig,
  collectShards,
  TIER_SHARD_PATTERN,
  SECRET_SHARD_PATTERN,
} from '../src/config/nodes.ts';
import {
  loadModelRegistry,
  modelRegistryEntry,
  servesModel,
  isWildcardNode,
} from '../src/config/registry.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

function makeEnv({ tier1, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY_AIR: 'k',
    GATEWAY_ACCESS_MODELS_AIR: '*',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(secrets ? { TIER1_NODES_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

// Shards ---------------------------------------------------------------------

test('collectShards parses tier and shard indexes and rejects out-of-range indexes', () => {
  const diagnostics = [];
  const secrets = collectShards(
    { TIER1_NODES_SECRETS_01: '{}', TIER1_NODES_SECRETS_09: '{}', TIER1_NODES_SECRETS_12: '{}' },
    SECRET_SHARD_PATTERN,
    'TIER1_NODES_SECRETS_',
    'TIER1_NODES_SECRETS_01',
    2,
    diagnostics,
  );
  assert.deepEqual(secrets.map((entry) => entry.index).sort((a, b) => a - b), [1, 9]);
  assert.ok(diagnostics.some((d) => d.includes('TIER1_NODES_SECRETS_12') && d.includes('out of range')));
  const tiers = collectShards(
    { TIER2_NODES_CONFIG_03: '[]' },
    TIER_SHARD_PATTERN,
    'TIER2_NODES_CONFIG_',
    'TIER2_NODES_CONFIG_01',
    2,
    [],
  );
  assert.equal(tiers[0].tierNumber, 2);
  assert.equal(tiers[0].index, 3);
});

test('malformed shard names are diagnostic errors instead of silent input', () => {
  const diagnostics = [];
  collectShards(
    { TIER1_NODES_CONFIG_01: '[]', TIER1_NODES_CONFIG_XX: '[]' },
    TIER_SHARD_PATTERN,
    'TIER1_NODES_CONFIG_',
    'TIER1_NODES_CONFIG_01',
    2,
    diagnostics,
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /malformed shard name/);
});

// Strict node schema ---------------------------------------------------------

test('a fully explicit node is ready and carries no legacy capacity fields', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('ok')], secrets: { ok: 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.ready, true);
  assert.equal(cfg.nodes.length, 1);
  assert.equal(cfg.nodes[0].priority, 100);
  assert.equal(cfg.nodes[0].protocol, 'openai');
  assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);
  assert.equal('limits' in cfg.nodes[0], false);
});

test('legacy limits is rejected outright', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('legacy', { limits: { concurrency: 2, rpm: 60 } })],
    secrets: { legacy: 'x' },
  }));
  assert.equal(cfg.nodes.length, 0);
  assert.equal(cfg.status, 'degraded');
  assert.ok(cfg.diagnostics.some((d) => d.includes('unknown field "limits"')));
});

test('unknown top-level fields are rejected', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bad', { prioirty: 5 })], secrets: { bad: 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('prioirty')));
});

test('negative priority is rejected', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bad', { priority: -1 })], secrets: { bad: 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('priority')));
});

test('protocol is mandatory and never inferred', () => {
  const raw = { id: 'missing-protocol', provider: 'mock', surfaces: ['chat_completions'], base_url: 'https://x.example/v1', models: {} };
  const cfg = loadGatewayConfig(makeEnv({ tier1: [raw], secrets: { 'missing-protocol': 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('protocol is required')));
});

test('surfaces is mandatory and never inferred', () => {
  const raw = { id: 'missing-surfaces', provider: 'mock', protocol: 'openai', base_url: 'https://x.example/v1', models: {} };
  const cfg = loadGatewayConfig(makeEnv({ tier1: [raw], secrets: { 'missing-surfaces': 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('surfaces is required')));
});

test('invalid protocol and protocol/surface combinations are rejected', () => {
  for (const bad of ['gemini', 'grpc', 'OPENAI-X', '']) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bp', { protocol: bad })], secrets: { bp: 'x' } }));
    assert.equal(cfg.nodes.length, 0);
    assert.ok(cfg.diagnostics.some((d) => d.includes('protocol')));
  }
  const wrong = loadGatewayConfig(makeEnv({
    tier1: [node('sw', { protocol: 'anthropic', surfaces: ['chat_completions'] })],
    secrets: { sw: 'x' },
  }));
  assert.equal(wrong.nodes.length, 0);
  assert.ok(wrong.diagnostics.some((d) => d.includes('invalid for protocol "anthropic"')));
});

test('anthropic nodes require explicit messages surface', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('an', { protocol: 'anthropic', surfaces: ['messages'] })],
    secrets: { an: 'x' },
  }));
  assert.equal(cfg.status, 'ready');
  assert.deepEqual(cfg.nodes[0].surfaces, ['messages']);
});

test('OpenAI nodes may expose chat_completions and responses explicitly', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('multi', { surfaces: ['responses', 'chat_completions'] })],
    secrets: { multi: 'x' },
  }));
  assert.equal(cfg.status, 'ready');
  assert.deepEqual(cfg.nodes[0].surfaces, ['responses', 'chat_completions']);
});

// Models ---------------------------------------------------------------------

test('missing models or explicit empty object means wildcard inside the known catalog', () => {
  const missing = loadGatewayConfig(makeEnv({ tier1: [node('a', { models: undefined })], secrets: { a: 'x' } }));
  assert.deepEqual(missing.nodes[0].models, {});
  const empty = loadGatewayConfig(makeEnv({ tier1: [node('a', { models: {} })], secrets: { a: 'x' } }));
  assert.deepEqual(empty.nodes[0].models, {});
});

test('models must be an object; legacy arrays and scalar forms are rejected', () => {
  for (const value of [['model-a'], 'model-a', 5, true]) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bad', { models: value })], secrets: { bad: 'x' } }));
    assert.equal(cfg.nodes.length, 0, `models=${JSON.stringify(value)} must fail`);
    assert.ok(cfg.diagnostics.some((d) => d.includes('models')));
  }
});

test('invalid models mappings never collapse into wildcard', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('bad', { models: { 'general-air': 123 } })],
    secrets: { bad: 'x' },
  }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('models')));
});

// Registry -------------------------------------------------------------------

test('registry builds declared capabilities and keeps conservative defaults', () => {
  const env = makeEnv({
    tier1: [node('a', { models: {} })],
    secrets: { a: 'x' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({
        'code-pro': { policy: 'fast', capabilities: { vision: true }, reasoning_efforts: ['high'] },
      }),
    },
  });
  const registry = loadModelRegistry(env);
  assert.equal(registry['code-pro'].policy, 'fast');
  assert.equal(registry['code-pro'].capabilities.vision, true);
  assert.deepEqual(registry['code-pro'].reasoning_efforts, ['high']);
  const unknown = modelRegistryEntry(env, 'unknown-model');
  assert.equal(unknown.capabilities.tools, false);
  assert.equal(unknown.capabilities.reasoning, false);
  assert.equal(unknown.capabilities.vision, false);
  assert.equal(unknown.capabilities.ocr, false);
  assert.equal(unknown.ui_visible, true);
  assert.deepEqual(unknown.reasoning_efforts, []);
});

test('MODELS_CONFIG modalities are normalized without inventing undeclared modalities', () => {
  const env = makeEnv({
    tier1: [node('a', { models: {} })],
    secrets: { a: 'x' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({
        'omni-pro': { policy: 'default', modalities: { input: ['text', 'image', 'audio'], output: ['text', 'audio'] } },
      }),
    },
  });
  const registry = loadModelRegistry(env);
  assert.deepEqual(registry['omni-pro'].modalities, { input: ['text', 'image', 'audio'], output: ['text', 'audio'] });
  assert.equal(modelRegistryEntry(env, 'unknown-model').modalities, undefined);
});

test('servesModel keeps wildcard and explicit mapping semantics', () => {
  assert.equal(isWildcardNode(node('w', { models: {} })), true);
  assert.equal(servesModel(node('w', { models: {} }), 'anything'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'only'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'other'), false);
});

if (!process.exitCode) console.log(`gateway-configuration tests passed (${passed}).`);
