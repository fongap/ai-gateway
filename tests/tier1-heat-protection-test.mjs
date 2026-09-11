// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 heat-protection contract:
//   1. empty accounts preserve the existing affinity preference
//   2. RPM headroom pressure softly moves a request to a cooler peer
//   3. a hot affinity account loses its affinity advantage before hard block
//   4. soft heat never hard-blocks a primary when it is the only candidate
//   5. hedge selection requires spare RPM/concurrency capacity
//   6. provider-model 429 heat needs evidence from multiple independent keys

import assert from 'node:assert/strict';
import { pickTier1Candidate } from '../src/scheduler/tier1-scheduler.ts';
import {
  __resetTier1StateForTests,
  claimTier1Slot,
  makeTier1ReleaseToken,
  releaseTier1Slot,
  recordTier1ProviderModelRateLimit,
  recordTier1ProviderModelSuccess,
  tier1ProviderModelRateLimitCount,
  tier1ProviderModelHeatFactor,
  TIER1_PROVIDER_MODEL_429_WINDOW_MS,
} from '../src/reliability/tier1-state.ts';
import {
  tier1AffinityHeatFactor,
  tier1CanAcceptHedge,
  tier1RpmHeadroomFactor,
  tier1RpmHeadroomPressure,
} from '../src/reliability/tier1-heat.ts';

const now = 1_800_000_000_000;
const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };

function node(id, overrides = {}) {
  return {
    id,
    tier: 'tier-1',
    provider: 'nvidia',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: 'https://example.invalid/v1',
    credential: `secret-${id}`,
    priority: 1,
    models: { 'Code-Max': 'upstream-code-max' },
    limits: { concurrency: 4, rpm: 60, rpmMode: 'hard' },
    ...overrides,
  };
}

function warmOneRpmToken(n) {
  assert.equal(claimTier1Slot(n, now, req.model), true, 'preheat claim must succeed');
  const token = makeTier1ReleaseToken(n.id);
  assert.equal(releaseTier1Slot(n.id, token), true, 'preheat release must succeed');
}

function releasePick(pick) {
  if (pick?.node && pick?.releaseToken) {
    releaseTier1Slot(pick.node.id, pick.releaseToken);
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

await test('cold accounts preserve the existing affinity preference', () => {
  __resetTier1StateForTests();
  const a = node('a');
  const b = node('b');
  const pick = pickTier1Candidate([a, b], req, new Set(), {
    affinityAccountId: 'a', now, rng: () => 0,
  });
  assert.equal(pick?.node?.id, 'a');
  releasePick(pick);
});

await test('RPM headroom pressure softly favors the cooler peer', () => {
  __resetTier1StateForTests();
  const a = node('a');
  const b = node('b');
  warmOneRpmToken(a);

  assert.equal(tier1RpmHeadroomPressure(a, now), 1);
  assert.equal(tier1RpmHeadroomFactor(a, now), 1.2);
  assert.equal(tier1RpmHeadroomPressure(b, now), 0);

  const pick = pickTier1Candidate([a, b], req, new Set(), { now, rng: () => 0 });
  assert.equal(pick?.node?.id, 'b', 'cool peer should win equal-TTFT P2C');
  releasePick(pick);
});

await test('heat neutralizes affinity before the hard RPM gate', () => {
  __resetTier1StateForTests();
  const a = node('a');
  const b = node('b');
  warmOneRpmToken(a);

  assert.equal(tier1AffinityHeatFactor(a, 0.85, now), 1);
  const pick = pickTier1Candidate([a, b], req, new Set(), {
    affinityAccountId: 'a', now, rng: () => 0,
  });
  assert.equal(pick?.node?.id, 'b', 'hot affinity account must not keep a sticky advantage');
  releasePick(pick);
});

await test('soft heat never hard-blocks the only primary candidate', () => {
  __resetTier1StateForTests();
  const a = node('a');
  warmOneRpmToken(a);

  const pick = pickTier1Candidate([a], req, new Set(), { now });
  assert.equal(pick?.node?.id, 'a', 'primary must still use the last dispatchable token');
  releasePick(pick);
});

await test('hedge selection rejects a hot but still primary-eligible account', () => {
  __resetTier1StateForTests();
  const primary = node('primary');
  const hot = node('hot');
  warmOneRpmToken(hot);

  assert.equal(tier1CanAcceptHedge(hot, now), false);
  const pick = pickTier1Candidate([primary, hot], req, new Set(), {
    excludeId: 'primary', now, rng: () => 0,
  });
  assert.equal(pick, null, 'optional hedge must not spend the hot account final RPM headroom');
});

await test('hedge selection still uses a cool account with spare capacity', () => {
  __resetTier1StateForTests();
  const primary = node('primary');
  const cool = node('cool');

  assert.equal(tier1CanAcceptHedge(cool, now), true);
  const pick = pickTier1Candidate([primary, cool], req, new Set(), {
    excludeId: 'primary', now, rng: () => 0,
  });
  assert.equal(pick?.node?.id, 'cool');
  releasePick(pick);
});

await test('concurrency pressure also suppresses optional hedge work', () => {
  __resetTier1StateForTests();
  const busy = node('busy', { limits: { concurrency: 4, rpmMode: 'soft' } });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(claimTier1Slot(busy, now, req.model), true);
  }
  assert.equal(tier1CanAcceptHedge(busy, now), false, '3/4 in-flight should reserve capacity for primaries');
});

await test('one or two independent 429 keys do not demote a provider-model cohort', () => {
  __resetTier1StateForTests();
  recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'nvidia-01', now);
  recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'nvidia-01', now + 1_000);
  recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'nvidia-02', now + 2_000);

  assert.equal(tier1ProviderModelRateLimitCount('nvidia', 'upstream-code-max', now + 2_000), 2);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 2_000), 1);
});

