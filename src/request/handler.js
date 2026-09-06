// SPDX-License-Identifier: MIT
// @ts-check
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
import { TIER_ORDER, normalizePath, detectRoute, acceptsHtml } from './router.js';
import { getLogger } from '../observability/logger.js';
import { healthResponse, metricsResponse, modelsListResponse, versionResponse } from '../observability/diagnostic-endpoints.mjs';
import { dashboardResponse } from '../dashboard/pages.js';
import { authorize } from './auth.js';
import { loadAccessKeysConfig, collectConfiguredModels } from '../config/access-keys.js';
import { authorizeModel, filterVisibleModels } from './model-authz.js';
import { gatewayError, buildBudgetExhaustedResponse, buildExhaustedResponse, buildClientErrorResponse } from './errors.js';
import {
  resolveTier1SessionId, readTier1Affinity,
  shouldEvaluateAffinity, recordTier1AffinityDecision,
} from '../scheduler/tier1-affinity.js';
import { tier1DeadlineTooSmall } from '../scheduler/tier1-scheduler.js';
import { preflight as runPreflight, getRouteProtocolSurface } from './preflight.js';
import { pickForTier, makeTier1Rng, computeTierCaps, countRemainingDispatchableAttempts } from './tier-loop.js';
import { runFallbackChain } from './fallback.js';
import { attemptNode, dispatchWithHedge } from './attempt.js';

export async function handleRequest(request, env, ctx) {
  const logger = getLogger(env);
  const pre = await runPreflight(request, env, ctx);
  if (!pre.ok) {
    return /** @type {Response} */ (/** @type {{ ok: false, response: Response }} */ (pre).response);
  }
  if (pre.authResult.group) {
    logger.info('request authorized', { key_group: pre.authResult.group, request_id: pre.requestId });
  }

  // Preflight validated auth, body, model authz, config readiness, and the
  // (model, protocol, surface) candidate existence check. Unpack the
  // carried request context; aliasing is just to keep the inner naming
  // identical to the pre-refactor handler.
  const {
    request: req, env: envFromPre, ctx: ctxFromPre,
    requestId, requestStartMs,
    route, requestedModel, clientWantsStream, fakeStream, bodyJson,
    limits, exposeUpstreamInfo, authResult, requestDescriptor: reqDescriptor,
    config, tiers, policy, failoverBudgetMs, knownModels, feasibility,
  } = pre;
  void authResult;
  // The request / env / ctx carried by preflight are the same as our
  // parameters; keep the inner code referring to the originals.
  void req; void envFromPre; void ctxFromPre;

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
    knownModels, feasibility,
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
  const fbResult = await runFallbackChain({
    loopCtx,
    route,
    requestedModel,
    runTierLoop,
  });
  if (fbResult) return fbResult;

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
    knownModels,
  } = loopCtx;
  const tierCaps = overrideTierCaps ?? computeTierCaps(tiers, reqDescriptor, state.attempted, policy, knownModels);
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
        tierNumber, usedInTier, policy.maxAttempts - state.logicalAttempts, knownModels,
      );
      const pick = pickForTier(tierNumber, tiers[tierNumber], reqDescriptor, state.attempted, {
        affinityAccountId: tierNumber === 1 ? tier1Affinity : null,
        evaluateAffinity: tierNumber === 1 && tier1EvaluateAffinity,
        rng: tier1Rng,
        knownModels,
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
