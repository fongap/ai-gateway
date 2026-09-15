#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import {
  persistTokenUsage,
  persistUpstreamAttemptUsage,
} from '../src/observability/token-usage-store.ts';
import {
  observeUpstreamAttemptUsage,
  recordTokens,
  recordUndeliveredUpstreamAttempt,
} from '../src/request/attempt/observability.ts';
import { reportedUsageFromPayload } from '../src/observability/reported-usage.ts';
import { trackStreamResponse } from '../src/stream/track.ts';

function fakeD1() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            run() {
              writes.push({ sql, params });
              return Promise.resolve({ success: true });
            },
          };
        },
      };
    },
  };
}

function sseResponse(parts) {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (i >= parts.length) return controller.close();
      const part = parts[i++];
      if (part instanceof Error) return controller.error(part);
      controller.enqueue(enc.encode(part));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {}
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('successful delivery updates delivered and upstream views in the same write set', async () => {
  const d1 = fakeD1();
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, Date.UTC(2026, 8, 15, 12), null);
  assert.equal(d1.writes.length, 2, 'success path must not double D1 write count');
  const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
  assert.ok(global);
  // Legacy prefix: hour + 8 delivered fields. Upstream 8 fields are appended.
  assert.deepEqual(global.params.slice(1, 9), [11, 7, 0, 0, 18, 1, 1, 0]);
  assert.deepEqual(global.params.slice(9, 17), [11, 7, 0, 0, 18, 1, 1, 0]);
});

test('failed physical attempt updates only upstream columns and never estimates missing tokens', async () => {
  const d1 = fakeD1();
  await persistUpstreamAttemptUsage({ TOKEN_STATS_DB: d1 }, null, Date.UTC(2026, 8, 15, 12), null);
  assert.equal(d1.writes.length, 2);
  const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
  assert.ok(global);
  assert.ok(!/\brequests\b/.test(global.sql), 'upstream-only write must not touch delivered requests');
  assert.deepEqual(global.params.slice(1), [0, 0, 0, 0, 0, 1, 0, 1]);
});

test('reported usage extraction accepts only native usage locations', () => {
  assert.deepEqual(reportedUsageFromPayload({ usage: { input_tokens: 3 } }), { input_tokens: 3 });
  assert.deepEqual(reportedUsageFromPayload({ message: { usage: { input_tokens: 4 } } }), { input_tokens: 4 });
  assert.deepEqual(reportedUsageFromPayload({ response: { usage: { input_tokens: 5 } } }), { input_tokens: 5 });
  assert.equal(reportedUsageFromPayload({ estimated_usage: { input_tokens: 999 } }), null);
});

test('one physical attempt is settled exactly once even when multiple paths try to finalize it', async () => {
  const d1 = fakeD1();
  const waits = [];
  const c = {
    env: { TOKEN_STATS_DB: d1 },
    ctx: { waitUntil(p) { waits.push(Promise.resolve(p)); } },
    logger: { info() {}, debug() {}, error() {} },
    requestedModel: 'Code-Max',
    reqDescriptor: { model: 'Code-Max' },
    state: { requestedModel: 'Code-Max' },
  };
  const node = { id: 'n1', provider: 'mock', tier: 'tier-1', models: { 'Code-Max': 'up-max' } };
  observeUpstreamAttemptUsage(c, { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 });
  recordUndeliveredUpstreamAttempt(c, node);
  recordUndeliveredUpstreamAttempt(c, node, { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 });
  recordTokens(c, node, { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 });
  await Promise.all(waits);
  assert.equal(d1.writes.length, 3, 'one upstream-only global/totals/model write set, not repeated settlements');
  const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
  assert.deepEqual(global.params.slice(1), [9, 1, 0, 0, 10, 1, 1, 0]);
});

test('successful settlement preserves a provider report observed before the terminal callback', async () => {
  const d1 = fakeD1();
  const waits = [];
  const c = {
    env: { TOKEN_STATS_DB: d1 },
    ctx: { waitUntil(p) { waits.push(Promise.resolve(p)); } },
    logger: { info() {}, debug() {}, error() {} },
    requestedModel: 'Code-Max',
    reqDescriptor: { model: 'Code-Max' },
    state: { requestedModel: 'Code-Max' },
  };
  const node = { id: 'n2', provider: 'mock', tier: 'tier-1', models: { 'Code-Max': 'up-max' } };
  observeUpstreamAttemptUsage(c, { input_tokens: 12, output_tokens: 3 });
  recordTokens(c, node, null);
  await Promise.all(waits);
  const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
  assert.deepEqual(global.params.slice(1, 9), [12, 3, 0, 0, 15, 1, 1, 0]);
  assert.deepEqual(global.params.slice(9, 17), [12, 3, 0, 0, 15, 1, 1, 0]);
});

test('interrupted stream exposes reported usage to physical-attempt accounting but not delivered onUsage', async () => {
  const attempts = [];
  const delivered = [];
  const tracked = trackStreamResponse(sseResponse([
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
    new Error('truncated'),
  ]), {
    idleTimeoutMs: 1000,
    completionMarker: /data:\s*\[DONE\]/,
    onSuccess() {},
    onFailure() {},
    onNeutral() {},
    onUsage: (u) => delivered.push(u),
    onAttemptUsage: (u, outcome) => attempts.push({ u, outcome }),
  });
  await drain(tracked);
  assert.equal(delivered.length, 0, 'interrupted stream must not become delivered-success evidence');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'failure');
  assert.deepEqual(attempts[0].u, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}
if (failed) {
  console.error(`upstream-attempt-usage: ${failed}/${tests.length} failed`);
  process.exit(1);
}
console.log(`upstream-attempt-usage tests passed (${tests.length}).`);
