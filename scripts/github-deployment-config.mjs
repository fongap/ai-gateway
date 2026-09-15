#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGatewayConfig } from '../src/config/nodes.ts';
import { RUNTIME_VAR_NAMES } from '../src/config/runtime-vars.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAR_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const NODE_VAR = /^TIER[123]_NODES_CONFIG_(0[1-9]|10)$/;
const NODE_SECRET = /^TIER[123]_NODES_SECRETS_(0[1-9]|10)$/;
const KEY_GROUPS = ['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT'];
const GROUP_KEY_PATTERN = `GATEWAY_ACCESS_KEY_(?:${KEY_GROUPS.join('|')})`;
const GROUP_MODELS_PATTERN = `GATEWAY_ACCESS_MODELS_(?:${KEY_GROUPS.join('|')})`;
const SECRET_NAME = new RegExp(`^(?:${GROUP_KEY_PATTERN}|TIER[123]_NODES_SECRETS_(0[1-9]|10))$`);
const MAX_VALUE_BYTES = 4500;
const RUNTIME_VAR_PATTERN = new RegExp(
  '^(TIER[123]_NODES_CONFIG_(0[1-9]|10)|MODELS_CONFIG|POLICIES_CONFIG|' +
  GROUP_MODELS_PATTERN + '|' + RUNTIME_VAR_NAMES.join('|') + ')$',
);
const EXTRA_VAR_ALLOW = new Set(['GITHUB_SHA']);
const CREDENTIAL_NAMES = new Set([
  'CLOUDFLARE_API_TOKEN',
  'GATEWAY_ACCESS_KEY_AIR', 'GATEWAY_ACCESS_KEY_PRO', 'GATEWAY_ACCESS_KEY_MAX',
  'GATEWAY_ACCESS_KEY_ULTRA', 'GATEWAY_ACCESS_KEY_AGENT',
]);

export function parseConfigObject(text, label = 'configuration') {
  let parsed;
  try { parsed = JSON.parse(String(text || '')); }
  catch (error) { throw new Error(`${label} is not valid JSON (${error.message})`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function encodeValue(value, label) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) throw new Error(`${label} must not be null or empty`);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`${label} has an unsupported value type`);
}

function assertSize(name, value) {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new Error(`${name} exceeds the ${MAX_VALUE_BYTES}-byte Worker variable limit; shard it first`);
  }
}

export function normalizeNodeConfigJsonText(text) {
  const source = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '、' || ch === '，') {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] !== '}' && source[j] !== ']') out += ',';
      continue;
    }
    out += ch;
  }
  return out;
}

export function normalizeRuntimeConfig(raw) {
  const vars = {};
  const secrets = {};
  for (const [name, rawValue] of Object.entries(raw.vars)) {
    if (!VAR_NAME.test(name)) throw new Error(`vars.${name}: invalid Worker variable name`);
    if (CREDENTIAL_NAMES.has(name) || NODE_SECRET.test(name)) {
      throw new Error(`vars.${name}: credentials belong in secrets, never vars`);
    }
    const nodeVarMatch = /^TIER[123]_NODES_CONFIG_(\d{2})$/.exec(name);
    if (nodeVarMatch && Number(nodeVarMatch[1]) > 10) {
      throw new Error(`vars.${name}: shard index out of range (01..10); ignored`);
    }
    const encoded = encodeValue(rawValue, `vars.${name}`);
    const value = NODE_VAR.test(name) ? normalizeNodeConfigJsonText(encoded) : encoded;
    assertSize(name, value);
    vars[name] = value;
  }
  for (const [name, rawValue] of Object.entries(raw.secrets)) {
    if (!SECRET_NAME.test(name)) {
      throw new Error(`secrets.${name}: only GATEWAY_ACCESS_KEY_<GROUP> and TIER[123]_NODES_SECRETS_01..10 are supported`);
    }
    const value = encodeValue(rawValue, `secrets.${name}`);
    assertSize(name, value);
    secrets[name] = value;
  }
  if (!Object.keys(secrets).some((k) => /^GATEWAY_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT)$/.test(k))) {
    throw new Error('secrets must contain at least one GATEWAY_ACCESS_KEY_<GROUP> (AIR, PRO, MAX, ULTRA, AGENT)');
  }
  if (!Object.keys(vars).some((name) => NODE_VAR.test(name))) {
    throw new Error('vars must contain at least one TIER{1,2,3}_NODES_CONFIG_XX value');
  }
  if (!Object.keys(secrets).some((name) => NODE_SECRET.test(name))) {
    throw new Error('secrets must contain at least one TIER[123]_NODES_SECRETS_XX value');
  }
  return { vars, secrets };
}

