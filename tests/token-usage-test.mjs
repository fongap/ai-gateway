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
} from '../src/observability/token-usage.ts';
import { dashboardResponse, __resetDashboardCacheForTests } from '../src/dashboard/pages.ts';
import { metricsResponse } from '../src/observability/diagnostic-endpoints.ts';
import { persistTokenUsage } from '../src/observability/token-usage-store.ts';
import { withUsageStreamOptions } from '../src/protocol/openai.ts';
import { trackStreamResponse } from '../src/stream/track.ts';
import { createMockD1 } from './mock-d1-database.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    __resetTokenStatsForTests();
    __resetDashboardCacheForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const ENV = { GATEWAY_ACCESS_KEY_AIR: 'test-access-key', GATEWAY_ACCESS_MODELS_AIR: '*' };
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

await test('non-object usage normalizes to null (counted missing)', async () => {
  for (const bad of [null, undefined, 'x', 42, [], {}]) assert.equal(normalizeTokenUsage(bad), null, String(bad));
});

await test('numeric strings and invalid numbers are rejected, never coerced', async () => {
  assert.equal(normalizeTokenUsage({ prompt_tokens: '5' }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: '5', completion_tokens: 3 }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: -1 }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: Infinity }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: NaN }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: '9' }), null);
  assert.equal(normalizeTokenUsage({ prompt_tokens: 2, total_tokens: -1 }), null);
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2 }), { input: 2, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 2, total: 2 });
});

await test('openai and anthropic/responses alias shapes both normalize', async () => {
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: 3 }), { input: 2, output: 3, cacheCreation: 0, cacheRead: 0, effectiveInput: 2, total: 5 });
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 4, output_tokens: 6 }), { input: 4, output: 6, cacheCreation: 0, cacheRead: 0, effectiveInput: 4, total: 10 });
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2 }), { input: 2, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 2, total: 2 });
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 1.9, completion_tokens: 2.1 }), { input: 1, output: 2, cacheCreation: 0, cacheRead: 0, effectiveInput: 1, total: 3 });
});

await test('a reported total_tokens wins verbatim over input+output', async () => {
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 10 }), { input: 2, output: 3, cacheCreation: 0, cacheRead: 0, effectiveInput: 2, total: 10 });
});

await test('withUsageStreamOptions adds include_usage while preserving existing stream_options', async () => {
  assert.deepEqual(withUsageStreamOptions({ model: 'm', stream: true, stream_options: { other: 'kept' } }), { model: 'm', stream: true, stream_options: { other: 'kept', include_usage: true } });
  assert.deepEqual(withUsageStreamOptions({ stream: true, stream_options: { include_usage: false } }), { stream: true, stream_options: { include_usage: false } });
  assert.deepEqual(withUsageStreamOptions({ model: 'm', stream: true }), { model: 'm', stream: true, stream_options: { include_usage: true } });
  assert.deepEqual(withUsageStreamOptions({ stream: true, stream_options: 'bogus' }), { stream: true, stream_options: { include_usage: true } });
});

await test('recordTokenUsage: empty usage counts missing, real usage reports — never both', async () => {
  record({ prompt_tokens: 5, completion_tokens: 7 });
  record(null); record(undefined); record({});
  const t = summarizeTokenStats().totals;
  assert.equal(t.reports, 1); assert.equal(t.missing, 3); assert.equal(t.input, 5); assert.equal(t.output, 7); assert.equal(t.total, 12);
});

await test('hostile dimension values are sanitized at storage time', async () => {
  record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'a"b\\c\nd', provider: 'üri provider', nodeId: '', tier: 'tier-9' });
  const [row] = tokenMetricSeries();
  assert.equal(row.model, 'a_b_c_d'); assert.equal(row.provider, '_ri_provider'); assert.equal(row.nodeId, 'unknown'); assert.equal(row.tier, 'tier-9');
});

await test('raw hostile dimensions never reach /metrics text', async () => {
  record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'a"b\\c\nd', provider: 'üri provider', nodeId: '' });
  const text = await (metricsResponse(new Request('https://gateway.example.com/metrics'), ENV)).text();
  assert.ok(text.includes('a_b_c_d')); assert.ok(!text.includes('a"b')); assert.ok(!text.includes('üri provider'));
});

