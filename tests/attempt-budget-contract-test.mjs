#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Contract for reserve-aware request budgeting. The gateway should give the
// preferred candidate a realistic first-output window while preserving a
// bounded escape path for later failover candidates.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attemptBudgetSliceMs,
  attemptBudgetWindowMs,
  attemptFirstEventTimeoutMs,
  MIN_FAILOVER_RESERVE_MS,
} from '../src/config/timeouts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Keep the equal-share primitive stable for callers/tests that explicitly need
// it; the live dispatch path uses the reserve-aware allocator below.
assert.equal(attemptBudgetSliceMs(60_000, 5), 12_000);
assert.equal(attemptBudgetSliceMs(240_000, 5), 48_000);

// Default production-shaped request: 60s budget / 5 possible attempts.
// Old live behavior allowed only 12s. The new allocator reserves 5s for each
// later candidate and gives the preferred candidate the remaining 40s.
assert.equal(MIN_FAILOVER_RESERVE_MS, 5_000);
assert.equal(attemptBudgetWindowMs(60_000, 5), 40_000);

// long-reasoning shape: 60s request budget / 3 attempts -> 50s for the
// preferred candidate, retaining 5s escape windows for two alternates.
assert.equal(attemptBudgetWindowMs(60_000, 3), 50_000);

// Once only one candidate remains it may use the whole remaining request
// budget; unused time from earlier fast failures naturally carries forward.
assert.equal(attemptBudgetWindowMs(37_000, 1), 37_000);

// Tight budgets degrade to an equal split instead of starving the tail.
assert.equal(attemptBudgetWindowMs(10_000, 5), 2_000);
assert.equal(attemptBudgetWindowMs(15_000, 3), 5_000);
assert.equal(attemptBudgetWindowMs(0, 5), 1);

// Under the default 40s primary window, a healthy upstream returning headers
// in 5s still receives the full configured 30s first-event wait. This is the
// behavior the old 12s absolute slice prevented.
assert.equal(attemptFirstEventTimeoutMs(30_000, 35_000, 1), 30_000);

// If every candidate consumes its entire worst-case window, the reserve is
// still usable in sequence rather than being consumed by the first attempt.
let remaining = 60_000;
for (let attempts = 5; attempts > 1; attempts--) {
  const window = attemptBudgetWindowMs(remaining, attempts);
  remaining -= window;
}
assert.equal(remaining, 5_000, 'the last candidate must retain its escape window');

// Composition contract: real dispatch must use reserve-aware allocation; the
// equal-share helper must not accidentally return to the live path during a
// refactor. Hedge twins must continue inheriting the primary absolute deadline.
const dispatchSource = readFileSync(join(root, 'src/request/attempt/dispatch.ts'), 'utf8');
assert.match(dispatchSource, /attemptBudgetWindowMs\(remainingBudgetMs,\s*remainingDispatchableAttempts\)/,
  'dispatch must allocate reserve-aware attempt windows');
assert.doesNotMatch(dispatchSource, /attemptBudgetSliceMs\(remainingBudgetMs,\s*remainingDispatchableAttempts\)/,
  'dispatch must not regress to equal-share request slicing');

const hedgeSource = readFileSync(join(root, 'src/request/attempt/hedge.ts'), 'utf8');
assert.match(hedgeSource, /attemptDeadlineMs:\s*primaryArgs\.attemptDeadlineMs/,
  'hedge twin must share the primary logical-attempt deadline');

console.log('attempt budget contract tests passed.');
