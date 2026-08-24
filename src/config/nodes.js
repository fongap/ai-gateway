const NODE_ID_PATTERN = /^(tier-1|tier-2|tier-3)-node-\d+$/;
const VALID_TIERS = new Set(['tier-1', 'tier-2', 'tier-3']);
const TIER_NUMBERS = [
  { tier: 'tier-1', num: 1 },
  { tier: 'tier-2', num: 2 },
  { tier: 'tier-3', num: 3 },
];
// 统一分片命名：TIERx_NODES_CONFIG_01 .. _99（固定两位编号）。
const SHARD_KEY_PATTERN = /^(TIER([123]))_NODES_CONFIG_(\d{2})$/;
// 兼容旧版单变量（只读，用于升级迁移；新部署不再创建）。
const LEGACY_KEYS = {
  'tier-1': 'TIER1_NODES_CONFIG',
  'tier-2': 'TIER2_NODES_CONFIG',
  'tier-3': 'TIER3_NODES_CONFIG',
};
const SHARD_MAX_BYTES = 4500;

function shardKeyPrefix(num) {
  return `TIER${num}_NODES_CONFIG_`;
}

export function isNodesConfigBound(env) {
  if (!env) return false;
  for (const key of Object.keys(env)) {
    if (SHARD_KEY_PATTERN.test(key) || /^TIER[123]_NODES_CONFIG$/.test(key)) return true;
  }
  return false;
}

export function loadNodesConfig(env) {
  const result = [];
  const seenIds = new Map();
  for (const { tier, num } of TIER_NUMBERS) {
    for (const [rawNode, sourceKey] of collectTierEntries(env, tier, num)) {
      const node = parseNode(rawNode, tier);
      if (!node) {
        console.error(sourceKey + ' contains an invalid node definition (missing or malformed id); skipped');
        continue;
      }
      if (seenIds.has(node.id)) {
        console.error(node.id + ' duplicated in ' + sourceKey + ' (first defined in ' + seenIds.get(node.id) + '); ignoring duplicate');
        continue;
      }
      seenIds.set(node.id, sourceKey);
      result.push(node);
    }
  }
  return result.sort((a, b) => a.priority - b.priority);
}

function collectTierEntries(env, tier, num) {
  if (!env) return [];
  const entries = [];
  const indices = [];
  for (const key of Object.keys(env)) {
    const match = SHARD_KEY_PATTERN.exec(key);
    if (match && Number(match[2]) === num) {
      indices.push({ index: Number(match[3]), key });
      continue;
    }
    if (match && Number(match[2]) !== num) continue;
    // 编号非法的同类变量（如 _1、_001、_A）不允许被静默忽略。
    if (key.startsWith(`TIER${num}_NODES_CONFIG_`)) {
      console.warn(key + ' has an illegal shard number (expected two digits, e.g. ' + shardKeyPrefix(num) + '01); ignored');
    }
  }
  if (indices.length > 0) {
    indices.sort((a, b) => a.index - b.index);
    const expected = [];
    for (let i = 1; i <= indices[indices.length - 1].index; i++) expected.push(i);
    const present = new Set(indices.map((s) => s.index));
    const missing = expected.filter((i) => !present.has(i));
    if (missing.length > 0) {
      console.warn(
        shardKeyPrefix(num) + ' missing shard number(s): ' +
        missing.map((i) => String(i).padStart(2, '0')).join(', ') + '; loading available shards only'
      );
    }
    for (const { key } of indices) {
      appendShardEntries(env[key], key, entries);
    }
    return entries;
  }
  const legacyRaw = env[LEGACY_KEYS[tier]];
  if (legacyRaw) {
    console.warn(LEGACY_KEYS[tier] + ' uses the legacy single-variable format; migrate to ' + shardKeyPrefix(num) + '01 via scripts/reconfigure');
    appendShardEntries(legacyRaw, LEGACY_KEYS[tier], entries);
  }
  return entries;
}

function appendShardEntries(raw, key, entries) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(key + ' parse error: ' + e.message);
    return;
  }
  if (!Array.isArray(parsed)) {
    console.error(key + ' must be a JSON array');
    return;
  }
  for (const n of parsed) entries.push([n, key]);
}

function parseNode(n, defaultTier) {
  if (!n || typeof n.id !== 'string') return null;
  const normalizedId = normalizeNodeId(String(n.id));
  if (!normalizedId) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(n)).length > SHARD_MAX_BYTES) {
      console.warn('Node "' + normalizedId + '" exceeds ' + SHARD_MAX_BYTES + ' bytes and cannot fit a single shard');
    }
  } catch { /* ignore size probe failures */ }
  let models = n.models;
  if (Array.isArray(models)) {
    const obj = {};
    for (const m of models) { if (typeof m === 'string' && m.trim()) obj[m.trim()] = m.trim(); }
    models = obj;
  } else if (!models || typeof models !== 'object') {
    models = {};
  } else {
    const obj = {};
    for (const [k, v] of Object.entries(models)) {
      if (typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()) obj[k.trim()] = v.trim();
    }
    models = obj;
  }
  return {
    id: normalizedId,
    tier: VALID_TIERS.has(n.tier) ? n.tier : defaultTier,
    priority: Number.isFinite(n.priority) ? n.priority : 100,
    provider: n.provider || 'unknown',
    token: typeof n.token === 'string' ? n.token : '',
    models,
    limits: { concurrency: Math.max(1, n.limits?.concurrency || 2) },
  };
}

function normalizeNodeId(id) {
  if (NODE_ID_PATTERN.test(id)) return id;
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return id;
  return null;
}

export function resolveUpstreamModel(node, logicalModel) {
  if (!node || !node.models) return logicalModel;
  return node.models[logicalModel] || logicalModel;
}
