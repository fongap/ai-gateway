// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import { createSseScanner } from '../stream/guard.ts';

// Conversion must preserve the upstream terminal boundary and propagate
// cancellation all the way to the upstream reader.
export function convertSseStream(
  body: ReadableStream<Uint8Array> | null | undefined,
  onData: (data: string, controller: ReadableStreamDefaultController<Uint8Array>) => void,
  isTerminal: () => boolean,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      if (!body) { controller.error(new Error('Upstream stream body is not readable')); return; }
      reader = body.getReader();
      const upstream = reader;
      const decoder = new TextDecoder();
      const scanner = createSseScanner((data) => {
        if (!cancelled && !isTerminal() && data) onData(data, controller);
      });
      void (async () => {
        try {
          while (!cancelled && !isTerminal()) {
            const { done, value } = await upstream.read();
            if (cancelled) return;
            if (done) { scanner.push(decoder.decode()); scanner.flush(); break; }
            scanner.push(decoder.decode(value, { stream: true }));
          }
          if (cancelled) return;
          if (!isTerminal()) throw new Error('Upstream stream interrupted before terminal event');
          controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
        } finally {
          await upstream.cancel().catch(() => {});
          upstream.releaseLock();
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      return reader?.cancel(reason).catch(() => {});
    },
  });
}
