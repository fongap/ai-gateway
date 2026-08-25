// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Main request pipeline.
//
//   auth -> route -> body -> validate -> model support check
//     -> per-tier attempt loop:
//          recompute eligible candidates (dynamic, no static retry index)
//          -> attempt node -> classify outcome
//             - success        return response
//             - rotate         node rotation within the same tier
//             - tier exhausted fall back to the next tier
//             - stop           return immediately (client-side errors)
//
// Streaming rule: the first-event guard runs BEFORE any streaming Response is
// returned to the client; after that point transparent failover is forbidden.

import { loadGatewayConfig } from '../config/nodes.js';
import { loadModelsConfig } from '../config/models.js';
import { loadPoliciesConfig, getPolicy } from '../config/policies.js';
import { getLimits } from '../config/timeouts.js';
import { pickCandidate, supportsModel, tierHasDeferredCapacity } from '../scheduler/scheduler.js';
import {
  recordSuccess, recordFailure, recordNeutralEnd,
  applyHealthPenalty, getCooldownRemainingMs,
} from '../reliability/node-state.js';
import {
  classifyUpstreamStatus, classifyNetworkError, classifyFirstEventFailure,
  classifyClientAbort,
} from '../reliability/classify.js';
import {
  buildTargetUrl, buildUpstreamHeaders, corsHeaders,
  readBodyTextWithLimit, BodyTooLargeError, safeReadErrorBody, trimDiagnostic,
  parseBearer,
} from '../protocol/http.js';
import { validateOpenAIChatRequest, isOpenAIStreamingResponse } from '../protocol/openai.js';
import {
  anthropicErrorResponse, anthropicErrorTypeForStatus,
  validateAnthropicMessagesRequest, validateAnthropicCountTokensRequest,
  estimateAnthropicInputTokens,
} from '../protocol/anthropic.js';
import { anthropicToOpenAIRequest, openAIToAnthropicMessage } from '../protocol/convert.js';
import { ensureFirstSseEvent, GUARD_ERROR } from '../stream/guard.js';
import { transformOpenAIStreamToAnthropic } from '../stream/transform.js';
import { collectOpenAIStreamObject } from '../stream/assemble.js';
import { trackStreamResponse } from '../stream/track.js';
import { getLogger } from '../observability/logger.js';
import { healthResponse, metricsResponse, modelsListResponse, versionResponse } from '../observability/status.js';
import { dashboardResponse } from '../dashboard/pages.js';

const TIER_ORDER = [1, 2, 3];
const DIAGNOSTIC_BYTES = 4096;

// Unified gateway error: Anthropic-style for Anthropic routes, OpenAI-style otherwise.
function gatewayError(request, env, route, status, message, requestId, details, extraHeaders) {
  if (route === 'anthropic_messages' || route === 'anthropic_count_tokens') {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: anthropicErrorTypeForStatus(status), message, ...(details ? { details } : {}) },
    }), {
      status,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'cache-control': 'no-store',
        'request-id': requestId || '',
        'x-request-id': requestId || '',
        ...(extraHeaders || {}),
        ...corsHeaders(request, env),
      },
    });
  }
  return new Response(JSON.stringify({ error: { message, ...(details ? { details } : {}) } }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...(extraHeaders || {}),
      ...corsHeaders(request, env),
    },
  });
}

// Cached digest of the gateway access key (immutable per isolate).
let cachedAccessKey = null;
let cachedAccessKeyDigest = null;

function getAccessKeyDigest(accessKey) {
  if (cachedAccessKey === accessKey && cachedAccessKeyDigest) return Promise.resolve(cachedAccessKeyDigest);
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(accessKey ?? '')))
    .then((digest) => {
      cachedAccessKey = accessKey;
      cachedAccessKeyDigest = new Uint8Array(digest);
      return cachedAccessKeyDigest;
    });
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

