#!/usr/bin/env node
// Tier 1 scheduler stability tests. Exercises the REAL new Tier 1 state
// machine and P2C + score path, without any network I/O.
//
// Covered behaviour (per the Tier 1 refactor spec):
//   - Eligibility: tier/2/3 excluded; (account,model) disabled filtered;
//     hard concurrency/RPM filtered; cooldown filtered; model_not_found scope.
//   - P2C: only samples from the eligible pool; single candidate direct pick;
//     never performs a full ordering; UNKNOWN gets the exploration factor.
//   - UNKNOWN: ttftEwma stays null; score uses the known median (or neutral
//     default) as a scheduling-only value; the fallback is never written
//     back and never increments sampleCount.
//   - EWMA: first real sample assigns directly (no weighted mix with null);
//     subsequent samples use alpha=0.25; a single outlier is clamped to
//     oldEwma * 4; consecutiveOutliers >= 2 stops clamping; a non-outlier
//     sample resets consecutiveOutliers; sampleCount increments every time.
//   - Meaningful TTFT: failed requests (no meaningful output) do NOT write
//     any TTFT sample — only recordTier1Ttft does, and only on real output.
//   - inFlight: claimTier1Slot respects concurrency cap; releaseTier1Slot is
//     idempotent (once-token).
//   - Affinity: soft bias in the score; escape window compares the affinity
//     account against THIS round's P2C winner only; on a successful escape
//     the new account is written (no-op without a KV binding).
//   - Failure: single transient failure does not immediately trip cooldown;
//     >= FAILURE_THRESHOLD consecutive counted failures do; HALF_OPEN needs
//     2 successes; 401/403 cools the account; model_not_found short-cools
//     only the (account, upstream model) pair; ambiguous 429 defaults to the
//     key/account scope, respects Retry-After, and uses short availability-first
//     recovery; cooldown never breaks the "no call against an unexpired cooldown" rule.
import assert from 'node:assert/strict';
import {
  __resetTier1StateForTests,
  isTier1Eligible, claimTier1Slot, releaseTier1Slot, makeTier1ReleaseToken,
  getTier1Account, getTier1Model, recordTier1Ttft, recordTier1Success, applyTier1Outcome,
  classifyTier1Failure, calculateTier1Score, snapshotTier1Runtime, recordTier1QuotaSignal,
  tier1BlockingWaitMs, rollbackTier1Rpm,
  TIER1_FAILURE_STATES,
} from '../src/reliability/tier1-state.ts';
import {
  pickTier1Candidate, tier1DeadlineTooSmall,
} from '../src/scheduler/tier1-scheduler.ts';
import {
  readTier1Affinity, writeTier1Affinity, resolveTier1SessionId,
  shouldEvaluateAffinity, tier1AffinityFactor, __resetTier1AffinityForTests,
} from '../src/scheduler/tier1-affinity.ts';
import {
  isOpenAIChatRealOutput, isResponsesRealOutput, isAnthropicNativeRealOutput,
  isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful,
  isAnthropicMessageMeaningful,
} from '../src/transport/index.ts';

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
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

function node(id, { concurrency = 2, rpm = 0, models = { m1: 'up-x' } } = {}) {
  return {
    id,
    tier: 'tier-1',
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    models,
    limits: { concurrency, rpm, rpmMode: 'hard' },
  };
}
const REQ = { model: 'm1', protocol: 'openai', surface: 'chat_completions' };

// ---- Eligibility ----------------------------------------------------------

await test('Eligibility: Tier 2/3 nodes are excluded', () => {
  const t1 = { ...node('a'), tier: 'tier-1' };
  const t2 = { ...node('b'), tier: 'tier-2' };
  const t3 = { ...node('c'), tier: 'tier-3' };
  assert.equal(isTier1Eligible(t1, REQ), true);
  assert.equal(isTier1Eligible(t2, REQ), false);
  assert.equal(isTier1Eligible(t3, REQ), false);
});

await test('Eligibility: (account,model) disabled filtered; model-scope only', () => {
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  getTier1Model('a', 'm1').disabled = true;
  assert.equal(isTier1Eligible(a, REQ), false, 'm1 disabled -> ineligible for m1');
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }), true, 'm2 still eligible');
  assert.equal(getTier1Account('a').accountDisabled, false);
});

await test('Eligibility: hard concurrency and RPM cap are filtered', () => {
  const b = node('b', { concurrency: 1, rpm: 1 });
  assert.ok(claimTier1Slot(b));
  assert.equal(isTier1Eligible(b, REQ), false, 'concurrency full -> ineligible');
  assert.equal(claimTier1Slot(b), false, 'second claim must fail (rpm + concurrency full)');
  const tok = makeTier1ReleaseToken('b');
  getTier1Account('b').inFlight = Math.max(0, getTier1Account('b').inFlight - 1);
});