await test('three and four independent 429 keys apply mild then strong soft heat', () => {
  __resetTier1StateForTests();
  for (const [index, id] of ['nvidia-01', 'nvidia-02', 'nvidia-03'].entries()) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now + index * 1_000);
  }
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 3_000), 1.15);

  recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'nvidia-04', now + 4_000);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 4_000), 1.35);
});

await test('provider-model heat changes ranking but never eligibility', () => {
  __resetTier1StateForTests();
  for (const id of ['nvidia-01', 'nvidia-02', 'nvidia-03']) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
  }

  const hot = node('nvidia-04');
  const cool = node('sensenova-01', { provider: 'sensenova' });
  const pick = pickTier1Candidate([hot, cool], req, new Set(), { now, rng: () => 0 });
  assert.equal(pick?.node?.id, 'sensenova-01', 'equal candidates should prefer the cooler provider-model cohort');
  releasePick(pick);

  const onlyHot = pickTier1Candidate([hot], req, new Set(), { now, rng: () => 0 });
  assert.equal(onlyHot?.node?.id, 'nvidia-04', 'soft cohort heat must not hard-block the last usable key');
  releasePick(onlyHot);
});

await test('real successes decay provider-model heat one observation at a time', () => {
  __resetTier1StateForTests();
  for (const id of ['nvidia-01', 'nvidia-02', 'nvidia-03', 'nvidia-04']) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
  }
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now), 1.35);

  recordTier1ProviderModelSuccess('nvidia', 'upstream-code-max', 'nvidia-05', now + 1_000);
  assert.equal(tier1ProviderModelRateLimitCount('nvidia', 'upstream-code-max', now + 1_000), 3);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 1_000), 1.15);

  recordTier1ProviderModelSuccess('nvidia', 'upstream-code-max', 'nvidia-03', now + 2_000);
  assert.equal(tier1ProviderModelRateLimitCount('nvidia', 'upstream-code-max', now + 2_000), 2);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 2_000), 1);
});

await test('provider-model heat is isolated by provider and upstream model', () => {
  __resetTier1StateForTests();
  for (const id of ['nvidia-01', 'nvidia-02', 'nvidia-03']) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
  }
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now), 1.15);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'other-model', now), 1);
  assert.equal(tier1ProviderModelHeatFactor('sensenova', 'upstream-code-max', now), 1);
});

await test('provider-model heat expires after the short evidence window', () => {
  __resetTier1StateForTests();
  for (const id of ['nvidia-01', 'nvidia-02', 'nvidia-03']) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
  }
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now), 1.15);
  assert.equal(
    tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + TIER1_PROVIDER_MODEL_429_WINDOW_MS + 1),
    1,
  );
});