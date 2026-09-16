#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { getPublicModelStatus } from '../src/runtime/model-status.ts';
import { renderModels } from '../src/dashboard/model-status-view.ts';
import { supportsRequest } from '../src/scheduler/scheduler.ts';
import { __resetTier1StateForTests, recordTier1Ttft } from '../src/reliability/tier1-state.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { loadGatewayConfig } from '../src/config/nodes.ts';
import { getPoliciesConfigDiagnostics } from '../src/config/policies.ts';
import { computeTierCaps } from '../src/request/tier-loop.ts';

let passed = 0;
function test(name, fn) {
  try {
    __resetTier1StateForTests();
    __resetAllStateForTests();
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}

const access = { GATEWAY_ACCESS_KEY_AIR: 'k', GATEWAY_ACCESS_MODELS_AIR: '*' };
const env = (models) => ({ ...access, ...(models ? { MODELS_CONFIG: JSON.stringify(models) } : {}) });
const runtimeNode = (id, models) => ({
  id, provider: 'mock', tier: 'tier-1', protocol: 'openai', surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`, models,
});
const configNode = (id) => ({
  id, provider: 'mock',
  base_url: `https://${id}.example.com/v1`, models: { 'Code-Max': 'up-model' },
});
const budgetNode = (id, tier) => ({
  id, tier, provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
  baseUrl: `https://${id}.example.com/v1`, credential: 'k', priority: 10,
  models: { 'Code-Max': 'up-model' },
});
const now = () => 1_700_000_000_000;
const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };
const ids = (result) => result.models.map((m) => m.id);

test('node-mapped models are public without MODELS_CONFIG', () => {
  const nodes = [runtimeNode('a', { 'public-air': 'up-air', 'public-max': 'up-max' })];
  recordTier1Ttft('a', 'public-air', 100, now() - 1000);
  const result = getPublicModelStatus(nodes, env(null), new Set(), now());
  assert.ok(ids(result).includes('public-air'));
  assert.ok(ids(result).includes('public-max'));
});

test('visibility internal hides a mapped model but does not make it unrequestable', () => {
  const nodes = [runtimeNode('a', { pub: 'up-pub', hidden: 'up-hidden' })];
  recordTier1Ttft('a', 'pub', 100, now() - 1000);
  recordTier1Ttft('a', 'hidden', 100, now() - 1000);
  const result = getPublicModelStatus(nodes, env({ pub: {}, hidden: { visibility: 'internal' } }), new Set(), now());
  assert.ok(ids(result).includes('pub'));
  assert.ok(!ids(result).includes('hidden'));
  const { html } = renderModels(result);
  assert.ok(html.includes('pub'));
  assert.ok(!html.includes('hidden'));
  assert.equal(nodes.some((n) => supportsRequest(n, { model: 'hidden', protocol: 'openai', surface: 'chat_completions' })), true);
});

test('MODELS_CONFIG alone never widens public/requestable models', () => {
  const result = getPublicModelStatus([], env({ orphan: { policy: 'fast' } }), new Set(), now());
  assert.ok(!ids(result).includes('orphan'));
  assert.equal([].some((n) => supportsRequest(n, { model: 'orphan', protocol: 'openai', surface: 'chat_completions' })), false);
});

test('same-tier credential may live in a different shard suffix', () => {
  const cfg = loadGatewayConfig({
    ...access,
    TIER1_NODES_CONFIG_01: JSON.stringify([configNode('same-tier')]),
    TIER1_NODES_SECRETS_07: JSON.stringify({ 'same-tier': 'secret' }),
  });
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.nodes[0].credential, 'secret');
});

test('cross-tier credential binding is rejected', () => {
  const cfg = loadGatewayConfig({
    ...access,
    TIER2_NODES_CONFIG_01: JSON.stringify([configNode('tier2-cross')]),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'tier2-cross': 'secret' }),
  });
  assert.equal(cfg.ready, false);
  assert.ok(cfg.diagnostics.some((d) => d.includes('tier2-cross') && d.includes('TIER2') && d.includes('TIER1')));
});

test('explicit tier_attempts remains a hard cap', () => {
  const tiers = { 1: [], 2: [budgetNode('t2', 'tier-2')], 3: [] };
  const policy = { maxAttempts: 6, tierAttempts: { tier2: 3 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
  const caps = computeTierCaps(tiers, req, new Set(), policy, new Set());
  assert.equal(caps[2], 3);
});

test('unset lower tier receives remaining budget after explicit higher-tier cap', () => {
  const tiers = { 1: [], 2: [budgetNode('t2', 'tier-2')], 3: [budgetNode('t3', 'tier-3')] };
  const policy = { maxAttempts: 6, tierAttempts: { tier2: 3 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
  const caps = computeTierCaps(tiers, req, new Set(), policy, new Set());
  assert.equal(caps[2], 3);
  assert.equal(caps[3], 3);
});

test('surplus goes to the first adjustable dispatchable tier', () => {
  const tiers = {
    1: [budgetNode('t1a', 'tier-1'), budgetNode('t1b', 'tier-1')],
    2: [budgetNode('t2', 'tier-2')], 3: [budgetNode('t3', 'tier-3')],
  };
  const policy = { maxAttempts: 5, tierAttempts: null, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
  assert.deepEqual(computeTierCaps(tiers, req, new Set(), policy, new Set()), { 1: 3, 2: 1, 3: 1 });
});

test('explicit zero disables a tier', () => {
  const tiers = { 1: [budgetNode('t1', 'tier-1')], 2: [budgetNode('t2', 'tier-2')], 3: [budgetNode('t3', 'tier-3')] };
  const policy = { maxAttempts: 4, tierAttempts: { tier2: 0 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
  const caps = computeTierCaps(tiers, req, new Set(), policy, new Set());
  assert.equal(caps[2], 0);
  assert.equal(caps[1], 3);
  assert.equal(caps[3], 1);
});

test('tier_attempts total above max_attempts is rejected', () => {
  const diags = getPoliciesConfigDiagnostics({ POLICIES_CONFIG: JSON.stringify({ over: { max_attempts: 6, tier_attempts: { tier2: 4, tier3: 4 } } }) });
  assert.ok(diags.some((d) => d.includes('tier_attempts total exceeds max_attempts')));
});

test('budget_split is not a current policy field', () => {
  const diags = getPoliciesConfigDiagnostics({ POLICIES_CONFIG: JSON.stringify({ bad: { max_attempts: 5, budget_split: 'weighted' } }) });
  assert.ok(diags.some((d) => d.includes('unknown field "budget_split"')));
});

console.log(`\nconfig-matrix tests: ${passed} passed.`);
if (process.exitCode) process.exit(1);
