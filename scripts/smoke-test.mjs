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
assert.equal(versionJson.version, '5.14.0');

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

// 未知路径默认拒绝，不得把 DELETE/文件等管理接口转发给上游。
let unexpectedProxyCalls = 0;
globalThis.fetch = async () => { unexpectedProxyCalls++; return new Response('{}'); };
const blockedRoute = await worker.fetch(
  new Request('https://gateway.example/v1/files/file-123', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-gateway-key' },
  }),
  env,
  ctx,
);
assert.equal(blockedRoute.status, 404);
assert.equal(unexpectedProxyCalls, 0);

// Base URL 固定查询参数必须保留，客户端查询参数可覆盖同名项。
let capturedTargetUrl = '';
globalThis.fetch = async (url) => {
  capturedTargetUrl = String(url);
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', model: 'upstream-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json', server: 'hidden-upstream' } });
};
const queryEnv = {
  ...env,
  PRIMARY_API_TOKENS: 'query-token@https://query-upstream.example/v1?api-version=2026-01-01&mode=base',
};
const queryResponse = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions?mode=client&trace=1&tag=a&tag=b', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'upstream-model', messages: [{ role: 'user', content: 'hi' }] }),
  }), queryEnv, ctx,
);
assert.equal(queryResponse.status, 200);
const captured = new URL(capturedTargetUrl);
assert.equal(captured.pathname, '/v1/chat/completions');
assert.equal(captured.searchParams.get('api-version'), '2026-01-01');
assert.equal(captured.searchParams.get('mode'), 'client');
assert.equal(captured.searchParams.get('trace'), '1');
assert.deepEqual(captured.searchParams.getAll('tag'), ['a', 'b']);
assert.equal(queryResponse.headers.get('server'), null);

// Primary 默认只接受 HTTPS。
const insecure = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  }),
  { ...env, PRIMARY_API_TOKENS: 'token@http://insecure.example/v1' },
  ctx,
);
assert.equal(insecure.status, 500);

// 严格模型映射开启后，只允许配置中的网关模型名。
const strictEnv = {
  ...env,
  PRIMARY_API_TOKENS: 'strict-token@https://strict.example/v1',
  STRICT_MODEL_MAPPING: 'true',
  MODEL_MAPPING: JSON.stringify({ 'strict.example': { allowed: 'vendor/allowed' } }),
};
const strictDenied = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'not-allowed', messages: [] }),
  }), strictEnv, ctx,
);
assert.equal(strictDenied.status, 400);

