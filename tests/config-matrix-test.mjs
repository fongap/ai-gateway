#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Config-effect Matrix contract tests. Node mappings are the PRIMARY source
// of the public model set; MODELS_CONFIG is OPTIONAL metadata that can
// downgrade a model to `visibility: 'internal'` to hide it. The governance
// matrix is therefore the product of (node-mapping presence x visibility):
//
//   node-mapped  x visibility   listed in public status/dashboard   requestable
//   yes          public        yes                                yes
//   yes          internal      no  (hidden)                       yes
//   no           (n/a)         no  (not public)                    no
//
// The Registry is OPTIONAL: an operator who only deploys node configs (the
// common free-model case) needs no MODELS_CONFIG. When MODELS_CONFIG IS
// present, the only thing it can do to the public catalog is hide internal
// models; it never widens the public set on its own.
//
// Requestability uses the real scheduler predicate the request handler relies
// on (supportsRequest): a request for a model with no serving node is exactly
// the 404 "No configured node provides model ..." denial path in handler.ts.

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
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const access = { GATEWAY_ACCESS_KEY_AIR: 'k', GATEWAY_ACCESS_MODELS_AIR: '*' };
const env = (models) => ({
  ...access,
  ...(models ? { MODELS_CONFIG: JSON.stringify(models) } : {}),
});
const node = (id, models) => ({
  id,
  provider: 'mock',
  tier: 'tier-1',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`,
  models,
  limits: { concurrency: 1 },
});
const configNode = (id) => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`,
  models: { 'Code-Max': 'up-model' },
  limits: { concurrency: 1 },
});
const budgetNode = (id, tier) => ({
  id,
  tier,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  baseUrl: `https://${id}.example.com/v1`,
  credential: 'k',
  priority: 10,
  models: { 'Code-Max': 'up-model' },
  limits: { concurrency: 1 },
});
const now = () => 1_700_000_000_000;
const reqFor = (model) => ({ model, protocol: 'openai', surface: 'chat_completions' });
const isRequestable = (nodes, model) => nodes.some((n) => supportsRequest(n, reqFor(model)));
const ids = (result) => result.models.map((m) => m.id);

// --- Primary rule: node mappings are the public set -------------------------

test('primary: node-mapped models are public by default, no MODELS_CONFIG required', () => {
  const nodes = [node('a', { 'public-air': 'up-air', 'public-max': 'up-max' })];
  recordTier1Ttft('a', 'public-air', 100, now() - 1000);
  // No MODELS_CONFIG: both models should still be listed.
  const result = getPublicModelStatus(nodes, env(null), new Set(), now());
  assert.ok(ids(result).includes('public-air'), 'node-mapped model listed without MODELS_CONFIG');
  assert.ok(ids(result).includes('public-max'), 'node-mapped model listed without MODELS_CONFIG');
});

// --- Governance: visibility:internal hides a node-mapped model ---------------

test('governance: internal model hidden from public status AND dashboard HTML; public model present', () => {
  const nodes = [node('a', { 'public-vis': 'up-pub', 'private-vis': 'up-priv' })];
  recordTier1Ttft('a', 'public-vis', 100, now() - 1000);
  recordTier1Ttft('a', 'private-vis', 100, now() - 1000);
  const result = getPublicModelStatus(nodes, env({
    'public-vis': { policy: 'fast' },
    'private-vis': { policy: 'fast', visibility: 'internal' },
  }), new Set(), now());
  assert.ok(ids(result).includes('public-vis'), 'public model is listed in public status');
  assert.ok(!ids(result).includes('private-vis'), 'internal model is hidden from public status');
  const { html } = renderModels(result);
  assert.ok(html.includes('public-vis'), 'public model appears in the rendered dashboard HTML');
  assert.ok(!html.includes('private-vis'), 'internal model never reaches the rendered dashboard HTML');
});

// --- Governance: node-mapped + public + available + requestable --------------

