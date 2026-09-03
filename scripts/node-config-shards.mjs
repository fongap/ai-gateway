#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Shared node-configuration sharding and planning module.
//
// Plain variables (no credential material allowed):
//   TIER1_NODES_CONFIG_01 .. _99   JSON arrays of node configs
//   TIER2_NODES_CONFIG_01 .. _99
//   TIER3_NODES_CONFIG_01 .. _99
// Secrets:
//   GATEWAY_ACCESS_KEY
//   TIER{1,2,3}_NODES_SECRETS_01..99   JSON objects { nodeId: credential }
//
// Cloudflare Workers variable/secret size limit is 5 KB per value; shards are
// capped below that with margin. Shards always split on complete entry
// boundaries so every shard is valid standalone JSON.
import fs from 'node:fs';

export const SHARD_MAX_BYTES = 4500;
export const MAX_SHARD_NUMBER = 99;

export const MANAGED_VAR_PATTERN = /^TIER[123]_NODES_CONFIG_\d{2}$/;
export const MANAGED_SECRET_PATTERN = /^(GATEWAY_ACCESS_KEY|TIER[123]_NODES_SECRETS_\d{2})$/;

const FORBIDDEN_NODE_FIELDS = ['token', 'credential', 'api_key', 'apikey', 'authorization', 'password', 'secret'];
const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'protocol', 'surfaces', 'base_url', 'priority', 'models', 'limits']);
const ALLOWED_LIMITS_FIELDS = new Set(['concurrency', 'rpm', 'rpm_mode']);
const VALID_TIER_PATTERN = /^[123]$/;
// protocol -> valid surfaces (mirror of src/config/nodes.js).
const PROTOCOL_SURFACES = new Map([
  ['openai', new Set(['chat_completions', 'responses'])],
  ['anthropic', new Set(['messages'])],
]);

function byteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

export function shardKeyName(kind, tierNumber, index) {
  if (kind === 'var') {
    if (!VALID_TIER_PATTERN.test(String(tierNumber))) throw new Error(`Invalid tier number: ${tierNumber}`);
    return `TIER${tierNumber}_NODES_CONFIG_${pad(index)}`;
  }
  if (kind === 'secret') {
    if (!VALID_TIER_PATTERN.test(String(tierNumber))) throw new Error(`Invalid tier number: ${tierNumber}`);
    return `TIER${tierNumber}_NODES_SECRETS_${pad(index)}`;
  }
  throw new Error(`Unknown shard kind: ${kind}`);
}

function pad(index) {
  if (!Number.isInteger(index) || index < 1 || index > MAX_SHARD_NUMBER) {
    throw new Error(`Invalid shard index: ${index} (expected 1..${MAX_SHARD_NUMBER})`);
  }
  return String(index).padStart(2, '0');
}

