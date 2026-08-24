import assert from 'node:assert/strict';

console.log('=== Node Config Shard Tests ===\n');

const { loadNodesConfig, isNodesConfigBound, resolveUpstreamModel } = await import('../src/config/nodes.js');
const {
  splitNodesIntoShards,
  buildShardPlan,
  buildTierShardSecrets,
  computeStaleSecrets,
  shardKeyName,
  SHARD_MAX_BYTES,
} = await import('../scripts/nodes-shard.mjs');

function makeNode(tier, num) {
  return { id: `${tier}-node-${String(num).padStart(2, '0')}`, token: `tok-${num}@https://${tier}.example/v1`, models: { 'general-air': 'model-air' } };
}
function makeNodes(tier, count) {
  return Array.from({ length: count }, (_, i) => makeNode(tier, i + 1));
}

let passed = 0;
function ok(label) { passed++; console.log(`   PASS: ${label}`); }

// ---- Case 1: Tier 1 只有 _01 ----
{
  const nodes = loadNodesConfig({ TIER1_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-1', 1)) });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'tier-1-node-01');
  assert.equal(nodes[0].tier, 'tier-1');
  ok('Case 1: Tier 1 只有 _01');
}

// ---- Case 2: Tier 1 有 _01 + _02 + _03 ----
{
  const env = {
    TIER1_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-1', 1)),
    TIER1_NODES_CONFIG_02: JSON.stringify(makeNodes('tier-1', 2).slice(1)),
    TIER1_NODES_CONFIG_03: JSON.stringify(makeNodes('tier-1', 3).slice(2)),
  };
  const nodes = loadNodesConfig(env);
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((n) => n.id), ['tier-1-node-01', 'tier-1-node-02', 'tier-1-node-03']);
  ok('Case 2: Tier 1 有 _01 + _02 + _03');
}

// ---- Case 3: Tier 2 支持多个分片 ----
{
  const nodes = loadNodesConfig({
    TIER2_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-2', 1)),
    TIER2_NODES_CONFIG_02: JSON.stringify([makeNode('tier-2', 2)]),
  });
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => n.tier === 'tier-2'));
  ok('Case 3: Tier 2 多分片');
}

// ---- Case 4: Tier 3 支持多个分片 ----
{
  const nodes = loadNodesConfig({
    TIER3_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-3', 1)),
    TIER3_NODES_CONFIG_02: JSON.stringify([makeNode('tier-3', 2)]),
  });
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => n.tier === 'tier-3'));
  ok('Case 4: Tier 3 多分片');
}

// ---- Case 5: 三层同时存在多个分片 ----
{
  const env = {
    TIER1_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-1', 2)),
    TIER1_NODES_CONFIG_02: JSON.stringify([makeNode('tier-1', 3)]),
    TIER2_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-2', 1)),
    TIER2_NODES_CONFIG_02: JSON.stringify([makeNode('tier-2', 2)]),
    TIER3_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-3', 1)),
    TIER3_NODES_CONFIG_02: JSON.stringify([makeNode('tier-3', 2)]),
  };
  const nodes = loadNodesConfig(env);
  assert.equal(nodes.length, 7);
  assert.deepEqual(
    ['tier-1', 'tier-2', 'tier-3'].map((t) => nodes.filter((n) => n.tier === t).length),
    [3, 2, 2]
  );
  ok('Case 5: 三层同时多分片（共 7 节点）');
}

// ---- Case 6: _09 → _10 排序正确（数值排序而非字符串排序）----
{
  const shards = {};
  for (let i = 1; i <= 10; i++) {
    const key = shardKeyName(1, i);
    const last = i === 10;
    shards[key] = JSON.stringify(last ? [makeNode('tier-1', i)] : []);
  }
  const nodes = loadNodesConfig(shards);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'tier-1-node-10');
  // 分片按数值顺序加载：_01.._09 全部为空数组后，_10 的节点仍然可用。
  ok('Case 6: _09 → _10 数值排序正确');
}

// ---- Case 7: 非法命名（_1）不被接受 ----
{
  const nodes = loadNodesConfig({
    TIER1_NODES_CONFIG_1: JSON.stringify(makeNodes('tier-1', 2)),
  });
  assert.equal(nodes.length, 0, '_1 命名必须被忽略');
  assert.equal(isNodesConfigBound({ TIER1_NODES_CONFIG_1: '[]' }), false);
  ok('Case 7: 非法命名 _1 不被接受');
}

