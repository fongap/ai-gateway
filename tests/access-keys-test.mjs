#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {
  loadAccessKeysConfig, keyAllowsModel, __resetAccessKeysCacheForTests, collectKnownModels,
} from '../src/config/access-keys.ts';
import { authorize } from '../src/request/auth.ts';
import { filterVisibleModels } from '../src/request/model-authz.ts';

let passed = 0;
async function test(name, fn) {
  try {
    __resetAccessKeysCacheForTests();
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

const ENV_MODELS = {
  MODELS_CONFIG: JSON.stringify({
    'code-pro': { policy: 'fast' },
    'general-air': { policy: 'fast' },
  }),
};
const req = (key, header = 'authorization') => new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    [header]: header === 'authorization' ? `Bearer ${key}` : key,
  },
  body: '{}',
});

await test('no configured group fails closed', async () => {
  const result = await authorize(req('unused'), { ...ENV_MODELS });
  assert.equal(result.authorized, false);
  assert.equal(loadAccessKeysConfig({ ...ENV_MODELS }).keys.length, 0);
});

await test('CSV allowlist is group-scoped and fail-closed', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_PRO: 'pro-secret',
    GATEWAY_ACCESS_MODELS_PRO: 'code-pro',
  };
  const result = await authorize(req('pro-secret'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.group, 'PRO');
  assert.equal(result.allowAll, false);
  assert.ok(result.allowlist.has('code-pro'));
  assert.ok(!result.allowlist.has('general-air'));
});

await test('missing or empty group model list grants zero models', async () => {
  for (const models of [undefined, '']) {
    const env = { ...ENV_MODELS, GATEWAY_ACCESS_KEY_AIR: 'air-secret' };
    if (models !== undefined) env.GATEWAY_ACCESS_MODELS_AIR = models;
    const result = await authorize(req('air-secret'), env);
    assert.equal(result.authorized, true);
    assert.equal(result.allowAll, false);
    assert.equal(result.allowlist.size, 0);
    assert.equal(keyAllowsModel(result, 'code-pro', new Set(['code-pro'])), false);
  }
});

await test('wildcard means all known models, not arbitrary strings', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_MAX: 'max-secret',
    GATEWAY_ACCESS_MODELS_MAX: '*',
  };
  const result = await authorize(req('max-secret'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.allowAll, true);
  const known = new Set(['code-pro', 'general-air']);
  assert.equal(keyAllowsModel(result, 'code-pro', known), true);
  assert.equal(keyAllowsModel(result, 'made-up-model', known), false);
});

await test('wrong credential is rejected', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_ULTRA: 'ultra-secret',
    GATEWAY_ACCESS_MODELS_ULTRA: '*',
  };
  assert.equal((await authorize(req('wrong'), env)).authorized, false);
});

await test('all five groups resolve independently', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'air', GATEWAY_ACCESS_MODELS_AIR: 'general-air',
    GATEWAY_ACCESS_KEY_PRO: 'pro', GATEWAY_ACCESS_MODELS_PRO: 'code-pro',
    GATEWAY_ACCESS_KEY_MAX: 'max', GATEWAY_ACCESS_MODELS_MAX: 'general-air,code-pro',
    GATEWAY_ACCESS_KEY_ULTRA: 'ultra', GATEWAY_ACCESS_MODELS_ULTRA: '*',
    GATEWAY_ACCESS_KEY_AGENT: 'agent', GATEWAY_ACCESS_MODELS_AGENT: 'code-pro',
  };
  for (const [secret, group] of [['air', 'AIR'], ['pro', 'PRO'], ['max', 'MAX'], ['ultra', 'ULTRA'], ['agent', 'AGENT']]) {
    const result = await authorize(req(secret), env);
    assert.equal(result.authorized, true);
    assert.equal(result.group, group);
  }
});

await test('authorization result never leaks the raw secret', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'super-secret-value',
    GATEWAY_ACCESS_MODELS_AIR: '*',
  };
  const serialized = JSON.stringify(await authorize(req('super-secret-value'), env));
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(!/bearer/i.test(serialized));
});

await test('unknown allowlist entry emits a catalog warning but creates no model', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_PRO: 'pro',
    GATEWAY_ACCESS_MODELS_PRO: 'ghost',
  };
  const { diagnostics } = loadAccessKeysConfig(env);
  assert.ok(diagnostics.some((d) => d.includes('ghost') && d.includes('Known Model Catalog')));
});

await test('x-api-key is accepted for grouped keys', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'air',
    GATEWAY_ACCESS_MODELS_AIR: '*',
  };
  const result = await authorize(req('air', 'x-api-key'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.group, 'AIR');
});

await test('known model catalog is node mappings plus MODELS_CONFIG', async () => {
  const nodes = [{ models: { 'Code-Max': 'up' } }];
  const env = { MODELS_CONFIG: JSON.stringify({ Air: { policy: 'default' }, OCR: { policy: 'default' } }) };
  const known = collectKnownModels(nodes, env);
  assert.deepEqual([...known].sort(), ['Air', 'Code-Max', 'OCR']);
  assert.ok(!known.has('made-up-model'));
});

await test('/v1/models filter uses the same known catalog as authorization', async () => {
  const nodes = [{ models: { Air: 'a', 'Code-Max': 'c', Omni: 'o', OCR: 'r' } }];
  const known = collectKnownModels(nodes, {});
  assert.deepEqual(
    filterVisibleModels(known, { authorized: true, allowAll: true }),
    ['Air', 'Code-Max', 'OCR', 'Omni'],
  );
  assert.deepEqual(
    filterVisibleModels(known, { authorized: true, allowAll: false, allowlist: new Set(['Air', 'Omni']) }),
    ['Air', 'Omni'],
  );
});

await test('empty known catalog stays empty even for wildcard access key', async () => {
  const known = collectKnownModels([{ models: {} }], {});
  assert.equal(known.size, 0);
  assert.deepEqual(filterVisibleModels(known, { authorized: true, allowAll: true }), []);
});

if (process.exitCode) process.exit(1);
console.log(`\naccess-keys tests passed (${passed}).`);
