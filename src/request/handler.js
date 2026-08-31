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
import {
  recordSuccess, recordFailure, recordNeutralEnd, rollbackRpmBucket, recordModelMissing,
  applyHealthPenalty, recordTtft,
} from '../reliability/node-state.js';
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
  isAnthropicNativeRealOutput, isResponsesRealOutput,
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
import { isAuthorized } from './auth.js';
import { gatewayError, buildBudgetExhaustedResponse, buildExhaustedResponse, buildClientErrorResponse } from './errors.js';
import { TIER_ORDER, normalizePath, detectRoute, acceptsHtml } from './router.js';

const DIAGNOSTIC_BYTES = 4096;

// Client surface -> (protocol, surface). The scheduler filters candidate
// nodes through BOTH dimensions plus the model, so an OpenAI request can
// never land on an Anthropic node, a chat-only node never receives a
// /v1/responses request, and there is no cross-protocol conversion or
// cross-protocol failover anywhere in the pipeline.
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
  // Triple filter: protocol + surface + model. A request is only routable
  // when a node of the matching protocol declares the matching surface and
  // serves the logical model.
  const reqDescriptor = { model: requestedModel, ...ROUTE_PROTOCOL_SURFACE[route] };
  const supported = TIER_ORDER.some((t) => tiers[t].some((n) => supportsRequest(n, reqDescriptor)));
  if (!supported) {
    return gatewayError(request, env, route, 404,
      `No configured node provides model "${requestedModel}" via protocol "${reqDescriptor.protocol}" surface "${reqDescriptor.surface}". Verify the models mapping.`, requestId);
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
  };

  // Per-tier attempt budgets, computed ONCE per request (dispatchability-aware):
  // a lower tier only receives budget when it can DISPATCH this model right now
  // (a ready candidate: not cooling, circuit-open, concurrency-saturated, or
  // hard-RPM exhausted). Deferred capacity — busy or temporarily over-quota
  // nodes that free up later — surfaces only in Retry-After / diagnostics and
  // earns NO budget. The loop below is strict tier precedence: a tier is
  // drained (its budget spent) before the next tier is entered. Tier caps and
  // max_attempts both count LOGICAL attempts; a hedge twin charges neither.
  const tierCaps = computeTierCaps(tiers, reqDescriptor, state.attempted, policy);
  for (const tierNumber of TIER_ORDER) {
    const cap = tierCaps[tierNumber] ?? 0;
    let usedInTier = 0;
    while (usedInTier < cap && state.logicalAttempts < policy.maxAttempts) {
      // Failover budget gate: before preparing a NEW attempt, stop if the
      // request has already consumed the whole budget. Never keep hammering
      // upstreams once the client has waited ~FAILOVER_BUDGET_MS overall.
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }
      const remainingDispatchableAttempts = countRemainingDispatchableAttempts(
        tiers, reqDescriptor, state.attempted, tierCaps,
        tierNumber, usedInTier, policy.maxAttempts - state.logicalAttempts,
      );
      const node = pickCandidate(tiers[tierNumber], reqDescriptor, state.attempted);
      if (!node) break; // tier exhausted -> fallback to next tier
      const outcome = await dispatchWithHedge({
        request, env, ctx, logger, requestId, route, node, requestedModel,
        clientWantsStream, fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
        failoverBudgetMs, requestStartMs, reqDescriptor,
        remainingDispatchableAttempts, policy, tierNumber,
      }, tiers[tierNumber]);
      // A pre-dispatch outcome that never reached an upstream (distributed
      // rate-limiter deny, invalid base URL) carries budgetCharged:false and
      // consumes NOTHING: neither the logical-attempt budget nor this tier's
      // attempt slot — charging the slot instead would let denied-but-untried
      // keys starve same-tier healthy candidates and every fallback tier.
      // budgetCharged is always defined on an outcome, so there is no implicit
      // default being matched here. Termination is unaffected: such nodes land
      // in state.attempted and pickCandidate skips them, so the candidate set
      // itself bounds the loop rather than the budgets. A hedge twin never
      // charges a slot: it is an extra executioner of the SAME logical attempt.
      if (outcome.budgetCharged) usedInTier++;
      if (outcome.response) return outcome.response;
      if (outcome.stop) break;
    }
  }

  return buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers, exposeUpstreamInfo, reqDescriptor);
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
    tierHasDispatchableNode(tiers[t], reqDescriptor, attempted, now));
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
    const live = countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now);
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
      + ` protocol=${c.node.protocol} surface=${c.surface} tier=${c.node.tier}`
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
  // the global env defaults. When no policy hedge is configured (null),
  // keep the legacy behavior — hedge enabled on ALL tiers with
  // HEDGE_DELAY_MS / MAX_HEDGES_PER_REQUEST from env.
  const hedgePolicy = args.policy?.hedge ?? null;
  const tierKey = `tier${args.tierNumber}`;
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
  const twinNode = pickCandidate(tierNodes, args.reqDescriptor, args.state.attempted, Date.now(), args.node.id);
  if (!twinNode) return primary;

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
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;
  // The surface is derived from the route and validated against the node by
  // the scheduler; carrying it on the attempt context keeps dispatch logging
  // and stream semantics explicit.
  const surface = reqDescriptor.surface;
  c.surface = surface;

  // Native outbound body: the client request is forwarded verbatim to the
  // upstream of the SAME protocol+surface, with only the model name
  // substituted. No cross-protocol or cross-surface conversion exists.
  const upstreamModel = node.models[requestedModel] || requestedModel;
  let outboundObject;
  if (route === 'openai_chat') {
    outboundObject = { ...bodyJson, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else {
    // openai_responses -> native /v1/responses body
    // anthropic_messages -> native /v1/messages body
    outboundObject = { ...bodyJson, model: upstreamModel };
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
    targetUrl = buildTargetUrl(node.baseUrl, resolveUpstreamPath(node.protocol, surface));
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
        recordNeutralEnd(node.id);
        rollbackRpmBucket(node.id);
        noteFailure(state, 'rate_limit_global');
        state.logger.info(
          `dispatch request=${requestId} logical_attempt=${state.logicalAttempts + 1}/${state.maxAttempts}`
          + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
          + ` protocol=${node.protocol} surface=${surface} tier=${node.tier}`
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
  const headers = buildUpstreamHeadersFor(node.protocol, request, node.credential, requestId);
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
      recordNeutralEnd(node.id);
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
// OpenAI Chat keeps the original "any parseable non-error event commits";
// OpenAI Responses commits on response.*.delta events (isResponsesRealOutput).

async function handleSuccess(s) {
  const { upstream, c, latencyMs, detach, upstreamWasStreaming } = s;
  const { request, env, logger, requestId, route, node, requestedModel, bodyJson, clientWantsStream, fakeStream, limits, exposeUpstreamInfo, state } = c;
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
      const firstEventTimeout = attemptFirstEventTimeoutMs(
        limits.firstEventTimeoutMs,
        Math.min(remainingRequestBudgetMs, remainingAttemptBudgetMs),
        1,
      );
      // Per-protocol "first real output" judgment — the failover boundary
      // commits only when genuine model output is observed:
      //   anthropic messages -> native content deltas (transport predicate)
      //   openai responses   -> response.*.delta events (transport predicate)
      //   openai chat        -> any parseable non-error event (original rule)
      const isRealOutput = surface === 'messages'
        ? isAnthropicNativeRealOutput
        : surface === 'responses' ? isResponsesRealOutput : undefined;
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
        recordNeutralEnd(node.id);
        logger.info(
          `hedge loser: request=${requestId} node=${node.id} phase=first_event`
          + ` reason=cancelled_after_peer_commit neutral=true latency_ms=${Date.now() - c.attemptStartMs}`,
        );
        return { rotate: true, hedgedAway: true, kind: 'cancelled_after_peer_commit' };
      }
      const classification = classifyFirstEventFailure();
      recordOutcome(state, node, classification, c, {
        latencyMs: Date.now() - c.attemptStartMs,
        ttftWaitMs: Date.now() - guardStartMs,
        status: upstream.status,
        diagnostic: code,
      });
      return { rotate: true, kind: classification.kind };
    }
    detach();
    // TTFT: dispatch start -> first committed stream event. The scheduler's
    // latency preference compares THIS for streaming traffic; avgLatencyMs
    // keeps measuring headers, which says nothing about when tokens start.
    c.ttftMs = Date.now() - c.attemptStartMs;
    recordTtft(node.id, c.ttftMs);
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
      // Single usage capture point for BOTH delivered forms below (plain JSON
      // and the synthesized Responses SSE).
      recordTokens(c, node, data?.usage);
      if (!clientWantsStream) {
        recordSuccess(node.id, latencyMs);
        if (data && typeof data === 'object') data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      }
      // Stream requested but upstream returned a full object: synthesize a
      // well-formed Responses SSE stream in one body.
      recordSuccess(node.id, latencyMs);
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
    recordSuccess(node.id, latencyMs);
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
  const task = persistTokenUsage(c.env, usage, Date.now(), c.requestedModel).catch((err) => {
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

// Node-layer stream tracking: node outcome recording + stream-end telemetry.
// The client-facing layer (gateway-stats.mjs trackClientResponse) never passes the
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
        + ` protocol=${node.protocol} surface=${node.surfaces?.[0] ?? ''}`
        + ` model=${c.requestedModel}->${upstreamModelOf(node, c.requestedModel)}`
        + ` reason=${d.reason} duration_ms=${d.durationMs} chunks=${d.chunkCount}`
        + ` received_bytes=${d.receivedBytes} completion_marker=${d.completionMarkerSeen}`,
      );
    },
  };
}

const streamErrorEncoder = new TextEncoder();

// Once bytes have reached the client, transparent failover is unsafe.  Still
// emit a protocol-shaped error event before closing so SDKs see the real
// gateway interruption instead of only a generic "missing completion marker".
// Deliberately do not emit a success completion marker after the error.
function streamInterruptionChunk(route, requestId, reason, { nextSequenceNumber = 0 } = {}) {
  const message = `Gateway upstream stream interrupted (${reason || 'unknown'}).`;
  let event;
  if (route === 'openai_responses') {
    event = `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'stream_interrupted', message, param: null, sequence_number: nextSequenceNumber })}\n\n`;
  } else if (route === 'anthropic_messages') {
    event = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`;
  } else {
    event = `data: ${JSON.stringify({ error: { message, type: 'api_error', code: 'stream_interrupted' } })}\n\n`;
  }
  return streamErrorEncoder.encode(event);
}

function upstreamModelOf(node, logicalModel) {
  return node.models[logicalModel] || logicalModel;
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
  recordNeutralEnd(node.id);
  // Pre-dispatch neutrals also never touched the network, so the RPM reservation
  // acquireSlot made must be returned to the bucket — otherwise a structurally
  // broken node silently burns its own per-minute RPM quota on traffic it never
  // sent. Post-dispatch neutrals (200-with-non-json) keep the charge: the
  // upstream WAS contacted.
  if (preDispatch) rollbackRpmBucket(node.id);
  noteFailure(state, reason);
  state.logger.info(
    `dispatch request=${c.requestId ?? state.requestId} logical_attempt=${preDispatch ? state.logicalAttempts + 1 : state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${node.protocol} surface=${c.surface ?? ''} tier=${node.tier ?? ''}`
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
    `dispatch request=${c?.requestId ?? state.requestId} logical_attempt=${state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${node.protocol} surface=${c?.surface ?? ''} tier=${node.tier}`
    + ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}`
    + ` hedged=${hedged} kind=${classification.kind} status=${status} counted=${classification.counted}`
    + ` headers_ms=${headersMs ?? -1}${ttftWaitMs !== undefined ? ` ttft_wait_ms=${ttftWaitMs}` : ''}`
    + ` latency_ms=${latencyMs}`
    + `${diagnostic && c?.exposeUpstreamInfo ? ` detail=${trimDiagnostic(diagnostic, 200)}` : ''}`,
  );

  const record = {
    attempt: state.logicalAttempts, dispatch: state.dispatches, node_id: node.id,
    provider: node.provider, protocol: node.protocol, surface: c?.surface,
    status, kind: classification.kind, hedged,
  };
  if (headersMs !== undefined && headersMs >= 0) record.headers_ms = headersMs;
  if (ttftWaitMs !== undefined && ttftWaitMs >= 0) record.ttft_wait_ms = ttftWaitMs;
  if (latencyMs >= 0) record.latency_ms = latencyMs;
  if (c?.exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
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