await test('RPM: smooth admission removes fixed-minute boundary reset', () => {
  const b = node('b', { concurrency: 10, rpm: 40 });
  const t0 = 59_999;
  assert.equal(claimTier1Slot(b, t0, 'm1'), true);
  getTier1Account('b').inFlight--;
  assert.equal(claimTier1Slot(b, t0, 'm1'), true, 'one small burst token is allowed');
  getTier1Account('b').inFlight--;
  assert.equal(claimTier1Slot(b, t0, 'm1'), false, 'burst capacity exhausted');
  assert.equal(claimTier1Slot(b, 60_001, 'm1'), false, 'calendar minute boundary must not reset admission');
  assert.equal(tier1BlockingWaitMs(b, 'm1', t0), 1_500, '40 RPM refills one token every 1.5s');
  assert.equal(claimTier1Slot(b, t0 + 1_500, 'm1'), true, 'continuous refill admits after one interval');
});

await test('RPM: rollback restores a pre-dispatch token', () => {
  const b = node('b', { concurrency: 10, rpm: 1 });
  const now = 100_000;
  assert.equal(claimTier1Slot(b, now, 'm1'), true);
  getTier1Account('b').inFlight--;
  assert.equal(claimTier1Slot(b, now, 'm1'), false);
  rollbackTier1Rpm('b', now);
  assert.equal(claimTier1Slot(b, now, 'm1'), true, 'rollback must restore the consumed admission token');
});

await test('RPM: explicit model-scoped 429 recovery suppresses same-model burst without blocking siblings', () => {
  const b = node('b', { concurrency: 10, rpm: 40, models: { m1: 'up-1', m2: 'up-2' } });
  const now = 1_000_000;
  assert.equal(claimTier1Slot(b, now, 'm1'), true);
  getTier1Account('b').inFlight--;
  const outcome = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'model' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('b', 'm1', outcome, now);
  assert.equal(isTier1Eligible(b, REQ, now + 9_999), false, 'Retry-After cooldown remains authoritative');
  assert.equal(isTier1Eligible(b, { ...REQ, model: 'm2' }, now + 1), true, 'explicit model-scoped 429 must not block sibling models');
  assert.equal(claimTier1Slot(b, now + 1, 'm2'), true, 'sibling model may keep using remaining account RPM capacity');
  getTier1Account('b').inFlight--;
  assert.equal(isTier1Eligible(b, REQ, now + 10_000), true, 'one m1 request may resume at cooldown expiry');
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), true);
  getTier1Account('b').inFlight--;
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), false, 'same model must not burst immediately after 429 recovery');
  recordTier1Success('b', 'm1', now + 10_001);
  assert.equal(isTier1Eligible(b, REQ, now + 10_001), true, 'successful recovery immediately clears the probe gate');
});

await test('RPM: explicit account-scoped 429 recovery gates the whole account until probe success', () => {
  const b = node('b', { concurrency: 10, rpm: 40, models: { m1: 'up-1', m2: 'up-2' } });
  const now = 2_000_000;
  assert.equal(claimTier1Slot(b, now, 'm1'), true);
  getTier1Account('b').inFlight--;
  const outcome = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('b', 'm1', outcome, now);
  assert.equal(isTier1Eligible(b, REQ, now + 10_000), true);
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), true);
  getTier1Account('b').inFlight--;
  assert.equal(isTier1Eligible(b, { ...REQ, model: 'm2' }, now + 10_000), false, 'account-scoped recovery gates sibling models during the probe');
  recordTier1Success('b', 'm1', now + 10_001);
  assert.equal(isTier1Eligible(b, { ...REQ, model: 'm2' }, now + 10_001), true, 'successful recovery immediately restores the key');
});

await test('Eligibility: cooldown filtered (no force-call on cooling account)', () => {
  const a = node('a');
  getTier1Model('a', 'm1').cooldownUntil = Date.now() + 60_000;
  assert.equal(isTier1Eligible(a, REQ), false);
});

await test('Eligibility: known exhausted quota is filtered until reset', () => {
  const a = node('a');
  assert.equal(recordTier1QuotaSignal('a', { remainingRatio: 0, resetAtMs: Date.now() + 60_000 }), true);
  assert.equal(isTier1Eligible(a, REQ), false);
});

// ---- P2C ------------------------------------------------------------------

await test('P2C: single eligible -> direct pick', () => {
  const a = node('a');
  const pick = pickTier1Candidate([a], REQ, new Set());
  assert.ok(pick && pick.node);
  assert.equal(pick.node.id, 'a');
  releaseTier1Slot('a', pick.releaseToken);
});

