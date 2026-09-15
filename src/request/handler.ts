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
import { preflight as runPreflight } from './preflight.ts';
import { evaluateRouteFeasibility } from './route-feasibility.ts';
import {
  buildModelFallbackPlan,
  failedDomainNodeIds,
  rememberFailedDomains,
} from './model-fallback.ts';
import { pickForTier, makeTier1Rng, computeTierCaps, countRemainingDispatchableAttempts } from './tier-loop.ts';
import { runFallbackChain } from './fallback.ts';
import { dispatchWithHedge } from './attempt.ts';
import type { LoopContext, ConversionContext, RouteFeasibilityResult } from '../types/request.ts';
import type { RoutableRequest } from '../types/scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';

export async function handleRequest(request: Request, env: Record<string, unknown>, ctx: { waitUntil?: Function }): Promise<Response> {
  const logger = getLogger(env);
  const pre = await runPreflight(request, env, ctx);
  if (pre.ok === false) return pre.response;
  if ('group' in pre.authResult && pre.authResult.group) {
    logger.info('request authorized', { key_group: pre.authResult.group, request_id: pre.requestId });
  }

  const {
    requestId, requestStartMs,
    route, requestedModel, clientWantsStream, fakeStream, bodyJson,
    limits, exposeUpstreamInfo, requestDescriptor: reqDescriptor,
    config, tiers, policy, failoverBudgetMs, knownModels, feasibility,
  } = pre;

  const requestPolicy = policy;
  const modelPlan = buildModelFallbackPlan(requestedModel, knownModels, requestPolicy.maxAttempts);
  const familyModels = new Set(modelPlan.flat().map((pass) => pass.model.trim().toLowerCase()));
  const familyFallback = familyModels.size > 1;

  // Request-local real failure domains. A logical sibling is not fresh
  // capacity when the same configured account resolves it to the same upstream
  // model that already failed earlier in this request. This set is also used by
  // wall-clock reserve planning so duplicate aliases do not reserve escape time
  // after their shared execution path is already known to have failed.
  const failedDomains = new Set<string>();
  const nodesById = new Map(config.nodes.map((node) => [node.id, node] as const));

  // Flatten only for request-plan accounting. Execution still follows the
  // bounded rounds below.
  const orderedModelPasses = modelPlan.flatMap((round, roundIndex) =>
    round.map((pass, passIndex) => ({ roundIndex, passIndex, pass })));

  const baseFeasibility = new Map<string, RouteFeasibilityResult>([[requestedModel, feasibility]]);
  const feasibilityForModel = (
    model: string,
    excludedNodeIds?: ReadonlySet<string> | null,
  ): RouteFeasibilityResult => {
    if (!excludedNodeIds?.size) {
      const cached = baseFeasibility.get(model);
      if (cached) return cached;
    }
    const descriptor = { ...reqDescriptor, model };
    const scopedTiers = excludedNodeIds?.size
      ? Object.fromEntries(TIER_ORDER.map((tierNumber) => [
        tierNumber,
        tiers[tierNumber].filter((node) => !excludedNodeIds.has(node.id)),
      ])) as Record<number, RuntimeNode[]>
      : tiers;
    const result = evaluateRouteFeasibility({
      route,
      requestedModel: model,
      requestDescriptor: descriptor,
      tiers: scopedTiers,
      knownModels,
      env,
    });
    if (!excludedNodeIds?.size) baseFeasibility.set(model, result);
    return result;
  };

  // Request-level wall-clock reserve for future FAMILY passes. The reserve is
  // request-scoped, but it is not allowed to become phantom capacity: once a
  // credential+upstreamModel failure domain is known, future aliases that only
  // resolve to that same spent domain are filtered out before reserving time.
  const futureAttemptReserveFor = (currentOrdinal: number, passAttemptCeiling: number): number => {
    if (!familyFallback) return 0;
    let slotsLeft = Math.max(0, requestPolicy.maxAttempts - passAttemptCeiling);
    if (slotsLeft === 0) return 0;
    let reserved = 0;
    for (let i = currentOrdinal + 1; i < orderedModelPasses.length && slotsLeft > 0; i++) {
      const futurePass = orderedModelPasses[i].pass;
      const excluded = failedDomainNodeIds(config.nodes, futurePass.model, failedDomains);
      if (!feasibilityForModel(futurePass.model, excluded).reachable) continue;
      const cap = futurePass.attemptCap == null ? slotsLeft : futurePass.attemptCap;
      const take = Math.min(slotsLeft, Math.max(0, cap));
      reserved += take;
      slotsLeft -= take;
    }
    return reserved;
  };

  // Three separate request-wide counters. Model switches never reset them.
  const state: LoopContext['state'] = {
    attempted: new Set<string>(), attempts: [], logicalAttempts: 0, dispatches: 0, hedges: 0,
    failureKinds: {}, logger, requestId, maxAttempts: requestPolicy.maxAttempts,
    maxDispatches: requestPolicy.maxAttempts + limits.maxHedgesPerRequest,
    requestedModel,
    nodes: config.nodes,
    knownModels,
  };

  const tier1Session = resolveTier1SessionId(request);
  const tier1Affinity = tier1Session ? await readTier1Affinity(env, tier1Session) : null;
  const tier1EvaluateAffinity = shouldEvaluateAffinity(tier1Session);
  const tier1Rng = makeTier1Rng(env);

  const loopCtx: LoopContext = {
    request, env, ctx, logger, requestId, route, requestedModel,
    clientWantsStream, fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs, policy: requestPolicy, tiers,
    tier1Affinity, tier1EvaluateAffinity, tier1Rng, tier1Session,
    knownModels, feasibility, futureAttemptReserve: 0,
  };

  let planOrdinal = 0;
  modelRoundsLoop:
  for (let roundIndex = 0; roundIndex < modelPlan.length; roundIndex++) {
    const round = modelPlan[roundIndex];
    for (let passIndex = 0; passIndex < round.length; passIndex++) {
      const pass = round[passIndex];
      const currentOrdinal = planOrdinal++;
      if (state.logicalAttempts >= requestPolicy.maxAttempts) break modelRoundsLoop;
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        state.requestedModel = requestedModel;
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }

      const effectiveModel = pass.model;
      const passStartAttempts = state.logicalAttempts;
      const passAttemptCeiling = pass.attemptCap == null
        ? requestPolicy.maxAttempts
        : Math.min(requestPolicy.maxAttempts, passStartAttempts + pass.attemptCap);
      const passPolicy = passAttemptCeiling === requestPolicy.maxAttempts
        ? requestPolicy
        : { ...requestPolicy, maxAttempts: passAttemptCeiling };

      const effectiveReqDescriptor = { ...reqDescriptor, model: effectiveModel };
      state.attempted = failedDomainNodeIds(config.nodes, effectiveModel, failedDomains);
      const domainExcluded = state.attempted.size;
      const effectiveFeasibility = feasibilityForModel(effectiveModel, state.attempted);

      // If every statically reachable path for this alias is already a spent
      // failure domain, skip it without charging an attempt or reserving time.
      if (!effectiveFeasibility.reachable) {
        if (domainExcluded > 0) {
          logger.debug(
            `model-fallback skip request=${requestId} requested=${requestedModel}`
            + ` effective=${effectiveModel} reason=spent_failure_domain`
            + ` domain_excluded=${domainExcluded}`,
          );
        }
        continue;
      }

      state.requestedModel = effectiveModel;
      const futureAttemptReserve = futureAttemptReserveFor(currentOrdinal, passAttemptCeiling);
      const effectiveLoopCtx: LoopContext = {
        ...loopCtx,
        feasibility: effectiveFeasibility,
        policy: passPolicy,
        futureAttemptReserve,
      };

      if (effectiveModel !== requestedModel || roundIndex > 0 || domainExcluded > 0) {
        logger.info(
          `model-fallback request=${requestId} round=${roundIndex + 1}/${modelPlan.length}`
          + ` requested=${requestedModel} effective=${effectiveModel}`
          + ` pass_cap=${pass.attemptCap ?? 'policy'}`
          + ` future_reserve=${futureAttemptReserve}`
          + ` domain_excluded=${domainExcluded}`
          + ` logical_attempts=${state.logicalAttempts}/${requestPolicy.maxAttempts}`,
        );
      }

      const nativeResult = await runTierLoop(effectiveLoopCtx, effectiveReqDescriptor, null);
      if (nativeResult) return nativeResult;
      rememberFailedDomains(failedDomains, nodesById, state.attempted, effectiveModel);

      if (state.logicalAttempts >= requestPolicy.maxAttempts) break modelRoundsLoop;
      if (state.logicalAttempts >= passAttemptCeiling) continue;

      // Native execution may have discovered additional spent domains. Re-plan
      // the sibling reserve before protocol fallback so those aliases do not
      // keep phantom escape time inside the remainder of this pass.
      const fallbackLoopCtx: LoopContext = {
        ...effectiveLoopCtx,
        futureAttemptReserve: futureAttemptReserveFor(currentOrdinal, passAttemptCeiling),
      };
      const fbResult = await runFallbackChain({
        loopCtx: fallbackLoopCtx,
        route,
        requestedModel: effectiveModel,
        runTierLoop,
      });
      if (fbResult) return fbResult;
      rememberFailedDomains(failedDomains, nodesById, state.attempted, effectiveModel);
    }
  }

  state.requestedModel = requestedModel;
  return buildExhaustedResponse(
    request, env, route, requestId, requestedModel, state, tiers,
    exposeUpstreamInfo, reqDescriptor, knownModels, familyFallback,
  );
}

