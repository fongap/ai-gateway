#!/usr/bin/env node
// Unit tests for isolate-local token usage observability: the
// reported-vs-missing normalization gate, dimension sanitization, aggregation
// + coverage, the transform-level onUsage contract (once per stream; client
// abort reports nothing), and the authenticated dashboard token panel
// (compaction formatting, Top-N ordering, zero-data state, public-page
// absence). Run directly; resetTokenStats keeps every test hermetic.
import assert from 'node:assert/strict';
import {
  normalizeTokenUsage, recordTokenUsage, summarizeTokenStats,
  tokenMetricSeries, __resetTokenStatsForTests,
} from '../src/observability/tokens.js';
import { dashboardResponse } from '../src/dashboard/pages.js';
import { metricsResponse } from '../src/observability/status.js';
import { transformOpenAIStreamToAnthropic } from '../src/stream/transform.js';
import { transformOpenAIStreamToResponses } from '../src/protocol/responses/stream.js';

let passed = 0;
async function test(name, fn) {
  try {
    __resetTokenStatsForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const ENV = { GATEWAY_ACCESS_KEY: 'test-access-key' };
const authedRequest = () => new Request('https://gateway.example.com/', {
  headers: { authorization: 'Bearer test-access-key', accept: 'text/html' },
});
const anonRequest = () => new Request('https://gateway.example.com/', {
  headers: { accept: 'text/html' },
});
const record = (usage, dims = {}) => recordTokenUsage({
  model: 'm', tier: 'tier-1', provider: 'p', nodeId: 'n', ...dims, usage,
});
const pageText = async (request) => (await dashboardResponse(request, ENV)).text();

// ---- normalizeTokenUsage: the single reported-vs-missing gate ---------------

await test('non-object usage normalizes to null (counted missing)', async () => {
  for (const bad of [null, undefined, 'x', 42, [], {}]) {
    assert.equal(normalizeTokenUsage(bad), null, String(bad));
  }
});

await test('numeric strings and invalid numbers are rejected, never coerced', async () => {
  assert.equal(normalizeTokenUsage({ prompt_tokens: '5' }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: '5', completion_tokens: 3 }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: -1 }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: Infinity }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: NaN }), null);
  // An unusable value on ONE side makes the whole report untrustworthy — no
  // half-true number survives. Same for a provided-but-invalid total.
  assert.equal(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: '9' }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: 2, total_tokens: -1 }), null);
  // A MISSING side is not an error — partial data beats nothing.
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2 }), { input: 2, output: 0, total: 2 });
});

await test('openai and anthropic/responses alias shapes both normalize', async () => {
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: 3 }), { input: 2, output: 3, total: 5 });
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 4, output_tokens: 6 }), { input: 4, output: 6, total: 10 });
  // One-sided reports are kept (partial data beats nothing).
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2 }), { input: 2, output: 0, total: 2 });
  // Fractional upstream values truncate.
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 1.9, completion_tokens: 2.1 }), { input: 1, output: 2, total: 3 });
});

await test('a reported total_tokens wins verbatim over input+output', async () => {
  assert.deepEqual(
    normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 10 }),
    { input: 2, output: 3, total: 10 },
  );
});

await test('recordTokenUsage: empty usage counts missing, real usage reports — never both', async () => {
  record({ prompt_tokens: 5, completion_tokens: 7 });
  record(null);
  record(undefined);
  record({});
  const t = summarizeTokenStats().totals;
  assert.equal(t.reports, 1);
  assert.equal(t.missing, 3);
  assert.equal(t.input, 5);
  assert.equal(t.output, 7);
  assert.equal(t.total, 12);
});

// ---- Dimension sanitization --------------------------------------------------

await test('hostile dimension values are sanitized at storage time', async () => {
  record({ prompt_tokens: 1, completion_tokens: 1 }, {
    model: 'a"b\\c\nd',
    provider: 'üri provider',
    nodeId: '',
    tier: 'tier-9',
  });
  const [row] = tokenMetricSeries();
  assert.equal(row.model, 'a_b_c_d');
  assert.equal(row.provider, '_ri_provider');
  assert.equal(row.nodeId, 'unknown');
  assert.equal(row.tier, 'tier-9');
});

await test('raw hostile dimensions never reach /metrics text', async () => {
  record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'a"b\\c\nd', provider: 'üri provider', nodeId: '' });
  const text = await (metricsResponse(new Request('https://gateway.example.com/metrics'), ENV)).text();
  assert.ok(text.includes('a_b_c_d'));
  assert.ok(!text.includes('a"b'), 'raw quote must not appear');
  assert.ok(!text.includes('üri provider'), 'raw provider must not appear');
});

// ---- Aggregation, coverage, Top-N ordering ----------------------------------

