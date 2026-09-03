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
import { getLimits, attemptHeadersTimeoutMs, attemptFirstEventTimeoutMs, attemptBudgetSliceMs } from '../config/timeouts.js';
import { pickCandidate, supportsRequest, tierHasDispatchableNode, countDispatchableNodes } from '../scheduler/scheduler.js';
import { pickTier1Candidate, tier1DeadlineTooSmall } from '../scheduler/tier1-scheduler.js';
import {
  resolveTier1SessionId, readTier1Affinity, writeTier1Affinity,
  shouldEvaluateAffinity, recordTier1AffinityDecision,
} from '../scheduler/tier1-affinity.js';
import {
  recordSuccess, recordFailure, recordNeutralEnd, rollbackRpmBucket, recordModelMissing,
  applyHealthPenalty, recordTtft, bumpNodeCounters, markProbeFailure,
} from '../reliability/node-state.js';
import {
  releaseTier1Slot,
  recordTier1Ttft, recordTier1Success, applyTier1Outcome, classifyTier1Failure,
  tier1CountDispatchableNodes, tier1HasDispatchableNode, rollbackTier1Rpm,
  TIER1_MAX_ATTEMPTS,
} from '../reliability/tier1-state.js';
import {
  classifyUpstreamStatus, classifyNetworkError, classifyFirstEventFailure,
  classifyClientAbort,
} from '../reliability/classify.js';
import {
  buildTargetUrl, corsHeaders,
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
import {
  validateOpenAIResponsesRequest,
  collectResponsesObject, synthesizeResponsesFromObject,
} from '../protocol/responses/index.js';
import {
  resolveUpstreamPath, buildUpstreamHeadersFor,
  isAnthropicNativeRealOutput, isResponsesRealOutput, isOpenAIChatRealOutput,
  isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful,
  isAnthropicMessageMeaningful,
} from '../transport/index.js';
import {
  collectAnthropicMessageObject, synthesizeAnthropicFromMessage,
} from '../stream/anthropic-native.js';
import { ensureFirstSseEvent, GUARD_ERROR, guardedStreamFailureReason } from '../stream/guard.js';
import { collectOpenAIStreamObject } from '../stream/assemble.js';
import { trackStreamResponse } from '../stream/track.js';
import { getLogger } from '../observability/logger.js';
import { healthResponse, metricsResponse, modelsListResponse, versionResponse } from '../observability/diagnostic-endpoints.mjs';
import { recordStreamStart, recordStreamCompleted, recordStreamInterrupted } from '../observability/gateway-stats.mjs';
import { recordTokenUsage } from '../observability/token-usage.mjs';
import { persistTokenUsage } from '../observability/token-usage-store.mjs';
import { streamUsageSupported } from '../config/provider-quirks.js';
import { dashboardResponse } from '../dashboard/pages.js';
import { authorize } from './auth.js';
import { loadAccessKeysConfig, collectConfiguredModels } from '../config/access-keys.js';
import { authorizeModel, filterVisibleModels } from './model-authz.js';
import { gatewayError, buildBudgetExhaustedResponse, buildExhaustedResponse, buildClientErrorResponse } from './errors.js';
import { TIER_ORDER, normalizePath, detectRoute, acceptsHtml } from './router.js';
import { finalHeaders, jsonResponse, streamInterruptionChunk, upstreamModelOf } from './response-helpers.js';
import { convertAnthropicToOpenAIRequest, ConversionError } from '../conversion/anthropic-to-openai.js';
import { convertOpenAIToAnthropicResponse, convertOpenAIUsageToAnthropic } from '../conversion/openai-to-anthropic.js';
import { createAnthropicStreamFromOpenAI } from '../conversion/stream-converter.js';
import { loadProtocolFallbacks, getProtocolFallbacksDiagnostics, getFallbackChain } from '../config/protocol-fallbacks.js';

const DIAGNOSTIC_BYTES = 4096;

// Client surface -> (protocol, surface). The scheduler filters candidate
// nodes through BOTH dimensions plus the model, so an OpenAI request can
// never land on an Anthropic node and a chat-only node never receives a
// /v1/responses request. Cross-protocol failover is opt-in via
// PROTOCOL_FALLBACKS: when the native pool is exhausted the request is
// converted to a fallback protocol+surface and re-runs through the same
// scheduler. The native triple filter still holds on each individual attempt
// — a hedge twin is never cross-protocol.
const ROUTE_PROTOCOL_SURFACE = Object.freeze({
  openai_chat: { protocol: 'openai', surface: 'chat_completions' },
  openai_responses: { protocol: 'openai', surface: 'responses' },
  anthropic_messages: { protocol: 'anthropic', surface: 'messages' },
});

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

  // ---- Authorization (grouped multi-key or legacy single key, fail closed) ----
  // Misconfiguration is checked via loadAccessKeysConfig (the single source of
  // truth for which key(s) exist): no configured key means nothing can be served.
  const accessConfig = route !== 'version' ? loadAccessKeysConfig(env) : { keys: [], anyNewKey: false };
  const hasAnyKey = accessConfig.keys.length > 0;
  if (!hasAnyKey && route !== 'version') {
    return gatewayError(request, env, route, 500,
      'Gateway misconfigured: no GATEWAY_ACCESS_KEY_<GROUP> (or legacy GATEWAY_ACCESS_KEY) is set.', requestId);
  }
  const authResult = route !== 'version' ? await authorize(request, env) : { authorized: true, mode: 'skip', group: null };
  if (route !== 'version' && !authResult.authorized) {
    return gatewayError(request, env, route, 401, 'Unauthorized: gateway access key is invalid or missing.', requestId);
  }
  // Log only the low-cardinality, non-secret group. Never log the raw key,
  // prefix, Authorization header, or any digest.
  if (authResult.group) {
    logger.info('request authorized', { key_group: authResult.group, request_id: requestId });
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

  // ---- Model authorization (fail closed, BEFORE the scheduler) ----
  // A key without permission for this model gets a stable 403, never a
  // misleading "all nodes failed" or a 404 that enumerates internal topology.
  // This must not leak whether an internal model exists: an allowlist-only key
  // gets 403 for anything outside its allowlist, and 404 only when the model
  // is allowlisted but not configured.
  // `configuredModels` is the union of all node `models` keys — the single
  // source of model existence (see config/access-keys.js). It is computed
  // before the scheduler so authorization never depends on routing health.
  const gatewayConfigForAuth = loadGatewayConfig(env);
  const configuredModels = collectConfiguredModels(gatewayConfigForAuth.nodes);
  const modelAuthz = authorizeModel(requestedModel, configuredModels, authResult);
  if (!modelAuthz.allowed) {
    return gatewayError(request, env, route, modelAuthz.status, modelAuthz.status === 403
      ? 'Forbidden: the provided key is not permitted to use this model.'
      : 'Model not found for this key.', requestId);
  }

  // ---- Candidate pool ----
  const config = loadGatewayConfig(env);
  // `ready` is the single serve/don't-serve gate: it is true only for the
  // ready/degraded statuses. A structurally INVALID config (duplicate ids,
  // conflicting shards) refuses service even if some nodes parsed — otherwise
  // /health would say 503 while traffic kept flowing.
  if (!config.ready) {
    return gatewayError(request, env, route, 500,
      'Gateway misconfigured: no usable node configuration. Check TIER*_NODES_CONFIG_* and TIER*_NODES_SECRETS_*.',
      requestId,
      { configuration_status: config.status, ...(exposeUpstreamInfo ? { diagnostics: config.diagnostics.slice(0, 5) } : {}) });
  }
  const tiers = config.tiers;
  const reqDescriptor = { model: requestedModel, ...ROUTE_PROTOCOL_SURFACE[route] };
  const supported = TIER_ORDER.some((t) => tiers[t].some((n) => supportsRequest(n, reqDescriptor)));
  if (!supported) {
    const fallbacks = getFallbackChain(route, env);
    if (fallbacks.length === 0 || !fallbacks.some((fb) =>
      TIER_ORDER.some((t) => tiers[t].some((n) => supportsRequest(n, { model: requestedModel, ...fb }))))) {
      return gatewayError(request, env, route, 404,
        `No configured node provides model "${requestedModel}" via protocol "${reqDescriptor.protocol}" surface "${reqDescriptor.surface}". Verify the models mapping.`, requestId);
    }
  }

  const policy = getPolicy(requestedModel, loadModelsConfig(env), loadPoliciesConfig(env));

  // Three SEPARATE counters, never one overloaded total:
  //   logicalAttempts — max_attempts budget; a primary + its optional hedge
  //                     twin together are ONE logical attempt;
  //   dispatches      — real upstream requests (pre-dispatch denies excluded);
  //   hedges          — hedge twins launched. Hard-capped by
  //                     MAX_HEDGES_PER_REQUEST; worst case
  //                     maxDispatches = maxAttempts + maxHedgesPerRequest.
  const state = {
    attempted: new Set(), attempts: [], logicalAttempts: 0, dispatches: 0, hedges: 0,
    failureKinds: {}, logger, requestId, maxAttempts: policy.maxAttempts,
    maxDispatches: policy.maxAttempts + limits.maxHedgesPerRequest,
    requestedModel,
    nodes: config.nodes,
  };

  // Tier 1 session affinity is a SOFT bias, read once before the loop. A cold
  // session (no client-supplied id, or no KV binding) degrades to no bias.
  const tier1Session = resolveTier1SessionId(request);
  const tier1Affinity = tier1Session ? await readTier1Affinity(env, tier1Session) : null;
  const tier1EvaluateAffinity = shouldEvaluateAffinity(tier1Session);
  const tier1Rng = makeTier1Rng(env);

  const loopCtx = {
    request, env, ctx, logger, requestId, route, requestedModel,
    clientWantsStream, fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs, policy, tiers,
    tier1Affinity, tier1EvaluateAffinity, tier1Rng, tier1Session,
  };

  // Native tier loop: attempt every eligible node of the client's own
  // protocol+surface before any cross-protocol fallback.
  const nativeResult = await runTierLoop(loopCtx, reqDescriptor, null);
  if (nativeResult) return nativeResult;

  // Cross-protocol fallback: when the native pool is exhausted and a
  // fallback chain is configured for this route, convert the request to each
  // fallback protocol in order and re-run the tier loop. The loop shares the
  // SAME state (logicalAttempts, dispatches, hedges, failoverBudget,
  // requestStartMs) — no fresh budget. Hedge does not cross protocols (the
  // scheduler's protocol+surface filter already excludes foreign nodes).
  const fallbacks = getFallbackChain(route, env);
  for (const fb of fallbacks) {
    if (state.logicalAttempts >= policy.maxAttempts) break;
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    if (remainingBudgetMs <= 0) {
      return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
    }
    const fbReqDescriptor = { model: requestedModel, protocol: fb.protocol, surface: fb.surface };
    const fbSupported = TIER_ORDER.some((t) =>
      tiers[t].some((n) => supportsRequest(n, fbReqDescriptor)));
    if (!fbSupported) continue;
    let convertedBody;
    try {
      if (route === 'anthropic_messages' && fb.protocol === 'openai' && fb.surface === 'chat_completions') {
        convertedBody = convertAnthropicToOpenAIRequest(bodyJson);
      } else {
        continue;
      }
    } catch (e) {
      if (e instanceof ConversionError) {
        return anthropicErrorResponse(request, env, 400, e.code, requestId);
      }
      throw e;
    }
    const fbTierCaps = computeTierCaps(tiers, fbReqDescriptor, state.attempted, policy);
    const conversionContext = {
      convertedBody,
      fallbackProtocol: fb.protocol,
      fallbackSurface: fb.surface,
      clientRoute: route,
    };
    const fbResult = await runTierLoop(loopCtx, fbReqDescriptor, conversionContext, fbTierCaps);
    if (fbResult) return fbResult;
  }

  return buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers, exposeUpstreamInfo, reqDescriptor);
}

