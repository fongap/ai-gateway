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
import { pickCandidate, supportsModel, tierHasDispatchableNode } from '../scheduler/scheduler.js';
import {
  recordSuccess, recordFailure, recordNeutralEnd, rollbackRpmBucket, recordModelMissing,
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
import { validateOpenAIChatRequest, isOpenAIStreamingResponse, synthesizeSseFromCompletion, extractOpenAITextContent, withUsageStreamOptions } from '../protocol/openai.js';
// Backward-compatible re-export: some tooling imports the synthesizer from here.
export { synthesizeSseFromCompletion };
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
import { recordStreamStart, recordStreamCompleted, recordStreamInterrupted } from '../observability/stats.js';
import { recordTokenUsage } from '../observability/tokens.js';
import { persistTokenUsage } from '../observability/token-store.js';
import { streamUsageSupported } from '../config/profiles.js';
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

  const state = { attempted: new Set(), attempts: [], totalAttempts: 0, failureKinds: {}, logger, maxAttempts: policy.maxAttempts, requestedModel };

  // Per-tier attempt budgets, computed ONCE per request (dispatchability-aware):
  // a lower tier only receives budget when it can DISPATCH this model right now
  // (a ready candidate: not cooling, circuit-open, concurrency-saturated, or
  // hard-RPM exhausted). Deferred capacity — busy or temporarily over-quota
  // nodes that free up later — surfaces only in Retry-After / diagnostics and
  // earns NO budget. The loop below is strict tier precedence: a tier is
  // drained (its budget spent) before the next tier is entered.
  const tierCaps = computeTierCaps(tiers, requestedModel, state.attempted, policy);
  for (const tierNumber of TIER_ORDER) {
    const cap = tierCaps[tierNumber] ?? 0;
    let usedInTier = 0;
    while (usedInTier < cap && state.totalAttempts < policy.maxAttempts) {
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
      // A pre-dispatch outcome that never reached an upstream (distributed
      // rate-limiter deny, invalid base URL) carries budgetCharged:false and
      // consumes NOTHING: neither totalAttempts nor this tier's attempt slot —
      // charging the slot instead would let denied-but-untried keys starve
      // same-tier healthy candidates and every fallback tier. budgetCharged is
      // always defined on an outcome, so there is no implicit default being
      // matched here. Termination is unaffected: such nodes land in
      // state.attempted and pickCandidate skips them, so the candidate set
      // itself bounds the loop rather than the budgets.
      if (outcome.budgetCharged) usedInTier++;
      if (outcome.response) return outcome.response;
      if (outcome.stop) break;
    }
  }

  return buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers, exposeUpstreamInfo);
}

// Per-tier attempt budget: { tier1, tier2, tier3 } -> max attempts each.
//   * Two capacity notions are kept strictly apart. DISPATCHABLE means a
//     candidate this tier could truly launch right now (supports the model,
//     circuit/model cooldown clear, under concurrency, not hard-RPM exhausted);
//     DEFERRED means capacity exists but cannot serve yet (saturated /
//     over-quota). Deferred capacity feeds only Retry-After and diagnostic
//     classification (see tierHasDeferredCapacity in scheduler.js) — it earns
//     NO budget, otherwise an attempt slot gets reserved for a tier that will
//     refuse dispatch while the current tier may still have immediately usable
//     candidates left to spend that slot on.
//   * A tier with no dispatchable candidate for `requestedModel` gets 0 budget.
//   * By default `max_attempts` is split so every dispatchable tier gets at
//     least one attempt and the surplus goes to the highest (most-preferred)
//     dispatchable tier — maximizing free/priority resource use while keeping
//     the paid fallback reachable and never starving an intermediate tier.
//   * `policy.tierAttempts` (POLICIES_CONFIG tier_attempts) overrides a tier's
//     budget explicitly (0 disables it).
// Budget is a per-tier UPPER bound; the shared state.maxAttempts still caps the
// request's total upstream attempts, and FAILOVER_BUDGET_MS caps wall-clock.
function computeTierCaps(tiers, requestedModel, attempted, policy) {
  const now = Date.now();
  const caps = {};
  for (const t of TIER_ORDER) caps[t] = 0;
  const dispatchable = TIER_ORDER.filter((t) =>
    tierHasDispatchableNode(tiers[t], requestedModel, attempted, now));
  if (dispatchable.length === 0) return caps;
  const max = policy.maxAttempts;
  const surplus = Math.max(0, max - dispatchable.length);
  dispatchable.forEach((t, i) => {
    // `t` is numeric (1/2/3); POLICIES_CONFIG tier_attempts uses string keys
    // ('tier1'/'tier2'/'tier3').
    caps[t] = policy.tierAttempts?.[`tier${t}`] ?? (i === 0 ? 1 + surplus : 1);
  });
  return caps;
}

