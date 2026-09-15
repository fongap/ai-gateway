#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Closed Model Catalog regression contracts.
import assert from 'node:assert/strict';
import { collectKnownModels, servesModel, isWildcardNode } from '../src/config/registry.ts';
import { authorizeModel, filterVisibleModels } from '../src/request/model-authz.ts';
import { supportsRequest } from '../src/scheduler/scheduler.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

const node = (id, models) => ({
  id,
  provider: 'mock',
  tier: 'tier-1',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  baseUrl: `https://${id}.example.com/v1`,
  credential: 'secret',
  priority: 10,
  models,
});
const wildcard = (id) => node(id, {});
const requestFor = (model) => ({ model, protocol: 'openai', surface: 'chat_completions' });
const allowAll = { authorized: true, allowAll: true, allowlist: new Set() };
const allowlist = (...models) => ({ authorized: true, allowAll: false, allowlist: new Set(models) });

test('wildcard + empty catalog rejects arbitrary model', () => {
  const n = wildcard('w1');
  const known = collectKnownModels([n], {});
  assert.equal(known.size, 0);
  assert.deepEqual(authorizeModel('gpt-unknown', known, allowAll), { allowed: false, status: 404 });
  assert.equal(servesModel(n, 'gpt-unknown', known), false);
  assert.equal(supportsRequest(n, requestFor('gpt-unknown'), known), false);
});

test('MODELS_CONFIG can bound an intentional wildcard node', () => {
  const n = wildcard('w1');
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
  const known = collectKnownModels([n], env);
  assert.ok(known.has('Code-Max'));
  assert.deepEqual(authorizeModel('Code-Max', known, allowAll), { allowed: true });
  assert.equal(servesModel(n, 'Code-Max', known), true);
  assert.equal(supportsRequest(n, requestFor('Code-Max'), known), true);
});

test('wildcard never expands beyond the known catalog', () => {
  const n = wildcard('w1');
  const known = collectKnownModels([n], { MODELS_CONFIG: JSON.stringify({ 'Code-Max': {} }) });
  for (const unknown of ['gpt-4.1', 'made-up-model', 'anything']) {
    assert.equal(authorizeModel(unknown, known, allowAll).allowed, false);
    assert.equal(servesModel(n, unknown, known), false);
    assert.equal(supportsRequest(n, requestFor(unknown), known), false);
  }
});

test('known catalog is the union of explicit node mappings and MODELS_CONFIG', () => {
  const nodes = [node('n1', { 'Code-Pro': 'up-pro', Air: 'up-air' })];
  const env = { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' }, Omni: {} }) };
  const known = collectKnownModels(nodes, env);
  assert.deepEqual([...known].sort(), ['Air', 'Code-Max', 'Code-Pro', 'Omni']);
});

test('mapped node serves only its declared logical models', () => {
  const n = node('n1', { Air: 'up-air' });
  const known = collectKnownModels([n], {});
  assert.equal(isWildcardNode(n), false);
  assert.equal(servesModel(n, 'Air', known), true);
  assert.equal(servesModel(n, 'Pro', known), false);
});

test('wildcard requires an explicit known catalog even when called directly', () => {
  const n = wildcard('w1');
  assert.equal(isWildcardNode(n), true);
  assert.equal(servesModel(n, 'anything'), false);
  assert.equal(servesModel(n, 'anything', new Set()), false);
  assert.equal(servesModel(n, 'Air', new Set(['Air'])), true);
});

test('allow-all visible models are exactly the known catalog', () => {
  const nodes = [node('n1', { Air: 'up-air', 'Code-Pro': 'up-pro' }), wildcard('w1')];
  const known = collectKnownModels(nodes, { MODELS_CONFIG: JSON.stringify({ 'Code-Max': {} }) });
  const visible = filterVisibleModels(known, allowAll);
  assert.deepEqual(visible, [...known].sort());
  for (const model of visible) {
    assert.equal(authorizeModel(model, known, allowAll).allowed, true);
    assert.equal(supportsRequest(wildcard('w1'), requestFor(model), known), true);
  }
});

test('per-key allowlist is intersected with the known catalog', () => {
  const known = collectKnownModels([node('n1', { Air: 'a', 'Code-Pro': 'p' })], {
    MODELS_CONFIG: JSON.stringify({ 'Code-Max': {} }),
  });
  const key = allowlist('Code-Pro', 'Code-Max');
  assert.deepEqual(filterVisibleModels(known, key), ['Code-Max', 'Code-Pro']);
  assert.equal(authorizeModel('Code-Pro', known, key).allowed, true);
  assert.equal(authorizeModel('Code-Max', known, key).allowed, true);
  assert.deepEqual(authorizeModel('Air', known, key), { allowed: false, status: 403 });
});

test('allowlisted-but-nonexistent model is still a 404', () => {
  const known = new Set(['Air']);
  const key = allowlist('ghost');
  assert.deepEqual(authorizeModel('ghost', known, key), { allowed: false, status: 404 });
  assert.deepEqual(filterVisibleModels(known, key), []);
});

test('empty catalog exposes and authorizes zero models', () => {
  const known = collectKnownModels([wildcard('w1')], {});
  assert.deepEqual(filterVisibleModels(known, allowAll), []);
  assert.deepEqual(authorizeModel('anything', known, allowAll), { allowed: false, status: 404 });
});

if (process.exitCode) process.exit(1);
console.log(`\nclosed-catalog tests passed (${passed}).`);
