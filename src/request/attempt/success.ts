// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// success.ts - success finalization for one attempt: the first-event guard
// for streaming, per-route stream passthrough / transformation wiring, and
// the per-protocol non-stream (and stream-synthesized) result handling.
// Node success / TTFT / token recording is delegated to observability.ts.

import { attemptFirstEventTimeoutMs } from '../../config/timeouts.ts';
import { markProbeFailure, recordTtft, recordNeutralEnd, bumpNodeCounters } from '../../reliability/node-state.ts';
import { recordTier1Ttft, releaseTier1Slot } from '../../reliability/tier1-state.ts';
import {
  classifyUpstreamStatus,
  classifyFirstEventFailure,
  classifyPostHeadersFailure,
  classifyClientAbort,
  classifyHedgeRaceLoss,
  classifyNonJsonBody,
  classifyEmptyResponse,
} from '../../reliability/classify.ts';
import {
  corsHeaders,
  safeReadErrorBody, trimDiagnostic,
} from '../../protocol/http.ts';
import { synthesizeSseFromCompletion } from '../../protocol/openai.ts';
import { estimateAnthropicInputTokens } from '../../protocol/anthropic.ts';
import {
  collectResponsesObject, synthesizeResponsesFromObject,
} from '../../protocol/responses/index.ts';
import {
  isAnthropicNativeRealOutput, isAnthropicNativeRealOutputForConversion,
  isResponsesRealOutput, isOpenAIChatRealOutput, isOpenAIChatRealOutputForConversion,
  isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful,
  isAnthropicMessageMeaningful,
} from '../../transport/index.ts';
import {
  collectAnthropicMessageObject, synthesizeAnthropicFromMessage,
} from '../../stream/anthropic-native.ts';
import { ensureFirstSseEvent, GUARD_ERROR, guardedStreamFailureReason } from '../../stream/guard.ts';
import { collectOpenAIStreamObject } from '../../stream/assemble.ts';
import { trackStreamResponse } from '../../stream/track.ts';
import { gatewayError, buildClientErrorResponse } from '../errors.ts';
import { finalHeaders, jsonResponse, streamInterruptionChunk, upstreamModelOf } from '../response-helpers.ts';
import { convertOpenAIToAnthropicResponse, convertOpenAIUsageToAnthropic } from '../../conversion/openai-to-anthropic.ts';
import { createAnthropicStreamFromOpenAI } from '../../conversion/stream-converter.ts';
import { convertAnthropicResponseToOpenAIChat } from '../../conversion/anthropic-response-to-openai-chat.ts';
import { createOpenAIChatStreamFromAnthropic } from '../../conversion/anthropic-stream-to-openai-chat.ts';
import {
  recordTokens, recordNodeSuccess, makeNodeStreamTrack, recordTier1NonStreamTtft,
} from './observability.ts';
import { recordOutcome } from './outcome.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';

// Anthropic-native first-event guard predicate: only text / thinking /
// tool-input deltas count as real model output. message_start,
// content_block_start/stop, ping and message_delta are lifecycle events and
// NOT commit points — the guard keeps consuming until real output appears,
// so a node that streams lifecycle events before dying can still fail over.
// Defined by the Anthropic transport (src/transport/anthropic.ts) — the two
// protocol families deliberately do NOT share a first-real-output judgment.
// OpenAI Chat uses the same meaningful-output predicate in every tier; a
// role-only / empty delta never closes the transparent-failover boundary.
// Responses uses response.*.delta.

