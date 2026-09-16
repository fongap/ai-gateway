#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Current protocol-routing matrix: Provider profiles own native surfaces,
// Chat/Messages conversion is explicit/bounded, Responses remains Native Only.
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

const ACCESS_KEY = 'test-access-key';
let passed = 0;
const calls = [];
let handlers = {};
async function test(name, fn) {
  try {
    __resetAllStateForTests(); __resetTier1StateForTests(); __resetTier1AffinityForTests();
    calls.length = 0; handlers = {}; await fn(); passed += 1; console.log(`ok - ${name}`);
  } catch (error) { console.error(`FAIL: ${name}`); console.error(error?.stack || error); process.exitCode = 1; }
}

globalThis.fetch = async (input, init) => {
  const source = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(source);
  const handler = handlers[url.hostname];
  if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  let bodyText = init?.body;
  if (bodyText === undefined && input instanceof Request) bodyText = await input.clone().text();
  const body = typeof bodyText === 'string' && bodyText ? JSON.parse(bodyText) : null;
  calls.push({ host: url.hostname, path: url.pathname, headers, body });
  return handler(url, init, body);
};

const chatNode = (id) => ({ id, provider: 'mock', base_url: `https://${id}.example.com/v1`, models: { max: 'up-model' } });
const openaiNode = (id) => ({ id, provider: 'openai', base_url: `https://${id}.example.com/v1`, models: { max: 'up-model' } });
const messagesNode = (id) => ({ id, provider: 'anthropic', base_url: `https://${id}.example.com`, models: { max: 'up-model' } });
function env(nodes, extra = {}) {
  return {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY, GATEWAY_ACCESS_MODELS_AIR: 'max',
    TIER1_NODES_CONFIG_01: JSON.stringify(nodes),
    TIER1_NODES_SECRETS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, `key-${n.id}`]))),
    TIER1_SCHEDULER_SEED: 'protocol-matrix', MODELS_CONFIG: JSON.stringify({ max: { policy: 'default' } }), ...extra,
  };
}