export function loadRuntimeConfig(varsText, secretsText, varsLabel = 'Worker variables', secretsLabel = 'Gateway secrets') {
  return normalizeRuntimeConfig({
    vars: parseConfigObject(varsText, varsLabel),
    secrets: parseConfigObject(secretsText, secretsLabel),
  });
}

export function collectVarsFromEnv(env) {
  const vars = {};
  for (const [name, value] of Object.entries(env)) {
    if (value == null || String(value).trim() === '') continue;
    if (CREDENTIAL_NAMES.has(name) || NODE_SECRET.test(name)) continue;
    if (RUNTIME_VAR_PATTERN.test(name) || EXTRA_VAR_ALLOW.has(name)) vars[name] = String(value);
  }
  return { vars };
}

export function collectSecretsFromEnv(env) {
  const secrets = {};
  for (const [name, value] of Object.entries(env)) {
    if (value == null || String(value).trim() === '') continue;
    if (SECRET_NAME.test(name)) secrets[name] = String(value);
  }
  return { secrets };
}

export function buildRuntimeFromEnv(env) {
  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  return { runtime: normalizeRuntimeConfig({ vars: v.vars, secrets: s.secrets }) };
}

const REQUIRED_VARS = ['CLOUDFLARE_ACCOUNT_ID', 'GATEWAY_PUBLIC_BASE_URL'];
const REQUIRED_SECRETS = ['CLOUDFLARE_API_TOKEN'];

export function preflight(env) {
  const errors = [];
  const warnings = [];
  for (const name of REQUIRED_VARS) {
    if (!env[name] || String(env[name]).trim() === '') errors.push(`${name} is missing from GitHub Repository Variables.`);
  }
  for (const name of REQUIRED_SECRETS) {
    if (!env[name] || String(env[name]).trim() === '') errors.push(`${name} is missing from GitHub Repository Secrets.`);
  }
  const hasGroupKey = Object.keys(env).some((k) => /^GATEWAY_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT)$/.test(k) && env[k] && String(env[k]).trim() !== '');
  if (!hasGroupKey) errors.push('At least one GATEWAY_ACCESS_KEY_<GROUP> (AIR, PRO, MAX, ULTRA, AGENT) is missing from GitHub Repository Secrets.');

  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  const tierShards = Object.keys(v.vars).filter((n) => NODE_VAR.test(n)).length;
  const tier1Shards = Object.keys(v.vars).filter((n) => /^TIER1_NODES_CONFIG_(0[1-9]|10)$/.test(n)).length;
  for (const [name, value] of Object.entries(v.vars)) {
    if (NODE_VAR.test(name) && normalizeNodeConfigJsonText(value) !== value) {
      warnings.push(`${name} contains full-width JSON punctuation; deployment will normalize it. Fix the GitHub Variable at source.`);
    }
  }
  const totalManaged = Object.keys(v.vars).length + Object.keys(s.secrets).length;
  if (totalManaged > 80) warnings.push(`Worker variable + secret count is ${totalManaged} (threshold 80). Consolidate shards or reduce node count.`);
  if (!tierShards) errors.push('No TIER{1,2,3}_NODES_CONFIG_XX GitHub Variable is configured.');
  if (tier1Shards && (!env.TIER1_AFFINITY_KV_ID || String(env.TIER1_AFFINITY_KV_ID).trim() === '')) {
    errors.push('TIER1_AFFINITY_KV_ID is required when Tier 1 nodes are configured.');
  }
  if (!Object.keys(s.secrets).some((n) => NODE_SECRET.test(n))) {
    errors.push('No TIER[123]_NODES_SECRETS_XX Secret is configured.');
  }
  if (!v.vars.MODELS_CONFIG) warnings.push('MODELS_CONFIG is not set (optional; the registry applies conservative defaults).');
  if (!v.vars.POLICIES_CONFIG) warnings.push('POLICIES_CONFIG is not set (optional; default attempt budgets apply).');
  if (!env.TOKEN_STATS_D1_ID || String(env.TOKEN_STATS_D1_ID).trim() === '') warnings.push('D1 persistence disabled: TOKEN_STATS_D1_ID is not configured.');
  return { ok: errors.length === 0, errors, warnings };
}

