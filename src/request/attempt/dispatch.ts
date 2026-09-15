// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// dispatch.ts - one attempt against one node: outbound preparation (URL,
// headers, body, conversion context), reserve-aware attempt deadline,
// the upstream fetch, and the classification entry points for non-OK /
// network / client-abort outcomes. Success handling lives in success.ts;
// the hedge race lives in hedge.ts.

import { attemptHeadersTimeoutMs, attemptBudgetWindowMs } from '../../config/timeouts.ts';
import { recordNeutralEnd, bumpNodeCounters } from '../../reliability/node-state.ts';
import { releaseTier1Slot } from '../../reliability/tier1-state.ts';
import { classifyUpstreamStatus, classifyNetworkError, classifyClientAbort, classifyPreDispatchInvalidBaseUrl, classifyHedgeRaceLoss } from '../../reliability/classify.ts';
import { buildTargetUrl, safeReadErrorBody } from '../../protocol/http.ts';
import { isOpenAIStreamingResponse, withUsageStreamOptions } from '../../protocol/openai.ts';
import { resolveUpstreamPath, buildUpstreamHeadersFor } from '../../transport/index.ts';
import { streamUsageSupported } from '../../config/provider-quirks.ts';
import { reportedUsageFromJsonText } from '../../observability/reported-usage.ts';
import { gatewayError, buildClientErrorResponse } from '../errors.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import { handleSuccess } from './success.ts';
import { recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';

const DIAGNOSTIC_BYTES = 4096;

// AttemptContext and AttemptOutcome are defined in src/types/request.ts
// (the cross-module source of truth). attempt.ts receives its context from
// handler.ts via dispatchWithHedge(args, tierNodes).

// ---- One attempt against one node -----------------------------------------

// Wrapper around dispatchAttempt. Every path inside either contacted (or tried
// to contact) an upstream — charging failover budget by default — or opted out
// explicitly on a pre-dispatch path. Normalizing here guarantees every outcome
// carries a defined `budgetCharged`, so the main loop never has to infer
// charging from a failure-kind string. Successful dispatches get one debug
// line here (failures log their own dispatch line inside recordOutcome), so
// every upstream dispatch emits exactly one completion record.
export async function attemptNode(c: AttemptContext): Promise<AttemptOutcome> {
  const outcome = await dispatchAttempt(c);
  // Some hedge-loss paths intentionally bypass recordOutcome() because they are
  // neutral reliability outcomes. They still contacted an upstream, so close
  // the physical-attempt accounting slot here. The settlement helper is
  // idempotent, therefore the headers-phase hedge path (which settles earlier)
  // is not double-counted.
  if (outcome.hedgedAway) recordUndeliveredUpstreamAttempt(c, c.node);
  if (outcome.budgetCharged === undefined) outcome.budgetCharged = true;
  if (outcome.response?.ok) {
    // Successful dispatches never pass through recordOutcome, so charge them
    // here — exactly once, like every failure/neutral path. A committed
    // response reached an upstream, so it always charges the dispatch count;
    // a hedge twin still never charges the logical attempt.
    c.state.dispatches++;
    if (!c.hedgedAttempt) c.state.logicalAttempts++;
    const effectiveModel = c.reqDescriptor.model;
    c.logger.debug(
      `dispatch request=${c.requestId} logical_attempt=${c.state.logicalAttempts}/${c.state.maxAttempts}`
      + ` dispatch=${c.state.dispatches} node=${c.node.id} provider=${c.node.provider}`
      + ` protocol=${c.upstreamProtocol ?? c.node.protocol} surface=${c.surface} tier=${c.node.tier}`
      + ` model=${c.requestedModel}${effectiveModel !== c.requestedModel ? `=>${effectiveModel}` : ''}->${upstreamModelOf(c.node, effectiveModel)}`
      + ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=ok status=${outcome.response.status}`
      + ` headers_ms=${c.headersMs ?? -1}${c.ttftMs !== undefined ? ` ttft_ms=${c.ttftMs}` : ''}`
      + ` latency_ms=${c.attemptStartMs ? Date.now() - c.attemptStartMs : -1}`,
    );
  }
  return outcome;
}

async function dispatchAttempt(c: AttemptContext): Promise<AttemptOutcome> {
  const {
    request, env, logger, requestId, route, node, requestedModel, clientWantsStream,
    fakeStream, bodyJson, limits, exposeUpstreamInfo, state,
    failoverBudgetMs, requestStartMs, remainingDispatchableAttempts, reqDescriptor,
    policy, conversionContext,
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;
  // For cross-protocol fallback the upstream protocol/surface come from the
  // conversion context (the fallback target), NOT from the node's native
  // protocol. The transport must use the FALLBACK protocol so the right
  // upstream path, headers and stream semantics are used. The node's own
  // protocol stays correct for the native path.
  const upstreamProtocol = conversionContext ? conversionContext.fallbackProtocol : node.protocol;
  c.upstreamProtocol = upstreamProtocol;
  const surface = conversionContext ? conversionContext.fallbackSurface : reqDescriptor.surface;
  c.surface = surface;
  const sourceBody = conversionContext ? conversionContext.convertedBody : bodyJson;

  // `requestedModel` is the client-facing identity and remains stable across
  // transparent model-family fallback. `reqDescriptor.model` is the effective
  // logical alias currently being routed. The node mapping MUST use the latter
  // so a Max request transparently falling back to Pro resolves the Pro
  // upstream mapping while the response can still be rewritten to Max.
  const effectiveModel = reqDescriptor.model;
  const upstreamModel = node.models[effectiveModel] || effectiveModel;
  let outboundObject: Record<string, unknown>;
  if (route === 'openai_chat' && !conversionContext) {
    outboundObject = { ...sourceBody, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else if (conversionContext && conversionContext.fallbackSurface === 'chat_completions') {
    outboundObject = { ...sourceBody, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else {
    // openai_responses -> native /v1/responses body
    // anthropic_messages -> native /v1/messages body
    // cross-protocol fallback to a non-chat surface (future use)
    outboundObject = { ...sourceBody, model: upstreamModel };
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

  let targetUrl: URL | string;
  try {
    targetUrl = buildTargetUrl(node.baseUrl, resolveUpstreamPath(upstreamProtocol, surface));
  } catch {
    return rotateWithNeutralEnd(state, node, classifyPreDispatchInvalidBaseUrl().kind, c, true);
  }

  const headers = buildUpstreamHeadersFor(upstreamProtocol, request, node.credential, requestId);
  const controller = new AbortController();
  let headersTimeoutHit = false;
  if (c.hedgeAbort) {
    const onHedgeAbort = () => controller.abort();
    if (c.hedgeAbort.signal.aborted) onHedgeAbort();
    else c.hedgeAbort.signal.addEventListener('abort', onHedgeAbort, { once: true });
  }
  let attemptHeadersTimeout: number;
  if (c.hedgedAttempt && c.attemptDeadlineMs) {
    attemptHeadersTimeout = attemptHeadersTimeoutMs(
      limits.headersTimeoutMs,
      Math.max(1, c.attemptDeadlineMs - Date.now()),
      1,
    );
  } else {
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    const attemptBudgetMs = attemptBudgetWindowMs(remainingBudgetMs, remainingDispatchableAttempts);
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
  let upstream: Response;
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
      // A peer committed first. This still was a real physical dispatch, but
      // it is a neutral reliability end and carries no successful-delivery
      // evidence. Finalize its upstream-attempt accounting before returning.
      recordUndeliveredUpstreamAttempt(c, node);
      state.attempted.add(node.id);
      state.dispatches++;
      if (!c.hedgedAttempt) state.logicalAttempts++;
      if (node.tier === 'tier-1') {
        releaseTier1Slot(node.id, c.tier1ReleaseToken);
        bumpNodeCounters(node.id, { requests: 1 });
      } else recordNeutralEnd(node.id);
      logger.info(
        `hedge loser: request=${requestId} node=${node.id} phase=headers`
        + ` reason=cancelled_after_peer_commit neutral=true latency_ms=${latencyMs}`,
      );
      return { rotate: true, hedgedAway: true, kind: classifyHedgeRaceLoss().kind };
    }
    const classification = classifyNetworkError(headersTimeoutHit);
    recordOutcome(state, node, classification, c, { latencyMs });
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.debug(`upstream fetch failed on ${node.id}: ${errorMessage}`);
    return { rotate: true, kind: classification.kind };
  }
  clearTimeout(timeoutId);
  const latencyMs = Date.now() - startMs;
  c.headersMs = latencyMs;

  // ---- Non-OK response ----
  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, DIAGNOSTIC_BYTES, c.attemptDeadlineMs);
    const classification = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    // Some compatible providers include usage even on an HTTP error. Preserve
    // only that explicit report; malformed/non-JSON bodies remain "missing".
    recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromJsonText(errorText));
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorText });
    if (classification.action === 'stop') {
      return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, upstream.status, errorText, state, exposeUpstreamInfo) };
    }
    return { rotate: true, kind: classification.kind };
  }

  const successNode = effectiveModel === requestedModel
    ? node
    : { ...node, models: { ...node.models, [requestedModel]: upstreamModel } };
  const successContext = successNode === node ? c : { ...c, node: successNode };

  return handleSuccess({
    upstream, c: successContext, targetUrl, latencyMs, detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}
