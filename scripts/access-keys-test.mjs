#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// ACCESS_KEYS_CONFIG unit tests: fail-closed allowlists, key_id resolution,
// rotation, and backward-compatible legacy fallback. Verifies that no secret
// ever appears in logs or error responses.

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

// --- 1. Legacy fallback: no ACCESS_KEYS_CONFIG, uses GATEWAY_ACCESS_KEY ---

await testAsync('legacy fallback: no ACCESS_KEYS_CONFIG -> GATEWAY_ACCESS_KEY grants all', async () => {
  const env = { ...ENV_MODELS, GATEWAY_ACCESS_KEY: 'legacy-secret' };
  const result = await authorize(mkReq('legacy-secret'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.mode, 'legacy');
  assert.equal(result.allowAll, true);
  assert.equal(result.keyId, undefined);
});

// --- 2. Multi-key: explicit allowlist ---

await testAsync('multi-key: allowlist permits listed model, denies others', async () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ key_id: 'prod', secret: 's1', models: ['code-pro'] }] }),
  };
  const ok = await authorize(mkReq('s1'), env);
  assert.equal(ok.authorized, true);
  assert.equal(ok.keyId, 'prod');
  assert.equal(ok.allowAll, false);
  assert.ok(ok.allowlist.has('code-pro'));
  assert.ok(!ok.allowlist.has('general-air'));
});

// --- 3. Fail closed: missing models -> empty allowlist ---

await testAsync('fail closed: missing models field -> denies everything', async () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ key_id: 'blank', secret: 's2' }] }),
  };
  const result = await authorize(mkReq('s2'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.keyId, 'blank');
  assert.equal(result.allowAll, false);
  assert.equal(result.allowlist.size, 0);
  assert.equal(keyAllowsModel({ allowAll: false, allowlist: result.allowlist }, 'code-pro'), false);
});

// --- 4. Wildcard: models: ["*"] ---

await testAsync('wildcard: models ["*"] permits all', async () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ key_id: 'admin', secret: 's3', models: ['*'] }] }),
  };
  const result = await authorize(mkReq('s3'), env);
  assert.equal(result.authorized, true);
  assert.equal(result.allowAll, true);
  assert.equal(result.allowlist, undefined);
});

// --- 5. Wrong key: not authorized ---

await testAsync('wrong credential -> not authorized', async () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ key_id: 'prod', secret: 's1', models: ['*'] }] }),
  };
  const result = await authorize(mkReq('wrong'), env);
  assert.equal(result.authorized, false);
  assert.equal(result.mode, 'multi');
});

// --- 6. Rotation: two keys coexist ---

await testAsync('rotation: multiple keys coexist and each resolves independently', async () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({
      keys: [
        { key_id: 'old', secret: 'old-secret', models: ['*'] },
        { key_id: 'new', secret: 'new-secret', models: ['code-pro'] },
      ],
    }),
  };
  const old = await authorize(mkReq('old-secret'), env);
  const neu = await authorize(mkReq('new-secret'), env);
  assert.equal(old.keyId, 'old');
  assert.equal(neu.keyId, 'new');
  assert.equal(old.allowAll, true);
  assert.equal(neu.allowAll, false);
});

// --- 7. No secret leakage: key_id only ---

await testAsync('no secret leakage: auth result carries no raw secret or prefix', async () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ key_id: 'prod', secret: 's1', models: ['*'] }] }),
  };
  const result = await authorize(mkReq('s1'), env);
  const serialized = JSON.stringify(result);
  assert.ok(!/s1/.test(serialized), 'raw secret must not appear');
  assert.ok(!/bearer/i.test(serialized), 'Authorization scheme must not appear');
});

// --- 8. Diagnostics: unknown model in allowlist ---

test('diagnostics: allowlist referencing unknown model emits warning', () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ key_id: 'k', secret: 's', models: ['ghost'] }] }),
  };
  const { diagnostics } = loadAccessKeysConfig(env);
  assert.ok(diagnostics.some((d) => d.includes('ghost') && d.includes('Model Registry')), `unexpected diagnostics: ${diagnostics}`);
});

// --- 9. Diagnostics: missing key_id ---

test('diagnostics: missing key_id is flagged', () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ secret: 's', models: ['*'] }] }),
  };
  const { diagnostics } = loadAccessKeysConfig(env);
  assert.ok(diagnostics.some((d) => d.includes('key_id')), `unexpected diagnostics: ${diagnostics}`);
});

// --- 10. x-api-key channel works ---

await testAsync('x-api-key header is also accepted', async () => {
  const env = {
    ...ENV_MODELS,
    ACCESS_KEYS_CONFIG: JSON.stringify({ keys: [{ key_id: 'prod', secret: 's1', models: ['*'] }] }),
  };
  const req = new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 's1' },
    body: '{}',
  });
  const result = await authorize(req, env);
  assert.equal(result.authorized, true);
  assert.equal(result.keyId, 'prod');
});

console.log(`\naccess-keys tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some tests FAILED.');
} else {
  console.log('All access-keys tests passed.');
}