test('governance: public + node + serving + available -> listed, available, requestable, dashboard-visible', () => {
  const nodes = [node('p1', { 'public-air': 'up-air' })];
  recordTier1Ttft('p1', 'public-air', 100, now() - 1000);
  const result = getPublicModelStatus(nodes, env({ 'public-air': { policy: 'fast' } }), new Set(), now());
  const entry = result.models.find((m) => m.id === 'public-air');
  assert.ok(entry, 'public model is listed in public status');
  assert.equal(entry.status, 'available', 'serving node with a TTFT sample -> available');
  assert.ok(isRequestable(nodes, 'public-air'), 'public model with a serving node IS requestable');
  const { html } = renderModels(result);
  assert.ok(html.includes('public-air'), 'public model is rendered on the dashboard');
});

// --- Governance: internal + node + serving + hidden, but still requestable --

test('governance: internal + node + serving -> hidden from public, but requestable', () => {
  const nodes = [node('i1', { 'internal-pro': 'up-pro' })];
  recordTier1Ttft('i1', 'internal-pro', 100, now() - 1000);
  const result = getPublicModelStatus(nodes, env({
    'internal-pro': { policy: 'fast', visibility: 'internal' },
  }), new Set(), now());
  assert.ok(!ids(result).includes('internal-pro'), 'internal model is hidden from public status');
  const { html } = renderModels(result);
  assert.ok(!html.includes('internal-pro'), 'internal model is hidden from the dashboard HTML');
  assert.ok(isRequestable(nodes, 'internal-pro'), 'internal model with a serving node IS requestable');
});

// --- Governance: not node-mapped -> not in the public set at all -------------

test('governance: a model declared in MODELS_CONFIG but with no node is NOT public', () => {
  // public-air exists in MODELS_CONFIG but no node maps it.
  const result = getPublicModelStatus([], env({ 'public-air': { policy: 'fast' } }), new Set(), now());
  assert.ok(!ids(result).includes('public-air'),
    'MODELS_CONFIG alone never surfaces a model — node mappings are required');
  assert.ok(!isRequestable([], 'public-air'), 'no serving node -> request denied (404 path)');
});

// --- Visibility default: no explicit field => public ------------------------

test('visibility default: a node-mapped model with NO explicit visibility field is treated as public', () => {
  const nodes = [node('d1', { 'no-field': 'up' })];
  recordTier1Ttft('d1', 'no-field', 100, now() - 1000);
  const result = getPublicModelStatus(nodes, env({ 'no-field': { policy: 'fast' } }), new Set(), now());
  assert.ok(ids(result).includes('no-field'), 'missing visibility field defaults to public -> listed');
  const { html } = renderModels(result);
  assert.ok(html.includes('no-field'), 'missing visibility field defaults to public -> rendered on dashboard');
});

// --- MODELS_CONFIG never widens: it can only narrow (visibility:internal) --

test('MODELS_CONFIG never widens: a model in MODELS_CONFIG but no node mapping is still not public', () => {
  const result = getPublicModelStatus([], env({
    'registry-only': { policy: 'fast' },
  }), new Set(), now());
  assert.ok(!ids(result).includes('registry-only'),
    'MODELS_CONFIG cannot surface a model that no node maps to');
});

// --- Secret tier isolation --------------------------------------------------

test('secret tier: same tier may bind across different shard suffixes', () => {
  const cfg = loadGatewayConfig({
    ...access,
    TIER1_NODES_CONFIG_01: JSON.stringify([configNode('same-tier')]),
    TIER1_NODES_SECRETS_07: JSON.stringify({ 'same-tier': 'secret' }),
  });
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.ready, true);
  assert.equal(cfg.nodes[0].credential, 'secret');
});

test('secret tier: TIER2 node cannot consume a TIER1 credential', () => {
  const cfg = loadGatewayConfig({
    ...access,
    TIER2_NODES_CONFIG_01: JSON.stringify([configNode('tier2-cross')]),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'tier2-cross': 'secret' }),
  });
  assert.equal(cfg.status, 'invalid');
  assert.equal(cfg.ready, false);
  const diag = cfg.diagnostics.find((d) => d.includes('tier2-cross')) || '';
  assert.match(diag, /TIER2/);
  assert.match(diag, /TIER1/);
});

