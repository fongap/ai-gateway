// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Main request pipeline.
//
//   auth -> route -> body -> validate -> model support check
//     -> bounded logical-model rounds:
//          -> native per-tier attempt loop
//          -> configured cross-protocol fallback for the SAME logical model
//          -> next compatible logical model when the current model pool is
//             exhausted
//
// Streaming rule: the first-event guard runs BEFORE any streaming Response is
// returned to the client; after that point transparent failover is forbidden.

import { TIER_ORDER } from './router.ts';
import { getLogger } from '../observability/logger.ts';
import { buildBudgetExhaustedResponse, buildExhaustedResponse } from './errors.ts';
import {
  resolveTier1SessionId, readTier1Affinity,
  shouldEvaluateAffinity, recordTier1AffinityDecision,
} from '../scheduler/tier1-affinity.ts';
import { tier1DeadlineTooSmall } from '../scheduler/tier1-scheduler.ts';
import { preflight as runPreflight } from './preflight.ts';
import { evaluateRouteFeasibility } from './route-feasibility.ts';
import { buildModelFallbackRounds } from './model-fallback.ts';
import { pickForTier, makeTier1Rng, computeTierCaps, countRemainingDispatchableAttempts } from './tier-loop.ts';
import { runFallbackChain } from './fallback.ts';
import { dispatchWithHedge } from './attempt.ts';
import type { LoopContext, ConversionContext } from '../types/request.ts';
import type { RoutableRequest } from '../types/scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';