await test('summarizeTokenStats aggregates per dimension sorted by total desc', async () => {
  record({ prompt_tokens: 100, completion_tokens: 50 }, { model: 'small', provider: 'prov-a', nodeId: 'n1' });
  record({ prompt_tokens: 900, completion_tokens: 600 }, { model: 'big', provider: 'prov-b', nodeId: 'n2' });
  record({ prompt_tokens: 10, completion_tokens: 5 }, { model: 'tiny', provider: 'prov-a', nodeId: 'n1' });
  const s = summarizeTokenStats();
  assert.deepEqual(s.byModel.map((r) => r.name), ['big', 'small', 'tiny']);
  assert.deepEqual(s.byProvider.map((r) => r.name), ['prov-b', 'prov-a']);
  assert.deepEqual(s.byNode.map((r) => r.name), ['n2', 'n1']);
  assert.equal(s.byModel[0].total, 1500); assert.equal(s.byProvider[1].total, 165);
});

await test('usage coverage is reports/(reports+missing), null at 0/0', async () => {
  assert.equal(summarizeTokenStats().usageCoverage, null);
  record({ prompt_tokens: 1, completion_tokens: 1 }); record({ prompt_tokens: 1, completion_tokens: 1 }); record({ prompt_tokens: 1, completion_tokens: 1 }); record(null);
  const s = summarizeTokenStats();
  assert.equal(s.usageCoverage, 0.75); assert.equal(s.totals.reports, 3); assert.equal(s.totals.missing, 1);
});

await test('usage coverage is also aggregated per dimension row', async () => {
  record({ prompt_tokens: 3, completion_tokens: 0 }, { model: 'cov' }); record(null, { model: 'cov' }); record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'other' });
  const row = summarizeTokenStats().byModel.find((r) => r.name === 'cov');
  assert.equal(row.reports, 1); assert.equal(row.missing, 1);
});

await test('missing records land in their dimension bucket for accurate per-node coverage', async () => {
  record({ prompt_tokens: 5, completion_tokens: 5 }, { nodeId: 'a', model: 'm' }); record(null, { nodeId: 'a', model: 'm' }); record(null, { nodeId: 'b', model: 'm' });
  const s = summarizeTokenStats();
  assert.equal(s.totals.missing, 2); assert.equal(s.totals.reports, 1);
  const a = s.byNode.find((r) => r.name === 'a'); const b = s.byNode.find((r) => r.name === 'b');
  assert.equal(a.reports, 1); assert.equal(a.missing, 1); assert.equal(b.reports, 0); assert.equal(b.missing, 1);
  const series = tokenMetricSeries(); const bSeries = series.find((r) => r.nodeId === 'b');
  assert.equal(bSeries.missing, 1); assert.equal(bSeries.input, 0);
});

const cellCount = (html) => (html.match(/class="cell"/g) || []).length;
const monthLabels = (html) => [...html.matchAll(/<span style="grid-column:\d+">(\d{1,2})月<\/span>/g)].map((m) => m[1]);
function seededEnv(writes) {
  const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1;
  const h0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  for (const [usage, offsetHours = 0] of writes) persistTokenUsage(env, usage, h0 - offsetHours * 3_600_000);
  return env;
}

await test('no D1 binding degrades to 统计暂不可用 with em dashes, never a fake 0', async () => {
  const html = await pageText(authedRequest(), ENV);
  assert.ok(html.includes('使用情况')); assert.ok(!html.includes('class="utc8"')); assert.ok(html.includes('今日')); assert.ok(html.includes('累计')); assert.ok(html.includes('近 24 小时')); assert.ok(html.includes('7 天'));
  assert.ok(!html.includes('累计请求')); assert.ok(!html.includes('今日 Token')); assert.ok(!html.includes('累计 Token')); assert.ok(html.includes('>—<')); assert.equal((html.match(/>—</g) || []).length, 5); assert.ok(html.includes('model-usage-empty')); assert.ok(!html.includes('>0<')); assert.ok(!html.includes('class="cell"')); assert.ok(!html.includes('NaN')); assert.ok(!html.includes('undefined')); assert.ok(!html.includes('API 地址')); assert.ok(!html.includes('api-url')); assert.ok(html.includes('快速开始')); assert.ok(html.includes('data-tab="openai"')); assert.ok(html.includes('data-tab="anthropic"'));
});

