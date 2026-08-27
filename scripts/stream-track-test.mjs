#!/usr/bin/env node
// Unit tests for trackStreamResponse stream-end telemetry: the three disjoint
// interruption reasons (missing_completion_marker / idle_timeout / reader_error)
// plus the completed and neutral outcomes, and the passive onUsage scan (the
// usage capture point for chat-passthrough streams). These run against the
// module directly because STREAM_IDLE_TIMEOUT_MS is clamped to >= 10s at the
// env layer, which makes idle-timeout scenarios impractical through the
// black-box worker suite.
import assert from 'node:assert/strict';
import { trackStreamResponse } from '../src/stream/track.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const encoder = new TextEncoder();
const MARKER = /data:\s*\[DONE\]\s*(?:\r?\n|$)/;
const sseChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const usageEvent = (usage) => `data: ${JSON.stringify({ id: 'chatcmpl-u', choices: [], usage })}\n\n`;

// Recorder collecting every callback invocation for assertions.
function recorder() {
  const calls = { success: 0, failure: 0, neutral: 0, start: 0, ends: [], usage: [] };
  return {
    calls,
    opts: {
      idleTimeoutMs: 0,
      completionMarker: MARKER,
      onSuccess: () => { calls.success++; },
      onFailure: () => { calls.failure++; },
      onNeutral: () => { calls.neutral++; },
      onStreamStart: () => { calls.start++; },
      onStreamEnd: (outcome, d) => { calls.ends.push({ outcome, ...d }); },
    },
    // opts + passive usage scan wired to the recorder.
    withUsage() {
      return { ...this.opts, onUsage: (u) => calls.usage.push(u) };
    },
  };
}

async function drain(response) {
  const reader = response.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

function assertCommonShape(end, expectedOutcome, expectedReason) {
  assert.equal(end.outcome, expectedOutcome);
  assert.equal(end.reason, expectedReason);
  assert.ok(typeof end.durationMs === 'number' && end.durationMs >= 0, `durationMs=${end.durationMs}`);
  assert.ok(Number.isInteger(end.chunkCount) && end.chunkCount >= 0, `chunkCount=${end.chunkCount}`);
  assert.ok(Number.isInteger(end.receivedBytes) && end.receivedBytes >= 0, `receivedBytes=${end.receivedBytes}`);
  assert.equal(typeof end.completionMarkerSeen, 'boolean');
}

function upstreamStream(pull) {
  return new Response(new ReadableStream({ pull }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

await test('text → [DONE] is completed with the marker seen', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('hello') + 'data: [DONE]\n\n'));
    c.close();
  }), r.opts);
  await drain(res);
  assert.equal(r.calls.success, 1);
  assert.equal(r.calls.failure, 0);
  assert.equal(r.calls.start, 1);
  assert.equal(r.calls.ends.length, 1);
  assertCommonShape(r.calls.ends[0], 'completed', null);
  assert.equal(r.calls.ends[0].completionMarkerSeen, true);
  assert.equal(r.calls.ends[0].chunkCount, 1);
  assert.ok(r.calls.ends[0].receivedBytes > 0);
});

await test('text → raw EOF is interrupted with missing_completion_marker', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('partial output')));
    c.close(); // clean FIN, no [DONE]
  }), r.opts);
  await drain(res); // wrapper still closes cleanly for the client
  assert.equal(r.calls.failure, 1);
  assert.equal(r.calls.success, 0);
  assert.equal(r.calls.ends.length, 1);
  assertCommonShape(r.calls.ends[0], 'interrupted', 'missing_completion_marker');
  assert.equal(r.calls.ends[0].completionMarkerSeen, false);
});

await test('text → reader throw is interrupted with reader_error', async () => {
  const r = recorder();
  let step = 0;
  const res = trackStreamResponse(upstreamStream((c) => {
    if (step === 0) {
      c.enqueue(encoder.encode(sseChunk('first ')));
      step = 1;
    } else {
      c.error(new Error('upstream died mid-stream'));
    }
  }), r.opts);
  await drain(res); // queued chunks delivered, then clean close (no throw)
  assert.equal(r.calls.failure, 1);
  assert.equal(r.calls.ends.length, 1);
  assertCommonShape(r.calls.ends[0], 'interrupted', 'reader_error');
  assert.ok(r.calls.ends[0].chunkCount >= 1);
});

await test('text → stalled stream is interrupted with idle_timeout', async () => {
  const r = recorder();
  let released = false;
  const res = trackStreamResponse(upstreamStream(async (c) => {
    if (!released) {
      c.enqueue(encoder.encode(sseChunk('only chunk')));
      released = true;
      // Park forever; the idle race must win.
      await new Promise(() => {});
    }
  }), { ...r.opts, idleTimeoutMs: 40 });
  await drain(res);
  assert.equal(r.calls.failure, 1);
  assert.equal(r.calls.ends.length, 1);
  assertCommonShape(r.calls.ends[0], 'interrupted', 'idle_timeout');
  assert.equal(r.calls.ends[0].chunkCount, 1);
  assert.ok(r.calls.ends[0].durationMs >= 30, `durationMs=${r.calls.ends[0].durationMs}`);
});

