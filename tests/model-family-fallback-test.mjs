#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import {
  buildModelFallbackPlan,
  buildModelFallbackRounds,
  hasModelFamilyFallback,
  modelFallbackCandidates,
} from '../src/request/model-fallback.ts';

function catalog(...models) {
  return new Set(models);
}

const all = catalog(
  'Code-Ultra', 'Code-Max', 'Code-Pro',
  'Ultra', 'Max', 'Pro', 'Air',
);

assert.deepEqual(
  buildModelFallbackRounds('Code-Max', all),
  [
    ['Code-Max', 'Code-Pro', 'Code-Ultra'],
    ['Code-Max', 'Code-Pro', 'Code-Ultra'],
  ],
  'Code-Max must prefer Code-Pro, then Code-Ultra, with one bounded recheck round',
);

assert.deepEqual(
  buildModelFallbackPlan('Code-Max', all),
  [
    [
      { model: 'Code-Max', attemptCap: 3 },
      { model: 'Code-Pro', attemptCap: 2 },
      { model: 'Code-Ultra', attemptCap: 1 },
    ],
    [
      { model: 'Code-Max', attemptCap: 1 },
      { model: 'Code-Pro', attemptCap: 1 },
      { model: 'Code-Ultra', attemptCap: 1 },
    ],
  ],
  'default family planning keeps the established 3-2-1 preference',
);

assert.deepEqual(
  buildModelFallbackRounds('Code-Pro', all),
  [
    ['Code-Pro', 'Code-Max', 'Code-Ultra'],
    ['Code-Pro', 'Code-Max', 'Code-Ultra'],
  ],
  'Code-Pro must prefer Code-Max, then Code-Ultra',
);

assert.deepEqual(
  buildModelFallbackPlan('Code-Pro', all)[0],
  [
    { model: 'Code-Pro', attemptCap: 3 },
    { model: 'Code-Max', attemptCap: 2 },
    { model: 'Code-Ultra', attemptCap: 1 },
  ],
  'the requested Code peer always gets the 3-attempt share at budget 6',
);

assert.deepEqual(
  buildModelFallbackRounds('Code-Ultra', all),
  [
    ['Code-Ultra', 'Code-Max', 'Code-Pro'],
    ['Code-Ultra', 'Code-Max', 'Code-Pro'],
  ],
  'Code-Ultra must stay inside the Code family',
);

assert.deepEqual(
  buildModelFallbackRounds('Max', all),
  [
    ['Max', 'Pro', 'Ultra'],
    ['Max', 'Pro', 'Ultra'],
  ],
  'Max must prefer Pro, then Ultra, with one bounded recheck round',
);

assert.deepEqual(
  buildModelFallbackPlan('Max', all)[0],
  [
    { model: 'Max', attemptCap: 3 },
    { model: 'Pro', attemptCap: 2 },
    { model: 'Ultra', attemptCap: 1 },
  ],
  'Max family keeps 3-2-1 at budget 6',
);

assert.deepEqual(
  buildModelFallbackRounds('Pro', all),
  [
    ['Pro', 'Max', 'Ultra'],
    ['Pro', 'Max', 'Ultra'],
  ],
  'Pro must prefer Max, then Ultra',
);

assert.deepEqual(
  buildModelFallbackRounds('Ultra', all),
  [
    ['Ultra', 'Max', 'Pro'],
    ['Ultra', 'Max', 'Pro'],
  ],
  'Ultra may fall back to Max/Pro but never to Air',
);

assert.deepEqual(
  buildModelFallbackRounds('Air', all),
  [
    ['Air', 'Pro', 'Max', 'Ultra'],
    ['Pro', 'Max', 'Ultra'],
  ],
  'Air may move upward but must never be revisited after fallback',
);

assert.deepEqual(
  buildModelFallbackPlan('Air', all),
  [
    [
      { model: 'Air', attemptCap: 3 },
      { model: 'Pro', attemptCap: 1 },
      { model: 'Max', attemptCap: 1 },
      { model: 'Ultra', attemptCap: 1 },
    ],
    [
      { model: 'Pro', attemptCap: 1 },
      { model: 'Max', attemptCap: 1 },
      { model: 'Ultra', attemptCap: 1 },
    ],
  ],
  'Air keeps its one-way 3-1-1-1 preference at budget 6',
);

// max_attempts is a hard request ceiling. Family planning must never widen the
// candidate set beyond the number of logical attempts the policy allows.
assert.deepEqual(
  buildModelFallbackPlan('Code-Max', all, 1),
  [
    [{ model: 'Code-Max', attemptCap: 1 }],
    [{ model: 'Code-Max', attemptCap: 1 }],
  ],
  'budget 1 exposes only the requested model',
);

