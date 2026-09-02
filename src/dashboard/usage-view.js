// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// 使用情况 section — KPI strip, 52-week heatmap, model usage donut + bars.
// Extracted from pages.js for the v5 Compact Quiet Technical Interface.

import {
  queryTokenSummary,
  queryTokenDailySeries,
  queryTokenModelUsage,
  utc8DayStartUtcMs,
  isoDayUtc8,
} from '../observability/token-usage-store.mjs';
import { escapeHtml, fmtTokens, fmtInt, fmtTooltipDate } from './format.js';

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 52;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;

// Teal ramp shared by the donut ring and the bar list.  Rank 1 gets the
// deepest teal, later ranks fade toward a light tint.
const TEAL_SHADES = ['#0f5d53', '#3f8b7c', '#7cb4a5', '#a9d0c4', '#dce9e3'];

function modelShade(i, n) {
  if (i < TEAL_SHADES.length) return TEAL_SHADES[i];
  const from = [0x0f, 0x5d, 0x53], to = [0xdc, 0xe9, 0xe3];
  const t = n <= 1 ? 0 : i / (n - 1);
  const c = from.map((f, k) => Math.round(f + (to[k] - f) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// ---- Heatmap ---------------------------------------------------------------

export function buildHeatmap(daily, now) {
  const todayStartUtc8 = utc8DayStartUtcMs(now);
  const todayIso = isoDayUtc8(todayStartUtc8);
  const dow = (new Date(todayIso).getUTCDay() + 6) % 7;
  const currentWeekStartUtc8 = todayStartUtc8 - dow * DAY_MS;
  const gridStartUtc8 = currentWeekStartUtc8 - (HEATMAP_WEEKS - 1) * 7 * DAY_MS;

  let max = 0;
  for (const v of daily?.values() || []) if (v.total > max) max = v.total;

  const cells = [];
  const monthStarts = [];
  let prevMonth = -1;
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const weekStartMs = gridStartUtc8 + w * 7 * DAY_MS;
    const weekStartIso = isoDayUtc8(weekStartMs);
    const month = new Date(weekStartIso).getUTCMonth();
    if (month !== prevMonth) monthStarts.push({ col: w, month });
    prevMonth = month;
    for (let d = 0; d < 7; d++) {
      const dayMs = weekStartMs + d * DAY_MS;
      const iso = isoDayUtc8(dayMs);
      const future = iso > todayIso;
      const v = daily?.get(iso);
      const total = future || !v ? 0 : v.total;
      const requests = future || !v ? 0 : v.requests;
      const level = total <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((total / max) * 4)));
      const tip = future ? iso : `${fmtTooltipDate(iso)}\n${fmtTokens(total)} Token · ${fmtInt(requests)} 次请求`;
      cells.push(`<i class="cell" data-level="${level}" tabindex="0" data-tooltip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></i>`);
    }
  }

  const labels = [];
  let lastCol = -99;
  for (const { col, month } of monthStarts) {
    if (col > HEATMAP_WEEKS - 3) break;
    if (labels.length && col - lastCol < 3) continue;
    labels.push(`<span style="grid-column:${col + 1}">${month + 1}月</span>`);
    lastCol = col;
  }

  return { cells, labels };
}

// ---- KPI -------------------------------------------------------------------

function statCell(value, label) {
  const exact = typeof value === 'string' && /^[\d,]+$/.test(value) ? Number(value.replace(/,/g, '')) : null;
  const titleAttr = exact !== null ? ` title="${escapeHtml(fmtInt(exact))}"` : '';
  return `<div class="stat"><div class="stat-value"${titleAttr}>${value}</div><div class="stat-label">${label}</div></div>`;
}

// ---- Donut -----------------------------------------------------------------

const DONUT_R = 60;
const DONUT_STROKE = 16;
const DONUT_CIRC = 2 * Math.PI * DONUT_R;

