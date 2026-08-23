import { loadNodesConfig, legacyToNodes, getNodeSecret } from '../config/nodes.js';
import { loadModelsConfig, getModelInfo, legacyModelMapping } from '../config/models.js';
import { loadPoliciesConfig, getPolicy } from '../config/policies.js';
import { selectNodes } from './selector.js';

export function buildRoutePlan(env, requestedModel, body) {
  const modelsConfig = loadModelsConfig(env);
  const modelMapping = legacyModelMapping(env);
  const policiesConfig = loadPoliciesConfig(env);

  const modelInfo = getModelInfo(requestedModel, modelsConfig, modelMapping);
  const policyName = modelInfo?.policy || 'general-fast';
  const policy = getPolicy(policyName, policiesConfig);

  const nodes = buildNodeList(env);

  if (nodes.length === 0) {
    return { nodes: [], policy, modelInfo };
  }

  const selected = selectNodes(nodes, policy, modelInfo, requestedModel);

  return { nodes: selected, policy, modelInfo };
}

function buildNodeList(env) {
  const configuredNodes = loadNodesConfig(env);

  if (configuredNodes.length > 0) {
    return configuredNodes.map(n => {
      if (n._legacyToken && n._legacyBaseUrl) return n;
      if (!n.secret_ref) return null;
      const secret = getNodeSecret(env, n.secret_ref);
      if (!secret) return null;
      const match = secret.match(/^(.*)@(https?:\/\/.+)$/i);
      if (!match) return null;
      return {
        ...n,
        _token: match[1].trim(),
        _baseUrl: match[2],
      };
    }).filter(n => n && (n._token || n._legacyToken));
  }

  const legacyNodes = legacyToNodes(env);
  return legacyNodes.filter(n => n._legacyToken && n._legacyBaseUrl);
}