#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Tier 1 scheduler stability contracts for the current architecture.
//
// Deliberately NOT covered here: retired node limits, configured concurrency,
// node RPM buckets, RPM rollback, or the old 30/45/60 rate-limit ladder.
// Provider/key adaptive 429 timing is owned by adaptive-429.ts and its dedicated
// tests. Tier 1 scheduling treats live in-flight work as a soft signal only.

import assert from 'node:assert/strict';
import {
  __resetTier1StateForTests,
  isTier1Eligible,
  releaseTier1Slot,
  getTier1Account,
  getTier1Model,
  recordTier1Ttft,
  recordTier1Success,
  applyTier1Outcome,
  classifyTier1Failure,
  calculateTier1Score,
  snapshotTier1Runtime,
  recordTier1QuotaSignal,
  tier1BlockingWaitMs,
  TIER1_FAILURE_STATES,
} from '../src/reliability/tier1-state.ts';
import {
  pickTier1Candidate,
  tier1DeadlineTooSmall,
} from '../src/scheduler/tier1-scheduler.ts';
import {
  tier1AffinityFactor,
  readTier1Affinity,
  writeTier1Affinity,
  resolveTier1SessionId,
  shouldEvaluateAffinity,
  __resetTier1AffinityForTests,
} from '../src/scheduler/tier1-affinity.ts';
import {
  tier1ConcurrencyPressure,
  tier1SelectionHeatFactor,
  tier1CanAcceptHedge,
} from '../src/reliability/tier1-heat.ts';
import {
  nextAdaptive429CooldownMs,
  snapshotAdaptive429State,
  __resetAdaptive429StateForTests,
} from '../src/reliability/adaptive-429.ts';
import {
  isOpenAIChatRealOutput,
  isResponsesRealOutput,
  isAnthropicNativeRealOutput,
  isOpenAIChatCompletionMeaningful,
  isOpenAIResponsesObjectMeaningful,
  isAnthropicMessageMeaningful,
} from '../src/transport/index.ts';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    __resetAdaptive429StateForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
  }
}

function node(id, { models = { m1: 'up-x' }, provider = 'mock' } = {}) {
  return {
    id,
    tier: 'tier-1',
    provider,
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    priority: 1,
    models,
  };
}

const REQ = { model: 'm1', protocol: 'openai', surface: 'chat_completions' };

// ---- Eligibility and soft load --------------------------------------------

await test('eligibility excludes non-Tier-1 nodes', () => {
  assert.equal(isTier1Eligible(node('a'), REQ), true);
  assert.equal(isTier1Eligible({ ...node('b'), tier: 'tier-2' }, REQ), false);
  assert.equal(isTier1Eligible({ ...node('c'), tier: 'tier-3' }, REQ), false);
});

await test('model disable is scoped to the logical model', () => {
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  getTier1Model('a', 'm1').disabled = true;
  assert.equal(isTier1Eligible(a, REQ), false);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }), true);
  assert.equal(getTier1Account('a').accountDisabled, false);
});

await test('live in-flight work is soft: a busy sole node remains selectable', () => {
  const a = node('a');
  const first = pickTier1Candidate([a], REQ, new Set(), { now: 1_000 });
  const second = pickTier1Candidate([a], REQ, new Set(), { now: 1_001 });
  assert.ok(first?.node && second?.node);
  assert.equal(first.node.id, 'a');
  assert.equal(second.node.id, 'a');
  assert.equal(getTier1Account('a').inFlight, 2);
  releaseTier1Slot('a', first.releaseToken);
  releaseTier1Slot('a', first.releaseToken);
  assert.equal(getTier1Account('a').inFlight, 1, 'release token must be idempotent');
  releaseTier1Slot('a', second.releaseToken);
  assert.equal(getTier1Account('a').inFlight, 0);
});

await test('live pressure changes ranking/hedge admission without becoming eligibility', () => {
  const a = node('a');
  getTier1Account('a').inFlight = 3;
  assert.equal(tier1ConcurrencyPressure(a), 0.75);
  assert.ok(tier1SelectionHeatFactor(a, 1) > 1);
  assert.equal(tier1CanAcceptHedge(a), false);
  assert.equal(isTier1Eligible(a, REQ), true);
});

await test('active cooldown and exhausted explicit quota are hard eligibility gates', () => {
  const a = node('a');
  getTier1Model('a', 'm1').cooldownUntil = 20_000;
  assert.equal(isTier1Eligible(a, REQ, 10_000), false);
  __resetTier1StateForTests();
  assert.equal(recordTier1QuotaSignal('a', { remainingRatio: 0, resetAtMs: 20_000 }, 10_000), true);
  assert.equal(isTier1Eligible(a, REQ, 10_001), false);
  assert.equal(isTier1Eligible(a, REQ, 20_001), true);
});