export function buildDeploymentSummary({ config, runtime, d1Configured, affinityKvConfigured, removedSecretShards = 0 }) {
  const modelsCount = (() => {
    try { return Object.keys(JSON.parse(runtime.vars.MODELS_CONFIG || '{}')).length; }
    catch { return 0; }
  })();
  return [
    'Deployment completed', '', 'Gateway',
    '  Status: ready',
    `  Nodes: ${config.nodesUsable}/${config.nodesTotal} usable`,
    `  Models: ${modelsCount}`, '', 'Configuration',
    `  Worker variables: ${Object.keys(runtime.vars).length}`,
    `  Node secret shards: ${Object.keys(runtime.secrets).filter((n) => NODE_SECRET.test(n)).length}`,
    `  Obsolete node-secret shards removed: ${removedSecretShards}`, '', 'D1',
    `  Status: ${String(d1Configured || '').trim() ? 'ready' : 'disabled (TOKEN_STATS_D1_ID is not configured)'}`, '',
    'Tier 1 affinity KV',
    `  Status: ${String(affinityKvConfigured || '').trim() ? 'ready' : 'missing (TIER1_AFFINITY_KV_ID is not configured)'}`, '',
    'Health', '  /health                    OK', '  /v1/models                 OK', '  /v1/messages/count_tokens  OK',
  ].join('\n');
}

export function withStaleNodeSecretsRemoved(secrets, existingSecrets) {
  const out = { ...secrets };
  for (const entry of Array.isArray(existingSecrets) ? existingSecrets : []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name === 'string' && /^TIER[123]_NODES_SECRETS_(0[1-9]|10)$/.test(name) && !(name in out)) out[name] = null;
  }
  return out;
}

export function validateGatewayRuntime(runtime) {
  const env = { ...runtime.vars, ...runtime.secrets };
  const config = loadGatewayConfig(env);
  if (!config.ready) {
    const details = config.diagnostics.length ? `: ${config.diagnostics.join('; ')}` : '';
    throw new Error(`gateway runtime configuration is ${config.status}${details}`);
  }
  return config;
}