// ---- Case 8: 单分片损坏不影响其他合法分片 ----
{
  const nodes = loadNodesConfig({
    TIER1_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-1', 1)),
    TIER1_NODES_CONFIG_02: '{"broken json',
    TIER1_NODES_CONFIG_03: JSON.stringify([makeNode('tier-1', 3)]),
  });
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((n) => n.id), ['tier-1-node-01', 'tier-1-node-03']);
  ok('Case 8: 损坏分片被跳过，其余分片继续加载');
}

// ---- Case 9: Node ID 跨分片重复能够检测 ----
{
  const dup = makeNode('tier-1', 1);
  const nodes = loadNodesConfig({
    TIER1_NODES_CONFIG_01: JSON.stringify([dup]),
    TIER1_NODES_CONFIG_02: JSON.stringify([dup, makeNode('tier-1', 2)]),
  });
  assert.equal(nodes.length, 2, '重复节点只保留首次定义');
  assert.deepEqual(nodes.map((n) => n.id), ['tier-1-node-01', 'tier-1-node-02']);
  ok('Case 9: 跨分片重复 Node ID 检测并去重');
}

// ---- Case 10: 8 KB 配置自动拆分 ----
{
  const big = Array.from({ length: 40 }, (_, i) => ({
    ...makeNode('tier-1', i + 1),
    note: 'x'.repeat(180),
  }));
  assert.ok(JSON.stringify(big).length > 8 * 1024, 'fixture must exceed 8KB');
  const shards = splitNodesIntoShards(big);
  assert.ok(shards.length > 1);
  for (const shard of shards) {
    assert.ok(Buffer.byteLength(shard, 'utf8') <= SHARD_MAX_BYTES);
    assert.ok(Array.isArray(JSON.parse(shard)), '每个分片必须是合法 JSON Array');
  }
  ok(`Case 10: ${JSON.stringify(big).length} bytes 配置自动拆分为 ${shards.length} 个分片`);
}

// ---- Case 11: 20 KB 配置自动拆分 ----
{
  const big = Array.from({ length: 100 }, (_, i) => ({
    ...makeNode('tier-1', i + 1),
    note: 'x'.repeat(190),
  }));
  assert.ok(JSON.stringify(big).length > 20 * 1024, 'fixture must exceed 20KB');
  const shards = splitNodesIntoShards(big);
  for (const shard of shards) assert.ok(Buffer.byteLength(shard, 'utf8') <= SHARD_MAX_BYTES);
  ok(`Case 11: ${JSON.stringify(big).length} bytes 配置自动拆分为 ${shards.length} 个分片`);
}

// ---- Case 12: 拆分后重新合并与原始 Node 数组完全等价 ----
{
  const original = [
    ...makeNodes('tier-1', 30),
    { id: 'custom-node-a', token: 'tok@https://x.example/v1', models: [], priority: 42, limits: { concurrency: 7 } },
  ];
  const shards = splitNodesIntoShards(original);
  const merged = shards.flatMap((shard) => JSON.parse(shard));
  assert.deepEqual(merged, original);
  ok('Case 12: 拆分→合并与原数组完全等价');
}

// ---- Case 13: 3 分片缩减至 2 后 _03 正确删除 ----
{
  const plan = buildShardPlan(
    { 1: makeNodes('tier-1', 60) },
    ['TIER1_NODES_CONFIG_01', 'TIER1_NODES_CONFIG_02', 'TIER1_NODES_CONFIG_03']
  );
  assert.deepEqual(plan.plannedKeys, ['TIER1_NODES_CONFIG_01', 'TIER1_NODES_CONFIG_02']);
  assert.deepEqual(plan.delete, ['TIER1_NODES_CONFIG_03']);
  ok('Case 13: 缩减后多余分片 _03 进入删除计划');
}