export async function handleRequest(request: Request, env: Record<string, unknown>, ctx: { waitUntil?: Function }): Promise<Response> {
  const logger = getLogger(env);
  const pre = await runPreflight(request, env, ctx);
  if (pre.ok === false) {
    return pre.response;
  }
  if ('group' in pre.authResult && pre.authResult.group) {
    logger.info('request authorized', { key_group: pre.authResult.group, request_id: pre.requestId });
  }

  const {
    requestId, requestStartMs,
    route, requestedModel, clientWantsStream, fakeStream, bodyJson,
    limits, exposeUpstreamInfo, requestDescriptor: reqDescriptor,
    config, tiers, policy, failoverBudgetMs, knownModels, feasibility,
  } = pre;

  // Three SEPARATE counters, never one overloaded total:
  //   logicalAttempts — max_attempts budget; a primary + its optional hedge
  //                     twin together are ONE logical attempt;
  //   dispatches      — real upstream requests (pre-dispatch denies excluded);
  //   hedges          — hedge twins launched. Hard-capped by
  //                     MAX_HEDGES_PER_REQUEST; worst case
  //                     maxDispatches = maxAttempts + maxHedgesPerRequest.
  // All model-family passes share these counters and the same wall-clock
  // failover budget. Switching models never creates a fresh retry budget.
  const state: LoopContext['state'] = {
    attempted: new Set<string>(), attempts: [], logicalAttempts: 0, dispatches: 0, hedges: 0,
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

  const loopCtx: LoopContext = {
    request, env, ctx, logger, requestId, route, requestedModel,
    clientWantsStream, fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs, policy, tiers,
    tier1Affinity, tier1EvaluateAffinity, tier1Rng, tier1Session,
    knownModels, feasibility,
  };

  // Model fallback is a bounded outer loop around the EXISTING scheduler. It
  // never changes node selection, P2C, affinity, cooldown, hedge, tier order,
  // protocol conversion, or reliability state machines. Each logical-model
  // pass gets a fresh request-local attempted set so the same credential can
  // legitimately serve a different logical model, and the second round can
  // re-check a model whose cooldown recovered while sibling pools were tried.
  // The global logicalAttempts / dispatches / hedges / wall-clock budget remain
  // shared and strictly bounded across every pass.
  const modelRounds = buildModelFallbackRounds(requestedModel, knownModels);

  modelRoundsLoop:
  for (let roundIndex = 0; roundIndex < modelRounds.length; roundIndex++) {
    const round = modelRounds[roundIndex];
    for (const effectiveModel of round) {
      if (state.logicalAttempts >= policy.maxAttempts) break modelRoundsLoop;
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        state.requestedModel = requestedModel;
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }

      const effectiveReqDescriptor = { ...reqDescriptor, model: effectiveModel };
      const effectiveFeasibility = roundIndex === 0 && effectiveModel === requestedModel
        ? feasibility
        : evaluateRouteFeasibility({
          route,
          requestedModel: effectiveModel,
          requestDescriptor: effectiveReqDescriptor,
          tiers,
          knownModels,
          env,
        });

      // A family member that has no statically reachable route costs no
      // attempt and does not block later siblings. Runtime cooldown/circuit
      // availability is still evaluated inside the normal tier loop.
      if (!effectiveFeasibility.reachable) continue;

      state.attempted = new Set<string>();
      // Reliability state is keyed to the model actually being routed. The
      // client-facing requested model remains loopCtx.requestedModel and is
      // preserved in response bodies; only this request-local reliability key
      // changes between family passes.
      state.requestedModel = effectiveModel;
      const effectiveLoopCtx: LoopContext = { ...loopCtx, feasibility: effectiveFeasibility };
      const modelMissingBefore = state.failureKinds.model_missing ?? 0;

      if (effectiveModel !== requestedModel || roundIndex > 0) {
        logger.info(
          `model-fallback request=${requestId} round=${roundIndex + 1}/${modelRounds.length}`
          + ` requested=${requestedModel} effective=${effectiveModel}`
          + ` logical_attempts=${state.logicalAttempts}/${policy.maxAttempts}`,
        );
      }

      // Native-first for this logical model.
      const nativeResult = await runTierLoop(effectiveLoopCtx, effectiveReqDescriptor, null);
      if (nativeResult) return nativeResult;

      if (state.logicalAttempts >= policy.maxAttempts) break modelRoundsLoop;

      // Then run the existing cross-protocol fallback chain for this SAME
      // effective logical model. Native + protocol fallback share the same
      // attempted set for this pass, exactly as before.
      const fbResult = await runFallbackChain({
        loopCtx: effectiveLoopCtx,
        route,
        requestedModel: effectiveModel,
        runTierLoop,
      });
      if (fbResult) return fbResult;

      // A model-missing 404 is a mapping/capability fact, not transient pool
      // unavailability. Keep that failure isolated to the (node, model) pair
      // and do not silently turn it into a different logical model. Model-family
      // fallback is only the final capacity escape hatch after runtime
      // availability is exhausted.
      if ((state.failureKinds.model_missing ?? 0) > modelMissingBefore) {
        break modelRoundsLoop;
      }
    }
  }

  // Restore the external model identity for the terminal error response. Any
  // successful streaming response returned above deliberately leaves
  // state.requestedModel on its effective model so late stream completion /
  // interruption callbacks update the correct reliability bucket.
  state.requestedModel = requestedModel;
  return buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers, exposeUpstreamInfo, reqDescriptor);
}

// Run the per-tier attempt loop for a given reqDescriptor. Returns a Response
// when the request was committed (success, budget exhausted, or client-side
// stop); returns null when all tiers are exhausted without a response so the
// caller can fall through to cross-protocol fallback or the next compatible
// logical model. `conversionContext` is null for native dispatches; for
// cross-protocol fallback it carries the converted outbound body and
// protocol/surface info. `overrideTierCaps` lets the caller inject pre-computed
// caps (used by the protocol-fallback path).
async function runTierLoop(loopCtx: LoopContext, reqDescriptor: RoutableRequest, conversionContext: ConversionContext | null, overrideTierCaps?: Record<number, number> | null): Promise<Response | null> {
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
    const raceLostIds = new Set<string>();
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
        raceLostIds,
      });
      if (!pick) break;
      if (pick.raceLost) {
        // raceLost means the best candidate's slot was claimed by a concurrent
        // request. Exclude it and retry within the same tier — there may be
        // other eligible nodes. Bounded by cap (shared logical attempt budget).
        continue;
      }
      // raceLost is guarded above, so the picker always returned a node
      // (single-writer invariant of pickForTier's success shape).
      const node = pick.node as RuntimeNode;
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
