// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Protocol Fallback Orchestration.
//
// Only Anthropic Messages -> OpenAI Chat Completions is supported,
// and only when PROTOCOL_FALLBACKS is explicitly configured for the
// client route. There is no implicit cross-protocol fallback, no
// Chat -> Anthropic direction, no OpenAI Responses -> Chat direction,
// and no Gemini conversion.
//
// Contract:
//   * Native-first: the native tier loop runs first and only when it
//     returns null (all tiers exhausted without a response) does the
//     fallback chain get a chance.
//   * Shared state: the fallback loop reuses the SAME state, the
//     SAME failover budget, the SAME requestStartMs, the SAME
//     logicalAttempts counter, the SAME dispatches counter, and the
//     SAME hedges counter. There is no fresh budget and no reset.
//   * Hedge never crosses protocol/surface: the scheduler's
//     (protocol, surface) filter excludes foreign nodes, so a hedge
//     twin is always same-protocol and same-surface as its primary.
//     Whether hedge is allowed inside a fallback pass is determined
//     by the normal policy and tier hedge rules — the fallback chain
//     does not suppress it, nor does it launch cross-protocol twins.
//   * Each fallback step that has a supported candidate re-runs the
//     tier loop. The first step that returns a Response wins. The set of
//     reachable fallback steps is precomputed by route-feasibility.js at
//     preflight time and carried through loopCtx.feasibility; runFallbackChain
//     iterates that set rather than re-implementing the feasibility check.
//   * If the conversion itself throws ConversionError, the request
//     is answered with 400 (the request was malformed for the
//     fallback protocol). Other conversion errors propagate.
//   * If the fallback chain is exhausted, the request falls through
//     to the standard exhausted handler.

import { anthropicErrorResponse } from '../protocol/anthropic.js';
import { convertAnthropicToOpenAIRequest, ConversionError } from '../conversion/anthropic-to-openai.js';
import { buildBudgetExhaustedResponse } from './errors.js';
import { computeTierCaps } from './tier-loop.js';

/**
 * Run the cross-protocol fallback chain.
 *
 * @param {{
 *   loopCtx: Record<string, any>,
 *   route: string,
 *   requestedModel: string,
 *   runTierLoop: (loopCtx: any, reqDescriptor: any, conversionContext: any, overrideTierCaps: any) => Promise<Response | null>,
 * }} args
 * @returns {Promise<Response | null>}
 */
export async function runFallbackChain({ loopCtx, route, requestedModel, runTierLoop }) {
  const {
    env, requestId, exposeUpstreamInfo, request, state, policy,
    failoverBudgetMs, requestStartMs, tiers, bodyJson, knownModels,
    feasibility,
  } = loopCtx;
  const fallbacks = feasibility?.fallbacks ?? [];
  for (const fb of fallbacks) {
    if (state.logicalAttempts >= policy.maxAttempts) break;
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    if (remainingBudgetMs <= 0) {
      return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
    }
    const fbReqDescriptor = { model: requestedModel, protocol: fb.protocol, surface: fb.surface };
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
    const fbTierCaps = computeTierCaps(tiers, fbReqDescriptor, state.attempted, policy, knownModels);
    const conversionContext = {
      convertedBody,
      fallbackProtocol: fb.protocol,
      fallbackSurface: fb.surface,
      clientRoute: route,
    };
    const fbResult = await runTierLoop(loopCtx, fbReqDescriptor, conversionContext, fbTierCaps);
    if (fbResult) return fbResult;
  }
  return null;
}