assert.deepEqual(
  buildModelFallbackPlan('Code-Max', all, 2)[0],
  [
    { model: 'Code-Max', attemptCap: 1 },
    { model: 'Code-Pro', attemptCap: 1 },
  ],
  'budget 2 widens to one sibling instead of inflating the request budget',
);

assert.deepEqual(
  buildModelFallbackPlan('Code-Max', all, 3)[0],
  [
    { model: 'Code-Max', attemptCap: 1 },
    { model: 'Code-Pro', attemptCap: 1 },
    { model: 'Code-Ultra', attemptCap: 1 },
  ],
  'budget 3 gives one attempt to each compatible model',
);

assert.deepEqual(
  buildModelFallbackPlan('Code-Max', all, 4)[0],
  [
    { model: 'Code-Max', attemptCap: 2 },
    { model: 'Code-Pro', attemptCap: 1 },
    { model: 'Code-Ultra', attemptCap: 1 },
  ],
  'budget 4 deepens the requested model after covering the family',
);

assert.deepEqual(
  buildModelFallbackPlan('Code-Max', all, 5)[0],
  [
    { model: 'Code-Max', attemptCap: 3 },
    { model: 'Code-Pro', attemptCap: 1 },
    { model: 'Code-Ultra', attemptCap: 1 },
  ],
  'budget 5 keeps the configured hard ceiling',
);

assert.deepEqual(
  buildModelFallbackPlan('Code-Max', all, 6)[0],
  [
    { model: 'Code-Max', attemptCap: 3 },
    { model: 'Code-Pro', attemptCap: 2 },
    { model: 'Code-Ultra', attemptCap: 1 },
  ],
  'budget 6 restores the full 3-2-1 preference',
);

assert.deepEqual(
  buildModelFallbackPlan('Air', all, 4)[0],
  [
    { model: 'Air', attemptCap: 1 },
    { model: 'Pro', attemptCap: 1 },
    { model: 'Max', attemptCap: 1 },
    { model: 'Ultra', attemptCap: 1 },
  ],
  'Air budget 4 covers its one-way family once before deepening Air',
);

assert.deepEqual(
  buildModelFallbackPlan('Air', all, 6)[0],
  [
    { model: 'Air', attemptCap: 3 },
    { model: 'Pro', attemptCap: 1 },
    { model: 'Max', attemptCap: 1 },
    { model: 'Ultra', attemptCap: 1 },
  ],
  'Air budget 6 keeps the established 3-1-1-1 preference',
);

assert.equal(hasModelFamilyFallback('Code-Max'), true);
assert.equal(hasModelFamilyFallback('Max'), true);
assert.equal(hasModelFamilyFallback('Custom-Model'), false);

assert.deepEqual(
  modelFallbackCandidates('Code-Max', all),
  ['Code-Max', 'Code-Pro', 'Code-Ultra'],
  'candidate list must never cross Code/non-Code families',
);

assert.deepEqual(
  modelFallbackCandidates('Max', all),
  ['Max', 'Pro', 'Ultra'],
  'general family candidate list must never include Air',
);

assert.deepEqual(
  buildModelFallbackRounds('Max', catalog('Max', 'Ultra')),
  [
    ['Max', 'Ultra'],
    ['Max', 'Ultra'],
  ],
  'missing peers must be skipped without inventing aliases',
);

assert.deepEqual(
  buildModelFallbackPlan('Max', catalog('Max', 'Ultra'))[0],
  [
    { model: 'Max', attemptCap: 3 },
    { model: 'Ultra', attemptCap: 1 },
  ],
  'missing peers keep their original rank and must not donate a larger reserved cap',
);

assert.deepEqual(
  buildModelFallbackRounds('CODE-MAX', catalog('CODE-MAX', 'Code-Pro', 'Code-Ultra')),
  [
    ['CODE-MAX', 'Code-Pro', 'Code-Ultra'],
    ['CODE-MAX', 'Code-Pro', 'Code-Ultra'],
  ],
  'matching must be case-insensitive while preserving catalog spelling',
);

assert.deepEqual(
  buildModelFallbackRounds('Custom-Model', catalog('Custom-Model', 'Max', 'Pro')),
  [['Custom-Model']],
  'unknown model families must keep legacy one-pass behavior',
);

assert.deepEqual(
  buildModelFallbackPlan('Custom-Model', catalog('Custom-Model', 'Max', 'Pro'), 1),
  [[{ model: 'Custom-Model', attemptCap: null }]],
  'unknown model families keep their original policy-owned attempt budget',
);

console.log('model-family fallback tests passed.');
