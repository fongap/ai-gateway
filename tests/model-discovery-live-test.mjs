#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import {
  collectDiscoveryNodes,
  scanDiscoveryNode,
  diffModelSnapshots,
  formatDiscoveryMarkdown,
} from '../scripts/provider-discovery/index.js';

const SECRET = 'never-print-this-key';
const env = {
  TIER1_NODES_CONFIG_01: JSON.stringify([{
    id: 'provider-a-01',
    provider: 'provider-a',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    base_url: 'https://provider.example.com/v1',
    models: { Pro: 'old-upstream-name' },
  }]),
  TIER1_NODES_SECRETS_01: JSON.stringify({ 'provider-a-01': SECRET }),
};

const nodes = collectDiscoveryNodes(env);
assert.equal(nodes.length, 1);
assert.equal(nodes[0].id, 'provider-a-01');
assert.equal(nodes[0].protocol, 'openai');
assert.equal(nodes[0].credential, SECRET);

const calls = [];
const openaiFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  calls.push({ url: url.toString(), method: init.method, headers: init.headers });
  assert.equal(init.headers.authorization, `Bearer ${SECRET}`);
  if (init.method === 'GET' && url.pathname === '/v1/models') {
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.pathname === '/v1/chat/completions') return new Response('{"error":"missing model"}', { status: 400 });
  if (url.pathname === '/v1/responses') return new Response('', { status: 404 });
  throw new Error(`unexpected URL: ${url}`);
};

const currentNode = await scanDiscoveryNode(nodes[0], { fetchImpl: openaiFetch });
assert.equal(currentNode.status, 'ok');
assert.deepEqual(currentNode.models, ['model-a', 'model-b']);
assert.equal(currentNode.capabilities.chat_completions.status, 'supported');
assert.equal(currentNode.capabilities.responses.status, 'unsupported');
assert.ok(calls.some((c) => new URL(c.url).pathname === '/v1/models'));
assert.ok(!JSON.stringify(currentNode).includes(SECRET), 'sanitized result must never include credential material');

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

// Anthropic discovery uses native x-api-key auth and probes /v1/messages.
const anthropicNode = {
  id: 'anthropic-01', tier: 1, provider: 'anthropic-like', protocol: 'anthropic',
  baseUrl: 'https://anthropic.example.com', credential: 'anthropic-secret', configuredSurfaces: ['messages'],
};
let anthropicMessagesProbe = false;
const anthropicFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(init.headers['x-api-key'], 'anthropic-secret');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  if (init.method === 'GET') {
    return new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 });
  }
  if (url.pathname === '/v1/messages') {
    anthropicMessagesProbe = true;
    return new Response('{}', { status: 422 });
  }
  throw new Error(`unexpected anthropic URL: ${url}`);
};
const anthropicResult = await scanDiscoveryNode(anthropicNode, { fetchImpl: anthropicFetch });
assert.equal(anthropicResult.status, 'ok');
assert.deepEqual(anthropicResult.models, ['claude-test']);
assert.equal(anthropicResult.capabilities.messages.status, 'supported');
assert.equal(anthropicMessagesProbe, true);
assert.ok(!JSON.stringify(anthropicResult).includes('anthropic-secret'));

console.log('live model discovery tests passed.');
