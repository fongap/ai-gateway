import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { __resetAllNodeStateForTests } from '../src/config/node-state.js';

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

const setupPage = await worker.fetch(new Request('https://gateway.example/', { headers: { Accept: 'text/html' } }), {}, ctx);
assert.equal(setupPage.status, 200);
assert.equal(setupPage.headers.get('cache-control'), 'no-store');
assert.match(await setupPage.text(), /等待完成配置/);

const version = await worker.fetch(
  new Request('https://gateway.example/version'),
  {},
  ctx,
);
assert.equal(version.status, 200);
const versionJson = await version.json();
assert.equal(versionJson.name, 'AI Agent Node Scheduler');
assert.equal(versionJson.version, '5.14.0');

// 未配置 NODES_CONFIG 时，即使有 GATEWAY_ACCESS_KEY 也处于待配置状态
const env = {
  GATEWAY_ACCESS_KEY: 'test-gateway-key',
  LOG_LEVEL: 'none',
};

const dashboardPending = await worker.fetch(
  new Request('https://gateway.example/', { headers: { Accept: 'text/html' } }),
  env,
  ctx,
);
assert.equal(dashboardPending.status, 200);
assert.match(await dashboardPending.text(), /等待完成配置/);

const unauthorized = await worker.fetch(
  new Request('https://gateway.example/health'),
  env,
  ctx,
);
assert.equal(unauthorized.status, 401);

// 完整 Node 配置环境
function makeNodeEnv(overrides = {}) {
  return {
    GATEWAY_ACCESS_KEY: 'test-gateway-key',
    NODES_CONFIG: JSON.stringify([
      {
        id: 'tier-1-node-01', tier: 'tier-1', priority: 100,
        provider: 'provider-a', secret_ref: 'FREE_NODE_01',
        workloads: ['general', 'coding'], models: { 'general-air': 'free-model-air', 'general-pro': 'free-model-pro' },
        limits: { concurrency: 2 },
      },
      {
        id: 'tier-2-node-01', tier: 'tier-2', priority: 80,
        provider: 'provider-b', secret_ref: 'PAID_NODE_01',
        workloads: ['general', 'coding'], models: { 'general-air': 'paid-model-air', 'general-pro': 'paid-model-pro' },
        limits: { concurrency: 5 },
      },
    ]),
    FREE_NODE_01: 'free-token@https://free-node.example/v1',
    PAID_NODE_01: 'paid-token@https://paid-node.example/v1',
    MODELS_CONFIG: JSON.stringify({
      'general-air': { workload: 'general', policy: 'general-fast' },
      'general-pro': { workload: 'general', policy: 'general-fast' },
    }),
    POLICIES_CONFIG: JSON.stringify({
      'general-fast': { tiers: ['tier-1', 'tier-2'], max_attempts: 3, retry_budget: { free: 2, paid: 1, plus: 1 } },
    }),
    ...overrides,
  };
}

const dashboard = await worker.fetch(
  new Request('https://gateway.example/', { headers: { Accept: 'text/html' } }),
  makeNodeEnv(),
  ctx,
);
assert.equal(dashboard.status, 200);
assert.equal(dashboard.headers.get('cache-control'), 'no-store');
const dashboardHtml = await dashboard.text();
assert.match(dashboardHtml, /Node Scheduler/);
assert.match(dashboardHtml, /配置范例/);
assert.doesNotMatch(dashboardHtml, /等待完成配置/);

const health = await worker.fetch(
  new Request('https://gateway.example/health', {
    headers: { Authorization: 'Bearer test-gateway-key' },
  }),
  makeNodeEnv(),
  ctx,
);
assert.equal(health.status, 200);
const healthJson = await health.json();
assert.equal(healthJson.status, 'ok');
assert.equal(healthJson.nodes_total, 2);
assert.equal(healthJson.tiers['tier-1'], 1);
assert.equal(healthJson.tiers['tier-2'], 1);

const metrics = await worker.fetch(
  new Request('https://gateway.example/metrics', {
    headers: { 'x-api-key': 'test-gateway-key' },
  }),
  makeNodeEnv(),
  ctx,
);
assert.equal(metrics.status, 200);
assert.match(await metrics.text(), /edge_gateway_node_health_score/);

// ===== 模型列表：只返回 NODES_CONFIG 中声明的逻辑模型 =====
const models = await worker.fetch(
  new Request('https://gateway.example/v1/models', {
    headers: { Authorization: 'Bearer test-gateway-key' },
  }),
  makeNodeEnv(),
  ctx,
);
assert.equal(models.status, 200);
const modelsJson = await models.json();
assert.deepEqual(modelsJson.data.map(item => item.id), ['general-air', 'general-pro']);

const originalFetch = globalThis.fetch;

__resetAllNodeStateForTests();

