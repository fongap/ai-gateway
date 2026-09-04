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
//     2 successes; 401/403 disables the account; model_not_found disables
//     only the (account, model) pair; 429 defaults to model scope with
//     scope_ambiguous and respects Retry-After; cooldown never breaks the
//     "no call against an unexpired cooldown" rule.
import assert from 'node:assert/strict';
import {
  __resetTier1StateForTests,
  isTier1Eligible, claimTier1Slot, releaseTier1Slot, makeTier1ReleaseToken,
  getTier1Account, getTier1Model, recordTier1Ttft, recordTier1Success, applyTier1Outcome,
  classifyTier1Failure, calculateTier1Score, snapshotTier1Runtime, recordTier1QuotaSignal,
  TIER1_FAILURE_STATES,
} from '../src/reliability/tier1-state.js';
import {
  pickTier1Candidate, tier1DeadlineTooSmall,
} from '../src/scheduler/tier1-scheduler.js';
import {
  readTier1Affinity, writeTier1Affinity, resolveTier1SessionId,
  shouldEvaluateAffinity, tier1AffinityFactor, __resetTier1AffinityForTests,
} from '../src/scheduler/tier1-affinity.js';
import {
  isOpenAIChatRealOutput, isResponsesRealOutput, isAnthropicNativeRealOutput,
  isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful,
  isAnthropicMessageMeaningful,
} from '../src/transport/index.js';

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

function node(id, { concurrency = 2, rpm = 100, models = { m1: 'up-x' } } = {}) {
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
  // Node must serve both models to test that disabling m1 does NOT disable m2.
  const a = node('a', { models: { m1: 'up-a', m2: 'up-b' } });
  getTier1Model('a', 'm1').disabled = true; // ensure runtime exists, then disable
  assert.equal(isTier1Eligible(a, REQ), false, 'm1 disabled -> ineligible for m1');
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }), true, 'm2 still eligible');
  assert.equal(getTier1Account('a').accountDisabled, false);
});

await test('Eligibility: hard concurrency and RPM cap are filtered', () => {
  const b = node('b', { concurrency: 1, rpm: 1 });
  assert.ok(claimTier1Slot(b)); // consumes the only slot + RPM token
  assert.equal(isTier1Eligible(b, REQ), false, 'concurrency full -> ineligible');
  // Second claim: must fail (concurrency full AND rpm full).
  assert.equal(claimTier1Slot(b), false, 'second claim must fail (rpm + concurrency full)');
  const tok = makeTier1ReleaseToken('b');
  // The release token made above is fresh; release the claimed slot manually.
  // (claimTier1Slot incremented inFlight; release via the account path.)
  getTier1Account('b').inFlight = Math.max(0, getTier1Account('b').inFlight - 1);
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
  const b = { ...node('b'), tier: 'tier-2' }; // ineligible
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
  // With pure P2C randomness and equal scores, every node should be hit at
  // least once across 200 picks. A full-sort would deterministically pick
  // the same node.
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

await test('P2C: deadline gate returns null when remaining budget is too small', () => {
  assert.equal(tier1DeadlineTooSmall(100), true);
  assert.equal(tier1DeadlineTooSmall(1_000), false);
  assert.equal(tier1DeadlineTooSmall(60_000), false);
  // With a known p99, the threshold scales: remaining < p99*3 fails.
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
  recordTier1Ttft('a', 'm1', 1000); // direct assign
  recordTier1Ttft('a', 'm1', 1000); // 0.25*1000 + 0.75*1000 = 1000
  assert.equal(getTier1Account('a').models.get('m1').ttftEwma, 1000);
  recordTier1Ttft('a', 'm1', 500); // 0.25*500 + 0.75*1000 = 875
  const e = getTier1Account('a').models.get('m1').ttftEwma;
  assert.ok(Math.abs(e - 875) < 0.001, `expected 875, got ${e}`);
  assert.equal(getTier1Account('a').models.get('m1').sampleCount, 3);
});

await test('Outlier: single sample clamped, sampleCount still increments, consecutiveOutliers=1', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 1000); // EWMA = 1000
  // 9000 > 1000*4=4000 → outlier. consecutiveOutliers=1 (<2) → clamp the
  // SAMPLE to 4000, then EWMA = 0.25*4000 + 0.75*1000 = 1750.
  recordTier1Ttft('a', 'm1', 9000);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.ttftEwma, 1750, 'clamped sample (4000) blended into EWMA = 1750');
  assert.equal(m.consecutiveOutliers, 1);
  assert.equal(m.sampleCount, 2);
});