export async function handleRequest(request, env, ctx) {
  const logger = getLogger(env);
  const requestId = crypto.randomUUID();
  const requestUrl = new URL(request.url);
  const pathname = normalizePath(requestUrl.pathname);
  const route = detectRoute(request.method, pathname);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (request.method === 'GET' && pathname === '/' && acceptsHtml(request)) {
    return dashboardResponse(request, env);
  }

  const accessKey = typeof env?.GATEWAY_ACCESS_KEY === 'string' ? env.GATEWAY_ACCESS_KEY : '';
  if (!accessKey && route !== 'version') {
    return gatewayError(request, env, route, 500, 'Gateway misconfigured: GATEWAY_ACCESS_KEY is not set.', requestId);
  }
  if (route !== 'version') {
    const bearer = parseBearer(request.headers.get('authorization'));
    const xApiKey = String(request.headers.get('x-api-key') || '').trim();
    const presented = [];
    if (bearer) presented.push(bearer);
    if (xApiKey) presented.push(xApiKey);
    let authorized = false;
    if (presented.length > 0) {
      // The expected digest is cached per isolate: one SHA-256 per request
      // instead of two, with the same either-header-matches semantics and a
      // constant-time comparison.
      const expected = await getAccessKeyDigest(accessKey);
      for (const candidate of presented) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate));
        if (constantTimeEquals(new Uint8Array(digest), expected)) {
          authorized = true;
          break;
        }
      }
    }
    if (!authorized) {
      return gatewayError(request, env, route, 401, 'Unauthorized: gateway access key is invalid or missing.', requestId);
    }
  }

  switch (route) {
    case 'version': return versionResponse(request, env);
    case 'health': return healthResponse(request, env, requestId);
    case 'metrics': return metricsResponse(request, env, requestId);
    case 'models': return modelsListResponse(request, env, requestId);
    case 'openai_chat':
    case 'anthropic_messages':
    case 'anthropic_count_tokens':
      break;
    default:
      return gatewayError(request, env, route, 404, 'Route not found.', requestId);
  }

  // ---- Request body ----
  const limits = getLimits(env);
  let bodyJson;
  try {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return gatewayError(request, env, route, 415, 'This endpoint requires Content-Type: application/json.', requestId);
    }
    const text = await readBodyTextWithLimit(request, limits.maxBodyBytes);
    bodyJson = JSON.parse(text || '{}');
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return gatewayError(request, env, route, 413, error.message, requestId);
    }
    return gatewayError(request, env, route, 400, `Invalid JSON request body: ${error.message}`, requestId);
  }

  // ---- Local Anthropic count_tokens ----
  if (route === 'anthropic_count_tokens') {
    const mode = String(env?.ANTHROPIC_COUNT_TOKENS_MODE || 'approximate').toLowerCase();
    if (!['approximate', 'disabled'].includes(mode)) {
      return anthropicErrorResponse(request, env, 500, 'ANTHROPIC_COUNT_TOKENS_MODE must be approximate or disabled.', requestId);
    }
    if (mode === 'disabled') {
      return anthropicErrorResponse(request, env, 404, 'Token counting is disabled on this gateway.', requestId);
    }
    const validationError = validateAnthropicCountTokensRequest(bodyJson);
    if (validationError) return anthropicErrorResponse(request, env, 400, validationError, requestId);
    return jsonResponse(200, { input_tokens: estimateAnthropicInputTokens(bodyJson) }, env, request, { 'x-request-id': requestId });
  }

  const validationError = route === 'anthropic_messages'
    ? validateAnthropicMessagesRequest(bodyJson)
    : validateOpenAIChatRequest(bodyJson);
  if (validationError) return gatewayError(request, env, route, 400, validationError, requestId);

  const requestedModel = String(bodyJson.model || '');
  const clientWantsStream = bodyJson.stream === true;
  const fakeStream = route === 'openai_chat'
    && String(env?.FAKE_STREAM_PROTECTION ?? '').trim().toLowerCase() === 'true'
    && !clientWantsStream;

  // ---- Candidate pool ----
  const config = loadGatewayConfig(env);
  if (config.nodes.length === 0) {
    return gatewayError(request, env, route, 500,
      'Gateway misconfigured: no usable nodes. Check TIER*_NODES_CONFIG_* and NODE_SECRETS_*.',
      requestId, { configuration_status: config.status, diagnostics: config.diagnostics.slice(0, 5) });
  }
  const tiers = config.tiers;
  const supported = TIER_ORDER.some((t) => tiers[t].some((n) => supportsModel(n, requestedModel)));
  if (!supported) {
    return gatewayError(request, env, route, 404,
      `No configured node provides model "${requestedModel}". Verify the models mapping.`, requestId);
  }

  const policy = getPolicy(requestedModel, loadModelsConfig(env), loadPoliciesConfig(env));
  const exposeUpstreamInfo = String(env?.EXPOSE_UPSTREAM_INFO ?? '').trim().toLowerCase() === 'true';

  // Anthropic requests convert once; per-attempt only the model name changes.
  const anthropicConversion = route === 'anthropic_messages'
    ? anthropicToOpenAIRequest(bodyJson, '', env)
    : null;

  const state = { attempted: new Set(), attempts: [], totalAttempts: 0 };

  for (const tierNumber of TIER_ORDER) {
    while (state.totalAttempts < policy.maxAttempts) {
      const node = pickCandidate(tiers[tierNumber], requestedModel, state.attempted);
      if (!node) break; // tier exhausted -> fallback to next tier
      const outcome = await attemptNode({
        request, env, ctx, logger, requestId, route, node, requestedModel,
        clientWantsStream, fakeStream, bodyJson, anthropicConversion,
        limits, exposeUpstreamInfo, state,
      });
      if (outcome.response) return outcome.response;
      if (outcome.stop) break;
    }
  }

  return buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers);
}

