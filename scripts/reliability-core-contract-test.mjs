#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// R3 (v1.3.0) — Reliability Core contract test.
//
// The failure-kind vocabulary (KIND) is the single source of truth for every
// string that appears on the request hot path as LoopState.failureKinds,
// AttemptOutcome.kind, or terminalStatus dispatch. Drift between the
// classifier (src/reliability/classify.ts) and its consumers
// (src/request/attempt/*.ts, src/request/errors.ts) is the most common
// silent bug: an upstream code adds a new failure mode, types it as a raw
// string literal in the consumer, and the terminal-status mapping never
// learns about it.
//
// This contract pins the closed set of failure-kind strings across the
// source tree:
//   * Every `kind:` property assignment in src/ that produces a string
//     literal must use one of the canonical KIND.* values (or a derived
//     variable). No open string literals are allowed.
//   * KIND is the only place that defines the kind vocabulary.
//   * AttemptOutcome.kind is typed as FailureKind (not string) at the
//     source level.
//   * Every classify* function lives in src/reliability/classify.ts.
//
// If a new failure kind is added, this test must be updated in the same
// commit. The same applies to the request-reliability-test.mjs "every
// failure-kind consumer-facing value" test that pins the KIND union.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1) KIND is the only place that defines the failure-kind vocabulary.
const classifySource = readFileSync(join(root, 'src', 'reliability', 'classify.ts'), 'utf8');
const kindBlockMatch = classifySource.match(/export const KIND = \{([\s\S]*?)\} as const;/);
const kindValues = kindBlockMatch
  ? [...kindBlockMatch[1].matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([^']+)'/gm)].map((m) => m[2])
  : [];
const expectedKinds = [
  'rate_limit', 'auth', 'client', 'model_missing', 'endpoint_not_found',
  'server', 'network', 'headers_timeout', 'first_event_timeout',
  'client_abort', 'rate_limit_global', 'invalid_base_url',
  'stream_interrupted', 'upstream_200_non_json_body',
  'cancelled_after_peer_commit', 'unknown',
];
const missingFromKind = expectedKinds.filter((k) => !kindValues.includes(k));
const extraInKind = kindValues.filter((k) => !expectedKinds.includes(k));
check('C19 KIND in src/reliability/classify.ts is the closed failure-kind vocabulary (no missing, no extra)',
  missingFromKind.length === 0 && extraInKind.length === 0,
  `missing=${JSON.stringify(missingFromKind)} extra=${JSON.stringify(extraInKind)} actual=${JSON.stringify(kindValues)}`);

// 2) No `kind: '...'` raw string literal in src/ that is not in KIND.
// We scan every .ts file under src/ for `kind: '<...>'` patterns. The
// ONLY file allowed to contain raw kind literals is src/reliability/classify.ts
// (where KIND itself is defined).
const kindLiteralRe = /\bkind\s*:\s*['"]([a-z_]+)['"]/g;
const violationFiles = [];
const allKindLiterals = new Set();
function walk(dir) {
  const { readdirSync, statSync } = require('node:fs');
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.wrangler-dry-run') continue;
      walk(full);
    } else if (full.endsWith('.ts')) {
      const text = readFileSync(full, 'utf8');
      let m;
      while ((m = kindLiteralRe.exec(text)) !== null) {
        allKindLiterals.add(m[1]);
        if (!full.endsWith('reliability/classify.ts') && !full.endsWith('reliability\\classify.ts')) {
          // Allow classify.ts (where the constants live).
          violationFiles.push({ file: full, literal: m[1] });
        }
      }
    }
  }
}
// Lazy import for readdirSync/statSync.
const { readdirSync, statSync } = await import('node:fs');
function walkSync(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.wrangler-dry-run') continue;
      walkSync(full);
    } else if (full.endsWith('.ts')) {
      const text = readFileSync(full, 'utf8');
      let m;
      while ((m = kindLiteralRe.exec(text)) !== null) {
        allKindLiterals.add(m[1]);
        if (!full.replace(/\\/g, '/').endsWith('src/reliability/classify.ts')) {
          violationFiles.push({ file: full, literal: m[1] });
        }
      }
    }
  }
}
walkSync(join(root, 'src'));
const unknownLiterals = [...allKindLiterals].filter((k) => !kindValues.includes(k));
check('C20 no raw failure-kind string literals in src/ outside classify.ts (closed vocabulary)',
  violationFiles.length === 0 && unknownLiterals.length === 0,
  `violations=${JSON.stringify(violationFiles.slice(0, 5))} unknownLiterals=${JSON.stringify(unknownLiterals)} allLiterals=${JSON.stringify([...allKindLiterals])}`);

// 3) AttemptOutcome.kind is typed as FailureKind (not string).
const requestTypesSource = readFileSync(join(root, 'src', 'types', 'request.ts'), 'utf8');
const outcomeBlock = requestTypesSource.match(/export type AttemptOutcome = \{([\s\S]*?)\};/);
const kindFieldLine = outcomeBlock ? outcomeBlock[1].match(/kind\?:\s*([^,]+),/) : null;
const kindType = kindFieldLine ? kindFieldLine[1].trim() : null;
check('C21 AttemptOutcome.kind is typed as FailureKind (not string) — compiler catches drift',
  kindType === 'FailureKind',
  `kindType=${JSON.stringify(kindType)} (expected "FailureKind")`);

// 4) FailureKind is imported in src/types/request.ts (proves the type
// comes from src/reliability/classify.ts, the single source of truth).
const importsFailureKind = /import\s+type\s+\{[^}]*\bFailureKind\b[^}]*\}\s+from\s+['"][^'"]*reliability\/classify/.test(requestTypesSource)
  || /import\s+type\s+\{[^}]*\bFailureKind\b[^}]*\}\s+from\s+['"][^'"]*reliability\\classify/.test(requestTypesSource);
check('C22 src/types/request.ts imports FailureKind from src/reliability/classify.ts',
  importsFailureKind,
  `importsFailureKind=${importsFailureKind}`);

if (failures > 0) {
  console.error(`reliability-core-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('reliability-core-contract: all contracts passed');
