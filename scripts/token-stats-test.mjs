#!/usr/bin/env node
// Unit tests for isolate-local token usage observability: the
// reported-vs-missing normalization gate, dimension sanitization, aggregation
// + coverage, the rolling 24h/7d time windows (sum + prune), the
// transform-level onUsage contract (once per stream; client abort reports
// nothing), and the public dashboard token panel (4 aggregate cards,
// compaction formatting, zero-data state, no internal-dimension leak). Run
// directly; resetTokenStats keeps every test hermetic.
import assert from 'node:assert/strict';
import {
  normalizeTokenUsage, recordTokenUsage, summarizeTokenStats,
  tokenMetricSeries, __resetTokenStatsForTests,
} from '../src/observability/tokens.js';
import { dashboardResponse } from '../src/dashboard/pages.js';
import { metricsResponse } from '../src/observability/status.js';
import { persistTokenUsage } from '../src/observability/token-store.js';
import { withUsageStreamOptions } from '../src/protocol/openai.js';
import { transformOpenAIStreamToAnthropic } from '../src/stream/transform.js';
import { transformOpenAIStreamToResponses } from '../src/protocol/responses/stream.js';
import { createMockD1 } from './d1-mock.mjs';

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
const pageText = async (request, env = ENV) => (await dashboardResponse(request, env)).text();
const deepClone = (o) => JSON.parse(JSON.stringify(o));

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

// ---- withUsageStreamOptions: streaming usage-hint injection is non-invasive ----

await test('withUsageStreamOptions adds include_usage while preserving existing stream_options', async () => {
  assert.deepEqual(
    withUsageStreamOptions({ model: 'm', stream: true, stream_options: { other: 'kept' } }),
    { model: 'm', stream: true, stream_options: { other: 'kept', include_usage: true } },
  );
  // A client-provided include_usage is never overwritten.
  assert.deepEqual(
    withUsageStreamOptions({ stream: true, stream_options: { include_usage: false } }),
    { stream: true, stream_options: { include_usage: false } },
  );
  // No existing stream_options -> a fresh object is added.
  assert.deepEqual(
    withUsageStreamOptions({ model: 'm', stream: true }),
    { model: 'm', stream: true, stream_options: { include_usage: true } },
  );
  // A non-object stream_options (primitive) is normalized without throwing.
  assert.deepEqual(
    withUsageStreamOptions({ stream: true, stream_options: 'bogus' }),
    { stream: true, stream_options: { include_usage: true } },
  );
});

// ---- recordTokenUsage: empty usage counts missing, real usage reports -----

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

// ---- 使用情况 section (D1-backed: 5-KPI strip + 52×7 activity heatmap) ------

