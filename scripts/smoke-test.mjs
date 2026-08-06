import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

const dashboard = await worker.fetch(new Request('https://gateway.example/', { headers: { Accept: 'text/html' } }), {}, ctx);
assert.equal(dashboard.status, 200);
assert.match(await dashboard.text(), /智能边缘网关/);

const env = {
  GATEWAY_ACCESS_KEY: 'test-gateway-key',
  PRIMARY_API_TOKENS: 'test-token@https://upstream.example/v1',
  LOG_LEVEL: 'none',
};

const unauthorized = await worker.fetch(
  new Request('https://gateway.example/health'),
  env,
  ctx,
);
assert.equal(unauthorized.status, 401);

const health = await worker.fetch(
  new Request('https://gateway.example/health', {
    headers: { Authorization: 'Bearer test-gateway-key' },
  }),
  env,
  ctx,
);
assert.equal(health.status, 200);
const healthJson = await health.json();
assert.ok(healthJson);

const metrics = await worker.fetch(
  new Request('https://gateway.example/metrics', {
    headers: { 'x-api-key': 'test-gateway-key' },
  }),
  env,
  ctx,
);
assert.equal(metrics.status, 200);
assert.match(await metrics.text(), /gateway_/);

console.log('Smoke tests passed.');