// ---- P2C / score / TTFT ----------------------------------------------------

await test('P2C single candidate selects directly', () => {
  const a = node('a');
  const pick = pickTier1Candidate([a], REQ, new Set(), { now: 1_000 });
  assert.equal(pick?.node?.id, 'a');
  releaseTier1Slot('a', pick?.releaseToken);
});

await test('P2C never samples an ineligible tier or attempted node', () => {
  const a = node('a');
  const b = { ...node('b'), tier: 'tier-2' };
  const c = node('c');
  const pick = pickTier1Candidate([a, b, c], REQ, new Set(['c']), { rng: () => 0, now: 1_000 });
  assert.equal(pick?.node?.id, 'a');
  releaseTier1Slot('a', pick?.releaseToken);
});

await test('P2C prefers clearly lower passive TTFT when both are sampled', () => {
  const slow = node('slow');
  const fast = node('fast');
  recordTier1Ttft('slow', 'm1', 2_000, 1_000);
  recordTier1Ttft('fast', 'm1', 100, 1_000);
  const pick = pickTier1Candidate([slow, fast], REQ, new Set(), { rng: () => 0, now: 2_000 });
  assert.equal(pick?.node?.id, 'fast');
  releaseTier1Slot('fast', pick?.releaseToken);
});

await test('unknown account keeps exploration bonus without storing synthetic TTFT', () => {
  const known = node('known');
  const unknown = node('unknown');
  recordTier1Ttft('known', 'm1', 1_000, 1_000);
  const knownScore = calculateTier1Score(known, 'm1', [known, unknown], 1, 2_000);
  const unknownScore = calculateTier1Score(unknown, 'm1', [known, unknown], 1, 2_000);
  assert.ok(unknownScore < knownScore);
  assert.equal(getTier1Model('unknown', 'm1').ttftEwma, null);
  assert.equal(getTier1Model('unknown', 'm1').sampleCount, 0);
});

await test('TTFT EWMA initializes directly then uses alpha 0.25', () => {
  recordTier1Ttft('a', 'm1', 1_000, 1_000);
  assert.equal(getTier1Model('a', 'm1').ttftEwma, 1_000);
  recordTier1Ttft('a', 'm1', 500, 2_000);
  assert.equal(getTier1Model('a', 'm1').ttftEwma, 875);
  assert.equal(getTier1Model('a', 'm1').sampleCount, 2);
});

await test('one extreme TTFT is clamped; consecutive extremes expose persistent degradation', () => {
  recordTier1Ttft('a', 'm1', 1_000, 1_000);
  recordTier1Ttft('a', 'm1', 9_000, 2_000);
  const afterOne = getTier1Model('a', 'm1');
  assert.equal(afterOne.ttftEwma, 1_750);
  assert.equal(afterOne.consecutiveOutliers, 1);
  recordTier1Ttft('a', 'm1', 9_000, 3_000);
  assert.equal(afterOne.consecutiveOutliers, 2);
  assert.ok(afterOne.ttftEwma > 3_000);
});

await test('deadline gate yields before an attempt that cannot fit', () => {
  assert.equal(tier1DeadlineTooSmall(100), true);
  assert.equal(tier1DeadlineTooSmall(1_000), false);
  assert.equal(tier1DeadlineTooSmall(5_000, 2_000), true);
  assert.equal(tier1DeadlineTooSmall(10_000, 2_000), false);
});

await test('seeded P2C disperses traffic across a healthy pool', () => {
  const nodes = Array.from({ length: 8 }, (_, i) => node(`n${i}`));
  const counts = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  let seed = 0x12345678;
  const rng = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let i = 0; i < 200; i++) {
    const pick = pickTier1Candidate(nodes, REQ, new Set(), { rng, now: 10_000 + i });
    assert.ok(pick?.node);
    counts[pick.node.id]++;
    releaseTier1Slot(pick.node.id, pick.releaseToken);
  }
  assert.ok(Object.values(counts).filter((v) => v > 0).length >= 6, JSON.stringify(counts));
});

// ---- Meaningful-output boundary -------------------------------------------

await test('OpenAI Chat commits only on meaningful content/reasoning/tool output', () => {
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { role: 'assistant' } }] }), false);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { content: '   ' } }] }), false);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { content: 'hello' } }] }), true);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { reasoning_content: 'think' } }] }), true);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{' } }] } }] }), true);
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', content: '' } }] }), false);
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { content: 'ok' } }] }), true);
});

