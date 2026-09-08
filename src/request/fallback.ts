// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Protocol Fallback Orchestration.
//
// Supported conversions (see SUPPORTED_CONVERSIONS in protocol-fallbacks.ts
// for the single source of truth):
//   * Anthropic Messages -> OpenAI Chat Completions
//   * OpenAI Chat Completions -> Anthropic Messages
// A conversion is only available when PROTOCOL_FALLBACKS is configured for
// the client route. There is no implicit cross-protocol fallback, no
// OpenAI Responses -> Chat direction, and no Gemini conversion.
// OpenAI Responses is native-only (no fallback to other protocols).
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
//     reachable fallback steps is precomputed by route-feasibility.ts at
//     preflight time and carried through loopCtx.feasibility; runFallbackChain
//     iterates that set rather than re-implementing the feasibility check.
//   * If the conversion itself throws ConversionError, that fallback target
//     simply cannot express this request (the client request is still legal —
//     it is the TARGET protocol that is incompatible). The conversion happens
//     before any upstream dispatch, so it never touches logicalAttempts,
//     dispatches, hedges, activeRequests, node RPM, node failure, cooldown,
//     or circuit breaker state. The current fallback target is SKIPPED and
//     the next one is tried.
//   * If the fallback chain is exhausted, the request falls through
//     to the standard exhausted handler (a 502/503 gateway failure, never a
//     client 400).

import { convertAnthropicToOpenAIRequest, ConversionError } from '../conversion/anthropic-to-openai.ts';
import { convertOpenAIChatRequestToAnthropic } from '../conversion/openai-chat-request-to-anthropic.ts';
import { buildBudgetExhaustedResponse } from './errors.ts';
import { computeTierCaps } from './tier-loop.ts';
import type { LoopContext, ConversionContext } from '../types/request.ts';
import type { RoutableRequest } from '../types/scheduler.ts';

type TierLoopRunner = (
  loopCtx: LoopContext,
  reqDescriptor: RoutableRequest,
  conversionContext: ConversionContext | null,
  overrideTierCaps: Record<number, number> | null,
) => Promise<Response | null>;

/**
 * Run the cross-protocol fallback chain.
 */
export async function runFallbackChain({ loopCtx, route, requestedModel, runTierLoop }: {
  loopCtx: LoopContext,
  route: string,
  requestedModel: string,
  runTierLoop: TierLoopRunner,
}): Promise<Response | null> {
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
    const fbReqDescriptor: RoutableRequest = { model: requestedModel, protocol: fb.protocol, surface: fb.surface };
    let convertedBody;
    try {
      if (route === 'anthropic_messages' && fb.protocol === 'openai' && fb.surface === 'chat_completions') {
        convertedBody = convertAnthropicToOpenAIRequest(bodyJson);
      } else if (route === 'openai_chat' && fb.protocol === 'anthropic' && fb.surface === 'messages') {
        convertedBody = convertOpenAIChatRequestToAnthropic(bodyJson);
      } else {
        continue;
      }
    } catch (e) {
      if (e instanceof ConversionError) {
        // This fallback target cannot express the request (e.g. an Anthropic
        // `thinking` block with no OpenAI equivalent). The client request is
        // legal — the TARGET is incompatible — so this is NOT a client 400.
        // Conversion happens before dispatch, so no reliability counter has
        // been touched. Skip this target and try the next fallback in the
        // chain. If every target is exhausted, runFallbackChain returns null
        // and the standard exhausted handler produces the gateway failure.
        continue;
      }
      throw e;
    }
    const fbTierCaps = computeTierCaps(tiers, fbReqDescriptor, state.attempted, policy, knownModels);
    const conversionContext: ConversionContext = {
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