await test('Outlier: 2 consecutive outliers stop clamping (raw value used)', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 1000); // EWMA = 1000
  // First outlier: clamp to 4000. EWMA = 0.25*4000 + 0.75*1000 = 1750.
  recordTier1Ttft('a', 'm1', 9000);
  // Threshold for next sample: 1750 * 4 = 7000. 9000 > 7000 -> outlier.
  // consecutiveOutliers would become 2 -> stop clamping, use raw 9000.
  // EWMA = 0.25*9000 + 0.75*1750 = 2250 + 1312.5 = 3562.5
  recordTier1Ttft('a', 'm1', 9000);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.consecutiveOutliers, 2, 'consecutive outliers must reach 2');
  // EWMA after 2nd raw outlier:
  assert.ok(m.ttftEwma > 3000, `expected EWMA > 3000 after real degradation, got ${m.ttftEwma}`);
});

await test('Outlier: a non-outlier sample resets consecutiveOutliers to 0', () => {
  const a = node('a');
  recordTier1Ttft('a', 'm1', 1000);
  recordTier1Ttft('a', 'm1', 9000); // outlier -> consecutiveOutliers=1
  recordTier1Ttft('a', 'm1', 1000); // back to normal
  assert.equal(getTier1Account('a').models.get('m1').consecutiveOutliers, 0);
});

await test('Failed requests do NOT produce TTFT samples', () => {
  // A request that ended in a failure must not have called recordTier1Ttft.
  // We assert by confirming that the model runtime stays UNKNOWN.
  const a = node('a');
  // Simulate a failure: only applyTier1Outcome, no recordTier1Ttft.
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
  // Simulate: stream starts (slot held) -> stream ends (release token).
  releaseTier1Slot('a', pick.releaseToken);
  assert.equal(getTier1Account('a').inFlight, 0);
  // Idempotent: a second release with the same token must be a no-op.
  releaseTier1Slot('a', pick.releaseToken);
  assert.equal(getTier1Account('a').inFlight, 0);
  // A second pick on the same account re-acquires cleanly.
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
  // Second claim must fail (concurrency full).
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

  // Clearing module-local cache/counters represents a new isolate. The
  // shared KV value remains readable there.
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
  // And again at 20th, etc.
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
  const a = node('a');
  const b = node('b');
  recordTier1Ttft('a', 'm1', 2000);
  recordTier1Ttft('b', 'm1', 100);
  const pick = pickTier1Candidate([a, b], REQ, new Set(), {
    affinityAccountId: 'a', evaluateAffinity: true, rng: () => 0,
  });
  assert.equal(pick.node.id, 'b');
  assert.equal(pick.updateAffinity, true);
  assert.equal(pick.escapedFromAffinity, true);
  releaseTier1Slot('b', pick.releaseToken);
});

