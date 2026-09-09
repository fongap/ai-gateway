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
//     or circuit breaker state. The target is skipped and a safe diagnostic is
//     emitted with only request identity, route, target protocol/surface and
//     the converter's reason string — never request content or credentials.
//   * If every recognized fallback target is rejected by conversion before any
//     upstream dispatch, return a dedicated 502 instead of misreporting the
//     condition as node cooldown/circuit exhaustion.

import { convertAnthropicToOpenAIRequest, ConversionError } from '../conversion/anthropic-to-openai.ts';
import { convertOpenAIChatRequestToAnthropic } from '../conversion/openai-chat-request-to-anthropic.ts';
import { getLogger } from '../observability/logger.ts';
import { buildBudgetExhaustedResponse, gatewayError } from './errors.ts';
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
  const logger = getLogger(env);
  let conversionErrorCount = 0;
  let convertedTargetCount = 0;

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
        conversionErrorCount++;
        const reason = String(e.message || e.code || 'conversion_not_supported').slice(0, 300);
        logger.error(JSON.stringify({
          event: 'fallback_conversion_skipped',
          request_id: requestId,
          route,
          fallback_protocol: fb.protocol,
          fallback_surface: fb.surface,
          reason,
        }));
        // This fallback target cannot express the request. The client request
        // is legal; the target protocol is incompatible. Conversion happens
        // before dispatch, so no reliability state is touched.
        continue;
      }
      throw e;
    }

    convertedTargetCount++;
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

  if (conversionErrorCount > 0 && convertedTargetCount === 0 && state.dispatches === 0) {
    return gatewayError(
      request,
      env,
      route,
      502,
      'Configured protocol fallback cannot represent this request.',
      requestId,
      {
        requested_model: requestedModel,
        attempts: state.logicalAttempts,
        dispatches: state.dispatches,
        hedges: state.hedges,
        failure_kind: 'conversion_not_supported',
      },
    );
  }

  return null;
}