await test('P2C: only samples from the eligible pool', () => {
  const a = node('a');
  const b = { ...node('b'), tier: 'tier-2' };
  for (let i = 0; i < 50; i++) {
    const pick = pickTier1Candidate([a, b], REQ, new Set());
    assert.ok(pick && pick.node);
    assert.equal(pick.node.id, 'a', 'must only ever pick a (b is tier-2)');
    releaseTier1Slot('a', pick.releaseToken);
  }
});

await test('P2C: does not perform a full sort; spreads across accounts', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => node(id));
  const counts = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < 200; i++) {
    const p = pickTier1Candidate(nodes, REQ, new Set());
    if (p && p.node) {
      counts[p.node.id]++;
      releaseTier1Slot(p.node.id, p.releaseToken);
    }
  }
  const seen = Object.entries(counts).filter(([, c]) => c > 0).length;
  assert.ok(seen >= 6, `expected most nodes hit, saw ${seen}/8: ${JSON.stringify(counts)}`);
});

await test('P2C: two candidates choose the lower passive-TTFT score', () => {
  const a = node('a');
  const b = node('b');
  recordTier1Ttft('a', 'm1', 2000);
  recordTier1Ttft('b', 'm1', 100);
  const pick = pickTier1Candidate([a, b], REQ, new Set(), { rng: () => 0 });
  assert.equal(pick.node.id, 'b');
  releaseTier1Slot('b', pick.releaseToken);
});

await test('Score: load penalty is relative to configured concurrency capacity', () => {
  const small = node('small', { concurrency: 2 });
  const large = node('large', { concurrency: 20 });
  recordTier1Ttft('small', 'm1', 500);
  recordTier1Ttft('large', 'm1', 500);
  getTier1Account('small').inFlight = 1;
  getTier1Account('large').inFlight = 1;
  const candidates = [small, large];
  assert.ok(calculateTier1Score(small, 'm1', candidates)
    > calculateTier1Score(large, 'm1', candidates));
});

await test('TTFT scoring: 1s node scores better than 2s node (bounded demotion)', () => {
  const fast = node('fast');
  const slow = node('slow');
  recordTier1Ttft('fast', 'm1', 1000);
  recordTier1Ttft('slow', 'm1', 2000);
  const candidates = [fast, slow];
  const scoreFast = calculateTier1Score(fast, 'm1', candidates);
  const scoreSlow = calculateTier1Score(slow, 'm1', candidates);
  assert.ok(scoreFast < scoreSlow, `fast (${scoreFast}) should score lower than slow (${scoreSlow})`);
});

await test('TTFT factor: very slow node gets at most 1.50x penalty', () => {
  const baseline = node('baseline');
  const slow = node('slow');
  recordTier1Ttft('baseline', 'm1', 1000);
  recordTier1Ttft('slow', 'm1', 100000);
  const candidates = [baseline, slow];
  const scoreBase = calculateTier1Score(baseline, 'm1', candidates);
  const scoreSlow = calculateTier1Score(slow, 'm1', candidates);
  assert.ok(scoreSlow / scoreBase <= 1.8,
    `slow/baseline ratio (${(scoreSlow / scoreBase).toFixed(3)}) should be bounded`);
});

await test('TTFT factor: very fast node gets at most 0.85x bonus', () => {
  const baseline = node('baseline');
  const fast = node('fast');
  recordTier1Ttft('baseline', 'm1', 1000);
  recordTier1Ttft('fast', 'm1', 1);
  const candidates = [baseline, fast];
  const scoreBase = calculateTier1Score(baseline, 'm1', candidates);
  const scoreFast = calculateTier1Score(fast, 'm1', candidates);
  assert.ok(scoreFast / scoreBase >= 0.5,
    `fast/baseline ratio (${(scoreFast / scoreBase).toFixed(3)}) should show bonus`);
});

await test('TTFT scoring: unknown node is not penalized (keeps exploration factor)', () => {
  const known = node('known');
  const unknown = node('unknown');
  recordTier1Ttft('known', 'm1', 1000);
  const candidates = [known, unknown];
  const scoreKnown = calculateTier1Score(known, 'm1', candidates);
  const scoreUnknown = calculateTier1Score(unknown, 'm1', candidates);
  assert.ok(scoreUnknown < scoreKnown,
    `unknown (${scoreUnknown}) should score lower than known (${scoreKnown}) due to exploration`);
});

await test('TTFT does not change failure state, cooldown, or consecutiveFailures', () => {
  const a = node('a');
  applyTier1Outcome('a', 'm1', { action: 'cooldown', counted: true, reason: 'server', backoff: 'server' });
  const m = getTier1Model('a', 'm1');
  const beforeState = m.failureState;
  const beforeFailures = m.consecutiveFailures;
  const beforeCooldown = m.cooldownUntil;
  recordTier1Ttft('a', 'm1', 500);
  assert.equal(m.failureState, beforeState, 'failureState unchanged after TTFT');
  assert.equal(m.consecutiveFailures, beforeFailures, 'consecutiveFailures unchanged after TTFT');
  assert.equal(m.cooldownUntil, beforeCooldown, 'cooldownUntil unchanged after TTFT');
});