// ---- One attempt against one node -----------------------------------------

async function attemptNode(c) {
  const {
    request, env, logger, requestId, route, node, requestedModel, clientWantsStream,
    fakeStream, bodyJson, anthropicConversion, limits, exposeUpstreamInfo, state,
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;

  const upstreamModel = node.models[requestedModel] || requestedModel;
  let outboundBody;
  if (route === 'openai_chat') {
    outboundBody = JSON.stringify({ ...bodyJson, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) });
  } else {
    outboundBody = JSON.stringify({ ...anthropicConversion, model: upstreamModel });
  }

  let targetUrl;
  try {
    targetUrl = buildTargetUrl(node.baseUrl, '/v1/chat/completions');
  } catch {
    return rotateWithNeutralEnd(state, node, 'invalid_base_url');
  }

  const headers = buildUpstreamHeaders(request, node.credential, requestId);
  const controller = new AbortController();
  let headersTimeoutHit = false;
  const timeoutId = setTimeout(() => {
    headersTimeoutHit = true;
    controller.abort();
  }, limits.headersTimeoutMs);
  const onClientAbort = () => controller.abort();
  if (request.signal?.aborted) onClientAbort();
  else request.signal?.addEventListener('abort', onClientAbort, { once: true });
  const detach = () => request.signal?.removeEventListener('abort', onClientAbort);

  const startMs = Date.now();
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: outboundBody,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    detach();
    const latencyMs = Date.now() - startMs;
    if (request.signal?.aborted && !headersTimeoutHit) {
      recordOutcome(state, node, classifyClientAbort(), latencyMs);
      return { response: gatewayError(request, env, route, 499, 'Client closed the request.', requestId) };
    }
    recordOutcome(state, node, classifyNetworkError(headersTimeoutHit), latencyMs);
    logger.debug(`upstream fetch failed on ${node.id}: ${error?.message || error}`);
    return { rotate: true };
  }
  clearTimeout(timeoutId);
  const latencyMs = Date.now() - startMs;

  // ---- Non-OK response ----
  if (!upstream.ok) {
    detach();
    const classification = classifyUpstreamStatus(upstream.status, upstream.headers, env);
    const errorText = await safeReadErrorBody(upstream, DIAGNOSTIC_BYTES);
    recordOutcome(state, node, classification, latencyMs, errorText, exposeUpstreamInfo, upstream.status);
    if (classification.action === 'stop') {
      return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, upstream.status, errorText, state) };
    }
    return { rotate: true };
  }

  return handleSuccess({
    upstream, c, targetUrl, latencyMs, detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}

async function handleSuccess(s) {
  const { upstream, c, latencyMs, detach, upstreamWasStreaming } = s;
  const { request, env, logger, requestId, route, node, requestedModel, clientWantsStream, fakeStream, limits, exposeUpstreamInfo, state } = c;
  const elapsedSinceStart = () => Date.now() - s.attemptStartMs;

  const extraHeaders = {
    'x-gateway-node': node.id,
    'x-gateway-tier': node.tier,
    'x-request-id': requestId,
  };

  const needsModelRewrite = requestedModel !== upstreamModelOf(node, requestedModel);

  // Streaming passthrough / transformed streams: run the first-event guard
  // BEFORE returning anything to the client.
  if (clientWantsStream && upstreamWasStreaming) {
    let guarded;
    try {
      guarded = await ensureFirstSseEvent(upstream, limits.firstEventTimeoutMs, request.signal);
    } catch (e) {
      detach();
      const code = e?.code || GUARD_ERROR.EMPTY;
      if (code === GUARD_ERROR.ABORTED) {
        recordOutcome(state, node, classifyClientAbort(), latencyMs);
        return { response: gatewayError(request, env, route, 499, 'Client closed the request before the first stream event.', requestId) };
      }
      recordOutcome(state, node, classifyFirstEventFailure(), latencyMs, code, exposeUpstreamInfo);
      return { rotate: true };
    }
    detach();

    const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

    if (route === 'openai_chat') {
      let tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
        onSuccess: () => recordSuccess(node.id, latencyMs),
        onFailure: () => recordFailure(node.id, { counted: true, cooldownMs: 2_000, reason: 'stream_interrupted' }),
        onNeutral: () => recordNeutralEnd(node.id),
      });
      if (needsModelRewrite) tracked = rewriteStreamModelField(tracked, requestedModel);
      return { response: tracked };
    }

    // anthropic_messages: transform then track the CLIENT-facing stream so an
    // interrupted transform records against the node exactly once.
    const transformed = transformOpenAIStreamToAnthropic(guarded, requestedModel, requestId, request.signal);
    const tracked = trackStreamResponse(transformed, {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      onSuccess: () => recordSuccess(node.id, latencyMs),
      onFailure: () => recordFailure(node.id, { counted: true, cooldownMs: 2_000, reason: 'stream_interrupted' }),
      onNeutral: () => recordNeutralEnd(node.id),
    });
    return { response: new Response(tracked.body, { status: 200, headers }) };
  }
  detach();

  const trackCallbacks = {
    onSuccess: () => recordSuccess(node.id, latencyMs),
    onFailure: () => recordFailure(node.id, { counted: true, cooldownMs: 2_000, reason: 'stream_interrupted' }),
    onNeutral: () => recordNeutralEnd(node.id),
  };

  // ---- OpenAI chat ----
  if (route === 'openai_chat') {
    if (fakeStream || (upstreamWasStreaming && !clientWantsStream)) {
      // Assemble the full object; nothing reached the client yet, so failures rotate.
      try {
        const data = await collectOpenAIStreamObject(upstream, request.signal);
        recordSuccess(node.id, latencyMs);
        data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      } catch (error) {
        if (request.signal?.aborted) {
          recordOutcome(state, node, classifyClientAbort(), elapsedSinceStart());
          return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
        }
        recordOutcome(state, node, classifyFirstEventFailure(), latencyMs, error.message, exposeUpstreamInfo);
        return { rotate: true };
      }
    }
    if (upstreamWasStreaming) {
      const tracked = trackStreamResponse(
        new Response(upstream.body, { status: 200, headers: finalHeaders(env, request, upstream.headers, extraHeaders) }),
        {
          idleTimeoutMs: limits.streamIdleTimeoutMs,
          // A passthrough stream that closes without [DONE] is a truncation:
          // deliver what arrived, but account the node failure.
          completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
          ...trackCallbacks,
        },
      );
      return { response: needsModelRewrite ? rewriteStreamModelField(tracked, requestedModel) : tracked };
    }
    // Upstream answered 200 but NOT with SSE. Some free providers return
    // JSON bodies (sometimes with an embedded error object) even for
    // stream:true requests. Handle explicitly instead of feeding the client
    // a body it cannot parse as a stream.
    const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return rotateWithNeutralEnd(state, node, 'upstream_200_non_json_body');
    }
    if (data && typeof data === 'object' && data.error) {
      // Provider returned 200 with an embedded error: treat as a real failure
      // so the request rotates to a healthy node instead of relaying garbage.
      const status = Number(data.error.status) >= 400 && Number(data.error.status) < 600
        ? Math.trunc(Number(data.error.status))
        : 502;
      const classification = classifyUpstreamStatus(status, upstream.headers, env);
      recordOutcome(state, node, classification, latencyMs, trimDiagnostic(data.error.message || 'embedded error', 200), exposeUpstreamInfo, status);
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, text, state) };
      }
      return { rotate: true };
    }
    if (!clientWantsStream) {
      recordSuccess(node.id, latencyMs);
      if (data && typeof data === 'object') data.model = requestedModel;
      return { response: jsonResponse(200, data, env, request, extraHeaders) };
    }
    // Valid completion JSON for a streaming client: synthesize a proper SSE
    // stream so SSE clients receive a well-formed event sequence.
    recordSuccess(node.id, latencyMs);
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: synthesizeSseFromCompletion(data, env, request, extraHeaders) };
  }

  // ---- Anthropic messages ----
  try {
    let data;
    if (upstreamWasStreaming) {
      data = await collectOpenAIStreamObject(upstream, request.signal);
    } else {
      data = JSON.parse(await upstream.text());
    }
    const message = openAIToAnthropicMessage(data, requestedModel);
    recordSuccess(node.id, latencyMs);
    return { response: jsonResponse(200, message, env, request, extraHeaders) };
  } catch (error) {
    if (request.signal?.aborted) {
      recordOutcome(state, node, classifyClientAbort(), latencyMs);
      return { response: gatewayError(request, env, route, 499, 'Client closed the request during conversion.', requestId) };
    }
    recordOutcome(state, node, classifyFirstEventFailure(), latencyMs, error.message, exposeUpstreamInfo);
    return { rotate: true };
  }
}