await test('Responses lifecycle events do not commit; output deltas do', () => {
  assert.equal(isResponsesRealOutput({ type: 'response.created', response: {} }), false);
  assert.equal(isResponsesRealOutput({ type: 'response.output_text.delta', delta: '' }), false);
  assert.equal(isResponsesRealOutput({ type: 'response.output_text.delta', delta: 'hello' }), true);
  assert.equal(isResponsesRealOutput({ type: 'response.function_call_arguments.delta', delta: '{' }), true);
  assert.equal(isOpenAIResponsesObjectMeaningful({ output: [{ type: 'message', content: [] }] }), false);
  assert.equal(isOpenAIResponsesObjectMeaningful({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }), true);
});

await test('Anthropic lifecycle events do not commit; text/thinking/tool input does', () => {
  assert.equal(isAnthropicNativeRealOutput({ type: 'ping' }), false);
  assert.equal(isAnthropicNativeRealOutput({ type: 'message_start', message: {} }), false);
  assert.equal(isAnthropicNativeRealOutput({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), false);
  assert.equal(isAnthropicNativeRealOutput({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'why' } }), true);
  assert.equal(isAnthropicNativeRealOutput({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), true);
  assert.equal(isAnthropicMessageMeaningful({ content: [{ type: 'text', text: '' }] }), false);
  assert.equal(isAnthropicMessageMeaningful({ content: [{ type: 'tool_use', name: 'lookup' }] }), true);
});

// ---- Affinity --------------------------------------------------------------

await test('affinity is a soft score bias', () => {
  assert.equal(tier1AffinityFactor('a', 'a'), 0.85);
  assert.equal(tier1AffinityFactor('b', 'a'), 1);
  assert.equal(tier1AffinityFactor('a', null), 1);
});

await test('affinity safely degrades without KV and validates session ids', async () => {
  assert.equal(await readTier1Affinity({}, 'session-12345678'), null);
  assert.equal(writeTier1Affinity({}, {}, 'session-12345678', 'a'), false);
  const short = new Request('https://x/', { headers: { 'x-session-id': 'short' } });
  const valid = new Request('https://x/', { headers: { 'x-session-id': 'abcdefgh' } });
  assert.equal(resolveTier1SessionId(short), null);
  assert.equal(resolveTier1SessionId(valid), 'abcdefgh');
});

await test('affinity escape evaluation is periodic, not per-request', () => {
  const sid = 'session-affinity-eval';
  for (let i = 0; i < 9; i++) assert.equal(shouldEvaluateAffinity(sid, 1_000 + i), false);
  assert.equal(shouldEvaluateAffinity(sid, 1_010), true);
});

await test('clearly degraded affinity can escape to the P2C winner', () => {
  const affinity = node('affinity');
  const peer = node('peer');
  recordTier1Ttft('affinity', 'm1', 5_000, 1_000);
  recordTier1Ttft('peer', 'm1', 100, 1_000);
  const pick = pickTier1Candidate([affinity, peer], REQ, new Set(), {
    affinityAccountId: 'affinity',
    evaluateAffinity: true,
    rng: () => 0,
    now: 2_000,
  });
  assert.equal(pick?.node?.id, 'peer');
  assert.equal(pick?.escapedFromAffinity, true);
  assert.equal(pick?.updateAffinity, true);
  releaseTier1Slot('peer', pick?.releaseToken);
});

// ---- Failure / recovery ----------------------------------------------------

await test('auth failure cools the whole credential without permanent disable', () => {
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  applyTier1Outcome('a', 'm1', classifyTier1Failure({ kind: 'auth' }), 1_000);
  const account = getTier1Account('a');
  assert.equal(account.accountDisabled, false);
  assert.ok(account.accountCooldownUntil > 1_000);
  assert.equal(isTier1Eligible(a, REQ, 2_000), false);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, 2_000), false);
});

await test('model_missing cools only the provider-facing mapping', () => {
  const now = 1_000_000;
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  const outcome = classifyTier1Failure({ kind: 'model_missing', cooldownMs: 5_000 });
  applyTier1Outcome('a', 'up-a', outcome, now);
  assert.equal(isTier1Eligible(a, REQ, now), false);
  assert.equal(tier1BlockingWaitMs(a, 'm1', now), 5_000);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, now), true);
  assert.equal(getTier1Account('a').models.get('m1'), undefined);
  const remapped = { ...a, models: { ...a.models, m1: 'up-new' } };
  assert.equal(isTier1Eligible(remapped, REQ, now), true);
});

