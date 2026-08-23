export function buildStandardHeaders(request, token, requestId) {
  const headers = new Headers();
  const incoming = request.headers;
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', incoming.get('content-type') || 'application/json');
  headers.set('Accept', incoming.get('accept') || 'application/json');
  headers.set('User-Agent', 'Smart-Edge-Gateway OpenAI-Compatible');
  headers.set('Accept-Encoding', 'identity');
  const orgId = incoming.get('openai-organization');
  if (orgId) headers.set('OpenAI-Organization', orgId);
  const idempotencyKey = incoming.get('idempotency-key');
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  headers.set('X-Request-ID', requestId);
  return headers;
}

export function buildTargetUrl(incomingUrl, targetBaseUrl) {
  const base = new URL(targetBaseUrl);
  let incomingPath = incomingUrl.pathname || '/';
  const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
  const lowerPath = incomingPath.toLowerCase();
  if (basePath.endsWith('/v1') && /^\/v1(?:\/|$)/.test(lowerPath)) {
    incomingPath = incomingPath.replace(/^\/[vV]1(?=\/|$)/, '') || '/';
  }
  base.pathname = joinPath(base.pathname, incomingPath);
  mergeSearchParams(base, incomingUrl);
  return base.toString();
}

function joinPath(left, right) {
  const a = String(left || '').replace(/\/+$/, '');
  const b = String(right || '').replace(/^\/+/, '');
  return `/${[a.replace(/^\/+/, ''), b].filter(Boolean).join('/')}`;
}

function mergeSearchParams(targetUrl, incomingUrl) {
  const merged = new URLSearchParams(targetUrl.search);
  const incoming = new Map();
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (!incoming.has(key)) incoming.set(key, []);
    incoming.get(key).push(value);
  }
  for (const [key, values] of incoming.entries()) {
    merged.delete(key);
    for (const value of values) merged.append(key, value);
  }
  targetUrl.search = merged.toString();
}

export function isStreamingResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
}

export function sanitizeUpstreamHeaders(sourceHeaders, exposeUpstreamInfo) {
  const headers = new Headers();
  const alwaysBlocked = new Set([
    'set-cookie', 'content-encoding', 'content-length',
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
  ]);
  const publicAllowlist = new Set([
    'content-type', 'cache-control', 'content-language', 'content-disposition',
    'content-range', 'accept-ranges', 'etag', 'last-modified', 'expires',
    'x-accel-buffering',
  ]);
  for (const [name, value] of sourceHeaders.entries()) {
    const lower = name.toLowerCase();
    if (alwaysBlocked.has(lower)) continue;
    if (!exposeUpstreamInfo && !publicAllowlist.has(lower)) continue;
    headers.append(name, value);
  }
  return headers;
}

export function corsHeaders(request, env) {
  const allowedOrigin = normalizeAllowedOrigin(env?.ALLOWED_ORIGIN);
  const allowedRequestHeaders = new Set([
    'authorization', 'x-api-key', 'content-type', 'accept', 'idempotency-key',
    'anthropic-version', 'anthropic-beta', 'x-claude-code-session-id',
    'x-claude-code-agent-id', 'x-claude-code-parent-agent-id',
  ]);
  const requested = String(request.headers.get('Access-Control-Request-Headers') || '')
    .split(',').map(v => v.trim()).filter(Boolean);
  const accepted = requested.filter(v => allowedRequestHeaders.has(v.toLowerCase()));
  const allowHeaders = accepted.length > 0
    ? accepted.join(', ')
    : 'Authorization,X-Api-Key,Content-Type,Accept,Idempotency-Key,Anthropic-Version,Anthropic-Beta,X-Claude-Code-Session-Id,X-Claude-Code-Agent-Id,X-Claude-Code-Parent-Agent-Id';
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Expose-Headers': 'X-Request-Id,X-Edge-Gateway-Attempts,X-Edge-Gateway-Upstream-Status,X-Edge-Gateway-Cache,X-Edge-Gateway-Health,X-Edge-Gateway-Route,X-Edge-Gateway-Fallback,X-Edge-Gateway-Fallback-Provider,X-Edge-Gateway-Fallback-Tier,X-Edge-Gateway-Fallback-Model,X-Edge-Gateway-Requested-Model,X-Edge-Gateway-Primary-Attempts,X-Edge-Gateway-Fallback-Reason,X-Edge-Gateway-Model-Source',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (allowedOrigin !== '*') headers.Vary = 'Origin';
  return headers;
}

function normalizeAllowedOrigin(value) {
  const raw = String(value || '*').trim();
  if (raw === '*') return '*';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'null';
    if (parsed.username || parsed.password) return 'null';
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return 'null';
    return parsed.origin;
  } catch { return 'null'; }
}

export function createAbortableStream(upstreamBody, requestSignal, clientAbortListener) {
  const reader = upstreamBody.getReader();
  let cleanedUp = false;
  const encoder = new TextEncoder();

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (requestSignal && clientAbortListener) {
      requestSignal.removeEventListener('abort', clientAbortListener);
    }
    try { await reader.cancel().catch(() => {}); } catch {}
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); cleanup(); }
        else { controller.enqueue(value); }
      } catch (error) {
        if (requestSignal && requestSignal.aborted) {
          try { controller.close(); } catch {}
        } else {
          const errMsg = JSON.stringify({ error: { message: `Stream interrupted: ${error?.message || 'unknown'}`, type: 'server_error' } });
          try {
            controller.enqueue(encoder.encode(`data: ${errMsg}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch {}
        }
        cleanup();
      }
    },
    cancel() { cleanup(); },
  });
}

export function withCors(response, request, env, extraHeaders, streamOptions) {
  const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);
  const headers = sanitizeUpstreamHeaders(response.headers, exposeUpstreamInfo);
  Object.entries(corsHeaders(request, env)).forEach(([k, v]) => {
    if (k.toLowerCase() === 'vary') headers.set(k, mergeVaryHeader(headers.get('vary'), v));
    else headers.set(k, v);
  });
  for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);

  const ct = (headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }

  let body = response.body;
  if (streamOptions && body) {
    body = createAbortableStream(body, streamOptions.requestSignal, streamOptions.clientAbortListener);
  }

  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function mergeVaryHeader(existing, value) {
  const values = new Set(String(existing || '').split(',').map(v => v.trim()).filter(Boolean));
  values.add(value);
  return [...values].join(', ');
}

function readBooleanEnv(env, name, fallback) {
  const value = env?.[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function jsonError(request, env, status, message, details, requestId) {
  return new Response(JSON.stringify({ error: { message, ...(details ? { details } : {}) } }, null, 2), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
    },
  });
}

export function htmlResponse(content) {
  return new Response(content, {
    status: 200,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
  });
}

export function sanitizePrometheusLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}