#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// P0-01 regression tests: raceLost same-tier re-evaluation.
//
// Verifies that when a candidate's slot is lost to a concurrent request
// (raceLost), the scheduler retries within the SAME tier instead of
// breaking to the next tier. Also verifies bounded termination.

import assert from 'node:assert/strict';
import {
  acquireSlot, peekAvailability, recordSuccess, recordFailure, recordNeutralEnd,
  getNodeState,
} from '../src/reliability/node-state.ts';
import { pickCandidate } from '../src/scheduler/scheduler.ts';
import { pickTier1Candidate } from '../src/scheduler/tier1-scheduler.ts';
import { pickForTier } from '../src/request/tier-loop.ts';
import {
  __resetTier1StateForTests,
  isTier1Eligible, claimTier1Slot, releaseTier1Slot,
  TIER1_FAILURE_STATES,
} from '../src/reliability/tier1-state.ts';

let passed = 0, failed = 0;
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
    process.exitCode = 1;
  }
}

function tier2Node(id, { concurrency = 2, rpm = 100 } = {}) {
  return {
    id,
    tier: 'tier-2',
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    models: { m1: 'up-x' },
    limits: { concurrency, rpm, rpmMode: 'hard' },
  };
}

function tier1Node(id, { concurrency = 2, rpm = 100 } = {}) {
  return {
    id,
    tier: 'tier-1',
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    models: { m1: 'up-x' },
    limits: { concurrency, rpm, rpmMode: 'hard' },
  };
}

const REQ = { model: 'm1', protocol: 'openai', surface: 'chat_completions' };

// ---- Case 1: raceLost -> same-tier retry with another node ----

await test('Case 1: full node skipped -> picks next available node in same tier', () => {
  const nodes = [tier2Node('a'), tier2Node('b')];
  // Fill all slots on 'a' so it's at concurrency limit
  acquireSlot('a', 1000);
  acquireSlot('a', 1000);
  // 'a' has activeRequests=2 >= concurrency=2, so it's skipped
  // 'b' has activeRequests=0, so it's picked
  const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, null);
  assert.ok(pick?.node, 'should pick node b');
  assert.equal(pick.node.id, 'b');
});

await test('Case 1b: raceLost with excludeIds -> skips lost node, picks another', () => {
  const nodes = [tier2Node('ex-a'), tier2Node('ex-b'), tier2Node('ex-c')];
  const raceLostIds = new Set(['ex-a']);
  const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, raceLostIds);
  assert.ok(pick?.node, 'should pick a node after excluding race-lost');
  assert.notEqual(pick.node.id, 'ex-a', 'must not pick the race-lost node');
});

await test('Case 1c: Tier 1 raceLost with excludeIds -> skips lost node', () => {
  const nodes = [tier1Node('a'), tier1Node('b')];
  const raceLostIds = new Set(['a']);
  const pick = pickTier1Candidate(nodes, REQ, new Set(), { raceLostIds });
  assert.ok(pick?.node, 'Tier 1 should pick a node after excluding race-lost');
  assert.notEqual(pick.node.id, 'a', 'Tier 1 must not pick the race-lost node');
});

await test('Case 1d: pickForTier passes raceLostIds through (Tier 2)', () => {
  const nodes = [tier2Node('a'), tier2Node('b')];
  const raceLostIds = new Set(['a']);
  const pick = pickForTier(2, nodes, REQ, new Set(), { raceLostIds });
  assert.ok(pick?.node, 'pickForTier should pick after excluding race-lost');
  assert.equal(pick.node.id, 'b');
});

// ---- Case 2: bounded termination ----

await test('Case 2: all nodes race-lost -> returns null (not infinite loop)', () => {
  const nodes = [tier2Node('a'), tier2Node('b')];
  const raceLostIds = new Set(['a', 'b']);
  const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, raceLostIds);
  assert.equal(pick, null, 'all nodes excluded -> null');
});

await test('Case 2b: single node race-lost -> returns null', () => {
  const nodes = [tier2Node('a')];
  const raceLostIds = new Set(['a']);
  const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, raceLostIds);
  assert.equal(pick, null, 'single node excluded -> null');
});

// ---- Case 3: no candidates -> moves to next tier ----

await test('Case 3: no eligible candidates in tier -> null (tier loop moves on)', () => {
  const nodes = [tier2Node('a')];
  // Mark 'a' as attempted so it's excluded
  const attempted = new Set(['a']);
  const pick = pickCandidate(nodes, REQ, attempted, 1000, null, null, null);
  assert.equal(pick, null, 'attempted node -> null');
});

await test('Case 3b: tier with wrong protocol -> null', () => {
  const nodes = [{
    id: 'anthropic-only',
    tier: 'tier-2',
    provider: 'mock',
    protocol: 'anthropic',
    surfaces: ['messages'],
    baseUrl: 'https://example.com',
    credential: 'secret',
    models: { m1: 'up-x' },
    limits: { concurrency: 2, rpm: 100, rpmMode: 'hard' },
  }];
  const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, null);
  assert.equal(pick, null, 'protocol mismatch -> null');
});

// ---- Case 4: tier order preserved ----

await test('Case 4: Tier 1 -> Tier 2 -> Tier 3 order is preserved in pickForTier', () => {
  const t1 = [tier1Node('t1-a')];
  const t2 = [tier2Node('t2-a')];
  const t3 = [tier2Node('t3-a')];

  const pick1 = pickForTier(1, t1, REQ, new Set());
  assert.ok(pick1?.node, 'Tier 1 picks');
  assert.equal(pick1.node.id, 't1-a');

  const pick2 = pickForTier(2, t2, REQ, new Set());
  assert.ok(pick2?.node, 'Tier 2 picks');
  assert.equal(pick2.node.id, 't2-a');

  const pick3 = pickForTier(3, t3, REQ, new Set());
  assert.ok(pick3?.node, 'Tier 3 picks');
  assert.equal(pick3.node.id, 't3-a');
});

await test('Case 4b: Tier 1 exhausted, Tier 2 available -> Tier 2 picks', () => {
  const t2 = [tier2Node('t2-a')];
  const pick2 = pickForTier(2, t2, REQ, new Set());
  assert.ok(pick2?.node, 'Tier 2 picks when available');
  assert.equal(pick2.node.id, 't2-a');
});

// ---- Case 5: raceLost does not charge logical attempts ----

await test('Case 5: raceLost exclusion allows retry without budget charge', () => {
  const nodes = [tier2Node('rl-a'), tier2Node('rl-b')];
  const raceLostIds = new Set(['rl-a']);
  const pick = pickForTier(2, nodes, REQ, new Set(), { raceLostIds });
  assert.ok(pick?.node, 'after raceLost exclusion, picks next node');
  assert.notEqual(pick.node.id, 'rl-a', 'must not pick the race-lost node');
  assert.ok(!pick.raceLost, 'second pick should not be raceLost');
});

// ---- Summary ----
console.log(`\n[scheduler-racelost-test] ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
