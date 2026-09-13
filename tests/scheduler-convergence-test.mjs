#!/usr/bin/env node
// Scheduler convergence contracts: weighted tier apportionment and the
// intentionally small built-in policy surface.
import assert from 'node:assert/strict';
import { computeTierCaps } from '../src/request/tier-loop.ts';
import { loadPoliciesConfig } from '../src/config/policies.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    __resetTier1StateForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
  }
}

function node(id, tier) {
  return {
    id,
    tier,
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    priority: 1,
    models: { m1: 'upstream-m1' },
  };
}

const REQ = { model: 'm1', protocol: 'openai', surface: 'chat_completions' };
const KNOWN = new Set(['m1']);

await test('weighted tier budget uses largest-remainder apportionment', () => {
  const tiers = {
    1: [node('t1-a', 'tier-1'), node('t1-b', 'tier-1'), node('t1-c', 'tier-1')],
    2: [node('t2-a', 'tier-2')],
    3: [node('t3-a', 'tier-3')],
  };
  const policy = {
    maxAttempts: 6,
    tierAttempts: null,
    hedge: null,
    firstEventTimeoutMs: null,
    budgetSplit: 'weighted',
  };
  const caps = computeTierCaps(tiers, REQ, new Set(), policy, KNOWN);
  assert.deepEqual(caps, { 1: 3, 2: 2, 3: 1 });
});

await test('weighted allocation never changes an explicit tier cap', () => {
  const tiers = {
    1: [node('e1-a', 'tier-1'), node('e1-b', 'tier-1'), node('e1-c', 'tier-1')],
    2: [node('e2-a', 'tier-2')],
    3: [node('e3-a', 'tier-3')],
  };
  const policy = {
    maxAttempts: 6,
    tierAttempts: { tier3: 2 },
    hedge: null,
    firstEventTimeoutMs: null,
    budgetSplit: 'weighted',
  };
  const caps = computeTierCaps(tiers, REQ, new Set(), policy, KNOWN);
  assert.equal(caps[3], 2);
  assert.equal(caps[1] + caps[2] + caps[3], 6);
  assert.ok(caps[1] >= caps[2]);
});

await test('stable is not a built-in policy', () => {
  const policies = loadPoliciesConfig({});
  assert.deepEqual(Object.keys(policies).sort(), ['default', 'fast', 'long-reasoning']);
  assert.equal(policies.stable, undefined);
});

console.log(`\n[scheduler-convergence] ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