await test('client cancel is neutral and reports no reason', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('keep flowing'))); // never closes
  }), r.opts);
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(r.calls.neutral, 1);
  assert.equal(r.calls.failure, 0);
  assert.equal(r.calls.success, 0);
  assert.equal(r.calls.ends.length, 1);
  assertCommonShape(r.calls.ends[0], 'neutral', null);
});

await test('no completionMarker option: clean close counts as completed', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('done implicitly')));
    c.close();
  }), { ...r.opts, completionMarker: undefined });
  await drain(res);
  assert.equal(r.calls.success, 1);
  assert.equal(r.calls.ends.length, 1);
  assertCommonShape(r.calls.ends[0], 'completed', null);
  assert.equal(r.calls.ends[0].completionMarkerSeen, true);
});

await test('callbacks fire exactly once even when the client keeps pulling', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('x') + 'data: [DONE]\n\n'));
    c.close();
  }), r.opts);
  const reader = res.body.getReader();
  // Extra pulls after close must not re-finalize.
  await reader.read();
  await reader.read();
  await reader.read();
  assert.equal(r.calls.ends.length, 1);
  assert.equal(r.calls.success, 1);
});

// ---- Passive usage scan (onUsage) -------------------------------------------

await test('usage event + [DONE] completes and fires onUsage exactly once with the raw object', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('hi') + usageEvent({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }) + 'data: [DONE]\n\n'));
    c.close();
  }), r.withUsage());
  await drain(res);
  assert.deepEqual(r.calls.usage, [{ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }]);
  assert.equal(r.calls.success, 1);
});

await test('completed stream without any usage fires onUsage(null) exactly once', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('hi') + 'data: [DONE]\n\n'));
    c.close();
  }), r.withUsage());
  await drain(res);
  assert.deepEqual(r.calls.usage, [null]);
});

await test('clean-EOF truncation without usage still fires onUsage(null)', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('partial output')));
    c.close(); // clean FIN, no [DONE]
  }), r.withUsage());
  await drain(res);
  assert.equal(r.calls.failure, 1);
  assert.deepEqual(r.calls.usage, [null]);
});

await test('truncation AFTER a usage event keeps the reported usage (stream is still a failure)', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('partial') + usageEvent({ prompt_tokens: 2, completion_tokens: 4 })));
    c.close(); // clean FIN, no [DONE]
  }), r.withUsage());
  await drain(res);
  assert.equal(r.calls.failure, 1, 'no completion marker remains a failure');
  assert.deepEqual(r.calls.usage, [{ prompt_tokens: 2, completion_tokens: 4 }]);
});

await test('client cancel fires onUsage zero times', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(usageEvent({ prompt_tokens: 5, completion_tokens: 5 })));
  }), r.withUsage());
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(r.calls.neutral, 1);
  assert.equal(r.calls.usage.length, 0);
});

await test('usage JSON split across chunk boundaries is still captured (carry-over buffer)', async () => {
  const r = recorder();
  const full = usageEvent({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }) + 'data: [DONE]\n\n';
  const bytes = encoder.encode(full);
  const mid = 22; // lands inside the JSON payload
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(bytes.slice(0, mid));
    c.enqueue(bytes.slice(mid));
    c.close();
  }), r.withUsage());
  await drain(res);
  assert.deepEqual(r.calls.usage, [{ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }]);
});

await test('an early empty usage:{} does not clobber a later real report', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(usageEvent({}) + usageEvent({ prompt_tokens: 4, completion_tokens: 2 }) + 'data: [DONE]\n\n'));
    c.close();
  }), r.withUsage());
  await drain(res);
  assert.deepEqual(r.calls.usage, [{ prompt_tokens: 4, completion_tokens: 2 }]);
});

await test('two real usage events keep the LAST one', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(usageEvent({ prompt_tokens: 1, completion_tokens: 1 }) + usageEvent({ prompt_tokens: 7, completion_tokens: 9 }) + 'data: [DONE]\n\n'));
    c.close();
  }), r.withUsage());
  await drain(res);
  assert.deepEqual(r.calls.usage, [{ prompt_tokens: 7, completion_tokens: 9 }]);
});

await test('usage-free numeric strings and malformed data lines never crash the scan', async () => {
  const r = recorder();
  const junk = 'data: {not json}\n\n'
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: '5' } })}\n\n`
    + 'data: [DONE]\n\n';
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(junk));
    c.close();
  }), r.withUsage());
  await drain(res);
  // '5' is a numeric string → normalizeTokenUsage rejects it → nothing usable
  // was reported → the single fire carries null, not the junk object.
  assert.deepEqual(r.calls.usage, [null]);
});

await test('data lines arriving AFTER the completion marker are not scanned', async () => {
  const r = recorder();
  const res = trackStreamResponse(upstreamStream((c) => {
    c.enqueue(encoder.encode(sseChunk('x') + 'data: [DONE]\n\n'));
    c.enqueue(encoder.encode(usageEvent({ prompt_tokens: 99, completion_tokens: 99 })));
    c.close();
  }), r.withUsage());
  await drain(res);
  assert.deepEqual(r.calls.usage, [null]);
});

if (!process.exitCode) console.log(`\nstream-track tests passed (${passed}).`);
else process.exit(1);
