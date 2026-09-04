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
// no Gemini conversion, and no cross-protocol hedge.
//
// Contract:
//   * Native-first: the native tier loop runs first and only when it
//     returns null (all tiers exhausted without a response) does the
//     fallback chain get a chance.
//   * Shared state: the fallback loop reuses the SAME state, the
//     SAME failover budget, the SAME requestStartMs, the SAME
//     logicalAttempts counter, the SAME dispatches counter, and the
//     SAME hedges counter. There is no fresh budget and no reset.
//   * Hedge does not cross protocols: the scheduler's
//     (protocol, surface) filter excludes foreign nodes anyway, but
//     the loop also never launches a hedge inside a fallback pass.
//   * Each fallback step that has a supported candidate re-runs the
//     tier loop. The first step that returns a Response wins.
//   * If the conversion itself throws ConversionError, the request
//     is answered with 400 (the request was malformed for the
//     fallback protocol). Other conversion errors propagate.
//   * If the fallback chain is exhausted, the request falls through
//     to the standard exhausted handler.
//
// PR 5 is a behavior-preserving refactor: the fallback body stays
// in handler.js for now; this module establishes the long-term
// boundary and the contract comment. The handler imports
// runFallbackChain and passes its own runTierLoop closure in,
// avoiding a circular import.

import { supportsRequest } from '../scheduler/scheduler.js';
import { TIER_ORDER } from './router.js';
import { anthropicErrorResponse } from '../protocol/anthropic.js';
import { convertAnthropicToOpenAIRequest, ConversionError } from '../conversion/anthropic-to-openai.js';
import { getFallbackChain } from '../config/protocol-fallbacks.js';
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
  } = loopCtx;
  const fallbacks = getFallbackChain(route, env);
  for (const fb of fallbacks) {
    if (state.logicalAttempts >= policy.maxAttempts) break;
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    if (remainingBudgetMs <= 0) {
      return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
    }
    const fbReqDescriptor = { model: requestedModel, protocol: fb.protocol, surface: fb.surface };
    const fbSupported = TIER_ORDER.some((t) =>
      tiers[t].some((n) => supportsRequest(n, fbReqDescriptor, knownModels)));
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
