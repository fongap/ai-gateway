// 统一节点配置分片模块：三个 Tier 共用同一套实现。
//
// 命名规则（固定两位编号，从 _01 开始）：
//   TIER1_NODES_CONFIG_01, TIER1_NODES_CONFIG_02, ...
//   TIER2_NODES_CONFIG_01, TIER2_NODES_CONFIG_02, ...
//   TIER3_NODES_CONFIG_01, TIER3_NODES_CONFIG_02, ...
//
// 约束：
// - 按完整 Node 对象边界拆分，禁止截断 JSON；
// - 每个分片序列化后不超过 SHARD_MAX_BYTES 字节；
// - 每个分片本身是完整合法的 JSON Array。

import fs from 'node:fs';

export const SHARD_MAX_BYTES = 4500;
export const MIN_SHARD_NUMBER = 1;
export const MAX_SHARD_NUMBER = 99;

// 本项目管理的全部节点配置 Secret（含旧版无后缀单变量）。
export const MANAGED_SECRET_PATTERN = /^TIER[123]_NODES_CONFIG(?:_\d{2})?$/;
const VALID_TIER_PATTERN = /^[123]$/;

function byteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

export function shardKeyName(tierNumber, index) {
  if (!VALID_TIER_PATTERN.test(String(tierNumber))) {
    throw new Error(`Invalid tier number: ${tierNumber}`);
  }
  if (!Number.isInteger(index) || index < MIN_SHARD_NUMBER || index > MAX_SHARD_NUMBER) {
    throw new Error(`Invalid shard index: ${index} (expected ${MIN_SHARD_NUMBER}..${MAX_SHARD_NUMBER})`);
  }
  return `TIER${tierNumber}_NODES_CONFIG_${String(index).padStart(2, '0')}`;
}

export function parseNodesFile(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  // 兼容 Windows 工具写入的 UTF-8 BOM。
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${filePath} parse error: ${e.message}`);
  }
  assertNodesArray(parsed, filePath);
  return parsed;
}

export function assertNodesArray(nodes, label = 'nodes config') {
  if (!Array.isArray(nodes)) {
    throw new Error(`${label} must be a JSON array`);
  }
  const seen = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id.trim()) {
      throw new Error(`${label} contains a node without a valid string "id"`);
    }
    if (seen.has(node.id)) {
      throw new Error(`${label} contains duplicate node id "${node.id}"`);
    }
    seen.add(node.id);
  }
}

// 按完整 Node 边界贪心拆分。返回分片 JSON 字符串数组。
export function splitNodesIntoShards(nodes, maxBytes = SHARD_MAX_BYTES) {
  assertNodesArray(nodes);
  const shards = [];
  let current = [];
  let currentBytes = 2; // '[]'
  for (const node of nodes) {
    const encoded = JSON.stringify(node);
    const encodedBytes = byteLength(encoded);
    if (encodedBytes + 2 > maxBytes) {
      throw new Error(
        `Node "${node.id}" itself is ${encodedBytes} bytes and exceeds the ${maxBytes}-byte shard limit; ` +
        'trim this node definition (it cannot be split across shards).'
      );
    }
    const joiner = current.length ? 1 : 0; // comma
    if (current.length > 0 && currentBytes + joiner + encodedBytes > maxBytes) {
      shards.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(node);
    currentBytes += (current.length > 1 ? 1 : 0) + encodedBytes;
  }
  if (current.length > 0) shards.push(current);
  return shards.map((group) => JSON.stringify(group));
}

// 单个 Tier → { "TIERx_NODES_CONFIG_01": "...", ... }
export function buildTierShardSecrets(tierNumber, nodes, maxBytes = SHARD_MAX_BYTES) {
  const secrets = {};
  const keys = [];
  const shardValues = splitNodesIntoShards(nodes, maxBytes);
  shardValues.forEach((value, i) => {
    const key = shardKeyName(tierNumber, i + 1);
    secrets[key] = value;
    keys.push(key);
  });
  return { secrets, keys };
}

// 三个 Tier 统一入口。tiers: { 1?: nodes[], 2?: nodes[], 3?: nodes[] }
export function buildShardPlan(tiers, existingSecretNames = null, maxBytes = SHARD_MAX_BYTES) {
  const secrets = {};
  const plannedKeys = [];
  const tierSummary = {};
  for (const tierNumber of [1, 2, 3]) {
    const nodes = tiers[tierNumber];
    if (!nodes) continue;
    assertNodesArray(nodes, `TIER${tierNumber} nodes config`);
    const { secrets: tierSecrets, keys } = buildTierShardSecrets(tierNumber, nodes, maxBytes);
    Object.assign(secrets, tierSecrets);
    plannedKeys.push(...keys);
    tierSummary[tierNumber] = { nodes: nodes.length, shards: keys.length };
  }
  const staleKeys = computeStaleSecrets(existingSecretNames, plannedKeys);
  return { secrets, plannedKeys, tierSummary, delete: staleKeys };
}

// 计算需要删除的旧 Secret：
// - 超出本次计划的多余分片（如 _03 不再需要）；
// - 旧版无后缀单变量（迁移到 _01 后删除）。
// 只匹配本项目管理的 TIER[123]_NODES_CONFIG(_XX)，绝不触碰其他 Secret。
export function computeStaleSecrets(existingSecretNames, plannedKeys) {
  if (!existingSecretNames) return [];
  const planned = new Set(plannedKeys);
  return existingSecretNames
    .filter((name) => MANAGED_SECRET_PATTERN.test(name) && !planned.has(name))
    .sort();
}
