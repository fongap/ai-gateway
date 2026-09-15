#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Cross-layer regression contract for explicit Tier 1 admission ceilings.
// Unit tests for policy parsing and picker admission are not sufficient: every
// orchestration path that selects/counts Tier 1 capacity must propagate the
// same maxInFlight value. This suite locks the two composition points most
// likely to regress: hedge twins and cross-protocol fallback tier-cap planning.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __resetTier1StateForTests,
  claimTier1Slot,
  makeTier1ReleaseToken,
  releaseTier1Slot,
} from '../src/reliability/tier1-state.ts';
import { pickTier1Candidate } from '../src/scheduler/tier1-scheduler.ts';
import { computeTierCaps } from '../src/request/tier-loop.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function source(path) {
  return readFileSync(join(root, path), 'utf8');
}

function node(id, protocol, surface) {
  return {
    id,
    tier: 'tier-1',
    provider: 'mock',
    protocol,
    surfaces: [surface],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'test-key',
    priority: 100,
    models: { 'general-air': 'upstream-model' },
  };
}

// --- Composition contract: hedge twin must inherit the primary policy cap. ---
const hedgeSource = source('src/request/attempt/hedge.ts');
const hedgeCallStart = hedgeSource.indexOf('pickTier1Candidate(tierNodes');
assert.ok(hedgeCallStart >= 0, 'Tier 1 hedge picker call must exist');
const hedgeCall = hedgeSource.slice(hedgeCallStart, hedgeCallStart + 1_200);
assert.match(
  hedgeCall,
  /maxInFlight:\s*args\.policy\?\.maxInFlight\s*\?\?\s*null/,
  'Tier 1 hedge twin must propagate policy.maxInFlight to pickTier1Candidate',
);

// Prove why the propagated value matters: a saturated account is rejected when
// the explicit cap is present, but would be admitted again if the caller drops it.
__resetTier1StateForTests();
const hedgeNode = node('hedge-cap', 'openai', 'chat_completions');
const hedgeReq = { model: 'general-air', protocol: 'openai', surface: 'chat_completions' };
assert.equal(claimTier1Slot(hedgeNode, Date.now(), hedgeReq.model, 1), true);
const occupiedToken = makeTier1ReleaseToken(hedgeNode.id);
assert.equal(
  pickTier1Candidate([hedgeNode], hedgeReq, new Set(), { maxInFlight: 1 }),
  null,
  'a saturated Tier 1 account must not be selectable when the explicit cap is propagated',
);
const uncappedPick = pickTier1Candidate([hedgeNode], hedgeReq, new Set(), { maxInFlight: null });
assert.equal(uncappedPick?.node?.id, hedgeNode.id,
  'dropping maxInFlight would admit the saturated account and recreate the hedge bypass');
assert.equal(releaseTier1Slot(hedgeNode.id, uncappedPick?.releaseToken), true);
assert.equal(releaseTier1Slot(hedgeNode.id, occupiedToken), true);

// --- Composition contract: protocol fallback capacity planning must use cap. ---
const fallbackSource = source('src/request/fallback.ts');
const fallbackCallStart = fallbackSource.indexOf('const fbTierCaps = computeTierCaps(');
assert.ok(fallbackCallStart >= 0, 'protocol fallback tier-cap computation must exist');
const fallbackCall = fallbackSource.slice(fallbackCallStart, fallbackCallStart + 700);
assert.match(
  fallbackCall,
  /policy\.maxInFlight\s*\?\?\s*null/,
  'protocol fallback must propagate policy.maxInFlight into computeTierCaps',
);

__resetTier1StateForTests();
const fallbackNode = node('fallback-cap', 'anthropic', 'messages');
const fallbackReq = { model: 'general-air', protocol: 'anthropic', surface: 'messages' };
assert.equal(claimTier1Slot(fallbackNode, Date.now(), fallbackReq.model, 1), true);
const fallbackToken = makeTier1ReleaseToken(fallbackNode.id);
const tiers = { 1: [fallbackNode], 2: [], 3: [] };
const policy = { maxAttempts: 5, budgetSplit: 'even', tierAttempts: {} };
const knownModels = new Set(['general-air']);
const capped = computeTierCaps(tiers, fallbackReq, new Set(), policy, knownModels, 1);
const uncapped = computeTierCaps(tiers, fallbackReq, new Set(), policy, knownModels, null);
assert.equal(capped[1], 0,
  'fallback planning must assign zero Tier 1 attempts when every account is at the explicit cap');
assert.ok(uncapped[1] > 0,
  'without the cap, the same fallback pool appears dispatchable, proving the composition bug is observable');
assert.equal(releaseTier1Slot(fallbackNode.id, fallbackToken), true);

console.log('composed capacity contract tests passed.');
