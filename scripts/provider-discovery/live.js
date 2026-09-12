// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Live Model Discovery.
//
// Reads the same node-config / credential shards used by the gateway, calls the
// provider's native /v1/models endpoint, performs zero-generation-cost surface
// probes with intentionally invalid request bodies, and emits sanitized model
// snapshots. It NEVER mutates Runtime Node config, Model Registry, Variables or
// Secrets.

import {
  DISCOVERY_LIMITS,
  enforceMaxModelCount,
  isSafeDiscoveryUrl,
  readBoundedResponseText,
  redirectTargetIsSafe,
} from './ssrf-guard.js';

const CONFIG_RE = /^TIER([123])_NODES_CONFIG_(0[1-9]|10)$/;
const SECRET_RE = /^TIER([123])_NODES_SECRETS_(0[1-9]|10)$/;
const SUPPORTED_PROTOCOLS = new Set(['openai', 'anthropic']);
const SUPPORTED_SURFACES = Object.freeze({
  openai: ['chat_completions', 'responses'],
  anthropic: ['messages'],
});

function parseJson(text, label) {
  try {
    return JSON.parse(String(text || ''));
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildTargetUrl(baseUrl, path) {
  const base = new URL(baseUrl);
  let next = String(path || '/');
  const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
  if ((basePath === '/v1' || basePath.endsWith('/v1')) && /^\/v1(?:\/|$)/i.test(next)) {
    next = next.replace(/^\/v1/i, '') || '/';
  }
  const a = base.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
  const b = next.replace(/^\/+/, '');
  base.pathname = `/${[a, b].filter(Boolean).join('/')}`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

function authHeaders(protocol, credential) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'ai-gateway-model-discovery',
  };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = credential;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${credential}`;
  }
  return headers;
}

function normalizeModelsPayload(payload) {
  const raw = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(raw)) throw new Error('/models response does not contain a model array');
  enforceMaxModelCount(raw);
  const ids = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function collectDiscoveryNodes(env) {
  const credentials = new Map();
  const secretTiers = new Map();
  for (const [name, value] of Object.entries(env || {})) {
    const m = SECRET_RE.exec(name);
    if (!m || value == null || String(value).trim() === '') continue;
    const parsed = parseJson(value, name);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${name}: expected { nodeId: credential }`);
    }
    for (const [nodeId, credential] of Object.entries(parsed)) {
      if (typeof credential !== 'string' || !credential.trim()) continue;
      if (!credentials.has(nodeId)) {
        credentials.set(nodeId, credential.trim());
        secretTiers.set(nodeId, Number(m[1]));
      }
    }
  }

  const nodes = [];
  for (const [name, value] of Object.entries(env || {})) {
    const m = CONFIG_RE.exec(name);
    if (!m || value == null || String(value).trim() === '') continue;
    const tier = Number(m[1]);
    const parsed = parseJson(value, name);
    if (!Array.isArray(parsed)) throw new Error(`${name}: expected a JSON array`);
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const baseUrl = cleanBaseUrl(raw.base_url);
      const protocol = typeof raw.protocol === 'string' ? raw.protocol.trim().toLowerCase() : 'openai';
      const credential = credentials.get(id);
      if (!id || !baseUrl || !credential || !SUPPORTED_PROTOCOLS.has(protocol)) continue;
      if (secretTiers.get(id) !== tier) continue;
      nodes.push({
        id,
        tier,
        provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : 'unknown',
        protocol,
        baseUrl,
        credential,
        configuredSurfaces: Array.isArray(raw.surfaces)
          ? raw.surfaces.filter((v) => typeof v === 'string').map((v) => v.trim().toLowerCase())
          : (protocol === 'anthropic' ? ['messages'] : ['chat_completions']),
      });
    }
  }
  return nodes.sort((a, b) => a.tier - b.tier || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

async function guardedFetch(url, init, fetchImpl, allowPrivate) {
  let current = url;
  for (let redirects = 0; redirects <= DISCOVERY_LIMITS.maxRedirects; redirects++) {
    const safe = isSafeDiscoveryUrl(current, allowPrivate);
    if (!safe.safe) throw new Error(`unsafe discovery URL: ${safe.reason}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_LIMITS.responseTimeoutMs);
    let response;
    try {
      response = await fetchImpl(current, { ...init, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error(`redirect ${response.status} without Location`);
    const next = new URL(location, current).toString();
    if (!redirectTargetIsSafe(next, allowPrivate)) throw new Error('unsafe discovery redirect target');
    current = next;
  }
  throw new Error(`too many redirects (>${DISCOVERY_LIMITS.maxRedirects})`);
}

async function fetchModels(node, fetchImpl, allowPrivate) {
  const url = buildTargetUrl(node.baseUrl, '/v1/models');
  const response = await guardedFetch(url, {
    method: 'GET',
    headers: authHeaders(node.protocol, node.credential),
  }, fetchImpl, allowPrivate);
  const text = await readBoundedResponseText(response);
  if (!response.ok) {
    const err = new Error(`/models HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('/models returned non-JSON content'); }
  return normalizeModelsPayload(payload);
}

function surfacePath(protocol, surface) {
  if (protocol === 'openai' && surface === 'chat_completions') return '/v1/chat/completions';
  if (protocol === 'openai' && surface === 'responses') return '/v1/responses';
  if (protocol === 'anthropic' && surface === 'messages') return '/v1/messages';
  throw new Error(`unsupported surface ${protocol}/${surface}`);
}

function classifyProbeStatus(status) {
  // Intentionally-invalid JSON bodies mean a validation error is evidence that
  // the route exists without generating tokens. 429 also proves the route is
  // recognized. 404/405 mean absent; auth failures and 5xx remain unknown.
  if ([400, 409, 422, 429].includes(status)) return 'supported';
  if ([404, 405].includes(status)) return 'unsupported';
  if ([401, 403].includes(status)) return 'auth_error';
  return 'unknown';
}

async function probeSurface(node, surface, fetchImpl, allowPrivate) {
  const url = buildTargetUrl(node.baseUrl, surfacePath(node.protocol, surface));
  try {
    const response = await guardedFetch(url, {
      method: 'POST',
      headers: authHeaders(node.protocol, node.credential),
      body: '{}',
    }, fetchImpl, allowPrivate);
    try { await readBoundedResponseText(response, 64 * 1024); } catch { /* status is enough */ }
    return { status: classifyProbeStatus(response.status), http_status: response.status };
  } catch (error) {
    return { status: 'unknown', error: String(error?.message || error).slice(0, 160) };
  }
}

export async function scanDiscoveryNode(node, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const allowPrivate = options.allowPrivate === true;
  const started = new Date().toISOString();
  const base = {
    node_id: node.id,
    provider: node.provider,
    tier: node.tier,
    protocol: node.protocol,
    base_url: node.baseUrl,
    scanned_at: started,
  };
  try {
    const models = await fetchModels(node, fetchImpl, allowPrivate);
    const capabilities = {};
    for (const surface of SUPPORTED_SURFACES[node.protocol]) {
      capabilities[surface] = await probeSurface(node, surface, fetchImpl, allowPrivate);
    }
    return { ...base, status: 'ok', models, capabilities };
  } catch (error) {
    return {
      ...base,
      status: 'scan_failed',
      models: [],
      capabilities: {},
      error: String(error?.message || error).slice(0, 200),
    };
  }
}

export async function scanDiscoveryEnv(env, options = {}) {
  const nodes = collectDiscoveryNodes(env);
  const results = [];
  // Sequential by design: discovery is background governance, not a load test.
  for (const node of nodes) results.push(await scanDiscoveryNode(node, options));
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    nodes: results,
  };
}

function nodeMap(snapshot) {
  return new Map((snapshot?.nodes || []).map((node) => [node.node_id, node]));
}

export function diffModelSnapshots(previous, current) {
  const prev = nodeMap(previous);
  const changes = [];
  let hasBaseline = false;
  for (const node of current?.nodes || []) {
    const before = prev.get(node.node_id);
    if (!before || before.status !== 'ok') {
      changes.push({
        node_id: node.node_id,
        provider: node.provider,
        status: node.status,
        baseline: false,
        added: [], removed: [], unchanged: [],
      });
      continue;
    }
    hasBaseline = true;
    if (node.status !== 'ok') {
      // A failed scan must never masquerade as mass model removal.
      changes.push({
        node_id: node.node_id,
        provider: node.provider,
        status: node.status,
        baseline: true,
        added: [], removed: [], unchanged: before.models || [],
      });
      continue;
    }
    const a = new Set(before.models || []);
    const b = new Set(node.models || []);
    const added = [...b].filter((m) => !a.has(m)).sort();
    const removed = [...a].filter((m) => !b.has(m)).sort();
    const unchanged = [...b].filter((m) => a.has(m)).sort();
    changes.push({
      node_id: node.node_id,
      provider: node.provider,
      status: node.status,
      baseline: true,
      added, removed, unchanged,
    });
  }
  return {
    schema_version: 1,
    generated_at: current?.generated_at || new Date().toISOString(),
    has_baseline: hasBaseline,
    changes,
  };
}

export function formatDiscoveryMarkdown(previous, current, diff) {
  const lines = ['# Model Discovery', ''];
  if (!diff.has_baseline) lines.push('No previous successful model snapshot was available; this run establishes the baseline.', '');
  for (const node of current?.nodes || []) {
    lines.push(`## ${node.provider} / ${node.node_id}`, '');
    if (node.status !== 'ok') {
      lines.push(`Scan failed: ${node.error || 'unknown error'}`, '');
      continue;
    }
    const c = diff.changes.find((x) => x.node_id === node.node_id);
    lines.push(`Models: ${node.models.length}`);
    const caps = Object.entries(node.capabilities || {}).map(([name, result]) => `${name}=${result.status}`).join(', ');
    if (caps) lines.push(`Protocol surfaces: ${caps}`);
    if (c?.baseline) {
      lines.push(`Added: ${c.added.length}; Removed: ${c.removed.length}; Unchanged: ${c.unchanged.length}`);
      if (c.added.length) lines.push('', 'Added models:', ...c.added.map((m) => `- + ${m}`));
      if (c.removed.length) lines.push('', 'Removed models:', ...c.removed.map((m) => `- - ${m}`));
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}
