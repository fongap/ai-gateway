// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// One attempt against one node: outbound preparation, fair-share header wait,
// fetch and outcome classification. Capacity shaping is runtime-observed; no
// configured per-node RPM/concurrency gate exists here.

import { attemptHeadersTimeoutMs, attemptBudgetSliceMs } from '../../config/timeouts.ts';
import { recordNeutralEnd, bumpNodeCounters } from '../../reliability/node-state.ts';
import { releaseTier1Slot } from '../../reliability/tier1-state.ts';
import {
  classifyUpstreamStatus,
  classifyNetworkError,
  classifyClientAbort,
  classifyPreDispatchInvalidBaseUrl,
  classifyHedgeRaceLoss,
  classifyHedgeUnknown,
} from '../../reliability/classify.ts';
import { buildTargetUrl, safeReadErrorBody } from '../../protocol/http.ts';
import { isOpenAIStreamingResponse, withUsageStreamOptions } from '../../protocol/openai.ts';
import { resolveUpstreamPath, buildUpstreamHeadersFor } from '../../transport/index.ts';
import { streamUsageSupported } from '../../config/provider-quirks.ts';
import { gatewayError, buildClientErrorResponse } from '../errors.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import { handleSuccess } from './success.ts';
import { recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';

const DIAGNOSTIC_BYTES = 4096;

export async function attemptNode(c: AttemptContext): Promise<AttemptOutcome> {
  let outcome: AttemptOutcome;
  try {
    outcome = await dispatchAttempt(c);
  } catch (error) {
    // Normal transport/protocol failures are classified inside dispatchAttempt.
    // This is the finalizer for an unexpected programming/runtime exception:
    // release the scheduler claim exactly once and rotate rather than leaving
    // an isolate-local active slot or half-open probe stuck forever.
    c.state.attempted.add(c.node.id);
    if (c.node.tier === 'tier-1') {
      releaseTier1Slot(c.node.id, c.tier1ReleaseToken);
      bumpNodeCounters(c.node.id, { requests: 1 });
    } else {
      recordNeutralEnd(c.node.id);
    }
    c.state.dispatches++;
    if (!c.hedgedAttempt) c.state.logicalAttempts++;
    const message = error instanceof Error ? error.message : String(error);
    c.logger.info(
      `dispatch request=${c.requestId} node=${c.node.id} provider=${c.node.provider}`
      + ` kind=unexpected_exception neutral=true diagnostic=${JSON.stringify(message.slice(0, 200))}`,
    );
    return { rotate: true, kind: classifyHedgeUnknown().kind, budgetCharged: true };
  }

  if (outcome.budgetCharged === undefined) outcome.budgetCharged = true;
  if (outcome.response?.ok) {
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
    conversionContext,
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;

  const upstreamProtocol = conversionContext ? conversionContext.fallbackProtocol : node.protocol;
  c.upstreamProtocol = upstreamProtocol;
  const surface = conversionContext ? conversionContext.fallbackSurface : reqDescriptor.surface;
  c.surface = surface;
  const sourceBody = conversionContext ? conversionContext.convertedBody : bodyJson;
  const effectiveModel = reqDescriptor.model;
  const upstreamModel = node.models[effectiveModel] || effectiveModel;

  let outboundObject: Record<string, unknown>;
  if (route === 'openai_chat' && !conversionContext) {
    outboundObject = { ...sourceBody, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else if (conversionContext && conversionContext.fallbackSurface === 'chat_completions') {
    outboundObject = { ...sourceBody, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else {
    outboundObject = { ...sourceBody, model: upstreamModel };
  }
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
    const attemptBudgetMs = attemptBudgetSliceMs(remainingBudgetMs, remainingDispatchableAttempts);
    c.attemptDeadlineMs = Date.now() + attemptBudgetMs;
    attemptHeadersTimeout = attemptHeadersTimeoutMs(limits.headersTimeoutMs, attemptBudgetMs, 1);
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
      state.attempted.add(node.id);
      state.dispatches++;
      if (!c.hedgedAttempt) state.logicalAttempts++;
      if (node.tier === 'tier-1') {
        releaseTier1Slot(node.id, c.tier1ReleaseToken);
        bumpNodeCounters(node.id, { requests: 1 });
      } else {
        recordNeutralEnd(node.id);
      }
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

  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, DIAGNOSTIC_BYTES);
    const classification = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    recordOutcome(state, node, classification, c, {
      latencyMs,
      status: upstream.status,
      diagnostic: errorText,
    });
    if (classification.action === 'stop') {
      return {
        response: buildClientErrorResponse(
          request,
          env,
          route,
          requestId,
          requestedModel,
          upstream.status,
          errorText,
          state,
          exposeUpstreamInfo,
        ),
      };
    }
    return { rotate: true, kind: classification.kind };
  }

  const successNode = effectiveModel === requestedModel
    ? node
    : { ...node, models: { ...node.models, [requestedModel]: upstreamModel } };
  const successContext = successNode === node ? c : { ...c, node: successNode };
  return handleSuccess({
    upstream,
    c: successContext,
    targetUrl,
    latencyMs,
    detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}
