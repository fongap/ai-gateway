#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Docs contract test: blocks old-architecture semantics from re-entering docs.
// Scans current docs/examples (excluding CHANGELOG.md, whose historical entries
// legitimately describe earlier behavior) for factual drift.
//
// Run as part of `npm run validate:merge`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'README.md',
  'README_EN.md',
  'SECURITY.md',
  'docs/architecture/overview.md',
  'docs/architecture/protocol-model.md',
  'docs/architecture/routing-model.md',
  'docs/architecture/reliability-model.md',
  'docs/operations/configuration.md',
  'docs/operations/deployment.md',
];

let passed = 0;

function readDoc(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

// Forbidden patterns that indicate old-architecture drift has returned.
const FORBIDDEN = [
  {
    pattern: /RESPONSES_REASONING_MODE/,
    message: 'RESPONSES_REASONING_MODE was removed — /v1/responses is native passthrough, no chat-conversion knob',
  },
  {
    pattern: /ANTHROPIC_REASONING_REQUEST_MODE/,
    message: 'ANTHROPIC_REASONING_REQUEST_MODE is stale — remove from runtime knobs table',
  },
  {
    pattern: /responses\/messages conversions|converted OpenAI-chat outbound body/,
    message: 'Responses cross-protocol conversion language is stale — /v1/responses is native-only',
  },
  {
    pattern: /max_attempts.*\bphysical\b|max_attempts.*physical upstream/i,
    message: 'max_attempts is LOGICAL attempts, not physical upstream dispatches',
  },
];

// Protocol fact contract: current docs/examples must match protocol-fallbacks.ts.
// Only OpenAI Chat ↔ Anthropic Messages bidirectional fallback exists.
// OpenAI Responses is Native Only.
const PROTOCOL_FACT_FILES = [
  'README.md',
  'README_EN.md',
  'docs/architecture/protocol-model.md',
  'docs/operations/configuration.md',
  '.dev.vars.example',
  'config/worker-vars.example.json',
];
for (const file of PROTOCOL_FACT_FILES) {
  const text = readDoc(file);
  assert.doesNotMatch(text, /Responses\s*→\s*Anthropic|Responses\s*->\s*Anthropic/, `${file}: must not claim Responses → Anthropic cross-protocol conversion`);
  assert.doesNotMatch(text, /three-way|三向/, `${file}: must not claim three-way protocol fallback`);
  assert.doesNotMatch(text, /"openai:responses"\s*:\s*\["anthropic:messages"\]/, `${file}: must not include openai:responses → anthropic:messages in default fallback chain`);
  passed++;
  console.log(`ok - ${file} respects protocol fact contract`);
}

const explicitFallbackExamples = ['.dev.vars.example', 'config/worker-vars.example.json'];
for (const file of explicitFallbackExamples) {
  const text = readDoc(file);
  assert.match(text, /anthropic:messages[\s\S]{0,160}openai:chat_completions/, `${file}: must show Anthropic Messages → OpenAI Chat fallback`);
  assert.match(text, /openai:chat_completions[\s\S]{0,160}anthropic:messages/, `${file}: must show OpenAI Chat → Anthropic Messages fallback`);
  passed++;
  console.log(`ok - ${file} shows the bidirectional v1.3.0 fallback`);
}

// configuration.md must not list a wrong default chain.
const configDocText = readDoc('docs/operations/configuration.md');
assert.doesNotMatch(
  configDocText,
  /openai:responses.*anthropic:messages.*openai:chat_completions.*anthropic:messages.*openai:responses/,
  'configuration.md default chain must not include openai:responses → anthropic:messages',
);
passed++;
console.log('ok - configuration.md default chain matches SUPPORTED_CONVERSIONS');

// Access-key fact contract: current operator-facing material is group-first.
const ACCESS_FACT_FILES = [
  'README.md',
  'README_EN.md',
  'SECURITY.md',
  'docs/operations/configuration.md',
  'docs/operations/deployment.md',
  '.dev.vars.example',
  'config/access-keys.example.json',
];
for (const file of ACCESS_FACT_FILES) {
  const text = readDoc(file);
  assert.match(text, /GATEWAY_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT)/, `${file}: must document at least one current Group Key`);
  assert.match(text, /GATEWAY_ACCESS_MODELS_(?:AIR|PRO|MAX|ULTRA|AGENT)/, `${file}: must document the corresponding Group Models`);
  passed++;
  console.log(`ok - ${file} uses the current Gateway Access Group model`);
}

// Secret shards bind by Tier + node id. Suffixes are independent shard numbers.
const SHARD_FACT_FILES = [
  'README.md',
  'README_EN.md',
  'SECURITY.md',
  'docs/operations/configuration.md',
  'docs/operations/deployment.md',
  '.dev.vars.example',
];
for (const file of SHARD_FACT_FILES) {
  const text = readDoc(file);
  assert.doesNotMatch(text, /paired\s*1:1|paired\s+one-to-one|matching\s+(?:config\s+)?shard|matching\s+suffix|一一对应/i, `${file}: must not require Config/Secret shard suffix pairing`);
  passed++;
  console.log(`ok - ${file} does not require Config/Secret suffix pairing`);
}

