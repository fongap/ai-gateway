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
import { classifyUpstreamStatus, classifyFirstEventFailure, classifyClientAbort, classifyHedgeRaceLoss, classifyNonJsonBody } from '../../reliability/classify.ts';
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
  isAnthropicNativeRealOutput, isResponsesRealOutput, isOpenAIChatRealOutput,
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
import { recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';

// Anthropic-native first-event guard predicate: only text / thinking /
// tool-input deltas count as real model output. message_start,
// content_block_start/stop, ping and message_delta are lifecycle events and
// NOT commit points — the guard keeps consuming until real output appears,
// so a node that streams lifecycle events before dying can still fail over.
// Defined by the Anthropic transport (src/transport/anthropic.ts) — the two
// protocol families deliberately do NOT share a first-real-output judgment.
// OpenAI Chat Tier 1 uses its meaningful-output predicate while Tier 2/3 keep
// the original parseable-event boundary. Responses uses response.*.delta.

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
      // Policy-level first_event_timeout_ms overrides the global env default
      // for this model (e.g. long-reasoning needs 120s for chain-of-thought).
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
      //   openai chat tier1  -> meaningful text/reasoning/tool delta (so a
      //     role-only or empty delta does NOT close the boundary and is NOT
      //     recorded as passive TTFT — Tier 1 learns only from real output)
      //   openai chat tier2/3 -> any parseable non-error event (original rule,
      //     unchanged — Tier 2/3 are not redesigned here)
      const isRealOutput = surface === 'messages'
        ? isAnthropicNativeRealOutput
        : surface === 'responses' ? isResponsesRealOutput
        : (surface === 'chat_completions' && node.tier === 'tier-1') ? isOpenAIChatRealOutput
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
      // Latest main invalidates stale Tier 2/3 TTFT after a real first-event
      // failure. Tier 1 has a separate passive metric and never writes here.
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
    // TTFT: dispatch start -> first committed meaningful stream event. For
    // Tier 1 this is the ONLY performance signal (passive, real-request), so
    // it is recorded against the (account, model) pair in tier1-state; a
    // failed request that produced no meaningful output never reaches here
    // (it rotates through the failure pipeline instead). Tier 2/3 keep the
    // node-level EWMA in node-state for their existing latency preference.
    c.ttftMs = Date.now() - (c.attemptStartMs as number);
    if (node.tier === 'tier-1') {
      recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
    } else {
      recordTtft(node.id, c.ttftMs, state.requestedModel);
    }
    const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);

    const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

    if (route === 'openai_chat' && !c.conversionContext) {
      const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
        // Model rewrite happens INSIDE the tracked stream; wrapping yet another
        // pull-based stream layer here stalls final chunks (see track.js).
        ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
        // Chat passthrough never parses chunks for protocol purposes, so this
        // is the one streaming path whose usage is captured by track.js's
        // passive scan. Transformed routes below report usage from the
        // transform's parse point instead (onUsage NOT passed here), keeping
        // exactly one capture per stream.
        onUsage: (u: unknown) => recordTokens(c, node, u),
        interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: tracked };
    }

    // Cross-protocol fallback (streaming, reverse direction): the client is
    // OpenAI Chat, the upstream is Anthropic Messages. The first-event guard
    // already committed on a real Anthropic output event (isAnthropicNativeRealOutput).
    // Convert the Anthropic SSE stream to OpenAI Chat SSE through the stream
    // converter, then track it with OpenAI Chat completion markers. The
    // stream converter emits [DONE] when upstream reaches message_stop, so
    // the existing [DONE] completion marker is the right boundary.
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
          // The stream converter emits usage in OpenAI Chat format
          // (prompt_tokens / completion_tokens / total_tokens), so the
          // passive scan can capture it directly.
          onUsage: (u: unknown) => recordTokens(c, node, u),
          interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
          upstreamFailureReason: hiddenStreamFailure,
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: new Response(tracked.body, { status: 200, headers }) };
    }

    if (route === 'openai_responses' && !c.conversionContext) {
      // NATIVE passthrough: the upstream streamed a Responses event sequence;
      // it is relayed as-is (model field rewritten inside the tracked stream).
      // No Chat Completions conversion is involved anywhere.
      const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
        failureMarker: /event:\s*response\.failed\b/,
        ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'response.model' } : {}),
        // Native Responses SSE carries usage inside the response.completed
        // payload; the tracked stream's passive scan reports it (onUsage).
        onUsage: (u: unknown) => recordTokens(c, node, u),
        interruptionChunk: (reason: string | null, details?: { nextSequenceNumber?: number }) => streamInterruptionChunk(route, requestId, reason, details),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs),
      });
      return { response: tracked };
    }

    // Cross-protocol fallback (streaming): the upstream is OpenAI Chat SSE but
    // the client is Anthropic. The first-event guard already committed on a
    // real OpenAI output event (isOpenAIChatRealOutput). Convert the OpenAI
    // SSE stream to Anthropic SSE through the stream converter, then track it
    // with Anthropic completion markers. The stream converter already emits
    // usage in Anthropic format (input_tokens/output_tokens), so the usage
    // scan reports it as-is.
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
            // Use the TRUE upstream (OpenAI) usage for observability.
            // The stream converter already emitted client-facing Anthropic usage.
            if (upstreamUsage !== null) recordTokens(c, node, upstreamUsage);
          },
          interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
          upstreamFailureReason: hiddenStreamFailure,
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: new Response(tracked.body, { status: 200, headers }) };
    }

    // anthropic_messages: NATIVE passthrough. The upstream streamed the
    // Anthropic event lifecycle (message_start ... message_stop); relay it
    // as-is, tracked so an interrupted passthrough records against the node
    // exactly once. No OpenAI conversion is involved anywhere.
    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      // A stream that never reaches message_stop (truncated / errored mid-way)
      // must NOT be recorded as a node success.
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
      if (upstreamWasStreaming) {
        // Defensive: the native upstream streamed although the client asked
        // for JSON. Assemble the terminal response object — nothing has
        // reached the client, so failures here still rotate.
        data = await collectResponsesObject(upstream, request.signal);
      } else {
        data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024));
      }
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
      recordTier1NonStreamTtft(c, node, data, isOpenAIResponsesObjectMeaningful);
      // Single usage capture point for BOTH delivered forms below (plain JSON
      // and the synthesized Responses SSE).
      recordTokens(c, node, data?.usage);
      if (!clientWantsStream) {
        recordNodeSuccess(c, node, latencyMs);
        if (data && typeof data === 'object') data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      }
      // Stream requested but upstream returned a full object: synthesize a
      // well-formed Responses SSE stream in one body.
      recordNodeSuccess(c, node, latencyMs);
      return { response: synthesizeResponsesFromObject(data, requestedModel, { ...extraHeaders, ...corsHeaders(request, env) }) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyFirstEventFailure();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- OpenAI chat (non-stream, CROSS-PROTOCOL FALLBACK) ----
  // The client is OpenAI Chat; the upstream is Anthropic Messages (fallback
  // pass only — native OpenAI Chat is handled in the branch below). The
  // conversion at the request boundary already turned the OpenAI Chat body
  // into an Anthropic Messages body, so the upstream answered with a
  // standard Anthropic /v1/messages response. We must convert it back to
  // OpenAI Chat shape here so the client sees a familiar envelope, and any
  // upstream error must surface as an OpenAI Chat error (R0.4).
  if (route === 'openai_chat' && c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) {
        // Anthropic fallback upstream streamed although the client asked for
        // JSON. Assemble the full Anthropic message object, then convert to
        // the OpenAI Chat shape and deliver.
        data = await collectAnthropicMessageObject(upstream, request.signal);
      } else {
        const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024);
        data = JSON.parse(text);
      }
      if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
        const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
          ? Math.trunc(Number(data.error?.status))
          : 502;
        const message = data.error?.message || 'Upstream returned an embedded error.';
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, message);
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(message, 200) });
        if (classification.action === 'stop') {
          // R0.4: the client is OpenAI Chat; buildClientErrorResponse uses
          // the client route to pick the envelope shape. The Anthropic error
          // body never reaches the client.
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      const converted = convertAnthropicResponseToOpenAIChat(data);
      converted.model = requestedModel;
      recordNodeSuccess(c, node, latencyMs);
      // Usage from the converted body is already in OpenAI Chat shape.
      recordTokens(c, node, converted?.usage);
      if (clientWantsStream) {
        return { response: synthesizeSseFromCompletion(converted, env, request, extraHeaders) };
      }
      return { response: jsonResponse(200, converted, env, request, extraHeaders) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyFirstEventFailure();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- OpenAI chat (non-stream, NATIVE) ----
  if (route === 'openai_chat' && !c.conversionContext) {
    if (fakeStream || (upstreamWasStreaming && !clientWantsStream)) {
      // Assemble the full object; nothing reached the client yet, so failures rotate.
      try {
        const data = await collectOpenAIStreamObject(upstream, request.signal);
        recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
        recordNodeSuccess(c, node, latencyMs);
        // Assembled-from-stream usage (fake-stream protection and the
        // upstream-stream / client-non-stream case): the collect helper
        // already carries the final usage chunk — record it here, exactly
        // once, instead of inside the passthrough scan.
        recordTokens(c, node, data?.usage);
        data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (request.signal?.aborted) {
          recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
          return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
        }
        const classification = classifyFirstEventFailure();
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
        return { rotate: true, kind: classification.kind };
      }
    }
    if (upstreamWasStreaming) {
      const tracked = trackStreamResponse(
        new Response(upstream.body, { status: 200, headers: finalHeaders(env, request, upstream.headers, extraHeaders) }),
        {
          idleTimeoutMs: limits.streamIdleTimeoutMs,
          // A passthrough stream that closes without [DONE] is a truncation:
          // deliver what arrived, but account the node failure.
          completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
          ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
          // Defensive consistency with the streaming passthrough above (this
          // branch is mutually exclusive with the assemble path below, so the
          // scan can never double-count against a recordTokens call).
          onUsage: (u: unknown) => recordTokens(c, node, u),
          interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: tracked };
    }
    // Upstream answered 200 but NOT with SSE. Some free providers return
    // JSON bodies (sometimes with an embedded error object) even for
    // stream:true requests. Handle explicitly instead of feeding the client
    // a body it cannot parse as a stream.
    const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024);
    let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
    try {
      data = JSON.parse(text);
    } catch {
      return rotateWithNeutralEnd(state, node, classifyNonJsonBody().kind, c);
    }
    if (data && typeof data === 'object' && data.error) {
      // Provider returned 200 with an embedded error: treat as a real failure
      // so the request rotates to a healthy node instead of relaying garbage.
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
    recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
    // Single usage capture point for BOTH delivered forms below (plain JSON
    // and the synthesized chat SSE) — nothing else parses this body.
    recordTokens(c, node, data?.usage);
    if (!clientWantsStream) {
      recordNodeSuccess(c, node, latencyMs);
      if (data && typeof data === 'object') data.model = requestedModel;
      return { response: jsonResponse(200, data, env, request, extraHeaders) };
    }
    // Valid completion JSON for a streaming client: synthesize a proper SSE
    // stream so SSE clients receive a well-formed event sequence.
    recordNodeSuccess(c, node, latencyMs);
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: synthesizeSseFromCompletion(data, env, request, extraHeaders) };
  }

  // ---- Anthropic messages (non-stream, CROSS-PROTOCOL FALLBACK) ----
  if (route === 'anthropic_messages' && c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) {
        // OpenAI fallback upstream streamed although the client asked for
        // JSON. Assemble the full OpenAI completion object, then convert to
        // the Anthropic message shape and deliver.
        data = await collectOpenAIStreamObject(upstream, request.signal);
      } else {
        const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024);
        data = JSON.parse(text);
      }
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
      const converted = convertOpenAIToAnthropicResponse(data);
      converted.model = requestedModel;
      recordNodeSuccess(c, node, latencyMs);
      recordTokens(c, node, convertOpenAIUsageToAnthropic(data?.usage));
      if (clientWantsStream) {
        return { response: synthesizeAnthropicFromMessage(converted, { ...extraHeaders, ...corsHeaders(request, env) }) };
      }
      return { response: jsonResponse(200, converted, env, request, extraHeaders) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyFirstEventFailure();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- Anthropic messages (non-stream, NATIVE) ----
  try {
    let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
    if (upstreamWasStreaming) {
      // Defensive: the native upstream streamed although the client asked
      // for JSON. Assemble the final message object — nothing has reached
      // the client, so failures here still rotate.
      data = await collectAnthropicMessageObject(upstream, request.signal);
    } else {
      // Use bounded read (2 MiB, consistent with assemble.js MAX_ASSEMBLED_BYTES
      // and the first-event guard pre-byte limit) instead of unbounded text().
      const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024);
      data = JSON.parse(text);
    }
    if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
      // Provider returned 200 with an embedded error envelope: treat as a
      // real failure so the request rotates to a healthy node.
      const message = data.error?.message || 'Upstream returned an embedded error.';
      const classification = classifyUpstreamStatus(502, upstream.headers, env, undefined, message);
      recordOutcome(state, node, classification, c, { latencyMs, status: 502, diagnostic: trimDiagnostic(message, 200) });
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, 502, JSON.stringify(data), state, exposeUpstreamInfo) };
      }
      return { rotate: true, kind: classification.kind };
    }
    recordTier1NonStreamTtft(c, node, data, isAnthropicMessageMeaningful);
    recordNodeSuccess(c, node, latencyMs);
    // Single usage capture point: this branch serves both the plain JSON body
    // and the upstream-stream-assembled object.
    recordTokens(c, node, data?.usage);
    if (clientWantsStream) {
      // Stream requested but upstream returned a full message object:
      // synthesize the well-formed Anthropic SSE lifecycle in one body.
      return { response: synthesizeAnthropicFromMessage(data, { ...extraHeaders, ...corsHeaders(request, env) }) };
    }
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: jsonResponse(200, data, env, request, extraHeaders) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (request.signal?.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs, status: upstream.status });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
    }
    const classification = classifyFirstEventFailure();
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
    return { rotate: true, kind: classification.kind };
  }
}