await test('15-account simulation: P2C disperses, avoids cooldowns, explores UNKNOWN, and escapes degradation', () => {
  const nodes = Array.from({ length: 15 }, (_, i) => node(`pool-${String(i).padStart(2, '0')}`, { concurrency: 20, rpm: 10_000 }));
  const rateLimit = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 60_000 });
  for (const n of nodes.slice(0, 3)) applyTier1Outcome(n.id, 'm1', rateLimit);
  const timeout = classifyTier1Failure({ kind: 'first_event_timeout' });
  for (const n of nodes.slice(3, 5)) {
    for (let i = 0; i < 3; i++) applyTier1Outcome(n.id, 'm1', timeout);
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
    const pick = pickTier1Candidate(nodes, REQ, new Set(), { rng });
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

  // A healthy affinity wins its biased pair; sustained real degradation then
  // makes the evaluation-window P2C peer eligible for escape.
  const affinity = nodes[8];
  const peer = nodes[9];
  let stableHits = 0;
  for (let i = 0; i < 20; i++) {
    const pick = pickTier1Candidate([affinity, peer], REQ, new Set(), {
      affinityAccountId: affinity.id, evaluateAffinity: false, rng,
    });
    if (pick.node.id === affinity.id) stableHits++;
    releaseTier1Slot(pick.node.id, pick.releaseToken);
  }
  assert.ok(stableHits >= 15, `healthy affinity should have a high hit rate (${stableHits}/20)`);
  for (let i = 0; i < 8; i++) recordTier1Ttft(affinity.id, 'm1', 4000);
  const escaped = pickTier1Candidate([affinity, peer], REQ, new Set(), {
    affinityAccountId: affinity.id, evaluateAffinity: true, rng,
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
  // Auth failure applies a long cooldown (TIER1_AUTH_DISABLED_COOLDOWN_MS) so
  // the node can self-recover when the key is rotated. Not permanently disabled.
  assert.equal(acct.accountDisabled, false, 'account is NOT permanently disabled');
  assert.ok(acct.accountCooldownUntil > Date.now(), 'account has a cooldown active');
  assert.equal(acct.accountCooldownReason, 'auth');
  // Account-scope cooldown makes EVERY model on this account ineligible
  assert.equal(isTier1Eligible(a, REQ), false, 'm1 blocked by account cooldown');
  assert.equal(isTier1Eligible(a, { ...REQ, model: 'm2' }), false, 'm2 also blocked');
});

await test('Failure: model_not_found applies long cooldown, not permanent disable', () => {
  const a = node('a');
  applyTier1Outcome('a', 'm1', classifyTier1Failure({ kind: 'model_missing' }));
  const m1 = getTier1Account('a').models.get('m1');
  // model_missing applies a long cooldown (TIER1_MODEL_MISSING_DISABLED_COOLDOWN_MS)
  // so the node can self-recover when the model is re-added upstream.
  assert.equal(m1.disabled, false, 'model is NOT permanently disabled');
  assert.equal(m1.failureState, TIER1_FAILURE_STATES.COOLDOWN, 'model is in COOLDOWN state');
  assert.ok(m1.cooldownUntil > Date.now(), 'model has a cooldown active');
  assert.equal(m1.cooldownReason, 'model_missing');
  assert.equal(getTier1Account('a').accountDisabled, false, 'account is NOT disabled');
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

await test('Failure: 429 -> model scope + scope_ambiguous, respects Retry-After', () => {
  const a = node('a');
  const c = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('a', 'm1', c);
  const m = getTier1Account('a').models.get('m1');
  assert.equal(m.failureState, TIER1_FAILURE_STATES.NORMAL, 'a 429 alone does not trip circuit');
  assert.equal(m.cooldownUntil > Date.now(), true, 'cooldown window set');
  assert.equal(m.scopeAmbiguous429, true);
  // The model is filtered by cooldown until expiry.
  assert.equal(isTier1Eligible(a, REQ), false);
});

await test('Failure: repeated ambiguous 429 without Retry-After uses exponential model backoff', () => {
  const now = 1_000_000;
  const c = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 0 });
  applyTier1Outcome('a', 'm1', c, now);
  const first = getTier1Model('a', 'm1').cooldownUntil - now;
  getTier1Model('a', 'm1').cooldownUntil = 0;
  applyTier1Outcome('a', 'm1', c, now);
  const second = getTier1Model('a', 'm1').cooldownUntil - now;
  // ±10% cooldown jitter (PR 7) — verify exponential growth within range.
  assert.ok(first >= 30_000 * 0.9 && first <= 30_000 * 1.1, `first backoff ${first} not in [27000, 33000]`);
  assert.ok(second >= 60_000 * 0.9 && second <= 60_000 * 1.1, `second backoff ${second} not in [54000, 66000]`);
  assert.equal(getTier1Model('a', 'm1').scopeAmbiguous429, true);
  assert.equal(getTier1Account('a').accountCooldownUntil, 0, 'ambiguous 429 must not block other models');
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
  // Force cooldown to be expired and transition to half-open.
  getTier1Account('a').models.get('m1').cooldownUntil = 0;
  // simulate the lazy transition (would happen in pickTier1Candidate):
  // use the public path: import maybeTransitionToHalfOpen via a pick.
  const r = pickTier1Candidate([a], REQ, new Set());
  if (r && r.node) releaseTier1Slot(r.node.id, r.releaseToken);
  const m = getTier1Account('a').models.get('m1');
  // After the lazy transition in pickTier1Candidate, state should be HALF_OPEN.
  assert.equal(m.failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  // Now a failure from HALF_OPEN must immediately return to COOLDOWN.
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
  // First success: halfOpenSuccesses = 1, still half-open.
  recordTier1Success('a', 'm1');
  assert.equal(getTier1Account('a').models.get('m1').failureState, TIER1_FAILURE_STATES.HALF_OPEN);
  // Second success: recovers to NORMAL.
  recordTier1Success('a', 'm1');
  assert.equal(getTier1Account('a').models.get('m1').failureState, TIER1_FAILURE_STATES.NORMAL);
});

// ---- Diagnostics -----------------------------------------------------------

await test('Diagnostics: snapshot exposes UNKNOWN vs KNOWN clearly', () => {
  const a = node('a');
  // Touching the account/model lazily creates the runtime so the snapshot
  // exists. A never-touched account returns null (no telemetry to show).
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