const cellCount = (html) => (html.match(/class="hd /g) || []).length;
const monthLabels = (html) => [...html.matchAll(/<span style="grid-column:\d+">(\d{1,2})月<\/span>/g)].map((m) => m[1]);

function seededEnv(writes) {
  const d1 = createMockD1();
  const env = deepClone(ENV);
  env.TOKEN_STATS_DB = d1;
  const h0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  for (const [usage, offsetHours = 0] of writes) {
    persistTokenUsage(env, usage, h0 - offsetHours * 3_600_000);
  }
  return env;
}

await test('no D1 binding degrades to 统计暂不可用 with em dashes, never a fake 0', async () => {
  const html = await pageText(authedRequest(), ENV);
  assert.ok(html.includes('使用情况'), 'section title');
  assert.ok(html.includes('今日 Token'), 'five KPI labels');
  assert.ok(html.includes('累计 Token'));
  assert.ok(html.includes('近 24 小时'));
  assert.ok(html.includes('近 7 天'));
  assert.ok(html.includes('累计请求'));
  // Em dash = "cannot obtain this number right now", NOT a confirmed zero.
  assert.ok(html.includes('>—<'));
  assert.equal((html.match(/>—</g) || []).length, 5, 'all five KPIs degrade');
  assert.ok(!html.includes('>0<'), 'a degraded panel must not claim 0 usage');
  assert.ok(!html.includes('class="hd '), 'no fabricated heatmap cells');
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
  // The API-address block was removed; quick start stays.
  assert.ok(!html.includes('API 地址'));
  assert.ok(!html.includes('api-url'));
  assert.ok(html.includes('快速开始'));
  assert.ok(html.includes('data-tab="openai"'));
  assert.ok(html.includes('data-tab="claude"'));
  assert.ok(html.includes('data-tab="codex"'));
});

await test('a failing D1 query also degrades instead of 500 / fake zero', async () => {
  const env = deepClone(ENV);
  env.TOKEN_STATS_DB = createMockD1({ failReads: true });
  const res = await dashboardResponse(authedRequest(), env);
  assert.equal(res.status, 200, 'homepage must still be served');
  const html = await res.text();
  assert.ok(html.includes('统计暂不可用'));
  assert.ok(!html.includes('>0<'));
  assert.ok(!html.includes('class="hd '));
});

await test('the D1-backed card renders the five KPIs from real aggregates', async () => {
  const env = seededEnv([
    [{ prompt_tokens: 10, completion_tokens: 20 }], // 30 tokens, 1 request
    [{ prompt_tokens: 3, completion_tokens: 2 }],
    [null], // missing usage: request counted, tokens untouched
  ]);
  const html = await pageText(anonRequest(), env);
  assert.ok(html.includes('使用情况'));
  assert.ok(html.includes('>35<'), 'cumulative total (10+20)+(3+2) must render');
  assert.ok(html.includes('>3<'), 'three requests = 2 reports + 1 missing');
  assert.ok(html.includes('>35<'), 'today/24h/7d all cover the current hour');
  assert.ok(!html.includes('Usage 覆盖率'), 'coverage is not part of the new card');
});

await test('Token 活动 renders a full 52×7 = 364-cell heatmap with month labels', async () => {
  const env = seededEnv([[{ prompt_tokens: 7, completion_tokens: 7 }]]);
  const html = await pageText(anonRequest(), env);
  assert.ok(html.includes('Token 活动'));
  assert.ok(html.includes('近12个月'));
  assert.equal(cellCount(html), 364, 'exactly 52 weeks × 7 days of square cells');
  const labels = monthLabels(html);
  assert.ok(labels.length >= 11 && labels.length <= 13, `12 months covered (got ${labels.length})`);
  for (const label of labels) assert.match(label, /^\d{1,2}$/);
  // Levels: the active day is lv4 (it is the max), most days stay lv0.
  assert.ok(html.includes('class="hd lv4"'), 'active cells use the blue scale');
  assert.ok(html.includes('class="hd lv0"'), 'inactive cells use the light gray');
  assert.ok(html.includes(' Token · 1 请求'), 'hover title carries date, tokens and requests');
});

await test('the heatmap colors derive from daily totals, not per-hour noise', async () => {
  // Two days of activity: 4000 tokens vs 1000 tokens -> 4:1 ratio -> the big
  // day is lv4, the small day is lv1 (25% of max).
  const env = seededEnv([
    [{ prompt_tokens: 4000, completion_tokens: 0 }],
    [{ prompt_tokens: 1000, completion_tokens: 0 }, 24],
  ]);
  const html = await pageText(authedRequest(), env);
  assert.ok(html.includes('class="hd lv4"'));
  assert.ok(html.includes('class="hd lv1"'));
  assert.ok(html.includes('4,000 Token'), 'titles show the raw daily total');
});

await test('the usage card leaks no internal dimensions', async () => {
  record({ prompt_tokens: 10, completion_tokens: 20 }, {
    model: 'secret-model', provider: 'secret-provider', nodeId: 'secret-node', tier: 'secret-tier',
  });
  const env = seededEnv([[{ prompt_tokens: 1, completion_tokens: 1 }]]);
  const html = await pageText(anonRequest(), env);
  assert.ok(!html.includes('secret-node'));
  assert.ok(!html.includes('secret-provider'));
  assert.ok(!html.includes('secret-tier'));
  assert.ok(!html.includes('secret-model'));
});

await test('K/M/B compaction renders on the cumulative-token KPI', async () => {
  const card = async (usage) => pageText(authedRequest(), seededEnv([[usage]]));
  assert.ok((await card({ prompt_tokens: 0, completion_tokens: 0 })).includes('>0<'));
  assert.ok((await card({ prompt_tokens: 999, completion_tokens: 0 })).includes('>999<'));
  assert.ok((await card({ prompt_tokens: 1000, completion_tokens: 0 })).includes('>1.0K<'));
  assert.ok((await card({ prompt_tokens: 1500, completion_tokens: 0 })).includes('>1.5K<'));
  assert.ok((await card({ prompt_tokens: 1234567, completion_tokens: 0 })).includes('>1.2M<'));
  assert.ok((await card({ prompt_tokens: 2500000000, completion_tokens: 0 })).includes('>2.5B<'));
  const one = await card({ prompt_tokens: 1, completion_tokens: 0 });
  assert.ok(!one.includes('NaN'));
});

// ---- Rolling 24h / 7d time windows ------------------------------------------

await test('rolling 24h/7d windows sum recent totals and prune expired buckets', async () => {
  // Anchor to an hour boundary so hour/day alignment is deterministic.
  const h0 = Math.floor(Date.now() / 3600_000) * 3600_000;
  const HOUR = 3600_000, DAY = 86400_000;
  // Three reports, 100 tokens each, across three consecutive hours.
  record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 });
  record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 + HOUR });
  record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 + 2 * HOUR });
  let s = summarizeTokenStats();
  assert.equal(s.windows.h24.total, 300, '24h window sums the three reports');
  assert.equal(s.windows.d7.total, 300, '7d window sums the three reports');
  assert.equal(s.windows.h24.reports, 3);

  // Advance 27h: the three hourly buckets fall outside the 24-bucket window.
  record({ prompt_tokens: 10, completion_tokens: 0 }, { now: h0 + 27 * HOUR });
  s = summarizeTokenStats();
  assert.equal(s.windows.h24.total, 10, 'old hourly buckets pruned from 24h');
  assert.equal(s.windows.h24.reports, 1);
  assert.equal(s.windows.d7.total, 310, '27h is still inside the 7d window');

  // Advance 8 more days: the 7-bucket daily window prunes everything older.
  record({ prompt_tokens: 5, completion_tokens: 0 }, { now: h0 + 27 * HOUR + 8 * DAY });
  s = summarizeTokenStats();
  assert.equal(s.windows.d7.total, 5, 'old daily buckets pruned from 7d');
  assert.equal(s.windows.h24.total, 5);
  assert.equal(s.totals.total, 315, 'cumulative total is never pruned');
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
