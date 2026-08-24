// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tracked stream wrapper: the single place where a streaming response body is
// relayed to the client while (a) enforcing the stream idle timeout and
// (b) recording the node outcome exactly once:
//   completed normally        -> onSuccess
//   idle timeout / upstream error -> onFailure
//   client cancelled          -> onNeutral (never penalizes the node)
//
// Per-chunk work is minimal: bytes pass through untouched; only a small
// rolling tail is kept to detect an in-band `event: error` marker.

export function trackStreamResponse(response, { idleTimeoutMs, onSuccess, onFailure, onNeutral }) {
  if (!response.body) {
    onSuccess();
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let diagnosticTail = '';
  let errorEventSeen = false;
  let finished = false;

  const finalize = (result) => {
    if (finished) return;
    finished = true;
    if (result === 'success') onSuccess();
    else if (result === 'failure') onFailure();
    else onNeutral();
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
        finalize(errorEventSeen ? 'failure' : 'success');
        controller.close();
        return;
      }
      if (!errorEventSeen) {
        diagnosticTail = (diagnosticTail + decoder.decode(value, { stream: true })).slice(-256);
        errorEventSeen = /(?:^|\r?\n)event:\s*error\s*(?:\r?\n|$)/.test(diagnosticTail);
      }
      controller.enqueue(value);
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
