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

  const requestPolicy = policy;
  // Model-family fallback shares the configured policy budget. Build the plan
  // before deriving terminal semantics so max_attempts=1 does not pretend a
  // sibling sweep happened merely because compatible aliases exist globally.
  const modelPlan = buildModelFallbackPlan(
    requestedModel,
    knownModels,
    requestPolicy.maxAttempts,
  );
  const familyModels = new Set(
    modelPlan.flat().map((pass) => pass.model.trim().toLowerCase()),
  );
  const familyFallback = familyModels.size > 1;

  // Flatten only for request-plan accounting. Execution still follows the
  // original bounded rounds below. The flattened order lets the wall-clock
  // allocator see reachable sibling opportunities that live OUTSIDE the
  // current logical-model pass, which per-tier live counts cannot observe.
  const orderedModelPasses = modelPlan.flatMap((round, roundIndex) =>
    round.map((pass, passIndex) => ({ roundIndex, passIndex, pass })));

  const feasibilityForModel = (model: string): RouteFeasibilityResult => {
    if (model === requestedModel) return feasibility;
    const descriptor = { ...reqDescriptor, model };
    return evaluateRouteFeasibility({
      route,
      requestedModel: model,
      requestDescriptor: descriptor,
      tiers,
      knownModels,
      env,
    });
  };

  // Request-level wall-clock reserve for future FAMILY passes. PR #197's
  // reserve-aware attempt allocator is intentionally request-scoped: a current
  // model pass must not spend time that the logical attempt plan has already
  // reserved for later compatible siblings. We reserve only statically
  // reachable future pass slots and never exceed the request-wide maxAttempts.
  // Current-pass live capacity is still counted dynamically in runTierLoop.
  const futureAttemptReserveFor = (currentOrdinal: number, passAttemptCeiling: number): number => {
    if (!familyFallback) return 0;
    let slotsLeft = Math.max(0, requestPolicy.maxAttempts - passAttemptCeiling);
    if (slotsLeft === 0) return 0;
    let reserved = 0;
    for (let i = currentOrdinal + 1; i < orderedModelPasses.length && slotsLeft > 0; i++) {
      const futurePass = orderedModelPasses[i].pass;
      if (!feasibilityForModel(futurePass.model).reachable) continue;
      const cap = futurePass.attemptCap == null ? slotsLeft : futurePass.attemptCap;
      const take = Math.min(slotsLeft, Math.max(0, cap));
      reserved += take;
      slotsLeft -= take;
    }
    return reserved;
  };

  // Request-local real failure domains. A logical sibling is not fresh
  // capacity when the same configured account resolves it to the same upstream
  // model that already failed earlier in this request. Keep this separate from
  // node health/cooldown: it is only retry-budget deduplication inside this one
  // family plan, never persistent reliability state.
  const failedDomains = new Set<string>();
  const nodesById = new Map(config.nodes.map((node) => [node.id, node] as const));

  // Three SEPARATE counters, never one overloaded total:
  //   logicalAttempts — request-wide attempt budget; a primary + its optional
  //                     hedge twin together are ONE logical attempt;
  //   dispatches      — real upstream requests (pre-dispatch denies excluded);
  //   hedges          — hedge twins launched. Hard-capped by
  //                     MAX_HEDGES_PER_REQUEST; worst case
  //                     maxDispatches = maxAttempts + maxHedgesPerRequest.
  // All model-family passes share these counters and the same wall-clock
  // failover budget. Switching models never creates a fresh retry budget.
  const state: LoopContext['state'] = {
    attempted: new Set<string>(), attempts: [], logicalAttempts: 0, dispatches: 0, hedges: 0,
    failureKinds: {}, logger, requestId, maxAttempts: requestPolicy.maxAttempts,
    maxDispatches: requestPolicy.maxAttempts + limits.maxHedgesPerRequest,
    requestedModel,
    nodes: config.nodes,
    knownModels,
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
    failoverBudgetMs, requestStartMs, policy: requestPolicy, tiers,
    tier1Affinity, tier1EvaluateAffinity, tier1Rng, tier1Session,
    knownModels, feasibility, futureAttemptReserve: 0,
  };

  // Model fallback is a bounded outer loop around the EXISTING scheduler. It
  // never changes node selection, P2C, affinity, cooldown, hedge, tier order,
  // protocol conversion, or reliability state machines. Each logical-model
  // pass gets a fresh request-local attempted set, seeded only with REAL
  // account/model failure domains already spent by earlier family passes.
  // Therefore the same account can still serve a genuinely different upstream
  // model, while aliases that collapse to the same upstream target cannot burn
  // the request budget repeatedly. The second round can still discover nodes
  // that were unavailable (and therefore never attempted) in the first round.
  //
  // Family allocation is derived from the configured max_attempts. Small
  // budgets widen across compatible siblings first; larger budgets deepen the
  // requested model toward the established 3/2/1 preference. A re-check pass
  // gets at most one attempt per eligible family member and can only spend
  // request budget that earlier passes left unused.

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
      const effectiveFeasibility = feasibilityForModel(effectiveModel);

      // A family member that has no statically reachable route costs no
      // attempt and does not block later siblings. Runtime cooldown/circuit
      // availability is still evaluated inside the normal tier loop.
      if (!effectiveFeasibility.reachable) continue;

      state.attempted = failedDomainNodeIds(config.nodes, effectiveModel, failedDomains);
      const domainExcluded = state.attempted.size;
      // Reliability state is keyed to the model actually being routed. The
      // client-facing requested model remains loopCtx.requestedModel and is
      // preserved in response bodies; only this request-local reliability key
      // changes between family passes.
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

      // Native-first for this logical model.
      const nativeResult = await runTierLoop(effectiveLoopCtx, effectiveReqDescriptor, null);
      if (nativeResult) return nativeResult;
      rememberFailedDomains(failedDomains, nodesById, state.attempted, effectiveModel);

      if (state.logicalAttempts >= requestPolicy.maxAttempts) break modelRoundsLoop;
      // This model spent its reserved share. Move to its sibling instead of
      // letting the first alias starve family fallback. If the native path did
      // not consume the whole share, protocol fallback may use the remainder.
      if (state.logicalAttempts >= passAttemptCeiling) continue;

      // Then run the existing cross-protocol fallback chain for this SAME
      // effective logical model. Native + protocol fallback share this pass's
      // cap and the request-wide attempt/wall-clock budget. The attempted set
      // already contains common failure-domain exclusions, so protocol fallback
      // cannot resurrect an alias of a domain spent by an earlier model pass.
      const fbResult = await runFallbackChain({
        loopCtx: effectiveLoopCtx,
        route,
        requestedModel: effectiveModel,
        runTierLoop,
      });
      if (fbResult) return fbResult;
      rememberFailedDomains(failedDomains, nodesById, state.attempted, effectiveModel);
    }
  }

  // Restore the external model identity for the terminal error response. Any
  // successful streaming response returned above deliberately leaves
  // state.requestedModel on its effective model so late stream completion /
  // interruption callbacks update the correct reliability bucket.
  state.requestedModel = requestedModel;
  return buildExhaustedResponse(
    request, env, route, requestId, requestedModel, state, tiers,
    exposeUpstreamInfo, reqDescriptor, knownModels, familyFallback,
  );
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
      // The dispatch deadline allocator must see the REQUEST plan, not only the
      // current logical-model pass. Add the sibling slots reserved by handler
      // and cap by the original request-wide maxAttempts. This changes only
      // wall-clock allocation; selection and logical-attempt accounting remain
      // owned by the existing tier/model loops.
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
        // A concurrent request claimed the candidate after selection. Exclude
        // that exact node from this tier pass and re-evaluate without charging
        // a logical attempt. Missing identity would make progress unverifiable,
        // so fail closed for this tier instead of spinning on the same pick.
        if (!pick.raceLostNodeId) break;
        raceLostIds.add(pick.raceLostNodeId);
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
