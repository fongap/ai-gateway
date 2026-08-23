const NODE_ID_PATTERN = /^(tier-1|tier-2|tier-3)-node-\d+$/;
const VALID_TIERS = new Set(['tier-1', 'tier-2', 'tier-3']);

export function loadNodesConfig(env) {
  const result = [];
  for (const tier of ['tier-1', 'tier-2', 'tier-3']) {
    const key = tier.toUpperCase() + '_NODES_CONFIG';
    const raw = env?.[key];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const n of parsed) {
          const node = parseNode(n, tier);
          if (node) result.push(node);
        }
      } else {
        console.error('NODES_CONFIG: ' + key + ' must be a JSON array');
      }
    } catch (e) {
      console.error('NODES_CONFIG parse error (' + key + '):', e.message);
    }
  }
  // 兼容旧版单文件 NODES_CONFIG
  if (result.length === 0 && env?.NODES_CONFIG) {
    try {
      const parsed = JSON.parse(env.NODES_CONFIG);
      if (Array.isArray(parsed)) {
        for (const n of parsed) {
          const node = parseNode(n, n.tier || 'tier-1');
          if (node) result.push(node);
        }
      }
    } catch (e) {
      console.error('NODES_CONFIG parse error:', e.message);
    }
  }
  return result.sort((a, b) => a.priority - b.priority);
}

function parseNode(n, defaultTier) {
  if (!n || typeof n.id !== 'string') return null;
  const normalizedId = normalizeNodeId(String(n.id));
  if (!normalizedId) return null;
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
    secret_ref: n.secret_ref || '',
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

export function getNodeSecret(env, secretRef) {
  if (!secretRef) return null;
  const value = env?.[secretRef];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return value || null;
}