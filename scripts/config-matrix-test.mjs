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
// the 404 "No configured node provides model ..." denial path in handler.js.

import assert from 'node:assert/strict';
import { getPublicModelStatus } from '../src/runtime/model-status.js';
import { renderModels } from '../src/dashboard/model-status-view.js';
import { supportsRequest } from '../src/scheduler/scheduler.js';
import { __resetTier1StateForTests, recordTier1Ttft } from '../src/reliability/tier1-state.js';
import { __resetAllStateForTests } from '../src/reliability/node-state.js';

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

const env = (models) => ({
  GATEWAY_ACCESS_KEY: 'k',
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

console.log(`\nconfig-matrix tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some config-matrix tests FAILED.');
} else {
  console.log('All config-matrix tests passed.');
}