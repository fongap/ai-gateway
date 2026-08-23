export function loadModelsConfig(env) {
  const raw = env?.MODELS_CONFIG;
  if (raw) {
    try {
      return parseAndValidateModels(JSON.parse(raw));
    } catch (e) {
      console.error('MODELS_CONFIG parse error:', e.message);
      return {};
    }
  }
  return {};
}

function parseAndValidateModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return {};
  const result = {};
  for (const [name, config] of Object.entries(models)) {
    if (typeof name !== 'string' || !name.trim()) continue;
    if (!config || typeof config !== 'object') continue;
    result[name] = {
      workload: String(config.workload || 'general').trim(),
      policy: String(config.policy || 'general-fast').trim(),
    };
  }
  return result;
}

export function getModelInfo(modelName, modelsConfig, modelMapping) {
  if (modelsConfig[modelName]) {
    return modelsConfig[modelName];
  }
  return { workload: 'general', policy: 'general-fast' };
}