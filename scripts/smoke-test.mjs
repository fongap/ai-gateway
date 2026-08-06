import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

const dashboard = await worker.fetch(new Request('https://gateway.example/', { headers: { Accept: 'text/html' } }), {}, ctx);
assert.equal(dashboard.status, 200);
assert.match(await dashboard.text(), /智能边缘网关/);


const version = await worker.fetch(
  new Request('https://gateway.example/version'),
  {},
  ctx,
);
assert.equal(version.status, 200);
const versionJson = await version.json();
assert.equal(versionJson.name, 'Smart Edge Gateway');
assert.equal(versionJson.version, '5.12.0');

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

const originalFetch = globalThis.fetch;
const modelCalls = [];
globalThis.fetch = async (url) => {
  modelCalls.push(String(url));
  if (modelCalls.length === 1) {
    return new Response(JSON.stringify({ error: { message: 'models endpoint unavailable' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    object: 'list',
    data: [{ id: 'upstream-model', object: 'model', owned_by: 'provider' }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

try {
  const modelsEnv = {
    ...env,
    PRIMARY_API_TOKENS: 'token-a@https://primary-a.example/v1,token-b@https://primary-b.example/v1',
    MODEL_MAPPING: JSON.stringify({
      'primary-b.example': {
        'gateway-model': 'vendor/model-id',
      },
    }),
  };
  const models = await worker.fetch(
    new Request('https://gateway.example/v1/models', {
      headers: { Authorization: 'Bearer test-gateway-key' },
    }),
    modelsEnv,
    ctx,
  );
  assert.equal(models.status, 200);
  const modelsJson = await models.json();
  assert.equal(modelsJson.object, 'list');
  assert.deepEqual(modelsJson.data.map(item => item.id), ['gateway-model', 'upstream-model']);
  assert.equal(modelCalls.length, 2);
  assert.equal(models.headers.get('x-edge-gateway-model-source'), 'upstream+configured');

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'not supported' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
  const configuredOnly = await worker.fetch(
    new Request('https://gateway.example/models', {
      headers: { 'x-api-key': 'test-gateway-key' },
    }),
    modelsEnv,
    ctx,
  );
  assert.equal(configuredOnly.status, 200);
  const configuredOnlyJson = await configuredOnly.json();
  assert.deepEqual(configuredOnlyJson.data.map(item => item.id), ['gateway-model']);
  assert.equal(configuredOnly.headers.get('x-edge-gateway-model-source'), 'configured');

  const unauthorizedModels = await worker.fetch(
    new Request('https://gateway.example/v1/models'),
    modelsEnv,
    ctx,
  );
  assert.equal(unauthorizedModels.status, 401);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Smoke tests passed.');
