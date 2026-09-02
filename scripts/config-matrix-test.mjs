#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Config-effect Matrix contract tests. The governance matrix is the product of
// model VISIBILITY (public / internal) and REQUEST ALLOWANCE (is there a node
// that serves the model?). This file locks the four combinations against the
// real Model Registry and real getPublicModelStatus() projection:
//
//   visibility x allowance            listed in public status/dashboard   requestable
//   public     + allowed (node)       yes                                yes
//   public     + denied (no node)     yes (status: unavailable)          no
//   internal   + allowed (node)       no (hidden)                        yes
//   internal   + denied (no node)     no (hidden)                        no
//
// The Model Registry is the ONLY source of the public model set: a node's
// `models` map can never surface an undeclared (ghost) model, and an internal
// model never leaks into the public catalog or the rendered dashboard HTML.
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
  MODELS_CONFIG: JSON.stringify(models),
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

// --- Visibility: hidden internal vs listed public, same env -----------------

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

// --- Governance 1: public + allowed + node available => requestable ---------

test('governance 1: public + allowed + node available -> listed, available, requestable, dashboard-visible', () => {
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

// --- Governance 2: public + denied (no serving node) => hidden? no: listed --

test('governance 2: public + denied (no serving node) -> still listed, but request denied', () => {
  const nodes = [node('p2', { 'other': 'up-other' })]; // does NOT serve public-air
  const result = getPublicModelStatus(nodes, env({ 'public-air': { policy: 'fast' } }), new Set(), now());
  const entry = result.models.find((m) => m.id === 'public-air');
  assert.ok(entry, 'a denied PUBLIC model is still listed in the public catalog');
  assert.equal(entry.status, 'unavailable', 'no serving node -> unavailable');
  assert.ok(!isRequestable(nodes, 'public-air'), 'no serving node -> request denied (404 path)');
  const { html } = renderModels(result);
  assert.ok(html.includes('public-air'), 'a denied public model is still rendered on the dashboard');
});

// --- Governance 3: internal + allowed => hidden from public, but requestable --

test('governance 3: internal + allowed -> hidden from public status/dashboard, but requestable', () => {
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

// --- Governance 4: internal + denied => hidden from public, request denied ---

test('governance 4: internal + denied (no serving node) -> hidden from public status and request denied', () => {
  const nodes = [node('i2', { 'other': 'up-other' })]; // does NOT serve internal-pro
  const result = getPublicModelStatus(nodes, env({
    'internal-pro': { policy: 'fast', visibility: 'internal' },
  }), new Set(), now());
  assert.ok(!ids(result).includes('internal-pro'), 'internal model is hidden from public status');
  assert.ok(!isRequestable(nodes, 'internal-pro'), 'no serving node -> internal model request denied');
});

// --- Visibility default: no explicit field => public ------------------------

test('visibility default: a model with NO explicit visibility field is treated as public', () => {
  const nodes = [node('d1', { 'no-field': 'up' })];
  recordTier1Ttft('d1', 'no-field', 100, now() - 1000);
  const result = getPublicModelStatus(nodes, env({ 'no-field': { policy: 'fast' } }), new Set(), now());
  assert.ok(ids(result).includes('no-field'), 'missing visibility field defaults to public -> listed');
  const { html } = renderModels(result);
  assert.ok(html.includes('no-field'), 'missing visibility field defaults to public -> rendered on dashboard');
});

// --- Registry-only rule: node mappings can never surface a ghost model ------

test('registry-only rule: a node-mapped model NOT in the registry never appears in public status', () => {
  const nodes = [node('g1', { ghost: 'ghost-upstream' })];
  // MODELS_CONFIG declares public-air only; `ghost` exists only as a node key.
  const result = getPublicModelStatus(nodes, env({ 'public-air': { policy: 'fast' } }), new Set(), now());
  assert.ok(!ids(result).includes('ghost'), 'the registry is the only source of the public model set');
});

console.log(`\nconfig-matrix tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some config-matrix tests FAILED.');
} else {
  console.log('All config-matrix tests passed.');
}