// ---- Case 14: 旧 TIER1_NODES_CONFIG 能升级迁移到 _01 ----
{
  const legacyNodes = makeNodes('tier-1', 2);
  const legacyLoaded = loadNodesConfig({ TIER1_NODES_CONFIG: JSON.stringify(legacyNodes) });
  assert.equal(legacyLoaded.length, 2);

  const plan = buildShardPlan({ 1: legacyNodes }, ['TIER1_NODES_CONFIG']);
  assert.deepEqual(plan.plannedKeys, ['TIER1_NODES_CONFIG_01']);
  const migrated = loadNodesConfig(plan.secrets);
  assert.deepEqual(migrated.map((n) => ({ id: n.id, tier: n.tier, priority: n.priority })), legacyLoaded.map((n) => ({ id: n.id, tier: n.tier, priority: n.priority })));
  ok('Case 14: 旧单变量配置可升级迁移到 _01 且语义等价');
}

// ---- Case 15: 迁移后旧无后缀 Secret 被删除 ----
{
  const plan = buildShardPlan({ 1: makeNodes('tier-1', 60) }, [
    'TIER1_NODES_CONFIG',
    'TIER1_NODES_CONFIG_02',
    'TIER1_NODES_CONFIG_03',
  ]);
  assert.deepEqual(plan.plannedKeys, ['TIER1_NODES_CONFIG_01', 'TIER1_NODES_CONFIG_02']);
  assert.ok(plan.delete.includes('TIER1_NODES_CONFIG'), '旧单变量必须删除');
  assert.ok(plan.delete.includes('TIER1_NODES_CONFIG_03'), '被新计划取代的旧分片必须删除');
  // 只操作本项目的节点 Secret，不触碰其他变量。
  const unrelated = computeStaleSecrets(['GATEWAY_ACCESS_KEY', 'MODELS_CONFIG', 'TIER1_NODES_CONFIG'], plan.plannedKeys);
  assert.ok(!unrelated.includes('GATEWAY_ACCESS_KEY') && !unrelated.includes('MODELS_CONFIG'));
  ok('Case 15: 迁移后旧 Secret 进入删除计划且不触碰其他 Secret');
}

// ---- 补充异常处理 ----
{
  // 中间编号缺失：warning 但按现有合法分片继续加载。
  const nodes = loadNodesConfig({
    TIER1_NODES_CONFIG_01: JSON.stringify(makeNodes('tier-1', 1)),
    TIER1_NODES_CONFIG_03: JSON.stringify([makeNode('tier-1', 3)]),
  });
  assert.equal(nodes.length, 2);
  ok('补充: _01/_03 编号缺失时仍按现有分片加载');

  // 非数组分片。
  const notArray = loadNodesConfig({ TIER2_NODES_CONFIG_01: '{"not":"array"}' });
  assert.equal(notArray.length, 0);
  ok('补充: 非 Array 分片被拒绝');

  // 单个 Node 本身超过限制时拒绝拆分。
  assert.throws(() => splitNodesIntoShards([{ id: 'huge-node', token: 'tok@https://x/v1', blob: 'x'.repeat(SHARD_MAX_BYTES) }]), /huge-node/);
  ok('补充: 超 4500 bytes 的单节点拆分时报错并指明节点');

  // 空 tier-2/tier-3 数组不产生任何 Secret。
  const plan = buildShardPlan({ 1: makeNodes('tier-1', 1), 2: [], 3: [] });
  assert.deepEqual(plan.plannedKeys, ['TIER1_NODES_CONFIG_01']);
  ok('补充: 空层不生成分片');
}

// ---- 运行时字段完整性（分片不得影响任何调度语义）----
{
  const node = {
    id: 'tier-1-node-01', tier: 'tier-1', priority: 77, provider: 'prov', token: 'tok@https://p/v1',
    models: { 'code-pro': 'real-model' }, limits: { concurrency: 5 },
  };
  const loaded = loadNodesConfig({ TIER1_NODES_CONFIG_01: JSON.stringify([node]) })[0];
  assert.equal(loaded.priority, 77);
  assert.equal(loaded.provider, 'prov');
  assert.equal(loaded.limits.concurrency, 5);
  assert.equal(resolveUpstreamModel(loaded, 'code-pro'), 'real-model');
  ok('补充: 分片加载保留 priority/provider/models/concurrency/token');
}

console.log(`\n=== All Node Config Shard Tests Passed (${passed} groups) ===`);
