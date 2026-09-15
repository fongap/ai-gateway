// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tracked stream wrapper: relay, idle timeout, node outcome, optional model
// rewrite, and passive upstream-reported usage observation.

import { normalizeTokenUsage, mergeReportedUsage } from '../observability/token-usage.ts';
import { FIRST_EVENT_MAX_SSE_LINE } from './guard.ts';

const TRACK_MAX_LINE_BUFFER = FIRST_EVENT_MAX_SSE_LINE;

export type TrackStreamEndInfo = {
  reason: string | null,
  durationMs: number,
  chunkCount: number,
  receivedBytes: number,
  completionMarkerSeen: boolean,
};

export type TrackOptions = {
  idleTimeoutMs: number,
  onSuccess: () => void,
  onFailure: () => void,
  onNeutral: () => void,
  onStreamStart?: () => void,
  onStreamEnd?: (outcome: string, info: TrackStreamEndInfo) => void,
  completionMarker?: RegExp,
  failureMarker?: RegExp,
  rewriteModel?: string,
  rewriteModelAt?: string,
  // Delivered-response usage callback. Preserved semantics: fires only for a
  // cleanly completed stream so model-status / delivered-token evidence cannot
  // be polluted by interrupted attempts.
  onUsage?: (usage: unknown) => void,
  // Physical-upstream accounting callback. Fires once for EVERY terminal stream
  // outcome and carries the best cumulative usage the upstream actually
  // reported, or null when no usable report was seen. Callers decide whether a
  // successful result is already covered by onUsage.
  onAttemptUsage?: (usage: unknown, outcome: 'success' | 'failure' | 'neutral') => void,
  interruptionChunk?: (reason: string | null, details?: { nextSequenceNumber?: number }) => Uint8Array,
  upstreamFailureReason?: () => string | null,
};

