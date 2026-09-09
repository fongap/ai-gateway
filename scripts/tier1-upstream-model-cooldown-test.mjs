#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import { classifyUpstreamStatus, KIND } from '../src/reliability/classify.ts';
import {
  applyTier1Outcome,
  classifyTier1Failure,
  getTier1ModelPerf,
  isTier1Eligible,
  tier1BlockingWaitMs,
  __resetTier1StateForTests,
} from '../src/reliability/tier1-state.ts';
import { recordOutcome } from '../src/request/attempt/outcome.ts';

const node = {
  id: 'nvidia-upstream-404',
  tier: 'tier-1',
  provider: 'nvidia',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  baseUrl: 'https://example.invalid/v1',
  credential: 'test-key',
  priority: 10,
  models: {
    'Code-Max': 'deepseek-ai/deepseek-v4-pro-0813',
    'Code-Pro': 'deepseek-ai/deepseek-v4-flash-0731',
  },
  limits: { concurrency: 5 },
};

const req = (model) => ({ model, protocol: 'openai', surface: 'chat_completions' });
const modelMissing = classifyUpstreamStatus(
  404,
  new Headers(),
  {},
  Date.now(),
  JSON.stringify({ error: { message: 'model deepseek-ai/deepseek-v4-pro-0813 not found' } }),
);

assert.equal(modelMissing.kind, KIND.MODEL_MISSING);
assert.equal(modelMissing.cooldownMs, 5_000);
assert.equal(modelMissing.modelScoped, true);

const tier1Class = classifyTier1Failure(modelMissing);
assert.equal(tier1Class.scope, 'upstream_model');
assert.equal(tier1Class.action, 'cooldown');
assert.equal(tier1Class.cooldownMs, 5_000);

// Direct state-machine contract: a 404 cools only this account + resolved
// upstream model. Sibling logical models stay eligible, and remapping the same
// logical alias to a new upstream model immediately escapes the stale 404.
__resetTier1StateForTests();
const now = 1_700_000_000_000;
applyTier1Outcome(node.id, node.models['Code-Max'], tier1Class, now);

assert.equal(isTier1Eligible(node, req('Code-Max'), now), false);
assert.equal(tier1BlockingWaitMs(node, 'Code-Max', now), 5_000);
assert.equal(isTier1Eligible(node, req('Code-Pro'), now), true);
assert.equal(getTier1ModelPerf(node.id, 'Code-Max'), null,
  'model_missing must not pollute logical-model performance/circuit state');

const remappedNode = {
  ...node,
  models: { ...node.models, 'Code-Max': 'another/provider-model' },
};
assert.equal(isTier1Eligible(remappedNode, req('Code-Max'), now), true,
  'new upstream mapping must not inherit the old upstream model cooldown');
assert.equal(isTier1Eligible(node, req('Code-Max'), now + 5_001), true,
  'the original upstream model becomes eligible after the short cooldown');

// Request-path regression: recordOutcome must resolve Code-Max through the
// selected node before it records model_missing state.
__resetTier1StateForTests();
const state = {
  attempted: new Set(),
  attempts: [],
  logicalAttempts: 0,
  dispatches: 0,
  hedges: 0,
  failureKinds: {},
  logger: { info() {}, debug() {}, error() {} },
  requestId: 'tier1-upstream-model-test',
  maxAttempts: 3,
  maxDispatches: 3,
  requestedModel: 'Code-Max',
  nodes: [node],
};
const context = {
  requestId: state.requestId,
  tier1ReleaseToken: null,
  upstreamProtocol: 'openai',
  surface: 'chat_completions',
  exposeUpstreamInfo: false,
};

recordOutcome(state, node, modelMissing, context, { status: 404 });
const afterRecord = Date.now();
assert.equal(state.logicalAttempts, 1);
assert.equal(state.dispatches, 1);
assert.equal(state.failureKinds[KIND.MODEL_MISSING], 1);
assert.equal(isTier1Eligible(node, req('Code-Max'), afterRecord), false);
assert.ok(tier1BlockingWaitMs(node, 'Code-Max', afterRecord) > 0);
assert.ok(tier1BlockingWaitMs(node, 'Code-Max', afterRecord) <= 5_000);
assert.equal(isTier1Eligible(remappedNode, req('Code-Max'), afterRecord), true);
assert.equal(isTier1Eligible(node, req('Code-Pro'), afterRecord), true);
assert.equal(getTier1ModelPerf(node.id, 'Code-Max'), null,
  'recordOutcome must keep logical Code-Max state untouched for model_missing');

console.log('tier1-upstream-model-cooldown: all tests passed');
