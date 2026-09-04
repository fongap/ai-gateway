#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Closed Model Catalog regression tests (PR 1 — P0 security fix).
//
// Verifies:
//   * knownModels = node models keys union MODELS_CONFIG keys (single source)
//   * wildcard node serves model IFF knownModels.has(requestedModel)
//   * unknown model -> fail closed -> never reaches scheduler / upstream
//   * "*" = all Known Models, never "any model string"
//   * empty catalog + wildcard node -> serves 0 models
//   * /v1/models visible == callable (authorization + scheduler + listing)
//   * collectConfiguredModels (node-only) is a strict subset of collectKnownModels

import assert from 'node:assert/strict';
import { collectKnownModels, collectConfiguredModels, servesModel, isWildcardNode } from '../src/config/registry.js';
import { authorizeModel, filterVisibleModels } from '../src/request/model-authz.js';
import { supportsRequest } from '../src/scheduler/scheduler.js';
import { __resetAccessKeysCacheForTests } from '../src/config/access-keys.js';

let passed = 0;
function test(name, fn) {
  try {
    __resetAccessKeysCacheForTests();
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const node = (id, models) => ({
  id, provider: 'mock', tier: 'tier-1', protocol: 'openai',
  surfaces: ['chat_completions'], base_url: `https://${id}.example.com/v1`,
  models, limits: { concurrency: 1 },
});
const wildcardNode = (id) => node(id, {});
const reqFor = (model) => ({ model, protocol: 'openai', surface: 'chat_completions' });
const allowAll = { authorized: true, allowAll: true, allowlist: new Set() };
const allowlist = (set) => ({ authorized: true, allowAll: false, allowlist: new Set(set) });

// --- Case 1: wildcard + empty catalog + allowlist=* + unknown model -> reject ---

test('Case 1: wildcard node + empty knownModels + allowlist=* + unknown model -> reject', () => {
  const nodes = [wildcardNode('w1')];
  const env = {}; // no MODELS_CONFIG, no node model mappings
  const known = collectKnownModels(nodes, env);
  assert.equal(known.size, 0, 'empty catalog when no node mappings and no MODELS_CONFIG');
  const authz = authorizeModel('gpt-unknown', known, allowAll);
  assert.equal(authz.allowed, false, 'unknown model must be rejected');
  assert.equal(authz.status, 404, 'fail closed with 404');
  // Scheduler defense-in-depth: wildcard does NOT serve the unknown model
  assert.equal(servesModel(wildcardNode('w1'), 'gpt-unknown', known), false,
    'wildcard node must not serve unknown model when catalog is empty');
  assert.equal(supportsRequest(wildcardNode('w1'), reqFor('gpt-unknown'), known), false,
    'supportsRequest must deny unknown model for wildcard node with empty catalog');
});

// --- Case 2: MODELS_CONFIG={Code-Max} + wildcard + allowlist=* + Code-Max -> allowed ---

test('Case 2: MODELS_CONFIG={Code-Max} + wildcard + allowlist=* + Code-Max -> allowed', () => {
  const nodes = [wildcardNode('w1')];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  assert.ok(known.has('Code-Max'), 'Code-Max is in the known catalog via MODELS_CONFIG');
  const authz = authorizeModel('Code-Max', known, allowAll);
  assert.equal(authz.allowed, true, 'Code-Max must be allowed');
  assert.equal(servesModel(wildcardNode('w1'), 'Code-Max', known), true,
    'wildcard node serves Code-Max (it is in the catalog)');
  assert.equal(supportsRequest(wildcardNode('w1'), reqFor('Code-Max'), known), true,
    'supportsRequest allows Code-Max via wildcard node');
});

// --- Case 3: MODELS_CONFIG={Code-Max} + wildcard + allowlist=* + gpt-4.1 -> reject ---

test('Case 3: MODELS_CONFIG={Code-Max} + wildcard + allowlist=* + gpt-4.1 -> reject', () => {
  const nodes = [wildcardNode('w1')];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  assert.ok(!known.has('gpt-4.1'), 'gpt-4.1 is NOT in the known catalog');
  const authz = authorizeModel('gpt-4.1', known, allowAll);
  assert.equal(authz.allowed, false, 'gpt-4.1 must be rejected');
  assert.equal(authz.status, 404);
  assert.equal(servesModel(wildcardNode('w1'), 'gpt-4.1', known), false,
    'wildcard node does NOT serve gpt-4.1');
  assert.equal(supportsRequest(wildcardNode('w1'), reqFor('gpt-4.1'), known), false,
    'supportsRequest denies gpt-4.1 for wildcard node');
});

// --- Case 4: explicit node models=Code-Pro + MODELS_CONFIG=Code-Max -> known = {Code-Pro, Code-Max} ---

test('Case 4: explicit node models=Code-Pro + MODELS_CONFIG=Code-Max -> known = {Code-Pro, Code-Max}', () => {
  const nodes = [node('n1', { 'Code-Pro': 'up-pro' })];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  assert.equal(known.size, 2, 'catalog has exactly 2 models');
  assert.ok(known.has('Code-Pro'), 'Code-Pro from node mapping');
  assert.ok(known.has('Code-Max'), 'Code-Max from MODELS_CONFIG');
  // collectConfiguredModels (node-only) is a strict subset
  const configured = collectConfiguredModels(nodes);
  for (const m of configured) assert.ok(known.has(m), `configured model ${m} is in known`);
  assert.ok(!configured.has('Code-Max'), 'Code-Max is NOT in node-only configured set');
});

// --- Case 5: visible == callable ---

test('Case 5a: allowAll key -> visible == callable for all known models', () => {
  const nodes = [node('n1', { 'Code-Pro': 'up-pro' }), wildcardNode('w1')];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  const visible = filterVisibleModels(known, allowAll);
  // Every visible model must be callable (authz + scheduler pass)
  for (const m of visible) {
    assert.equal(authorizeModel(m, known, allowAll).allowed, true, `${m} is callable (authz)`);
    assert.equal(supportsRequest(wildcardNode('w1'), reqFor(m), known), true, `${m} is callable (scheduler via wildcard)`);
  }
  // Every known model must be visible for allowAll
  assert.deepEqual(visible, [...known].sort(), 'allowAll sees all known models');
});

test('Case 5b: no model is visible but not callable (wildcard)', () => {
  const nodes = [wildcardNode('w1')];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  const visible = filterVisibleModels(known, allowAll);
  for (const m of visible) {
    assert.equal(authorizeModel(m, known, allowAll).allowed, true, `${m} is callable`);
    assert.equal(supportsRequest(wildcardNode('w1'), reqFor(m), known), true, `${m} served by wildcard`);
  }
  // gpt-4.1 is not visible AND not callable
  assert.ok(!visible.includes('gpt-4.1'), 'gpt-4.1 is NOT visible');
  assert.equal(authorizeModel('gpt-4.1', known, allowAll).allowed, false, 'gpt-4.1 NOT callable');
  assert.equal(supportsRequest(wildcardNode('w1'), reqFor('gpt-4.1'), known), false, 'gpt-4.1 NOT served by wildcard');
});

test('Case 5c: allowlist key -> visible == callable', () => {
  const nodes = [node('n1', { 'Code-Pro': 'up-pro', 'Air': 'up-air' }), wildcardNode('w1')];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  const key = allowlist(['Code-Pro', 'Code-Max']);
  const visible = filterVisibleModels(known, key);
  assert.deepEqual(visible, ['Code-Max', 'Code-Pro']);
  for (const m of visible) {
    assert.equal(authorizeModel(m, known, key).allowed, true, `${m} callable with this key`);
  }
  // Air is known but not in the allowlist -> not visible, not callable with this key
  assert.ok(!visible.includes('Air'));
  assert.equal(authorizeModel('Air', known, key).allowed, false, 'Air not callable without allowlist entry');
});

// --- Empty catalog behavior (2.4) ---

test('empty catalog: wildcard node + no MODELS_CONFIG + no node mappings -> serves 0 models', () => {
  const nodes = [wildcardNode('w1')];
  const env = {};
  const known = collectKnownModels(nodes, env);
  assert.equal(known.size, 0);
  // Nothing is allowed, not even with allowAll
  assert.equal(authorizeModel('anything', known, allowAll).allowed, false);
  // wildcard serves nothing
  assert.equal(servesModel(wildcardNode('w1'), 'anything', known), false);
  assert.equal(supportsRequest(wildcardNode('w1'), reqFor('anything'), known), false);
  // Visible list is empty
  assert.deepEqual(filterVisibleModels(known, allowAll), []);
});

// --- "*" means all Known Models, never any string ---

test('"*" allowAll grants all known models, never arbitrary strings', () => {
  const nodes = [node('n1', { 'Air': 'up-air' })];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  // all known models are callable with allowAll
  for (const m of known) {
    assert.equal(authorizeModel(m, known, allowAll).allowed, true, `${m} allowed with "*"`);
  }
  // arbitrary string is NOT callable
  assert.equal(authorizeModel('arbitrary-model', known, allowAll).allowed, false);
  assert.equal(authorizeModel('gpt-4o', known, allowAll).allowed, false);
});

// --- collectKnownModels is the single source ---

test('collectKnownModels is deterministic and includes both sources', () => {
  const nodes = [
    node('n1', { 'Air': 'up-air', 'Pro': 'up-pro' }),
    wildcardNode('w2'),
  ];
  const env = { MODELS_CONFIG: JSON.stringify({
    'Code-Max': { policy: 'default' },
    'Omni': { policy: 'default' },
  }) };
  const known = collectKnownModels(nodes, env);
  assert.ok(known.has('Air'));
  assert.ok(known.has('Pro'));
  assert.ok(known.has('Code-Max'));
  assert.ok(known.has('Omni'));
  assert.equal(known.size, 4);
});

// --- isWildcardNode + servesModel semantics ---

test('servesModel: mapped node serves only its declared models', () => {
  const n = node('n1', { 'Air': 'up-air' });
  const known = collectKnownModels([n], {});
  assert.equal(servesModel(n, 'Air', known), true);
  assert.equal(servesModel(n, 'Pro', known), false, 'mapped node does not serve undeclared model');
});

test('servesModel: wildcard without catalog stays permissive (legacy compat for standalone tests)', () => {
  const n = wildcardNode('w1');
  // No knownModels arg -> permissive (backward compat)
  assert.equal(servesModel(n, 'anything'), true);
  // With knownModels arg -> closed
  assert.equal(servesModel(n, 'anything', new Set()), false);
  assert.equal(servesModel(n, 'Air', new Set(['Air'])), true);
});

console.log(`\nclosed-catalog tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some closed-catalog tests FAILED.');
} else {
  console.log('All closed-catalog tests passed.');
}
