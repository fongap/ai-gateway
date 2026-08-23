import assert from 'node:assert/strict';

console.log('=== Node Scheduler Tests ===\n');

// Test 1: Node config loading
console.log('1. Node config loading...');
const { loadNodesConfig, resolveUpstreamModel } = await import('../src/config/nodes.js');
const nodes = loadNodesConfig({ TIER1_NODES_CONFIG: JSON.stringify([
  { id: 'tier-1-node-01', tier: 'tier-1', priority: 100, provider: 'test', account: 'test', token: '', workloads: ['general'], capabilities: ['chat'], models: { 'general-air': 'free-air' }, limits: { concurrency: 2 } },
  { id: 'tier-2-node-01', tier: 'tier-2', priority: 80, provider: 'test', account: 'test', token: '', workloads: ['coding'], capabilities: ['chat', 'stream', 'tools'], models: { 'code-pro': 'paid-pro' }, limits: { concurrency: 5 } },
  { id: 'tier-3-node-01', tier: 'tier-3', priority: 50, provider: 'test', account: 'test', token: '', workloads: ['coding', 'critical'], capabilities: ['chat', 'stream', 'tools'], models: { 'code-max': 'plus-max' }, limits: { concurrency: 3 } },
]) });
assert.equal(nodes.length, 3, 'Should load 3 nodes');
assert.equal(nodes[0].tier, 'tier-3', 'First node should be plus (highest priority)');
assert.equal(nodes[1].tier, 'tier-2', 'Second node should be paid');
assert.equal(nodes[2].tier, 'tier-1', 'Third node should be free');
console.log('   PASS: 3 nodes loaded correctly\n');

// Test 2: Model mapping (logical → actual) with object form
console.log('2. Model mapping resolution...');
const freeNode = nodes.find(n => n.tier === 'tier-1');
assert.equal(resolveUpstreamModel(freeNode, 'general-air'), 'free-air', 'actual upstream model resolved');
assert.equal(resolveUpstreamModel(freeNode, 'unknown-model'), 'unknown-model', 'unmapped model passes through');
console.log('   PASS: Node model mapping works\n');

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
const info = getModelInfo('code-pro', models, null);
assert.equal(info.policy, 'coding-stable', 'getModelInfo returns model policy');
console.log('   PASS: Models loaded correctly\n');

// Test 4: Policy config loading
console.log('4. Policy loading...');
const { loadPoliciesConfig } = await import('../src/config/policies.js');
const policies = loadPoliciesConfig({ POLICIES_CONFIG: JSON.stringify({
  'general-fast': { tiers: ['tier-1', 'tier-2'], max_attempts: 3, retry_budget: { free: 2, paid: 1 } },
  'coding-stable': { tiers: ['tier-1', 'tier-2', 'tier-3'], max_attempts: 4, retry_budget: { free: 2, paid: 1, plus: 1 } },
}) });
assert.ok(policies['general-fast'], 'Should load general-fast policy');
assert.equal(policies['general-fast'].tiers.length, 2, 'general-fast should have 2 tiers');
assert.equal(policies['coding-stable'].tiers.length, 3, 'coding-stable should have 3 tiers');
console.log('   PASS: Policies loaded correctly\n');

// Test 5: Node selector - free node priority
console.log('5. Free node priority...');
const { selectNodes } = await import('../src/scheduler/selector.js');
const selectorTestNodes = [
  { id: 'tier-1-node-01', tier: 'tier-1', priority: 100, workloads: ['general'], capabilities: ['chat'], models: { 'general-air': 'a' }, limits: { concurrency: 2 } },
  { id: 'tier-2-node-01', tier: 'tier-2', priority: 80, workloads: ['general'], capabilities: ['chat'], models: { 'general-air': 'b' }, limits: { concurrency: 5 } },
  { id: 'tier-3-node-01', tier: 'tier-3', priority: 50, workloads: ['general'], capabilities: ['chat'], models: { 'general-air': 'c' }, limits: { concurrency: 3 } },
];
const selected = selectNodes(selectorTestNodes, { tiers: ['tier-1', 'tier-2', 'tier-3'], max_attempts: 2, retry_budget: { 'tier-1': 2, 'tier-2': 1, 'tier-3': 1 } }, { model: 'general-air' }, 'general-air');
assert.ok(selected.length > 0, 'Should select at least one node');
assert.equal(selected[0].tier, 'tier-1', 'First selected should be free tier');
console.log('   PASS: Free node selected first\n');

