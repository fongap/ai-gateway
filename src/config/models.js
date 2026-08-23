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

export function legacyModelMapping(env) {
  const raw = env?.MODEL_MAPPING;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch { return {}; }
}

export function getModelInfo(modelName, modelsConfig, modelMapping) {
  if (modelsConfig[modelName]) {
    return modelsConfig[modelName];
  }
  for (const [, hostMapping] of Object.entries(modelMapping)) {
    if (hostMapping && typeof hostMapping === 'object') {
      const cfg = hostMapping[modelName];
      if (cfg) {
        const workload = /code|coding|程序|代码/i.test(modelName) ? 'coding'
          : /critical|重要|关键/i.test(modelName) ? 'critical'
          : 'general';
        return {
          workload,
          policy: workload === 'coding' ? 'coding-stable' : 'general-fast',
          _mapped: true,
        };
      }
    }
  }
  return null;
}