// ---- One attempt against one node -----------------------------------------

// Wrapper around dispatchAttempt. Every path inside either contacted (or tried
// to contact) an upstream — charging failover budget by default — or opted out
// explicitly on a pre-dispatch path. Normalizing here guarantees every outcome
// carries a defined `budgetCharged`, so the main loop never has to infer
// charging from a failure-kind string.
async function attemptNode(c) {
  const outcome = await dispatchAttempt(c);
  if (outcome.budgetCharged === undefined) outcome.budgetCharged = true;
  return outcome;
}

async function dispatchAttempt(c) {
  const {
    request, env, logger, requestId, route, node, requestedModel, clientWantsStream,
    fakeStream, bodyJson, anthropicConversion, responsesConversion, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs,
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;

  const upstreamModel = node.models[requestedModel] || requestedModel;
  let outboundObject;
  if (route === 'openai_chat') {
    outboundObject = { ...bodyJson, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else if (route === 'openai_responses') {
    outboundObject = { ...responsesConversion, model: upstreamModel };
  } else {
    outboundObject = { ...anthropicConversion, model: upstreamModel };
  }
  // Ask the upstream to report usage in the final streaming chunk. This is a
  // passive protocol hint (include_usage) that changes nothing the client sees
  // and is gated by the node's profile capability + operator switches, so an
  // upstream that rejects the field can be opted out per provider. Non-stream
  // requests already carry usage in the body and are never touched here.
  if (outboundObject.stream === true && streamUsageSupported(node, env)) {
    outboundObject = withUsageStreamOptions(outboundObject);
  }
  const outboundBody = JSON.stringify(outboundObject);

  let targetUrl;
  try {
    targetUrl = buildTargetUrl(node.baseUrl, '/v1/chat/completions');
  } catch {
    return rotateWithNeutralEnd(state, node, 'invalid_base_url', { preDispatch: true });
  }

  // ---- Optional distributed rate shaping (Cloudflare Rate Limiting) ---------
  // isolate-local RPM/concurrency state can only shape traffic per Worker
  // isolate; several isolates share the same upstream key. Binding a Workers
  // Rate Limiting binding as QUOTA_RATE_LIMITER adds a distributed (per-Cloudflare
  // location) fixed-window check before dispatch. NOTE: Cloudflare Rate Limiting
  // is counted per location, permissive and eventually consistent — it is NOT a
  // strict global/account quota, and its threshold is fixed at the binding
  // (limit=N, period=60), so it cannot express a different per-node
  // limits.rpm value. Treat it as approximate distributed shaping; the local
  // hard/soft semantics remain the source of truth for exact per-node counts.
  if (node.limits.rpmMode === 'hard' && typeof env?.QUOTA_RATE_LIMITER?.limit === 'function') {
    try {
      const verdict = await env.QUOTA_RATE_LIMITER.limit({ key: node.id });
      if (verdict && verdict.success === false) {
        // Distributed-limit denied: the request never reached an upstream, so
        // it must NOT consume any failover budget — neither the shared attempt
        // budget (maxAttempts) nor this tier's own attempt slot — otherwise a
        // run of CF-denied keys starves same-tier healthy candidates and every
        // fallback tier without ever contacting a provider. It also must not
        // charge the node's local RPM: release the slot AND roll back the RPM
        // reservation acquireSlot just made. Mark the node attempted so it is
        // not re-picked this request; the tier drains via `attempted` rather
        // than the budgets.
        state.attempted.add(node.id);
        recordNeutralEnd(node.id);
        rollbackRpmBucket(node.id);
        noteFailure(state, 'rate_limit_global');
        state.logger.info(`attempt ${state.totalAttempts}/${state.maxAttempts} node=${node.id} kind=rate_limit_global status=429 (pre-dispatch, no budget charged)`);
        state.attempts.push({ attempt: state.totalAttempts, node_id: node.id, status: 429, kind: 'rate_limit_global' });
        return { rotate: true, budgetCharged: false };
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
    const errorText = await safeReadErrorBody(upstream, DIAGNOSTIC_BYTES);
    const classification = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
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

// Anthropic first-event guard predicate: only text / reasoning / tool_call
// count as real model output. A role-only, empty-delta, usage-only or
// empty-choices chunk is NOT a commit point — the guard keeps consuming until
// real output appears, so a node that streams a non-output event before dying
// can still fail over. Mirrors the transform's own notion of a content event.
function isAnthropicRealOutput(json) {
  const choice = json?.choices?.[0];
  if (!choice) return false;
  const delta = choice.delta || {};
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string' && reasoning) return true;
  if (extractOpenAITextContent(delta.content)) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  if (delta.function_call) return true;
  return false;
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
      // Anthropic requires real model output (text / reasoning / tool_call)
      // before the failover boundary commits: a role-only, empty-delta,
      // usage-only or empty-choices event is NOT a commit point. OpenAI Chat /
      // Responses keep the original "any parseable non-error event commits".
      const isRealOutput = route === 'anthropic_messages' ? isAnthropicRealOutput : undefined;
      guarded = await ensureFirstSseEvent(upstream, firstEventTimeout, request.signal, isRealOutput);
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
        // Chat passthrough never parses chunks for protocol purposes, so this
        // is the one streaming path whose usage is captured by track.js's
        // passive scan. Transformed routes below report usage from the
        // transform's parse point instead (onUsage NOT passed here), keeping
        // exactly one capture per stream.
        onUsage: (u) => recordTokens(c, node, u),
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: tracked };
    }

    if (route === 'openai_responses') {
      const transformed = transformOpenAIStreamToResponses(guarded, requestedModel, bodyJson, requestId, request.signal, { onUsage: (u) => recordTokens(c, node, u) });
      const tracked = trackStreamResponse(transformed, {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: new Response(tracked.body, { status: 200, headers }) };
    }

    // anthropic_messages: transform then track the CLIENT-facing stream so an
    // interrupted transform records against the node exactly once.
    const transformed = transformOpenAIStreamToAnthropic(guarded, requestedModel, requestId, request.signal, { onUsage: (u) => recordTokens(c, node, u) });
    const tracked = trackStreamResponse(transformed, {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      // A stream that never reaches message_stop (truncated / errored mid-way)
      // must NOT be recorded as a node success.
      completionMarker: /event:\s*message_stop\b/,
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: new Response(tracked.body, { status: 200, headers }) };
  }
  detach();

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
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
        recordOutcome(state, node, classification, latencyMs, trimDiagnostic(data.error.message || 'embedded error', 200), exposeUpstreamInfo, status);
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true };
      }
      // Single usage capture point for BOTH delivered forms below (plain JSON
      // and the synthesized Responses SSE) — the transform never runs here.
      recordTokens(c, node, data?.usage);
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
        // Assembled-from-stream usage (fake-stream protection and the
        // upstream-stream / client-non-stream case): the collect helper
        // already carries the final usage chunk — record it here, exactly
        // once, instead of inside the passthrough scan.
        recordTokens(c, node, data?.usage);
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
          // Defensive consistency with the streaming passthrough above (this
          // branch is mutually exclusive with the assemble path below, so the
          // scan can never double-count against a recordTokens call).
          onUsage: (u) => recordTokens(c, node, u),
          ...makeNodeStreamTrack(c, node, latencyMs),
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
      const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
      recordOutcome(state, node, classification, latencyMs, trimDiagnostic(data.error.message || 'embedded error', 200), exposeUpstreamInfo, status);
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, text, state, exposeUpstreamInfo) };
      }
      return { rotate: true };
    }
    // Single usage capture point for BOTH delivered forms below (plain JSON
    // and the synthesized chat SSE) — nothing else parses this body.
    recordTokens(c, node, data?.usage);
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
    // Single usage capture point: this branch serves both the plain JSON body
    // and the upstream-stream-assembled object, for streaming and non-stream
    // clients alike.
    recordTokens(c, node, data?.usage);
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

// Token observability: called EXACTLY ONCE per delivered response — from the
// non-stream parse points, or via the onUsage callback of the one stream
// wrapper / transform that actually parsed the body. Rotating attempts never
// reach here, so failover still yields a single record.
//
// It does TWO independent things:
//   1. recordTokenUsage()     — isolate-local, best-effort (resets on restart).
//   2. persistTokenUsage()    — cross-isolate D1 hour-bucket UPSERT, fired
//      inside ctx.waitUntil() so it is OFF the request hot path. It is fully
//      fail-open: D1 absence, errors, timeouts and rejects are swallowed here
//      and never change the HTTP response, fallback, node health, circuit
//      breaker, scheduler, concurrency count or stream completion.
function recordTokens(c, node, usage) {
  recordTokenUsage({ model: c.requestedModel, tier: node.tier, provider: node.provider, nodeId: node.id, usage });
  scheduleD1TokenPersist(c, usage);
}

// Fire the D1 persistence WITHOUT touching the request path. Wrapped so that:
//   * no binding  -> no-op (the primary "delete TOKEN_STATS_DB and it still
//     serves every model" invariant);
//   * ctx.waitUntil is the ONLY mechanism used — never `await` before a
//     response, never a synchronous D1 call;
//   * every rejection is caught and logged at most once.
function scheduleD1TokenPersist(c, usage) {
  const task = persistTokenUsage(c.env, usage).catch((err) => {
    try { c.logger?.error?.(`token-stats D1 persist failed: ${err?.message || err}`); } catch { /* never throw */ }
  });
  const ctx = c.ctx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch { task.catch(() => {}); }
  } else {
    // No ExecutionContext (unit tests): fire-and-forget with a swallow.
    task.catch(() => {});
  }
}

