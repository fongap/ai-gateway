#!/usr/bin/env node
// Gateway added-overhead benchmark.
//
// Measures the cost of running the same mocked upstream through ai-gateway
// versus calling it directly. This is NOT an absolute-RPS comparison against
// other gateways; it tracks this project's hot-path overhead so regressions
// become visible. Numbers depend on the local machine and a zero-latency
// mocked upstream; they are only comparable between runs of THIS script on
// the same machine.
//
// Usage:
//   node benchmark/benchmark.mjs            # full run
//   node benchmark/benchmark.mjs --quick    # CI smoke (fewer iterations)
import { performance } from 'node:perf_hooks';
import worker from '../src/index.js';
import { __resetAllStateForTests } from '../src/reliability/node-state.js';

const QUICK = process.argv.includes('--quick');
const DURATION_MS = QUICK ? 400 : 2000;
const ACCESS_KEY = 'bench-key';
const STREAM_EVENT_COUNTS = QUICK ? [100] : [100, 500, 1000];
const NODE_COUNTS = QUICK ? [5, 10] : [5, 10, 30];

function jsonCompletion() {
  return JSON.stringify({
    id: 'chatcmpl-bench', object: 'chat.completion', model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(64) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 16 },
  });
}

function sseStream(eventCount) {
  const enc = new TextEncoder();
  let i = 0;
  const chunk = (content) => JSON.stringify({
    id: 'c', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: null }],
  });
  return new ReadableStream({
    pull(controller) {
      if (i < eventCount) {
        controller.enqueue(enc.encode(`data: ${chunk('x'.repeat(20))}\n\n`));
        i++;
      } else if (i === eventCount) {
        const finish = JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        controller.enqueue(enc.encode(`data: ${finish}\n\n`));
        i++;
      } else {
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}

let mockStreamEvents = 100;

function installMockUpstream() {
  globalThis.fetch = async (_url, init) => {
    let wantsStream = false;
    try { wantsStream = JSON.parse(init.body).stream === true; } catch { /* ignore */ }
    if (wantsStream) {
      return new Response(sseStream(mockStreamEvents), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(jsonCompletion(), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function makeEnv(nodeCount) {
  const nodes = [];
  const secrets = {};
  for (let i = 0; i < nodeCount; i++) {
    const id = `bench-${String(i).padStart(2, '0')}`;
    nodes.push({ id, provider: 'mock', base_url: `https://${id}.example.com/v1`, priority: 10 + i, models: { m: 'm' }, limits: { concurrency: 50 } });
    secrets[id] = `cred-${i}`;
  }
  return {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    TIER1_NODES_CONFIG_01: JSON.stringify(nodes),
    TIER1_NODES_SECRETS_01: JSON.stringify(secrets),
    LOG_LEVEL: 'none',
  };
}

async function measure(name, fn) {
  for (let i = 0; i < 10; i++) await fn();
  const latencies = [];
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < DURATION_MS) {
    const t0 = performance.now();
    await fn();
    latencies.push(performance.now() - t0);
    count++;
  }
  const elapsed = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  return {
    name,
    rps: Math.round(count / elapsed),
    p50: +pct(0.50).toFixed(2),
    p95: +pct(0.95).toFixed(2),
    p99: +pct(0.99).toFixed(2),
  };
}

function printRow(r) {
  console.log(`${r.name.padEnd(42)} ${String(r.rps).padStart(7)} rps  p50=${String(r.p50).padStart(8)}ms  p95=${String(r.p95).padStart(8)}ms  p99=${String(r.p99).padStart(8)}ms`);
}

installMockUpstream();

const directNonStreamFn = async () => {
  const res = await fetch('https://direct.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  await res.text();
};

async function main() {
  console.log(`ai-gateway overhead benchmark (${QUICK ? 'quick' : 'full'} mode, ${DURATION_MS}ms/scenario)\n`);

  // Global JIT warmup so every scenario measures steady state.
  {
    const env = makeEnv(10);
    const gwBody = JSON.stringify({ model: 'm', messages: [] });
    for (let i = 0; i < 300; i++) {
      const req = new Request('https://gw.example.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
        body: gwBody,
      });
      const res = await worker.fetch(req, env, {});
      await res.text();
      await directNonStreamFn();
    }
    __resetAllStateForTests();
  }

  const rows = [];

  const directStream = async () => {
    const res = await fetch('https://direct.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    });
    await res.text();
  };

  rows.push(await measure('direct non-stream', directNonStreamFn));
  mockStreamEvents = STREAM_EVENT_COUNTS[0];
  rows.push(await measure(`direct stream e=${mockStreamEvents}`, directStream));

  for (const nodeCount of NODE_COUNTS) {
    __resetAllStateForTests();
    const env = makeEnv(nodeCount);
    const gw = (body) => async () => {
      const req = new Request('https://gw.example.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
        body,
      });
      const res = await worker.fetch(req, env, {});
      await res.text();
    };
    rows.push(await measure(`gateway non-stream ${nodeCount} nodes`, gw(JSON.stringify({ model: 'm', messages: [] }))));
  }

  // Streaming scenarios: one global mock phase per event count so the gateway
  // (which forwards only an allowlisted header set) still receives N events.
  for (const events of STREAM_EVENT_COUNTS) {
    mockStreamEvents = events;
    for (const nodeCount of NODE_COUNTS) {
      __resetAllStateForTests();
      const env = makeEnv(nodeCount);
      rows.push(await measure(`gateway stream e=${events} ${nodeCount} nodes`, async () => {
        const req = new Request('https://gw.example.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
          body: JSON.stringify({ model: 'm', messages: [], stream: true }),
        });
        const res = await worker.fetch(req, env, {});
        await res.text();
      }));
    }
  }

  console.log('');
  for (const row of rows) printRow(row);

  const base = rows[0];
  const gwRow = rows.find((r) => r.name.startsWith('gateway non-stream'));
  console.log('\ngateway added latency vs direct (non-stream):');
  if (gwRow) console.log(`  p50 +${(gwRow.p50 - base.p50).toFixed(2)}ms  p95 +${(gwRow.p95 - base.p95).toFixed(2)}ms  p99 +${(gwRow.p99 - base.p99).toFixed(2)}ms`);
  console.log(`\nenvironment: Node.js ${process.version}, single process, mocked zero-latency upstream, ${new Date().toISOString().slice(0, 10)}.`);
}

await main();