await test('P2C: deadline gate returns null when remaining budget is too small', () => {
  assert.equal(tier1DeadlineTooSmall(100), true);
  assert.equal(tier1DeadlineTooSmall(1_000), false);
  assert.equal(tier1DeadlineTooSmall(60_000), false);
  assert.equal(tier1DeadlineTooSmall(5_000, 2_000), true);
  assert.equal(tier1DeadlineTooSmall(10_000, 2_000), false);
});

// ---- UNKNOWN & EWMA -------------------------------------------------------

await test('UNKNOWN: ttftEwma stays null until a real sample; median is not written back', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const s = calculateTier1Score(nodes[0], 'm1', nodes, 1.0);
  assert.ok(s > 0);
  const perfA = getTier1Model('a', 'm1');
  assert.equal(perfA.ttftEwma, null);
  assert.equal(perfA.sampleCount, 0);
});

await test('EWMA: first sample assigns directly, no weighted mix against null', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 800);
  const perf = getTier1Account('a').models.get('m1');
  assert.equal(perf.ttftEwma, 800);
  assert.equal(perf.sampleCount, 1);
  assert.equal(perf.consecutiveOutliers, 0);
});

await test('EWMA: subsequent samples use alpha=0.25; converges', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 1000);
  recordTier1Ttft('a', 'm1', 1000);
  assert.equal(getTier1Account('a').models.get('m1').ttftEwma, 1000);
  recordTier1Ttft('a', 'm1', 500);
  const e = getTier1Account('a').models.get('m1').ttftEwma;
  assert.ok(Math.abs(e - 875) < 0.001, `expected 875, got ${e}`);
  assert.equal(getTier1Account('a').models.get('m1').sampleCount, 3);
});

await test('Outlier: single sample clamped, sampleCount still increments, consecutiveOutliers=1', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 1000);
  recordTier1Ttft('a', 'm1', 9000);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.ttftEwma, 1750, 'clamped sample (4000) blended into EWMA = 1750');
  assert.equal(m.consecutiveOutliers, 1);
  assert.equal(m.sampleCount, 2);
});

await test('Outlier: 2 consecutive outliers stop clamping (raw value used)', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 1000);
  recordTier1Ttft('a', 'm1', 9000);
  recordTier1Ttft('a', 'm1', 9000);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.consecutiveOutliers, 2, 'consecutive outliers must reach 2');
  assert.ok(m.ttftEwma > 3000, `expected EWMA > 3000 after real degradation, got ${m.ttftEwma}`);
});

await test('Outlier: a non-outlier sample resets consecutiveOutliers to 0', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 1000);
  recordTier1Ttft('a', 'm1', 9000);
  recordTier1Ttft('a', 'm1', 1000);
  assert.equal(getTier1Account('a').models.get('m1').consecutiveOutliers, 0);
});

await test('Failed requests do NOT produce TTFT samples', () => {
  const a = node('a');
  applyTier1Outcome('a', 'm1', { action: 'cooldown', cooldownMs: 0, counted: true, reason: 'first_event_timeout', backoff: 'timeout' });
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.ttftEwma, null);
  assert.equal(m.sampleCount, 0);
  assert.equal(m.failureState, TIER1_FAILURE_STATES.NORMAL);
});

await test('Meaningful TTFT: OpenAI Chat ignores role/empty metadata and accepts content, reasoning, or tools', () => {
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { role: 'assistant' } }] }), false);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { content: '   ' } }] }), false);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { content: 'hello' } }] }), true);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { reasoning_content: 'think' } }] }), true);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{' } }] } }] }), true);
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', content: '' } }] }), false);
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { tool_calls: [{ function: { name: 'run' } }] } }] }), true);
});

await test('Meaningful TTFT: Responses ignores lifecycle/metadata and accepts output deltas or final output', () => {
  assert.equal(isResponsesRealOutput({ type: 'response.created', response: {} }), false);
  assert.equal(isResponsesRealOutput({ type: 'response.output_text.delta', delta: '' }), false);
  assert.equal(isResponsesRealOutput({ type: 'response.output_text.delta', delta: 'hello' }), true);
  assert.equal(isResponsesRealOutput({ type: 'response.function_call_arguments.delta', delta: '{' }), true);
  assert.equal(isOpenAIResponsesObjectMeaningful({ output: [{ type: 'message', content: [] }] }), false);
  assert.equal(isOpenAIResponsesObjectMeaningful({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] }), true);
});

