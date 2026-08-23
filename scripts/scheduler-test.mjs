import assert from 'node:assert/strict';

console.log('=== Node Scheduler Tests ===\n');

// Test 1: Node config loading
console.log('1. Node config loading...');
const { loadNodesConfig, legacyToNodes } = await import('../src/config/nodes.js');
const nodes = loadNodesConfig({ NODES_CONFIG: JSON.stringify([
  { id: 'free-node-01', tier: 'free', priority: 100, provider: 'test', account: 'test', secret_ref: '', workloads: ['general'], capabilities: ['chat'], models: ['general-air'], limits: { concurrency: 2 } },
  { id: 'paid-node-01', tier: 'paid', priority: 80, provider: 'test', account: 'test', secret_ref: '', workloads: ['coding'], capabilities: ['chat', 'stream', 'tools'], models: ['code-pro'], limits: { concurrency: 5 } },
  { id: 'plus-node-01', tier: 'plus', priority: 50, provider: 'test', account: 'test', secret_ref: '', workloads: ['coding', 'critical'], capabilities: ['chat', 'stream', 'tools'], models: ['code-max'], limits: { concurrency: 3 } },
]) });
assert.equal(nodes.length, 3, 'Should load 3 nodes');
assert.equal(nodes[0].tier, 'plus', 'First node should be plus (highest priority)');
assert.equal(nodes[1].tier, 'paid', 'Second node should be paid');
assert.equal(nodes[2].tier, 'free', 'Third node should be free');
console.log('   PASS: 3 nodes loaded correctly\n');

// Test 2: Legacy config conversion
console.log('2. Legacy config conversion...');
const legacyNodes = legacyToNodes({ PRIMARY_API_TOKENS: 'token1@https://api1.example.com/v1,token2@https://api2.example.com/v1' });
assert.ok(legacyNodes.length >= 1, 'Should convert legacy tokens');
assert.equal(legacyNodes[0].tier, 'free', 'Legacy nodes should be free tier');
console.log('   PASS: Legacy tokens converted to free nodes\n');

// Test 3: Model config loading
console.log('3. Model config loading...');
const { loadModelsConfig, getModelInfo } = await import('../src/config/models.js');
const models = loadModelsConfig({ MODELS_CONFIG: JSON.stringify({
  'general-air': { workload: 'general', policy: 'general-fast' },
  'code-pro': { workload: 'coding', policy: 'coding-stable' },
  'code-max': { workload: 'coding', policy: 'coding-stable' },
}) });
assert.ok(models['general-air'], 'Should load general-air model');
assert.equal(models['general-air'].workload, 'general', 'general-air workload should be general');
assert.equal(models['code-pro'].workload, 'coding', 'code-pro workload should be coding');
console.log('   PASS: Models loaded correctly\n');

// Test 4: Policy config loading
console.log('4. Policy loading...');
const { loadPoliciesConfig, getPolicy } = await import('../src/config/policies.js');
const policies = loadPoliciesConfig({ POLICIES_CONFIG: JSON.stringify({
  'general-fast': { tiers: ['free', 'paid'], max_attempts: 3, retry_budget: { free: 2, paid: 1 } },
  'coding-stable': { tiers: ['free', 'paid', 'plus'], max_attempts: 4, retry_budget: { free: 2, paid: 1, plus: 1 } },
}) });
assert.ok(policies['general-fast'], 'Should load general-fast policy');
assert.equal(policies['general-fast'].tiers.length, 2, 'general-fast should have 2 tiers');
assert.equal(policies['coding-stable'].tiers.length, 3, 'coding-stable should have 3 tiers');
console.log('   PASS: Policies loaded correctly\n');

// Test 5: Node selector - free node priority
console.log('5. Free node priority...');
const { selectNodes } = await import('../src/scheduler/selector.js');
const testNodes = [
  { id: 'free-node-01', tier: 'free', priority: 100, workloads: ['general'], capabilities: ['chat'], models: ['general-air'], limits: { concurrency: 2 } },
  { id: 'paid-node-01', tier: 'paid', priority: 80, workloads: ['general'], capabilities: ['chat'], models: ['general-air'], limits: { concurrency: 5 } },
  { id: 'plus-node-01', tier: 'plus', priority: 50, workloads: ['general'], capabilities: ['chat'], models: ['general-air'], limits: { concurrency: 3 } },
];
const selected = selectNodes(testNodes, { tiers: ['free', 'paid', 'plus'], max_attempts: 2, retry_budget: { free: 2, paid: 1, plus: 1 } }, { model: 'general-air' }, 'general-air');
assert.ok(selected.length > 0, 'Should select at least one node');
assert.equal(selected[0].tier, 'free', 'First selected should be free tier');
console.log('   PASS: Free node selected first\n');

