#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// GATEWAY_ACCESS_KEY_<GROUP> unit tests: five independent groups (AIR/PRO/MAX/ULTRA/AGENT),
// fail-closed CSV allowlists, legacy GATEWAY_ACCESS_KEY fallback, and no secret leakage.

import assert from 'node:assert/strict';
import { loadAccessKeysConfig, keyAllowsModel, __resetAccessKeysCacheForTests } from '../src/config/access-keys.js';
import { authorize } from '../src/request/auth.js';

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
async function testAsync(name, fn) {
  try {
    __resetAccessKeysCacheForTests();
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const ENV_MODELS = { MODELS_CONFIG: JSON.stringify({ 'code-pro': { policy: 'fast' }, 'general-air': { policy: 'fast' } }) };
const mkReq = (key) => new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: '{}',
});

// --- 1. Legacy fallback: no GATEWAY_ACCESS_KEY_<GROUP>, uses GATEWAY_ACCESS_KEY ---
await testAsync('legacy fallback: no GATEWAY_ACCESS_KEY_<GROUP> -> GATEWAY_ACCESS_KEY grants all', async () => {
  const env = { ...ENV_MODELS, GATEWAY_ACCESS_KEY: 'legacy-secret' };
  const result = await authorize(mkReq('legacy-secret'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.mode, 'legacy');
  assert.equal(result.allowAll, true);
  assert.equal(result.group, 'LEGACY');
});

// --- 2. Grouped key: explicit CSV allowlist ---
await testAsync('grouped key: allowlist permits listed model, denies others', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_PRO: 'prod-secret',
    GATEWAY_ACCESS_MODELS_PRO: 'code-pro',
  };
  const ok = await authorize(mkReq('prod-secret'), env);
  assert.equal(ok.authorized, true);
  assert.equal(ok.mode, 'grouped');
  assert.equal(ok.group, 'PRO');
  assert.equal(ok.allowAll, false);
  assert.ok(ok.allowlist.has('code-pro'));
  assert.ok(!ok.allowlist.has('general-air'));
});

// --- 3. Fail closed: missing models field -> empty allowlist ---
await testAsync('fail closed: missing GATEWAY_ACCESS_MODELS_<GROUP> -> denies everything', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'air-secret',
    // no GATEWAY_ACCESS_MODELS_AIR -> empty allowlist
  };
  const result = await authorize(mkReq('air-secret'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.group, 'AIR');
  assert.equal(result.allowAll, false);
  assert.equal(result.allowlist.size, 0);
  assert.equal(keyAllowsModel({ allowAll: false, allowlist: result.allowlist }, 'code-pro'), false);
});

// --- 4. Wildcard: GATEWAY_ACCESS_MODELS_<GROUP>="*" ---
await testAsync('wildcard: GATEWAY_ACCESS_MODELS_<GROUP>="*" permits all', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_MAX: 'max-secret',
    GATEWAY_ACCESS_MODELS_MAX: '*',
  };
  const result = await authorize(mkReq('max-secret'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.allowAll, true);
  assert.equal(result.allowlist, undefined);
});

// --- 5. Wrong key: not authorized ---
await testAsync('wrong credential -> not authorized', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_ULTRA: 'ultra-secret',
    GATEWAY_ACCESS_MODELS_ULTRA: '*',
  };
  const result = await authorize(mkReq('wrong'), env);
  assert.equal(result.authorized, false);
  assert.equal(result.mode, 'grouped'); // grouped mode but key not matched
});

// --- 6. Rotation: multiple groups coexist independently ---
await testAsync('rotation: multiple groups coexist and each resolves independently', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AGENT: 'agent-secret',
    GATEWAY_ACCESS_MODELS_AGENT: '*',
    GATEWAY_ACCESS_KEY_PRO: 'prod-secret',
    GATEWAY_ACCESS_MODELS_PRO: 'code-pro',
  };
  const agent = await authorize(mkReq('agent-secret'), env);
  const prod = await authorize(mkReq('prod-secret'), env);
  assert.equal(agent.group, 'AGENT');
  assert.equal(prod.group, 'PRO');
  assert.equal(agent.allowAll, true);
  assert.equal(prod.allowAll, false);
});