await test('a failing D1 query also degrades instead of 500 / fake zero', async () => {
  const env = deepClone(ENV); env.TOKEN_STATS_DB = createMockD1({ failReads: true });
  const res = await dashboardResponse(authedRequest(), env); assert.equal(res.status, 200); const html = await res.text(); assert.ok(html.includes('统计暂不可用')); assert.ok(!html.includes('>0<')); assert.ok(!html.includes('class="cell"'));
});

await test('the D1-backed card renders the four KPIs from real aggregates', async () => {
  const env = seededEnv([[{ prompt_tokens: 10, completion_tokens: 20 }], [{ prompt_tokens: 3, completion_tokens: 2 }], [null]]);
  const html = await pageText(anonRequest(), env); assert.ok(html.includes('使用情况')); assert.ok(html.includes('>35<')); assert.ok(!html.includes('class="utc8"')); assert.ok(!html.includes('累计请求')); assert.ok(!html.includes('Usage 覆盖率'));
});

await test('模型使用 renders one row per model with bars plus a donut ring', async () => {
  const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const HOUR = 3_600_000; const h0 = Math.floor(Date.now() / HOUR) * HOUR;
  await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'code-max'); await persistTokenUsage(env, { prompt_tokens: 40, completion_tokens: 10 }, h0, 'ultra');
  const html = await pageText(anonRequest(), env);
  assert.ok(html.includes('模型使用')); assert.ok(html.includes('bars')); assert.ok(html.includes('bar-row')); assert.ok(html.includes('code-max')); assert.ok(html.includes('ultra')); assert.ok(html.includes('bar-track')); assert.ok(html.includes('data-tooltip=')); assert.ok(html.includes('bar-value')); assert.ok(html.includes('class="donut"')); assert.ok(html.includes('donut-center')); assert.ok(html.includes('role="img"'));
  assert.match(html, /<div class="usage-split">[\s\S]*?<div class="bars">/); assert.ok(html.includes('<strong>150</strong>')); assert.ok(html.includes('code-max\n100 Token')); assert.ok(html.includes('ultra\n50 Token')); assert.match(html, /<div class="bar-value">100<\/div>/); assert.match(html, /<div class="bar-value">50<\/div>/);
});