// Primary 进入 429 冷却后，下一次请求应直接跳过 Primary，使用 Fallback。
const routedHosts = [];
globalThis.fetch = async (url) => {
  const host = new URL(String(url)).hostname;
  routedHosts.push(host);
  if (host === 'cool-primary.example') {
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }
  return new Response(JSON.stringify({
    id: 'chatcmpl-fallback', object: 'chat.completion', model: 'fallback-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const coolingEnv = {
  ...env,
  PRIMARY_API_TOKENS: 'cool-token@https://cool-primary.example/v1',
  FALLBACK_ENABLED: 'true',
  FALLBACK_API_TOKEN: 'fallback-token',
  FALLBACK_BASE_URL: 'https://cool-fallback.example/v1',
  FALLBACK_PRIMARY_MODEL: 'fallback-model',
};
const makeCoolingRequest = () => new Request('https://gateway.example/v1/chat/completions', {
  method: 'POST', headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'requested-model', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal((await worker.fetch(makeCoolingRequest(), coolingEnv, ctx)).status, 200);
assert.deepEqual(routedHosts, ['cool-primary.example', 'cool-fallback.example']);
routedHosts.length = 0;
assert.equal((await worker.fetch(makeCoolingRequest(), coolingEnv, ctx)).status, 200);
assert.deepEqual(routedHosts, ['cool-fallback.example']);

// 流式连接在结束前应保持 active_requests，占满硬并发上限时拒绝新请求。
let streamController;
let streamFetchCalls = 0;
globalThis.fetch = async () => {
  streamFetchCalls++;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const streamEnv = {
  ...env,
  PRIMARY_API_TOKENS: 'stream-token@https://stream.example/v1',
  PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT: '1',
};
const makeStreamRequest = () => new Request('https://gateway.example/v1/chat/completions', {
  method: 'POST', headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'stream-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});
const firstStream = await worker.fetch(makeStreamRequest(), streamEnv, ctx);
assert.equal(firstStream.status, 200);
const streamHealth = await worker.fetch(new Request('https://gateway.example/health', {
  headers: { Authorization: 'Bearer test-gateway-key' },
}), streamEnv, ctx);
const streamHealthJson = await streamHealth.json();
assert.equal(streamHealthJson.endpoints[0].active_requests, 1);
const blockedByConcurrency = await worker.fetch(makeStreamRequest(), streamEnv, ctx);
assert.equal(blockedByConcurrency.status, 429);
assert.equal(streamFetchCalls, 1);
streamController.close();
await firstStream.text();
const endedHealth = await worker.fetch(new Request('https://gateway.example/health', {
  headers: { Authorization: 'Bearer test-gateway-key' },
}), streamEnv, ctx);
assert.equal((await endedHealth.json()).endpoints[0].active_requests, 0);

globalThis.fetch = originalFetch;
console.log('Extended safety tests passed.');

// 客户端提供的 Idempotency-Key 应原样转发；非流式请求默认不得被改成 stream=true。
let forwardedIdempotencyKey = '';
let forwardedBody = null;
globalThis.fetch = async (_url, init) => {
  forwardedIdempotencyKey = new Headers(init.headers).get('idempotency-key') || '';
  forwardedBody = JSON.parse(String(init.body || '{}'));
  return new Response(JSON.stringify({
    id: 'chatcmpl-idempotency', object: 'chat.completion', model: 'model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const idempotencyResponse = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-gateway-key',
      'content-type': 'application/json',
      'Idempotency-Key': 'request-123',
    },
    body: JSON.stringify({ model: 'model', stream: false, messages: [] }),
  }),
  { ...env, PRIMARY_API_TOKENS: 'idem-token@https://idem.example/v1' },
  ctx,
);
assert.equal(idempotencyResponse.status, 200);
assert.equal(forwardedIdempotencyKey, 'request-123');
assert.equal(forwardedBody.stream, false);

// 最终失败响应在默认配置下不得暴露上游 hostname 或 Base URL。
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'upstream failure' } }), {
  status: 500,
  headers: { 'content-type': 'application/json' },
});
const hiddenUpstreamEnv = {
  ...env,
  PRIMARY_API_TOKENS: 'hidden-primary-token@https://hidden-primary.example/v1',
  PRIMARY_MAX_ATTEMPTS: '1',
  FALLBACK_ENABLED: 'true',
  FALLBACK_API_TOKEN: 'hidden-fallback-token',
  FALLBACK_BASE_URL: 'https://hidden-fallback.example/v1',
  FALLBACK_PRIMARY_MODEL: 'fallback-model',
};
const hiddenFailure = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model', messages: [] }),
  }), hiddenUpstreamEnv, ctx,
);
assert.equal(hiddenFailure.status, 502);
const hiddenFailureText = await hiddenFailure.text();
assert.doesNotMatch(hiddenFailureText, /hidden-primary\.example/);
assert.doesNotMatch(hiddenFailureText, /hidden-fallback\.example/);

// 指标保留旧名称兼容，同时提供语义准确的 TTFB 名称。
const updatedMetrics = await worker.fetch(
  new Request('https://gateway.example/metrics', {
    headers: { Authorization: 'Bearer test-gateway-key' },
  }), env, ctx,
);
const updatedMetricsText = await updatedMetrics.text();
assert.match(updatedMetricsText, /edge_gateway_endpoint_avg_ttfb_ms/);
assert.match(updatedMetricsText, /edge_gateway_endpoint_avg_latency_ms/);

globalThis.fetch = originalFetch;
console.log('Extended compatibility tests passed.');

// /health 与 /metrics 应提供独立的客户端请求、成功、失败和 Fallback 统计。
const statsHealth = await worker.fetch(
  new Request('https://gateway.example/health', {
    headers: { Authorization: 'Bearer test-gateway-key' },
  }), env, ctx,
);
assert.equal(statsHealth.status, 200);
const statsHealthJson = await statsHealth.json();
assert.ok(statsHealthJson.client_stats.requests_total > 0);
assert.equal(
  statsHealthJson.client_stats.requests_total,
  statsHealthJson.client_stats.successes_total + statsHealthJson.client_stats.failures_total,
);
assert.ok(statsHealthJson.client_stats.fallback_activations_total >= 1);
assert.ok(statsHealthJson.client_stats.fallback_successes_total >= 1);

const statsMetrics = await worker.fetch(
  new Request('https://gateway.example/metrics', {
    headers: { Authorization: 'Bearer test-gateway-key' },
  }), env, ctx,
);
const statsMetricsText = await statsMetrics.text();
assert.match(statsMetricsText, /edge_gateway_client_requests_total/);
assert.match(statsMetricsText, /edge_gateway_client_successes_total/);
assert.match(statsMetricsText, /edge_gateway_client_failures_total/);
assert.match(statsMetricsText, /edge_gateway_fallback_activations_total/);

console.log('Client statistics tests passed.');
