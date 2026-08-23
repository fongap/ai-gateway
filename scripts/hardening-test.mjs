import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { __resetAllNodeStateForTests } from '../src/config/node-state.js';

const ctx = { waitUntil() {}, passThroughOnException() {} };
const originalFetch = globalThis.fetch;
const key = 'hardening-gateway-key';
const baseEnv = {
  GATEWAY_ACCESS_KEY: key,
  NODES_CONFIG: JSON.stringify([
    { id: 'free-node-01', tier: 'free', priority: 100, secret_ref: 'NODE_KEY', models: { 'm': 'upstream-m' } },
    { id: 'paid-node-01', tier: 'paid', priority: 80, secret_ref: 'NODE_KEY2', models: { 'm': 'upstream-m2' } },
  ]),
  NODE_KEY: 'hardening-token@https://primary.example/v1',
  NODE_KEY2: 'hardening-token2@https://second.example/v1',
  LOG_LEVEL: 'none',
};
const auth = { Authorization: `Bearer ${key}` };
const chat = (body, extra = {}) => new Request('https://gateway.example/v1/chat/completions', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json', ...(extra.headers || {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
});
const anthropic = (body, extra = {}) => new Request('https://gateway.example/v1/messages', {
  method: 'POST',
  headers: {
    ...auth,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(extra.headers || {}),
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
});

try {
  // 诊断接口必须支持 CORS，且不反射未知请求头。
  const health = await worker.fetch(new Request('https://gateway.example/health', {
    headers: { ...auth, Origin: 'https://app.example' },
  }), { ...baseEnv, ALLOWED_ORIGIN: 'https://app.example' }, ctx);
  assert.equal(health.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.match(health.headers.get('vary') || '', /Origin/);

  const eitherHeaderAuth = await worker.fetch(new Request('https://gateway.example/health', {
    headers: { Authorization: 'Bearer wrong-key', 'x-api-key': key },
  }), baseEnv, ctx);
  assert.equal(eitherHeaderAuth.status, 200);

  const preflight = await worker.fetch(new Request('https://gateway.example/v1/chat/completions', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example',
      'Access-Control-Request-Headers': 'Authorization, X-Evil-Header, Idempotency-Key',
    },
  }), { ...baseEnv, ALLOWED_ORIGIN: 'https://app.example' }, ctx);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /Authorization/i);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /Idempotency-Key/i);
  assert.doesNotMatch(preflight.headers.get('access-control-allow-headers') || '', /X-Evil-Header/i);

  const invalidOrigin = await worker.fetch(new Request('https://gateway.example/health', {
    headers: { ...auth, Origin: 'https://app.example' },
  }), { ...baseEnv, ALLOWED_ORIGIN: 'javascript:alert(1)' }, ctx);
  assert.equal(invalidOrigin.status, 200);
  assert.equal(invalidOrigin.headers.get('access-control-allow-origin'), 'null');

  const dashboard = await worker.fetch(new Request('https://gateway.example/', {
    headers: { Accept: 'text/html' },
  }), baseEnv, ctx);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(dashboard.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');

  // 已声明路由的大小写和尾斜杠必须落到网关自身处理器，不得意外透传上游。
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  const versionSlash = await worker.fetch(new Request('https://gateway.example/VERSION/'), baseEnv, ctx);
  assert.equal(versionSlash.status, 200);
  assert.equal(versionSlash.headers.get('cache-control'), 'no-store');
  const healthSlash = await worker.fetch(new Request('https://gateway.example/HEALTH/', { headers: auth }), baseEnv, ctx);
  assert.equal(healthSlash.status, 200);
  assert.equal(calls, 0);

  const blockedPreflight = await worker.fetch(new Request('https://gateway.example/v1/files', {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Method': 'DELETE' },
  }), baseEnv, ctx);
  assert.equal(blockedPreflight.status, 404);

  // 压缩请求明确拒绝，避免把压缩字节当作明文 JSON 转发。
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  const compressed = await worker.fetch(new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: 'not-really-gzip',
  }), baseEnv, ctx);
  assert.equal(compressed.status, 415);
  assert.equal(calls, 0);

  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'identity', object: 'chat.completion', model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const identityEncoding = await worker.fetch(new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'content-encoding': 'identity' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  }), baseEnv, ctx);
  assert.equal(identityEncoding.status, 200);

  // 无效 JSON 与超限流式请求体在访问上游前失败。
  const invalid = await worker.fetch(chat('{"model":'), baseEnv, ctx);
  assert.equal(invalid.status, 400);
  const oversizedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'm', messages: [], padding: 'x'.repeat(4000) })));
      controller.close();
    },
  });
  const oversized = await worker.fetch(new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: oversizedBody,
    duplex: 'half',
  }), { ...baseEnv, MAX_BODY_BYTES: '1024' }, ctx);
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);

  // 非流式缓存命中必须明确返回 HIT；流式请求不进入缓存。
  const originalCaches = globalThis.caches;
  let cacheMatchCalls = 0;
  let cacheUpstreamCalls = 0;
  globalThis.caches = {
    default: {
      async match() {
        cacheMatchCalls++;
        return new Response(JSON.stringify({
          id: 'cached', object: 'chat.completion', model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'cached' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'content-type': 'application/json', 'x-edge-gateway-cache': 'CACHED' } });
      },
      async put() {},
    },
  };
  globalThis.fetch = async () => { cacheUpstreamCalls++; throw new Error('cache hit must not fetch upstream'); };
  const cacheHit = await worker.fetch(chat({ model: 'm', messages: [], stream: false, temperature: 0 }), {
    ...baseEnv,
    CACHE_ENABLED: 'true',
  }, ctx);
  assert.equal(cacheHit.status, 200);
  assert.equal(cacheHit.headers.get('x-edge-gateway-cache'), 'HIT');
  assert.equal(cacheMatchCalls, 1);
  assert.equal(cacheUpstreamCalls, 0);

  cacheMatchCalls = 0;
  globalThis.fetch = async () => new Response('data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  const uncachedStream = await worker.fetch(chat({ model: 'm', messages: [], stream: true }), {
    ...baseEnv,
    CACHE_ENABLED: 'true',
  }, ctx);
  await uncachedStream.text();
  assert.equal(cacheMatchCalls, 0);
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;

  // Anthropic count_tokens 必须校验配置值及基础请求结构。
  const invalidCountMode = await worker.fetch(new Request('https://gateway.example/v1/messages/count_tokens', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  }), { ...baseEnv, ANTHROPIC_COUNT_TOKENS_MODE: 'unknown' }, ctx);
  assert.equal(invalidCountMode.status, 500);

  const invalidCountBody = await worker.fetch(new Request('https://gateway.example/v1/messages/count_tokens', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  }), baseEnv, ctx);
  assert.equal(invalidCountBody.status, 400);

  // 客户端在响应头前取消时，不得继续轮询或惩罚上游健康状态。
  let abortFetchCalls = 0;
  globalThis.fetch = async (_url, init) => {
    abortFetchCalls++;
    return await new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  __resetAllNodeStateForTests();
  const clientAbortController = new AbortController();
  const abortRequest = new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
    signal: clientAbortController.signal,
  });
  const abortPromise = worker.fetch(abortRequest, baseEnv, ctx);
  clientAbortController.abort();
  const abortedResponse = await abortPromise;
  assert.equal(abortedResponse.status, 499);
  assert.equal(abortFetchCalls, 1);
  const abortHealth = await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), {
    ...baseEnv, EXPOSE_UPSTREAM_INFO: 'true',
  }, ctx);
  const abortState = await abortHealth.json();
  const touchedAbortEndpoint = abortState.endpoints.find(item => item.id === 'free-node-01');
  assert.equal(touchedAbortEndpoint?.total_failures, 0);

  // 无尾部分隔符的合法 SSE 仍应被读取；空流不得伪装成功。
  globalThis.fetch = async () => new Response(
    'data: {"id":"tail","model":"m","choices":[{"index":0,"delta":{"content":"tail-ok"},"finish_reason":"stop"}]}',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  __resetAllNodeStateForTests();
  const tail = await worker.fetch(chat({ model: 'm', messages: [], stream: false }), {
    ...baseEnv, FAKE_STREAM_PROTECTION: 'true',
  }, ctx);
  assert.equal(tail.status, 200);
  assert.equal((await tail.json()).choices[0].message.content, 'tail-ok');

  globalThis.fetch = async () => new Response('', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  const emptyStream = await worker.fetch(chat({ model: 'm', messages: [], stream: false }), {
    ...baseEnv, FAKE_STREAM_PROTECTION: 'true',
  }, ctx);
  assert.equal(emptyStream.status, 502);

  // Anthropic 流转换不得静默吞掉畸形 JSON，也不得把 role-only 空流伪装成成功。
  globalThis.fetch = async () => new Response(
    'data: {"choices":[\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  __resetAllNodeStateForTests();
  const malformedAnthropic = await worker.fetch(anthropic({
    model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }],
  }), baseEnv, ctx);
  const malformedAnthropicSse = await malformedAnthropic.text();
  assert.equal(malformedAnthropic.status, 200);
  assert.match(malformedAnthropicSse, /event: error/);
  assert.match(malformedAnthropicSse, /Upstream returned malformed streaming data/);
  assert.doesNotMatch(malformedAnthropicSse, /event: message_stop/);

  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const emptyAnthropic = await worker.fetch(anthropic({
    model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }],
  }), baseEnv, ctx);
  const emptyAnthropicSse = await emptyAnthropic.text();
  assert.match(emptyAnthropicSse, /event: error/);
  assert.match(emptyAnthropicSse, /Upstream returned an empty streaming response/);
  assert.doesNotMatch(emptyAnthropicSse, /event: message_stop/);

  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  __resetAllNodeStateForTests();
  const truncatedAnthropic = await worker.fetch(anthropic({
    model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }],
  }), baseEnv, ctx);
  const truncatedAnthropicSse = await truncatedAnthropic.text();
  assert.match(truncatedAnthropicSse, /event: error/);
  assert.match(truncatedAnthropicSse, /ended before a completion marker/);
  assert.doesNotMatch(truncatedAnthropicSse, /event: message_stop/);

  // 兼容缺少 SSE 双换行、但每行都是完整 data 事件的 OpenAI 兼容上游。
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"line-one"},"finish_reason":null}]}\n' +
    'data: {"choices":[{"index":0,"delta":{"content":"line-two"},"finish_reason":"stop"}]}\n' +
    'data: [DONE]\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  __resetAllNodeStateForTests();
  const looseAnthropic = await worker.fetch(anthropic({
    model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }],
  }), baseEnv, ctx);
  const looseAnthropicSse = await looseAnthropic.text();
  assert.match(looseAnthropicSse, /line-one/);
  assert.match(looseAnthropicSse, /line-two/);
  assert.match(looseAnthropicSse, /event: message_stop/);
  assert.doesNotMatch(looseAnthropicSse, /event: error/);

  // 客户端流统计在流真正结束后才记成功。
  let controller;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n'));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  __resetAllNodeStateForTests();
  const before = await (await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), baseEnv, ctx)).json();
  const streamResponse = await worker.fetch(chat({ model: 'm', messages: [], stream: true }), baseEnv, ctx);
  const during = await (await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), baseEnv, ctx)).json();
  assert.equal(during.client_stats.active_requests, before.client_stats.active_requests + 1);
  assert.equal(during.client_stats.successes_total, before.client_stats.successes_total);
  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  controller.close();
  await streamResponse.text();
  const after = await (await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), baseEnv, ctx)).json();
  assert.equal(after.client_stats.active_requests, before.client_stats.active_requests);
  assert.equal(after.client_stats.successes_total, before.client_stats.successes_total + 1);

  // 错误响应与模型列表默认不暴露真实上游主机名。
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  const failingChat = await worker.fetch(chat({ model: 'm', messages: [] }), baseEnv, ctx);
  assert.equal(failingChat.status, 502);
  assert.doesNotMatch(await failingChat.text(), /primary\.example|second\.example|hardening-token/);

  const privateModels = await worker.fetch(new Request('https://gateway.example/v1/models', { headers: auth }), baseEnv, ctx);
  assert.equal(privateModels.status, 200);
  assert.doesNotMatch(await privateModels.text(), /primary\.example|second\.example/);

  console.log('Hardening tests passed.');
} finally {
  globalThis.fetch = originalFetch;
}