function upstreamModelOf(node, logicalModel) {
  return node.models[logicalModel] || logicalModel;
}

// Convert a full OpenAI completion object into a well-formed SSE stream
// (delta chunks + finish chunk + [DONE]) for clients that requested
// streaming but received JSON from the upstream.
export function synthesizeSseFromCompletion(data, env, request, extraHeaders) {
  const encoder = new TextEncoder();
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const base = {
    id: data?.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: data?.created || Math.floor(Date.now() / 1000),
    model: data?.model,
  };
  const stream = new ReadableStream({
    start(controller) {
      const emit = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      for (const choice of choices) {
        const msg = choice.message || {};
        const delta = { role: msg.role || 'assistant' };
        if (msg.content) delta.content = msg.content;
        if (msg.reasoning_content) delta.reasoning_content = msg.reasoning_content;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) delta.tool_calls = msg.tool_calls;
        emit({ ...base, choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] });
      }
      for (const choice of choices) {
        const finish = { index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason || 'stop' };
        emit({ ...base, choices: [finish], ...(data.usage ? { usage: data.usage } : {}) });
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      ...(extraHeaders || {}),
      ...corsHeaders(request, env),
    },
  });
}

function rotateWithNeutralEnd(state, node, reason) {
  state.attempted.add(node.id);
  state.totalAttempts++;
  recordNeutralEnd(node.id);
  state.attempts.push({ attempt: state.totalAttempts, node_id: node.id, status: 0, kind: reason });
  return { rotate: true };
}

