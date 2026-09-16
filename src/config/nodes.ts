// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Config Layer: environment shards -> Runtime Node list.
//
//   TIER{1,2,3}_NODES_CONFIG_01..10   plain variables, JSON arrays of node
//                                     configs WITHOUT credential material.
//   TIER{1,2,3}_NODES_SECRETS_01..10  secrets, JSON objects { nodeId: credential }.
//
// Current Node JSON schema is explicit. Required fields:
//   id, provider, protocol, surfaces, base_url, models
// Optional:
//   priority (non-negative integer number, default 100)
//
// There are no old-version defaults or alternate shapes. Missing protocol /
// surfaces / provider / models, a models array, numeric strings, retired limits,
// credential fields, or unknown fields are configuration errors.

import { readEnv, getBool } from './env.ts';
import { loadModelsConfig, getModelsConfigDiagnostics } from './models.ts';
import { loadPoliciesConfig, getPoliciesConfigDiagnostics } from './policies.ts';
import { getProtocolFallbacksDiagnostics } from './protocol-fallbacks.ts';
import { loadModelRegistry } from './registry.ts';
import type { RegistryEntry } from './registry.ts';
import type { RuntimeNode, NodeTier } from '../types/node.ts';
import type { Protocol, Surface } from '../types/protocol.ts';

export const TIER_SHARD_PATTERN = /^TIER([123])_NODES_CONFIG_(\d{2})$/;
export const SECRET_SHARD_PATTERN = /^TIER([123])_NODES_SECRETS_(\d{2})$/;
export const MAX_SHARD_INDEX = 10;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_NODE_FIELDS = ['token', 'credential', 'api_key', 'apikey', 'authorization', 'password', 'secret'];
const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'protocol', 'surfaces', 'base_url', 'priority', 'models']);
const PROTOCOL_SURFACES = new Map<string, Set<string>>([
  ['openai', new Set(['chat_completions', 'responses'])],
  ['anthropic', new Set(['messages'])],
]);

export type ConfigStatus = 'unconfigured' | 'invalid' | 'degraded' | 'ready';

export type GatewayConfig = {
  status: ConfigStatus,
  ready: boolean,
  accessKeyBound: boolean,
  nodes: RuntimeNode[],
  tiers: Record<number, RuntimeNode[]>,
  bindings: {
    tierShards: string[],
    secretShards: string[],
  },
  nodesTotal: number,
  nodesUsable: number,
  diagnostics: string[],
};

let cachedEnv: Record<string, unknown> | undefined;
let cachedResult: GatewayConfig | undefined;

export function loadGatewayConfig(env: Record<string, unknown>): GatewayConfig {
  if (cachedEnv === env && cachedResult) return cachedResult;
  cachedEnv = env;
  cachedResult = buildConfig(env);
  return cachedResult;
}

function collectAuxConfigDiagnostics(env: Record<string, unknown>): string[] {
  const diags = [
    ...getModelsConfigDiagnostics(env),
    ...getPoliciesConfigDiagnostics(env),
  ];
  const models = loadModelsConfig(env);
  const policies = loadPoliciesConfig(env);
  for (const [model, mcfg] of Object.entries(models)) {
    const pname = mcfg?.policy || 'default';
    if (!policies[pname]) diags.push(`MODELS_CONFIG: model "${model}" references unknown policy "${pname}"`);
  }
  return diags;
}

function collectNodeModelDiagnostics(nodes: ReadonlyArray<RuntimeNode>, env: Record<string, unknown>): string[] {
  const diags: string[] = [];
  let registry: Record<string, RegistryEntry>;
  try {
    registry = loadModelRegistry(env);
  } catch {
    return diags;
  }
  if (!registry || Object.keys(registry).length === 0) return diags;
  const internalModels = new Set<string>();
  for (const [name, entry] of Object.entries(registry)) {
    if (entry.visibility === 'internal') internalModels.add(name);
  }
  if (internalModels.size === 0) return diags;
  for (const node of nodes) {
    for (const logical of Object.keys(node.models)) {
      if (internalModels.has(logical)) {
        diags.push(`NODE CONFIG: node "${node.id}" maps logical model "${logical}" which is marked visibility:"internal" in MODELS_CONFIG; internal models are still requestable but hidden from the dashboard`);
      }
    }
  }
  return diags;
}