for (const file of DOCS) {
  const text = readDoc(file);
  for (const { pattern, message } of FORBIDDEN) {
    const match = text.match(pattern);
    if (match) {
      assert.fail(`${file}: forbidden pattern "${match[0]}" — ${message}`);
    }
  }
  passed++;
  console.log(`ok - ${file} has no forbidden old-architecture patterns`);
}

// CONFIGURATION.md must NOT present GATEWAY_CONFIG / GATEWAY_SECRETS_CONFIG
// as the recommended production source (it is deprecated per deployment.md).
const configText = readDoc('docs/operations/configuration.md');
assert.ok(
  !/deliver.*through.*GATEWAY_CONFIG/i.test(configText) || /deprecated/i.test(configText),
  'CONFIGURATION.md must not present GATEWAY_CONFIG as the production path without marking it deprecated',
);
assert.ok(
  !/deliver.*through.*GATEWAY_SECRETS_CONFIG/i.test(configText) || /deprecated/i.test(configText),
  'CONFIGURATION.md must not present GATEWAY_SECRETS_CONFIG as the production path without marking it deprecated',
);
passed++;
console.log('ok - CONFIGURATION.md does not present legacy blob as production path');

// deploy.yml must inject every runtime tunable from runtime-vars.ts.
const deployYml = readDoc('.github/workflows/deploy.yml');
const { RUNTIME_VAR_NAMES } = await import('../src/config/runtime-vars.ts');
for (const name of RUNTIME_VAR_NAMES) {
  assert.ok(
    deployYml.includes(`${name}:`),
    `deploy.yml must inject ${name} as an env var`,
  );
}
passed++;
console.log(`ok - deploy.yml injects all ${RUNTIME_VAR_NAMES.length} runtime variables`);

// .dev.vars.example comments must match runtime-vars.ts defaults.
// This ensures the example config doesn't silently override defaults with stale values.
const devVarsExample = readDoc('.dev.vars.example');
const { RUNTIME_TUNABLES } = await import('../src/config/runtime-vars.ts');
for (const tunable of RUNTIME_TUNABLES) {
  const name = tunable.name;
  const expectedDefault = String(tunable.def);
  const commentPattern = new RegExp(`#\\s+${name}=.*#\\s+default:\\s+${expectedDefault}\\s*\\(`);
  const match = devVarsExample.match(commentPattern);
  if (!match) {
    const flexiblePattern = new RegExp(`${name}[^\\n]*#.*default:\\s*${expectedDefault}`);
    if (!flexiblePattern.test(devVarsExample)) {
      assert.fail(`.dev.vars.example: missing or mismatched default for ${name} (expected ${expectedDefault})`);
    }
  }
  passed++;
  console.log(`ok - .dev.vars.example default for ${name} matches runtime-vars.ts`);
}

// Architecture docs must not contradict runtime-vars.ts defaults.
// Specific drift-prone values: FAILOVER_BUDGET_MS, HEDGE_DELAY_MS.
const archDocDefaults = [
  { file: 'docs/architecture/routing-model.md', varName: 'FAILOVER_BUDGET_MS', def: RUNTIME_TUNABLES.find((t) => t.name === 'FAILOVER_BUDGET_MS').def },
  { file: 'docs/architecture/routing-model.md', varName: 'HEDGE_DELAY_MS', def: RUNTIME_TUNABLES.find((t) => t.name === 'HEDGE_DELAY_MS').def },
];
for (const { file, varName, def } of archDocDefaults) {
  const text = readDoc(file);
  const re = new RegExp(`${varName}[^\\n]*?\\u9ed8\\u8ba4\\s*(\\d+)\\s*s`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const seconds = parseInt(m[1], 10);
    const expectedSeconds = Math.round(def / 1000);
    assert.equal(
      seconds,
      expectedSeconds,
      `${file}: ${varName} default is ${seconds}s in docs but runtime-vars.ts says ${expectedSeconds}s (${def}ms)`,
    );
  }
  passed++;
  console.log(`ok - ${file} default for ${varName} matches runtime-vars.ts (${def}ms)`);
}

// routing-model.md must describe Tier 1 as Affinity → P2C, not LRU.
const routingText = readDoc('docs/architecture/routing-model.md');
assert.ok(
  /Tier 1[\s\S]{0,200}Affinity[\s\S]{0,200}P2C/.test(routingText),
  'routing-model.md must describe Tier 1 as Eligibility → Affinity → P2C (not LRU rotation)',
);
assert.doesNotMatch(
  routingText,
  /Same tier \+ same priority = LRU rotation/,
  'routing-model.md must not describe LRU rotation as the tier-1 selection algorithm',
);
passed++;
console.log('ok - routing-model.md describes Tier 1 as Affinity → P2C, not LRU');

console.log(`\ndocs contract tests passed (${passed}).`);
