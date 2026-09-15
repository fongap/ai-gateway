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
  ERROR_ENVELOPE: 'first_event_error_envelope',
  PRE_EVENT_BYTES_EXCEEDED: 'first_event_pre_bytes_exceeded',
  SSE_LINE_EXCEEDED: 'first_event_sse_line_exceeded',
} as const;

export type GuardErrorCode = typeof GUARD_ERROR[keyof typeof GUARD_ERROR];

class GuardError extends Error {
  code: GuardErrorCode;
  constructor(code: GuardErrorCode) {
    super(code);
    this.name = 'FirstEventGuardError';
    this.code = code;
  }
}

function guardError(code: GuardErrorCode): GuardError {
  return new GuardError(code);
}

const guardedStreamState = new WeakMap<object, { failureReason: string | null }>();

export const FIRST_EVENT_MAX_PRE_BYTES = 2 * 1024 * 1024;
export const FIRST_EVENT_MAX_SSE_LINE = 1024 * 1024;

export type SseEventState = { dataLines: string[], dataLength: number };
export type SseEventHandler = (data: string) => void;

export function guardedStreamFailureReason(response: Response): string | null {
  return guardedStreamState.get(response)?.failureReason || null;
}

export function createSseScanner(onEvent: SseEventHandler): { push(chunkText: string): void, flush(): void } {
  let buffer = '';
  const eventState: SseEventState = { dataLines: [], dataLength: 0 };
  return {
    push(chunkText: string): void {
      buffer += chunkText;
      buffer = drainLines(buffer, eventState, onEvent);
      if (buffer.length > FIRST_EVENT_MAX_SSE_LINE) {
        throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
      }
    },
    flush(): void {
      buffer = drainLines(buffer + '', eventState, onEvent, true);
    },
  };
}

function drainLines(buffer: string, eventState: SseEventState, onEvent: SseEventHandler, flush: boolean = false): string {
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    let line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > FIRST_EVENT_MAX_SSE_LINE) {
      throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
    }
    handleSseLine(line, eventState, onEvent);
  }
  if (flush) {
    let tail = rest;
    if (tail.endsWith('\r')) tail = tail.slice(0, -1);
    if (tail.length > FIRST_EVENT_MAX_SSE_LINE) {
      throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
    }
    if (tail) handleSseLine(tail, eventState, onEvent);
    dispatchData(eventState, onEvent);
    return '';
  }
  return rest;
}

function handleSseLine(line: string, eventState: SseEventState, onEvent: SseEventHandler): void {
  if (line === '') {
    dispatchData(eventState, onEvent);
    return;
  }
  if (line.charCodeAt(0) === 58) return;
  if (!line.startsWith('data:')) return;
  const value = line.slice(5).trimStart();
  if (eventState.dataLines.length > 0 && isCompletePayload(eventState.dataLines.join('\n'))) {
    dispatchData(eventState, onEvent);
  }
  const separatorLength = eventState.dataLines.length > 0 ? 1 : 0;
  if (eventState.dataLength + separatorLength + value.length > FIRST_EVENT_MAX_SSE_LINE) {
    throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
  }
  eventState.dataLines.push(value);
  eventState.dataLength += separatorLength + value.length;
}

function dispatchData(eventState: SseEventState, onEvent: SseEventHandler): void {
  const { dataLines } = eventState;
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  dataLines.length = 0;
  eventState.dataLength = 0;
  onEvent(data);
}

function isCompletePayload(data: string): boolean {
  if (!data || data === '[DONE]') return true;
  try {
    JSON.parse(data);
    return true;
  } catch {
    return false;
  }
}

export async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number | null | undefined,
  onDeadline: (message: string) => Promise<never>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const message = 'Attempt deadline reached while assembling the response body.';
  if (!deadlineMs || deadlineMs <= 0) return reader.read();
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return onDeadline(message);
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<'timeout'>((resolve) => {
    timerId = setTimeout(() => resolve('timeout'), remaining);
  });
  try {
    const result = await Promise.race([
      reader.read().then((v) => ({ chunk: v })),
      timeoutP.then(() => 'timeout' as const),
    ]);
    if (result === 'timeout') return onDeadline(message);
    return result.chunk;
  } finally {
    clearTimeout(timerId);
  }
}

// `onParsedEvent` is intentionally observation-only. It runs after a data event
// has parsed as JSON but BEFORE the failover boundary commits. This lets the
// request layer retain upstream-reported usage from lifecycle/usage events even
// when the stream later fails before first real output. The callback cannot
// change commit semantics and any callback exception is ignored.
export async function ensureFirstSseEvent(
  upstreamResponse: Response,
  timeoutMs: number,
  clientSignal: AbortSignal | null | undefined,
  isRealOutput: ((json: unknown) => boolean) | undefined,
  onParsedEvent?: (json: unknown) => void,
): Promise<Response> {
  if (!upstreamResponse.body) throw guardError(GUARD_ERROR.EMPTY);
  const reader = upstreamResponse.body.getReader();
  const consumed: Uint8Array[] = [];
  let settled = false;

  return await new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finishErr(GUARD_ERROR.ABORTED);

    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      clientSignal?.removeEventListener('abort', abort);
      const state: { failureReason: string | null } = { failureReason: null };
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

    const finishErr = (code: GuardErrorCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      clientSignal?.removeEventListener('abort', abort);
      reader.cancel().catch(() => {});
      reject(guardError(code));
    };

    const check = (data: string) => {
      if (data === '[DONE]') {
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
      try { onParsedEvent?.(json); } catch { /* observability must not affect failover */ }
      if (json && typeof json === 'object' && !Array.isArray(json) && json.error) {
        finishErr(GUARD_ERROR.ERROR_ENVELOPE);
        return;
      }
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
      .catch((error) => {
        if (!settled) finishErr(error?.code || GUARD_ERROR.EMPTY);
      });
  });
}

async function consumeSseEventsWithReader(reader: ReadableStreamDefaultReader<Uint8Array>, onData: SseEventHandler, consumed: Uint8Array[], isSettled: () => boolean): Promise<void> {
  const decoder = new TextDecoder();
  const scanner = createSseScanner(onData);
  let preBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || isSettled()) break;
    if (consumed) consumed.push(value);
    preBytes += value.byteLength;
    if (preBytes > FIRST_EVENT_MAX_PRE_BYTES) {
      reader.cancel().catch(() => {});
      throw guardError(GUARD_ERROR.PRE_EVENT_BYTES_EXCEEDED);
    }
    scanner.push(decoder.decode(value, { stream: true }));
    if (isSettled()) break;
  }
  if (!isSettled()) scanner.flush();
}

async function pump(reader: ReadableStreamDefaultReader<Uint8Array>, controller: ReadableStreamDefaultController<Uint8Array>, state: { failureReason: string | null }): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      controller.enqueue(value);
    }
    controller.close();
  } catch {
    state.failureReason = 'reader_error';
    try { controller.close(); } catch { /* already closed */ }
  }
}