// Record a classified attempt outcome exactly once.
function recordOutcome(state, node, classification, latencyMs, diagnostic, exposeUpstreamInfo, status = 0) {
  state.attempted.add(node.id);
  state.totalAttempts++;

  if (classification.action === 'neutral') {
    recordNeutralEnd(node.id);
  } else {
    applyHealthPenalty(node.id, classification.kind);
    recordFailure(node.id, { counted: classification.counted, cooldownMs: classification.cooldownMs || 0, reason: classification.kind });
  }

  const record = { attempt: state.totalAttempts, node_id: node.id, status, kind: classification.kind };
  if (latencyMs !== undefined && latencyMs >= 0) record.latency_ms = latencyMs;
  if (exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
  state.attempts.push(record);
}

// ---- Response helpers ------------------------------------------------------

function finalHeaders(env, request, sourceHeaders, extraHeaders) {
  const headers = new Headers();
  if (sourceHeaders) {
    const contentType = sourceHeaders.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    const buffering = sourceHeaders.get('x-accel-buffering');
    if (buffering) headers.set('x-accel-buffering', buffering);
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return headers;
}

function jsonResponse(status, data, env, request, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
      ...corsHeaders(request, env),
    },
  });
}

// Rewrite the model field in a passthrough OpenAI SSE stream. Lines that cannot
// contain the field are never parsed, keeping per-chunk CPU minimal.
function rewriteStreamModelField(response, logicalModel) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = '';

  const processLine = (line) => {
    if (!line.startsWith('data:') || !line.includes('"model"')) return line;
    const raw = line.slice(5).trimStart();
    if (!raw || raw === '[DONE]') return line;
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === 'object' && json.model !== undefined) {
        json.model = logicalModel;
        return 'data: ' + JSON.stringify(json);
      }
    } catch { /* malformed lines pass through untouched */ }
    return line;
  };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (lineBuffer) {
            controller.enqueue(encoder.encode(lineBuffer));
            lineBuffer = '';
          }
          controller.close();
          return;
        }
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) controller.enqueue(encoder.encode(processLine(line) + '\n'));
      } catch (e) {
        try { controller.error(e); } catch { /* closed */ }
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers) {
  const last = state.attempts[state.attempts.length - 1];
  const nothingAttempted = state.attempts.length === 0;

  // Distinguish WHY no node was available:
  //   saturated (all candidates busy at concurrency/RPM caps) -> 503 + short
  //     Retry-After so bursty multi-agent clients back off instead of hammering;
  //   cooling / circuit open -> 429 + the smallest remaining cooldown;
  //   real failures -> 502.
  let status;
  let message;
  let retryAfterSec;
  if (nothingAttempted) {
    const deferred = TIER_ORDER.some((t) =>
      tierHasDeferredCapacity(tiers[t], requestedModel, state.attempted));
    if (deferred) {
      status = 503;
      message = 'All eligible nodes are at capacity. Retry shortly.';
      retryAfterSec = 1;
    } else {
      const remaining = Object.values(tiers).flat()
        .map((n) => getCooldownRemainingMs(n.id))
        .filter((v) => v > 0);
      const minRemaining = remaining.length ? Math.min(...remaining) : 0;
      status = 429;
      message = 'All eligible nodes are temporarily unavailable (cooldown or circuit open).';
      if (minRemaining > 0) retryAfterSec = Math.ceil(minRemaining / 1000);
    }
  } else {
    status = last?.status === 429 ? 429 : 502;
    message = `All nodes failed for model "${requestedModel}".`;
    if (status === 429) {
      const remaining = Object.values(tiers).flat()
        .map((n) => getCooldownRemainingMs(n.id))
        .filter((v) => v > 0);
      if (remaining.length) retryAfterSec = Math.ceil(Math.min(...remaining) / 1000);
    }
  }

  const details = {
    attempts: state.attempts,
    requested_model: requestedModel,
    nodes_total: Object.values(tiers).flat().length,
  };
  // Route-aware body: Anthropic clients must receive Anthropic-shaped errors.
  return gatewayError(request, env, route, status, message, requestId, details,
    retryAfterSec ? { 'retry-after': String(retryAfterSec) } : undefined);
}

