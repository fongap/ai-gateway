#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// GitHub Actions deployment-config bridge.
//
// Non-sensitive Worker text variables are supplied by the fork-specific GitHub
// repository Variable GATEWAY_CONFIG (config/worker-vars.example.json is a template).
// The encrypted GitHub repository Secret GATEWAY_SECRETS_CONFIG contains only:
// { "GATEWAY_ACCESS_KEY": "...", "NODE_SECRETS_01": { "node-id": "..." } }
// Values are never printed; stdout contains safe counts only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGatewayConfig } from '../src/config/nodes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAR_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const NODE_VAR = /^TIER[123]_NODES_CONFIG_\d{2}$/;
const NODE_SECRET = /^NODE_SECRETS_\d{2}$/;
const SECRET_NAME = /^(GATEWAY_ACCESS_KEY|NODE_SECRETS_\d{2})$/;
const MAX_VALUE_BYTES = 4500;

export function parseConfigObject(text, label = 'configuration') {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${error.message})`);
  }
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

export function normalizeRuntimeConfig(raw) {
  const vars = {};
  const secrets = {};
  for (const [name, rawValue] of Object.entries(raw.vars)) {
    if (!VAR_NAME.test(name)) throw new Error(`vars.${name}: invalid Worker variable name`);
    if (name === 'GATEWAY_ACCESS_KEY' || NODE_SECRET.test(name)) {
      throw new Error(`vars.${name}: credentials belong in secrets, never vars`);
    }
    const value = encodeValue(rawValue, `vars.${name}`);
    assertSize(name, value);
    vars[name] = value;
  }
  for (const [name, rawValue] of Object.entries(raw.secrets)) {
    if (!SECRET_NAME.test(name)) {
      throw new Error(`secrets.${name}: only GATEWAY_ACCESS_KEY and NODE_SECRETS_01..99 are supported`);
    }
    const value = encodeValue(rawValue, `secrets.${name}`);
    assertSize(name, value);
    secrets[name] = value;
  }
  if (!secrets.GATEWAY_ACCESS_KEY) throw new Error('secrets.GATEWAY_ACCESS_KEY is required');
  if (!Object.keys(vars).some((name) => NODE_VAR.test(name))) {
    throw new Error('vars must contain at least one TIER{1,2,3}_NODES_CONFIG_XX value');
  }
  if (!Object.keys(secrets).some((name) => NODE_SECRET.test(name))) {
    throw new Error('secrets must contain at least one NODE_SECRETS_XX value');
  }
  return { vars, secrets };
}

export function loadRuntimeConfig(varsText, secretsText, varsLabel = 'Worker variables', secretsLabel = 'Gateway secrets') {
  return normalizeRuntimeConfig({
    vars: parseConfigObject(varsText, varsLabel),
    secrets: parseConfigObject(secretsText, secretsLabel),
  });
}

// Wrangler secret bulk preserves undeclared secrets by default. Explicit null
// entries make our managed NODE_SECRETS shards a true source of truth while
// leaving unrelated Worker secrets untouched.
export function withStaleNodeSecretsRemoved(secrets, existingSecrets) {
  const out = { ...secrets };
  for (const entry of Array.isArray(existingSecrets) ? existingSecrets : []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name === 'string' && NODE_SECRET.test(name) && !(name in out)) out[name] = null;
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

export function buildWranglerConfig(vars, d1DatabaseId = '') {
  const out = {
    name: 'ai-gateway',
    main: 'src/index.js',
    compatibility_date: '2026-08-06',
    workers_dev: true,
    // CI owns every plain runtime variable. Do not retain Dashboard drift.
    keep_vars: false,
    observability: { enabled: true },
    triggers: { crons: ['0 3 * * *'] },
    vars,
  };
  if (String(d1DatabaseId || '').trim()) {
    out.d1_databases = [{
      binding: 'TOKEN_STATS_DB',
      database_name: 'ai-gateway-stats',
      database_id: String(d1DatabaseId).trim(),
      migrations_dir: 'migrations',
    }];
  }
  return out;
}

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { throw new Error(`Cannot read ${file}`); }
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readSecretList(file) {
  const parsed = JSON.parse(readFile(file));
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a JSON array from "wrangler secret list"`);
  return parsed;
}

async function verifyRemote(baseUrl, accessKey) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(origin)) throw new Error('GATEWAY_PUBLIC_BASE_URL must be an absolute https URL');
  const headers = { authorization: `Bearer ${accessKey}` };
  const health = await fetch(`${origin}/health`, { headers });
  const healthBody = await health.json().catch(() => null);
  if (!health.ok || !healthBody?.ready) {
    throw new Error(`remote /health is not ready (HTTP ${health.status}, status ${healthBody?.status || 'unknown'})`);
  }
  const models = await fetch(`${origin}/v1/models`, { headers });
  if (!models.ok) throw new Error(`remote /v1/models failed (HTTP ${models.status})`);
  const count = await fetch(`${origin}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gateway-health-check', messages: [] }),
  });
  if (!count.ok) throw new Error(`remote Claude count_tokens failed (HTTP ${count.status})`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'prepare') {
    const varsInput = argValue(argv, '--vars');
    const secretsInput = argValue(argv, '--secrets-input');
    const wrangler = argValue(argv, '--wrangler');
    const secretsOut = argValue(argv, '--secrets');
    if (!varsInput || !secretsInput || !wrangler || !secretsOut) {
      throw new Error('usage: prepare --vars FILE --secrets-input FILE --wrangler FILE --secrets FILE');
    }
    const runtime = loadRuntimeConfig(readFile(varsInput), readFile(secretsInput), varsInput, secretsInput);
    const config = validateGatewayRuntime(runtime);
    const existingSecretsFile = argValue(argv, '--existing-secrets');
    const bulkSecrets = existingSecretsFile
      ? withStaleNodeSecretsRemoved(runtime.secrets, readSecretList(existingSecretsFile))
      : runtime.secrets;
    fs.writeFileSync(wrangler, JSON.stringify(buildWranglerConfig(runtime.vars, process.env.TOKEN_STATS_D1_ID), null, 2));
    fs.writeFileSync(secretsOut, JSON.stringify(bulkSecrets));
    const removed = Object.values(bulkSecrets).filter((value) => value === null).length;
    console.log(`Runtime configuration package is valid: ${config.nodesUsable}/${config.nodesTotal} usable node(s), ${Object.keys(runtime.vars).length} Worker text variable(s), ${Object.keys(runtime.secrets).length} Worker Secret(s), ${removed} obsolete node-secret shard(s) removed.`);
    return;
  }
  if (command === 'health-check') {
    const varsInput = argValue(argv, '--vars');
    const secretsInput = argValue(argv, '--secrets-input');
    if (!varsInput || !secretsInput) {
      throw new Error('usage: health-check --vars FILE --secrets-input FILE (requires GATEWAY_PUBLIC_BASE_URL)');
    }
    const runtime = loadRuntimeConfig(readFile(varsInput), readFile(secretsInput), varsInput, secretsInput);
    await verifyRemote(process.env.GATEWAY_PUBLIC_BASE_URL, runtime.secrets.GATEWAY_ACCESS_KEY);
    console.log('Remote health checks passed.');
    return;
  }
  throw new Error('usage: github-deployment-config.mjs <prepare|health-check> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