// Node-layer stream tracking: node outcome recording + stream-end telemetry.
// The client-facing layer (stats.js trackClientResponse) never passes the
// telemetry callbacks, so stream counters count each stream exactly once.
function makeNodeStreamTrack(c, node, latencyMs) {
  return {
    onSuccess: () => recordSuccess(node.id, latencyMs),
    // Field evidence (NVIDIA-hosted stalls mid-generation): 2s let a stalling
    // node straight back into rotation. 60s matches the rate-limit cooldown —
    // long enough to push repeat offenders out of candidate ordering without
    // permanently discarding a node that had one transient blip.
    onFailure: () => recordFailure(node.id, { counted: true, cooldownMs: 60_000, reason: 'stream_interrupted' }),
    onNeutral: () => recordNeutralEnd(node.id),
    onStreamStart: () => recordStreamStart(),
    onStreamEnd: (outcome, d) => {
      if (outcome === 'completed') { recordStreamCompleted(); return; }
      if (outcome !== 'interrupted') return; // neutral (client abort) is not counted
      recordStreamInterrupted(d.reason);
      applyHealthPenalty(node.id, 'stream');
      c.logger.info(
        `[stream-interrupted] node=${node.id} provider=${node.provider}`
        + ` model=${c.requestedModel}->${upstreamModelOf(node, c.requestedModel)}`
        + ` reason=${d.reason} duration_ms=${d.durationMs} chunks=${d.chunkCount}`
        + ` received_bytes=${d.receivedBytes} completion_marker=${d.completionMarkerSeen}`,
      );
    },
  };
}

