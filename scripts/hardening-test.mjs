import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ctx = { waitUntil() {}, passThroughOnException() {} };
const originalFetch = globalThis.fetch;
const key = 'hardening-gateway-key';
const baseEnv = {
  GATEWAY_ACCESS_KEY: key,
  PRIMARY_API_TOKENS: 'hardening-token@https://primary.example/v1',
  LOG_LEVEL: 'none',
};
const auth = { Authorization: `Bearer ${key}` };
const chat = (body, extra = {}) => new Request('https://gateway.example/v1/chat/completions', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json', ...(extra.headers || {}) },
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

  let calls = 0;
  const dashboard = await worker.fetch(new Request('https://gateway.example/', {
    headers: { Accept: 'text/html' },
  }), baseEnv, ctx);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(dashboard.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');

  // 已声明路由的大小写和尾斜杠必须落到网关自身处理器，不得意外透传上游。
  calls = 0;
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

  // Token 自身含 @ 时，使用最后一个 @https:// 作为绑定分隔符。
  let authorization = '';
  globalThis.fetch = async (_url, init) => {
    authorization = new Headers(init.headers).get('authorization') || '';
    return new Response(JSON.stringify({
      id: 'ok', object: 'chat.completion', model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const atToken = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'token@with-at@https://at.example/v1',
  }, ctx);
  assert.equal(atToken.status, 200);
  assert.equal(authorization, 'Bearer token@with-at');

  // URL 用户名/密码及 HTTP invoke_url 均不得绕过上游安全限制。
  const credentialUrl = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'token@https://user:pass@credential.example/v1',
  }, ctx);
  assert.equal(credentialUrl.status, 500);

  const badMapping = await worker.fetch(chat({ model: 'alias', messages: [] }), {
    ...baseEnv,
    MODEL_MAPPING: JSON.stringify({
      'primary.example': { alias: { model: 'vendor/model', invoke_url: 'http://unsafe.example/v1/chat/completions' } },
    }),
  }, ctx);
  assert.equal(badMapping.status, 500);

  const badSchema = await worker.fetch(chat({ model: 'alias', messages: [] }), {
    ...baseEnv,
    MODEL_MAPPING: JSON.stringify({ 'primary.example': { alias: { model: 'x', capabilities: [] } } }),
  }, ctx);
  assert.equal(badSchema.status, 500);

  // Host 映射大小写应归一化；静态覆盖不得改写 model/messages/stream。
  let mappedBody = null;
  globalThis.fetch = async (_url, init) => {
    mappedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      id: 'mapped', object: 'chat.completion', model: mappedBody.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-provider-secret': 'hidden' } });
  };
  const normalizedMapping = await worker.fetch(chat({ model: 'public-model', messages: [] }), {
    ...baseEnv,
    MODEL_MAPPING: JSON.stringify({
      'PRIMARY.EXAMPLE': {
        'public-model': {
          model: 'vendor/real-model',
          request_overrides: { temperature: 0.2 },
        },
      },
    }),
  }, ctx);
  assert.equal(normalizedMapping.status, 200);
  assert.equal(normalizedMapping.headers.get('x-provider-secret'), null);
  assert.equal(mappedBody.model, 'vendor/real-model');
  assert.equal(mappedBody.temperature, 0.2);

  const protectedOverride = await worker.fetch(chat({ model: 'public-model', messages: [] }), {
    ...baseEnv,
    MODEL_MAPPING: JSON.stringify({
      'primary.example': {
        'public-model': { model: 'vendor/real-model', request_overrides: { stream: true } },
      },
    }),
  }, ctx);
  assert.equal(protectedOverride.status, 500);
  assert.match(await protectedOverride.text(), /must not override model, messages, or stream/i);

  const protectedDrop = await worker.fetch(chat({ model: 'public-model', messages: [] }), {
    ...baseEnv,
    MODEL_MAPPING: JSON.stringify({
      'primary.example': {
        'public-model': { model: 'vendor/real-model', drop_params: ['model'] },
      },
    }),
  }, ctx);
  assert.equal(protectedDrop.status, 500);

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
    CACHE_STREAM: 'true',
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

  // 严格模式不能在未配置任何公开模型时返回一个误导性的空列表。
  const strictEmpty = await worker.fetch(new Request('https://gateway.example/v1/models', { headers: auth }), {
    ...baseEnv,
    STRICT_MODEL_MAPPING: 'true',
  }, ctx);
  assert.equal(strictEmpty.status, 500);
  assert.match(await strictEmpty.text(), /no models are configured/i);

  // 严格模式模型列表只暴露配置模型，不查询或泄露上游完整列表。
  calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  const strictModels = await worker.fetch(new Request('https://gateway.example/v1/models', { headers: auth }), {
    ...baseEnv,
    STRICT_MODEL_MAPPING: 'true',
    MODEL_MAPPING: JSON.stringify({ 'primary.example': { public_alias: 'private/vendor-model' } }),
  }, ctx);
  assert.equal(strictModels.status, 200);
  assert.deepEqual((await strictModels.json()).data.map(x => x.id), ['public_alias']);
  assert.equal(calls, 0);

  // 严格模式必须先筛选映射端点，再应用最大尝试数。
  let routedHost = '';
  globalThis.fetch = async (url) => {
    routedHost = new URL(String(url)).hostname;
    return new Response(JSON.stringify({
      id: 'strict', object: 'chat.completion', model: 'vendor/m',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const strictRouted = await worker.fetch(chat({ model: 'public', messages: [] }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'a@https://unmapped.example/v1,b@https://mapped.example/v1',
    PRIMARY_MAX_ATTEMPTS: '1',
    STRICT_MODEL_MAPPING: 'true',
    MODEL_MAPPING: JSON.stringify({ 'mapped.example': { public: 'vendor/m' } }),
  }, ctx);
  assert.equal(strictRouted.status, 200);
  assert.equal(routedHost, 'mapped.example');

  // 3xx 不直接透传；应尝试下一个端点。
  const redirectHosts = [];
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    redirectHosts.push(host);
    if (host === 'redirect.example') {
      return new Response(null, { status: 302, headers: { location: 'https://private-provider.example/login' } });
    }
    return new Response(JSON.stringify({
      id: 'second', object: 'chat.completion', model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const redirected = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'r@https://redirect.example/v1',
    PRIMARY_MAX_ATTEMPTS: '1',
    FALLBACK_ENABLED: 'true',
    FALLBACK_API_TOKEN: 's',
    FALLBACK_BASE_URL: 'https://second.example/v1',
    FALLBACK_PRIMARY_MODEL: 'm',
  }, ctx);
  assert.equal(redirected.status, 200);
  assert.equal(redirected.headers.get('location'), null);
  assert.equal(redirectHosts.length, 2);

  // 完全重复的 Primary 与 Fallback 配置不得在同一请求中重复调用。
  let duplicatePrimaryCalls = 0;
  globalThis.fetch = async () => {
    duplicatePrimaryCalls++;
    return new Response(JSON.stringify({ error: { message: 'fail' } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  };
  const duplicatePrimary = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'same@https://duplicate.example/v1,same@https://duplicate.example/v1',
    PRIMARY_MAX_ATTEMPTS: '2',
  }, ctx);
  assert.equal(duplicatePrimary.status, 502);
  assert.equal(duplicatePrimaryCalls, 1);

  let duplicateFallbackCalls = 0;
  globalThis.fetch = async (url) => {
    duplicateFallbackCalls++;
    const host = new URL(String(url)).hostname;
    return new Response(JSON.stringify({ error: { message: host } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  };
  const duplicateFallback = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'p@https://duplicate-primary.example/v1',
    PRIMARY_MAX_ATTEMPTS: '1',
    FALLBACK_ENABLED: 'true',
    FALLBACK_API_TOKEN: 'f',
    FALLBACK_BASE_URL: 'https://duplicate-fallback.example/v1',
    FALLBACK_PRIMARY_MODEL: 'same-model',
    FALLBACK_SECONDARY_MODEL: 'same-model',
  }, ctx);
  assert.equal(duplicateFallback.status, 502);
  assert.equal(duplicateFallbackCalls, 2); // one Primary + one deduplicated Fallback

  // 同一 Token 的不同 URL 必须拥有不同健康状态 ID。
  const uniqueHealth = await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'same@https://one.example/v1,same@https://two.example/v1',
  }, ctx);
  const uniqueJson = await uniqueHealth.json();
  const endpointIds = uniqueJson.endpoints.filter(x => x.role === 'primary').map(x => x.id);
  assert.equal(new Set(endpointIds).size, endpointIds.length);

  // 无效布尔值采用安全关闭，不得把 Fallback 或 Primary 意外启用。
  const invalidFallbackBoolean = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'p@https://invalid-bool-primary.example/v1',
    FALLBACK_ENABLED: 'flase',
    FALLBACK_API_TOKEN: 'fallback-token',
    FALLBACK_BASE_URL: 'https://invalid-bool-fallback.example/v1',
    FALLBACK_PRIMARY_MODEL: 'fallback-model',
  }, ctx);
  assert.equal(invalidFallbackBoolean.status, 502);
  assert.equal((await invalidFallbackBoolean.json()).error.details.fallback_configured, false);

  const invalidPrimaryBoolean = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    PRIMARY_ENABLED: 'treu',
  }, ctx);
  assert.equal(invalidPrimaryBoolean.status, 500);

  // off 必须真正关闭 Fallback。
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'fail' } }), {
    status: 500, headers: { 'content-type': 'application/json' },
  });
  const fallbackOff = await worker.fetch(chat({ model: 'm', messages: [] }), {
    ...baseEnv,
    FALLBACK_ENABLED: 'off',
    FALLBACK_API_TOKEN: 'fallback-token',
    FALLBACK_BASE_URL: 'https://fallback.example/v1',
    FALLBACK_PRIMARY_MODEL: 'fallback-model',
  }, ctx);
  assert.equal(fallbackOff.status, 502);
  assert.equal((await fallbackOff.json()).error.details.fallback_configured, false);

  // 客户端在响应头前取消时，不得继续轮询或惩罚上游健康状态。
  let abortFetchCalls = 0;
  globalThis.fetch = async (_url, init) => {
    abortFetchCalls++;
    return await new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const clientAbortController = new AbortController();
  const abortRequest = new Request('https://gateway.example/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
    signal: clientAbortController.signal,
  });
  const abortPromise = worker.fetch(abortRequest, {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'a@https://abort-a.example/v1,b@https://abort-b.example/v1',
    PRIMARY_MAX_ATTEMPTS: '2',
  }, ctx);
  clientAbortController.abort();
  const abortedResponse = await abortPromise;
  assert.equal(abortedResponse.status, 499);
  assert.equal(abortFetchCalls, 1);
  const abortHealth = await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'a@https://abort-a.example/v1,b@https://abort-b.example/v1',
    EXPOSE_UPSTREAM_INFO: 'true',
  }, ctx);
  const abortState = await abortHealth.json();
  const touchedAbortEndpoint = abortState.endpoints.find(item => item.base_url.includes('abort-a.example') || item.base_url.includes('abort-b.example'));
  assert.equal(touchedAbortEndpoint.total_failures, 0);

  // 无尾部分隔符的合法 SSE 仍应被读取；空流不得伪装成功。
  globalThis.fetch = async () => new Response(
    'data: {"id":"tail","model":"m","choices":[{"index":0,"delta":{"content":"tail-ok"},"finish_reason":"stop"}]}',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const tail = await worker.fetch(chat({ model: 'm', messages: [], stream: false }), {
    ...baseEnv, PRIMARY_API_TOKENS: 'tail-token@https://tail.example/v1', FAKE_STREAM_PROTECTION: 'true',
  }, ctx);
  assert.equal(tail.status, 200);
  assert.equal((await tail.json()).choices[0].message.content, 'tail-ok');

  globalThis.fetch = async () => new Response('', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  const emptyStream = await worker.fetch(chat({ model: 'm', messages: [], stream: false }), {
    ...baseEnv, PRIMARY_API_TOKENS: 'empty-token@https://empty.example/v1', FAKE_STREAM_PROTECTION: 'true',
  }, ctx);
  assert.equal(emptyStream.status, 502);

  // 客户端流统计在流真正结束后才记成功。
  let controller;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n'));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const before = await (await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), { ...baseEnv, PRIMARY_API_TOKENS: 'streamstats-token@https://streamstats.example/v1' }, ctx)).json();
  const streamResponse = await worker.fetch(chat({ model: 'm', messages: [], stream: true }), { ...baseEnv, PRIMARY_API_TOKENS: 'streamstats-token@https://streamstats.example/v1' }, ctx);
  const during = await (await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), { ...baseEnv, PRIMARY_API_TOKENS: 'streamstats-token@https://streamstats.example/v1' }, ctx)).json();
  assert.equal(during.client_stats.active_requests, before.client_stats.active_requests + 1);
  assert.equal(during.client_stats.successes_total, before.client_stats.successes_total);
  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  controller.close();
  await streamResponse.text();
  const after = await (await worker.fetch(new Request('https://gateway.example/health', { headers: auth }), { ...baseEnv, PRIMARY_API_TOKENS: 'streamstats-token@https://streamstats.example/v1' }, ctx)).json();
  assert.equal(after.client_stats.active_requests, before.client_stats.active_requests);
  assert.equal(after.client_stats.successes_total, before.client_stats.successes_total + 1);

  // 模型列表失败默认不暴露真实上游主机名。
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  const privateModels = await worker.fetch(new Request('https://gateway.example/v1/models', { headers: auth }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'p@https://private-models.example/v1',
  }, ctx);
  assert.equal(privateModels.status, 502);
  assert.doesNotMatch(await privateModels.text(), /private-models\.example/);

  globalThis.fetch = async () => new Response(JSON.stringify({
    object: 'list',
    data: [{ id: 'x'.repeat(5 * 1024 * 1024 + 1024) }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const oversizedModels = await worker.fetch(new Request('https://gateway.example/v1/models', { headers: auth }), {
    ...baseEnv,
    PRIMARY_API_TOKENS: 'p@https://oversized-models.example/v1',
    MODEL_LIST_MAX_ATTEMPTS: '1',
  }, ctx);
  assert.equal(oversizedModels.status, 502);
  assert.doesNotMatch(await oversizedModels.text(), /oversized-models\.example/);

  console.log('Hardening tests passed.');
} finally {
  globalThis.fetch = originalFetch;
}