const auth = { authorization: `Bearer ${ACCESS_KEY}`, 'content-type': 'application/json' };
const chatRequest = (extra = {}) => new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'max', messages: [{ role: 'user', content: 'hi' }], ...extra }) });
const responsesRequest = (extra = {}) => new Request('https://gateway.example.com/v1/responses', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'max', input: 'hi', ...extra }) });
const messagesRequest = (extra = {}) => new Request('https://gateway.example.com/v1/messages', { method: 'POST', headers: { 'x-api-key': ACCESS_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra }) });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatOk = () => ({ id: 'chat-1', object: 'chat.completion', model: 'up-model', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const messageOk = () => ({ id: 'msg-1', type: 'message', role: 'assistant', model: 'up-model', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
const responsesOk = () => ({ id: 'resp-1', object: 'response', status: 'completed', model: 'up-model', output: [{ id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });

await test('Chat uses OpenAI-compatible providers and never Anthropic when conversion is disabled', async () => {
  handlers['chat.example.com'] = () => json(chatOk()); handlers['anth.example.com'] = () => json(messageOk());
  const res = await worker.fetch(chatRequest(), env([messagesNode('anth'), chatNode('chat')], { PROTOCOL_FALLBACKS: 'disable' }), {});
  assert.equal(res.status, 200); assert.deepEqual(calls.map((c) => c.host), ['chat.example.com']); assert.equal(calls[0].path, '/v1/chat/completions');
});

await test('Chat failover stays inside the same native surface', async () => {
  handlers['a.example.com'] = () => json({ error: 'down' }, 500); handlers['b.example.com'] = () => json(chatOk());
  const res = await worker.fetch(chatRequest(), env([chatNode('a'), chatNode('b')], { PROTOCOL_FALLBACKS: 'disable' }), {});
  assert.equal(res.status, 200); assert.deepEqual(calls.map((c) => c.host), ['a.example.com', 'b.example.com']); assert.ok(calls.every((c) => c.path === '/v1/chat/completions'));
});

await test('Responses uses only the OpenAI provider profile', async () => {
  handlers['chat.example.com'] = () => json(chatOk()); handlers['oa.example.com'] = () => json(responsesOk());
  const res = await worker.fetch(responsesRequest(), env([chatNode('chat'), openaiNode('oa')], { PROTOCOL_FALLBACKS: 'disable' }), {});
  assert.equal(res.status, 200); assert.deepEqual(calls.map((c) => c.host), ['oa.example.com']); assert.equal(calls[0].path, '/v1/responses');
});

await test('Responses remains Native Only and never converts to Messages', async () => {
  handlers['anth.example.com'] = () => json(messageOk());
  const res = await worker.fetch(responsesRequest(), env([messagesNode('anth')]), {});
  assert.notEqual(res.status, 200); assert.equal(calls.length, 0);
});

await test('Messages uses only Anthropic provider when conversion is disabled', async () => {
  handlers['chat.example.com'] = () => json(chatOk()); handlers['anth.example.com'] = () => json(messageOk());
  const res = await worker.fetch(messagesRequest(), env([chatNode('chat'), messagesNode('anth')], { PROTOCOL_FALLBACKS: 'disable' }), {});
  assert.equal(res.status, 200); assert.deepEqual(calls.map((c) => c.host), ['anth.example.com']); assert.equal(calls[0].path, '/v1/messages'); assert.equal(calls[0].headers.get('x-api-key'), 'key-anth');
});

await test('Chat falls back to Messages only through configured conversion', async () => {
  handlers['chat.example.com'] = () => json({ error: 'down' }, 500); handlers['anth.example.com'] = () => json(messageOk());
  const res = await worker.fetch(chatRequest(), env([chatNode('chat'), messagesNode('anth')], { PROTOCOL_FALLBACKS: JSON.stringify({ 'openai:chat_completions': ['anthropic:messages'], 'anthropic:messages': ['openai:chat_completions'] }) }), {});
  assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.choices[0].message.content, 'hello'); assert.deepEqual(calls.map((c) => c.path), ['/v1/chat/completions', '/v1/messages']);
});

await test('Messages falls back to Chat only through configured conversion', async () => {
  handlers['anth.example.com'] = () => json({ error: 'down' }, 500); handlers['chat.example.com'] = () => json(chatOk());
  const res = await worker.fetch(messagesRequest(), env([messagesNode('anth'), chatNode('chat')], { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'], 'openai:chat_completions': ['anthropic:messages'] }) }), {});
  assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.type, 'message'); assert.equal(body.content[0].text, 'hello'); assert.deepEqual(calls.map((c) => c.path), ['/v1/messages', '/v1/chat/completions']);
});

await test('disable turns off the built-in Chat/Messages fallback', async () => {
  handlers['anth.example.com'] = () => json(messageOk());
  const res = await worker.fetch(chatRequest(), env([messagesNode('anth')], { PROTOCOL_FALLBACKS: 'disable' }), {});
  assert.notEqual(res.status, 200); assert.equal(calls.length, 0);
});

await test('hedge twin stays inside the same provider wire profile', async () => {
  handlers['slow.example.com'] = (_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(json(chatOk())), 2_000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  handlers['fast.example.com'] = () => json(chatOk()); handlers['anth.example.com'] = () => json(messageOk());
  const res = await worker.fetch(chatRequest(), env([chatNode('slow'), chatNode('fast'), messagesNode('anth')], {
    PROTOCOL_FALLBACKS: 'disable', HEDGE_DELAY_MS: '50', FAILOVER_BUDGET_MS: '5000',
    POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 3, hedge: { enabled: true, delay_ms: 50, tiers: ['tier1'] } } }),
  }), {});
  assert.equal(res.status, 200); assert.deepEqual(calls.map((c) => c.host), ['slow.example.com', 'fast.example.com']); assert.ok(calls.every((c) => c.path === '/v1/chat/completions'));
});

await test('protocol or surfaces in Node JSON are rejected before dispatch', async () => {
  handlers['broken.example.com'] = () => json(chatOk());
  for (const extra of [{ protocol: 'openai' }, { surfaces: ['chat_completions'] }]) {
    calls.length = 0;
    const res = await worker.fetch(chatRequest(), env([{ ...chatNode('broken'), ...extra }], { PROTOCOL_FALLBACKS: 'disable' }), {});
    assert.notEqual(res.status, 200); assert.equal(calls.length, 0);
  }
});

await test('requested model identity is preserved in native client response', async () => {
  handlers['chat.example.com'] = () => json(chatOk());
  const res = await worker.fetch(chatRequest(), env([chatNode('chat')], { PROTOCOL_FALLBACKS: 'disable' }), {});
  assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.model, 'max'); assert.equal(calls[0].body.model, 'up-model');
});

if (process.exitCode) process.exit(1);
console.log(`\nprotocol-matrix tests passed (${passed}).`);
