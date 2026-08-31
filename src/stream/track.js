// Tracked stream wrapper: the single place where a streaming response body is
// relayed to the client while (a) enforcing the stream idle timeout, (b)
// recording the node outcome exactly once, (c) optionally rewriting the
// SSE model field inline, and (d) optionally scanning reported usage. Keeping
// the model rewrite INSIDE this layer instead of wrapping yet another
// pull-based stream around it matters: stacked pull-based stream wrappers can
// stall on their final chunks, which clients experience as "first events
// arrive, then the stream never terminates".
//
// Per-chunk work is minimal: only a small rolling tail is kept to detect an
// in-band `event: error` marker and, when `completionMarker` is set, whether
// the stream terminated properly. A clean close without the marker is an
// upstream truncation and counts as a failure. The usage scan (only active
// when `onUsage` is passed, i.e. on passthrough call sites — transformed
// streams report usage from their own parse points) reuses the already
// decoded tail text and is passive: it never injects, requests or estimates
// usage; it only observes what the upstream volunteered.

import { normalizeTokenUsage } from '../observability/token-usage.mjs';
import { FIRST_EVENT_MAX_SSE_LINE } from './guard.js';

// Hard limit for the model-rewrite line buffer in the tracked stream (after
// first-event commit). Prevents unbounded growth from a never-terminated
// SSE line. Same limit as the pre-first-event guard for consistency.
const TRACK_MAX_LINE_BUFFER = FIRST_EVENT_MAX_SSE_LINE;

export function trackStreamResponse(response, { idleTimeoutMs, onSuccess, onFailure, onNeutral, onStreamStart, onStreamEnd, completionMarker, failureMarker, rewriteModel, rewriteModelAt, onUsage, interruptionChunk, upstreamFailureReason }) {
  if (!response.body) {
    onSuccess();
    return response;
  }
  const reader = response.body.getReader();
  // Two SEPARATE stream-stateful TextDecoders: the rewrite path and the
  // diagnostic tail each consume the same raw chunk with { stream: true }.
  // A single shared decoder instance would have its internal multi-byte UTF-8
  // carry advanced twice per chunk, corrupting any multi-byte character (e.g.
  // CJK) split across chunk boundaries. The usage scan adds no decoder — it
  // reuses the tail's already-decoded STRING (sharing the decoded text is
  // safe; sharing the decoder instance is not).
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
  // Passive usage scan state: lines that may still be split across chunks,
  // the last usable reported usage object, and a once-only fire guard.
  const usageScan = typeof onUsage === 'function';
  let usageLines = '';
  let usageCandidate = null;
  let usageReported = false;
  // Stream-end telemetry: chunk/byte volume plus the interruption reason,
  // resolved at the failure branch that observed it.
  const startMs = Date.now();
  let chunkCount = 0;
  let receivedBytes = 0;
  let failureReason = null;

  const emitInterruption = (controller) => {
    if (errorEventSeen || typeof interruptionChunk !== 'function') return;
    try {
      const chunk = interruptionChunk(failureReason, { nextSequenceNumber });
      if (chunk instanceof Uint8Array && chunk.byteLength > 0) controller.enqueue(chunk);
    } catch { /* diagnostics must never break stream shutdown */ }
  };

  // Incremental SSE line scan for `data: {... "usage": ...}` events. Only the
  // LAST usable report wins, so an early empty `usage:{}` cannot clobber a
  // later real report and two real reports keep the final one (providers that
  // resend cumulative usage). The buffer is capped so a never-terminating
  // line cannot grow it unbounded; scanning stops once the completion marker
  // was seen (usage never follows [DONE]).
  const scanUsageLine = (text) => {
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
        // Native wire shapes that report usage:
        //   OpenAI chat  -> data.usage on the terminal chunk
        //   Responses    -> data.response.usage on response.completed
        //   Anthropic    -> data.usage on message_delta (message_start's
        //                   partial input-only report is superseded by the
        //                   last usable report, per the last-wins rule below)
        const reported = json?.response?.usage !== undefined ? json.response.usage : json?.usage;
        if (reported !== undefined) {
          if (normalizeTokenUsage(reported)) usageCandidate = reported;
        }
      } catch { /* malformed lines are ignored — passive scan */ }
    }
  };

  const finalize = (result) => {
    if (finished) return;
    finished = true;
    // Fire the usage callback EXACTLY ONCE per stream, for success and
    // failure alike (a truncated stream may still have carried real reported
    // usage before it died). A client cancel ('neutral') closes the
    // observation window: it records neither usage nor missing.
    if (usageScan && !usageReported && result !== 'neutral') {
      usageReported = true;
      try { onUsage(usageCandidate); } catch { /* observability must never break the relay */ }
    }
    const failed = result === 'failure' || (result === 'success' && !completionSeen);
    if (result === 'success') {
      // Clean close but the upstream never sent its termination marker:
      // the output was truncated, so account it as a failure.
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

  // Inline SSE model-field rewrite (same semantics as the former standalone
  // rewriteStreamModelField wrapper). Lines that cannot contain the field are
  // never parsed; malformed lines pass through untouched.
  // `rewriteModelAt` selects where the logical model lives on the wire:
  //   'model'          -> top-level data.model      (OpenAI chat chunks)
  //   'response.model' -> data.response.model       (native Responses events)
  //   'message.model'  -> data.message.model        (native Anthropic events)
  // The field is only REWRITTEN when it already exists — unrelated lines are
  // never given a model field they did not carry.
  const modelPointer = rewriteModelAt || 'model';
  const processLine = (line) => {
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

  // Decode + optional rewrite, returning the bytes to forward for this chunk.
  // The line buffer is capped so a never-terminated SSE line (no newline) from
  // a malformed or adversarial upstream cannot grow it unbounded.
  const forwardBytes = (value) => {
    if (!encoder) return value;
    lineBuffer += rewriteDecoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    if (lineBuffer.length > TRACK_MAX_LINE_BUFFER || lines.some((line) => line.length > TRACK_MAX_LINE_BUFFER)) {
      // Never invent a newline or forward a partial oversized event: either
      // action corrupts the SSE protocol. The pull loop turns this into the
      // normal post-commit interruption path and cancels the upstream reader.
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
        // Upstream died mid-stream. Close cleanly so chunks that were already
        // queued still reach the client; the missing completion marker makes
        // the truncation detectable, and the node records a failure.
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
        let hiddenReason = null;
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
        // Scan BEFORE the completion-marker test: a single chunk carrying the
        // usage event and [DONE] together must still be seen.
        if (usageScan && !completionSeen) scanUsageLine(decoded);
        // Test the full current chunk plus the previous boundary tail BEFORE
        // retaining only a small suffix.  Large terminal events (notably
        // response.completed, whose data contains the whole response) put the
        // event header more than 256 characters before the chunk end; slicing
        // first used to discard that header and mark successful streams as
        // missing_completion_marker.
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
        if (!terminalFailureSeen && failureMarker?.test(scanWindow)) {
          terminalFailureSeen = true;
        }
        if (!completionSeen && completionMarker.test(scanWindow)) {
          completionSeen = true;
        }
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

async function raceWithIdle(readPromise, idleTimeoutMs) {
  if (!idleTimeoutMs || idleTimeoutMs <= 0) return { value: await readPromise };
  let timerId;
  const timeoutPromise = new Promise((resolve) => {
    timerId = setTimeout(() => resolve({ timeout: true }), idleTimeoutMs);
  });
  try {
    return await Promise.race([
      readPromise.then((value) => ({ value })),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timerId);
  }
}