await test('模型使用 shows official logical IDs, not lowercase statistics keys', async () => {
  __resetDashboardCacheForTests(); const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1;
  env.TIER1_NODES_CONFIG_01 = JSON.stringify([{ id: 'node-a', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://a.example.com/v1', models: { 'Code-Max': 'up-max', 'Code-Ultra': 'up-ultra' }, limits: { concurrency: 1 } }]);
  env.TIER1_NODES_SECRETS_01 = JSON.stringify({ 'node-a': 'test-key' });
  const HOUR = 3_600_000; const h0 = Math.floor(Date.now() / HOUR) * HOUR;
  await persistTokenUsage(env, { prompt_tokens: 900, completion_tokens: 0 }, h0, 'code-max'); await persistTokenUsage(env, { prompt_tokens: 300, completion_tokens: 0 }, h0, 'CODE-ULTRA');
  const html = await pageText(anonRequest(), env); assert.ok(html.includes('>Code-Max<')); assert.ok(html.includes('>Code-Ultra<')); assert.ok(!html.includes('>code-max<')); assert.ok(!html.includes('>code-ultra<')); assert.ok(html.includes('Code-Max\n900 Token'));
});

await test('模型使用 folds models beyond the top 4 into one 其他 row', async () => {
  const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const HOUR = 3_600_000; const h0 = Math.floor(Date.now() / HOUR) * HOUR;
  const models = [['m1', 600], ['m2', 500], ['m3', 400], ['m4', 300], ['m5', 30], ['m6', 20]];
  for (const [model, tokens] of models) await persistTokenUsage(env, { prompt_tokens: tokens, completion_tokens: 0 }, h0, model);
  const html = await pageText(anonRequest(), env); for (const model of ['m1', 'm2', 'm3', 'm4']) assert.ok(html.includes(model)); for (const model of ['m5', 'm6']) assert.ok(!html.includes(`>${model}<`)); assert.ok(html.includes('其他')); assert.ok(html.includes('<strong>1850</strong>')); assert.match(html, /<div class="bar-value">50<\/div>/);
});

await test('Token 活动 · 近 52 周 renders a full 364-cell heatmap with month labels', async () => {
  const env = seededEnv([[{ prompt_tokens: 7, completion_tokens: 7 }]]); const html = await pageText(anonRequest(), env);
  assert.ok(html.includes('Token 活动 · 近 52 周')); assert.ok(html.includes('次请求')); assert.equal(cellCount(html), 364); const labels = monthLabels(html); assert.ok(labels.length >= 11 && labels.length <= 13); for (const label of labels) assert.match(label, /^\d{1,2}$/); assert.ok(html.includes('data-level="4"')); assert.ok(html.includes('data-level="0"')); assert.ok(html.includes('data-tooltip="')); assert.ok(html.includes('· 1 次请求')); assert.match(html, /class="heatmap-wrap" tabindex="0" role="img"/); assert.match(html, /aria-label="近 52 周 Token 活动热力图/);
});

await test('the heatmap colors derive from daily totals, not per-hour noise', async () => {
  const env = seededEnv([[{ prompt_tokens: 4000, completion_tokens: 0 }], [{ prompt_tokens: 1000, completion_tokens: 0 }, 24]]); const html = await pageText(authedRequest(), env); assert.ok(html.includes('data-level="4"')); assert.ok(html.includes('data-level="1"')); assert.ok(html.includes('4000') && html.includes('Token')); assert.ok(!html.includes('4,000 Token'));
});

await test('the usage card leaks no internal dimensions', async () => {
  record({ prompt_tokens: 10, completion_tokens: 20 }, { model: 'secret-model', provider: 'secret-provider', nodeId: 'secret-node', tier: 'secret-tier' }); const env = seededEnv([[{ prompt_tokens: 1, completion_tokens: 1 }]]); const html = await pageText(anonRequest(), env); assert.ok(!html.includes('secret-node')); assert.ok(!html.includes('secret-provider')); assert.ok(!html.includes('secret-tier')); assert.ok(!html.includes('secret-model'));
});

await test('Chinese unit (万/亿) compaction renders on KPI values, never K/M/B', async () => {
  const card = async (usage) => pageText(authedRequest(), seededEnv([[usage]]));
  assert.ok((await card({ prompt_tokens: 0, completion_tokens: 0 })).includes('>0<')); assert.ok((await card({ prompt_tokens: 999, completion_tokens: 0 })).includes('>999<')); assert.ok((await card({ prompt_tokens: 9820, completion_tokens: 0 })).includes('>9820<')); assert.ok((await card({ prompt_tokens: 10000, completion_tokens: 0 })).includes('>1万<')); assert.ok((await card({ prompt_tokens: 128000, completion_tokens: 0 })).includes('>12.8万<')); assert.ok((await card({ prompt_tokens: 1280000, completion_tokens: 0 })).includes('>128万<')); assert.ok((await card({ prompt_tokens: 48600000, completion_tokens: 0 })).includes('>4860万<')); assert.ok((await card({ prompt_tokens: 128000000, completion_tokens: 0 })).includes('>1.28亿<')); assert.ok((await card({ prompt_tokens: 2500000000, completion_tokens: 0 })).includes('>25亿<')); const one = await card({ prompt_tokens: 1, completion_tokens: 0 }); assert.ok(!one.includes('NaN')); const cardHtml = await card({ prompt_tokens: 1234567, completion_tokens: 0 }); assert.ok(!cardHtml.includes('K<') && !cardHtml.includes('M<') && !cardHtml.includes('B<'));
});

await test('rolling 24h/7d windows sum recent totals and prune expired buckets', async () => {
  const h0 = Math.floor(Date.now() / 3600_000) * 3600_000; const HOUR = 3600_000, DAY = 86400_000;
  record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 }); record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 + HOUR }); record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 + 2 * HOUR }); let s = summarizeTokenStats(); assert.equal(s.windows.h24.total, 300); assert.equal(s.windows.d7.total, 300); assert.equal(s.windows.h24.reports, 3); record({ prompt_tokens: 10, completion_tokens: 0 }, { now: h0 + 27 * HOUR }); s = summarizeTokenStats(); assert.equal(s.windows.h24.total, 10); assert.equal(s.windows.h24.reports, 1); assert.equal(s.windows.d7.total, 310); record({ prompt_tokens: 5, completion_tokens: 0 }, { now: h0 + 27 * HOUR + 8 * DAY }); s = summarizeTokenStats(); assert.equal(s.windows.d7.total, 5); assert.equal(s.windows.h24.total, 5); assert.equal(s.totals.total, 315);
});