async function runTierLoop(loopCtx: LoopContext, reqDescriptor: RoutableRequest, conversionContext: ConversionContext | null, overrideTierCaps?: Record<number, number> | null): Promise<Response | null> {
  const {
    request, env, ctx, logger, requestId, route, requestedModel,
    clientWantsStream, fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs, policy, tiers,
    tier1Affinity, tier1EvaluateAffinity, tier1Rng, tier1Session,
    knownModels, futureAttemptReserve,
  } = loopCtx;
  const tierCaps = overrideTierCaps ?? computeTierCaps(tiers, reqDescriptor, state.attempted, policy, knownModels, policy.maxInFlight ?? null);
  for (const tierNumber of TIER_ORDER) {
    const cap = tierCaps[tierNumber] ?? 0;
    let usedInTier = 0;
    const raceLostIds = new Set<string>();
    while (usedInTier < cap && state.logicalAttempts < policy.maxAttempts) {
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }
      const currentPassRemaining = countRemainingDispatchableAttempts(
        tiers, reqDescriptor, state.attempted, tierCaps,
        tierNumber, usedInTier, policy.maxAttempts - state.logicalAttempts, knownModels, policy.maxInFlight ?? null,
      );
      const requestRemaining = Math.max(1, state.maxAttempts - state.logicalAttempts);
      const remainingDispatchableAttempts = Math.max(1, Math.min(
        requestRemaining,
        currentPassRemaining + Math.max(0, futureAttemptReserve),
      ));
      const pick = pickForTier(tierNumber, tiers[tierNumber], reqDescriptor, state.attempted, {
        affinityAccountId: tierNumber === 1 ? tier1Affinity : null,
        evaluateAffinity: tierNumber === 1 && tier1EvaluateAffinity,
        rng: tier1Rng,
        knownModels,
        raceLostIds,
        maxInFlight: policy.maxInFlight ?? null,
      });
      if (!pick) break;
      if (pick.raceLost) {
        if (!pick.raceLostNodeId) break;
        raceLostIds.add(pick.raceLostNodeId);
        continue;
      }
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