// Run the per-tier attempt loop for a given reqDescriptor. Returns a Response
// when the request was committed (success, budget exhausted, or client-side
// stop); returns null when all tiers are exhausted without a response so the
// caller can fall through to cross-protocol fallback or the exhausted handler.
// `conversionContext` is null for native dispatches; for cross-protocol
// fallback it carries the converted outbound body and protocol/surface info.
// `overrideTierCaps` lets the caller inject pre-computed caps (used by the
// fallback path which recomputes for the fallback protocol).
async function runTierLoop(loopCtx, reqDescriptor, conversionContext, overrideTierCaps) {
  const {
    request, env, ctx, logger, requestId, route, requestedModel,
    clientWantsStream, fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs, policy, tiers,
    tier1Affinity, tier1EvaluateAffinity, tier1Rng, tier1Session,
  } = loopCtx;
  const tierCaps = overrideTierCaps ?? computeTierCaps(tiers, reqDescriptor, state.attempted, policy);
  for (const tierNumber of TIER_ORDER) {
    const cap = tierCaps[tierNumber] ?? 0;
    let usedInTier = 0;
    while (usedInTier < cap && state.logicalAttempts < policy.maxAttempts) {
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }
      if (tierNumber === 1 && usedInTier > 0 && tier1DeadlineTooSmall(remainingBudgetMs)) {
        state.tier1ExhaustionReason = 'deadline_too_small';
        break;
      }
      const remainingDispatchableAttempts = countRemainingDispatchableAttempts(
        tiers, reqDescriptor, state.attempted, tierCaps,
        tierNumber, usedInTier, policy.maxAttempts - state.logicalAttempts,
      );
      const pick = pickForTier(tierNumber, tiers[tierNumber], reqDescriptor, state.attempted, {
        affinityAccountId: tierNumber === 1 ? tier1Affinity : null,
        evaluateAffinity: tierNumber === 1 && tier1EvaluateAffinity,
        rng: tier1Rng,
      });
      if (!pick || pick.raceLost) break;
      const node = pick.node;
      if (tierNumber === 1) {
        recordTier1AffinityDecision({
          affinityHit: pick.tier1AffinityHit,
          escaped: pick.tier1EscapedFromAffinity,
        });
      }
      const outcome = await dispatchWithHedge({
        request, env, ctx, logger, requestId, route, node, requestedModel,
        clientWantsStream, fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
        failoverBudgetMs, requestStartMs, reqDescriptor,
        remainingDispatchableAttempts, policy, tierNumber,
        tier1ReleaseToken: pick.tier1ReleaseToken || null,
        tier1EscapedFromAffinity: !!pick.tier1EscapedFromAffinity,
        tier1UpdateAffinity: !!pick.tier1UpdateAffinity,
        tier1AffinityAccountId: tier1Affinity,
        tier1EvaluateAffinity,
        tier1Session,
        rng: tier1Rng,
        conversionContext,
      }, tiers[tierNumber]);
      if (outcome.budgetCharged) usedInTier++;
      if (outcome.response) return outcome.response;
      if (outcome.stop) break;
    }
  }
  return null;
}