export function trackStreamResponse(response: Response, { idleTimeoutMs, onSuccess, onFailure, onNeutral, onStreamStart, onStreamEnd, completionMarker, failureMarker, rewriteModel, rewriteModelAt, onUsage, onAttemptUsage, interruptionChunk, upstreamFailureReason }: TrackOptions): Response {
  if (!response.body) {
    try { onAttemptUsage?.(null, 'success'); } catch { /* observability only */ }
    onSuccess();
    return response;
  }
  const reader = response.body.getReader();
  const rewriteDecoder = new TextDecoder();
  const tailDecoder = new TextDecoder();
  const encoder = rewriteModel !== undefined ? new TextEncoder() : null;
  let lineBuffer = '';
  let diagnosticTail = '';
  let errorEventSeen = false;
  let terminalFailureSeen = false;
  let completionSeen = !completionMarker;
  let nextSequenceNumber = 0;
  let finished = false;
  const usageScan = typeof onUsage === 'function' || typeof onAttemptUsage === 'function';
  let usageLines = '';
  let usageCandidate: unknown = null;
  let usageReported = false;
  let attemptUsageReported = false;
  const startMs = Date.now();
  let chunkCount = 0;
  let receivedBytes = 0;
  let failureReason: string | null = null;

  const emitInterruption = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (errorEventSeen || typeof interruptionChunk !== 'function') return;
    try {
      const chunk = interruptionChunk(failureReason, { nextSequenceNumber });
      if (chunk instanceof Uint8Array && chunk.byteLength > 0) controller.enqueue(chunk);
    } catch { /* diagnostics must never break stream shutdown */ }
  };

  const scanUsageLine = (text: string) => {
    usageLines += text;
    if (usageLines.length > 64 * 1024) usageLines = '';
    const lines = usageLines.split('\n');
    usageLines = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        const reported = json?.response?.usage !== undefined
          ? json.response.usage
          : json?.message?.usage !== undefined
            ? json.message.usage
            : json?.usage;
        if (reported !== undefined) {
          const merged = mergeReportedUsage(usageCandidate, reported);
          if (normalizeTokenUsage(merged)) usageCandidate = merged;
        }
      } catch { /* passive scan */ }
    }
  };

  const finalize = (result: 'success' | 'failure' | 'neutral') => {
    if (finished) return;
    finished = true;

    // Every real upstream stream closes one physical-attempt accounting slot.
    // Usage may be partial/cumulative; only upstream-reported values are kept.
    if (!attemptUsageReported) {
      attemptUsageReported = true;
      try { onAttemptUsage?.(usageCandidate, result); } catch { /* fail-open */ }
    }

    // Existing delivered-response semantics remain success-only.
    if (usageScan && !usageReported && result === 'success' && completionSeen && typeof onUsage === 'function') {
      usageReported = true;
      try { onUsage(usageCandidate); } catch { /* observability must never break relay */ }
    }

    const failed = result === 'failure' || (result === 'success' && !completionSeen);
    if (result === 'success') {
      if (!completionSeen) onFailure();
      else onSuccess();
    } else if (result === 'failure') onFailure();
    else onNeutral();
    onStreamEnd?.(
      result === 'neutral' ? 'neutral' : failed ? 'interrupted' : 'completed',
      {
        reason: failed ? failureReason : null,
        durationMs: Date.now() - startMs,
        chunkCount,
        receivedBytes,
        completionMarkerSeen: completionSeen,
      },
    );
  };

  const modelPointer = rewriteModelAt || 'model';
  const processLine = (line: string): string => {
    if (!line.startsWith('data:') || !line.includes('"model"')) return line;
    const raw = line.slice(5).trimStart();
    if (!raw || raw === '[DONE]') return line;
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === 'object') {
        const parts = modelPointer.split('.');
        let holder = json;
        for (let i = 0; i < parts.length - 1; i++) {
          holder = holder?.[parts[i]];
          if (!holder || typeof holder !== 'object') return line;
        }
        const leaf = parts[parts.length - 1];
        if (holder[leaf] === undefined) return line;
        holder[leaf] = rewriteModel;
        return 'data: ' + JSON.stringify(json);
      }
    } catch { /* malformed lines pass through untouched */ }
    return line;
  };

  const forwardBytes = (value: Uint8Array): Uint8Array => {
    if (!encoder) return value;
    lineBuffer += rewriteDecoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    if (lineBuffer.length > TRACK_MAX_LINE_BUFFER || lines.some((line) => line.length > TRACK_MAX_LINE_BUFFER)) {
      throw new Error('tracked SSE line exceeded the hard limit');
    }
    let out = '';
    for (const line of lines) out += processLine(line) + '\n';
    return encoder.encode(out);
  };

  const body = new ReadableStream({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      let result;
      try {
        result = await raceWithIdle(reader.read(), idleTimeoutMs);
      } catch {
        failureReason = 'reader_error';
        emitInterruption(controller);
        finalize('failure');
        try { controller.close(); } catch { /* closed */ }
        return;
      }
      if (result.timeout) {
        reader.cancel().catch(() => {});
        failureReason = 'idle_timeout';
        emitInterruption(controller);
        finalize('failure');
        controller.close();
        return;
      }
      const { done, value } = result.value;
      if (done) {
        let hiddenReason: string | null = null;
        try { hiddenReason = upstreamFailureReason?.() || null; } catch { /* diagnostic only */ }
        failureReason = hiddenReason || 'missing_completion_marker';
        if (encoder && lineBuffer) { controller.enqueue(encoder.encode(lineBuffer)); lineBuffer = ''; }
        if (!completionSeen && !terminalFailureSeen) emitInterruption(controller);
        finalize(errorEventSeen || terminalFailureSeen ? 'failure' : 'success');
        controller.close();
        return;
      }
      chunkCount++;
      receivedBytes += value.byteLength;
      if (!errorEventSeen || !completionSeen) {
        const decoded = tailDecoder.decode(value, { stream: true });
        if (usageScan && !completionSeen) scanUsageLine(decoded);
        const scanWindow = diagnosticTail + decoded;
        if (interruptionChunk) {
          const sequencePattern = /"sequence_number"\s*:\s*(\d+)/g;
          let match;
          while ((match = sequencePattern.exec(scanWindow))) {
            nextSequenceNumber = Math.max(nextSequenceNumber, Number(match[1]) + 1);
          }
        }
        if (!errorEventSeen) {
          errorEventSeen = /(?:^|\r?\n)event:\s*error\s*(?:\r?\n|$)/.test(scanWindow);
        }
        if (!terminalFailureSeen && failureMarker?.test(scanWindow)) terminalFailureSeen = true;
        if (!completionSeen && completionMarker?.test(scanWindow)) completionSeen = true;
        diagnosticTail = scanWindow.slice(-256);
      }
      let forwarded;
      try {
        forwarded = forwardBytes(value);
      } catch {
        reader.cancel().catch(() => {});
        failureReason = 'reader_error';
        emitInterruption(controller);
        finalize('failure');
        try { controller.close(); } catch { /* closed */ }
        return;
      }
      controller.enqueue(forwarded);
      if (completionMarker && completionSeen) {
        reader.cancel().catch(() => {});
        try {
          if (encoder && lineBuffer) { controller.enqueue(encoder.encode(lineBuffer)); lineBuffer = ''; }
        } catch { /* already closed */ }
        finalize('success');
        controller.close();
        return;
      }
    },
    cancel() {
      finalize('neutral');
      reader.cancel().catch(() => {});
    },
  });

  onStreamStart?.();

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function raceWithIdle(readPromise: Promise<ReadableStreamReadResult<Uint8Array>>, idleTimeoutMs: number): Promise<{ timeout: false, value: ReadableStreamReadResult<Uint8Array> } | { timeout: true }> {
  if (!idleTimeoutMs || idleTimeoutMs <= 0) return { timeout: false, value: await readPromise };
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
    timerId = setTimeout(() => resolve({ timeout: true }), idleTimeoutMs);
  });
  try {
    return await Promise.race([
      readPromise.then((value) => ({ timeout: false as const, value })),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timerId);
  }
}
