// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// dispatch.ts - one attempt against one node: outbound preparation (URL,
// headers, body, conversion context), timeout acquisition (fair-share header
// wait), the upstream fetch, and the classification entry points for
// non-OK / network / client-abort outcomes. Success handling lives in
// success.ts; the hedge race lives in hedge.ts.

import { attemptHeadersTimeoutMs, attemptBudgetSliceMs } from '../../config/timeouts.ts';
import { recordNeutralEnd, rollbackRpmBucket, bumpNodeCounters } from '../../reliability/node-state.ts';
import { releaseTier1Slot, rollbackTier1Rpm } from '../../reliability/tier1-state.ts';
import { classifyUpstreamStatus, classifyNetworkError, classifyClientAbort, classifyPreDispatchRateLimit, classifyPreDispatchInvalidBaseUrl, classifyHedgeRaceLoss } from '../../reliability/classify.ts';
import { buildTargetUrl, safeReadErrorBody } from '../../protocol/http.ts';
import { isOpenAIStreamingResponse, withUsageStreamOptions } from '../../protocol/openai.ts';
import { resolveUpstreamPath, buildUpstreamHeadersFor } from '../../transport/index.ts';
import { streamUsageSupported } from '../../config/provider-quirks.ts';
import { gatewayError, buildClientErrorResponse } from '../errors.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import { handleSuccess } from './success.ts';
import { recordOutcome, rotateWithNeutralEnd, noteFailure } from './outcome.ts';
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
  if (outcome.budgetCharged === undefined) outcome.budgetCharged = true;
  if (outcome.response?.status === 200) {
    // Successful dispatches never pass through recordOutcome, so charge them
    // here — exactly once, like every failure/neutral path. A committed
    // response reached an upstream, so it always charges the dispatch count;
    // a hedge twin still never charges the logical attempt.
    c.state.dispatches++;
    if (!c.hedgedAttempt) c.state.logicalAttempts++;
    c.logger.debug(
      `dispatch request=${c.requestId} logical_attempt=${c.state.logicalAttempts}/${c.state.maxAttempts}`
      + ` dispatch=${c.state.dispatches} node=${c.node.id} provider=${c.node.provider}`
      + ` protocol=${c.upstreamProtocol ?? c.node.protocol} surface=${c.surface} tier=${c.node.tier}`
      + ` model=${c.requestedModel}->${upstreamModelOf(c.node, c.requestedModel)}`
      + ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=ok status=200`
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

  // Native outbound body: the client request is forwarded verbatim to the
  // upstream of the SAME protocol+surface, with only the model name
  // substituted. No cross-protocol or cross-surface conversion exists.
  // Cross-protocol fallback path uses the converted body built by the
  // conversionContext, with only the upstream model name rewritten.
  const upstreamModel = node.models[requestedModel] || requestedModel;
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

  // ---- Optional distributed rate shaping (Cloudflare Rate Limiting) ---------
  // isolate-local RPM/concurrency state can only shape traffic per Worker
  // isolate; several isolates share the same upstream key. Binding a Workers
  // Rate Limiting binding as QUOTA_RATE_LIMITER adds a distributed (per-Cloudflare
  // location) fixed-window check before dispatch. NOTE: Cloudflare Rate Limiting
  // is counted per location, permissive and eventually consistent — it is NOT a
  // strict global/account quota, and its threshold is fixed at the binding
  // (limit=N, period=60), so it cannot express a different per-node
  // limits.rpm value. Treat it as approximate distributed shaping; the local
  // hard/soft semantics remain the source of truth for exact per-node counts.
  const rateLimiter = env?.QUOTA_RATE_LIMITER as { limit?: (args: { key: string }) => Promise<{ success?: boolean }> } | null | undefined;
  if (node.limits.rpmMode === 'hard' && typeof rateLimiter?.limit === 'function') {
    try {
      const verdict = await rateLimiter.limit({ key: node.id });
      if (verdict && verdict.success === false) {
        // Distributed-limit denied: the request never reached an upstream, so
        // it must NOT consume any failover budget — neither the shared attempt
        // budget (maxAttempts) nor this tier's own attempt slot — otherwise a
        // run of CF-denied keys starves same-tier healthy candidates and every
        // fallback tier without ever contacting a provider. It also must not
        // charge the node's local RPM: release the slot AND roll back the RPM
        // reservation acquireSlot just made. Mark the node attempted so it is
        // not re-picked this request; the tier drains via `attempted` rather
        // than the budgets.
        state.attempted.add(node.id);
        if (node.tier === 'tier-1') {
          releaseTier1Slot(node.id, c.tier1ReleaseToken);
          rollbackTier1Rpm(node.id);
        } else {
          recordNeutralEnd(node.id);
          rollbackRpmBucket(node.id);
        }
        const preDispatchKind = classifyPreDispatchRateLimit().kind;
        noteFailure(state, preDispatchKind);
        state.logger.info(
          `dispatch request=${requestId} logical_attempt=${state.logicalAttempts + 1}/${state.maxAttempts}`
          + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
          + ` protocol=${upstreamProtocol} surface=${surface} tier=${node.tier}`
          + ` model=${requestedModel}->${upstreamModelOf(node, requestedModel)}`
          + ` hedged=false kind=${preDispatchKind} status=429 counted=false (pre-dispatch, no budget charged)`,
        );
        state.attempts.push({ attempt: state.logicalAttempts + 1, dispatch: state.dispatches, node_id: node.id, status: 429, kind: preDispatchKind, hedged: false });
        return { rotate: true, budgetCharged: false };
      }
    } catch {
      // A broken coordinator must never take the gateway down: proceed and let
      // the local limits + circuit breaker do their job.
    }
  }

  // Protocol-aware upstream headers: OpenAI nodes authenticate with
  // Authorization Bearer, Anthropic nodes with x-api-key + anthropic-version.
  // The client's own gateway key never reaches the upstream for either.
  const headers = buildUpstreamHeadersFor(upstreamProtocol, request, node.credential, requestId);
  const controller = new AbortController();
  let headersTimeoutHit = false;
  // A hedged twin loses the race by being aborted: once the winning attempt
  // commits its response, the twin's controller fires and both the upstream
  // fetch and the first-event guard unwind through their normal error paths.
  if (c.hedgeAbort) {
    const onHedgeAbort = () => controller.abort();
    if (c.hedgeAbort.signal.aborted) onHedgeAbort();
    else c.hedgeAbort.signal.addEventListener('abort', onHedgeAbort, { once: true });
  }
  // Cap this attempt's own wait by a FAIR SHARE of the remaining whole-request
  // budget instead of letting one node consume UPSTREAM_HEADERS_TIMEOUT_MS in
  // full: the budget is split across the attempts that may still be needed, so
  // a slow first candidate no longer starves every later one. The last
  // remaining attempt keeps the entire remaining budget (share = remaining),
  // and the wait never exceeds UPSTREAM_HEADERS_TIMEOUT_MS.
  //
  // A hedged TWIN does not get a fresh slice: it inherits the logical
  // attempt's absolute deadline (primary + twin share ONE budget), so its
  // header wait is simply the time left until that deadline.
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
      // Lost the hedge race: the upstream was healthy, just slower than its
      // twin. Neutral end — no health penalty, no cooldown, no circuit
      // failure; it still counts as a real dispatch because it did contact
      // an upstream (the twin charges dispatches, never logicalAttempts).
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
    // The classification kind MUST travel with the rotate outcome: hedge
    // logging reads it from the settled outcome, and dropping it here used to
    // surface as primary_kind=unknown / twin_kind=unknown even though the
    // error was already classified.
    return { rotate: true, kind: classification.kind };
  }
  clearTimeout(timeoutId);
  const latencyMs = Date.now() - startMs;
  c.headersMs = latencyMs;

  // ---- Non-OK response ----
  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, DIAGNOSTIC_BYTES);
    const classification = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorText });
    if (classification.action === 'stop') {
      return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, upstream.status, errorText, state, exposeUpstreamInfo) };
    }
    return { rotate: true, kind: classification.kind };
  }

  return handleSuccess({
    upstream, c, targetUrl, latencyMs, detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}
