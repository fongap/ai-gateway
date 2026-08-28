// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// First Event Guard — the single streaming failover boundary implementation.
//
// Consumes the upstream SSE stream until the first valid data event has been
// observed (parseable JSON payload other than "[DONE]"), then returns a new
// Response that replays the consumed bytes and continues transparently.
//
// Before the first valid event the request can safely fail over to another
// node; AFTER it, transparent failover is forbidden (the client already saw
// model A's output). Callers must therefore run this guard before returning
// any streaming Response to the client.
//
// Throws on: timeout, empty stream, [DONE]-only stream, client abort, or a
// malformed first event. The caller records a node failure and rotates.

export const GUARD_ERROR = {
  TIMEOUT: 'first_event_timeout',
  EMPTY: 'empty_stream',
  DONE_ONLY: 'done_only_stream',
  ABORTED: 'client_aborted',
  MALFORMED: 'malformed_first_event',
  // HTTP 200 + a parseable JSON event that is an error envelope
  // ({"error":{...}}). The node produced no model output, so the caller must
  // still be allowed to rotate instead of committing the stream.
  ERROR_ENVELOPE: 'first_event_error_envelope',
};

const guardedStreamState = new WeakMap();

// A post-commit reader exception is intentionally relayed as a clean EOF so
// already-buffered model output is not discarded. Expose the hidden cause to
// the outer tracker, which can then classify/log it as reader_error instead of
// collapsing every clean close into missing_completion_marker.
export function guardedStreamFailureReason(response) {
  return guardedStreamState.get(response)?.failureReason || null;
}

// Incremental SSE line scanner shared by every streaming path so each SSE
// event is parsed exactly once no matter which consumer processes it.
// Usage: const s = createSseScanner(onData); s.push(chunkText)...; s.flush();
export function createSseScanner(onEvent) {
  let buffer = '';
  const dataLines = [];
  return {
    push(chunkText) {
      buffer += chunkText;
      buffer = drainLines(buffer, dataLines, onEvent);
    },
    flush() {
      buffer = drainLines(buffer + '', dataLines, onEvent, true);
    },
  };
}

function drainLines(buffer, dataLines, onEvent, flush = false) {
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    let line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    handleSseLine(line, dataLines, onEvent);
  }
  if (flush) {
    let tail = rest;
    if (tail.endsWith('\r')) tail = tail.slice(0, -1);
    if (tail) handleSseLine(tail, dataLines, onEvent);
    dispatchData(dataLines, onEvent);
    return '';
  }
  return rest;
}

function handleSseLine(line, dataLines, onEvent) {
  if (line === '') {
    dispatchData(dataLines, onEvent);
    return;
  }
  if (line.charCodeAt(0) === 58 /* ':' */) return; // SSE comment / keep-alive
  if (!line.startsWith('data:')) return;
  const value = line.slice(5).trimStart();
  // Some providers omit the blank line between events. If the accumulated
  // payload is already valid JSON (or [DONE]), dispatch before accumulating.
  if (dataLines.length > 0 && isCompletePayload(dataLines.join('\n'))) {
    dispatchData(dataLines, onEvent);
  }
  dataLines.push(value);
}

function dispatchData(dataLines, onEvent) {
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  dataLines.length = 0;
  onEvent(data);
}

function isCompletePayload(data) {
  if (!data || data === '[DONE]') return true;
  try {
    JSON.parse(data);
    return true;
  } catch {
    return false;
  }
}

// Wait for the first valid event and return { response } replaying consumed bytes.
// `isRealOutput` (optional): a per-route predicate that decides whether a
// parseable, non-error SSE event counts as real model output. When supplied,
// events that parse but carry no real output (role-only / empty delta /
// usage-only / empty choices) do NOT commit the failover boundary — the guard
// keeps consuming until real output appears (or the stream ends/times out).
// Omitting it preserves the original "any parseable non-error event commits"
// behavior used by the OpenAI Chat / Responses paths.
export async function ensureFirstSseEvent(upstreamResponse, timeoutMs, clientSignal, isRealOutput) {
  if (!upstreamResponse.body) throw guardError(GUARD_ERROR.EMPTY);
  const reader = upstreamResponse.body.getReader();
  const consumed = [];
  let settled = false;

  return await new Promise((resolve, reject) => {
    let timerId = null;
    const abort = () => finishErr(GUARD_ERROR.ABORTED);

    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      clientSignal?.removeEventListener('abort', abort);
      const state = { failureReason: null };
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of consumed) controller.enqueue(chunk);
          void pump(reader, controller, state);
        },
        cancel() { reader.cancel().catch(() => {}); },
      });
      const replay = new Response(stream, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: upstreamResponse.headers,
      });
      guardedStreamState.set(replay, state);
      resolve(replay);
    };

    const finishErr = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      clientSignal?.removeEventListener('abort', abort);
      reader.cancel().catch(() => {});
      reject(guardError(code));
    };

    // Some OpenAI-compatible providers answer HTTP 200 but stream a JSON error
    // envelope ({"error":{...}}) as the first SSE event. That is NOT model
    // output: committing it would close the failover boundary on a node that
    // never produced anything, so it must rotate like any other first-event
    // failure.
    const check = (data) => {
      if (data === '[DONE]') {
        // A bare [DONE] without any output event is an empty stream.
        finishErr(GUARD_ERROR.DONE_ONLY);
        return;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        finishErr(GUARD_ERROR.MALFORMED);
        return;
      }
      if (json && typeof json === 'object' && !Array.isArray(json) && json.error) {
        finishErr(GUARD_ERROR.ERROR_ENVELOPE);
        return;
      }
      // A route may require real model output (text / reasoning / tool_call)
      // before the failover boundary commits. Events that parse but carry no
      // real output (role-only / empty delta / usage-only / empty choices) are
      // skipped and the guard keeps consuming — they must NOT close the
      // boundary on a node that has produced nothing yet.
      if (isRealOutput && !isRealOutput(json)) return;
      finishOk();
    };

    if (clientSignal?.aborted) {
      finishErr(GUARD_ERROR.ABORTED);
      return;
    }
    clientSignal?.addEventListener('abort', abort, { once: true });
    timerId = setTimeout(() => finishErr(GUARD_ERROR.TIMEOUT), timeoutMs);

    void consumeSseEventsWithReader(reader, check, consumed, () => settled)
      .then(() => { if (!settled) finishErr(GUARD_ERROR.EMPTY); })
      .catch(() => { if (!settled) finishErr(GUARD_ERROR.EMPTY); });
  });
}

async function consumeSseEventsWithReader(reader, onData, consumed, isSettled) {
  const decoder = new TextDecoder();
  const scanner = createSseScanner(onData);
  for (;;) {
    const { done, value } = await reader.read();
    if (done || isSettled()) break;
    if (consumed) consumed.push(value);
    scanner.push(decoder.decode(value, { stream: true }));
    if (isSettled()) break; // guard settled mid-chunk; replay pump owns the reader now
  }
  if (!isSettled()) scanner.flush();
}

async function pump(reader, controller, state) {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      controller.enqueue(value);
    }
    controller.close();
  } catch {
    // Upstream died mid-stream after the first event: close cleanly so
    // already-buffered bytes still reach the client; the missing completion
    // marker exposes the truncation.
    state.failureReason = 'reader_error';
    try { controller.close(); } catch { /* already closed */ }
  }
}

function guardError(code) {
  const error = new Error(code);
  error.name = 'FirstEventGuardError';
  error.code = code;
  return error;
}
