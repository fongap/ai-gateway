const NODE_ID_PATTERN = /^(free|paid|plus)-node-\d+$/;
const VALID_TIERS = new Set(['free', 'paid', 'plus']);

export function loadNodesConfig(env) {
  const raw = env?.NODES_CONFIG;
  if (!raw) return [];
  try {
    return parseAndValidateNodes(JSON.parse(raw));
  } catch (e) {
    console.error('NODES_CONFIG parse error:', e.message);
    return [];
  }
}

function parseAndValidateNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter(n => n && typeof n.id === 'string')
    .map(n => {
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
        tier: VALID_TIERS.has(n.tier) ? n.tier : 'free',
        priority: Number.isFinite(n.priority) ? n.priority : 100,
        provider: n.provider || 'unknown',
        account: n.account || 'default',
        secret_ref: n.secret_ref || '',
        workloads: Array.isArray(n.workloads) ? n.workloads : ['general'],
        capabilities: Array.isArray(n.capabilities) ? n.capabilities : ['chat'],
        models,
        limits: {
          concurrency: Math.max(1, n.limits?.concurrency || 2),
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);
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