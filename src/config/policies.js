export function loadPoliciesConfig(env) {
  const raw = env?.POLICIES_CONFIG;
  if (raw) {
    try {
      return parseAndValidatePolicies(JSON.parse(raw));
    } catch (e) {
      console.error('POLICIES_CONFIG parse error:', e.message);
      return {};
    }
  }
  return {};
}

function parseAndValidatePolicies(policies) {
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return {};
  const result = {};
  for (const [name, config] of Object.entries(policies)) {
    if (typeof name !== 'string' || !name.trim()) continue;
    if (!config || typeof config !== 'object') continue;
    const tiers = Array.isArray(config.tiers) ? config.tiers.filter(t => ['tier-1', 'tier-2', 'tier-3'].includes(t)) : ['tier-1', 'tier-2'];
    result[name] = {
      tiers: tiers.length > 0 ? tiers : ['tier-1', 'tier-2'],
      max_attempts: Math.max(1, Math.min(config.max_attempts || 3, 5)),
retry_budget: config.retry_budget && typeof config.retry_budget === 'object'
          ? {
              'tier-1': Math.min(config.retry_budget['tier-1'] || 2, 3),
              'tier-2': Math.min(config.retry_budget['tier-2'] || 1, 2),
              'tier-3': Math.min(config.retry_budget['tier-3'] || 1, 1),
            }
          : { 'tier-1': 2, 'tier-2': 1, 'tier-3': 1 },
    };
  }
  return result;
}

export const DEFAULT_POLICY = {
  tiers: ['tier-1', 'tier-2'],
  max_attempts: 3,
  retry_budget: { 'tier-1': 2, 'tier-2': 1, 'tier-3': 1 },
};

export function getPolicy(policyName, policiesConfig) {
  return policiesConfig[policyName] || DEFAULT_POLICY;
}