await test('summarizeTokenStats aggregates per dimension sorted by total desc', async () => {
  record({ prompt_tokens: 100, completion_tokens: 50 }, { model: 'small', provider: 'prov-a', nodeId: 'n1' });
  record({ prompt_tokens: 900, completion_tokens: 600 }, { model: 'big', provider: 'prov-b', nodeId: 'n2' });
  record({ prompt_tokens: 10, completion_tokens: 5 }, { model: 'tiny', provider: 'prov-a', nodeId: 'n1' });
  const s = summarizeTokenStats();
  assert.deepEqual(s.byModel.map((r) => r.name), ['big', 'small', 'tiny']);
  assert.deepEqual(s.byProvider.map((r) => r.name), ['prov-b', 'prov-a']);
  // n1 aggregates two records (150 + 15 = 165), n2 one (1500): total-desc puts
  // n2 first.
  assert.deepEqual(s.byNode.map((r) => r.name), ['n2', 'n1']);
  assert.equal(s.byModel[0].total, 1500);
  assert.equal(s.byProvider[1].total, 165);
});

await test('usage coverage is reports/(reports+missing), null at 0/0', async () => {
  assert.equal(summarizeTokenStats().usageCoverage, null);
  record({ prompt_tokens: 1, completion_tokens: 1 });
  record({ prompt_tokens: 1, completion_tokens: 1 });
  record({ prompt_tokens: 1, completion_tokens: 1 });
  record(null);
  const s = summarizeTokenStats();
  assert.equal(s.usageCoverage, 0.75);
  assert.equal(s.totals.reports, 3);
  assert.equal(s.totals.missing, 1);
});

await test('usage coverage is also aggregated per dimension row', async () => {
  record({ prompt_tokens: 3, completion_tokens: 0 }, { model: 'cov' });
  record(null, { model: 'cov' });
  record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'other' });
  const row = summarizeTokenStats().byModel.find((r) => r.name === 'cov');
  assert.equal(row.reports, 1);
  assert.equal(row.missing, 1);
});

await test('missing records land in their dimension bucket for accurate per-node coverage', async () => {
  record({ prompt_tokens: 5, completion_tokens: 5 }, { nodeId: 'a', model: 'm' });
  record(null, { nodeId: 'a', model: 'm' });
  record(null, { nodeId: 'b', model: 'm' });
  const s = summarizeTokenStats();
  assert.equal(s.totals.missing, 2);
  assert.equal(s.totals.reports, 1);
  // node 'a' has 1 report + 1 missing → 50% coverage; node 'b' is all missing.
  const a = s.byNode.find((r) => r.name === 'a');
  const b = s.byNode.find((r) => r.name === 'b');
  assert.equal(a.reports, 1);
  assert.equal(a.missing, 1);
  assert.equal(b.reports, 0);
  assert.equal(b.missing, 1);
  // A missing-only bucket still surfaces in /metrics as a labelled zero-input
  // series, so per-node usage_missing is queryable.
  const series = tokenMetricSeries();
  const bSeries = series.find((r) => r.nodeId === 'b');
  assert.equal(bSeries.missing, 1);
  assert.equal(bSeries.input, 0);
});

// ---- Dashboard token panel (authenticated) -----------------------------------

await test('empty data renders the panel with zeros, an em-dash coverage and no NaN', async () => {
  const html = await pageText(authedRequest());
  assert.ok(html.includes('Token 使用量'));
  assert.ok(html.includes('Isolate-local · Observability only · 非计费口径'));
  assert.ok(html.includes('>0<'), 'zero cards must render as 0');
  assert.ok(html.includes('—'), 'empty coverage must render as —');
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
  assert.ok(html.includes('暂无数据。'));
});

await test('the anonymous page contains no token panel at all', async () => {
  record({ prompt_tokens: 10, completion_tokens: 20 }, { model: 'secret-model', provider: 'secret-provider', nodeId: 'secret-node' });
  const html = await pageText(anonRequest());
  assert.ok(!html.includes('Token 使用量'));
  assert.ok(!html.includes('Isolate-local'));
  assert.ok(!html.includes('secret-model'));
  // The token CSS lives in a separate TOKEN_STYLES block injected only for
  // authenticated requests, so the public page carries no token markup —
  // not even a `.tcard` style rule.
  assert.ok(!html.includes('tcard'));
  assert.ok(!html.includes('tokens-block'));
});

await test('authenticated cards render the totals and coverage', async () => {
  record({ prompt_tokens: 3, completion_tokens: 1 });
  record({ prompt_tokens: 3, completion_tokens: 1 });
  record({ prompt_tokens: 3, completion_tokens: 1 });
  record(null);
  const html = await pageText(authedRequest());
  // Three reported responses of 4 tokens each → total 12; input 9, output 3.
  assert.ok(html.includes('>12<'), 'total tokens 3*(3+1) must render as 12');
  assert.ok(html.includes('>9<'), 'input tokens 3*3 must render as 9');
  assert.ok(html.includes('75.0%'), 'coverage 3/4 must render');
});