export async function handleSuccess(s: {
  upstream: Response,
  c: AttemptContext,
  targetUrl: string,
  latencyMs: number,
  detach: () => void,
  upstreamWasStreaming: boolean,
  attemptStartMs?: number,
}): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach, upstreamWasStreaming } = s;
  const { request, env, logger, requestId, route, node, requestedModel, bodyJson, clientWantsStream, fakeStream, limits, exposeUpstreamInfo, state, policy } = c;
  const surface = c.surface;
  const elapsedSinceStart = () => Date.now() - (c.attemptStartMs as number);
  // Topology-leak policy (P1): by default a successful client response carries
  // only x-request-id. Node id / tier are operational details exposed only when
  // EXPOSE_UPSTREAM_INFO=true (debugging) or via the auth-protected /health.
  const extraHeaders = {
    'x-request-id': requestId,
    ...(exposeUpstreamInfo ? { 'x-gateway-node': node.id, 'x-gateway-tier': node.tier } : {}),
  };

  const needsModelRewrite = requestedModel !== upstreamModelOf(node, requestedModel);

  // Streaming passthrough / transformed streams: run the first-event guard
  // BEFORE returning anything to the client.
  if (clientWantsStream && upstreamWasStreaming) {
    const guardStartMs = Date.now();
    let guarded: Response;
    try {
      const remainingRequestBudgetMs = (c.failoverBudgetMs ?? limits.failoverBudgetMs) - (Date.now() - (c.requestStartMs || (s.attemptStartMs as number) || Date.now()));
      const remainingAttemptBudgetMs = (c.attemptDeadlineMs ?? Date.now()) - Date.now();
      // Policy-level first_event_timeout_ms can override the global env default
      // for models that intentionally need a longer first-output window. The
      // request-wide and attempt-wide clocks still remain hard upper bounds.
      const effectiveFirstEventTimeoutMs = policy?.firstEventTimeoutMs ?? limits.firstEventTimeoutMs;
      const firstEventTimeout = attemptFirstEventTimeoutMs(
        effectiveFirstEventTimeoutMs,
        Math.min(remainingRequestBudgetMs, remainingAttemptBudgetMs),
        1,
      );
      // Per-protocol "first real output" judgment — the failover boundary
      // commits only when genuine model output is observed:
      //   anthropic messages -> native content deltas (transport predicate)
      //   openai responses   -> response.*.delta events (transport predicate)
      //   openai chat -> meaningful text/reasoning/tool delta in EVERY tier;
      //     role-only or empty deltas do not close the boundary. Tier 1 still
      //     remains the only tier that learns passive TTFT in tier1-state.
      const isRealOutput = c.conversionContext
        ? (c.conversionContext.fallbackProtocol === 'anthropic'
            ? isAnthropicNativeRealOutputForConversion
            : isOpenAIChatRealOutputForConversion)
        : surface === 'messages'
          ? isAnthropicNativeRealOutput
          : surface === 'responses' ? isResponsesRealOutput
          : surface === 'chat_completions' ? isOpenAIChatRealOutput
          : undefined;
      guarded = await ensureFirstSseEvent(upstream, firstEventTimeout, request.signal, isRealOutput);
    } catch (e) {
      detach();
      const code = (e && typeof e === 'object' && 'code' in e) ? String((e as { code: unknown }).code) : GUARD_ERROR.EMPTY;
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, {
          latencyMs: Date.now() - (c.attemptStartMs as number),
          ttftWaitMs: Date.now() - guardStartMs,
          status: upstream.status,
        });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request before the first stream event.', requestId) };
      }
      if (c.hedgeAbort?.signal.aborted) {
        // Lost the hedge race while waiting for the first event: same neutral
        // treatment as the fetch-phase loss — slow is not broken. This holds
        // REGARDLESS of the guard error code: once the peer committed, this
        // side was cancelled, and a body-reader unwinding caused by our own
        // abort must not be miscounted as a first-event timeout.
        state.attempted.add(node.id);
        state.dispatches++;
        if (!c.hedgedAttempt) state.logicalAttempts++;
        if (node.tier === 'tier-1') {
          releaseTier1Slot(node.id, c.tier1ReleaseToken);
          bumpNodeCounters(node.id, { requests: 1 });
        } else recordNeutralEnd(node.id);
        logger.info(
          `hedge loser: request=${requestId} node=${node.id} phase=first_event`
          + ` reason=cancelled_after_peer_commit neutral=true latency_ms=${Date.now() - (c.attemptStartMs as number)}`,
        );
        return { rotate: true, hedgedAway: true, kind: classifyHedgeRaceLoss().kind };
      }
      const classification = classifyFirstEventFailure();
      if (node.tier !== 'tier-1') markProbeFailure(node.id, state.requestedModel);
      recordOutcome(state, node, classification, c, {
        latencyMs: Date.now() - (c.attemptStartMs as number),
        ttftWaitMs: Date.now() - guardStartMs,
        status: upstream.status,
        diagnostic: code,
      });
      return { rotate: true, kind: classification.kind };
    }
    detach();
    c.ttftMs = Date.now() - (c.attemptStartMs as number);
    if (node.tier === 'tier-1') recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
    else recordTtft(node.id, c.ttftMs, state.requestedModel);
    const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);
    const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

    if (route === 'openai_chat' && !c.conversionContext) {
      const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
        ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
        onUsage: (u: unknown) => recordTokens(c, node, u),
        interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: tracked };
    }

    if (route === 'openai_chat' && c.conversionContext) {
      const openAiStream = createOpenAIChatStreamFromAnthropic(guarded.body, {
        messageId: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        model: requestedModel,
      });
      const tracked = trackStreamResponse(
        new Response(openAiStream, { status: 200, headers }),
        {
          idleTimeoutMs: limits.streamIdleTimeoutMs,
          completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
          ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
          onUsage: (u: unknown) => recordTokens(c, node, u),
          interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
          upstreamFailureReason: hiddenStreamFailure,
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: new Response(tracked.body, { status: 200, headers }) };
    }

    if (route === 'openai_responses' && !c.conversionContext) {
      const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
        failureMarker: /event:\s*response\.failed\b/,
        ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'response.model' } : {}),
        onUsage: (u: unknown) => recordTokens(c, node, u),
        interruptionChunk: (reason: string | null, details?: { nextSequenceNumber?: number }) => streamInterruptionChunk(route, requestId, reason, details),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: tracked };
    }

    if (route === 'anthropic_messages' && c.conversionContext) {
      const inputTokens = estimateAnthropicInputTokens(bodyJson);
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      let upstreamUsage: unknown = null;
      const anthropicStream = createAnthropicStreamFromOpenAI(guarded.body, {
        messageId,
        model: requestedModel,
        inputTokens,
        onUpstreamUsage: (u: unknown) => { upstreamUsage = u; },
      });
      const tracked = trackStreamResponse(
        new Response(anthropicStream, { status: 200, headers }),
        {
          idleTimeoutMs: limits.streamIdleTimeoutMs,
          completionMarker: /event:\s*message_stop\b/,
          onUsage: () => {
            if (upstreamUsage !== null) recordTokens(c, node, upstreamUsage);
          },
          interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
          upstreamFailureReason: hiddenStreamFailure,
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: new Response(tracked.body, { status: 200, headers }) };
    }

    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      completionMarker: /event:\s*message_stop\b/,
      ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'message.model' } : {}),
      onUsage: (u: unknown) => recordTokens(c, node, u),
      interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
      upstreamFailureReason: hiddenStreamFailure,
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: new Response(tracked.body, { status: 200, headers }) };
  }
  detach();

  // ---- OpenAI Responses (non-stream, NATIVE) ----
  if (route === 'openai_responses' && !c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) data = await collectResponsesObject(upstream, request.signal, c.attemptDeadlineMs);
      else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
      if (data && typeof data === 'object' && data.error) {
        const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
          ? Math.trunc(Number(data.error?.status))
          : 502;
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(data.error.message || 'embedded error', 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      if (!isOpenAIResponsesObjectMeaningful(data)) {
        const classification = classifyEmptyResponse();
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'Responses object carried no meaningful output' });
        return { rotate: true, kind: classification.kind };
      }
      recordTier1NonStreamTtft(c, node, data, isOpenAIResponsesObjectMeaningful);
      recordTokens(c, node, data?.usage);
      if (!clientWantsStream) {
        recordNodeSuccess(c, node, latencyMs);
        if (data && typeof data === 'object') data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      }
      recordNodeSuccess(c, node, latencyMs);
      return { response: synthesizeResponsesFromObject(data, requestedModel, { ...extraHeaders, ...corsHeaders(request, env) }) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- OpenAI chat (non-stream, CROSS-PROTOCOL FALLBACK) ----
  if (route === 'openai_chat' && c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) data = await collectAnthropicMessageObject(upstream, request.signal, c.attemptDeadlineMs);
      else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
      if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
        const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
          ? Math.trunc(Number(data.error?.status))
          : 502;
        const message = data.error?.message || 'Upstream returned an embedded error.';
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, message);
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(message, 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      if (!isAnthropicMessageMeaningful(data)) {
        const classification = classifyEmptyResponse();
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'cross-protocol Anthropic message carried no meaningful output' });
        return { rotate: true, kind: classification.kind };
      }
      const converted = convertAnthropicResponseToOpenAIChat(data);
      converted.model = requestedModel;
      recordNodeSuccess(c, node, latencyMs);
      recordTokens(c, node, converted?.usage);
      if (clientWantsStream) return { response: synthesizeSseFromCompletion(converted, env, request, extraHeaders) };
      return { response: jsonResponse(200, converted, env, request, extraHeaders) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- OpenAI chat (non-stream, NATIVE) ----
  if (route === 'openai_chat' && !c.conversionContext) {
    if (fakeStream || (upstreamWasStreaming && !clientWantsStream)) {
      try {
        const data = await collectOpenAIStreamObject(upstream, request.signal, c.attemptDeadlineMs);
        if (!isOpenAIChatCompletionMeaningful(data)) {
          const classification = classifyEmptyResponse();
          recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'assembled chat completion carried no meaningful output' });
          return { rotate: true, kind: classification.kind };
        }
        recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
        recordNodeSuccess(c, node, latencyMs);
        recordTokens(c, node, data?.usage);
        data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (request.signal?.aborted) {
          recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
          return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
        }
        const classification = classifyPostHeadersFailure(error);
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
        return { rotate: true, kind: classification.kind };
      }
    }
    if (upstreamWasStreaming) {
      const tracked = trackStreamResponse(
        new Response(upstream.body, { status: 200, headers: finalHeaders(env, request, upstream.headers, extraHeaders) }),
        {
          idleTimeoutMs: limits.streamIdleTimeoutMs,
          completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
          ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
          onUsage: (u: unknown) => recordTokens(c, node, u),
          interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: tracked };
    }
    const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs);
    let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
    try {
      data = JSON.parse(text);
    } catch {
      const classification = classifyNonJsonBody();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: text });
      return { rotate: true, kind: classification.kind };
    }
    if (data && typeof data === 'object' && data.error) {
      const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
        ? Math.trunc(Number(data.error?.status))
        : 502;
      const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
      recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(data.error.message || 'embedded error', 200) });
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, text, state, exposeUpstreamInfo) };
      }
      return { rotate: true, kind: classification.kind };
    }
    if (!isOpenAIChatCompletionMeaningful(data)) {
      const classification = classifyEmptyResponse();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'chat completion carried no meaningful output' });
      return { rotate: true, kind: classification.kind };
    }
    recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
    recordTokens(c, node, data?.usage);
    if (!clientWantsStream) {
      recordNodeSuccess(c, node, latencyMs);
      if (data && typeof data === 'object') data.model = requestedModel;
      return { response: jsonResponse(200, data, env, request, extraHeaders) };
    }
    recordNodeSuccess(c, node, latencyMs);
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: synthesizeSseFromCompletion(data, env, request, extraHeaders) };
  }

  // ---- Anthropic messages (non-stream, CROSS-PROTOCOL FALLBACK) ----
  if (route === 'anthropic_messages' && c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) data = await collectOpenAIStreamObject(upstream, request.signal, c.attemptDeadlineMs);
      else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
      if (data && typeof data === 'object' && data.error) {
        const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
          ? Math.trunc(Number(data.error?.status))
          : 502;
        const message = data.error?.message || 'Upstream returned an embedded error.';
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, message);
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(message, 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      if (!isOpenAIChatCompletionMeaningful(data)) {
        const classification = classifyEmptyResponse();
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'cross-protocol OpenAI Chat completion carried no meaningful output' });
        return { rotate: true, kind: classification.kind };
      }
      const converted = convertOpenAIToAnthropicResponse(data);
      converted.model = requestedModel;
      recordNodeSuccess(c, node, latencyMs);
      recordTokens(c, node, convertOpenAIUsageToAnthropic(data?.usage));
      if (clientWantsStream) return { response: synthesizeAnthropicFromMessage(converted, { ...extraHeaders, ...corsHeaders(request, env) }) };
      return { response: jsonResponse(200, converted, env, request, extraHeaders) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- Anthropic messages (non-stream, NATIVE) ----
  try {
    let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
    if (upstreamWasStreaming) data = await collectAnthropicMessageObject(upstream, request.signal, c.attemptDeadlineMs);
    else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
    if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
      const message = data.error?.message || 'Upstream returned an embedded error.';
      const classification = classifyUpstreamStatus(502, upstream.headers, env, undefined, message);
      recordOutcome(state, node, classification, c, { latencyMs, status: 502, diagnostic: trimDiagnostic(message, 200) });
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, 502, JSON.stringify(data), state, exposeUpstreamInfo) };
      }
      return { rotate: true, kind: classification.kind };
    }
    if (!isAnthropicMessageMeaningful(data)) {
      const classification = classifyEmptyResponse();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'Anthropic message carried no meaningful output' });
      return { rotate: true, kind: classification.kind };
    }
    recordTier1NonStreamTtft(c, node, data, isAnthropicMessageMeaningful);
    recordNodeSuccess(c, node, latencyMs);
    recordTokens(c, node, data?.usage);
    if (clientWantsStream) return { response: synthesizeAnthropicFromMessage(data, { ...extraHeaders, ...corsHeaders(request, env) }) };
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: jsonResponse(200, data, env, request, extraHeaders) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (request.signal?.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs, status: upstream.status });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
    }
    const classification = classifyPostHeadersFailure(error);
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
    return { rotate: true, kind: classification.kind };
  }
}