// Test 6: Node state management
console.log('6. Node state management...');
const { getNodeState, recordRequestStart, recordSuccess, recordFailure, isCoolingDown } = await import('../src/config/node-state.js');
const state = getNodeState('test-node-01');
assert.equal(state.healthScore, 50, 'Initial health should be 50');
recordRequestStart('test-node-01');
assert.equal(state.activeRequests, 1, 'Active requests should be 1');
recordSuccess('test-node-01', 100);
assert.equal(state.activeRequests, 0, 'Active requests should be 0 after success');
assert.ok(state.healthScore > 50, 'Health should increase after success');
recordFailure('test-node-01', 429, 60000, 'rate_limited');
assert.ok(state.healthScore < 50, 'Health should decrease after 429');
assert.ok(isCoolingDown('test-node-01'), 'Node should be in cooldown after 429');
console.log('   PASS: Node state management works\n');

// Test 7: Circuit breaker
console.log('7. Circuit breaker...');
const { shouldAllowRequest, recordCircuitFailure, resetCircuit } = await import('../src/reliability/circuit.js');
const circuitId = 'circuit-test-node';
resetCircuit(circuitId);
assert.ok(shouldAllowRequest(circuitId), 'Should allow request with closed circuit');
recordCircuitFailure(circuitId);
recordCircuitFailure(circuitId);
recordCircuitFailure(circuitId);
const { isCircuitOpen } = await import('../src/config/node-state.js');
assert.ok(isCircuitOpen(circuitId), 'Circuit should open after 3 failures');
console.log('   PASS: Circuit breaker works\n');

// Test 8: Retry budget
console.log('8. Retry budget...');
const { shouldRetry, getAttemptBudget } = await import('../src/reliability/retry.js');
const testPolicy = { retry_budget: { free: 2, paid: 1, plus: 1 }, max_attempts: 4 };
assert.ok(shouldRetry(0, 3, 429, 'free', testPolicy), 'Should retry free node on 429');
assert.ok(!shouldRetry(2, 3, 429, 'free', testPolicy), 'Should not exceed free retry budget');
assert.ok(shouldRetry(0, 3, 429, 'paid', testPolicy), 'Should retry paid node on 429');
assert.ok(!shouldRetry(1, 3, 429, 'paid', testPolicy), 'Should not exceed paid retry budget');
console.log('   PASS: Retry budget works\n');

// Test 9: First Event Guard
console.log('9. First Event Guard...');
const { FirstEventGuard } = await import('../src/stream/guard.js');
const streamBody = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
    controller.close();
  },
});
const response = new Response(streamBody, { headers: { 'content-type': 'text/event-stream' } });
const guard = new FirstEventGuard(response, 5000);
try {
  const result = await guard.waitForFirstEvent();
  assert.ok(guard.hasFirstEvent(), 'Should have received first event');
  assert.ok(result.eventChunk, 'Should have event chunk');
  console.log('   PASS: First Event Guard works\n');
} catch (e) {
  console.log('   FAIL: ' + e.message + '\n');
  process.exit(1);
}

// Test 10: Legacy config compatibility
console.log('10. Legacy config compatibility...');
const legacyEndpoints = legacyToNodes({ PRIMARY_API_TOKENS: 'test-token@https://test.example.com/v1' });
assert.ok(legacyEndpoints.length > 0, 'Legacy endpoints should be created');
assert.equal(legacyEndpoints[0]._legacyToken, 'test-token', 'Legacy token should be preserved');
console.log('   PASS: Legacy config compatibility works\n');

// Test 11: Security - no secret leakage
console.log('11. Security - no secret leakage...');
const { getNodeSecret } = await import('../src/config/nodes.js');
const secret = getNodeSecret({ TEST_SECRET: 'super-secret-key' }, 'TEST_SECRET');
assert.equal(secret, 'super-secret-key', 'Secret should be retrievable');
const missing = getNodeSecret({}, 'NONEXISTENT');
assert.equal(missing, null, 'Missing secret should return null');
console.log('   PASS: Secret handling works\n');

// Test 12: Route plan building
console.log('12. Route plan building...');
const { buildRoutePlan } = await import('../src/scheduler/router.js');
const plan = buildRoutePlan({
  NODES_CONFIG: JSON.stringify([
    { id: 'free-node-01', tier: 'free', priority: 100, provider: 'test', account: 'test', secret_ref: 'FREE_NODE_KEY', workloads: ['general'], capabilities: ['chat'], models: ['general-air'], limits: { concurrency: 2 } },
  ]),
  FREE_NODE_KEY: 'test-token@https://test.example.com/v1',
  MODELS_CONFIG: JSON.stringify({ 'general-air': { workload: 'general', policy: 'general-fast' } }),
  POLICIES_CONFIG: JSON.stringify({ 'general-fast': { tiers: ['free', 'paid'], max_attempts: 3, retry_budget: { free: 2, paid: 1 } } }),
}, 'general-air', { model: 'general-air', messages: [{ role: 'user', content: 'hi' }] });
assert.ok(plan.nodes, 'Should have nodes array');
assert.ok(plan.policy, 'Should have policy');
assert.ok(plan.modelInfo, 'Should have model info');
console.log('   PASS: Route plan building works\n');

console.log('=== All Node Scheduler Tests Passed ===');