export function buildWranglerConfig(vars, d1DatabaseId = '', affinityKvId = '') {
  const out = {
    name: 'ai-gateway',
    main: path.resolve(root, 'src/index.ts'),
    compatibility_date: '2026-08-06',
    workers_dev: true,
    keep_vars: false,
    observability: { enabled: true },
    triggers: { crons: ['0 3 * * *'] },
    vars,
  };
  if (String(d1DatabaseId || '').trim()) {
    out.d1_databases = [{
      binding: 'TOKEN_STATS_DB', database_name: 'ai-gateway-stats', database_id: String(d1DatabaseId).trim(),
      migrations_dir: path.resolve(root, 'migrations'),
    }];
  }
  if (String(affinityKvId || '').trim()) {
    out.kv_namespaces = [{ binding: 'TIER1_AFFINITY', id: String(affinityKvId).trim() }];
  }
  return out;
}

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { throw new Error(`Cannot read ${file}`); }
}
function argValue(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; }
function hasFlag(argv, flag) { return argv.includes(flag); }
function readSecretList(file) {
  const parsed = JSON.parse(readFile(file));
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a JSON array from "wrangler secret list"`);
  return parsed;
}
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Remote deployment identity is the commit SHA returned by authenticated
// /health. Human release labels are not part of runtime verification.
export async function verifyRemote(baseUrl, accessKey, expectedBuild, { graceMs = 30_000, intervalMs = 5_000 } = {}) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(origin)) throw new Error('GATEWAY_PUBLIC_BASE_URL must be an absolute https URL');
  const headers = { authorization: `Bearer ${accessKey}` };
  if (expectedBuild !== undefined && !/^[a-f0-9]{40}$/i.test(expectedBuild)) {
    throw new Error('Expected build must be a full commit SHA');
  }

  const deadline = Date.now() + (expectedBuild === undefined ? 0 : graceMs);
  let healthBody = null;
  let healthStatus = 0;
  let lastError = null;
  do {
    try {
      const health = await fetch(`${origin}/health`, { headers, signal: AbortSignal.timeout(15000) });
      healthStatus = health.status;
      healthBody = await health.json().catch(() => null);
      if (!health.ok || !healthBody?.ready) {
        lastError = new Error(`remote /health is not ready (HTTP ${health.status}, status ${healthBody?.status || 'unknown'})`);
      } else if (expectedBuild !== undefined && healthBody?.build !== expectedBuild) {
        lastError = new Error(`Remote /health.build does not match the validated deployment SHA (got ${healthBody?.build ?? 'unknown'}, expected ${expectedBuild})`);
      } else {
        lastError = null;
        break;
      }
    } catch (e) { lastError = e; }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleepMs(Math.min(intervalMs, remaining));
  } while (Date.now() < deadline);
  if (lastError) throw lastError;
  if (!healthBody?.ready) throw new Error(`remote /health is not ready (HTTP ${healthStatus}, status ${healthBody?.status || 'unknown'})`);

  const models = await fetch(`${origin}/v1/models`, { headers, signal: AbortSignal.timeout(15000) });
  if (!models.ok) throw new Error(`remote /v1/models failed (HTTP ${models.status})`);
  const count = await fetch(`${origin}/v1/messages/count_tokens`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gateway-health-check', messages: [] }),
  });
  if (!count.ok) throw new Error(`remote Claude count_tokens failed (HTTP ${count.status})`);
}

function resolveRuntime(argv) {
  if (hasFlag(argv, '--from-env')) return buildRuntimeFromEnv(process.env).runtime;
  const varsInput = argValue(argv, '--vars');
  const secretsInput = argValue(argv, '--secrets-input');
  if (!varsInput || !secretsInput) {
    throw new Error('usage: prepare --from-env | --vars FILE --secrets-input FILE --wrangler FILE --secrets FILE [--existing-secrets FILE]');
  }
  return loadRuntimeConfig(readFile(varsInput), readFile(secretsInput), varsInput, secretsInput);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'preflight') {
    const result = preflight(process.env);
    for (const w of result.warnings) console.warn(`WARNING: ${w}`);
    if (result.errors.length) {
      for (const e of result.errors) console.error(`ERROR: ${e}`);
      process.exitCode = 1;
      return;
    }
    const v = collectVarsFromEnv(process.env);
    const s = collectSecretsFromEnv(process.env);
    const tierShards = Object.keys(v.vars).filter((n) => NODE_VAR.test(n)).length;
    const secretShards = Object.keys(s.secrets).filter((n) => NODE_SECRET.test(n)).length;
    console.log(`Preflight passed: ${tierShards} node-config shard(s), ${secretShards} credential shard(s), ${Object.keys(v.vars).length + Object.keys(s.secrets).length} total binding(s), Gateway Access Group Key present.`);
    return;
  }
  if (command === 'prepare') {
    const wrangler = argValue(argv, '--wrangler');
    const secretsOut = argValue(argv, '--secrets');
    if (!wrangler || !secretsOut) throw new Error('usage: prepare --from-env | --vars FILE --secrets-input FILE --wrangler FILE --secrets FILE [--existing-secrets FILE]');
    const runtime = resolveRuntime(argv);
    const config = validateGatewayRuntime(runtime);
    const existingSecretsFile = argValue(argv, '--existing-secrets');
    const bulkSecrets = existingSecretsFile ? withStaleNodeSecretsRemoved(runtime.secrets, readSecretList(existingSecretsFile)) : runtime.secrets;
    fs.writeFileSync(wrangler, JSON.stringify(buildWranglerConfig(runtime.vars, process.env.TOKEN_STATS_D1_ID, process.env.TIER1_AFFINITY_KV_ID), null, 2));
    fs.writeFileSync(secretsOut, JSON.stringify(bulkSecrets));
    const removed = Object.values(bulkSecrets).filter((value) => value === null).length;
    const summaryOut = argValue(argv, '--summary');
    if (summaryOut) {
      fs.writeFileSync(summaryOut, buildDeploymentSummary({
        config, runtime, d1Configured: process.env.TOKEN_STATS_D1_ID,
        affinityKvConfigured: process.env.TIER1_AFFINITY_KV_ID, removedSecretShards: removed,
      }) + '\n');
    }
    console.log(`Runtime configuration package is valid: ${config.nodesUsable}/${config.nodesTotal} usable node(s), ${Object.keys(runtime.vars).length} Worker text variable(s), ${Object.keys(runtime.secrets).length} Worker Secret(s), ${removed} obsolete node-secret shard(s) removed.`);
    return;
  }
  if (command === 'health-check') {
    const runtime = resolveRuntime(argv);
    const groupKey = Object.keys(runtime.secrets).find((k) => /^GATEWAY_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT)$/.test(k));
    if (!groupKey) throw new Error('No GATEWAY_ACCESS_KEY_<GROUP> secret found for health check');
    await verifyRemote(process.env.GATEWAY_PUBLIC_BASE_URL, runtime.secrets[groupKey], argValue(argv, '--expected-build') || undefined);
    console.log('Remote health checks passed.');
    return;
  }
  throw new Error('usage: github-deployment-config.mjs <preflight|prepare|health-check> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`error: ${error.message}`); process.exitCode = 1; });
}