await test('Meaningful TTFT: Anthropic ignores heartbeat/lifecycle and accepts text, thinking, or tool input', () => {
  assert.equal(isAnthropicNativeRealOutput({ type: 'ping' }), false);
  assert.equal(isAnthropicNativeRealOutput({ type: 'message_start', message: {} }), false);
  assert.equal(isAnthropicNativeRealOutput({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), false);
  assert.equal(isAnthropicNativeRealOutput({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'why' } }), true);
  assert.equal(isAnthropicNativeRealOutput({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), true);
  assert.equal(isAnthropicMessageMeaningful({ content: [{ type: 'text', text: '' }] }), false);
  assert.equal(isAnthropicMessageMeaningful({ content: [{ type: 'tool_use', name: 'lookup' }] }), true);
});

// ---- inFlight -------------------------------------------------------------

await test('inFlight: streaming release via token; no double decrement', () => {
  const a = node('a', { concurrency: 2 });
  const pick = pickTier1Candidate([a], REQ, new Set());
  assert.ok(pick && pick.node);
  assert.equal(getTier1Account('a').inFlight, 1);
  releaseTier1Slot('a', pick.releaseToken);
  assert.equal(getTier1Account('a').inFlight, 0);
  releaseTier1Slot('a', pick.releaseToken);
  assert.equal(getTier1Account('a').inFlight, 0);
  const pick2 = pickTier1Candidate([a], REQ, new Set());
  assert.ok(pick2 && pick2.node);
  assert.equal(getTier1Account('a').inFlight, 1);
  releaseTier1Slot('a', pick2.releaseToken);
});

await test('inFlight: concurrency cap is respected across many concurrent claims', () => {
  const a = node('a', { concurrency: 1 });
  const tokens = [];
  const p1 = pickTier1Candidate([a], REQ, new Set());
  assert.ok(p1 && p1.node);
  tokens.push(p1.releaseToken);
  const p2 = pickTier1Candidate([a], REQ, new Set());
  assert.equal(p2, null, 'second pick must be null when at capacity');
  releaseTier1Slot('a', tokens[0]);
});

// ---- Affinity -------------------------------------------------------------

await test('Affinity: tier1AffinityFactor biases the score downward (<1.0)', () => {
  assert.equal(tier1AffinityFactor('a', 'a'), 0.85);
  assert.equal(tier1AffinityFactor('b', 'a'), 1.0);
  assert.equal(tier1AffinityFactor('a', null), 1.0);
});

await test('Affinity: no KV binding -> read returns null (degrades to no bias)', async () => {
  const sessionId = 'session-12345678';
  const accountId = await readTier1Affinity({}, sessionId);
  assert.equal(accountId, null);
});

await test('Affinity: KV survives an isolate-local cache reset and hashes the session key', async () => {
  const values = new Map();
  const puts = [];
  const kv = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value, options) => { values.set(key, value); puts.push({ key, value, options }); },
  };
  const tasks = [];
  const env = { TIER1_AFFINITY: kv };
  const sessionId = 'cross-isolate-session-secret';
  assert.equal(writeTier1Affinity(env, { waitUntil: (p) => tasks.push(p) }, sessionId, 'account-a'), true);
  await Promise.all(tasks);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].options.expirationTtl, 1800);
  assert.ok(puts[0].key.startsWith('affinity:v1:'));
  assert.ok(!puts[0].key.includes(sessionId), 'raw session id must not appear in the KV key');
  __resetTier1AffinityForTests();
  assert.equal(await readTier1Affinity(env, sessionId), 'account-a');
});

await test('Affinity: resolveTier1SessionId requires a non-trivial header value', () => {
  const env = {};
  const req1 = { headers: { get: (n) => n.toLowerCase() === 'x-session-id' ? 'short' : null } };
  assert.equal(resolveTier1SessionId(req1, env), null, 'too-short id rejected');
  const req2 = { headers: { get: (n) => n.toLowerCase() === 'x-session-id' ? 'abcdefghijkl' : null } };
  assert.equal(resolveTier1SessionId(req2, env), 'abcdefghijkl');
  const req3 = { headers: { get: () => null } };
  assert.equal(resolveTier1SessionId(req3, env), null);
});

await test('shouldEvaluateAffinity: triggers every N requests or T minutes', () => {
  const sid = 'session-affinity-eval';
  for (let i = 0; i < 9; i++) {
    assert.equal(shouldEvaluateAffinity(sid), false, `should not evaluate at request ${i + 1}`);
  }
  assert.equal(shouldEvaluateAffinity(sid), true, 'evaluates at 10th request');
  for (let i = 0; i < 9; i++) shouldEvaluateAffinity(sid);
  assert.equal(shouldEvaluateAffinity(sid), true);
});

