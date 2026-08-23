import assert from 'node:assert/strict';

console.log('=== Reliability Tests ===\n');

// Test 1: Cooldown on 429
console.log('1. 429 cooldown...');
const { getNodeState, recordFailure, isCoolingDown, getRetryAfterMs } = await import('../src/config/node-state.js');
const n1 = 'test-429-node';
recordFailure(n1, 429, 60000, 'rate_limited');
assert.ok(isCoolingDown(n1), 'Node should be cooling down after 429');
const s1 = getNodeState(n1);
assert.ok(s1.healthScore < 50, 'Health should decrease after 429');
assert.equal(s1.cooldownReason, 'rate_limited', 'Cooldown reason should be set');
console.log('   PASS\n');

// Test 2: 503 circuit breaker
console.log('2. 503 circuit breaker...');
const { recordCircuitFailure, shouldAllowRequest, resetCircuit } = await import('../src/reliability/circuit.js');
const n2 = 'test-503-node';
resetCircuit(n2);
assert.ok(shouldAllowRequest(n2), 'Should allow initially');
recordCircuitFailure(n2);
assert.ok(shouldAllowRequest(n2), 'Should allow after 1 failure');
recordCircuitFailure(n2);
assert.ok(shouldAllowRequest(n2), 'Should allow after 2 failures');
recordCircuitFailure(n2);
const { isCircuitOpen } = await import('../src/config/node-state.js');
assert.ok(isCircuitOpen(n2), 'Circuit should open after 3 failures');
console.log('   PASS\n');

// Test 3: Retry-After header parsing
console.log('3. Retry-After parsing...');
const ra = getRetryAfterMs(new Headers({ 'Retry-After': '30' }));
assert.ok(ra >= 29000 && ra <= 31000, 'Retry-After seconds should be parsed: ' + ra);
const ra2 = getRetryAfterMs(new Headers({}));
assert.equal(ra2, 0, 'Missing Retry-After should return 0');
console.log('   PASS\n');

// Test 4: Retry budget limits
console.log('4. Retry budget limits...');
const { shouldRetry } = await import('../src/reliability/retry.js');
const policy = { retry_budget: { free: 2, paid: 1, plus: 1 }, max_attempts: 4 };
assert.ok(shouldRetry(0, 4, 429, 'free', policy), 'First retry for free');
assert.ok(shouldRetry(1, 4, 429, 'free', policy), 'Second retry for free');
assert.ok(!shouldRetry(2, 4, 429, 'free', policy), 'Third retry for free should be blocked');
assert.ok(shouldRetry(0, 4, 503, 'paid', policy), 'First retry for paid');
assert.ok(!shouldRetry(1, 4, 503, 'paid', policy), 'Second retry for paid should be blocked');
assert.ok(shouldRetry(0, 4, 502, 'plus', policy), 'First retry for plus');
assert.ok(!shouldRetry(1, 4, 502, 'plus', policy), 'Second retry for plus should be blocked');
console.log('   PASS\n');

// Test 5: Non-retryable status
console.log('5. Non-retryable status...');
assert.ok(!shouldRetry(0, 3, 400, 'free', policy), '400 should not be retried');
assert.ok(!shouldRetry(0, 3, 422, 'free', policy), '422 should not be retried');
assert.ok(shouldRetry(0, 3, 429, 'free', policy), '429 should be retried');
assert.ok(shouldRetry(0, 3, 503, 'free', policy), '503 should be retried');
console.log('   PASS\n');

// Test 6: Maximum total attempts
console.log('6. Maximum total attempts...');
const { checkRetryBudget } = await import('../src/reliability/retry.js');
assert.ok(checkRetryBudget([1, 1, 1], policy), '3 attempts within budget');
assert.ok(!checkRetryBudget([2, 2, 2], policy), '6 attempts exceeds budget');
console.log('   PASS\n');

