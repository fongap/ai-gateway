import { loadNodesConfig, getNodeSecret } from '../config/nodes.js';
import { loadModelsConfig, getModelInfo } from '../config/models.js';
import { loadPoliciesConfig, getPolicy } from '../config/policies.js';
import { selectNodes } from './selector.js';

export function buildRoutePlan(env, requestedModel, body) {
  const modelsConfig = loadModelsConfig(env);
  const policiesConfig = loadPoliciesConfig(env);

  const modelInfo = getModelInfo(requestedModel, modelsConfig, null);
  const policyName = modelInfo?.policy || 'general-fast';
  const policy = getPolicy(policyName, policiesConfig);

  const nodes = getConfiguredNodes(env);

  if (nodes.length === 0) {
    return { nodes: [], policy, modelInfo };
  }

  const selected = selectNodes(nodes, policy, modelInfo, requestedModel);

  return { nodes: selected, policy, modelInfo };
}

export function getConfiguredNodes(env) {
  const configuredNodes = loadNodesConfig(env);
  if (configuredNodes.length === 0) return [];

  const allowInsecure = /^(true|1|yes|on)$/i.test(String(env?.ALLOW_INSECURE_HTTP_UPSTREAM || '').trim());

  return configuredNodes.map(n => {
    let raw = n.token || '';
    // 无 inline token 时通过 secret_ref 查找
    if (!raw && n.secret_ref) {
      const secret = getNodeSecret(env, n.secret_ref);
      if (secret) raw = secret;
    }
    if (!raw) return null;
    const match = raw.match(/^(.*)@(https?:\/\/.+)$/i);
    if (!match) return null;
    const baseUrl = match[2];
    if (!allowInsecure && !baseUrl.startsWith('https://')) return null;
    return {
      ...n,
      _token: match[1].trim(),
      _baseUrl: baseUrl,
    };
  }).filter(n => n && n._token && n._baseUrl);
}