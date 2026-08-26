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
import { pickCandidate, supportsModel } from '../scheduler/scheduler.js';
import {
  recordSuccess, recordFailure, recordNeutralEnd,
  applyHealthPenalty,
} from '../reliability/node-state.js';
import {
  classifyUpstreamStatus, classifyNetworkError, classifyFirstEventFailure,
  classifyClientAbort,
} from '../reliability/classify.js';
import {
  buildTargetUrl, buildUpstreamHeaders, corsHeaders,
  readBodyTextWithLimit, BodyTooLargeError, safeReadErrorBody, trimDiagnostic,
} from '../protocol/http.js';
import { validateOpenAIChatRequest, isOpenAIStreamingResponse } from '../protocol/openai.js';
import {
  anthropicErrorResponse,
  validateAnthropicMessagesRequest, validateAnthropicCountTokensRequest,
  estimateAnthropicInputTokens,
} from '../protocol/anthropic.js';
import { anthropicToOpenAIRequest, openAIToAnthropicMessage } from '../protocol/convert.js';
import {
  validateOpenAIResponsesRequest, responsesToOpenAIRequest, ResponseConversionError,
  openAICompletionToResponses, transformOpenAIStreamToResponses,
  synthesizeResponsesFromCompletion,
} from '../protocol/responses/index.js';
import { ensureFirstSseEvent, GUARD_ERROR } from '../stream/guard.js';
import { transformOpenAIStreamToAnthropic } from '../stream/transform.js';
import { collectOpenAIStreamObject } from '../stream/assemble.js';
import { trackStreamResponse } from '../stream/track.js';
import { getLogger } from '../observability/logger.js';
import { healthResponse, metricsResponse, modelsListResponse, versionResponse } from '../observability/status.js';
import { dashboardResponse } from '../dashboard/pages.js';
import { isAuthorized } from './auth.js';
import { gatewayError, buildBudgetExhaustedResponse, buildExhaustedResponse, buildClientErrorResponse } from './errors.js';
import { TIER_ORDER, normalizePath, detectRoute, acceptsHtml } from './router.js';

const DIAGNOSTIC_BYTES = 4096;

export async function handleRequest(request, env, ctx) {
  const logger = getLogger(env);
  const requestId = crypto.randomUUID();
  const requestUrl = new URL(request.url);
  const pathname = normalizePath(requestUrl.pathname);
  const route = detectRoute(request.method, pathname);
  // Whole-request wall clock starts when the gateway receives the request. It
  // bounds the total failover budget (see FAILOVER_BUDGET_MS) regardless of how
  // many attempts / nodes / tiers are involved.
  const requestStartMs = Date.now();
  const failoverBudgetMs = getLimits(env).failoverBudgetMs;
  const exposeUpstreamInfo = String(env?.EXPOSE_UPSTREAM_INFO ?? '').trim().toLowerCase() === 'true';

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
  if (route !== 'version' && !(await isAuthorized(request, accessKey))) {
    return gatewayError(request, env, route, 401, 'Unauthorized: gateway access key is invalid or missing.', requestId);
  }

  switch (route) {
    case 'version': return versionResponse(request, env);
    case 'health': return healthResponse(request, env, requestId);
    case 'metrics': return metricsResponse(request, env, requestId);
    case 'models': return modelsListResponse(request, env, requestId);
    case 'openai_chat':
    case 'anthropic_messages':
    case 'anthropic_count_tokens':
    case 'openai_responses':
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

  let validationError;
  if (route === 'openai_responses') validationError = validateOpenAIResponsesRequest(bodyJson);
  else if (route === 'anthropic_messages') validationError = validateAnthropicMessagesRequest(bodyJson);
  else validationError = validateOpenAIChatRequest(bodyJson);
  if (validationError) return gatewayError(request, env, route, 400, validationError, requestId);

  const requestedModel = String(bodyJson.model || '');
  const clientWantsStream = bodyJson.stream === true;
  const fakeStream = route === 'openai_chat'
    && String(env?.FAKE_STREAM_PROTECTION ?? '').trim().toLowerCase() === 'true'
    && !clientWantsStream;

  // ---- Candidate pool ----
  const config = loadGatewayConfig(env);
  // `ready` is the single serve/don't-serve gate: it is true only for the
  // ready/degraded statuses. A structurally INVALID config (duplicate ids,
  // conflicting shards) refuses service even if some nodes parsed — otherwise
  // /health would say 503 while traffic kept flowing.
  if (!config.ready) {
    return gatewayError(request, env, route, 500,
      'Gateway misconfigured: no usable node configuration. Check TIER*_NODES_CONFIG_* and NODE_SECRETS_*.',
      requestId,
      { configuration_status: config.status, ...(exposeUpstreamInfo ? { diagnostics: config.diagnostics.slice(0, 5) } : {}) });
  }
  const tiers = config.tiers;
  const supported = TIER_ORDER.some((t) => tiers[t].some((n) => supportsModel(n, requestedModel)));
  if (!supported) {
    return gatewayError(request, env, route, 404,
      `No configured node provides model "${requestedModel}". Verify the models mapping.`, requestId);
  }

  const policy = getPolicy(requestedModel, loadModelsConfig(env), loadPoliciesConfig(env));

  // Anthropic / Responses requests convert once; per-attempt only the model
  // name changes. A Responses conversion error is a request-shape problem and
  // never reaches an upstream (unsupported tool types etc.).
  const anthropicConversion = route === 'anthropic_messages'
    ? anthropicToOpenAIRequest(bodyJson, '', env)
    : null;
  let responsesConversion = null;
  if (route === 'openai_responses') {
    try {
      responsesConversion = responsesToOpenAIRequest(bodyJson, '', env);
    } catch (error) {
      if (error instanceof ResponseConversionError) {
        return gatewayError(request, env, route, 400, error.message, requestId);
      }
      throw error;
    }
  }

  const state = { attempted: new Set(), attempts: [], totalAttempts: 0, failureKinds: {}, logger, maxAttempts: policy.maxAttempts };

  for (const tierNumber of TIER_ORDER) {
    while (state.totalAttempts < policy.maxAttempts) {
      // Failover budget gate: before preparing a NEW attempt, stop if the
      // request has already consumed the whole budget. Never keep hammering
      // upstreams once the client has waited ~FAILOVER_BUDGET_MS overall.
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }
      const node = pickCandidate(tiers[tierNumber], requestedModel, state.attempted);
      if (!node) break; // tier exhausted -> fallback to next tier
      const outcome = await attemptNode({
        request, env, ctx, logger, requestId, route, node, requestedModel,
        clientWantsStream, fakeStream, bodyJson, anthropicConversion, responsesConversion,
        limits, exposeUpstreamInfo, state, failoverBudgetMs, requestStartMs,
      });
      if (outcome.response) return outcome.response;
      if (outcome.stop) break;
    }
  }

  return buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers, exposeUpstreamInfo);
}

