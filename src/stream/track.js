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

import { normalizeTokenUsage } from '../observability/tokens.js';

export function trackStreamResponse(response, { idleTimeoutMs, onSuccess, onFailure, onNeutral, onStreamStart, onStreamEnd, completionMarker, rewriteModel, onUsage }) {
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
  let completionSeen = !completionMarker;
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
        if (json && typeof json === 'object' && json.usage !== undefined) {
          if (normalizeTokenUsage(json.usage)) usageCandidate = json.usage;
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
  const processLine = (line) => {
    if (!line.startsWith('data:') || !line.includes('"model"')) return line;
    const raw = line.slice(5).trimStart();
    if (!raw || raw === '[DONE]') return line;
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === 'object' && json.model !== undefined) {
        json.model = rewriteModel;
        return 'data: ' + JSON.stringify(json);
      }
    } catch { /* malformed lines pass through untouched */ }
    return line;
  };

  // Decode + optional rewrite, returning the bytes to forward for this chunk.
  const forwardBytes = (value) => {
    if (!encoder) return value;
    lineBuffer += rewriteDecoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
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
        finalize('failure');
        try { controller.close(); } catch { /* closed */ }
        return;
      }
      if (result.timeout) {
        reader.cancel().catch(() => {});
        failureReason = 'idle_timeout';
        finalize('failure');
        controller.close();
        return;
      }
      const { done, value } = result.value;
      if (done) {
        failureReason = 'missing_completion_marker';
        if (encoder && lineBuffer) { controller.enqueue(encoder.encode(lineBuffer)); lineBuffer = ''; }
        finalize(errorEventSeen ? 'failure' : 'success');
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
        diagnosticTail = (diagnosticTail + decoded).slice(-256);
        if (!errorEventSeen) {
          errorEventSeen = /(?:^|\r?\n)event:\s*error\s*(?:\r?\n|$)/.test(diagnosticTail);
        }
        if (!completionSeen && completionMarker.test(diagnosticTail)) {
          completionSeen = true;
        }
      }
      controller.enqueue(forwardBytes(value));
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
