#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {
  loadGatewayConfig, collectShards, TIER_SHARD_PATTERN, SECRET_SHARD_PATTERN,
} from '../src/config/nodes.ts';
import { loadModelRegistry, modelRegistryEntry, servesModel, isWildcardNode } from '../src/config/registry.ts';
import { getModelsConfigDiagnostics } from '../src/config/models.ts';
import { getPoliciesConfigDiagnostics, loadPoliciesConfig } from '../src/config/policies.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL: ${name}`); console.error(e?.stack || e); process.exitCode = 1; }
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
const policyDiags = (policies) => getPoliciesConfigDiagnostics(makeEnv({ extraEnv: { POLICIES_CONFIG: JSON.stringify(policies) } }));
const modelDiags = (models) => getModelsConfigDiagnostics(makeEnv({ extraEnv: { MODELS_CONFIG: JSON.stringify(models) } }));

// Shards.
test('collectShards accepts 01..10 and reports out-of-range/malformed names', () => {
  const diags = [];
  const secrets = collectShards(
    { TIER1_NODES_SECRETS_01: '{}', TIER1_NODES_SECRETS_09: '{}', TIER1_NODES_SECRETS_12: '{}' },
    SECRET_SHARD_PATTERN, 'TIER1_NODES_SECRETS_', 'TIER1_NODES_SECRETS_01', 2, diags,
  );
  assert.deepEqual(secrets.map((s) => s.index), [1, 9]);
  assert.ok(diags.some((d) => /12.*out of range/.test(d)));
  const tiers = collectShards({ TIER2_NODES_CONFIG_03: '[]' }, TIER_SHARD_PATTERN, 'TIER2_NODES_CONFIG_', 'TIER2_NODES_CONFIG_01', 2, []);
  assert.equal(tiers[0].tierNumber, 2);
  assert.equal(tiers[0].index, 3);
});

// Strict node schema: required current fields only.
test('fully explicit node config is ready', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('good')], secrets: { good: 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.nodes.length, 1);
  assert.equal(cfg.nodes[0].protocol, 'openai');
  assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);
});

test('provider, protocol, surfaces and models are required', () => {
  for (const field of ['provider', 'protocol', 'surfaces', 'models']) {
    const n = node(`missing-${field}`);
    delete n[field];
    const cfg = loadGatewayConfig(makeEnv({ tier1: [n], secrets: { [n.id]: 'x' } }));
    assert.equal(cfg.nodes.length, 0, `${field} omission must not be repaired by a default`);
    assert.ok(cfg.diagnostics.some((d) => d.includes(field)), `missing ${field} diagnostic required`);
  }
});

test('models accepts object only; explicit empty object is intentional wildcard', () => {
  const wildcard = loadGatewayConfig(makeEnv({ tier1: [node('w', { models: {} })], secrets: { w: 'x' } }));
  assert.equal(wildcard.status, 'ready');
  assert.deepEqual(wildcard.nodes[0].models, {});
  for (const bad of [['general-air'], 'deepseek', 5, true]) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bad-models', { models: bad })], secrets: { 'bad-models': 'x' } }));
    assert.equal(cfg.nodes.length, 0, `models=${JSON.stringify(bad)} must be rejected`);
  }
});

test('unknown, credential and retired capacity fields are rejected', () => {
  for (const extra of [
    { prioirty: 5 },
    { limits: { concurrency: 2 } },
    { api_key: 'secret' },
  ]) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bad-field', extra)], secrets: { 'bad-field': 'x' } }));
    assert.equal(cfg.nodes.length, 0);
  }
});

test('priority is numeric-only; absent priority uses current default 100', () => {
  const normal = loadGatewayConfig(makeEnv({ tier1: [node('prio')], secrets: { prio: 'x' } }));
  assert.equal(normal.nodes[0].priority, 100);
  for (const bad of [-1, '10', 1.5]) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('prio-bad', { priority: bad })], secrets: { 'prio-bad': 'x' } }));
    assert.equal(cfg.nodes.length, 0);
    assert.ok(cfg.diagnostics.some((d) => d.includes('priority')));
  }
});

test('protocol and surfaces are closed vocabularies', () => {
  const anthropic = loadGatewayConfig(makeEnv({
    tier1: [node('an', { protocol: 'anthropic', surfaces: ['messages'] })], secrets: { an: 'x' },
  }));
  assert.equal(anthropic.status, 'ready');
  const badProtocol = loadGatewayConfig(makeEnv({ tier1: [node('pbad', { protocol: 'gemini' })], secrets: { pbad: 'x' } }));
  assert.equal(badProtocol.nodes.length, 0);
  const badSurface = loadGatewayConfig(makeEnv({ tier1: [node('sbad', { protocol: 'anthropic', surfaces: ['chat_completions'] })], secrets: { sbad: 'x' } }));
  assert.equal(badSurface.nodes.length, 0);
});

