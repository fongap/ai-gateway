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
    const tiers = Array.isArray(config.tiers) ? config.tiers.filter(t => ['free', 'paid', 'plus'].includes(t)) : ['free', 'paid'];
    result[name] = {
      tiers: tiers.length > 0 ? tiers : ['free', 'paid'],
      max_attempts: Math.max(1, Math.min(config.max_attempts || 3, 5)),
      retry_budget: config.retry_budget && typeof config.retry_budget === 'object'
        ? {
            free: Math.min(config.retry_budget.free || 2, 3),
            paid: Math.min(config.retry_budget.paid || 1, 2),
            plus: Math.min(config.retry_budget.plus || 1, 1),
          }
        : { free: 2, paid: 1, plus: 1 },
    };
  }
  return result;
}

export const DEFAULT_POLICY = {
  tiers: ['free', 'paid'],
  max_attempts: 3,
  retry_budget: { free: 2, paid: 1, plus: 1 },
};

export function getPolicy(policyName, policiesConfig) {
  return policiesConfig[policyName] || DEFAULT_POLICY;
}