function buildConfig(env: Record<string, unknown>): GatewayConfig {
  const diagnostics: string[] = [];
  const auxDiagnostics = collectAuxConfigDiagnostics(env);
  auxDiagnostics.push(...getProtocolFallbacksDiagnostics(env));
  diagnostics.push(...auxDiagnostics);
  const accessKeyBound = ['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT'].some((g) => readEnv(env, `GATEWAY_ACCESS_KEY_${g}`));

  const tierShards = collectShards(env, TIER_SHARD_PATTERN, 'TIER1_NODES_CONFIG_', 'TIER1_NODES_CONFIG_01', 2, diagnostics);
  const secretShards = collectShards(env, SECRET_SHARD_PATTERN, 'TIER1_NODES_SECRETS_', 'TIER1_NODES_SECRETS_01', 2, diagnostics);
  const nodesDeclared = tierShards.reduce((sum, s) => sum + countArrayEntries(env[s.key] as string), 0);

  let status: ConfigStatus = 'unconfigured';
  if (!accessKeyBound || tierShards.length === 0) {
    return {
      status,
      ready: false,
      accessKeyBound,
      nodes: [],
      tiers: { 1: [], 2: [], 3: [] },
      bindings: {
        tierShards: tierShards.map((s) => s.key).sort(),
        secretShards: secretShards.map((s) => s.key).sort(),
      },
      nodesTotal: nodesDeclared,
      nodesUsable: 0,
      diagnostics,
    };
  }

  const credentials = new Map<string, string>();
  const credentialTiers = new Map<string, string>();
  let conflict = false;
  const sortedSecretShards = [...secretShards].sort((a, b) => a.tierNumber - b.tierNumber || a.index - b.index);
  for (const shard of sortedSecretShards) {
    const parsed = parseJsonVar(env[shard.key] as string, shard.key, diagnostics);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      diagnostics.push(`${shard.key}: must be a JSON object { nodeId: credential }`);
      conflict = true;
      continue;
    }
    const shardTier = `tier-${shard.tierNumber}`;
    for (const [nodeId, credential] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof credential !== 'string' || !credential.trim()) {
        diagnostics.push(`${shard.key}: credential for "${nodeId}" is empty`);
        conflict = true;
        continue;
      }
      if (credentials.has(nodeId)) {
        diagnostics.push(`credential id "${nodeId}" defined in multiple secret shards (${credentialTiers.get(nodeId)} and ${shardTier})`);
        conflict = true;
        continue;
      }
      credentials.set(nodeId, credential);
      credentialTiers.set(nodeId, shardTier);
    }
  }

  const allowInsecure = getBool(env, 'ALLOW_INSECURE_HTTP_UPSTREAM', false);
  const seenIds = new Map<string, string>();
  const nodes: RuntimeNode[] = [];
  const sortedTierShards = [...tierShards].sort((a, b) => a.tierNumber - b.tierNumber || a.index - b.index);
  for (const shard of sortedTierShards) {
    const tier = `tier-${shard.tierNumber}` as NodeTier;
    const parsed = parseJsonVar(env[shard.key] as string, shard.key, diagnostics);
    if (!Array.isArray(parsed)) {
      diagnostics.push(`${shard.key}: must be a JSON array of node objects`);
      conflict = true;
      continue;
    }
    for (const rawNode of parsed) {
      const rawId = rawNode && typeof rawNode === 'object' && !Array.isArray(rawNode)
        && typeof (rawNode as Record<string, unknown>).id === 'string'
        ? ((rawNode as Record<string, unknown>).id as string).trim()
        : '';
      const secretTier = ID_PATTERN.test(rawId) ? credentialTiers.get(rawId) : undefined;
      if (secretTier && secretTier !== tier) {
        diagnostics.push(`Node "${rawId}" belongs to TIER${shard.tierNumber} but its credential is defined under TIER${secretTier.slice(5)}.`);
        conflict = true;
        continue;
      }
      const node = buildRuntimeNode(rawNode, tier, credentials, allowInsecure, shard.key, diagnostics);
      if (!node) continue;
      if (seenIds.has(node.id)) {
        diagnostics.push(`duplicate node id "${node.id}" (${seenIds.get(node.id)} and ${shard.key})`);
        conflict = true;
        continue;
      }
      seenIds.set(node.id, shard.key);
      nodes.push(node);
    }
  }

  diagnostics.push(...collectNodeModelDiagnostics(nodes, env));
  for (const [nodeId] of credentials) {
    if (!seenIds.has(nodeId)) diagnostics.push(`credential "${nodeId}" has no matching node config`);
  }

  if (auxDiagnostics.length > 0) status = 'invalid';
  else if (conflict || nodes.length === 0) status = 'invalid';
  else if (nodes.length < nodesDeclared) status = 'degraded';
  else status = 'ready';
  const ready = status === 'ready' || status === 'degraded';

  const tiers: Record<number, RuntimeNode[]> = { 1: [], 2: [], 3: [] };
  for (const node of nodes) tiers[Number(node.tier.slice(5))].push(node);
  for (const list of Object.values(tiers)) list.sort((a, b) => a.priority - b.priority);

  return {
    status,
    ready,
    accessKeyBound,
    nodes,
    tiers,
    bindings: {
      tierShards: sortedTierShards.map((s) => s.key),
      secretShards: sortedSecretShards.map((s) => s.key),
    },
    nodesTotal: nodesDeclared,
    nodesUsable: nodes.length,
    diagnostics,
  };
}