await test('transient failures use hysteresis before entering cooldown', () => {
  const a = node('a');
  const failure = classifyTier1Failure({ kind: 'first_event_timeout' });
  applyTier1Outcome('a', 'm1', failure, 1_000);
  assert.equal(getTier1Model('a', 'm1').failureState, TIER1_FAILURE_STATES.NORMAL);
  assert.equal(getTier1Model('a', 'm1').consecutiveFailures, 1);
  applyTier1Outcome('a', 'm1', failure, 1_001);
  applyTier1Outcome('a', 'm1', failure, 1_002);
  assert.equal(getTier1Model('a', 'm1').failureState, TIER1_FAILURE_STATES.COOLDOWN);
  assert.ok(getTier1Model('a', 'm1').cooldownUntil > 1_002);
});

await test('account-scoped 429 gates one real recovery request, then success restores the key', () => {
  const now = 1_000_000;
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  const outcome = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('a', 'm1', outcome, now);
  assert.equal(isTier1Eligible(a, REQ, now + 9_999), false);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, now + 9_999), false);
  const probe = pickTier1Candidate([a], REQ, new Set(), { now: now + 10_000 });
  assert.ok(probe?.node);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, now + 10_001), false, 'recovery gate blocks a stampede');
  recordTier1Success('a', 'm1', now + 10_002);
  releaseTier1Slot('a', probe?.releaseToken);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, now + 10_003), true);
  assert.equal(getTier1Account('a').consecutiveRateLimits, 0);
});

await test('model-scoped 429 leaves sibling models eligible', () => {
  const now = 2_000_000;
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  const outcome = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'model' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('a', 'm1', outcome, now);
  assert.equal(isTier1Eligible(a, REQ, now + 9_999), false);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, now + 1), true);
  const probe = pickTier1Candidate([a], REQ, new Set(), { now: now + 10_000 });
  assert.ok(probe?.node);
  assert.equal(isTier1Eligible(a, REQ, now + 10_001), false);
  recordTier1Success('a', 'm1', now + 10_002);
  releaseTier1Slot('a', probe?.releaseToken);
  assert.equal(isTier1Eligible(a, REQ, now + 10_003), true);
});

await test('adaptive provider/key 429 ladder starts 15s then 30s', () => {
  const now = 3_000_000;
  assert.equal(nextAdaptive429CooldownMs('provider', 'key-a', 0, now), 15_000);
  assert.deepEqual(snapshotAdaptive429State('provider', 'key-a', now), {
    stage: 1,
    cooldown_remaining_ms: 15_000,
  });
  assert.equal(nextAdaptive429CooldownMs('provider', 'key-a', 0, now + 15_000), 30_000);
  assert.equal(snapshotAdaptive429State('provider', 'key-a', now + 15_000).stage, 2);
  assert.equal(snapshotAdaptive429State('provider', 'key-b', now).stage, 0, 'other key is isolated');
});

await test('half-open allows one real recovery request at a time', () => {
  const a = node('a');
  const failure = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('a', 'm1', failure, 1_000 + i);
  getTier1Model('a', 'm1').cooldownUntil = 2_000;
  const first = pickTier1Candidate([a], REQ, new Set(), { now: 2_001 });
  assert.ok(first?.node);
  assert.equal(getTier1Model('a', 'm1').failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  assert.equal(pickTier1Candidate([a], REQ, new Set(), { now: 2_002 }), null);
  releaseTier1Slot('a', first?.releaseToken);
});

await test('two successful half-open observations return the model to normal', () => {
  const a = node('a');
  const failure = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('a', 'm1', failure, 1_000 + i);
  getTier1Model('a', 'm1').cooldownUntil = 2_000;
  const first = pickTier1Candidate([a], REQ, new Set(), { now: 2_001 });
  assert.ok(first?.node);
  recordTier1Success('a', 'm1', 2_002);
  releaseTier1Slot('a', first?.releaseToken);
  assert.equal(getTier1Model('a', 'm1').failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  const second = pickTier1Candidate([a], REQ, new Set(), { now: 2_003 });
  assert.ok(second?.node);
  recordTier1Success('a', 'm1', 2_004);
  releaseTier1Slot('a', second?.releaseToken);
  assert.equal(getTier1Model('a', 'm1').failureState, TIER1_FAILURE_STATES.NORMAL);
});

await test('snapshot reports current state without retired capacity fields', () => {
  recordTier1Ttft('a', 'm1', 321, 1_000);
  const snapshot = snapshotTier1Runtime('a', 'm1', 1_001);
  assert.equal(snapshot.ttft_ewma_ms, 321);
  assert.equal(snapshot.sample_count, 1);
  assert.equal(snapshot.in_flight, 0);
  assert.equal('rpm' in snapshot, false);
  assert.equal('concurrency' in snapshot, false);
});

console.log(`\n[scheduler-stability] ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : ''));
if (failed) process.exit(1);
