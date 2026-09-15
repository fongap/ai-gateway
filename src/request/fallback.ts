// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Protocol Fallback Orchestration.
//
// Supported conversions (see SUPPORTED_CONVERSIONS in protocol-fallbacks.ts
// for the single source of truth):
//   * Anthropic Messages -> OpenAI Chat Completions
//   * OpenAI Chat Completions -> Anthropic Messages
// Fallback follows the resolved PROTOCOL_FALLBACKS policy, including the
// built-in bidirectional Chat/Messages default when the variable is unset.
// OpenAI Responses is native-only (no fallback to other protocols), and there
// is no Gemini conversion.
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
//   * If conversion throws ConversionError, or would drop high-risk semantic
//     state, that fallback target is skipped before any upstream dispatch.
//     The client request is still legal; the target protocol is incompatible.
//     No logical attempt, dispatch, hedge, active-request, cooldown or circuit
//     state is charged for a skipped conversion.
//   * Successful conversion emits a debug-only fidelity record. Diagnostics
//     contain only fixed feature/action labels; request content, schemas, tool
//     names and credentials are never logged.
//   * If every recognized fallback target is rejected before any upstream
//     dispatch, return a dedicated 502 instead of misreporting the condition as
//     node cooldown/circuit exhaustion.

import {
  convertAnthropicToOpenAIResult,
  convertOpenAIChatToAnthropicResult,
} from '../conversion/result.ts';
import { ConversionError } from '../conversion/validation.ts';
import { getLogger } from '../observability/logger.ts';
import { buildBudgetExhaustedResponse, gatewayError } from './errors.ts';
import { computeTierCaps } from './tier-loop.ts';
import type { ConversionResult } from '../conversion/result.ts';
import type { LoopContext, ConversionContext } from '../types/request.ts';
import type { RoutableRequest } from '../types/scheduler.ts';

const HIGH_RISK_DROPPED_FEATURES = new Set([
  'provider_native_tool',
  'provider_native_tool_history',
  'thinking_history',
  'context_management',
  'tool_result_error_marker',
]);

type TierLoopRunner = (
  loopCtx: LoopContext,
  reqDescriptor: RoutableRequest,
  conversionContext: ConversionContext | null,
  overrideTierCaps: Record<number, number> | null,
) => Promise<Response | null>;

function highRiskSemanticLoss(result: ConversionResult): string[] {
  return result.diagnostics
    .filter((d) => d.action === 'dropped' && HIGH_RISK_DROPPED_FEATURES.has(d.feature))
    .map((d) => d.feature);
}

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
  let conversionRejectedCount = 0;
  let convertedTargetCount = 0;

  for (const fb of fallbacks) {
    if (state.logicalAttempts >= policy.maxAttempts) break;
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    if (remainingBudgetMs <= 0) {
      return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
    }
    const fbReqDescriptor: RoutableRequest = { model: requestedModel, protocol: fb.protocol, surface: fb.surface };
    let conversionResult: ConversionResult;
    try {
      if (route === 'anthropic_messages' && fb.protocol === 'openai' && fb.surface === 'chat_completions') {
        // Unknown OpenAI-compatible targets intentionally keep the established
        // prompt structured-output strategy. Native/tool modes require positive
        // capability evidence and are not inferred from provider names here.
        conversionResult = convertAnthropicToOpenAIResult(bodyJson);
      } else if (route === 'openai_chat' && fb.protocol === 'anthropic' && fb.surface === 'messages') {
        conversionResult = convertOpenAIChatToAnthropicResult(bodyJson);
      } else {
        continue;
      }
    } catch (e) {
      if (e instanceof ConversionError) {
        conversionRejectedCount++;
        const reason = String(e.message || e.code || 'conversion_not_supported').slice(0, 300);
        logger.error(JSON.stringify({
          event: 'fallback_conversion_skipped',
          request_id: requestId,
          route,
          fallback_protocol: fb.protocol,
          fallback_surface: fb.surface,
          reason,
        }));
        continue;
      }
      throw e;
    }

    // Debug-only: provides an exact denominator for fidelity analysis when an
    // operator enables debug logging, without adding default per-request noise.
    logger.debug(JSON.stringify({
      event: 'fallback_conversion',
      request_id: requestId,
      route,
      fallback_protocol: fb.protocol,
      fallback_surface: fb.surface,
      fidelity: conversionResult.fidelity,
      diagnostic_count: conversionResult.diagnostics.length,
      diagnostics: conversionResult.diagnostics,
      ...(conversionResult.structuredOutput
        ? { structured_output_strategy: conversionResult.structuredOutput.strategy }
        : {}),
    }));

    const highRiskLoss = highRiskSemanticLoss(conversionResult);
    if (highRiskLoss.length > 0) {
      conversionRejectedCount++;
      logger.error(JSON.stringify({
        event: 'fallback_conversion_skipped',
        request_id: requestId,
        route,
        fallback_protocol: fb.protocol,
        fallback_surface: fb.surface,
        reason: 'high_risk_semantic_loss',
        features: highRiskLoss,
      }));
      continue;
    }

    convertedTargetCount++;
    // Protocol fallback must preserve the same explicit Tier 1 admission
    // contract as the native pass. Omitting maxInFlight here overstates live
    // capacity and can distort tier caps / fair-share timeout slicing before
    // the downstream picker eventually rejects the saturated account.
    const fbTierCaps = computeTierCaps(
      tiers, fbReqDescriptor, state.attempted, policy, knownModels,
      policy.maxInFlight ?? null,
    );
    const conversionContext: ConversionContext = {
      convertedBody: conversionResult.body,
      fallbackProtocol: fb.protocol,
      fallbackSurface: fb.surface,
      clientRoute: route,
    };
    const fbResult = await runTierLoop(loopCtx, fbReqDescriptor, conversionContext, fbTierCaps);
    if (fbResult) return fbResult;
  }

  if (conversionRejectedCount > 0 && convertedTargetCount === 0 && state.dispatches === 0) {
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