function renderDonut(rows) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  if (total <= 0) return '';
  let acc = 0;
  const segments = rows.map((r, i) => {
    const frac = total > 0 ? r.total / total : 0;
    const len = frac * DONUT_CIRC;
    const seg = `<circle cx="78" cy="78" r="${DONUT_R}" fill="none" ` +
      `stroke="${modelShade(i, rows.length)}" stroke-width="${DONUT_STROKE}" ` +
      `stroke-dasharray="${len} ${DONUT_CIRC - len}" stroke-dashoffset="${-acc}" ` +
      `transform="rotate(-90 78 78)" ` +
      `data-tooltip="${escapeHtml(`${r.model}\n${fmtTokens(r.total)} Token · ${fmtInt(r.requests)} 次请求 · ${(frac * 100).toFixed(1)}%`)}" ` +
      `tabindex="0" aria-label="${escapeHtml(`${r.model} ${(frac * 100).toFixed(1)}%`)}"></circle>`;
    acc += len;
    return seg;
  }).join('');
  return `<div class="donut" role="img" aria-label="各模型 Token 占比，统计窗口为近 7 天">
  <svg viewBox="0 0 156 156" aria-hidden="true">
    <circle cx="78" cy="78" r="${DONUT_R}" fill="none" stroke="var(--line-soft)" stroke-width="${DONUT_STROKE}"></circle>
    ${segments}
  </svg>
  <div class="donut-center"><strong>${fmtTokens(total)}</strong><span>近 7 天</span></div>
</div>`;
}

// ---- Model usage bars ------------------------------------------------------

function renderBars(rows) {
  const max = rows.reduce((m, r) => (r.total > m ? r.total : m), 0);
  const items = rows.map((r, i) => {
    const color = modelShade(i, rows.length);
    const pct = max > 0 ? Math.max(2, Math.round((r.total / max) * 100)) : 0;
    const exactTitle = `${fmtTokens(r.total)} Token · ${fmtInt(r.requests)} 次请求`;
    return `<div class="bar-row" style="--c:${color};--w:${pct}%" data-tooltip="${escapeHtml(exactTitle)}" tabindex="0" aria-label="${escapeHtml(exactTitle)}">` +
      `<div class="bar-name"><i></i>${escapeHtml(r.model)}</div>` +
      `<div class="bar-track"><i></i></div>` +
      `<div class="bar-value">${fmtTokens(r.total)}</div></div>`;
  }).join('');
  return `<div class="bars">${items}</div>`;
}

// ---- Model usage section ---------------------------------------------------

function renderModelUsage(modelUsage) {
  if (!modelUsage || modelUsage.available === false) {
    return `<div class="subhead" style="margin-bottom:32px"><b>模型使用</b></div>` +
      `<div class="model-usage-empty">—</div>`;
  }
  const rows = Array.isArray(modelUsage.rows) ? modelUsage.rows : [];
  if (!rows.length) {
    return `<div class="subhead" style="margin-bottom:32px"><b>模型使用</b></div>` +
      `<div class="model-usage-empty">近 7 天暂无数据</div>`;
  }
  const TOP_N = 4;
  let chartRows = rows;
  if (rows.length > TOP_N) {
    const rest = rows.slice(TOP_N);
    chartRows = [...rows.slice(0, TOP_N), {
      model: '其他',
      total: rest.reduce((s, r) => s + r.total, 0),
      requests: rest.reduce((s, r) => s + r.requests, 0),
    }];
  }
  const donut = renderDonut(chartRows);
  const bars = renderBars(chartRows);
  return `<div class="subhead" style="margin-bottom:32px"><b>模型使用</b></div>` +
    `<div class="usage-split">${donut}${bars}</div>`;
}

// ---- Full section ----------------------------------------------------------

