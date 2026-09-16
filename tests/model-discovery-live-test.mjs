#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { providerWireProfile } from '../src/config/provider-profile.ts';
import {
  collectDiscoveryNodes,
  scanDiscoveryNode,
  diffModelSnapshots,
  formatDiscoveryMarkdown,
} from '../scripts/provider-discovery/index.js';

const GENERIC_SECRET = 'never-print-generic-key';
const OPENAI_SECRET = 'never-print-openai-key';
const ANTHROPIC_SECRET = 'never-print-anthropic-key';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

// Node Config stays account-level only. Discovery must derive protocol/surfaces
// from the same Provider Wire Profile used by runtime.
const env = {
  TIER1_NODES_CONFIG_01: JSON.stringify([
    {
      id: 'provider-a-01',
      provider: 'provider-a',
      base_url: 'https://provider.example.com/v1',
      models: { Pro: 'old-upstream-name' },
    },
    {
      id: 'openai-01',
      provider: 'openai',
      base_url: 'https://openai.example.com',
      models: { Pro: 'gpt-test' },
    },
    {
      id: 'anthropic-01',
      provider: 'anthropic',
      base_url: 'https://anthropic.example.com',
      models: { Pro: 'claude-test' },
    },
  ]),
  TIER1_NODES_SECRETS_01: JSON.stringify({
    'provider-a-01': GENERIC_SECRET,
    'openai-01': OPENAI_SECRET,
    'anthropic-01': ANTHROPIC_SECRET,
  }),
};

const nodes = collectDiscoveryNodes(env);
assert.equal(nodes.length, 3);
for (const node of nodes) {
  const profile = providerWireProfile(node.provider);
  assert.equal(node.protocol, profile.protocol);
  assert.deepEqual(node.configuredSurfaces, [...profile.surfaces]);
}
const genericNode = nodes.find((node) => node.id === 'provider-a-01');
const openaiNode = nodes.find((node) => node.id === 'openai-01');
const anthropicNode = nodes.find((node) => node.id === 'anthropic-01');
assert.deepEqual(genericNode.configuredSurfaces, ['chat_completions']);
assert.deepEqual(openaiNode.configuredSurfaces, ['chat_completions', 'responses']);
assert.equal(anthropicNode.protocol, 'anthropic');
assert.deepEqual(anthropicNode.configuredSurfaces, ['messages']);

// Discovery must accept the same narrow browser/IME punctuation repair as the
// deployment bridge.
const punctuationEnv = {
  TIER1_NODES_CONFIG_03: '[{"id":"cfworkers-02","provider":"cfworkers","base_url":"https://api.example.com/v1","models":{"Pro":"upstream"}、}]',
  TIER1_NODES_SECRETS_03: JSON.stringify({ 'cfworkers-02': GENERIC_SECRET }),
};
const punctuationNodes = collectDiscoveryNodes(punctuationEnv);
assert.equal(punctuationNodes.length, 1);
assert.equal(punctuationNodes[0].id, 'cfworkers-02');
assert.equal(punctuationNodes[0].protocol, 'openai');
assert.deepEqual(punctuationNodes[0].configuredSurfaces, ['chat_completions']);

const genericCalls = [];
const genericFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  genericCalls.push({ url: url.toString(), method: init.method, headers: init.headers });
  assert.equal(init.headers.authorization, `Bearer ${GENERIC_SECRET}`);
  if (init.method === 'GET' && url.pathname === '/v1/models') {
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.pathname === '/v1/chat/completions') return new Response('{"error":"missing model"}', { status: 400 });
  throw new Error(`unexpected generic-provider URL: ${url}`);
};

const currentNode = await scanDiscoveryNode(genericNode, { fetchImpl: genericFetch, lookupImpl: publicLookup });
assert.equal(currentNode.status, 'ok');
assert.deepEqual(currentNode.models, ['model-a', 'model-b']);
assert.equal(currentNode.capabilities.chat_completions.status, 'supported');
assert.equal(currentNode.capabilities.responses, undefined);
assert.ok(genericCalls.some((c) => new URL(c.url).pathname === '/v1/models'));
assert.ok(!JSON.stringify(currentNode).includes(GENERIC_SECRET), 'sanitized result must never include credential material');

// Native OpenAI owns both Chat Completions and Responses in the shared profile.
const openaiFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(init.headers.authorization, `Bearer ${OPENAI_SECRET}`);
  if (init.method === 'GET') {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), { status: 200 });
  }
  if (url.pathname === '/v1/chat/completions') return new Response('{}', { status: 400 });
  if (url.pathname === '/v1/responses') return new Response('', { status: 404 });
  throw new Error(`unexpected OpenAI URL: ${url}`);
};
const openaiResult = await scanDiscoveryNode(openaiNode, { fetchImpl: openaiFetch, lookupImpl: publicLookup });
assert.equal(openaiResult.status, 'ok');
assert.equal(openaiResult.capabilities.chat_completions.status, 'supported');
assert.equal(openaiResult.capabilities.responses.status, 'unsupported');

const previous = {
  schema_version: 1,
  generated_at: '2026-09-11T00:00:00.000Z',
  nodes: [{
    node_id: 'provider-a-01', provider: 'provider-a', status: 'ok',
    models: ['model-a', 'model-old'], capabilities: {},
  }],
};
const current = {
  schema_version: 1,
  generated_at: '2026-09-12T00:00:00.000Z',
  nodes: [currentNode],
};
const diff = diffModelSnapshots(previous, current);
assert.equal(diff.has_baseline, true);
assert.deepEqual(diff.changes[0].added, ['model-b']);
assert.deepEqual(diff.changes[0].removed, ['model-old']);
assert.deepEqual(diff.changes[0].unchanged, ['model-a']);
const md = formatDiscoveryMarkdown(previous, current, diff);
assert.match(md, /Added: 1; Removed: 1; Unchanged: 1/);
assert.match(md, /\+ model-b/);
assert.match(md, /- model-old/);

// A scan failure must never be presented as every previous model disappearing.
const failedCurrent = {
  schema_version: 1,
  generated_at: '2026-09-12T01:00:00.000Z',
  nodes: [{
    node_id: 'provider-a-01', provider: 'provider-a', status: 'scan_failed',
    models: [], capabilities: {}, error: 'HTTP 503',
  }],
};
const failedDiff = diffModelSnapshots(previous, failedCurrent);
assert.deepEqual(failedDiff.changes[0].removed, []);
assert.deepEqual(failedDiff.changes[0].unchanged, ['model-a', 'model-old']);

// Anthropic config contains no protocol/surfaces fields. Discovery still uses
// native x-api-key auth and probes /v1/messages because the provider profile
// is the single wire contract.
let anthropicMessagesProbe = false;
const anthropicFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(init.headers['x-api-key'], ANTHROPIC_SECRET);
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers.authorization, undefined);
  if (init.method === 'GET') {
    return new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 });
  }
  if (url.pathname === '/v1/messages') {
    anthropicMessagesProbe = true;
    return new Response('{}', { status: 422 });
  }
  throw new Error(`unexpected anthropic URL: ${url}`);
};
const anthropicResult = await scanDiscoveryNode(anthropicNode, { fetchImpl: anthropicFetch, lookupImpl: publicLookup });
assert.equal(anthropicResult.status, 'ok');
assert.deepEqual(anthropicResult.models, ['claude-test']);
assert.equal(anthropicResult.capabilities.messages.status, 'supported');
assert.equal(anthropicMessagesProbe, true);
assert.ok(!JSON.stringify(anthropicResult).includes(ANTHROPIC_SECRET));

console.log('live model discovery tests passed.');