// ===== free-node 优先调度 + 上游模型映射 =====
let captured = {};
globalThis.fetch = async (url, init) => {
  captured.url = String(url);
  captured.auth = new Headers(init.headers).get('authorization');
  captured.body = JSON.parse(String(init.body || '{}'));
  return new Response(JSON.stringify({
    id: 'chatcmpl-01', object: 'chat.completion', model: captured.body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok-from-' + new URL(captured.url).hostname }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const chatResponse = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'general-air', messages: [{ role: 'user', content: 'hi' }] }),
  }),
  makeNodeEnv(),
  ctx,
);
assert.equal(chatResponse.status, 200);
assert.match(captured.url, /free-node\.example/); // free 节点优先
assert.equal(captured.auth, 'Bearer free-token'); // secret_ref 凭据注入
assert.equal(captured.body.model, 'free-model-air'); // 逻辑模型 → 上游模型映射
const chatJson = await chatResponse.json();
assert.equal(chatJson.model, 'general-air'); // 响应中保留客户端请求的逻辑模型名

// ===== 429 自动切换：free 冷却后切到 paid =====
let callHosts = [];
globalThis.fetch = async (url) => {
  const host = new URL(String(url)).hostname;
  callHosts.push(host);
  if (host === 'free-node.example') {
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }
  return new Response(JSON.stringify({
    id: 'chatcmpl-fb', object: 'chat.completion', model: 'paid-model-air',
    choices: [{ index: 0, message: { role: 'assistant', content: 'from-paid' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const failoverEnv = makeNodeEnv();
callHosts = [];
const failoverResponse = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'general-air', messages: [{ role: 'user', content: 'hi' }] }),
  }),
  failoverEnv,
  ctx,
);
assert.equal(failoverResponse.status, 200);
assert.deepEqual(callHosts, ['free-node.example', 'paid-node.example']);
// 第二次请求：free 已冷却，直接使用 paid
callHosts = [];
await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'general-air', messages: [{ role: 'user', content: 'hi' }] }),
  }),
  failoverEnv,
  ctx,
);
assert.deepEqual(callHosts, ['paid-node.example']);

// ===== 全部节点不可用时返回 429 =====
const exhaustedEnv = makeNodeEnv({ RATE_LIMIT_COOLDOWN_MS: '60000' });
// 让两个节点都进入冷却
for (let i = 0; i < 6; i++) {
  globalThis.fetch = async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
  try { await worker.fetch(
    new Request('https://gateway.example/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'general-pro', messages: [] }),
    }), exhaustedEnv, ctx);
  } catch {}
}
globalThis.fetch = async () => new Response('{}', { status: 500 });
const allExhausted = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'general-pro', messages: [] }),
  }),
  exhaustedEnv,
  ctx,
);
assert.equal(allExhausted.status, 429); // 全部节点冷却/熔断中

// ===== 不泄露 Secret 与上游 hostname =====
const hiddenFailure = allExhausted;
const hiddenText = await hiddenFailure.text();
assert.doesNotMatch(hiddenText, /free-token|paid-token/);
assert.doesNotMatch(hiddenText, /free-node\.example|paid-node\.example/);

__resetAllNodeStateForTests();

// ===== 流式响应透传（OpenAI）=====
globalThis.fetch = async () => new Response(
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const streamRequest = new Request('https://gateway.example/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'general-air', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});
const streamResponse = await worker.fetch(streamRequest, makeNodeEnv(), ctx);
assert.equal(streamResponse.status, 200);
const streamBody = await streamResponse.text();
assert.match(streamBody, /hello/);

__resetAllNodeStateForTests();

// ===== Anthropic 协议桥接 =====
let anthropicCaptured = {};
globalThis.fetch = async (url, init) => {
  anthropicCaptured.body = JSON.parse(String(init.body || '{}'));
  return new Response(JSON.stringify({
    id: 'chatcmpl-anthropic', object: 'chat.completion', model: anthropicCaptured.body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'anthropic-ok' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const anthropicResponse = await worker.fetch(
  new Request('https://gateway.example/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'general-air', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
  }),
  makeNodeEnv(),
  ctx,
);
assert.equal(anthropicResponse.status, 200);
assert.equal(anthropicCaptured.body.stream, false); // 默认不改写流式
const anthropicJson = await anthropicResponse.json();
assert.equal(anthropicJson.type, 'message');
assert.equal(anthropicJson.content[0].text, 'anthropic-ok');

__resetAllNodeStateForTests();

// ===== First Event Guard：空流触发 failover 到下一节点 =====
let guardCalls = [];
globalThis.fetch = async (url) => {
  const host = new URL(String(url)).hostname;
  guardCalls.push(host);
  if (host === 'free-node.example') {
    // 空流：立即关闭，无任何事件
    return new Response(new ReadableStream({ start(c) { c.close(); } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"paid-stream"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};
guardCalls = [];
const guardRequest = new Request('https://gateway.example/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'general-air', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});
const guardResponse = await worker.fetch(guardRequest, makeNodeEnv(), ctx);
assert.equal(guardResponse.status, 200);
assert.deepEqual(guardCalls, ['free-node.example', 'paid-node.example']); // 空流后 failover
const guardBody = await guardResponse.text();
assert.match(guardBody, /paid-stream/);
assert.doesNotMatch(guardBody, /free-model/);

// ===== 未知路径默认拒绝 =====
let unexpectedProxyCalls = 0;
globalThis.fetch = async () => { unexpectedProxyCalls++; return new Response('{}'); };
const blockedRoute = await worker.fetch(
  new Request('https://gateway.example/v1/files/file-123', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-gateway-key' },
  }),
  makeNodeEnv(),
  ctx,
);
assert.equal(blockedRoute.status, 404);
assert.equal(unexpectedProxyCalls, 0);

// ===== HTTP 上游默认拒绝 =====
__resetAllNodeStateForTests();
const insecure = await worker.fetch(
  new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  }),
  makeNodeEnv({
    NODES_CONFIG: JSON.stringify([{ id: 'tier-1-node-01', tier: 'tier-1', secret_ref: 'FREE_NODE_01' }]),
    FREE_NODE_01: 'tok@http://insecure.example/v1',
  }),
  ctx,
);
assert.equal(insecure.status, 500);

globalThis.fetch = originalFetch;
console.log('Smoke tests passed.');