await test('K/M/B compaction renders through the dashboard tables', async () => {
  record({ prompt_tokens: 0, completion_tokens: 0 }, { model: 'k-zero' });
  record({ prompt_tokens: 999, completion_tokens: 0 }, { model: 'k-999' });
  record({ prompt_tokens: 1000, completion_tokens: 0 }, { model: 'k-1k' });
  record({ prompt_tokens: 1500, completion_tokens: 0 }, { model: 'k-15k' });
  record({ prompt_tokens: 1234567, completion_tokens: 0 }, { model: 'k-1m' });
  record({ prompt_tokens: 2500000000, completion_tokens: 0 }, { model: 'k-2b' });
  const html = await pageText(authedRequest());
  assert.ok(html.includes('>0<'));
  assert.ok(html.includes('>999<'));
  assert.ok(html.includes('>1.0K<'));
  assert.ok(html.includes('>1.5K<'));
  assert.ok(html.includes('>1.2M<'));
  assert.ok(html.includes('>2.5B<'));
  assert.ok(!html.includes('NaN'));
});

await test('By Node table is capped at Top 5 rows', async () => {
  for (let i = 1; i <= 7; i++) {
    record({ prompt_tokens: i, completion_tokens: 0 }, { nodeId: `node-${i}` });
  }
  const html = await pageText(authedRequest());
  for (let i = 7; i >= 3; i--) assert.ok(html.includes(`node-${i}`), `node-${i} must be in top 5`);
  assert.ok(!html.includes('node-2'), 'node-2 must be cut by the Top-5 cap');
  assert.ok(!html.includes('node-1<'), 'node-1 must be cut by the Top-5 cap');
});

await test('dashboard table Top-N follows the tokens-module sort, not insertion', async () => {
  record({ prompt_tokens: 100, completion_tokens: 50 }, { model: 'small' });
  record({ prompt_tokens: 900, completion_tokens: 600 }, { model: 'big' });
  const html = await pageText(authedRequest());
  assert.ok(html.indexOf('big') < html.indexOf('small'), 'largest total must render first');
  const s = summarizeTokenStats();
  assert.equal(s.byModel[0].name, 'big');
});

// ---- Transform-level onUsage contract ----------------------------------------

const encoder = new TextEncoder();
function sseUpstream(lines) {
  return new Response(new ReadableStream({
    pull(c) {
      for (const line of lines.splice(0)) c.enqueue(encoder.encode(line));
      c.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const chatChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const chatUsage = (usage) => `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
async function drain(response) {
  const reader = response.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

await test('anthropic transform: interrupted WITH usage reports it exactly once (Anthropic shape)', async () => {
  const calls = [];
  const upstream = sseUpstream([
    chatChunk('partial'),
    chatUsage({ prompt_tokens: 6, completion_tokens: 8 }),
    // clean EOF, no finish_reason, no [DONE] → failStream path
  ]);
  const res = transformOpenAIStreamToAnthropic(upstream, 'model-x', 'req-1', null, { onUsage: (u) => calls.push(u) });
  await drain(res);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input_tokens, 6);
  assert.equal(calls[0].output_tokens, 8);
});

await test('anthropic transform: client abort reports nothing', async () => {
  const calls = [];
  const ac = new AbortController();
  // Never-closing upstream: the transform parks in reader.read() until the
  // client side gives up (signal abort + body cancel, as the runtime does).
  const upstream = new Response(new ReadableStream({
    pull(c) { c.enqueue(encoder.encode(chatChunk('flowing'))); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const res = transformOpenAIStreamToAnthropic(upstream, 'model-x', 'req-1', ac.signal, { onUsage: (u) => calls.push(u) });
  const reader = res.body.getReader();
  await reader.read();
  ac.abort();
  await reader.cancel().catch(() => {});
  assert.equal(calls.length, 0);
});

await test('responses transform: interrupted WITH usage reports it exactly once (verbatim openai shape)', async () => {
  const calls = [];
  const upstream = sseUpstream([
    chatChunk('partial'),
    chatUsage({ prompt_tokens: 6, completion_tokens: 8 }),
  ]);
  const request = new Request('https://gateway.example.com/v1/responses', { method: 'POST', body: '{}' });
  const res = transformOpenAIStreamToResponses(upstream, 'model-x', request, 'req-1', null, { onUsage: (u) => calls.push(u) });
  await drain(res);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { prompt_tokens: 6, completion_tokens: 8 });
});

await test('responses transform: client abort reports nothing', async () => {
  const calls = [];
  const ac = new AbortController();
  const upstream = new Response(new ReadableStream({
    pull(c) { c.enqueue(encoder.encode(chatChunk('flowing'))); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const request = new Request('https://gateway.example.com/v1/responses', { method: 'POST', body: '{}' });
  const res = transformOpenAIStreamToResponses(upstream, 'model-x', request, 'req-1', ac.signal, { onUsage: (u) => calls.push(u) });
  const reader = res.body.getReader();
  await reader.read();
  ac.abort();
  await reader.cancel().catch(() => {});
  assert.equal(calls.length, 0);
});

await test('transforms without onUsage stay fully functional (observability optional)', async () => {
  const upstream = sseUpstream([
    chatChunk('hello'),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
  const res = transformOpenAIStreamToAnthropic(upstream, 'model-x', 'req-1', null);
  const text = await res.text();
  assert.ok(text.includes('message_stop'));
});

if (!process.exitCode) console.log(`\ntoken-stats tests passed (${passed}).`);
else process.exit(1);
