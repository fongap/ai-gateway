export class FirstEventGuard {
  constructor(upstream, firstEventTimeout = 60_000) {
    this.upstream = upstream;
    this.firstEventTimeout = firstEventTimeout;
    this.firstEventReceived = false;
    this.firstEventData = null;
    this._aborted = false;
  }

  async waitForFirstEvent() {
    if (!this.upstream.body) {
      throw new Error('Upstream response has no body');
    }

    const reader = this.upstream.body.getReader();
    const decoder = new TextDecoder();
    let timerId = null;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('First event timeout')), this.firstEventTimeout);
    });

    const clearTimer = () => { if (timerId) { clearTimeout(timerId); timerId = null; } };

    try {
      let buffer = '';
      while (true) {
        const readPromise = reader.read();
        const { done, value } = await Promise.race([readPromise, timeout]);
        clearTimer();

        if (this._aborted) {
          await reader.cancel().catch(() => {});
          throw new Error('First event guard aborted');
        }

        if (done) {
          await reader.cancel().catch(() => {});
          throw new Error('Empty stream: upstream closed before any event');
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';

        for (const eventChunk of events) {
          const dataLines = eventChunk.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());

          if (dataLines.length > 0) {
            const data = dataLines.join('\n');
            if (data === '[DONE]') {
              await reader.cancel().catch(() => {});
              throw new Error('Empty stream: upstream sent [DONE] without data');
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content !== undefined
                || parsed.choices?.[0]?.delta?.reasoning_content
                || parsed.choices?.[0]?.delta?.tool_calls
                || parsed.type === 'content_block_start'
                || parsed.type === 'message_start') {
                this.firstEventReceived = true;
                this.firstEventData = { eventChunk, remainingBuffer: buffer };
                await reader.cancel().catch(() => {});
                return { eventChunk, remainingBuffer: buffer };
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      clearTimer();
      await reader.cancel().catch(() => {});
      throw e;
    }
  }

  abort() {
    this._aborted = true;
  }

  hasFirstEvent() {
    return this.firstEventReceived;
  }
}

export function isFirstEventAfterResponse(response) {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  return ct.includes('text/event-stream');
}

export function createGuardedStream(upstream, firstEventData, requestSignal, clientAbortListener) {
  const encoder = new TextEncoder();
  let firstEventEmitted = false;
  let cleanedUp = false;

  const cleanup = async (reader) => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (requestSignal && clientAbortListener) {
      requestSignal.removeEventListener('abort', clientAbortListener);
    }
    try { await reader.cancel().catch(() => {}); } catch {}
  };

  const stream = new ReadableStream({
    async start(controller) {
      if (firstEventData && !firstEventEmitted) {
        controller.enqueue(encoder.encode(firstEventData.eventChunk + '\n\n'));
        firstEventEmitted = true;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        let buffer = firstEventData?.remainingBuffer || '';
        while (true) {
          if (requestSignal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              controller.enqueue(encoder.encode(buffer));
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || '';
          for (const eventChunk of events) {
            controller.enqueue(encoder.encode(eventChunk + '\n\n'));
          }
        }
        controller.close();
      } catch (e) {
        if (!requestSignal?.aborted) {
          controller.error(e);
        }
      } finally {
        await cleanup(reader);
      }
    },
    cancel() { cleanup(upstream.body?.getReader()); },
  });

  return new Response(stream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}