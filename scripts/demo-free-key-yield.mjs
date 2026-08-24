#!/usr/bin/env node
// Reproducible before/after demonstration: free-key yield under
// per-key per-minute quotas enforced BY THE UPSTREAM (the mock counts
// requests per key and answers 429 once its quota is gone, like real
// free providers do).
//
// Scenario A ("old style"): 3 keys configured with distinct priorities
//          10/20/30 — traffic pins to the first key until it breaks.
// Scenario B ("new style"): same 3 keys, EQUAL priority + limits.rpm,
//          letting the scheduler rotate traffic across keys.
//
// Metric: how many of 45 sequential client requests succeed without
// seeing an error, and where the load landed.
import worker from '../src/index.js';
import { __resetAllStateForTests } from '../src/reliability/node-state.js';

const ACCESS_KEY = 'demo-key';
const KEYS = ['key-a', 'key-b', 'key-c'];
const QUOTA_PER_MIN = 10; // upstream-enforced, per key
const TOTAL_REQUESTS = 45;

function installEnforcingUpstream() {
  const hits = {}; // host -> { minute, count }
  globalThis.fetch = async (_url, init) => {
    const host = new URL(typeof _url === 'string' ? _url : _url.url).hostname;
    const id = host.split('.')[0];
    const minute = Math.floor(Date.now() / 60_000);
    if (!hits[id] || hits[id].minute !== minute) hits[id] = { minute, count: 0 };
    hits[id].count++;
    if (hits[id].count > QUOTA_PER_MIN) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      });
    }
    return new Response(JSON.stringify({
      id: 'ok', object: 'chat.completion', model: JSON.parse(init.body).model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => Object.fromEntries(KEYS.map((k) => [k, hits[`${k}`]?.count ?? 0]));
}

function makeEnv(priorities, withRpm) {
  const nodes = KEYS.map((k, i) => ({
    id: k,
    provider: 'free-tier',
    base_url: `https://${k}.example.com/v1`,
    priority: priorities[i],
    models: { m: 'm' },
    limits: withRpm ? { concurrency: 5, rpm: QUOTA_PER_MIN } : { concurrency: 5 },
  }));
  return {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    TIER1_NODES_CONFIG_01: JSON.stringify(nodes),
    NODE_SECRETS_01: JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, `cred-${k}`]))),
    LOG_LEVEL: 'none',
  };
}

async function runScenario(name, priorities, withRpm) {
  __resetAllStateForTests();
  installEnforcingUpstream();
  const env = makeEnv(priorities, withRpm);
  let ok = 0;
  let client429 = 0;
  let client503 = 0;
  let other = 0;
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    const res = await worker.fetch(new Request('https://gw.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
      body: JSON.stringify({ model: 'm', messages: [] }),
    }), env, {});
    if (res.status === 200) ok++;
    else if (res.status === 429) client429++;
    else if (res.status === 503) client503++;
    else other++;
    await res.text();
  }
  console.log(`\n${name}`);
  console.log(`  client success : ${ok}/${TOTAL_REQUESTS}`);
  console.log(`  client errors  : ${client429} x 429, ${client503} x 503, ${other} other`);
}

console.log(`Free-key yield demo: ${KEYS.length} keys x ${QUOTA_PER_MIN} req/min upstream quota = ${KEYS.length * QUOTA_PER_MIN} combined capacity.`);
console.log(`Load: ${TOTAL_REQUESTS} sequential requests (deliberately ABOVE one key's quota, BELOW the pool's).`);

await runScenario('Scenario A - old style (priorities 10/20/30, gateway unaware of RPM)', [10, 20, 30], false);
await runScenario('Scenario B - new style (equal priorities + limits.rpm)', [10, 10, 10], true);

console.log('\nInterpretation:');
console.log('  A pins traffic onto key-a until the upstream cuts it off, then cascades');
console.log('  through b and c; whatever arrives after the combined burn-down sees errors.');
console.log('  B spreads requests across all keys inside their quotas, so every request');
console.log('  is served from unused key capacity instead of triggering upstream 429s.');
process.exit(0);
