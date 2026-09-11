#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Ordered unit/contract suite runner. Every executable test lives under tests/;
// repository tooling remains under scripts/.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const UNIT_TESTS = [
  'tests/node-config-shards-test.mjs',
  'tests/github-deployment-config-test.mjs',
  'tests/gateway-configuration-test.mjs',
  'tests/request-reliability-test.mjs',
  'tests/tier1-upstream-model-cooldown-test.mjs',
  'tests/tier1-heat-protection-test.mjs',
  'tests/stream-completion-test.mjs',
  'tests/token-usage-store-test.mjs',
  'tests/daily-token-overlay-test.mjs',
  'tests/token-usage-test.mjs',
  'tests/protocol-matrix-test.mjs',
  'tests/config-cli-test.mjs',
  'tests/docs-contract-test.mjs',
  'tests/provider-discovery-test.mjs',
  'tests/provider-discovery-ssrf-guard-test.mjs',
  'tests/model-status-test.mjs',
  'tests/model-status-window-contract-test.mjs',
  'tests/model-stats-canonicalization-test.mjs',
  'tests/ttft-query-contract-test.mjs',
  'tests/reliability-performance-test.mjs',
  'tests/conversion-test.mjs',
  'tests/conversion-result-test.mjs',
  'tests/claude-fallback-compatibility-test.mjs',
  'tests/fallback-conversion-observability-test.mjs',
  'tests/conversion-boundary-test.mjs',
  'tests/deployment-identity-test.mjs',
  'tests/config-matrix-test.mjs',
  'tests/access-keys-test.mjs',
  'tests/closed-catalog-test.mjs',
  'tests/tier1-affinity-bounding-test.mjs',
  'tests/reliability-fault-injection-test.mjs',
  'tests/key-rpm-test.mjs',
  'tests/calendar-heatmap-test.mjs',
  'tests/calendar-heatmap-view-test.mjs',
  'tests/calendar-heatmap-contract-test.mjs',
  'tests/migrations-check-test.mjs',
  'tests/version-check-test.mjs',
  'tests/architecture-contract-test.mjs',
  'tests/repository-layout-test.mjs',
  'tests/reliability-core-contract-test.mjs',
  'tests/deployment-workflow-contract-test.mjs',
  'tests/scheduler-racelost-test.mjs',
];

let failed = 0;
let passed = 0;

for (const rel of UNIT_TESTS) {
  const abs = join(root, rel);
  const result = spawnSync(process.execPath, [abs], { stdio: 'inherit', cwd: root });
  if (result.status === 0) {
    passed++;
  } else {
    failed++;
    console.error(`\n[runner] FAILED: ${rel} (exit ${result.status})\n`);
  }
}

console.log(`\n[test:unit] ${passed}/${UNIT_TESTS.length} suites passed` +
  (failed > 0 ? `, ${failed} FAILED` : ''));

if (failed > 0) process.exit(1);