// Tier-aware picker. Tier 1 uses P2C + affinity + tier1-state eligibility;
// Tier 2/3 use the existing node-state pickCandidate unchanged. Returns
// { node, tier1ReleaseToken?, tier1EscapedFromAffinity? } or { raceLost } or null.
// An optional deterministic RNG (from TIER1_SCHEDULER_SEED) makes P2C sampling
// reproducible in tests without adding a production env knob — when the seed
// is absent (production), Math.random is used and behaviour stays random.
function pickForTier(tierNumber, tierNodes, req, attempted, opts = {}) {
  if (tierNumber !== 1) {
    const node = pickCandidate(tierNodes, req, attempted);
    return node ? { node } : null;
  }
  const r = pickTier1Candidate(tierNodes, req, attempted, opts);
  if (!r) return null;
  if (r.raceLost) return { raceLost: true };
  return {
    node: r.node,
    tier1ReleaseToken: r.releaseToken,
    tier1EscapedFromAffinity: r.escapedFromAffinity,
    tier1UpdateAffinity: r.updateAffinity,
    tier1AffinityHit: r.affinityHit,
  };
}

// Mulberry32 — a tiny deterministic PRNG for test reproducibility only. It is
// only wired in when env.TIER1_SCHEDULER_SEED is a non-empty string; production
// leaves it unset and P2C uses Math.random.
function makeTier1Rng(env) {
  const seedRaw = String(env?.TIER1_SCHEDULER_SEED ?? '').trim();
  if (!seedRaw) return Math.random;
  let h = 1779033703 ^ seedRaw.length;
  for (let i = 0; i < seedRaw.length; i++) {
    h = Math.imul(h ^ seedRaw.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
//   * A tier with no dispatchable candidate for the request descriptor gets 0
//     budget.
//   * By default `max_attempts` is split so every dispatchable tier gets at
//     least one attempt and the surplus goes to the highest (most-preferred)
//     dispatchable tier — maximizing free/priority resource use while keeping
//     the paid fallback reachable and never starving an intermediate tier.
//   * `policy.tierAttempts` (POLICIES_CONFIG tier_attempts) overrides a tier's
//     budget explicitly (0 disables it).
// Budget is a per-tier UPPER bound; the shared state.maxAttempts still caps the
// request's total upstream attempts, and FAILOVER_BUDGET_MS caps wall-clock.
function computeTierCaps(tiers, reqDescriptor, attempted, policy) {
  const now = Date.now();
  const caps = {};
  for (const t of TIER_ORDER) caps[t] = 0;
  const dispatchable = TIER_ORDER.filter((t) =>
    t === 1
      ? tier1HasDispatchableNode(tiers[t], reqDescriptor, attempted, now)
      : tierHasDispatchableNode(tiers[t], reqDescriptor, attempted, now));
  if (dispatchable.length === 0) return caps;
  const max = policy.maxAttempts;
  const surplus = Math.max(0, max - dispatchable.length);
  dispatchable.forEach((t, i) => {
    // `t` is numeric (1/2/3); POLICIES_CONFIG tier_attempts uses string keys
    // ('tier1'/'tier2'/'tier3').
    caps[t] = policy.tierAttempts?.[`tier${t}`] ?? (i === 0 ? 1 + surplus : 1);
    if (t === 1) caps[t] = Math.min(caps[t], TIER1_MAX_ATTEMPTS);
  });
  return caps;
}

// Number of upstream dispatches that can still happen in this request after
// applying live availability, per-tier caps, strict tier order, and the shared
// policy cap.  This is deliberately recomputed before every attempt because a
// pre-dispatch deny or a concurrent request can change the live candidate set.
function countRemainingDispatchableAttempts(tiers, reqDescriptor, attempted, tierCaps, currentTier, usedInTier, sharedRemaining) {
  const now = Date.now();
  let total = 0;
  let currentReached = false;
  for (const tierNumber of TIER_ORDER) {
    if (tierNumber === currentTier) currentReached = true;
    if (!currentReached) continue;
    const capRemaining = Math.max(0,
      (tierCaps[tierNumber] ?? 0) - (tierNumber === currentTier ? usedInTier : 0));
    if (capRemaining === 0) continue;
    const live = tierNumber === 1
      ? tier1CountDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now)
      : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now);
    total += Math.min(capRemaining, live);
  }
  return Math.max(1, Math.min(Math.max(1, sharedRemaining), total || 1));
}

// ---- One attempt against one node -----------------------------------------

// Wrapper around dispatchAttempt. Every path inside either contacted (or tried
// to contact) an upstream — charging failover budget by default — or opted out
// explicitly on a pre-dispatch path. Normalizing here guarantees every outcome
// carries a defined `budgetCharged`, so the main loop never has to infer
// charging from a failure-kind string. Successful dispatches get one debug
// line here (failures log their own dispatch line inside recordOutcome), so
// every upstream dispatch emits exactly one completion record.
async function attemptNode(c) {
  const outcome = await dispatchAttempt(c);
  if (outcome.budgetCharged === undefined) outcome.budgetCharged = true;
  if (outcome.response?.status === 200) {
    // Successful dispatches never pass through recordOutcome, so charge them
    // here — exactly once, like every failure/neutral path. A committed
    // response reached an upstream, so it always charges the dispatch count;
    // a hedge twin still never charges the logical attempt.
    c.state.dispatches++;
    if (!c.hedgedAttempt) c.state.logicalAttempts++;
    c.logger.debug(
      `dispatch request=${c.requestId} logical_attempt=${c.state.logicalAttempts}/${c.state.maxAttempts}`
      + ` dispatch=${c.state.dispatches} node=${c.node.id} provider=${c.node.provider}`
      + ` protocol=${c.upstreamProtocol ?? c.node.protocol} surface=${c.surface} tier=${c.node.tier}`
      + ` model=${c.requestedModel}->${upstreamModelOf(c.node, c.requestedModel)}`
      + ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=ok status=200`
      + ` headers_ms=${c.headersMs ?? -1}${c.ttftMs !== undefined ? ` ttft_ms=${c.ttftMs}` : ''}`
      + ` latency_ms=${c.attemptStartMs ? Date.now() - c.attemptStartMs : -1}`,
    );
  }
  return outcome;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Hedged dispatch (reactive per-try hedge, Envoy-style) -----------------
// A slow-but-alive node is the dominant tail-latency source: the scheduler
// cannot know a candidate will be slow, and once an attempt is awaiting its
// first event the sequential loop simply waits for it. If the first attempt
// has not committed a response within HEDGE_DELAY_MS, launch ONE twin attempt
// against the next-best candidate and let the two race. The first committed
// response wins; the twin is aborted and recorded as a NEUTRAL end (it was
// slow, not broken).
//
// Hedge vs. logical attempt: the twin is an EXTRA executioner of the SAME
// logical attempt, not an attempt of its own. It charges neither the
// max_attempts budget nor the tier cap; it is bounded instead by
// MAX_HEDGES_PER_REQUEST (default 1) and by the hard dispatch ceiling
// maxDispatches = maxAttempts + maxHedgesPerRequest. Both executioners share
// the logical attempt's wall-clock slice: the twin INHERITS the primary's
// absolute attempt deadline instead of being handed a fresh one. See The Tail
// at Scale (Dean & Barroso, 2013) for the underlying technique and its
// overload caveat.
async function dispatchWithHedge(args, tierNodes) {
  // Resolve effective hedge config: policy.hedge (per-model) overrides
  // the global env defaults. Tier 3 (paid) nodes NEVER hedge by default
  // — two paid requests in parallel is rarely worth the cost. To hedge
  // a paid tier, opt in via policy.hedge.tiers=['tier3'] or policy: 'stable'.
  const hedgePolicy = args.policy?.hedge ?? null;
  const tierKey = `tier${args.tierNumber}`;
  if (args.tierNumber === 3 && !(hedgePolicy && hedgePolicy.tiers && hedgePolicy.tiers.includes('tier3') && hedgePolicy.enabled !== false)) {
    return attemptNode(args);
  }
  let hedgeDelayMs, maxHedges;
  if (hedgePolicy) {
    if (hedgePolicy.enabled === false) return attemptNode(args);
    if (hedgePolicy.tiers && !hedgePolicy.tiers.includes(tierKey)) return attemptNode(args);
    hedgeDelayMs = hedgePolicy.delayMs ?? args.limits.hedgeDelayMs;
    maxHedges = args.limits.maxHedgesPerRequest ?? 1;
  } else {
    hedgeDelayMs = args.limits.hedgeDelayMs || 0;
    maxHedges = args.limits.maxHedgesPerRequest ?? 1;
  }
  if (hedgeDelayMs <= 0 || maxHedges <= 0) return attemptNode(args);

  // The primary holds its own args object so the twin can inherit the logical
  // attempt deadline it computes, and so its ttft measurement can feed the
  // winner log even when it wins after the twin was already launched.
  const primaryArgs = { ...args, hedgeAbort: new AbortController() };
  const primary = attemptNode(primaryArgs);
  const verdict = await Promise.race([
    primary.then(() => 'settled', () => 'settled'),
    sleepMs(hedgeDelayMs).then(() => 'hedge'),
  ]);
  if (verdict === 'settled') return primary;

  // Hedge gates: hard caps ONLY — never the logical-attempt budget or the tier
  // cap, which the twin deliberately does not consume. The in-flight primary
  // has not charged its dispatch yet, so the eventual dispatch count is
  // dispatches + 2 (primary charge + twin); the ceiling bounds the whole
  // request to maxAttempts + maxHedgesPerRequest upstream calls.
  if (args.state.hedges >= maxHedges) return primary;
  if (args.state.dispatches + 2 > args.state.maxDispatches) return primary;
  // Shared deadline FIRST, BEFORE any candidate is picked or claimed. The
  // selector below claims a concurrency slot + RPM reservation as a side
  // effect of picking (acquireSlot inside pickCandidate), so a deadline that
  // is already exhausted must bail out here — returning after the pick would
  // strand those reservations on a twin that is never dispatched (the node
  // then looks saturated, worst case at limits.concurrency=1). No remaining
  // time means no fresh budget can be conjured here; an undefined deadline
  // (primary still awaiting its rate-limiter check) is treated the same way.
  const deadlineRemainingMs = (primaryArgs.attemptDeadlineMs ?? 0) - Date.now();
  if (deadlineRemainingMs <= 0) return primary;
  // The twin is picked through the same protocol/surface/model-gated selector
  // as the primary, so a hedge twin is ALWAYS same-protocol and same-surface
  // as its primary — an anthropic node can never twin an openai request, and
  // a chat-only node can never twin a /v1/responses attempt. The pick claims
  // the twin's slot atomically (re-checked inside acquireSlot), and the
  // deadline gate above guarantees the claim is always followed by a real
  // dispatch or a legitimate loser lifecycle.
  const legacyTwin = args.tierNumber === 1
    ? null : pickCandidate(tierNodes, args.reqDescriptor, args.state.attempted, Date.now(), args.node.id);
  const twinPick = args.tierNumber === 1
    ? pickTier1Candidate(tierNodes, args.reqDescriptor, args.state.attempted, {
      excludeId: args.node.id,
      now: Date.now(),
      rng: args.rng ?? Math.random,
      affinityAccountId: args.tier1AffinityAccountId,
      evaluateAffinity: args.tier1EvaluateAffinity,
    })
    : legacyTwin ? { node: legacyTwin } : null;
  if (!twinPick || twinPick.raceLost) return primary;
  const twinNode = twinPick.node;

  args.state.hedges++;
  primaryArgs.hedgedWithTwin = true;
  const logicalAttemptNo = args.state.logicalAttempts + 1;
  args.logger.info(
    `hedge: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}`
    + ` primary=${args.node.id} twin=${twinNode.id} delay_ms=${hedgeDelayMs}`
    + ` deadline_remaining_ms=${deadlineRemainingMs}`,
  );

  // Both sides get an external abort handle up front so the loser can be
  // cancelled no matter which one wins the race.
  const twinArgs = {
    ...args, node: twinNode, hedgeAbort: new AbortController(), hedgedAttempt: true,
    // THE shared logical attempt deadline (absolute; not re-sliced).
    attemptDeadlineMs: primaryArgs.attemptDeadlineMs,
    tier1ReleaseToken: twinPick.releaseToken || null,
    tier1EscapedFromAffinity: !!twinPick.escapedFromAffinity,
    tier1UpdateAffinity: !!twinPick.updateAffinity,
  };
  const twin = attemptNode(twinArgs).then(undefined, (error) => {
    args.logger.debug(`hedge: twin ${twinNode.id} error ${error?.message || error}`);
    return { rotate: true, kind: 'unknown' };
  });
  const safePrimary = primary.then(undefined, (error) => {
    args.logger.debug(`hedge: primary ${args.node.id} error ${error?.message || error}`);
    return { rotate: true, kind: 'unknown' };
  });

  return new Promise((resolve) => {
    let resolved = false;
    let settled = 0;
    let firstFailure = null;
    let primaryOutcome = null;
    let twinOutcome = null;
    const win = (outcome, winnerArgs, loserAbort) => {
      if (resolved) {
        // Lost after the winner was chosen: drop any committed stream so no
        // upstream keeps streaming into the void.
        try { outcome.response?.body?.cancel(); } catch { /* already closed */ }
        return;
      }
      resolved = true;
      loserAbort?.abort();
      args.logger.info(
        `hedge winner: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}`
        + ` winner=${winnerArgs.node.id} loser=${(winnerArgs === primaryArgs ? twinNode : args.node).id}`
        + ` winner_ttft_ms=${winnerArgs.ttftMs ?? -1}`,
      );
      resolve(outcome);
    };
    const onSettled = (outcome, isPrimary, loserAbort) => {
      settled++;
      if (isPrimary) primaryOutcome = outcome; else twinOutcome = outcome;
      if (outcome.response) win(outcome, isPrimary ? primaryArgs : twinArgs, loserAbort);
      else {
        if (!firstFailure || isPrimary) firstFailure = outcome;
        // Only report a failed hedge when BOTH sides failed. If one side
        // already won (resolved), the loser's late neutral outcome arrives
        // here too — logging then would print a misleading "hedge failed"
        // line with kind=unknown for the successful winner.
        if (settled >= 2 && !resolved) {
          args.logger.info(
            `hedge failed: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}`
            + ` primary=${args.node.id} twin=${twinNode.id}`
            + ` primary_kind=${primaryOutcome?.kind || 'unknown'} twin_kind=${twinOutcome?.kind || 'unknown'}`,
          );
          resolve({ ...firstFailure });
        }
      }
    };
    safePrimary.then((o) => onSettled(o, true, twinArgs.hedgeAbort));
    twin.then((o) => onSettled(o, false, primaryArgs.hedgeAbort));
  });
}

async function dispatchAttempt(c) {
  const {
    request, env, logger, requestId, route, node, requestedModel, clientWantsStream,
    fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs, remainingDispatchableAttempts, reqDescriptor,
    policy, conversionContext,
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;
  // For cross-protocol fallback the upstream protocol/surface come from the
  // conversion context (the fallback target), NOT from the node's native
  // protocol. The transport must use the FALLBACK protocol so the right
  // upstream path, headers and stream semantics are used. The node's own
  // protocol stays correct for the native path.
  const upstreamProtocol = conversionContext ? conversionContext.fallbackProtocol : node.protocol;
  c.upstreamProtocol = upstreamProtocol;
  const surface = conversionContext ? conversionContext.fallbackSurface : reqDescriptor.surface;
  c.surface = surface;
  const sourceBody = conversionContext ? conversionContext.convertedBody : bodyJson;

  // Native outbound body: the client request is forwarded verbatim to the
  // upstream of the SAME protocol+surface, with only the model name
  // substituted. No cross-protocol or cross-surface conversion exists.
  // Cross-protocol fallback path uses the converted body built by the
  // conversionContext, with only the upstream model name rewritten.
  const upstreamModel = node.models[requestedModel] || requestedModel;
  let outboundObject;
  if (route === 'openai_chat' && !conversionContext) {
    outboundObject = { ...sourceBody, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else if (conversionContext && conversionContext.fallbackSurface === 'chat_completions') {
    outboundObject = { ...sourceBody, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else {
    // openai_responses -> native /v1/responses body
    // anthropic_messages -> native /v1/messages body
    // cross-protocol fallback to a non-chat surface (future use)
    outboundObject = { ...sourceBody, model: upstreamModel };
  }
  // Ask the OpenAI-chat upstream to report usage in the final streaming chunk.
  // This is a passive protocol hint (include_usage) that changes nothing the
  // client sees and is gated by provider quirks + operator switches, so an
  // upstream that rejects the field can be opted out per provider. The field
  // only exists on the OpenAI chat_completions wire format — native Responses
  // and Anthropic bodies are never touched. Non-stream requests already carry
  // usage in the body and are never touched here.
  if (surface === 'chat_completions' && outboundObject.stream === true && streamUsageSupported(node, env)) {
    outboundObject = withUsageStreamOptions(outboundObject);
  }
  const outboundBody = JSON.stringify(outboundObject);

  let targetUrl;
  try {
    targetUrl = buildTargetUrl(node.baseUrl, resolveUpstreamPath(upstreamProtocol, surface));
  } catch {
    return rotateWithNeutralEnd(state, node, 'invalid_base_url', c, true);
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
        if (node.tier === 'tier-1') {
          releaseTier1Slot(node.id, c.tier1ReleaseToken);
          rollbackTier1Rpm(node.id);
        } else {
          recordNeutralEnd(node.id);
          rollbackRpmBucket(node.id);
        }
        noteFailure(state, 'rate_limit_global');
        state.logger.info(
          `dispatch request=${requestId} logical_attempt=${state.logicalAttempts + 1}/${state.maxAttempts}`
          + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
          + ` protocol=${upstreamProtocol} surface=${surface} tier=${node.tier}`
          + ` model=${requestedModel}->${upstreamModelOf(node, requestedModel)}`
          + ` hedged=false kind=rate_limit_global status=429 counted=false (pre-dispatch, no budget charged)`,
        );
        state.attempts.push({ attempt: state.logicalAttempts + 1, dispatch: state.dispatches, node_id: node.id, status: 429, kind: 'rate_limit_global', hedged: false });
        return { rotate: true, budgetCharged: false };
      }
    } catch {
      // A broken coordinator must never take the gateway down: proceed and let
      // the local limits + circuit breaker do their job.
    }
  }

  // Protocol-aware upstream headers: OpenAI nodes authenticate with
  // Authorization Bearer, Anthropic nodes with x-api-key + anthropic-version.
  // The client's own gateway key never reaches the upstream for either.
  const headers = buildUpstreamHeadersFor(upstreamProtocol, request, node.credential, requestId);
  const controller = new AbortController();
  let headersTimeoutHit = false;
  // A hedged twin loses the race by being aborted: once the winning attempt
  // commits its response, the twin's controller fires and both the upstream
  // fetch and the first-event guard unwind through their normal error paths.
  if (c.hedgeAbort) {
    const onHedgeAbort = () => controller.abort();
    if (c.hedgeAbort.signal.aborted) onHedgeAbort();
    else c.hedgeAbort.signal.addEventListener('abort', onHedgeAbort, { once: true });
  }
  // Cap this attempt's own wait by a FAIR SHARE of the remaining whole-request
  // budget instead of letting one node consume UPSTREAM_HEADERS_TIMEOUT_MS in
  // full: the budget is split across the attempts that may still be needed, so
  // a slow first candidate no longer starves every later one. The last
  // remaining attempt keeps the entire remaining budget (share = remaining),
  // and the wait never exceeds UPSTREAM_HEADERS_TIMEOUT_MS.
  //
  // A hedged TWIN does not get a fresh slice: it inherits the logical
  // attempt's absolute deadline (primary + twin share ONE budget), so its
  // header wait is simply the time left until that deadline.
  let attemptHeadersTimeout;
  if (c.hedgedAttempt && c.attemptDeadlineMs) {
    attemptHeadersTimeout = attemptHeadersTimeoutMs(
      limits.headersTimeoutMs,
      Math.max(1, c.attemptDeadlineMs - Date.now()),
      1,
    );
  } else {
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    const attemptBudgetMs = attemptBudgetSliceMs(remainingBudgetMs, remainingDispatchableAttempts);
    c.attemptDeadlineMs = Date.now() + attemptBudgetMs;
    attemptHeadersTimeout = attemptHeadersTimeoutMs(
      limits.headersTimeoutMs,
      attemptBudgetMs,
      1,
    );
  }
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
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request.', requestId) };
    }
    if (c.hedgeAbort?.signal.aborted) {
      // Lost the hedge race: the upstream was healthy, just slower than its
      // twin. Neutral end — no health penalty, no cooldown, no circuit
      // failure; it still counts as a real dispatch because it did contact
      // an upstream (the twin charges dispatches, never logicalAttempts).
      state.attempted.add(node.id);
      state.dispatches++;
      if (!c.hedgedAttempt) state.logicalAttempts++;
      if (node.tier === 'tier-1') {
        releaseTier1Slot(node.id, c.tier1ReleaseToken);
        bumpNodeCounters(node.id, { requests: 1 });
      } else recordNeutralEnd(node.id);
      logger.info(
        `hedge loser: request=${requestId} node=${node.id} phase=headers`
        + ` reason=cancelled_after_peer_commit neutral=true latency_ms=${latencyMs}`,
      );
      return { rotate: true, hedgedAway: true, kind: 'cancelled_after_peer_commit' };
    }
    const classification = classifyNetworkError(headersTimeoutHit);
    recordOutcome(state, node, classification, c, { latencyMs });
    logger.debug(`upstream fetch failed on ${node.id}: ${error?.message || error}`);
    // The classification kind MUST travel with the rotate outcome: hedge
    // logging reads it from the settled outcome, and dropping it here used to
    // surface as primary_kind=unknown / twin_kind=unknown even though the
    // error was already classified.
    return { rotate: true, kind: classification.kind };
  }
  clearTimeout(timeoutId);
  const latencyMs = Date.now() - startMs;
  c.headersMs = latencyMs;

  // ---- Non-OK response ----
  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, DIAGNOSTIC_BYTES);
    const classification = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorText });
    if (classification.action === 'stop') {
      return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, upstream.status, errorText, state, exposeUpstreamInfo) };
    }
    return { rotate: true, kind: classification.kind };
  }

  return handleSuccess({
    upstream, c, targetUrl, latencyMs, detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}

// Anthropic-native first-event guard predicate: only text / thinking /
// tool-input deltas count as real model output. message_start,
// content_block_start/stop, ping and message_delta are lifecycle events and
// NOT commit points — the guard keeps consuming until real output appears,
// so a node that streams lifecycle events before dying can still fail over.
// Defined by the Anthropic transport (src/transport/anthropic.js) — the two
// protocol families deliberately do NOT share a first-real-output judgment.
// OpenAI Chat Tier 1 uses its meaningful-output predicate while Tier 2/3 keep
// the original parseable-event boundary. Responses uses response.*.delta.

async function handleSuccess(s) {
  const { upstream, c, latencyMs, detach, upstreamWasStreaming } = s;
  const { request, env, logger, requestId, route, node, requestedModel, bodyJson, clientWantsStream, fakeStream, limits, exposeUpstreamInfo, state, policy } = c;
  const surface = c.surface;
  const elapsedSinceStart = () => Date.now() - c.attemptStartMs;
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
    const guardStartMs = Date.now();
    let guarded;
    try {
      const remainingRequestBudgetMs = (c.failoverBudgetMs ?? limits.failoverBudgetMs) - (Date.now() - (c.requestStartMs || s.attemptStartMs));
      const remainingAttemptBudgetMs = (c.attemptDeadlineMs ?? Date.now()) - Date.now();
      // Policy-level first_event_timeout_ms overrides the global env default
      // for this model (e.g. long-reasoning needs 120s for chain-of-thought).
      const effectiveFirstEventTimeoutMs = policy?.firstEventTimeoutMs ?? limits.firstEventTimeoutMs;
      const firstEventTimeout = attemptFirstEventTimeoutMs(
        effectiveFirstEventTimeoutMs,
        Math.min(remainingRequestBudgetMs, remainingAttemptBudgetMs),
        1,
      );
      // Per-protocol "first real output" judgment — the failover boundary
      // commits only when genuine model output is observed:
      //   anthropic messages -> native content deltas (transport predicate)
      //   openai responses   -> response.*.delta events (transport predicate)
      //   openai chat tier1  -> meaningful text/reasoning/tool delta (so a
      //     role-only or empty delta does NOT close the boundary and is NOT
      //     recorded as passive TTFT — Tier 1 learns only from real output)
      //   openai chat tier2/3 -> any parseable non-error event (original rule,
      //     unchanged — Tier 2/3 are not redesigned here)
      const isRealOutput = surface === 'messages'
        ? isAnthropicNativeRealOutput
        : surface === 'responses' ? isResponsesRealOutput
        : (surface === 'chat_completions' && node.tier === 'tier-1') ? isOpenAIChatRealOutput
        : undefined;
      guarded = await ensureFirstSseEvent(upstream, firstEventTimeout, request.signal, isRealOutput);
    } catch (e) {
      detach();
      const code = e?.code || GUARD_ERROR.EMPTY;
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, {
          latencyMs: Date.now() - c.attemptStartMs,
          ttftWaitMs: Date.now() - guardStartMs,
          status: upstream.status,
        });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request before the first stream event.', requestId) };
      }
      if (c.hedgeAbort?.signal.aborted) {
        // Lost the hedge race while waiting for the first event: same neutral
        // treatment as the fetch-phase loss — slow is not broken. This holds
        // REGARDLESS of the guard error code: once the peer committed, this
        // side was cancelled, and a body-reader unwinding caused by our own
        // abort must not be miscounted as a first-event timeout.
        state.attempted.add(node.id);
        state.dispatches++;
        if (!c.hedgedAttempt) state.logicalAttempts++;
        if (node.tier === 'tier-1') {
          releaseTier1Slot(node.id, c.tier1ReleaseToken);
          bumpNodeCounters(node.id, { requests: 1 });
        } else recordNeutralEnd(node.id);
        logger.info(
          `hedge loser: request=${requestId} node=${node.id} phase=first_event`
          + ` reason=cancelled_after_peer_commit neutral=true latency_ms=${Date.now() - c.attemptStartMs}`,
        );
        return { rotate: true, hedgedAway: true, kind: 'cancelled_after_peer_commit' };
      }
      const classification = classifyFirstEventFailure();
      // Latest main invalidates stale Tier 2/3 TTFT after a real first-event
      // failure. Tier 1 has a separate passive metric and never writes here.
      if (node.tier !== 'tier-1') markProbeFailure(node.id, state.requestedModel);
      recordOutcome(state, node, classification, c, {
        latencyMs: Date.now() - c.attemptStartMs,
        ttftWaitMs: Date.now() - guardStartMs,
        status: upstream.status,
        diagnostic: code,
      });
      return { rotate: true, kind: classification.kind };
    }
    detach();
    // TTFT: dispatch start -> first committed meaningful stream event. For
    // Tier 1 this is the ONLY performance signal (passive, real-request), so
    // it is recorded against the (account, model) pair in tier1-state; a
    // failed request that produced no meaningful output never reaches here
    // (it rotates through the failure pipeline instead). Tier 2/3 keep the
    // node-level EWMA in node-state for their existing latency preference.
    c.ttftMs = Date.now() - c.attemptStartMs;
    if (node.tier === 'tier-1') {
      recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
    } else {
      recordTtft(node.id, c.ttftMs, state.requestedModel);
    }
    const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);

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
        interruptionChunk: (reason) => streamInterruptionChunk(route, requestId, reason),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: tracked };
    }

    if (route === 'openai_responses') {
      // NATIVE passthrough: the upstream streamed a Responses event sequence;
      // it is relayed as-is (model field rewritten inside the tracked stream).
      // No Chat Completions conversion is involved anywhere.
      const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
        failureMarker: /event:\s*response\.failed\b/,
        ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'response.model' } : {}),
        // Native Responses SSE carries usage inside the response.completed
        // payload; the tracked stream's passive scan reports it (onUsage).
        onUsage: (u) => recordTokens(c, node, u),
        interruptionChunk: (reason, details) => streamInterruptionChunk(route, requestId, reason, details),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: tracked };
    }

    // Cross-protocol fallback (streaming): the upstream is OpenAI Chat SSE but
    // the client is Anthropic. The first-event guard already committed on a
    // real OpenAI output event (isOpenAIChatRealOutput). Convert the OpenAI
    // SSE stream to Anthropic SSE through the stream converter, then track it
    // with Anthropic completion markers. The stream converter already emits
    // usage in Anthropic format (input_tokens/output_tokens), so the usage
    // scan reports it as-is.
    if (route === 'anthropic_messages' && c.conversionContext) {
      const inputTokens = estimateAnthropicInputTokens(bodyJson);
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const anthropicStream = createAnthropicStreamFromOpenAI(guarded.body, {
        messageId,
        model: requestedModel,
        inputTokens,
      });
      const tracked = trackStreamResponse(
        new Response(anthropicStream, { status: 200, headers }),
        {
          idleTimeoutMs: limits.streamIdleTimeoutMs,
          completionMarker: /event:\s*message_stop\b/,
          onUsage: (u) => recordTokens(c, node, u),
          interruptionChunk: (reason) => streamInterruptionChunk(route, requestId, reason),
          upstreamFailureReason: hiddenStreamFailure,
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: new Response(tracked.body, { status: 200, headers }) };
    }

    // anthropic_messages: NATIVE passthrough. The upstream streamed the
    // Anthropic event lifecycle (message_start ... message_stop); relay it
    // as-is, tracked so an interrupted passthrough records against the node
    // exactly once. No OpenAI conversion is involved anywhere.
    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      // A stream that never reaches message_stop (truncated / errored mid-way)
      // must NOT be recorded as a node success.
      completionMarker: /event:\s*message_stop\b/,
      ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'message.model' } : {}),
      onUsage: (u) => recordTokens(c, node, u),
      interruptionChunk: (reason) => streamInterruptionChunk(route, requestId, reason),
      upstreamFailureReason: hiddenStreamFailure,
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: new Response(tracked.body, { status: 200, headers }) };
  }
  detach();

  // ---- OpenAI Responses (non-stream, NATIVE) ----
  if (route === 'openai_responses') {
    try {
      let data;
      if (upstreamWasStreaming) {
        // Defensive: the native upstream streamed although the client asked
        // for JSON. Assemble the terminal response object — nothing has
        // reached the client, so failures here still rotate.
        data = await collectResponsesObject(upstream, request.signal);
      } else {
        data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024));
      }
      if (data && typeof data === 'object' && data.error) {
        const status = Number(data.error.status) >= 400 && Number(data.error.status) < 600
          ? Math.trunc(Number(data.error.status))
          : 502;
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(data.error.message || 'embedded error', 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      recordTier1NonStreamTtft(c, node, data, isOpenAIResponsesObjectMeaningful);
      // Single usage capture point for BOTH delivered forms below (plain JSON
      // and the synthesized Responses SSE).
      recordTokens(c, node, data?.usage);
      if (!clientWantsStream) {
        recordNodeSuccess(c, node, latencyMs);
        if (data && typeof data === 'object') data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      }
      // Stream requested but upstream returned a full object: synthesize a
      // well-formed Responses SSE stream in one body.
      recordNodeSuccess(c, node, latencyMs);
      return { response: synthesizeResponsesFromObject(data, requestedModel, { ...extraHeaders, ...corsHeaders(request, env) }) };
    } catch (error) {
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyFirstEventFailure();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: error.message });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- OpenAI chat ----
  if (route === 'openai_chat') {
    if (fakeStream || (upstreamWasStreaming && !clientWantsStream)) {
      // Assemble the full object; nothing reached the client yet, so failures rotate.
      try {
        const data = await collectOpenAIStreamObject(upstream, request.signal);
        recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
        recordNodeSuccess(c, node, latencyMs);
        // Assembled-from-stream usage (fake-stream protection and the
        // upstream-stream / client-non-stream case): the collect helper
        // already carries the final usage chunk — record it here, exactly
        // once, instead of inside the passthrough scan.
        recordTokens(c, node, data?.usage);
        data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      } catch (error) {
        if (request.signal?.aborted) {
          recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
          return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
        }
        const classification = classifyFirstEventFailure();
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: error.message });
        return { rotate: true, kind: classification.kind };
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
          interruptionChunk: (reason) => streamInterruptionChunk(route, requestId, reason),
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
      return rotateWithNeutralEnd(state, node, 'upstream_200_non_json_body', c);
    }
    if (data && typeof data === 'object' && data.error) {
      // Provider returned 200 with an embedded error: treat as a real failure
      // so the request rotates to a healthy node instead of relaying garbage.
      const status = Number(data.error.status) >= 400 && Number(data.error.status) < 600
        ? Math.trunc(Number(data.error.status))
        : 502;
      const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
      recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(data.error.message || 'embedded error', 200) });
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, text, state, exposeUpstreamInfo) };
      }
      return { rotate: true, kind: classification.kind };
    }
    recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
    // Single usage capture point for BOTH delivered forms below (plain JSON
    // and the synthesized chat SSE) — nothing else parses this body.
    recordTokens(c, node, data?.usage);
    if (!clientWantsStream) {
      recordNodeSuccess(c, node, latencyMs);
      if (data && typeof data === 'object') data.model = requestedModel;
      return { response: jsonResponse(200, data, env, request, extraHeaders) };
    }
    // Valid completion JSON for a streaming client: synthesize a proper SSE
    // stream so SSE clients receive a well-formed event sequence.
    recordNodeSuccess(c, node, latencyMs);
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: synthesizeSseFromCompletion(data, env, request, extraHeaders) };
  }

  // ---- Anthropic messages (non-stream, CROSS-PROTOCOL FALLBACK) ----
  if (route === 'anthropic_messages' && c.conversionContext) {
    try {
      let data;
      if (upstreamWasStreaming) {
        // OpenAI fallback upstream streamed although the client asked for
        // JSON. Assemble the full OpenAI completion object, then convert to
        // the Anthropic message shape and deliver.
        data = await collectOpenAIStreamObject(upstream, request.signal);
      } else {
        const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024);
        data = JSON.parse(text);
      }
      if (data && typeof data === 'object' && data.error) {
        const status = Number(data.error.status) >= 400 && Number(data.error.status) < 600
          ? Math.trunc(Number(data.error.status))
          : 502;
        const message = data.error?.message || 'Upstream returned an embedded error.';
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, message);
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(message, 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      const converted = convertOpenAIToAnthropicResponse(data);
      converted.model = requestedModel;
      recordNodeSuccess(c, node, latencyMs);
      recordTokens(c, node, convertOpenAIUsageToAnthropic(data?.usage));
      if (clientWantsStream) {
        return { response: synthesizeAnthropicFromMessage(converted, { ...extraHeaders, ...corsHeaders(request, env) }) };
      }
      return { response: jsonResponse(200, converted, env, request, extraHeaders) };
    } catch (error) {
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyFirstEventFailure();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: error.message });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- Anthropic messages (non-stream, NATIVE) ----
  try {
    let data;
    if (upstreamWasStreaming) {
      // Defensive: the native upstream streamed although the client asked
      // for JSON. Assemble the final message object — nothing has reached
      // the client, so failures here still rotate.
      data = await collectAnthropicMessageObject(upstream, request.signal);
    } else {
      // Use bounded read (2 MiB, consistent with assemble.js MAX_ASSEMBLED_BYTES
      // and the first-event guard pre-byte limit) instead of unbounded text().
      const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024);
      data = JSON.parse(text);
    }
    if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
      // Provider returned 200 with an embedded error envelope: treat as a
      // real failure so the request rotates to a healthy node.
      const message = data.error?.message || 'Upstream returned an embedded error.';
      const classification = classifyUpstreamStatus(502, upstream.headers, env, undefined, message);
      recordOutcome(state, node, classification, c, { latencyMs, status: 502, diagnostic: trimDiagnostic(message, 200) });
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, 502, JSON.stringify(data), state, exposeUpstreamInfo) };
      }
      return { rotate: true, kind: classification.kind };
    }
    recordTier1NonStreamTtft(c, node, data, isAnthropicMessageMeaningful);
    recordNodeSuccess(c, node, latencyMs);
    // Single usage capture point: this branch serves both the plain JSON body
    // and the upstream-stream-assembled object.
    recordTokens(c, node, data?.usage);
    if (clientWantsStream) {
      // Stream requested but upstream returned a full message object:
      // synthesize the well-formed Anthropic SSE lifecycle in one body.
      return { response: synthesizeAnthropicFromMessage(data, { ...extraHeaders, ...corsHeaders(request, env) }) };
    }
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: jsonResponse(200, data, env, request, extraHeaders) };
  } catch (error) {
    if (request.signal?.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs, status: upstream.status });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
    }
    const classification = classifyFirstEventFailure();
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: error.message });
    return { rotate: true, kind: classification.kind };
  }
}

function recordTier1NonStreamTtft(c, node, data, isMeaningful) {
  if (node.tier !== 'tier-1' || !isMeaningful(data)) return;
  c.ttftMs = Date.now() - c.attemptStartMs;
  recordTier1Ttft(node.id, c.state.requestedModel, c.ttftMs);
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
//
// TTFT is passed only for successful requests with meaningful output.
// Failures MUST NOT pass a TTFT value — they enter failure statistics only.
function scheduleD1TokenPersist(c, usage) {
  const task = persistTokenUsage(c.env, usage, Date.now(), c.requestedModel, c.ttftMs ?? null).catch((err) => {
    const scope = err?.scope === 'per-model' ? 'per-model' : 'global';
    try { c.logger?.error?.(`token-stats D1 ${scope} persist failed: ${err?.message || err}`); } catch { /* never throw */ }
  });
  const ctx = c.ctx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch { task.catch(() => {}); }
  } else {
    // No ExecutionContext (unit tests): fire-and-forget with a swallow.
    task.catch(() => {});
  }
}

// Record the real request outcome first. Tier 1 learns ONLY from real business
// requests: success drives half-open recovery and (on an affinity escape) moves
// the session to the winning account. Tier 2/3 keep their node-state path.
// There is NO background probe anymore — probes were Tier-1-only and have been
// removed entirely from the scheduling path.
function recordNodeSuccess(c, node, latencyMs) {
  if (node.tier === 'tier-1') {
    recordTier1Success(node.id, c.state?.requestedModel);
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    bumpNodeCounters(node.id, { requests: 1, successes: 1 });
    // KV writes happen only for a cold session or an approved migration, and
    // only after the selected account completed a real request successfully.
    if (c.tier1UpdateAffinity && c.tier1Session) {
      writeTier1Affinity(c.env, c.ctx, c.tier1Session, node.id);
    }
    return;
  }
  recordSuccess(node.id, latencyMs, c.state?.requestedModel);
}

// Node-layer stream tracking: node outcome recording + stream-end telemetry.
// The client-facing layer (gateway-stats.mjs trackClientResponse) never passes the
// telemetry callbacks, so stream counters count each stream exactly once.
function makeNodeStreamTrack(c, node, latencyMs) {
  const tier1 = node.tier === 'tier-1';
  return {
    onSuccess: () => recordNodeSuccess(c, node, latencyMs),
    // Field evidence (NVIDIA-hosted stalls mid-generation): 2s let a stalling
    // node straight back into rotation. 60s matches the rate-limit cooldown —
    // long enough to push repeat offenders out of candidate ordering without
    // permanently discarding a node that had one transient blip.
    // Tier 1 needs the concrete interruption reason supplied to onStreamEnd,
    // so its failure state and release happen there. Tier 2/3 keep the existing
    // recordFailure path unchanged.
    onFailure: () => {
      if (!tier1) recordFailure(node.id, { counted: true, cooldownMs: 60_000, reason: 'stream_interrupted' });
    },
    onNeutral: () => tier1
      ? releaseTier1Slot(node.id, c.tier1ReleaseToken)
      : recordNeutralEnd(node.id),
    onStreamStart: () => recordStreamStart(),
    onStreamEnd: (outcome, d) => {
      if (outcome === 'completed') { recordStreamCompleted(); return; }
      if (outcome !== 'interrupted') return; // neutral (client abort) is not counted
      recordStreamInterrupted(d.reason);
      if (tier1) {
        applyTier1Outcome(node.id, c.state?.requestedModel,
          classifyTier1Failure({ kind: 'stream_interrupted', streamReason: d.reason }));
        releaseTier1Slot(node.id, c.tier1ReleaseToken);
        bumpNodeCounters(node.id, { requests: 1, failures: 1 });
      } else {
        applyHealthPenalty(node.id, 'stream');
      }
      c.logger.info(
        `[stream-interrupted] node=${node.id} provider=${node.provider}`
        + ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? node.surfaces?.[0] ?? ''}`
        + ` model=${c.requestedModel}->${upstreamModelOf(node, c.requestedModel)}`
        + ` reason=${d.reason} duration_ms=${d.durationMs} chunks=${d.chunkCount}`
        + ` received_bytes=${d.receivedBytes} completion_marker=${d.completionMarkerSeen}`,
      );
    },
  };
}

