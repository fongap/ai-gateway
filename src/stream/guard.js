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
};

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
export async function ensureFirstSseEvent(upstreamResponse, timeoutMs, clientSignal) {
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
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of consumed) controller.enqueue(chunk);
          void pump(reader, controller);
        },
        cancel() { reader.cancel().catch(() => {}); },
      });
      resolve(new Response(stream, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: upstreamResponse.headers,
      }));
    };

    const finishErr = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      clientSignal?.removeEventListener('abort', abort);
      reader.cancel().catch(() => {});
      reject(guardError(code));
    };

    const check = (data) => {
      if (data === '[DONE]') {
        // A bare [DONE] without any output event is an empty stream.
        finishErr(GUARD_ERROR.DONE_ONLY);
        return;
      }
      try {
        JSON.parse(data);
        finishOk();
      } catch {
        finishErr(GUARD_ERROR.MALFORMED);
      }
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

async function pump(reader, controller) {
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
    try { controller.close(); } catch { /* already closed */ }
  }
}

function guardError(code) {
  const error = new Error(code);
  error.name = 'FirstEventGuardError';
  error.code = code;
  return error;
}