function buildRuntimeNode(
  rawNode: unknown,
  tier: NodeTier,
  credentials: Map<string, string>,
  allowInsecure: boolean,
  sourceKey: string,
  diagnostics: string[],
): RuntimeNode | null {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    diagnostics.push(`${sourceKey}: entry is not a JSON object`);
    return null;
  }
  const rec = rawNode as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  if (!ID_PATTERN.test(id)) {
    diagnostics.push(`${sourceKey}: node id "${String(rec.id).slice(0, 40)}" is missing or invalid (lowercase letters, digits, hyphens)`);
    return null;
  }
  if ('tier' in rec) {
    diagnostics.push(`node "${id}": "tier" field is not allowed; the tier comes from the variable name (${sourceKey})`);
    return null;
  }
  const forbidden = FORBIDDEN_NODE_FIELDS.filter((f) => f in rec);
  if (forbidden.length > 0) {
    diagnostics.push(`node "${id}": forbidden credential field(s) ${forbidden.join(', ')}; credentials belong in TIER{N}_NODES_SECRETS_*`);
    return null;
  }
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_NODE_FIELDS.has(key)) {
      diagnostics.push(`node "${id}": unknown field "${key}" (allowed: id, provider, protocol, surfaces, base_url, priority, models)`);
      return null;
    }
  }

  const provider = typeof rec.provider === 'string' ? rec.provider.trim() : '';
  if (!provider) {
    diagnostics.push(`node "${id}": provider is required and must be a non-empty string`);
    return null;
  }

  const baseUrl = typeof rec.base_url === 'string' ? rec.base_url.trim() : '';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    diagnostics.push(`node "${id}": base_url is missing or not a valid URL`);
    return null;
  }
  if (!allowInsecure && url.protocol !== 'https:') {
    diagnostics.push(`node "${id}": base_url must use https:// (set ALLOW_INSECURE_HTTP_UPSTREAM=true to override)`);
    return null;
  }
  if (url.username || url.password) {
    diagnostics.push(`node "${id}": base_url must not contain username/password`);
    return null;
  }

  const credential = credentials.get(id);
  if (!credential) {
    diagnostics.push(`node "${id}": no credential found in TIER{N}_NODES_SECRETS_*; node excluded`);
    return null;
  }

  const protocol = parseProtocol(rec.protocol, id, diagnostics);
  if (protocol === null) return null;
  const surfaces = parseSurfaces(rec.surfaces, protocol, id, diagnostics);
  if (surfaces === null) return null;
  const models = normalizeModels(rec.models, id, diagnostics);
  if (models === null) return null;
  const priority = parsePriority(rec.priority, id, diagnostics);
  if (priority === null) return null;

  return {
    id,
    tier,
    provider,
    protocol,
    surfaces,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    credential,
    priority,
    models,
  };
}

