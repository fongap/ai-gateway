#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { computeTierCaps } from '../src/request/tier-loop.ts';
import { loadPoliciesConfig } from '../src/config/policies.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { __resetTier1StateForTests(); await fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failed++; console.error(`FAIL: ${name}`); console.error(error?.stack || error); }
}
function node(id, tier) {
  return {
    id, tier, provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`, credential: 'secret', priority: 1,
    models: { m1: 'upstream-m1' },
  };
}
const REQ = { model: 'm1', protocol: 'openai', surface: 'chat_completions' };
const KNOWN = new Set(['m1']);

await test('strict tier precedence gives each dispatchable tier a baseline then surplus to Tier 1', () => {
  const tiers = {
    1: [node('t1-a', 'tier-1'), node('t1-b', 'tier-1')],
    2: [node('t2-a', 'tier-2')],
    3: [node('t3-a', 'tier-3')],
  };
  const policy = { maxAttempts: 6, tierAttempts: null, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
  assert.deepEqual(computeTierCaps(tiers, REQ, new Set(), policy, KNOWN), { 1: 4, 2: 1, 3: 1 });
});

await test('explicit tier cap is never inflated by surplus allocation', () => {
  const tiers = {
    1: [node('e1', 'tier-1')],
    2: [node('e2', 'tier-2')],
    3: [node('e3', 'tier-3')],
  };
  const policy = { maxAttempts: 6, tierAttempts: { tier1: 2 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
  const caps = computeTierCaps(tiers, REQ, new Set(), policy, KNOWN);
  assert.deepEqual(caps, { 1: 2, 2: 3, 3: 1 });
});

await test('explicit zero disables a tier without redistributing against precedence', () => {
  const tiers = {
    1: [node('z1', 'tier-1')],
    2: [node('z2', 'tier-2')],
    3: [node('z3', 'tier-3')],
  };
  const policy = { maxAttempts: 4, tierAttempts: { tier2: 0 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
  assert.deepEqual(computeTierCaps(tiers, REQ, new Set(), policy, KNOWN), { 1: 3, 2: 0, 3: 1 });
});

await test('built-in policy surface remains intentionally small', () => {
  const policies = loadPoliciesConfig({});
  assert.deepEqual(Object.keys(policies).sort(), ['default', 'fast', 'long-reasoning']);
});

console.log(`\n[scheduler-convergence] ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