function rotateWithNeutralEnd(state, node, reason, c = {}, preDispatch = false) {
  state.attempted.add(node.id);
  // Pre-dispatch neutrals (invalid base URL) never reached an upstream, so they
  // do not consume any budget — no dispatch/attempt charge, and the outcome
  // reports budgetCharged:false exactly like the rate-limiter deny.
  if (!preDispatch) {
    state.dispatches++;
    if (!c.hedgedAttempt) state.logicalAttempts++;
  }
  if (node.tier === 'tier-1') {
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (preDispatch) rollbackTier1Rpm(node.id);
    else bumpNodeCounters(node.id, { requests: 1 });
  } else {
    recordNeutralEnd(node.id);
    // Pre-dispatch neutrals also never touched the network, so the RPM reservation
    // acquireSlot made must be returned to the bucket — otherwise a structurally
    // broken node silently burns its own per-minute RPM quota on traffic it never
    // sent. Post-dispatch neutrals (200-with-non-json) keep the charge: the
    // upstream WAS contacted.
    if (preDispatch) rollbackRpmBucket(node.id);
  }
  noteFailure(state, reason);
  state.logger.info(
    `dispatch request=${c.requestId ?? state.requestId} logical_attempt=${preDispatch ? state.logicalAttempts + 1 : state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? ''} tier=${node.tier ?? ''}`
    + ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}`
    + ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=${reason} status=0 counted=false`,
  );
  state.attempts.push({ attempt: state.logicalAttempts + (preDispatch ? 1 : 0), dispatch: state.dispatches, node_id: node.id, status: 0, kind: reason, hedged: !!(c.hedgedAttempt || c.hedgedWithTwin) });
  return preDispatch ? { rotate: true, budgetCharged: false, kind: reason } : { rotate: true, kind: reason };
}