function parseProtocol(raw: unknown, nodeId: string, diagnostics: string[]): Protocol | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    diagnostics.push(`node "${nodeId}": protocol is required and must be "openai" or "anthropic"`);
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (!PROTOCOL_SURFACES.has(value)) {
    diagnostics.push(`node "${nodeId}": protocol must be "openai" or "anthropic"`);
    return null;
  }
  return value as Protocol;
}

function parseSurfaces(raw: unknown, protocol: Protocol, nodeId: string, diagnostics: string[]): Surface[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    diagnostics.push(`node "${nodeId}": surfaces is required and must be a non-empty array`);
    return null;
  }
  const allowed = PROTOCOL_SURFACES.get(protocol) as Set<string>;
  const out: Surface[] = [];
  for (const entry of raw) {
    const value = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!allowed.has(value)) {
      diagnostics.push(`node "${nodeId}": surfaces entry "${String(entry).slice(0, 40)}" is not valid for protocol "${protocol}" (allowed: ${[...allowed].join(', ')})`);
      return null;
    }
    if (!out.includes(value as Surface)) out.push(value as Surface);
  }
  return out;
}

function parsePriority(raw: unknown, nodeId: string, diagnostics: string[]): number | null {
  if (raw === undefined) return 100;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    diagnostics.push(`node "${nodeId}": priority must be a non-negative integer number`);
    return null;
  }
  return raw;
}

function normalizeModels(models: unknown, nodeId: string, diagnostics: string[]): Record<string, string> | null {
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    diagnostics.push(`node "${nodeId}": models is required and must be an object { logical: upstream }; use {} only for an intentional catalog-bounded wildcard`);
    return null;
  }

  const out: Record<string, string> = {};
  for (const key of Object.keys(models)) {
    if (!key.trim()) {
      diagnostics.push(`node "${nodeId}": models keys must be non-empty strings`);
      return null;
    }
    const value = (models as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !value.trim()) {
      diagnostics.push(`node "${nodeId}": models["${key}"] must map to a non-empty upstream model string`);
      return null;
    }
    out[key.trim()] = value.trim();
  }
  return out;
}

export function collectShards(
  env: Record<string, unknown>,
  pattern: RegExp,
  loosePrefix: string,
  expectedExample: string,
  indexGroup: number,
  diagnostics: string[],
): Array<{ key: string, index: number, tierNumber: number }> {
  const shards: Array<{ key: string, index: number, tierNumber: number }> = [];
  for (const key of Object.keys(env || {})) {
    const match = pattern.exec(key);
    if (match) {
      const index = Number(match[indexGroup]);
      if (index < 1 || index > MAX_SHARD_INDEX) {
        diagnostics.push(`${key}: shard index out of range (expected 01..${String(MAX_SHARD_INDEX).padStart(2, '0')}); ignored`);
        continue;
      }
      shards.push({
        key,
        tierNumber: pattern.source.includes('TIER') ? Number(match[1]) : 0,
        index,
      });
      continue;
    }
    if (!pattern.test(key) && key.startsWith(loosePrefix)) {
      diagnostics.push(`${key}: malformed shard name (expected ${expectedExample}); ignored`);
    }
  }
  return shards;
}

function parseJsonVar(raw: string, key: string, diagnostics: string[]): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push(`${key}: invalid JSON (${msg})`);
    return null;
  }
}

function countArrayEntries(raw: string): number {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