// ---- One attempt against one node -----------------------------------------

async function attemptNode(c) {
  const {
    request, env, logger, requestId, route, node, requestedModel, clientWantsStream,
    fakeStream, bodyJson, anthropicConversion, responsesConversion, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs,
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;

  const upstreamModel = node.models[requestedModel] || requestedModel;
  let outboundBody;
  if (route === 'openai_chat') {
    outboundBody = JSON.stringify({ ...bodyJson, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) });
  } else if (route === 'openai_responses') {
    outboundBody = JSON.stringify({ ...responsesConversion, model: upstreamModel });
  } else {
    outboundBody = JSON.stringify({ ...anthropicConversion, model: upstreamModel });
  }

  let targetUrl;
  try {
    targetUrl = buildTargetUrl(node.baseUrl, '/v1/chat/completions');
  } catch {
    return rotateWithNeutralEnd(state, node, 'invalid_base_url');
  }

  // ---- Optional GLOBAL quota coordination --------------------------------
  // isolate-local RPM/concurrency state can only shape traffic per Worker
  // isolate; several isolates share the same upstream key. When the operator
  // binds a Workers Rate Limiting binding as QUOTA_RATE_LIMITER, hard-RPM nodes
  // get a real cluster-wide check before dispatch. Without the binding this is
  // a no-op and the local hard/soft semantics apply.
  if (node.limits.rpmMode === 'hard' && typeof env?.QUOTA_RATE_LIMITER?.limit === 'function') {
    try {
      const verdict = await env.QUOTA_RATE_LIMITER.limit({ key: node.id });
      if (verdict && verdict.success === false) {
        // Globally rate-limited: not the node's fault — no failure/cooldown,
        // just move on to the next candidate.
        state.attempted.add(node.id);
        state.totalAttempts++;
        recordNeutralEnd(node.id);
        noteFailure(state, 'rate_limit_global');
        state.logger.info(`attempt ${state.totalAttempts}/${state.maxAttempts} node=${node.id} kind=rate_limit_global status=429`);
        state.attempts.push({ attempt: state.totalAttempts, node_id: node.id, status: 429, kind: 'rate_limit_global' });
        return { rotate: true };
      }
    } catch {
      // A broken coordinator must never take the gateway down: proceed and let
      // the local limits + circuit breaker do their job.
    }
  }

  const headers = buildUpstreamHeaders(request, node.credential, requestId);
  const controller = new AbortController();
  let headersTimeoutHit = false;
  // Cap this attempt's own wait by the remaining whole-request budget so the
  // worst case is bounded: a single attempt never burns the entire budget AND
  // never lets the total exceed FAILOVER_BUDGET_MS by more than one attempt.
  const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
  const attemptHeadersTimeout = Math.min(limits.headersTimeoutMs, Math.max(1, remainingBudgetMs));
  const timeoutId = setTimeout(() => {
    headersTimeoutHit = true;
    controller.abort();
  }, attemptHeadersTimeout);
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
      return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, upstream.status, errorText, state, exposeUpstreamInfo) };
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
  const { request, env, logger, requestId, route, node, requestedModel, bodyJson, clientWantsStream, fakeStream, limits, exposeUpstreamInfo, state } = c;
  const elapsedSinceStart = () => Date.now() - s.attemptStartMs;

  // Topology-leak policy (P1): by default a successful client response carries
  // only x-request-id. Node id / tier are operational details exposed only when
  // EXPOSE_UPSTREAM_INFO=true (debugging) or via the auth-protected /health.
  const extraHeaders = {
    'x-request-id': requestId,
    ...(exposeUpstreamInfo ? { 'x-gateway-node': node.id, 'x-gateway-tier': node.tier } : {}),
  };

  const needsModelRewrite = requestedModel !== upstreamModelOf(node, requestedModel);

  // Streaming passthrough / transformed streams: run the first-event guard
  // BEFORE returning anything to the client.
  if (clientWantsStream && upstreamWasStreaming) {
    let guarded;
    try {
      const remainingBudgetMs = (c.failoverBudgetMs ?? limits.failoverBudgetMs) - (Date.now() - (c.requestStartMs || s.attemptStartMs));
      const firstEventTimeout = Math.min(limits.firstEventTimeoutMs, Math.max(1, remainingBudgetMs));
      guarded = await ensureFirstSseEvent(upstream, firstEventTimeout, request.signal);
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
      const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
        // Model rewrite happens INSIDE the tracked stream; wrapping yet another
        // pull-based stream layer here stalls final chunks (see track.js).
        ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
        onSuccess: () => recordSuccess(node.id, latencyMs),
        onFailure: () => recordFailure(node.id, { counted: true, cooldownMs: 2_000, reason: 'stream_interrupted' }),
        onNeutral: () => recordNeutralEnd(node.id),
      });
      return { response: tracked };
    }

    if (route === 'openai_responses') {
      const transformed = transformOpenAIStreamToResponses(guarded, requestedModel, bodyJson, requestId, request.signal);
      const tracked = trackStreamResponse(transformed, {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
        onSuccess: () => recordSuccess(node.id, latencyMs),
        onFailure: () => recordFailure(node.id, { counted: true, cooldownMs: 2_000, reason: 'stream_interrupted' }),
        onNeutral: () => recordNeutralEnd(node.id),
      });
      return { response: new Response(tracked.body, { status: 200, headers }) };
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

  // ---- OpenAI Responses (non-stream) ----
  if (route === 'openai_responses') {
    try {
      let data;
      if (upstreamWasStreaming) {
        data = await collectOpenAIStreamObject(upstream, request.signal);
      } else {
        data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024));
      }
      if (data && typeof data === 'object' && data.error) {
        const status = Number(data.error.status) >= 400 && Number(data.error.status) < 600
          ? Math.trunc(Number(data.error.status))
          : 502;
        const classification = classifyUpstreamStatus(status, upstream.headers, env);
        recordOutcome(state, node, classification, latencyMs, trimDiagnostic(data.error.message || 'embedded error', 200), exposeUpstreamInfo, status);
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true };
      }
      if (!clientWantsStream) {
        const responses = openAICompletionToResponses(data, requestedModel, bodyJson);
        recordSuccess(node.id, latencyMs);
        return { response: jsonResponse(200, responses, env, request, extraHeaders) };
      }
      // Stream requested but upstream returned a full object: synthesize a
      // well-formed Responses SSE stream in one body.
      recordSuccess(node.id, latencyMs);
      return { response: synthesizeResponsesFromCompletion(data, requestedModel, bodyJson, { ...extraHeaders, ...corsHeaders(request, env) }) };
    } catch (error) {
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), elapsedSinceStart());
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      recordOutcome(state, node, classifyFirstEventFailure(), latencyMs, error.message, exposeUpstreamInfo);
      return { rotate: true };
    }
  }

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
          ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
          ...trackCallbacks,
        },
      );
      return { response: tracked };
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
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, text, state, exposeUpstreamInfo) };
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
  noteFailure(state, reason);
  state.logger.info(`attempt ${state.totalAttempts}/${state.maxAttempts} node=${node.id} kind=${reason} status=0`);
  state.attempts.push({ attempt: state.totalAttempts, node_id: node.id, status: 0, kind: reason });
  return { rotate: true };
}

// Aggregate failure-kind counter for the exhausted response. Kinds alone (no
// node ids / no ordering) are safe to expose to clients by default and answer
// the only question that matters when everything failed: HOW did it fail?
function noteFailure(state, kind) {
  state.failureKinds[kind] = (state.failureKinds[kind] || 0) + 1;
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

  noteFailure(state, classification.kind);
  state.logger.info(
    `attempt ${state.totalAttempts}/${state.maxAttempts} node=${node.id} kind=${classification.kind}`
    + ` status=${status} counted=${classification.counted} latency=${latencyMs ?? -1}ms`
    + `${diagnostic && exposeUpstreamInfo ? ` detail=${trimDiagnostic(diagnostic, 200)}` : ''}`,
  );

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
