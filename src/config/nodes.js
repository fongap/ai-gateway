const NODE_ID_PATTERN = /^(free|paid|plus)-node-\d+$/;
const VALID_TIERS = new Set(['free', 'paid', 'plus']);

export function loadNodesConfig(env) {
  const raw = env?.NODES_CONFIG;
  if (raw) {
    try {
      return parseAndValidateNodes(JSON.parse(raw));
    } catch (e) {
      console.error('NODES_CONFIG parse error:', e.message);
      return [];
    }
  }
  return [];
}

function parseAndValidateNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter(n => n && typeof n.id === 'string' && NODE_ID_PATTERN.test(n.id))
    .map(n => ({
      id: n.id,
      tier: VALID_TIERS.has(n.tier) ? n.tier : 'free',
      priority: Number.isFinite(n.priority) ? n.priority : 100,
      provider: n.provider || 'unknown',
      account: n.account || 'default',
      secret_ref: n.secret_ref || '',
      workloads: Array.isArray(n.workloads) ? n.workloads : ['general'],
      capabilities: Array.isArray(n.capabilities) ? n.capabilities : ['chat'],
      models: Array.isArray(n.models) ? n.models : [],
      limits: {
        concurrency: Math.max(1, n.limits?.concurrency || 2),
      },
    }))
    .sort((a, b) => a.priority - b.priority);
}

export function getNodeSecret(env, secretRef) {
  if (!secretRef) return null;
  const value = readOptionalEnv(env, secretRef);
  if (value) return value;
  const alt = env?.[secretRef];
  return alt || null;
}

function readOptionalEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : value;
}

export function legacyToNodes(env) {
  const tokens = readOptionalEnv(env, 'PRIMARY_API_TOKENS');
  if (!tokens) return [];
  const defaultBaseUrl = readOptionalEnv(env, 'PRIMARY_BASE_URL') || '';
  const allowInsecure = readBooleanEnv(env, 'ALLOW_INSECURE_HTTP_UPSTREAM', false);
  const items = parseTokens(tokens, defaultBaseUrl, allowInsecure);
  return items.map((item, i) => ({
    id: `free-node-${i + 1}`,
    tier: 'free',
    priority: 100 - i * 5,
    provider: inferProvider(item.baseUrl),
    account: 'legacy',
    secret_ref: '',
    workloads: ['general', 'coding'],
    capabilities: ['chat', 'stream', 'tools'],
    models: [],
    limits: { concurrency: 2 },
    _legacyToken: item.token,
    _legacyBaseUrl: item.baseUrl,
  }));
}

function parseTokens(raw, defaultBaseUrl, allowInsecureHttp) {
  const source = String(raw || '');
  if (source.includes(';')) return [];
  const items = source.split(/[,\r\n]+/).map(item => item.trim()).filter(Boolean);
  return items.map(item => {
    const match = item.match(/^(.*)@(https?:\/\/.+)$/i);
    const token = match ? match[1].trim() : item;
    const rawBaseUrl = match ? match[2] : defaultBaseUrl || '';
    const baseUrl = normalizeUpstreamBaseUrl(rawBaseUrl, allowInsecureHttp);
    if (!token || !baseUrl) return null;
    return { token, baseUrl };
  }).filter(Boolean);
}

function normalizeUpstreamBaseUrl(value, allowInsecureHttp) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' && !(allowInsecureHttp && parsed.protocol === 'http:')) return '';
    if (parsed.username || parsed.password) return '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch { return ''; }
}

function inferProvider(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname || 'legacy'; }
  catch { return 'legacy'; }
}

function readBooleanEnv(env, name, fallback) {
  const value = readOptionalEnv(env, name);
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}