// SPDX-License-Identifier: MIT
// @ts-check
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
  tier1ConcurrencyPressure,
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
    ...overrides,
  };
}

function releasePick(pick) {
  if (pick?.node && pick?.releaseToken) releaseTier1Slot(pick.node.id, pick.releaseToken);
}

async function test(name, fn) {
  try {
    __resetTier1StateForTests();
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

await test('cold accounts preserve soft affinity preference', () => {
  const a = node('a');
  const b = node('b');
  const pick = pickTier1Candidate([a, b], req, new Set(), {
    affinityAccountId: 'a', now, rng: () => 0,
  });
  assert.equal(pick?.node?.id, 'a');
  releasePick(pick);
});

await test('live in-flight work produces bounded pressure without static capacity', () => {
  const busy = node('busy');
  assert.equal(tier1ConcurrencyPressure(busy), 0);
  assert.equal(claimTier1Slot(busy, now, req.model), true);
  assert.equal(tier1ConcurrencyPressure(busy), 0.5);
  assert.equal(claimTier1Slot(busy, now, req.model), true);
  assert.ok(Math.abs(tier1ConcurrencyPressure(busy) - (2 / 3)) < 1e-9);
});

await test('live heat weakens affinity instead of creating a hard gate', () => {
  const a = node('a');
  claimTier1Slot(a, now, req.model);
  claimTier1Slot(a, now, req.model);
  claimTier1Slot(a, now, req.model);
  const factor = tier1AffinityHeatFactor(a, 0.85);
  assert.ok(factor > 0.85 && factor < 1);

  const only = pickTier1Candidate([a], req, new Set(), { now });
  assert.equal(only?.node?.id, 'a', 'a busy account remains usable for a primary request');
  releasePick(only);
});

await test('optional hedge avoids an account at 0.75 live pressure', () => {
  const primary = node('primary');
  const busy = node('busy');
  for (let i = 0; i < 3; i++) assert.equal(claimTier1Slot(busy, now, req.model), true);
  assert.equal(tier1ConcurrencyPressure(busy), 0.75);
  assert.equal(tier1CanAcceptHedge(busy), false);
  const pick = pickTier1Candidate([primary, busy], req, new Set(), {
    excludeId: 'primary', now, rng: () => 0,
  });
  assert.equal(pick, null);
});

await test('optional hedge may use a cool account', () => {
  const primary = node('primary');
  const cool = node('cool');
  assert.equal(tier1CanAcceptHedge(cool), true);
  const pick = pickTier1Candidate([primary, cool], req, new Set(), {
    excludeId: 'primary', now, rng: () => 0,
  });
  assert.equal(pick?.node?.id, 'cool');
  releasePick(pick);
});

await test('one or two independent 429 keys do not heat a provider-model cohort', () => {
  recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'nvidia-01', now);
  recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'nvidia-02', now + 1_000);
  assert.equal(tier1ProviderModelRateLimitCount('nvidia', 'upstream-code-max', now + 1_000), 2);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 1_000), 1);
});

await test('three and four independent 429 keys apply mild then strong soft heat', () => {
  for (const [index, id] of ['nvidia-01', 'nvidia-02', 'nvidia-03'].entries()) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now + index * 1_000);
  }
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 3_000), 1.15);
  recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'nvidia-04', now + 4_000);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 4_000), 1.35);
});

await test('provider-model heat changes ranking but never removes the last candidate', () => {
  for (const id of ['nvidia-01', 'nvidia-02', 'nvidia-03']) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
  }
  const hot = node('nvidia-04');
  const cool = node('sensenova-01', { provider: 'sensenova' });
  const pick = pickTier1Candidate([hot, cool], req, new Set(), { now, rng: () => 0 });
  assert.equal(pick?.node?.id, 'sensenova-01');
  releasePick(pick);

  const onlyHot = pickTier1Candidate([hot], req, new Set(), { now });
  assert.equal(onlyHot?.node?.id, 'nvidia-04');
  releasePick(onlyHot);
});

await test('success observations decay provider-model heat', () => {
  for (const id of ['nvidia-01', 'nvidia-02', 'nvidia-03', 'nvidia-04']) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
  }
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now), 1.35);
  recordTier1ProviderModelSuccess('nvidia', 'upstream-code-max', 'nvidia-05', now + 1_000);
  assert.equal(tier1ProviderModelRateLimitCount('nvidia', 'upstream-code-max', now + 1_000), 3);
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 1_000), 1.15);
});

await test('provider-model heat is isolated and expires', () => {
  for (const id of ['nvidia-01', 'nvidia-02', 'nvidia-03']) {
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
  }
  assert.equal(tier1ProviderModelHeatFactor('nvidia', 'other-model', now), 1);
  assert.equal(tier1ProviderModelHeatFactor('sensenova', 'upstream-code-max', now), 1);
  assert.equal(
    tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + TIER1_PROVIDER_MODEL_429_WINDOW_MS + 1),
    1,
  );
});