const encoder = new TextEncoder();
function sseUpstream(lines) { return new Response(new ReadableStream({ pull(c) { for (const line of lines.splice(0)) c.enqueue(encoder.encode(line)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); }
const chatChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const chatUsage = (usage) => `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
async function drain(response) { const reader = response.body.getReader(); for (;;) { const { done } = await reader.read(); if (done) return; } }
const noopTrack = { idleTimeoutMs: 0, onSuccess: () => {}, onFailure: () => {}, onNeutral: () => {} };
const anthropicTextDelta = (text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
const anthropicUsage = (input, output) => `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: input, output_tokens: output } })}\n\n`;
const anthropicStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const responsesTextDelta = (text) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text })}\n\n`;
const responsesCompleted = (usage) => `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', object: 'response', status: 'completed', model: 'up-model', output: [], usage } })}\n\n`;

await test('anthropic passthrough: interrupted WITH usage reports it exactly once (Anthropic shape)', async () => {
  const calls = []; const upstream = sseUpstream([anthropicTextDelta('partial'), anthropicUsage(6, 8)]); const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*message_stop\b/, onUsage: (u) => calls.push(u) }); await drain(res); assert.equal(calls.length, 1); assert.equal(calls[0].input_tokens, 6); assert.equal(calls[0].output_tokens, 8);
});
await test('anthropic passthrough: client abort reports nothing', async () => {
  const calls = []; const ac = new AbortController(); const upstream = new Response(new ReadableStream({ pull(c) { c.enqueue(encoder.encode(anthropicTextDelta('flowing'))); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*message_stop\b/, onUsage: (u) => calls.push(u) }); const reader = res.body.getReader(); await reader.read(); ac.abort(); await reader.cancel().catch(() => {}); assert.equal(calls.length, 0);
});
await test('responses passthrough: completed stream reports usage exactly once (verbatim native shape)', async () => {
  const calls = []; const upstream = sseUpstream([responsesTextDelta('hello'), responsesCompleted({ input_tokens: 6, output_tokens: 8, total_tokens: 14 })]); const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*response\.(?:completed|incomplete)\b/, onUsage: (u) => calls.push(u) }); await drain(res); assert.equal(calls.length, 1); assert.deepEqual(calls[0], { input_tokens: 6, output_tokens: 8, total_tokens: 14 });
});
await test('responses passthrough: client abort reports nothing', async () => {
  const calls = []; const ac = new AbortController(); const upstream = new Response(new ReadableStream({ pull(c) { c.enqueue(encoder.encode(responsesTextDelta('flowing'))); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*response\.(?:completed|incomplete)\b/, onUsage: (u) => calls.push(u) }); const reader = res.body.getReader(); await reader.read(); ac.abort(); await reader.cancel().catch(() => {}); assert.equal(calls.length, 0);
});
await test('passthrough without onUsage stays fully functional (observability optional)', async () => {
  const upstream = sseUpstream([anthropicTextDelta('hello'), anthropicUsage(1, 1), anthropicStop]); const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*message_stop\b/ }); const text = await res.text(); assert.ok(text.includes('message_stop'));
});