// Aggregate failure-kind counter for the exhausted response. Kinds alone (no
// node ids / no ordering) are safe to expose to clients by default and answer
// the only question that matters when everything failed: HOW did it fail?
function noteFailure(state, kind) {
  state.failureKinds[kind] = (state.failureKinds[kind] || 0) + 1;
}

// Record a classified attempt outcome exactly once. `c` is the dispatch
// context (attemptNode args): its hedgedAttempt / hedgedWithTwin flags decide
// charging and the hedged log field, headersMs feeds the timing fields.
//   * dispatches counts every real upstream dispatch (never a pre-dispatch deny);
//   * logicalAttempts counts the logical attempt the dispatch belongs to — a
//     hedge twin belongs to its primary's attempt and does not increment it.
function recordOutcome(state, node, classification, c, { latencyMs = -1, ttftWaitMs, status = 0, diagnostic } = {}) {
  state.attempted.add(node.id);
  state.dispatches++;
  if (!c?.hedgedAttempt) state.logicalAttempts++;
  const hedged = !!(c?.hedgedAttempt || c?.hedgedWithTwin);
  const headersMs = c?.headersMs ?? (latencyMs >= 0 ? latencyMs : undefined);

  if (node.tier === 'tier-1') {
    // Tier 1 owns its own per-(account,model) failure state machine. The
    // shared classify.js outcome is mapped to a Tier 1 scope/cooldown; 429
    // defaults to MODEL scope with a scope_ambiguous diagnostic flag when no
    // provider-specific rule disambiguated it.
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (classification.action === 'neutral') {
      bumpNodeCounters(node.id, { requests: 1 });
    } else {
      const t1Class = classifyTier1Failure(classification, { retryAfterMs: classification.retryAfterMs || 0 });
      applyTier1Outcome(node.id, state.requestedModel, t1Class);
      bumpNodeCounters(node.id, { requests: 1, failures: 1 });
    }
  } else if (classification.modelScoped) {
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
    `dispatch request=${c?.requestId ?? state.requestId} logical_attempt=${state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${c?.upstreamProtocol ?? node.protocol} surface=${c?.surface ?? ''} tier=${node.tier}`
    + ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}`
    + ` hedged=${hedged} kind=${classification.kind} status=${status} counted=${classification.counted}`
    + ` headers_ms=${headersMs ?? -1}${ttftWaitMs !== undefined ? ` ttft_wait_ms=${ttftWaitMs}` : ''}`
    + ` latency_ms=${latencyMs}`
    + `${diagnostic && c?.exposeUpstreamInfo ? ` detail=${trimDiagnostic(diagnostic, 200)}` : ''}`,
  );

  const record = {
    attempt: state.logicalAttempts, dispatch: state.dispatches, node_id: node.id,
    provider: node.provider, protocol: c?.upstreamProtocol ?? node.protocol, surface: c?.surface,
    status, kind: classification.kind, hedged,
  };
  if (headersMs !== undefined && headersMs >= 0) record.headers_ms = headersMs;
  if (ttftWaitMs !== undefined && ttftWaitMs >= 0) record.ttft_wait_ms = ttftWaitMs;
  if (latencyMs >= 0) record.latency_ms = latencyMs;
  if (c?.exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
  state.attempts.push(record);
}

// ---- Response helpers ------------------------------------------------------
// finalHeaders, jsonResponse, streamInterruptionChunk and upstreamModelOf
// live in ./response-helpers.js.