export function parseJsonFile(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${filePath}: invalid JSON (${e.message})`);
  }
}

// Validate one tier's node array. Throws with a precise message on any problem.
export function assertNodesArray(nodes, label = 'nodes config') {
  if (!Array.isArray(nodes)) throw new Error(`${label} must be a JSON array`);
  const seen = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`${label}: every entry must be an object`);
    }
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`${label}: node id "${String(node.id).slice(0, 40)}" missing or invalid (lowercase letters, digits, hyphens)`);
    }
    if (seen.has(id)) throw new Error(`${label}: duplicate node id "${id}"`);
    seen.add(id);
    const forbidden = FORBIDDEN_NODE_FIELDS.filter((f) => f in node);
    if (forbidden.length > 0) {
      throw new Error(`${label}: node "${id}" contains forbidden credential field(s): ${forbidden.join(', ')}. Credentials belong in the TIER{1,2,3}_NODES_SECRETS_* secret.`);
    }
    if ('tier' in node) {
      throw new Error(`${label}: node "${id}" must not declare "tier"; the tier comes from the variable name`);
    }
    for (const key of Object.keys(node)) {
      if (!ALLOWED_NODE_FIELDS.has(key)) {
        throw new Error(`${label}: node "${id}" has unknown field "${key}" (allowed: ${[...ALLOWED_NODE_FIELDS].join(', ')})`);
      }
    }
    if (typeof node.base_url !== 'string' || !node.base_url.startsWith('https://')) {
      throw new Error(`${label}: node "${id}" needs an https:// base_url`);
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(node.base_url);
    } catch {
      throw new Error(`${label}: node "${id}" has an invalid base_url`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error(`${label}: node "${id}" base_url must not contain username/password`);
    }
    if (node.priority !== undefined) {
      const num = typeof node.priority === 'number'
        ? node.priority
        : (typeof node.priority === 'string' && node.priority.trim() !== '' ? Number(node.priority) : NaN);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error(`${label}: node "${id}" priority must be a non-negative number`);
      }
    }
    // protocol: openai | anthropic. Missing = legacy implicit "openai"
    // (deprecated default; the runtime emits a diagnostic and still serves).
    if (node.protocol !== undefined) {
      const proto = String(node.protocol).trim().toLowerCase();
      if (!PROTOCOL_SURFACES.has(proto)) {
        throw new Error(`${label}: node "${id}" protocol must be "openai" or "anthropic"`);
      }
    }
    // surfaces: which endpoints the node really serves. Missing = implicit
    // legacy default for the resolved protocol (deprecated, diagnostic-only).
    if (node.surfaces !== undefined) {
      const proto = String(node.protocol ?? 'openai').trim().toLowerCase();
      const allowed = PROTOCOL_SURFACES.get(proto);
      if (!Array.isArray(node.surfaces) || node.surfaces.length === 0) {
        throw new Error(`${label}: node "${id}" surfaces must be a non-empty array`);
      }
      for (const surface of node.surfaces) {
        if (!allowed.has(String(surface).trim().toLowerCase())) {
          throw new Error(`${label}: node "${id}" surfaces entry "${String(surface).slice(0, 40)}" is not valid for protocol "${proto}" (allowed: ${[...allowed].join(', ')})`);
        }
      }
    }
    // models: missing / explicit {} => wildcard. A filled-but-invalid map is a
    // config error, never silently emptied into a wildcard.
    if (node.models !== undefined && node.models !== null) {
      if (Array.isArray(node.models)) {
        for (const m of node.models) {
          if (typeof m !== 'string' || !m.trim()) {
            throw new Error(`${label}: node "${id}" models array entries must be non-empty strings`);
          }
        }
      } else if (typeof node.models !== 'object') {
        throw new Error(`${label}: node "${id}" models must be an object { logical: upstream }`);
      } else {
        for (const [logical, upstream] of Object.entries(node.models)) {
          if (typeof upstream !== 'string' || !upstream.trim()) {
            throw new Error(`${label}: node "${id}" models["${logical}"] must map to a non-empty upstream model string`);
          }
        }
      }
    }
    if (node.limits !== undefined) {
      if (node.limits === null || typeof node.limits !== 'object' || Array.isArray(node.limits)) {
        throw new Error(`${label}: node "${id}" limits must be an object { concurrency, rpm }`);
      }
      for (const key of Object.keys(node.limits)) {
        if (!ALLOWED_LIMITS_FIELDS.has(key)) {
          throw new Error(`${label}: node "${id}" limits.${key} is not a supported limit (allowed: ${[...ALLOWED_LIMITS_FIELDS].join(', ')})`);
        }
      }
      const c = node.limits?.concurrency;
      if (c !== undefined && (!Number.isFinite(c) || c < 1)) {
        throw new Error(`${label}: node "${id}" limits.concurrency must be >= 1`);
      }
    const rpm = node.limits?.rpm;
    if (rpm !== undefined && (!Number.isFinite(rpm) || rpm < 1)) {
      throw new Error(`${label}: node "${id}" limits.rpm must be >= 1`);
    }
    const rpmMode = node.limits?.rpm_mode;
    if (rpmMode !== undefined && !['hard', 'soft'].includes(String(rpmMode).toLowerCase())) {
      throw new Error(`${label}: node "${id}" limits.rpm_mode must be "hard" or "soft"`);
    }
    }
  }
}