await test('dashboard D1 cache coalesces concurrent requests within TTL', async () => {
  const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const HOUR = 3_600_000; const h0 = Math.floor(Date.now() / HOUR) * HOUR; await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'code-max'); const [html1, html2] = await Promise.all([pageText(anonRequest(), env), pageText(anonRequest(), env)]); assert.equal(html1, html2); assert.equal(d1._reads.length, 8); await pageText(anonRequest(), env); assert.equal(d1._reads.length, 8);
});
await test('dashboard D1 cache refreshes after TTL expires', async () => {
  const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const HOUR = 3_600_000; const h0 = Math.floor(Date.now() / HOUR) * HOUR; await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'code-max'); const realNow = Date.now; let fakeNow = h0 + 1_000; Date.now = () => fakeNow;
  try { const html1 = await pageText(anonRequest(), env); assert.ok(html1.includes('code-max')); assert.equal(d1._reads.length, 8); await persistTokenUsage(env, { prompt_tokens: 200, completion_tokens: 0 }, h0, 'ultra'); fakeNow += 44_000; const cached = await pageText(anonRequest(), env); assert.ok(!cached.includes('>200<')); assert.equal(d1._reads.length, 8); fakeNow += 2_000; const refreshed = await pageText(anonRequest(), env); assert.ok(refreshed.includes('>200<')); assert.ok(refreshed.includes('code-max')); assert.equal(d1._reads.length, 16); } finally { Date.now = realNow; }
});
await test('dashboard cache does not leak across different D1 bindings', async () => {
  const d1a = createMockD1(); const d1b = createMockD1(); const envA = deepClone(ENV); const envB = deepClone(ENV); envA.TOKEN_STATS_DB = d1a; envB.TOKEN_STATS_DB = d1b; const HOUR = 3_600_000; const h0 = Math.floor(Date.now() / HOUR) * HOUR; await persistTokenUsage(envA, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'model-a'); await persistTokenUsage(envB, { prompt_tokens: 200, completion_tokens: 0 }, h0, 'model-b'); const htmlA = await pageText(anonRequest(), envA); assert.ok(htmlA.includes('model-a')); assert.ok(!htmlA.includes('model-b')); const htmlB = await pageText(anonRequest(), envB); assert.ok(htmlB.includes('model-b')); assert.ok(!htmlB.includes('model-a')); assert.equal(d1a._reads.length, 8); assert.equal(d1b._reads.length, 8);
});
await test('public homepage does not leak raw D1 errors in degraded state', async () => {
  __resetDashboardCacheForTests(); const d1 = createMockD1({ failReads: true }); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const html = await pageText(anonRequest(), env); assert.ok(html.includes('统计暂不可用')); for (const leak of ['token_usage_hourly','token_usage_model_hourly','TOKEN_STATS_DB','mock D1 read failure','SELECT','FROM','WHERE','GROUP BY','ORDER BY']) assert.ok(!html.includes(leak));
});
await test('model usage panel does not leak raw D1 errors in degraded state', async () => {
  __resetDashboardCacheForTests(); const d1 = createMockD1({ failReads: true }); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const html = await pageText(anonRequest(), env); assert.ok(html.includes('模型使用')); assert.ok(html.includes('model-usage-empty')); for (const leak of ['token_usage_model_hourly','mock D1 read failure','SELECT','FROM']) assert.ok(!html.includes(leak));
});
await test('模型状态 section has model rows with status, P50, P95, sample count', async () => {
  __resetDashboardCacheForTests(); const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; env.TIER1_NODES_CONFIG_01 = JSON.stringify([{ id: 'node-a', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://a.example.com/v1', models: { 'max': 'up-max' }, limits: { concurrency: 1 } }]); env.TIER1_NODES_SECRETS_01 = JSON.stringify({ 'node-a': 'test-key' }); const html = await pageText(anonRequest(), env); assert.ok(html.includes('P50')); assert.ok(html.includes('P95')); assert.ok(html.includes('samples')); assert.ok(html.includes('mr-status')); assert.ok(html.includes('status-grid'));
});
await test('使用情况 section does NOT contain success rate, reliability, TTFT P50, TTFT P95', async () => {
  __resetDashboardCacheForTests(); const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const html = await pageText(anonRequest(), env); for (const leak of ['perf-section','成功率','reliability','Reliability','Model Reliability','Provider Reliability','可靠性']) assert.ok(!html.includes(leak)); assert.ok(html.includes('使用情况')); assert.ok(html.includes('Token 活动'));
});
await test('public dashboard does not leak provider, node id, tier, credential, key', async () => {
  __resetDashboardCacheForTests(); const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; const html = await pageText(anonRequest(), env); for (const leak of ['provider','node','tier','credential','api_key','cooldown','circuit']) assert.ok(!html.includes(leak));
});
await test('model status section is structurally separate from usage section', async () => {
  __resetDashboardCacheForTests(); const d1 = createMockD1(); const env = deepClone(ENV); env.TOKEN_STATS_DB = d1; env.TIER1_NODES_CONFIG_01 = JSON.stringify([{ id: 'node-a', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://a.example.com/v1', models: { 'unconfigured-model': 'up-x' }, limits: { concurrency: 1 } }]); env.TIER1_NODES_SECRETS_01 = JSON.stringify({ 'node-a': 'test-key' }); const html = await pageText(anonRequest(), env); const modelStatusIdx = html.indexOf('模型状态'); const usageIdx = html.indexOf('使用情况'); assert.ok(modelStatusIdx >= 0); assert.ok(usageIdx >= 0); assert.ok(modelStatusIdx < usageIdx); assert.ok(!html.includes('perf-section')); assert.ok(!html.includes('可靠性 · 性能')); assert.ok(html.includes('status-grid'));
});

if (!process.exitCode) console.log(`\ntoken-usage tests passed (${passed}).`);
else process.exit(1);