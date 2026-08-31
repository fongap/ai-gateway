#!/usr/bin/env node
// Guardrails for the low-frequency background (node, model) TTFT probe.
import assert from 'node:assert/strict';
import { scheduleModelProbe, __resetModelProbesForTests } from '../src/scheduler/model-probes.js';
import { __resetAllStateForTests, getNodeState, rpmUsage } from '../src/reliability/node-state.js';

let passed = 0;
async function test(name, fn) {
  try {
    __resetAllStateForTests();
    __resetModelProbesForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

function node(id, limits = { concurrency: 2, rpm: 10 }) {
  return {
    id,
    tier: 'tier-1',
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    models: { air: 'up-air' },
    limits: { ...limits, rpmMode: limits.rpm_mode || 'hard' },
  };
}

function firstChunkResponse() {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"1"}}]}\n\n');
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

await test('probe records TTFT then immediately frees its slot', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return firstChunkResponse(); };
  const tasks = [];
  const scheduled = scheduleModelProbe({ waitUntil: (task) => tasks.push(task) }, {
    nodes: [node('fast')], model: 'air', protocol: 'openai', surface: 'chat_completions', env: {},
  });
  assert.equal(scheduled, true);
  await Promise.all(tasks);
  assert.equal(calls, 1);
  assert.ok(getNodeState('fast').avgTtftMs >= 0);
  assert.equal(getNodeState('fast').activeRequests, 0);
  assert.equal(rpmUsage('fast'), 1, 'the real upstream probe is charged to RPM');
});

await test('probe never consumes a user\'s final concurrency or hard-RPM slot', async () => {
  globalThis.fetch = async () => { throw new Error('must not probe'); };
  const noSlot = scheduleModelProbe({ waitUntil() {} }, {
    nodes: [node('single', { concurrency: 1, rpm: 10 })], model: 'air', protocol: 'openai', surface: 'chat_completions', env: {},
  });
  assert.equal(noSlot, false);
  const noRpm = scheduleModelProbe({ waitUntil() {} }, {
    nodes: [node('last-rpm', { concurrency: 2, rpm: 1 })], model: 'air', protocol: 'openai', surface: 'chat_completions', env: {},
  });
  assert.equal(noRpm, false);
});

await test('paid Tier 2 and Tier 3 nodes are never probed', async () => {
  globalThis.fetch = async () => { throw new Error('paid nodes must not be probed'); };
  for (const tier of ['tier-2', 'tier-3']) {
    const paid = { ...node(`paid-${tier}`), tier };
    const scheduled = scheduleModelProbe({ waitUntil() {} }, {
      nodes: [paid], model: 'air', protocol: 'openai', surface: 'chat_completions', env: {},
    });
    assert.equal(scheduled, false, `${tier} must be excluded from background probes`);
  }
});

console.log(`\nmodel probe tests passed (${passed}).`);