await test('Affinity escape: before the window a faster peer serves without migrating the binding', () => {
  const a = node('a');
  const b = node('b');
  recordTier1Ttft('a', 'm1', 2000);
  recordTier1Ttft('b', 'm1', 100);
  const pick = pickTier1Candidate([a, b], REQ, new Set(), {
    affinityAccountId: 'a', evaluateAffinity: false, rng: () => 0,
  });
  assert.equal(pick.node.id, 'b');
  assert.equal(pick.updateAffinity, false);
  assert.equal(pick.escapedFromAffinity, false);
  releaseTier1Slot('b', pick.releaseToken);
});

await test('Affinity escape: evaluation window permits a clearly better P2C winner to migrate on success', () => {
  const b = node('b');
  const slow = node('slow');
  const a = node('a');
  const dummy = node('dummy');
  recordTier1Ttft('slow', 'm1', 10000);
  recordTier1Ttft('a', 'm1', 30000);
  recordTier1Ttft('b', 'm1', 100);
  const pick = pickTier1Candidate([b, slow, a, dummy], REQ, new Set(), {
    affinityAccountId: 'a', evaluateAffinity: true, rng: () => 0,
  });
  assert.equal(pick.node.id, 'b');
  assert.equal(pick.updateAffinity, true);
  assert.equal(pick.escapedFromAffinity, true);
  releaseTier1Slot('b', pick.releaseToken);
});

await test('15-account simulation: P2C disperses, avoids cooldowns, explores UNKNOWN, and escapes degradation', () => {
  const nodes = Array.from({ length: 15 }, (_, i) => node(`pool-${String(i).padStart(2, '0')}`, { concurrency: 20, rpm: 10_000 }));
  const simulationStart = Date.now();
  const rateLimit = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 60_000 });
  for (const n of nodes.slice(0, 3)) applyTier1Outcome(n.id, 'm1', rateLimit, simulationStart);
  const timeout = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (const n of nodes.slice(3, 5)) {
    for (let i = 0; i < 3; i++) applyTier1Outcome(n.id, 'm1', timeout, simulationStart);
  }
  for (const n of nodes.slice(5, 8)) recordTier1Ttft(n.id, 'm1', 4000);
  for (const n of nodes.slice(8, 12)) recordTier1Ttft(n.id, 'm1', 200);
  for (const n of nodes.slice(12)) {
    assert.equal(getTier1Model(n.id, 'm1').ttftEwma, null, 'cold accounts start UNKNOWN');
  }

  let seed = 0x12345678;
  const rng = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const counts = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < 600; i++) {
    const pick = pickTier1Candidate(nodes, REQ, new Set(), { rng, now: simulationStart + i * 10 });
    assert.ok(pick?.node);
    counts[pick.node.id]++;
    if (pick.node.id >= 'pool-12' && getTier1Model(pick.node.id, 'm1').sampleCount === 0) {
      recordTier1Ttft(pick.node.id, 'm1', 250);
    }
    releaseTier1Slot(pick.node.id, pick.releaseToken);
  }
  for (const n of nodes.slice(0, 5)) assert.equal(counts[n.id], 0, `${n.id} is cooling and must never be hit`);
  for (const n of nodes.slice(12)) assert.ok(counts[n.id] > 0, `${n.id} UNKNOWN account must receive exploration traffic`);
  assert.ok(Object.values(counts).filter((count) => count > 0).length >= 8,
    `traffic should disperse across the eligible pool: ${JSON.stringify(counts)}`);

  const affinity = nodes[8];
  const peer = nodes[9];
  let stableHits = 0;
  for (let i = 0; i < 20; i++) {
    const pick = pickTier1Candidate([affinity, peer], REQ, new Set(), {
      affinityAccountId: affinity.id, evaluateAffinity: false, rng,
      now: simulationStart + 6_000 + i * 10,
    });
    if (pick.node.id === affinity.id) stableHits++;
    releaseTier1Slot(pick.node.id, pick.releaseToken);
  }
  assert.ok(stableHits >= 10, `healthy affinity should have a reasonable hit rate (${stableHits}/20)`);
  for (let i = 0; i < 8; i++) recordTier1Ttft(affinity.id, 'm1', 4000);
  const escaped = pickTier1Candidate([affinity, peer], REQ, new Set(), {
    affinityAccountId: affinity.id, evaluateAffinity: true, rng,
    now: simulationStart + 6_200,
  });
  assert.equal(escaped.node.id, peer.id);
  assert.equal(escaped.escapedFromAffinity, true);
  releaseTier1Slot(peer.id, escaped.releaseToken);
});

// ---- Failure state machine -------------------------------------------------

await test('Failure: 401/403 applies long cooldown, not permanent disable', () => {
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  applyTier1Outcome('a', 'm1', classifyTier1Failure({ kind: 'auth' }));
  const acct = getTier1Account('a');
  assert.equal(acct.accountDisabled, false, 'account is NOT permanently disabled');
  assert.ok(acct.accountCooldownUntil > Date.now(), 'account has a cooldown active');
  assert.equal(acct.accountCooldownReason, 'auth');
  assert.equal(isTier1Eligible(a, REQ), false, 'm1 blocked by account cooldown');
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }), false, 'm2 also blocked');
});

