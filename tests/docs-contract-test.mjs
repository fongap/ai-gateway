#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
const ok = (label) => { passed++; console.log(`ok - ${label}`); };

const DOCS = [
  'README.md', 'README.zh-CN.md', 'SECURITY.md',
  'docs/architecture/overview.md',
  'docs/architecture/protocol-model.md',
  'docs/architecture/routing-model.md',
  'docs/architecture/reliability-model.md',
  'docs/operations/configuration.md',
  'docs/operations/deployment.md',
];

const PROTOCOL_FACT_FILES = [
  'README.md', 'README.zh-CN.md',
  'docs/architecture/protocol-model.md',
  'docs/architecture/routing-model.md',
  'docs/operations/configuration.md',
  '.dev.vars.example', 'config/worker-vars.example.json',
];
for (const file of PROTOCOL_FACT_FILES) {
  const text = read(file);
  assert.doesNotMatch(text, /Responses\s*(?:→|->)\s*Anthropic/i, `${file}: Responses must remain Native Only`);
  assert.doesNotMatch(text, /three-way|三向/i, `${file}: no three-way protocol fallback`);
  assert.doesNotMatch(text, /"openai:responses"\s*:\s*\["anthropic:messages"\]/, `${file}: invalid Responses fallback`);
  ok(`${file} protocol contract`);
}

for (const file of ['.dev.vars.example', 'config/worker-vars.example.json']) {
  const text = read(file);
  assert.match(text, /anthropic:messages[\s\S]{0,180}openai:chat_completions/);
  assert.match(text, /openai:chat_completions[\s\S]{0,180}anthropic:messages/);
  ok(`${file} bidirectional Chat/Messages fallback`);
}

const ACCESS_FACT_FILES = [
  'README.md', 'README.zh-CN.md', 'SECURITY.md',
  'docs/operations/configuration.md', 'docs/operations/deployment.md',
  '.dev.vars.example', 'config/access-keys.example.json',
];
const GROUP_KEY = /GATEWAY_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT|<GROUP>|\{AIR,PRO,MAX,ULTRA,AGENT\})/;
const GROUP_MODELS = /GATEWAY_ACCESS_MODELS_(?:AIR|PRO|MAX|ULTRA|AGENT|<GROUP>|\{AIR,PRO,MAX,ULTRA,AGENT\})/;
for (const file of ACCESS_FACT_FILES) {
  const text = read(file);
  assert.match(text, GROUP_KEY, `${file}: grouped access key required`);
  assert.match(text, GROUP_MODELS, `${file}: grouped model allowlist required`);
  ok(`${file} grouped access model`);
}

const SHARD_FACT_FILES = [
  'README.md', 'README.zh-CN.md', 'SECURITY.md',
  'docs/architecture/routing-model.md',
  'docs/operations/configuration.md', 'docs/operations/deployment.md', '.dev.vars.example',
];
for (const file of SHARD_FACT_FILES) {
  const text = read(file);
  assert.match(text, /independent|independently|not by matching|无需.*对应|不按.*后缀|Tier\s*\+\s*node id/i,
    `${file}: must state independent Config/Secret shard binding`);
  assert.doesNotMatch(text, /(?:must|should|required to|需要|必须)[^\n]{0,80}(?:paired\s*1:1|matching\s+(?:config\s+)?shard|matching\s+suffix|一一对应|1:1\s*配对)/i,
    `${file}: must not instruct operators to pair Config/Secret suffixes`);
  ok(`${file} independent shard suffixes`);
}

const routing = read('docs/architecture/routing-model.md');
assert.match(routing, /Tier 1 has no independent attempt cap/i);
assert.match(routing, /Node `limits` are not part of the schema/i);
assert.match(routing, /`max_attempts` is the request-wide hard ceiling/i);
assert.match(routing, /There is exactly one cross-tier allocation model/i);
assert.match(routing, /There is no `budget_split`, weighted allocation, or alternate cross-tier budget mode/i);
assert.doesNotMatch(routing, /historical config|migration-time runtime interpretation/i);
ok('routing docs use one current attempt-allocation contract');

const config = read('docs/operations/configuration.md');
assert.match(config, /Required fields:[\s\S]{0,160}id[\s\S]{0,80}provider[\s\S]{0,80}base_url[\s\S]{0,80}models/i,
  'configuration docs must show the small account-level node schema');
assert.match(config, /Provider wire profiles/i);
assert.match(config, /`protocol`, `surfaces`[^\n]*rejected/i,
  'protocol/surfaces must not return to per-node config');
assert.match(config, /provider:\s*"anthropic"[\s\S]{0,100}messages/i);
assert.match(config, /provider:\s*"openai"[\s\S]{0,120}responses/i);
assert.match(config, /`budget_split`, weighted allocation, and alternate tier-budget modes are not part of the current policy schema/i);
assert.doesNotMatch(config, /protocol` is required|surfaces` is required|budget_split"\s*:/i);
ok('configuration docs match provider-owned wire contract');

for (const file of DOCS) {
  const text = read(file);
  assert.doesNotMatch(text, /RESPONSES_REASONING_MODE|ANTHROPIC_REASONING_REQUEST_MODE/, `${file}: removed knobs must stay absent`);
  assert.doesNotMatch(text, /max_attempts[^\n]{0,80}\bphysical\b/i, `${file}: max_attempts is logical`);
  assert.doesNotMatch(text, /CHANGELOG\.md|version-policy\.md|\/version\b/i, `${file}: project release/version surface must stay absent`);
  ok(`${file} has no retired contract surface`);
}

const deployYml = read('.github/workflows/deploy.yml');
const { RUNTIME_VAR_NAMES, RUNTIME_TUNABLES } = await import('../src/config/runtime-vars.ts');
for (const name of RUNTIME_VAR_NAMES) {
  assert.ok(deployYml.includes(`${name}:`), `deploy.yml must inject ${name}`);
}
ok(`deploy.yml injects all ${RUNTIME_VAR_NAMES.length} runtime variables`);

const devVars = read('.dev.vars.example');
assert.match(devVars, /Defaults live in src\/config\/runtime-vars\.ts/i,
  '.dev.vars.example must point operators to runtime-vars.ts for defaults');
for (const tunable of RUNTIME_TUNABLES) {
  assert.ok(devVars.includes(tunable.name), `.dev.vars.example must mention ${tunable.name}`);
}
ok('.dev.vars.example references every current tunable and keeps defaults single-sourced');

assert.match(routing, /Tier 1:[^\n]*Eligibility → Affinity → P2C/i);
assert.doesNotMatch(routing, /Same tier \+ same priority = LRU rotation/i);
ok('Tier 1 docs remain Affinity → P2C');

console.log(`\ndocs contract tests passed (${passed}).`);