// Registry / wildcard behavior.
test('registry carries declared capabilities and conservative defaults', () => {
  const env = makeEnv({
    tier1: [node('r', { models: {} })], secrets: { r: 'x' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ 'code-pro': { policy: 'fast', capabilities: { vision: true }, reasoning_efforts: ['high'] } }) },
  });
  const reg = loadModelRegistry(env);
  assert.equal(reg['code-pro'].capabilities.vision, true);
  assert.deepEqual(reg['code-pro'].reasoning_efforts, ['high']);
  const def = modelRegistryEntry(env, 'unknown-model');
  assert.equal(def.capabilities.tools, false);
  assert.equal(def.capabilities.reasoning, false);
  assert.equal(def.capabilities.vision, false);
});

test('wildcard and explicit model mappings remain distinct', () => {
  assert.equal(isWildcardNode(node('w', { models: {} })), true);
  assert.equal(servesModel(node('w', { models: {} }), 'known', new Set(['known'])), true);
  assert.equal(servesModel(node('w', { models: {} }), 'unknown', new Set(['known'])), false,
    'wildcard must be bounded by known catalog');
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'only', new Set(['only'])), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'other', new Set(['only', 'other'])), false);
});

test('MODELS_CONFIG rejects malformed or unknown capability fields', () => {
  const malformed = loadGatewayConfig(makeEnv({ tier1: [node('m1')], secrets: { m1: 'x' }, extraEnv: { MODELS_CONFIG: '{bad' } }));
  assert.equal(malformed.status, 'invalid');
  assert.equal(malformed.ready, false);
  const diags = modelDiags({ m: { capabilities: { visionz: true, reasoning: 'yes' } } });
  assert.ok(diags.some((d) => d.includes('visionz')));
  assert.ok(diags.some((d) => d.includes('reasoning')));
});

test('MODELS_CONFIG accepts current modalities/ocr/ui fields', () => {
  const env = makeEnv({ extraEnv: { MODELS_CONFIG: JSON.stringify({
    Omni: { modalities: { input: ['text', 'image', 'audio'], output: ['text', 'audio'] } },
    OCR: { capabilities: { ocr: true }, ui_visible: false },
  }) } });
  assert.deepEqual(getModelsConfigDiagnostics(env), []);
  const reg = loadModelRegistry(env);
  assert.deepEqual(reg.Omni.modalities, { input: ['text', 'image', 'audio'], output: ['text', 'audio'] });
  assert.equal(reg.OCR.capabilities.ocr, true);
  assert.equal(reg.OCR.ui_visible, false);
});

// Strict policy schema.
test('max_attempts and tier_attempts accept only bounded integer numbers', () => {
  for (const bad of ['5', -1, 0, 9, 1.5, null]) {
    assert.ok(policyDiags({ p: { max_attempts: bad } }).some((d) => d.includes('max_attempts')));
  }
  for (const bad of ['2', -1, 9, 1.5]) {
    assert.ok(policyDiags({ p: { tier_attempts: { tier1: bad } } }).some((d) => d.includes('tier_attempts.tier1')));
  }
  assert.deepEqual(policyDiags({ p: { max_attempts: 5, tier_attempts: { tier1: 3, tier2: 1, tier3: 1 } } }), []);
});

test('budget_split and other retired policy fields are rejected as unknown', () => {
  for (const value of ['even', 'weighted', null]) {
    const diags = policyDiags({ p: { max_attempts: 5, budget_split: value } });
    assert.ok(diags.some((d) => d.includes('unknown field "budget_split"')),
      `budget_split=${JSON.stringify(value)} must not be accepted`);
  }
});

test('hedge and max_in_flight current fields validate without coercion', () => {
  const policies = loadPoliciesConfig(makeEnv({ extraEnv: { POLICIES_CONFIG: JSON.stringify({ p: {
    max_attempts: 5,
    hedge: { enabled: true, delay_ms: 4000, tiers: ['tier1'] },
    max_in_flight: 4,
  } }) } }));
  assert.equal(policies.p.hedge.enabled, true);
  assert.equal(policies.p.hedge.delayMs, 4000);
  assert.deepEqual(policies.p.hedge.tiers, ['tier1']);
  assert.equal(policies.p.maxInFlight, 4);
  assert.ok(policyDiags({ p: { max_in_flight: '4' } }).some((d) => d.includes('max_in_flight')));
});

test('invalid policy/model references are fatal end-to-end', () => {
  const badAttempts = loadGatewayConfig(makeEnv({
    tier1: [node('f1')], secrets: { f1: 'x' },
    extraEnv: { POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 0 } }) },
  }));
  assert.equal(badAttempts.ready, false);
  const missingPolicy = loadGatewayConfig(makeEnv({
    tier1: [node('f2')], secrets: { f2: 'x' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'missing' } }) },
  }));
  assert.equal(missingPolicy.ready, false);
  assert.ok(missingPolicy.diagnostics.some((d) => d.includes('missing')));
});

if (!process.exitCode) console.log(`gateway configuration tests passed (${passed}).`);
else process.exit(1);