await test('Failure: model_not_found short-cools only the resolved upstream model', () => {
  const now = 1_000_000;
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  const c = classifyTier1Failure({ kind: 'model_missing', cooldownMs: 5_000 });
  assert.equal(c.scope, 'upstream_model');
  assert.equal(c.action, 'cooldown');
  applyTier1Outcome('a', 'up-a', c, now);
  assert.equal(isTier1Eligible(a, REQ, now), false, 'current upstream mapping is cooling');
  assert.equal(tier1BlockingWaitMs(a, 'm1', now), 5_000, 'cooldown remains short');
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, now), true, 'sibling upstream model stays eligible');
  assert.equal(getTier1Account('a').models.get('m1'), undefined,
    'model_missing must not create logical-model reliability state');
  assert.equal(getTier1Account('a').accountDisabled, false, 'account is NOT disabled');
  const remapped = { ...a, models: { ...a.models, m1: 'up-new' } };
  assert.equal(isTier1Eligible(remapped, REQ, now), true,
    'new upstream mapping must not inherit the old upstream model cooldown');
  assert.equal(isTier1Eligible(a, REQ, now + 5_001), true,
    'old upstream mapping becomes eligible after the short cooldown');
});

await test('Failure: single transient failure does NOT trip cooldown (hysteresis)', () => {
  const a = node('a');
  applyTier1Outcome('a', 'm1', classifyTier1Failure({ kind: 'first_event_timeout' }));
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.cooldownUntil, 0);
  assert.equal(m.failureState, TIER1_FAILURE_STATES.NORMAL);
  assert.equal(m.consecutiveFailures, 1);
});

await test('Failure: >= FAILURE_THRESHOLD consecutive counted failures -> COOLDOWN', () => {
  const a = node('a');
  const c = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('a', 'm1', c);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.failureState, TIER1_FAILURE_STATES.COOLDOWN);
  assert.ok(m.cooldownUntil > Date.now());
});

await test('Failure: ambiguous 429 -> key/account scope and respects Retry-After', () => {
  const now = Date.now();
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  const c = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 10_000 });
  assert.equal(c.scope, 'account');
  assert.equal(c.scopeAmbiguous, true);
  applyTier1Outcome('a', 'm1', c, now);
  const acct = getTier1Account('a');
  assert.equal(acct.accountCooldownUntil, now + 10_000, 'Retry-After remains authoritative');
  assert.equal(acct.scopeAmbiguous429, true);
  assert.equal(acct.models.get('m1'), undefined, 'account-scoped 429 need not create model cooldown state');
  assert.equal(isTier1Eligible(a, REQ, now + 9_999), false);
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }, now + 9_999), false, 'same key is cooling for sibling models too');
});

await test('Failure: repeated ambiguous 429 without Retry-After uses 30s/45s/60s key backoff', () => {
  const now = 1_000_000;
  const c = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 0 });
  const acct = getTier1Account('a');
  applyTier1Outcome('a', 'm1', c, now);
  const first = acct.accountCooldownUntil - now;
  acct.accountCooldownUntil = 0;
  applyTier1Outcome('a', 'm1', c, now);
  const second = acct.accountCooldownUntil - now;
  acct.accountCooldownUntil = 0;
  applyTier1Outcome('a', 'm1', c, now);
  const third = acct.accountCooldownUntil - now;
  acct.accountCooldownUntil = 0;
  applyTier1Outcome('a', 'm1', c, now);
  const fourth = acct.accountCooldownUntil - now;
  assert.ok(first >= 30_000 * 0.9 && first <= 30_000 * 1.1, `first backoff ${first} not around 30s`);
  assert.ok(second >= 45_000 * 0.9 && second <= 45_000 * 1.1, `second backoff ${second} not around 45s`);
  assert.ok(third >= 60_000 * 0.9 && third <= 60_000 * 1.1, `third backoff ${third} not around 60s`);
  assert.ok(fourth >= 60_000 * 0.9 && fourth <= 60_000 * 1.1, `fourth backoff ${fourth} must stay capped around 60s`);
  assert.equal(acct.consecutiveRateLimits, 4);
  assert.equal(acct.scopeAmbiguous429, true);
});

await test('Failure: pre-existing success cannot cancel an active 429 cooldown', () => {
  const now = 1_000_000;
  const c = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 30_000 });
  applyTier1Outcome('a', 'm1', c, now);
  const acct = getTier1Account('a');
  const until = acct.accountCooldownUntil;
  recordTier1Success('a', 'm1', now + 1_000);
  assert.equal(acct.accountCooldownUntil, until, 'an older in-flight success must not clear the active cooldown');
  assert.equal(acct.consecutiveRateLimits, 1, 'rate-limit history remains until an admitted recovery succeeds');
  assert.equal(acct.rateLimitRecoveryPending, true);
});