export async function usageSection(env, now = Date.now(), stats = null) {
  const cache = stats || await getCachedDashboardStats(env, now);
  const { summary, daily, modelUsage } = cache;
  const summaryOk = summary && summary.available !== false;
  const dailyOk = daily && daily.available !== false;
  const available = summaryOk && dailyOk;
  const kpis = available
    ? [
        statCell(fmtTokens(summary.today.total), '今日'),
        statCell(fmtTokens(summary.h24.total), '近 24 小时'),
        statCell(fmtTokens(summary.d7.total), '7 天'),
        statCell(fmtTokens(summary.cumulative.total), '累计'),
      ].join('')
    : [
        statCell('—', '今日'),
        statCell('—', '近 24 小时'),
        statCell('—', '7 天'),
        statCell('—', '累计'),
      ].join('');
  let totalRequests = 0;
  if (available && daily) {
    for (const v of daily.values()) totalRequests += v.requests;
  }
  const errors = [];
  if (summary && summary.error) errors.push(summary.error);
  if (daily && daily.error) errors.push(daily.error);
  if (!summary) errors.push('TOKEN_STATS_DB binding missing');
  if (summary && !summary.available && !summary.error) errors.push('summary unavailable');
  if (daily && !daily.available && !daily.error) errors.push('daily unavailable');
  if (errors.length && env && env.LOG_LEVEL !== 'none') {
    try { console.warn(`[dashboard D1 degraded] ${errors.join('; ')}`); } catch { /* ignore */ }
  }
  const activity = available
    ? (() => {
        const { cells, labels } = buildHeatmap(daily, now);
        return `<div class="heatmap-wrap" tabindex="0" role="img" ` +
          `aria-label="近 52 周 Token 活动热力图">` +
          `<div class="heatmap" aria-hidden="true">${cells.join('')}</div>` +
          `<div class="months" aria-hidden="true">${labels.join('')}</div></div>`;
      })()
    : `<div class="model-usage-empty">统计暂不可用</div>`;
  const modelSection = renderModelUsage(modelUsage);
  return `<section id="usage">
  <div class="wrap">
    <div class="section-head"><span class="section-title">使用情况</span></div>
    <div class="stat-row">${kpis}</div>
    <div class="subhead"><b>Token 活动 · 52 周</b><span>${fmtInt(totalRequests)} 次请求</span></div>
    ${activity}
    ${modelSection}
  </div>
</section>`;
}

// Re-export cache helpers used by pages.js
import { queryRecentModelEvidence, queryModelTtftPercentiles } from '../observability/token-usage-store.mjs';

const DASHBOARD_CACHE_TTL_MS = 45_000;
let dashboardCaches = new WeakMap();
let missingBindingCache = { expiresAt: 0, inFlight: null, value: null };

function newDashboardCacheEntry() {
  return { expiresAt: 0, inFlight: null, value: null };
}

function dashboardCacheFor(env) {
  const d1 = env?.TOKEN_STATS_DB;
  if (!d1 || (typeof d1 !== 'object' && typeof d1 !== 'function') || typeof d1.prepare !== 'function') {
    return missingBindingCache;
  }
  let entry = dashboardCaches.get(d1);
  if (!entry) {
    entry = newDashboardCacheEntry();
    dashboardCaches.set(d1, entry);
  }
  return entry;
}

export async function getCachedDashboardStats(env, now) {
  const cache = dashboardCacheFor(env);
  const nowMs = typeof now === 'number' ? now : Date.now();
  if (cache.inFlight && cache.expiresAt > nowMs) return cache.inFlight;
  if (cache.value && cache.expiresAt > nowMs) return cache.value;
  cache.expiresAt = nowMs + DASHBOARD_CACHE_TTL_MS;
  const task = loadDashboardStats(env, now);
  const inFlight = task.finally(() => {
    if (cache.inFlight === inFlight) cache.inFlight = null;
  });
  cache.inFlight = inFlight;
  try {
    cache.value = await cache.inFlight;
    return cache.value;
  } catch (e) {
    cache.expiresAt = 0;
    throw e;
  }
}

export function __resetDashboardCacheForTests() {
  dashboardCaches = new WeakMap();
  missingBindingCache = newDashboardCacheEntry();
}

async function loadDashboardStats(env, now) {
  const gridStartUtc8 = utc8DayStartUtcMs(now);
  const dow = (new Date(isoDayUtc8(gridStartUtc8)).getUTCDay() + 6) % 7;
  const currentWeekStartUtc8 = gridStartUtc8 - dow * DAY_MS;
  const startIso = isoDayUtc8(currentWeekStartUtc8 - (HEATMAP_WEEKS - 1) * 7 * DAY_MS);
  const [summary, daily, modelUsage, recentEvidence] = await Promise.all([
    queryTokenSummary(env, now),
    queryTokenDailySeries(env, startIso, now),
    queryTokenModelUsage(env, 7, now),
    queryRecentModelEvidence(env, 7 * 24 * 60 * 60 * 1000, now),
  ]);
  const topModels = Array.isArray(modelUsage?.rows)
    ? modelUsage.rows.slice(0, 4).map((r) => r.model)
    : [];
  const ttftResults = await Promise.all(
    topModels.map((m) => queryModelTtftPercentiles(env, m, 7, now)),
  );
  const ttft = new Map();
  for (let i = 0; i < topModels.length; i++) {
    ttft.set(topModels[i], ttftResults[i]);
  }
  return { summary, daily, modelUsage, recentEvidence, ttft, observedAt: new Date(now).toISOString() };
}