// Validate the credential map { nodeId: credential }.
export function assertSecretsObject(obj, label = 'node secrets') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label} must be a JSON object { nodeId: credential }`);
  }
  const seen = new Set();
  for (const [id, credential] of Object.entries(obj)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`${label}: key "${id}" is not a valid node id`);
    }
    if (seen.has(id)) throw new Error(`${label}: duplicate key "${id}"`);
    seen.add(id);
    if (typeof credential !== 'string' || !credential.trim()) {
      throw new Error(`${label}: credential for "${id}" must be a non-empty string`);
    }
  }
}

// Greedy split of ordered entries into JSON-array shards at entry boundaries.
function splitEntries(entries, maxBytes) {
  const shards = [];
  let current = [];
  let currentBytes = 2; // "[]"
  for (const [key, encoded, encodedBytes] of entries) {
    if (encodedBytes + 2 > maxBytes) {
      throw new Error(`Entry "${key}" itself is ${encodedBytes} bytes and exceeds the ${maxBytes}-byte shard limit; trim this entry.`);
    }
    const joiner = current.length > 0 ? 1 : 0;
    if (current.length > 0 && currentBytes + joiner + encodedBytes > maxBytes) {
      shards.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(encoded);
    currentBytes += joiner + encodedBytes;
  }
  if (current.length > 0) shards.push(current);
  return shards.map((list) => '[' + list.join(',') + ']');
}

function nodesToEntries(nodes) {
  return nodes.map((node) => {
    const encoded = JSON.stringify(node);
    return [node.id, encoded, byteLength(encoded)];
  });
}

function secretsToEntries(obj) {
  return Object.entries(obj).map(([id, credential]) => {
    const encoded = JSON.stringify({ [id]: credential }).replace(/^\{|\}$/g, '');
    return [id, encoded, byteLength(encoded)];
  });
}

// Build the full deployment plan.
// tiers: { 1: nodes[], 2?: nodes[], 3?: nodes[] }, secretsMap: { nodeId: credential }
export function buildPlan({ tiers, secretsMap, existingVarNames = [], existingSecretNames = [], maxBytes = SHARD_MAX_BYTES }) {
  for (const tierNumber of [1, 2, 3]) {
    if (tiers[tierNumber]) assertNodesArray(tiers[tierNumber], `TIER${tierNumber} nodes config`);
  }
  if (secretsMap) assertSecretsObject(secretsMap);

  // Cross-validation: every node needs a credential, warn on orphan credentials.
  const nodeIds = new Set();
  for (const tierNumber of [1, 2, 3]) {
    for (const node of tiers[tierNumber] ?? []) nodeIds.add(node.id.trim());
  }
  if (secretsMap) {
    for (const id of Object.keys(secretsMap)) {
      if (!nodeIds.has(id)) throw new Error(`credential "${id}" has no matching node in any tier config`);
    }
    for (const id of nodeIds) {
      if (!(id in secretsMap)) throw new Error(`node "${id}" has no credential in the node secrets file`);
    }
  }

  const vars = {};
  const secrets = {};
  const plannedVars = [];
  const plannedSecrets = [];
  const tierSummary = {};

  for (const tierNumber of [1, 2, 3]) {
    const nodes = tiers[tierNumber];
    if (!nodes || nodes.length === 0) continue;
    const shards = splitEntries(nodesToEntries(nodes), maxBytes);
    shards.forEach((value, i) => {
      const key = shardKeyName('var', tierNumber, i + 1);
      vars[key] = value;
      plannedVars.push(key);
    });
    tierSummary[tierNumber] = { nodes: nodes.length, shards: shards.length };
  }

  if (secretsMap && Object.keys(secretsMap).length > 0) {
    // Shard secrets per-tier to match the node-config shard structure.
    for (const tierNumber of [1, 2, 3]) {
      const nodes = tiers[tierNumber];
      if (!nodes || nodes.length === 0) continue;
      const tierNodeIds = new Set(nodes.map((n) => n.id.trim()));
      const tierEntries = Object.entries(secretsMap)
        .filter(([id]) => tierNodeIds.has(id))
        .sort(([a], [b]) => a.localeCompare(b));
      if (tierEntries.length === 0) continue;
      // Shard whole-object boundaries: accumulate entries until byte budget hit.
      const shards = [];
      let currentEntries = [];
      let currentBytes = 2;
      for (const [id, credential] of tierEntries) {
        const pair = `"${id}":${JSON.stringify(credential)}`;
        const joiner = currentEntries.length > 0 ? 1 : 0;
        if (currentEntries.length > 0 && currentBytes + joiner + byteLength(pair) > maxBytes) {
          shards.push(currentEntries);
          currentEntries = [];
          currentBytes = 2;
        }
        currentEntries.push(pair);
        currentBytes += joiner + byteLength(pair);
        if (byteLength(pair) + 2 > maxBytes) {
          throw new Error(`Credential "${id}" is too large for a single ${maxBytes}-byte shard.`);
        }
      }
      if (currentEntries.length > 0) shards.push(currentEntries);
      shards.forEach((entries_, i) => {
        const key = shardKeyName('secret', tierNumber, i + 1);
        secrets[key] = '{' + entries_.join(',') + '}';
        plannedSecrets.push(key);
      });
      tierSummary[tierNumber].secretShards = shards.length;
    }
  }

  const planned = new Set([...plannedVars]);
  const deleteVars = [...new Set(existingVarNames)].filter((name) => MANAGED_VAR_PATTERN.test(name) && !planned.has(name)).sort();
  const plannedS = new Set(plannedSecrets);
  const deleteSecrets = [...new Set(existingSecretNames)]
    .filter((name) => /^TIER[123]_NODES_SECRETS_\d{2}$/.test(name) && !plannedS.has(name))
    .sort();

  return { vars, secrets, plannedVars, plannedSecrets, deleteVars, deleteSecrets, tierSummary };
}
