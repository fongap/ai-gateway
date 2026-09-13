// SPDX-License-Identifier: MIT
// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterVisibleModels } from '../src/request/model-authz.ts';
import { buildModelFallbackPlan } from '../src/request/model-fallback.ts';
import { classifyUpstreamStatus, KIND } from '../src/reliability/classify.ts';
import { isOpenAIChatRealOutput } from '../src/transport/openai.ts';
import { attemptNode } from '../src/request/attempt.ts';
import { acquireSlot, getNodeState, __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { getLimits } from '../src/config/timeouts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

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

await test('family fallback is bounded by the current key callable-model set', () => {
  const known = new Set(['Air', 'Pro', 'Max', 'Ultra', 'SenseNova']);
  const airAuthz = {
    authorized: true,
    allowAll: false,
    allowlist: new Set(['Air', 'SenseNova']),
  };
  const callable = new Set(filterVisibleModels(known, airAuthz));
  const plan = buildModelFallbackPlan('Air', callable, 6);
  const planned = new Set(plan.flat().map((entry) => entry.model));
  assert.deepEqual([...planned], ['Air']);
  assert.equal(planned.has('Pro'), false);
  assert.equal(planned.has('Max'), false);
  assert.equal(planned.has('Ultra'), false);
});

await test('broader key scope still allows bounded sibling fallback', () => {
  const known = new Set(['Pro', 'Max', 'Ultra']);
  const authz = { authorized: true, allowAll: true };
  const callable = new Set(filterVisibleModels(known, authz));
  const firstRound = buildModelFallbackPlan('Pro', callable, 3)[0];
  assert.deepEqual(firstRound.map((entry) => entry.model), ['Pro', 'Max', 'Ultra']);
});

await test('model_missing remains node/upstream-model scoped and does not erase siblings', () => {
  const classification = classifyUpstreamStatus(
    404,
    new Headers(),
    {},
    Date.now(),
    'model Max not found',
  );
  assert.equal(classification.kind, KIND.MODEL_MISSING);
  assert.equal(classification.modelScoped, true);
  const plan = buildModelFallbackPlan('Max', new Set(['Max', 'Pro', 'Ultra']), 3);
  assert.deepEqual(plan[0].map((entry) => entry.model), ['Max', 'Pro', 'Ultra']);
});

await test('OpenAI Chat role-only and usage-only events do not commit the failover boundary', () => {
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { role: 'assistant' } }] }), false);
  assert.equal(isOpenAIChatRealOutput({ choices: [], usage: { completion_tokens: 0 } }), false);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { content: 'hello' } }] }), true);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { reasoning: 'step' } }] }), true);
  assert.equal(isOpenAIChatRealOutput({ choices: [{ delta: { tool_calls: [{ function: { name: 'run' } }] } }] }), true);
});

await test('handler wires family planning to callable models and has no family-wide model_missing stop', () => {
  const source = fs.readFileSync(path.join(root, 'src/request/handler.ts'), 'utf8');
  assert.match(source, /callableModels\s*=\s*new Set\(filterVisibleModels/);
  assert.match(source, /buildModelFallbackPlan\(\s*requestedModel,\s*callableModels,/s);
  assert.doesNotMatch(source, /model_missing[^\n]*break modelRoundsLoop/);
});

await test('all OpenAI Chat streaming tiers use the same meaningful-output predicate', () => {
  const source = fs.readFileSync(path.join(root, 'src/request/attempt/success.ts'), 'utf8');
  assert.match(source, /surface === 'chat_completions' \? isOpenAIChatRealOutput/);
  assert.doesNotMatch(source, /node\.tier === 'tier-1'[^\n]*isOpenAIChatRealOutput/);
});

await test('unexpected attempt exception releases a claimed Tier2 slot exactly once', async () => {
  __resetAllStateForTests();
  const node = {
    id: 'throw-node',
    tier: 'tier-2',
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: 'https://provider.example.com/v1',
    credential: 'secret',
    priority: 10,
    models: { Max: 'upstream-max' },
  };
  assert.equal(acquireSlot(node.id), true);
  assert.equal(getNodeState(node.id).activeRequests, 1);

  const circular = {};
  circular.self = circular;
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  const state = {
    attempted: new Set(),
    attempts: [],
    logicalAttempts: 0,
    dispatches: 0,
    hedges: 0,
    failureKinds: {},
    logger,
    requestId: 'req-throw',
    maxAttempts: 3,
    maxDispatches: 3,
    requestedModel: 'Max',
    nodes: [node],
  };
  const limits = getLimits({});
  const outcome = await attemptNode({
    request: new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST' }),
    env: {},
    ctx: {},
    logger,
    requestId: 'req-throw',
    route: 'openai_chat',
    node,
    requestedModel: 'Max',
    clientWantsStream: false,
    fakeStream: false,
    bodyJson: circular,
    limits,
    exposeUpstreamInfo: false,
    state,
    failoverBudgetMs: limits.failoverBudgetMs,
    requestStartMs: Date.now(),
    remainingDispatchableAttempts: 1,
    reqDescriptor: { model: 'Max', protocol: 'openai', surface: 'chat_completions' },
    policy: {
      maxAttempts: 3,
      tierAttempts: null,
      hedge: null,
      firstEventTimeoutMs: null,
      budgetSplit: null,
    },
    tierNumber: 2,
  });
  assert.equal(outcome.rotate, true);
  assert.equal(getNodeState(node.id).activeRequests, 0);
  assert.equal(state.logicalAttempts, 1);
  assert.equal(state.dispatches, 1);
});