// --- 7. No secret leakage: only group in result ---
await testAsync('no secret leakage: auth result carries no raw secret or prefix', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'air-secret',
    GATEWAY_ACCESS_MODELS_AIR: '*',
  };
  const result = await authorize(mkReq('air-secret'), env);
  const serialized = JSON.stringify(result);
  assert.ok(!/air-secret/.test(serialized), 'raw secret must not appear');
  assert.ok(!/bearer/i.test(serialized), 'Authorization scheme must not appear');
});

// --- 8. Diagnostics: unknown model in allowlist ---
test('diagnostics: allowlist referencing unknown model emits warning', () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_PRO: 'prod-secret',
    GATEWAY_ACCESS_MODELS_PRO: 'ghost',
  };
  const { diagnostics } = loadAccessKeysConfig(env);
  assert.ok(diagnostics.some((d) => d.includes('ghost') && d.includes('not currently configured')), `unexpected diagnostics: ${diagnostics}`);
});

// --- 9. Legacy disabled when any new group configured ---
await testAsync('legacy disabled: GATEWAY_ACCESS_KEY ignored when any GATEWAY_ACCESS_KEY_<GROUP> set', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY: 'legacy-secret', // should be ignored
    GATEWAY_ACCESS_KEY_PRO: 'prod-secret',
    GATEWAY_ACCESS_MODELS_PRO: 'code-pro',
  };
  // Legacy key should NOT work
  const legacyResult = await authorize(mkReq('legacy-secret'), env);
  assert.equal(legacyResult.authorized, false);
  // New group key should work
  const prodResult = await authorize(mkReq('prod-secret'), env);
  assert.equal(prodResult.authorized, true);
  assert.equal(prodResult.group, 'PRO');
});

// --- 10. x-api-key header works ---
await testAsync('x-api-key header is also accepted', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'air-secret',
    GATEWAY_ACCESS_MODELS_AIR: '*',
  };
  const req = new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'air-secret' },
    body: '{}',
  });
  const result = await authorize(req, env);
  assert.equal(result.authorized, true);
  assert.equal(result.group, 'AIR');
});

// --- 11. All five groups independent ---
await testAsync('all five groups independent: each has own secret and allowlist', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'air-secret',
    GATEWAY_ACCESS_MODELS_AIR: 'general-air',
    GATEWAY_ACCESS_KEY_PRO: 'pro-secret',
    GATEWAY_ACCESS_MODELS_PRO: 'code-pro',
    GATEWAY_ACCESS_KEY_MAX: 'max-secret',
    GATEWAY_ACCESS_MODELS_MAX: 'general-air,code-pro',
    GATEWAY_ACCESS_KEY_ULTRA: 'ultra-secret',
    GATEWAY_ACCESS_MODELS_ULTRA: '*',
    GATEWAY_ACCESS_KEY_AGENT: 'agent-secret',
    GATEWAY_ACCESS_MODELS_AGENT: 'code-pro',
  };
  const air = await authorize(mkReq('air-secret'), env);
  const pro = await authorize(mkReq('pro-secret'), env);
  const max = await authorize(mkReq('max-secret'), env);
  const ultra = await authorize(mkReq('ultra-secret'), env);
  const agent = await authorize(mkReq('agent-secret'), env);
  assert.equal(air.group, 'AIR');
  assert.equal(pro.group, 'PRO');
  assert.equal(max.group, 'MAX');
  assert.equal(ultra.group, 'ULTRA');
  assert.equal(agent.group, 'AGENT');
  assert.ok(air.allowlist.has('general-air'));
  assert.ok(!air.allowlist.has('code-pro'));
  assert.ok(pro.allowlist.has('code-pro'));
  assert.ok(max.allowlist.has('general-air') && max.allowlist.has('code-pro'));
  assert.equal(ultra.allowAll, true);
  assert.ok(agent.allowlist.has('code-pro'));
});

// --- 12. Empty CSV string -> fail closed ---
await testAsync('fail closed: empty GATEWAY_ACCESS_MODELS_<GROUP> -> empty allowlist', async () => {
  const env = {
    ...ENV_MODELS,
    GATEWAY_ACCESS_KEY_AIR: 'air-secret',
    GATEWAY_ACCESS_MODELS_AIR: '',
  };
  const result = await authorize(mkReq('air-secret'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.allowAll, false);
  assert.equal(result.allowlist.size, 0);
});

console.log(`\naccess-keys tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some tests FAILED.');
} else {
  console.log('All access-keys tests passed.');
}