// Test 6: Node state management
console.log('6. Node state management...');
const ns = await import('../src/config/node-state.js');
const state = ns.getNodeState('test-node-01');
assert.equal(state.healthScore, 50, 'Initial health should be 50');
ns.recordRequestStart('test-node-01');
assert.equal(state.activeRequests, 1, 'Active requests should be 1');
ns.recordSuccess('test-node-01', 100);
assert.equal(state.activeRequests, 0, 'Active requests should be 0 after success');
assert.ok(state.healthScore > 50, 'Health should increase after success');
ns.recordFailure('test-node-01', 429, 60000, 'rate_limited');
assert.ok(state.healthScore < 50, 'Health should decrease after 429');
assert.ok(ns.isCoolingDown('test-node-01'), 'Node should be in cooldown after 429');
console.log('   PASS: Node state management works\n');

// Test 7: Circuit breaker
console.log('7. Circuit breaker...');
const circ = await import('../src/reliability/circuit.js');
circ.resetCircuit('circuit-test-node');
assert.ok(circ.shouldAllowRequest('circuit-test-node'), 'Should allow request with closed circuit');
circ.recordCircuitFailure('circuit-test-node');
circ.recordCircuitFailure('circuit-test-node');
circ.recordCircuitFailure('circuit-test-node');
assert.ok(ns.isCircuitOpen('circuit-test-node'), 'Circuit should open after 3 failures');
console.log('   PASS: Circuit breaker works\n');

// Test 8: Retry budget
console.log('8. Retry budget...');
const { shouldRetry, getAttemptBudget } = await import('../src/reliability/retry.js');
const testPolicy = { retry_budget: { free: 2, paid: 1, plus: 1 }, max_attempts: 4 };
assert.ok(shouldRetry(0, 3, 429, 'tier-1', testPolicy), 'Should retry free node on 429');
assert.ok(!shouldRetry(2, 3, 429, 'tier-1', testPolicy), 'Should not exceed free retry budget');
assert.ok(shouldRetry(0, 3, 429, 'tier-2', testPolicy), 'Should retry paid node on 429');
assert.ok(!shouldRetry(1, 3, 429, 'tier-2', testPolicy), 'Should not exceed paid retry budget');
assert.equal(getAttemptBudget(testPolicy, 'tier-3'), 1, 'plus budget is 1');
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

// Test 10: Token inline (no separate secret needed)
console.log('10. Token handling...');
const testNodes = loadNodesConfig({ TIER1_NODES_CONFIG: JSON.stringify([
  { id: 'tier-1-node-01', token: 'sk-test@https://test.example/v1', models: { 'm': 'um' } },
]) });
assert.equal(testNodes[0].token, 'sk-test@https://test.example/v1', 'Token should be inline in node config');
assert.equal(testNodes[0].token, "sk-test@https://test.example/v1", 'Token is inline');
console.log('   PASS: Token handling works\n');

// Test 11: HTTPS enforcement
console.log('11. HTTPS enforcement...');
const { getConfiguredNodes } = await import('../src/scheduler/router.js');
const httpsNodes = getConfiguredNodes({
  TIER1_NODES_CONFIG: JSON.stringify([
    { id: 'tier-1-node-01', token: 't@https://good.example/v1', models: { 'm': 'um' } },
    { id: 'tier-1-node-02', token: 't@http://bad.example/v1', models: { 'm': 'um' } },
  ]),
});
assert.equal(httpsNodes.length, 1, 'Only HTTPS node accepted by default');
assert.equal(httpsNodes[0].id, 'tier-1-node-01', 'HTTP node rejected');
console.log('   PASS: Insecure HTTP rejected\n');

// Test 12: Route plan building
console.log('12. Route plan building...');
const { buildRoutePlan } = await import('../src/scheduler/router.js');
const plan = buildRoutePlan({
  TIER1_NODES_CONFIG: JSON.stringify([
    { id: 'tier-1-node-01', tier: 'tier-1', priority: 100, provider: 'test', account: 'test', token: 'test-token@https://test.example.com/v1', workloads: ['general'], capabilities: ['chat'], models: { 'general-air': 'free-air' }, limits: { concurrency: 2 } },
  ]),
  
  MODELS_CONFIG: JSON.stringify({ 'general-air': { workload: 'general', policy: 'general-fast' } }),
  POLICIES_CONFIG: JSON.stringify({ 'general-fast': { tiers: ['tier-1', 'tier-2'], max_attempts: 3, retry_budget: { 'tier-1': 2, 'tier-2': 1 } } }),
}, 'general-air', { model: 'general-air', messages: [{ role: 'user', content: 'hi' }] });
assert.ok(plan.nodes, 'Should have nodes array');
assert.ok(plan.policy, 'Should have policy');
assert.ok(plan.modelInfo, 'Should have model info');
assert.equal(plan.nodes.length, 1, 'Should select free node');
console.log('   PASS: Route plan building works\n');

console.log('=== All Node Scheduler Tests Passed ===');