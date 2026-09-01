#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Docs contract test: blocks old-architecture semantics from re-entering docs.
// Scans README.md, README_EN.md, and docs/*.md (EXCLUDING CHANGELOG.md, whose
// historical entries legitimately mention removed features) for forbidden
// patterns that indicate the old cross-protocol-conversion / legacy-blob /
// physical-attempt-semantics architecture has crept back.
//
// Run as part of `npm run verify`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'README.md',
  'README_EN.md',
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
    message: 'cross-protocol conversion language — /v1/responses and /v1/messages are native passthrough, no conversion',
  },
  {
    pattern: /max_attempts.*\bphysical\b|max_attempts.*physical upstream/i,
    message: 'max_attempts is LOGICAL attempts, not physical upstream dispatches',
  },
];

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

// deploy.yml must inject every runtime tunable from runtime-vars.js.
const deployYml = readDoc('.github/workflows/deploy.yml');
const { RUNTIME_VAR_NAMES } = await import('../src/config/runtime-vars.js');
for (const name of RUNTIME_VAR_NAMES) {
  assert.ok(
    deployYml.includes(`${name}:`),
    `deploy.yml must inject ${name} as an env var`,
  );
}
passed++;
console.log(`ok - deploy.yml injects all ${RUNTIME_VAR_NAMES.length} runtime variables`);

  // .dev.vars.example comments must match runtime-vars.js defaults.
  // This ensures the example config doesn't silently override defaults with stale values.
  const devVarsExample = readDoc('.dev.vars.example');
  const { RUNTIME_TUNABLES } = await import('../src/config/runtime-vars.js');
  for (const tunable of RUNTIME_TUNABLES) {
    const name = tunable.name;
    const expectedDefault = String(tunable.def);
    // Check that the comment contains the expected default
    const commentPattern = new RegExp(`#\\s+${name}=.*#\\s+default:\\s+${expectedDefault}\\s*\\(`);
    const match = devVarsExample.match(commentPattern);
    if (!match) {
      // More flexible: look for the default value in a comment near the variable name
      const flexiblePattern = new RegExp(`${name}[^\\n]*#.*default:\\s*${expectedDefault}`);
      if (!flexiblePattern.test(devVarsExample)) {
        assert.fail(`.dev.vars.example: missing or mismatched default for ${name} (expected ${expectedDefault})`);
      }
    }
    passed++;
    console.log(`ok - .dev.vars.example default for ${name} matches runtime-vars.js`);
  }

  console.log(`\ndocs contract tests passed (${passed}).`);