// Test 7: Timeout splitting
console.log('7. Timeout splitting...');
const { getTimeouts, UPSTREAM_HEADERS_TIMEOUT, FIRST_EVENT_TIMEOUT, STREAM_IDLE_TIMEOUT } = await import('../src/reliability/retry.js');
const timeouts = getTimeouts({});
assert.equal(timeouts.headersTimeout, UPSTREAM_HEADERS_TIMEOUT, 'Default headers timeout');
assert.equal(timeouts.firstEventTimeout, FIRST_EVENT_TIMEOUT, 'Default first event timeout');
assert.equal(timeouts.streamIdleTimeout, STREAM_IDLE_TIMEOUT, 'Default stream idle timeout');
const custom = getTimeouts({ UPSTREAM_HEADERS_TIMEOUT: '15000', FIRST_EVENT_TIMEOUT: '30000', STREAM_IDLE_TIMEOUT: '60000' });
assert.equal(custom.headersTimeout, 15000, 'Custom headers timeout');
assert.equal(custom.firstEventTimeout, 30000, 'Custom first event timeout');
assert.equal(custom.streamIdleTimeout, 60000, 'Custom stream idle timeout');
console.log('   PASS\n');

// Test 8: Health check response
console.log('8. Health check...');
const { buildHealthResponse } = await import('../src/reliability/health.js');
const health = buildHealthResponse([
  { id: 'free-node-01', tier: 'free', priority: 100, provider: 'test', account: 'test', secret_ref: '', workloads: ['general'], capabilities: ['chat'], models: [], limits: { concurrency: 2 } },
], {});
assert.ok(health.status === 'ok' || health.status === 'misconfigured', 'Health should have status');
assert.ok(health.nodes_total >= 0, 'Should have nodes_total');
assert.ok(health.client_stats, 'Should have client_stats');
console.log('   PASS\n');

// Test 9: Exponential backoff
console.log('9. Exponential backoff...');
const { applyExponentialBackoff } = await import('../src/config/node-state.js');
const n3 = 'backoff-test-node';
const s3 = getNodeState(n3);
s3.consecutiveFailures = 0;
const b1 = applyExponentialBackoff(n3, 500, 1000);
assert.equal(b1, 1000, 'First 500 failure should use base cooldown');
s3.consecutiveFailures = 1;
const b2 = applyExponentialBackoff(n3, 500, 1000);
assert.equal(b2, 2000, 'Second consecutive failure should double');
s3.consecutiveFailures = 2;
const b3 = applyExponentialBackoff(n3, 500, 1000);
assert.equal(b3, 4000, 'Third consecutive failure should quadruple');
console.log('   PASS\n');

// Test 10: Client abort (no penalty)
console.log('10. Client abort handling...');
const { recordCancellation, getNodeState: getNS } = await import('../src/config/node-state.js');
const n4 = 'abort-test-node';
const s4 = getNS(n4);
s4.activeRequests = 1;
recordCancellation(n4);
assert.equal(s4.activeRequests, 0, 'Active requests should be 0 after cancellation');
assert.equal(s4.healthScore, 50, 'Health should not be penalized on cancellation');
console.log('   PASS\n');

// Test 11: Concurrent requests limit
console.log('11. Concurrency limit...');
const { selectNodes } = await import('../src/scheduler/selector.js');
const concNodes = [
  { id: 'busy-node', tier: 'free', priority: 100, workloads: ['general'], capabilities: ['chat'], models: ['test-model'], limits: { concurrency: 1 } },
  { id: 'free-node', tier: 'free', priority: 90, workloads: ['general'], capabilities: ['chat'], models: ['test-model'], limits: { concurrency: 2 } },
];
const cState = getNodeState('busy-node');
cState.activeRequests = 1;
const cSelected = selectNodes(concNodes, { tiers: ['free', 'paid'], max_attempts: 2, retry_budget: { free: 2, paid: 1 } }, { model: 'test-model' }, 'test-model');
assert.ok(cSelected.length > 0, 'Should still select nodes');
const busySelected = cSelected.find(n => n.id === 'busy-node');
assert.ok(!busySelected, 'Busy node should not be selected');
console.log('   PASS\n');

// Test 12: First Event Guard - empty stream
console.log('12. First Event Guard - empty stream...');
const { FirstEventGuard } = await import('../src/stream/guard.js');
const emptyBody = new ReadableStream({ start(c) { c.close(); } });
const emptyResponse = new Response(emptyBody, { headers: { 'content-type': 'text/event-stream' } });
const emptyGuard = new FirstEventGuard(emptyResponse, 1000);
try {
  await emptyGuard.waitForFirstEvent();
  assert.fail('Should have thrown for empty stream');
} catch (e) {
  assert.ok(e.message.includes('Empty') || e.message.includes('empty'), 'Should reject empty stream: ' + e.message);
}
console.log('   PASS\n');

console.log('=== All Reliability Tests Passed ===');