await test('Failure: successful 429 recovery resets key backoff and clears probe gate immediately', () => {
  const now = 1_000_000;
  const a = node('a', { concurrency: 10, rpm: 40 });
  const c = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 0 });
  applyTier1Outcome('a', 'm1', c, now);
  const acct = getTier1Account('a');
  const recoveryAt = acct.accountCooldownUntil + 1;
  assert.equal(claimTier1Slot(a, recoveryAt, 'm1'), true, 'first request after cooldown is admitted as recovery probe');
  assert.ok(acct.rateLimitRecoveryUntil > recoveryAt, 'probe gate is active while the recovery request is unresolved');
  recordTier1Success('a', 'm1', recoveryAt + 1);
  releaseTier1Slot('a', makeTier1ReleaseToken('a'));
  assert.equal(acct.consecutiveRateLimits, 0);
  assert.equal(acct.rateLimitRecoveryUntil, 0);
  assert.equal(acct.rateLimitRecoveryPending, false);
  assert.equal(acct.accountCooldownReason, null);
});

await test('Failure: timeout and 5xx backoff grow after hysteresis threshold', () => {
  const timeout = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('a', 'm1', timeout, 1_000_000);
  const timeoutCd = getTier1Model('a', 'm1').cooldownUntil - 1_000_000;
  assert.ok(timeoutCd >= 20_000 * 0.9 && timeoutCd <= 20_000 * 1.1, `timeout cooldown ${timeoutCd} not in [18000, 22000]`);

  const server = classifyTier1Failure({ kind: 'server' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('b', 'm1', server, 1_000_000);
  const serverCd = getTier1Model('b', 'm1').cooldownUntil - 1_000_000;
  assert.ok(serverCd >= 4_000 * 0.9 && serverCd <= 4_000 * 1.1, `server cooldown ${serverCd} not in [3600, 4400]`);
});

await test('Failure: HALF_OPEN -> one failure reopens to COOLDOWN', () => {
  const a = node('a');
  const c = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('a', 'm1', c);
  getTier1Account('a').models.get('m1').cooldownUntil = 0;
  const r = pickTier1Candidate([a], REQ, new Set());
  if (r && r.node) releaseTier1Slot(r.node.id, r.releaseToken);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  applyTier1Outcome('a', 'm1', c);
  assert.equal(m.failureState, TIER1_FAILURE_STATES.COOLDOWN);
  assert.ok(m.cooldownUntil > Date.now());
});

await test('Failure: HALF_OPEN admits only one real recovery request at a time', () => {
  const a = node('a', { concurrency: 4 });
  const c = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('a', 'm1', c);
  getTier1Model('a', 'm1').cooldownUntil = 0;
  const first = pickTier1Candidate([a], REQ, new Set());
  assert.ok(first?.node);
  assert.equal(getTier1Model('a', 'm1').failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  assert.equal(pickTier1Candidate([a], REQ, new Set()), null);
  releaseTier1Slot('a', first.releaseToken);
});

await test('Failure: HALF_OPEN -> 2 successes recover to NORMAL', () => {
  const a = node('a');
  const c = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (let i = 0; i < 3; i++) applyTier1Outcome('a', 'm1', c);
  getTier1Account('a').models.get('m1').cooldownUntil = 0;
  const r = pickTier1Candidate([a], REQ, new Set());
  if (r && r.node) releaseTier1Slot(r.node.id, r.releaseToken);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  recordTier1Success('a', 'm1');
  assert.equal(getTier1Account('a').models.get('m1').failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  recordTier1Success('a', 'm1');
  assert.equal(getTier1Account('a').models.get('m1').failureState, TIER1_FAILURE_STATES.NORMAL);
});

// ---- Diagnostics -----------------------------------------------------------

await test('Diagnostics: snapshot exposes UNKNOWN vs KNOWN clearly', () => {
  const a = node('a');
  getTier1Model('a', 'm1');
  const snap0 = snapshotTier1Runtime('a', 'm1');
  assert.equal(snap0.ttft_ewma_ms, null);
  assert.equal(snap0.state, 'unknown');
  assert.equal(snap0.sample_count, 0);
  recordTier1Ttft('a', 'm1', 640);
  const snap1 = snapshotTier1Runtime('a', 'm1');
  assert.equal(snap1.ttft_ewma_ms, 640);
  assert.equal(snap1.state, 'observed_healthy');
  assert.equal(snap1.sample_count, 1);
  assert.equal(snap1.failure_state, 'normal');
});

console.log(`\nTier 1 scheduler tests: ${passed} passed, ${failed} failed.`);
