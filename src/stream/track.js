// Tracked stream wrapper: the single place where a streaming response body is
// relayed to the client while (a) enforcing the stream idle timeout, (b)
// recording the node outcome exactly once, and (c) optionally rewriting the
// SSE model field inline. Keeping the model rewrite INSIDE this layer instead
// of wrapping yet another pull-based stream around it matters: stacked
// pull-based stream wrappers can stall on their final chunks, which clients
// experience as "first events arrive, then the stream never terminates".
//
// Per-chunk work is minimal: only a small rolling tail is kept to detect an
// in-band `event: error` marker and, when `completionMarker` is set, whether
// the stream terminated properly. A clean close without the marker is an
// upstream truncation and counts as a failure.

export function trackStreamResponse(response, { idleTimeoutMs, onSuccess, onFailure, onNeutral, completionMarker, rewriteModel }) {
  if (!response.body) {
    onSuccess();
    return response;
  }
  const reader = response.body.getReader();
  // Two SEPARATE stream-stateful TextDecoders: the rewrite path and the
  // diagnostic tail each consume the same raw chunk with { stream: true }.
  // A single shared decoder instance would have its internal multi-byte UTF-8
  // carry advanced twice per chunk, corrupting any multi-byte character (e.g.
  // CJK) split across chunk boundaries.
  const rewriteDecoder = new TextDecoder();
  const tailDecoder = new TextDecoder();
  const encoder = rewriteModel !== undefined ? new TextEncoder() : null;
  let lineBuffer = '';
  let diagnosticTail = '';
  let errorEventSeen = false;
  let completionSeen = !completionMarker;
  let finished = false;

  const finalize = (result) => {
    if (finished) return;
    finished = true;
    if (result === 'success') {
      // Clean close but the upstream never sent its termination marker:
      // the output was truncated, so account it as a failure.
      if (!completionSeen) onFailure();
      else onSuccess();
    } else if (result === 'failure') onFailure();
    else onNeutral();
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
        finalize('failure');
        try { controller.close(); } catch { /* closed */ }
        return;
      }
      if (result.timeout) {
        reader.cancel().catch(() => {});
        finalize('failure');
        controller.close();
        return;
      }
      const { done, value } = result.value;
      if (done) {
        if (encoder && lineBuffer) { controller.enqueue(encoder.encode(lineBuffer)); lineBuffer = ''; }
        finalize(errorEventSeen ? 'failure' : 'success');
        controller.close();
        return;
      }
      if (!errorEventSeen || !completionSeen) {
        diagnosticTail = (diagnosticTail + tailDecoder.decode(value, { stream: true })).slice(-256);
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
