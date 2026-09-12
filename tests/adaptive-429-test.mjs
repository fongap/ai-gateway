#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import {
  ADAPTIVE_429_COOLDOWN_STEPS_MS,
  __resetAdaptive429StateForTests,
  clearAdaptive429State,
  nextAdaptive429CooldownMs,
  snapshotAdaptive429State,
} from '../src/reliability/adaptive-429.ts';

const base = 1_800_000_000_000;

function reset() {
  __resetAdaptive429StateForTests();
}

reset();
assert.deepEqual(
  [...ADAPTIVE_429_COOLDOWN_STEPS_MS],
  [15_000, 30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000],
  'adaptive 429 ladder must stay bounded at one hour',
);

assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, base), 15_000);
assert.equal(snapshotAdaptive429State('nvidia', 'key-01', base).stage, 1);

// Extra 429s from requests already in flight during the same cooldown must not
// escalate the stage. A burst of parallel 429s must never jump to one hour.
assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, base + 1_000), 14_000);
assert.equal(snapshotAdaptive429State('nvidia', 'key-01', base + 1_000).stage, 1);

// Only a 429 after the previous cooldown expired (the recovery request) moves
// to the next stage.
assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, base + 15_001), 30_000);
assert.equal(snapshotAdaptive429State('nvidia', 'key-01', base + 15_001).stage, 2);

let now = base + 15_001;
for (const expected of [60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000]) {
  const current = snapshotAdaptive429State('nvidia', 'key-01', now).cooldown_remaining_ms;
  now += current + 1;
  assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, now), expected);
}

// Binding is explicitly Provider + key-slot. Neither a sibling key nor the
// same key id under another Provider inherits the cooldown stage.
assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-02', 0, base), 15_000);
assert.equal(nextAdaptive429CooldownMs('sensenova', 'key-01', 0, base), 15_000);
assert.equal(snapshotAdaptive429State('nvidia', 'key-01', now).stage, 8);
assert.equal(snapshotAdaptive429State('nvidia', 'key-02', base).stage, 1);
assert.equal(snapshotAdaptive429State('sensenova', 'key-01', base).stage, 1);

// Retry-After is a minimum hint; it may extend the current cooldown but can
// never shorten the adaptive stage.
reset();
assert.equal(nextAdaptive429CooldownMs('provider-a', 'key-a', 45_000, base), 45_000);
assert.equal(nextAdaptive429CooldownMs('provider-a', 'key-a', 5_000, base + 1_000), 44_000);

// A real recovery success clears the Provider+key history. The next 429 starts
// from the short first stage again.
clearAdaptive429State('provider-a', 'key-a');
assert.equal(snapshotAdaptive429State('provider-a', 'key-a', base).stage, 0);
assert.equal(nextAdaptive429CooldownMs('provider-a', 'key-a', 0, base + 60_000), 15_000);

console.log('adaptive 429 tests passed.');
