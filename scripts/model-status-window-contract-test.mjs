#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Model Status Recent-Evidence Window Contract.
//
// Design fact: the Public Model Status "Recent Evidence" window is exactly
// MODEL_STATUS_RECENT_WINDOW_MS (24h), with ONE definition point next to the
// D1 query that parameterizes it. A previous drift had the dashboard call the
// evidence query with a hardcoded 7-day window, so design (24h) and behavior
// (7d) diverged. These contracts pin the single source and keep the magic
// numbers out of the evidence chain:
//
//   C01  The window constant is defined exactly once (token-usage-store
//        queries.js), exported through the store facade and re-exported by
//        src/runtime/model-status.js — same binding identity.
//   C02  queryRecentModelEvidence defaults to that constant.
//   C03  23h-old success IS recent evidence; 25h-old is NOT (default window).
//   C04  The dashboard evidence call site passes the constant, not a number.
//   C05  No second window literal (7d / 168h / 604800000) in the evidence
//        chain modules.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const HOUR = 3_600_000;
const now = () => 1_700_000_000_000;

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---- C01: one definition, consistent re-exports ------------------------------
const storeConstant = (await import('../src/observability/token-usage-store.mjs')).MODEL_STATUS_RECENT_WINDOW_MS;
const runtimeConstant = (await import('../src/runtime/model-status.js')).MODEL_STATUS_RECENT_WINDOW_MS;
check('C01 store and runtime expose the SAME 24h binding',
  storeConstant === runtimeConstant && runtimeConstant === 24 * HOUR,
  `store=${storeConstant} runtime=${runtimeConstant}`);

// ---- C02 + C03: default window is the constant; boundary behavior -------------
{
  const { queryRecentModelEvidence, persistTokenUsage } = await import('../src/observability/token-usage-store.mjs');
  const { createMockD1 } = await import('./mock-d1-database.mjs');

  const src = readFileSync(join(root, 'src/observability/token-usage-store/queries.js'), 'utf8');
  check('C02 queryRecentModelEvidence default window is the constant',
    /queryRecentModelEvidence\(env, windowMs = MODEL_STATUS_RECENT_WINDOW_MS/.test(src)
      && /export const MODEL_STATUS_RECENT_WINDOW_MS = 24 \* HOUR_MS;/.test(src));

  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const h23 = Math.floor((now() - 23 * HOUR) / HOUR) * HOUR; // in window
  const h25 = Math.floor((now() - 25 * HOUR) / HOUR) * HOUR; // out of window
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h23, 'in-23h');
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h25, 'out-25h');
  const evidence = await queryRecentModelEvidence(env, undefined, now());
  check('C03 23h-old success is evidence, 25h-old is not',
    evidence.has('in-23h') && !evidence.has('out-25h'),
    `evidence=${JSON.stringify([...evidence])}`);
}

// ---- C04 + C05: dashboard call site and magic-number ban ----------------------
{
  const usageView = readFileSync(join(root, 'src/dashboard/usage-view.js'), 'utf8');
  check('C04 dashboard evidence call passes MODEL_STATUS_RECENT_WINDOW_MS',
    /queryRecentModelEvidence\(env, MODEL_STATUS_RECENT_WINDOW_MS, now\)/.test(usageView));

  const banned = [
    /7 \* 24 \* 60 \* 60 \* 1000/,
    /604_?800_000/,
    /168 \* 60 \* 60 \* 1000/,
    /168 \* HOUR/,
    /7 \* 24 \* HOUR/,
  ];
  const chainFiles = [
    'src/dashboard/usage-view.js',
    'src/dashboard/pages.js',
    'src/dashboard/model-status-view.js',
    'src/runtime/model-status.js',
    'src/observability/token-usage-store/queries.js',
  ];
  let hit = '';
  for (const f of chainFiles) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const re of banned) {
      if (re.test(src)) hit += `${f}:${re} `;
    }
  }
  check('C05 no second Recent-Evidence window literal in the evidence chain', hit === '', hit);
  // The runtime module must re-export, not redefine.
  const runtimeSrc = readFileSync(join(root, 'src/runtime/model-status.js'), 'utf8');
  check('C05b runtime model-status re-exports the window constant',
    /export \{\s*\n?\s*MODEL_STATUS_RECENT_WINDOW_MS,\s*\} from '\.\.\/observability\/token-usage-store\.mjs'/.test(runtimeSrc)
      && !/MODEL_STATUS_RECENT_WINDOW_MS = 24 \* 3600_000/.test(runtimeSrc));
}

if (failures > 0) {
  console.error(`model-status-window-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('model-status-window-contract: all contracts passed');