test('secret tier: TIER3 node cannot consume a TIER2 credential', () => {
  const cfg = loadGatewayConfig({
    ...access,
    TIER3_NODES_CONFIG_01: JSON.stringify([configNode('tier3-cross')]),
    TIER2_NODES_SECRETS_07: JSON.stringify({ 'tier3-cross': 'secret' }),
  });
  assert.equal(cfg.status, 'invalid');
  assert.equal(cfg.ready, false);
  const diag = cfg.diagnostics.find((d) => d.includes('tier3-cross')) || '';
  assert.match(diag, /TIER3/);
  assert.match(diag, /TIER2/);
});

// --- Explicit tier_attempts contract ---------------------------------------

test('weighted tier_attempts: explicit Tier2=3 stays 3 when it is the only dispatchable tier', () => {
  const tiers = { 1: [], 2: [budgetNode('only-t2', 'tier-2')], 3: [] };
  const policy = {
    maxAttempts: 6,
    tierAttempts: { tier2: 3 },
    hedge: null,
    firstEventTimeoutMs: null,
    budgetSplit: 'weighted',
  };
  const caps = computeTierCaps(tiers, reqFor('Code-Max'), new Set(), policy, new Set());
  assert.equal(caps[2], 3, 'weighted reconciliation must not inflate explicit Tier2 from 3 to 6');
});

test('POLICIES_CONFIG rejects explicit tier_attempts total above max_attempts', () => {
  const extra = {
    POLICIES_CONFIG: JSON.stringify({
      over: { max_attempts: 6, tier_attempts: { tier2: 4, tier3: 4 }, budget_split: 'weighted' },
    }),
  };
  const diags = getPoliciesConfigDiagnostics(extra);
  assert.ok(diags.some((d) => d.includes('tier_attempts total exceeds max_attempts')),
    `expected tier_attempts total diagnostic, got ${diags}`);

  const cfg = loadGatewayConfig({
    ...access,
    TIER2_NODES_CONFIG_01: JSON.stringify([configNode('over-budget')]),
    TIER2_NODES_SECRETS_01: JSON.stringify({ 'over-budget': 'secret' }),
    ...extra,
  });
  assert.equal(cfg.status, 'invalid');
  assert.equal(cfg.ready, false);
});

test('tier_attempts: unset Tier3 receives only the remaining budget', () => {
  const tiers = {
    1: [],
    2: [budgetNode('split-t2', 'tier-2')],
    3: [budgetNode('split-t3', 'tier-3')],
  };
  const basePolicy = {
    maxAttempts: 6,
    tierAttempts: { tier2: 3 },
    hedge: null,
    firstEventTimeoutMs: null,
  };
  const weightedCaps = computeTierCaps(tiers, reqFor('Code-Max'), new Set(), { ...basePolicy, budgetSplit: 'weighted' }, new Set());
  const evenCaps = computeTierCaps(tiers, reqFor('Code-Max'), new Set(), { ...basePolicy, budgetSplit: 'even' }, new Set());
  assert.equal(weightedCaps[2], 3, 'weighted keeps explicit Tier2 fixed');
  assert.equal(weightedCaps[3], 3, 'weighted gives remaining 3 attempts to unset Tier3');
  assert.equal(evenCaps[2], 3, 'even keeps explicit Tier2 fixed');
  assert.equal(evenCaps[3], 3, 'even gives remaining 3 attempts to unset Tier3');
});

test('Tier1 has no independent attempt cap beyond max_attempts and tier_attempts', () => {
  const tiers = {
    1: Array.from({ length: 5 }, (_, i) => budgetNode(`tier1-${i + 1}`, 'tier-1')),
    2: [],
    3: [],
  };
  const basePolicy = {
    maxAttempts: 5,
    tierAttempts: { tier1: 5 },
    hedge: null,
    firstEventTimeoutMs: null,
  };
  const evenCaps = computeTierCaps(tiers, reqFor('Code-Max'), new Set(), { ...basePolicy, budgetSplit: null }, new Set());
  const weightedCaps = computeTierCaps(tiers, reqFor('Code-Max'), new Set(), { ...basePolicy, budgetSplit: 'weighted' }, new Set());
  assert.equal(evenCaps[1], 5, 'default split must honor explicit Tier1=5');
  assert.equal(weightedCaps[1], 5, 'weighted split must honor explicit Tier1=5');
});

console.log(`\nconfig-matrix tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some config-matrix tests FAILED.');
} else {
  console.log('All config-matrix tests passed.');
}