function buildClientErrorResponse(request, env, route, requestId, requestedModel, status, errorText, state) {
  const detail = extractErrorMessage(errorText) || `Upstream returned HTTP ${status}.`;
  if (route === 'anthropic_messages') {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: anthropicErrorTypeForStatus(status), message: detail },
    }), {
      status,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'cache-control': 'no-store',
        'request-id': requestId,
        'x-request-id': requestId,
        ...corsHeaders(request, env),
      },
    });
  }
  return new Response(JSON.stringify({
    error: {
      message: detail,
      details: { requested_model: requestedModel, attempts: state.attempts.slice(-1) },
    },
  }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...corsHeaders(request, env),
    },
  });
}

function extractErrorMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    return json?.error?.message || json?.message || trimDiagnostic(raw, 300);
  } catch {
    return trimDiagnostic(raw, 300);
  }
}

// ---- Route helpers ---------------------------------------------------------

export function normalizePath(pathname) {
  return String(pathname || '/').replace(/\/+$/, '').toLowerCase() || '/';
}

function detectRoute(method, pathname) {
  const verb = String(method).toUpperCase();
  if (verb === 'GET') {
    if (pathname === '/health') return 'health';
    if (pathname === '/metrics') return 'metrics';
    if (pathname === '/version') return 'version';
    if (pathname === '/v1/models' || pathname === '/models') return 'models';
    return 'other';
  }
  if (verb !== 'POST') return 'other';
  if (pathname === '/v1/messages/count_tokens' || pathname === '/messages/count_tokens') return 'anthropic_count_tokens';
  if (pathname === '/v1/messages' || pathname === '/messages') return 'anthropic_messages';
  if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') return 'openai_chat';
  return 'other';
}

function acceptsHtml(request) {
  return (request.headers.get('accept') || '').includes('text/html');
}