function upstreamModelOf(node, logicalModel) {
  return node.models[logicalModel] || logicalModel;
}

function rotateWithNeutralEnd(state, node, reason, { preDispatch = false } = {}) {
  state.attempted.add(node.id);
  // Pre-dispatch neutrals (invalid base URL) never reached an upstream, so they
  // do not consume the shared attempt budget — no totalAttempts++, and the
  // outcome reports budgetCharged:false exactly like the rate-limiter deny.
  if (!preDispatch) state.totalAttempts++;
  recordNeutralEnd(node.id);
  // Pre-dispatch neutrals also never touched the network, so the RPM reservation
  // acquireSlot made must be returned to the bucket — otherwise a structurally
  // broken node silently burns its own per-minute RPM quota on traffic it never
  // sent. Post-dispatch neutrals (200-with-non-json) keep the charge: the
  // upstream WAS contacted.
  if (preDispatch) rollbackRpmBucket(node.id);
  noteFailure(state, reason);
  state.logger.info(`attempt ${state.totalAttempts}/${state.maxAttempts} node=${node.id} kind=${reason} status=0`);
  state.attempts.push({ attempt: state.totalAttempts, node_id: node.id, status: 0, kind: reason });
  return preDispatch ? { rotate: true, budgetCharged: false } : { rotate: true };
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

  if (classification.modelScoped) {
    // A 404 "model not found" is a (node, model) mapping mismatch, not a node
    // health issue: cool the PAIR only, leave the node healthy for its other
    // models, do not penalize health, do not feed the circuit.
    recordModelMissing(node.id, state.requestedModel, classification.cooldownMs || 0);
  } else if (classification.action === 'neutral') {
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
