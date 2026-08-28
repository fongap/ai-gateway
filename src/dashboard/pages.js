// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public entry page served on GET /.
//
// Single-screen-first status entry in a light, flat, Flyme-3-like design:
//   Header     — δ Smart AI Gateway | GitHub (brand & GitHub each appear once)
//   Hero       — 一个入口，多个模型 (compact)
//   模型状态   — 通用 / 编程 rows inside ONE card, light chips + status dot
//   使用情况   — ONE card: 5-column KPI strip + 52×7 Token 活动 heatmap
//   快速开始   — OpenAI / Claude Code / Codex tabs (no stacked code blocks)
//   Footer     — © 2026 Fongap Studio
//
// Public-safety rules:
//   * Unauthenticated, so it never leaks credentials, node ids, providers,
//     tiers, cooldowns, faults, protocol notes or version numbers.
//   * Logical-model status is computed server-side and collapsed to a colored
//     dot (title carries 可用 | 波动 | 不可用 for hover / a11y only).
//   * `/health`, `/metrics`, `/v1/models` stay auth-protected and untouched.
//   * The 使用情况 card exposes only AGGREGATE numbers (tokens / requests per
//     UTC day) — never per-provider / per-tier / per-node breakdowns, so node
//     ids, providers and tiers can never leak through it. Data comes from the
//     durable D1 hourly aggregate (token-store.js) and degrades to "统计暂不可
//     用" when the binding is absent or the query fails — never a fake 0.
//
// No external fonts, no framework, no chart library, no runtime dependency:
// plain HTML + inline CSS + one tiny inline script (copy + tabs). Heatmap is
// 364 server-rendered <i> cells; hover uses native title attributes.

import { loadGatewayConfig } from '../config/nodes.js';
import { loadModelRegistry, servesModel } from '../config/registry.js';
import { peekAvailability } from '../reliability/node-state.js';
import { htmlResponse } from '../protocol/http.js';
import {
  queryTokenSummary,
  queryTokenDailySeries,
  utc8DayStartUtcMs,
  isoDayUtc8,
} from '../observability/token-store.js';

export const GITHUB_URL = 'https://github.com/fongap/ai-gateway';

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 52;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7; // 364 cells, exactly

const STYLES = `
:root{
  --bg:#f5f6f7; --surface:#fff; --text:#30343a; --muted:#68717c; --faint:#6b7480;
  --line:#e6e9ed; --blue:#087bbd; --green:#26855f; --orange:#d5971f; --radius:14px; --content:1040px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{background:var(--bg);color:var(--text);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",
    "Hiragino Sans GB","Microsoft YaHei",sans-serif;
  letter-spacing:-.005em;min-height:100vh;display:flex;flex-direction:column}
.wrap{width:min(var(--content),calc(100% - 48px));margin:0 auto}
a{color:var(--blue);text-decoration:none}
.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;
  margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;
  white-space:nowrap!important;border:0!important}

/* Header */
.site-header{height:56px;display:flex;align-items:center;justify-content:space-between;
  gap:16px;border-bottom:1px solid rgba(0,0,0,.04)}
.brand{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;
  letter-spacing:-.01em;color:var(--text);white-space:nowrap}
.brand .mark{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  font-size:18px;color:var(--blue);font-weight:500;line-height:1}
.github{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;
  color:var(--muted);border-radius:8px;transition:color .15s,background .15s}
.github:hover{color:var(--text);background:rgba(0,0,0,.04)}
.github:focus-visible{outline:2px solid var(--blue);outline-offset:4px;border-radius:8px}
.github svg{width:18px;height:18px;display:block}

/* Hero (compact — the page targets ~1.5 viewports total) */
.hero{text-align:center;padding:24px 0 18px}
.hero h1{font-size:32px;line-height:1.2;font-weight:500;letter-spacing:-.035em}
.hero .desc{margin:7px 0 0;color:var(--muted);font-size:14px}

/* Sections: unified title + card rhythm */
.section{margin-top:16px}
.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;
  font-size:13px;font-weight:600;color:#666e78;margin:0 0 8px 2px}
.section-title .utc8{font-size:11px;color:var(--faint);font-weight:400}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:0 1px 2px rgba(27,31,36,.025)}

/* Models — one card, two rows, lightweight items (no heavy chips) */
.models-card{overflow:hidden}
.model-line{min-height:52px;padding:0 16px;display:flex;align-items:center;gap:14px}
.model-line + .model-line{border-top:1px solid var(--line)}
.model-kind{width:90px;flex:none;font-size:12px;color:var(--muted)}
.model-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;flex:1;
  padding:9px 0}
.model-item{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:6px 10px;border-radius:8px;font-size:12px;color:#4a525d;
  font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  transition:background .15s}
.model-item:hover{background:rgba(0,0,0,.02)}
.model-item .name{word-break:break-all;flex:1;min-width:0}
.model-item .state{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:11px}
.model-item .dot{width:6px;height:6px;border-radius:50%;flex:none}
.model-item .state.available{color:var(--green)}
.model-item .state.degraded{color:var(--orange)}
.model-item .state.unavailable{color:var(--faint)}
.model-item .dot.available{background:var(--green)}
.model-item .dot.degraded{background:var(--orange)}
.model-item .dot.unavailable{background:var(--faint)}
.model-status{font-size:11px;color:var(--faint)}
.model-status .dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:5px}
.model-status .dot.ok{background:var(--green)}
.empty{padding:16px;font-size:13px;color:var(--faint)}

/* Usage — ONE card: KPI strip on top, activity heatmap below */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.kpi{position:relative;min-width:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;height:88px;padding:0 8px}
.kpi:not(:last-child)::after{content:"";position:absolute;right:0;top:24px;height:40px;
  width:1px;background:var(--line)}
.kpi strong{font-size:25px;line-height:1;font-weight:400;letter-spacing:-.035em;
  font-variant-numeric:tabular-nums}
.kpi span{margin-top:7px;font-size:12px;color:var(--muted);white-space:nowrap}
.activity{border-top:1px solid var(--line);padding:15px 17px 15px}
.activity-head{min-height:22px;display:flex;align-items:baseline;justify-content:space-between;
  gap:12px}
.activity-head b{font-size:13px;font-weight:600;color:#606872}
.activity-head span{font-size:12px;color:var(--faint)}
.activity-scroll{overflow-x:auto;overflow-y:hidden;overscroll-behavior-inline:contain;
  scrollbar-width:thin;scrollbar-color:var(--faint) transparent;padding-bottom:2px}
.activity-scroll::-webkit-scrollbar{height:6px}
.activity-scroll::-webkit-scrollbar-thumb{background:var(--faint);border-radius:3px}
.activity-scroll::-webkit-scrollbar-track{background:transparent}
.activity-scroll:focus-visible{outline:2px solid var(--blue);outline-offset:3px;border-radius:4px}
.heatmap{display:grid;grid-template-columns:repeat(52,minmax(0,1fr));
  grid-template-rows:repeat(7,auto);grid-auto-flow:column;gap:3px;margin-top:9px}
.hd{display:block;width:100%;height:auto;aspect-ratio:1;border-radius:3px;
  background:#edf0f2}
.hd.lv1{background:#dceff9}
.hd.lv2{background:#b7ddf2}
.hd.lv3{background:#79c4ec}
.hd.lv4{background:var(--blue)}
.months{display:grid;grid-template-columns:repeat(52,minmax(0,1fr));margin-top:6px;
  color:var(--faint);font-size:10.5px;line-height:1.2}
.months span{grid-row:1;text-align:left;white-space:nowrap}
.heat-empty{padding:26px 0 20px;text-align:center;font-size:12.5px;color:var(--faint)}

/* Quick start — tabs so the three snippets never stack vertically */
.tabs{height:42px;border-bottom:1px solid var(--line);display:flex;align-items:center;
  gap:4px;padding:0 12px}
.tab{height:27px;display:flex;align-items:center;padding:0 11px;border:0;background:none;
  border-radius:8px;font:inherit;font-size:12px;color:var(--muted);cursor:pointer;
  transition:background .15s,color .15s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--blue);background:#edf7fc}
.tab:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.pane{display:none}
.pane.active{display:block}
.snippet{position:relative}
.snippet pre{margin:0;padding:14px 96px 15px 17px;font:12.5px/1.7 ui-monospace,
  SFMono-Regular,Consolas,"Liberation Mono",monospace;color:#505862;
  white-space:pre;overflow-x:auto}
.snippet .copy{position:absolute;top:10px;right:12px}

button.copy{font:inherit;font-size:12px;color:var(--blue);background:transparent;
  border:0;border-radius:7px;padding:5px 9px;cursor:pointer;flex:none;
  transition:background .15s,color .15s}
button.copy:hover{background:#edf7fc}
button.copy:focus-visible{outline:2px solid var(--blue);outline-offset:1px}

/* Footer */
.site-footer{margin-top:20px;display:flex;align-items:center;justify-content:space-between;
  gap:12px;color:var(--faint);font-size:11px;border-top:1px solid rgba(0,0,0,.04);padding-top:14px}
.site-footer a{color:var(--faint);text-decoration:none}
.site-footer a:hover{color:var(--muted)}

@media(max-width:860px){
  .wrap{width:calc(100% - 28px)}
  .hero{padding:20px 0 14px}
  .hero h1{font-size:28px}
  .model-kind{width:72px}
  .model-list{grid-template-columns:repeat(2,minmax(0,1fr))}
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .kpi{height:72px}
  .kpi::after{display:none}
  .kpi:nth-child(even)::before{content:"";position:absolute;left:0;top:18px;height:36px;
    width:1px;background:var(--line)}
  .kpi:nth-child(n+3){border-top:1px solid var(--line)}
  .kpi:nth-child(n+5)::before{display:none}
  .kpi:nth-child(n+5){grid-column:1/-1;border-top:1px solid var(--line)}
  .heatmap,.months{min-width:520px}
  .heatmap{gap:2px}
  .months{font-size:9px;letter-spacing:-.02em}
  .snippet pre{white-space:pre-wrap;word-break:break-all;padding-right:17px}
  .snippet .copy{position:static;margin:8px 12px 0}
  .site-footer{flex-direction:column;align-items:flex-start;gap:4px}
}
@media (prefers-reduced-motion:reduce){.tab,button.copy{transition:none}}
@media (forced-colors:active){.dot,.hd,.model-item .dot{border:1px solid CanvasText}}
`;

const GH_ICON = `<a class="github" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" aria-label="GitHub · ai-gateway 仓库" title="GitHub · ai-gateway">
<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>`;

// One tiny delegated handler: [data-copy] copies its target's text; .tab
// switches the visible quick-start pane. No libraries.
const PAGE_SCRIPT = `<script>(function(){
var root=document.body;
function activateTab(tab,moveFocus){
  var group=tab.closest('.tabs');var scope=group.parentElement;
  var id=tab.getAttribute('data-tab');
  for(var i=0;i<group.children.length;i++){
    var item=group.children[i];var active=item===tab;
    item.classList.toggle('active',active);item.setAttribute('aria-selected',active?'true':'false');
    item.tabIndex=active?0:-1;
  }
  var panes=scope.querySelectorAll(':scope > .pane');
  for(var j=0;j<panes.length;j++){var shown=panes[j].id==='pane-'+id;
    panes[j].classList.toggle('active',shown);panes[j].hidden=!shown;}
  if(moveFocus)tab.focus();
}
root.addEventListener('click',function(e){
  var tab=e.target.closest&&e.target.closest('.tab');
  if(tab){activateTab(tab,false);return;}
  var b=e.target.closest&&e.target.closest('[data-copy]');if(!b)return;
  var label=b.textContent;var t=document.querySelector(b.getAttribute('data-copy'));
  var text=t?t.textContent:'';
  function done(ok){b.textContent=ok?'已复制':'复制失败';setTimeout(function(){b.textContent=label;},1400);}
  function fallback(text){var ta=document.createElement('textarea');ta.value=text;
    ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
    var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);return ok;}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){done(true);},function(){done(fallback(text));});}
  else{done(fallback(text));}
});
root.addEventListener('keydown',function(e){
  var tab=e.target.closest&&e.target.closest('.tab');if(!tab)return;
  var keys=['ArrowLeft','ArrowRight','Home','End'];if(keys.indexOf(e.key)<0)return;
  e.preventDefault();var items=Array.prototype.slice.call(tab.closest('.tabs').children);
  var index=items.indexOf(tab);
  if(e.key==='Home')index=0;else if(e.key==='End')index=items.length-1;
  else index=(index+(e.key==='ArrowRight'?1:-1)+items.length)%items.length;
  activateTab(items[index],true);
});
})();</script>`;

// Collapse node-level availability into a public-safe per-model status.
//   available    at least one serving node is currently healthy
//   degraded     serving nodes exist but none is currently available
//   unavailable  no configured node serves this logical model
// Model set = Model Registry (primary) ∪ node mappings. No node ids, providers,
// tiers, counts or durations ever leave this function.
function publicModelStatus(nodes, env) {
  const names = new Set(Object.keys(loadModelRegistry(env)));
  for (const node of nodes) for (const key of Object.keys(node.models || {})) names.add(key);
  const list = [];
  for (const name of [...names].sort()) {
    const serving = nodes.filter((n) => servesModel(n, name));
    let status = 'unavailable';
    if (serving.length) {
      status = serving.some((n) => peekAvailability(n.id) === 'yes') ? 'available' : 'degraded';
    }
    list.push({ id: name, status });
  }
  return list;
}

const STATE_LABEL = { available: '可用', degraded: '波动', unavailable: '不可用' };
// Tier hierarchy: Ultra > Max > Pro > Air — display order follows it.
const MODEL_RANK = { ultra: 1, max: 2, pro: 3, air: 4 };
const CODE_PREFIX = 'code-';
const GENERAL_PREFIX = 'general-';

// Split flat model statuses into 通用 / 编程 with a fixed Ultra → Max → Pro →
// Air order inside each group (top tier first). Models prefixed with 'general-'
// are excluded from display. A `code-` prefix places a model in 编程,
// everything else in 通用. Unknown suffixes sort last.
function groupModels(models) {
  const groups = { general: [], program: [] };
  for (const m of models) {
    // Skip general-* models from public display
    if (m.id.toLowerCase().startsWith(GENERAL_PREFIX)) continue;
    const isCode = m.id.toLowerCase().startsWith(CODE_PREFIX);
    const base = isCode ? m.id.slice(CODE_PREFIX.length).toLowerCase() : m.id.toLowerCase();
    const rank = MODEL_RANK[base] ?? Number.MAX_SAFE_INTEGER;
    groups[isCode ? 'program' : 'general'].push({ id: m.id, status: m.status, rank });
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  }
  return groups;
}

function modelItem(m) {
  const label = STATE_LABEL[m.status] || '不可用';
  const statusClass = m.status;
  return `<div class="model-item" title="状态：${label}">` +
    `<span class="name">${escapeHtml(m.id)}</span>` +
    `<span class="state ${statusClass}"><i class="dot ${statusClass}" aria-hidden="true"></i>${label}</span>` +
    `<span class="sr-only">状态：${label}</span></div>`;
}

function modelRow(kind, list) {
  return `<div class="model-line"><div class="model-kind">${kind}</div>` +
    `<div class="model-list">${list.map(modelItem).join('')}</div></div>`;
}

function renderModels(models) {
  const groups = groupModels(models);
  const total = groups.general.length + groups.program.length;
  const available = [...groups.general, ...groups.program].filter(m => m.status === 'available').length;
  const rows = [];
  if (groups.general.length) rows.push(modelRow('通用 / General', groups.general));
  if (groups.program.length) rows.push(modelRow('编程 / Coding', groups.program));
  if (!rows.length) return { html: `<div class="card models-card"><div class="empty">模型映射配置后在此显示。</div></div>`, statusHtml: '' };
  const statusHtml = total > 0
    ? `<span class="model-status"><span class="dot ok" aria-hidden="true"></span>${available} / ${total} 正常</span>`
    : '';
  return { html: `<div class="card models-card">${rows.join('')}</div>`, statusHtml };
}

// Pick the quick-start example model deterministically: prefer a known
// recommended, currently-available logical model; else any available model;
// else show a placeholder the operator must fill in (never a hardcoded model
// that may not exist). Never take the first string-sorted model.
// general-* models are excluded from public display and recommendations.
const RECOMMENDED_ORDER = [
  'ultra', 'max', 'pro', 'air',
  'code-ultra', 'code-max', 'code-pro', 'code-air',
];
const MODEL_PLACEHOLDER = '<model>';
function recommendedExampleModel(models) {
  // general-* models are excluded from public display and recommendations.
  const visible = models.filter((m) => !m.id.toLowerCase().startsWith(GENERAL_PREFIX));
  for (const name of RECOMMENDED_ORDER) {
    if (visible.some((m) => m.id === name && m.status === 'available')) return name;
  }
  const any = visible.find((m) => m.status === 'available');
  return any ? any.id : MODEL_PLACEHOLDER;
}

// ---- 使用情况 (KPI strip + Token 活动 heatmap, one card) --------------------

// Chinese unit formatting for KPI values: 万 (10^4) and 亿 (10^8).
// < 10000: integer; >= 10000: 万 with 1 decimal; >= 100M: 亿 with 2 decimals.
// Never use K/M/B. Exact value available in title attribute.
function fmtTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 10000) return String(Math.trunc(n));
  if (n < 1e8) {
    const v = n / 1e4;
    const s = v >= 100 ? Math.round(v) : (Number.isInteger(v) ? v : v.toFixed(1));
    return `${s}万`;
  }
  const v = n / 1e8;
  const s = v >= 100 ? Math.round(v) : (Number.isInteger(v) ? v : v.toFixed(2));
  return `${s}亿`;
}

function fmtInt(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Build the 52×7 activity grid (364 cells, Monday-aligned weeks, the current
// week is the last column) plus month labels pinned to the columns where each
// month actually starts, so labels and cells always correspond. `daily` maps
// "YYYY-MM-DD" (UTC+8) -> { total, requests }; days without data are inactive.
// Future days of the current week render as inactive placeholders.
function buildHeatmap(daily, now) {
  const todayStartUtc8 = utc8DayStartUtcMs(now);
  const todayIso = isoDayUtc8(todayStartUtc8);
  const dow = (new Date(todayIso).getUTCDay() + 6) % 7; // 0 = Monday
  const currentWeekStartUtc8 = todayStartUtc8 - dow * DAY_MS;
  const gridStartUtc8 = currentWeekStartUtc8 - (HEATMAP_WEEKS - 1) * 7 * DAY_MS;

  let max = 0;
  for (const v of daily?.values() || []) if (v.total > max) max = v.total;

  const cells = [];
  const monthStarts = []; // { col, month }
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
      const title = future ? iso : `${iso} · ${fmtInt(total)} Token · ${fmtInt(requests)} 请求`;
      cells.push(`<i class="hd lv${level}" title="${escapeHtml(title)}"></i>`);
    }
  }

  // One label per month that starts inside the grid; drop labels that would
  // collide (fewer than 3 columns apart) or overflow the right edge. A 52-week
  // window then covers 12 labelled months.
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

function usageCard(env, now) {
  const gridStartUtc8 = utc8DayStartUtcMs(now);
  const dow = (new Date(isoDayUtc8(gridStartUtc8)).getUTCDay() + 6) % 7;
  const currentWeekStartUtc8 = gridStartUtc8 - dow * DAY_MS;
  const startIso = isoDayUtc8(currentWeekStartUtc8 - (HEATMAP_WEEKS - 1) * 7 * DAY_MS);
  return Promise.all([
    queryTokenSummary(env, now),
    queryTokenDailySeries(env, startIso, now),
  ]).then(([summary, daily]) => ({ summary, daily }));
}

function kpiCell(value, label) {
  const exact = typeof value === 'string' && /^[\d,]+$/.test(value) ? Number(value.replace(/,/g, '')) : null;
  const titleAttr = exact !== null ? ` title="${escapeHtml(fmtInt(exact))}"` : '';
  return `<div class="kpi"><strong${titleAttr}>${value}</strong><span>${label}</span></div>`;
}

// Fail-open: a missing D1 binding or a failed query renders em dashes and an
// "统计暂不可用" note — never a fake 0 and never a fabricated heatmap.
async function usageSection(env, now = Date.now()) {
  const { summary, daily } = await usageCard(env, now);
  const available = summary && daily;
  const kpis = available
    ? [
        kpiCell(fmtTokens(summary.today.total), '今日'),
        kpiCell(fmtTokens(summary.h24.total), '近 24 小时'),
        kpiCell(fmtTokens(summary.d7.total), '近 7 天'),
        kpiCell(fmtTokens(summary.cumulative.total), '累计'),
      ].join('')
    : [
        kpiCell('—', '今日'),
        kpiCell('—', '近 24 小时'),
        kpiCell('—', '近 7 天'),
        kpiCell('—', '累计'),
      ].join('');
  // Total requests in the heatmap window for the "xx,xxx 次请求" label
  let totalRequests = 0;
  if (available && daily) {
    for (const v of daily.values()) totalRequests += v.requests;
  }
  const activity = available
    ? (() => {
        const { cells, labels } = buildHeatmap(daily, now);
        return `<div class="activity-scroll" tabindex="0" role="img" ` +
          `aria-label="近52周 Token 活动热力图，日期按 UTC+8 显示，颜色越深表示当日 Token 使用量越高">` +
          `<div class="heatmap" aria-hidden="true">${cells.join('')}</div>` +
          `<div class="months" aria-hidden="true">${labels.join('')}</div></div>`;
      })()
    : `<div class="heat-empty">统计暂不可用</div>`;
  return `<section class="section">
  <div class="section-title">使用情况<span class="utc8">UTC+8</span></div>
  <div class="card">
    <div class="kpis">${kpis}</div>
    <div class="activity">
      <div class="activity-head"><b>Token 活动 · 52 周</b><span>${fmtInt(totalRequests)} 次请求</span></div>
      ${activity}
    </div>
  </div>
</section>`;
}

// ---- 快速开始 (tabbed, no stacked code blocks) -------------------------------

function snippetPane({ id, label, active, code }) {
  const target = `#code-${id}`;
  return `<div class="pane${active ? ' active' : ''}" id="pane-${id}" role="tabpanel" ` +
    `aria-labelledby="tab-${id}"${active ? '' : ' hidden'}>
    <div class="snippet">
      <button class="copy" type="button" data-copy="${target}" aria-label="复制${escapeHtml(label)}配置" aria-live="polite">复制</button>
      <pre id="code-${id}">${code}</pre>
    </div>
  </div>`;
}

function quickStartSection(apiBase, model) {
  const openai = `OPENAI_BASE_URL=${escapeHtml(apiBase)}
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=${escapeHtml(model)}`;
  const origin = new URL(apiBase).origin;
  const claude = `ANTHROPIC_BASE_URL=${escapeHtml(origin)}
ANTHROPIC_AUTH_TOKEN=your-api-key
ANTHROPIC_MODEL=${escapeHtml(model)}`;
  const codex = `# ~/.codex/config.toml
model = "${escapeHtml(model)}"
model_provider = "gateway"

[model_providers.gateway]
base_url = "${escapeHtml(apiBase)}"
env_key = "GATEWAY_API_KEY"`;
  const tabs = [
    { id: 'openai', label: 'OpenAI' },
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
  ].map((t, i) => `<button class="tab${i === 0 ? ' active' : ''}" id="tab-${t.id}" ` +
    `type="button" role="tab" aria-controls="pane-${t.id}" aria-selected="${i === 0}" ` +
    `tabindex="${i === 0 ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('');
  const panes = [
    snippetPane({ id: 'openai', label: 'OpenAI', active: true, code: openai }),
    snippetPane({ id: 'claude', label: 'Claude Code', active: false, code: claude }),
    snippetPane({ id: 'codex', label: 'Codex', active: false, code: codex }),
  ].join('\n');
  return `<section class="section">
  <div class="section-title">快速开始</div>
  <div class="card">
    <div class="tabs" role="tablist">${tabs}</div>
    ${panes}
    <noscript><style>.pane{display:block}.snippet pre{padding-right:17px}</style></noscript>
  </div>
</section>`;
}

function shell({ title, body }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="统一接入多个 AI 服务，自动完成节点切换、故障转移和模型映射，为客户端提供稳定、简洁的 API 入口。">
<title>${escapeHtml(title)}</title><style>${STYLES}</style></head>
<body>
<header class="wrap site-header">
  <div class="brand"><span class="mark" aria-hidden="true">δ</span>Smart AI Gateway</div>
  ${GH_ICON}
</header>
<main class="wrap">${body}</main>
<footer class="wrap site-footer">
  <span>© 2026 Fongap Studio</span>
  <a href="https://www.fongap.com" target="_blank" rel="noopener noreferrer">Fongap Studio Blog</a>
</footer>
${PAGE_SCRIPT}
</body></html>`;
}

export async function dashboardResponse(request, env) {
  const config = loadGatewayConfig(env);
  const models = publicModelStatus(config.nodes || [], env);
  const apiBase = `${new URL(request.url).origin}/v1`;
  const defaultModel = recommendedExampleModel(models);

  const modelsResult = renderModels(models);
  const usageHtml = await usageSection(env);
  const quickHtml = quickStartSection(apiBase, defaultModel);

  const body = `
<section class="hero">
  <h1>一个入口，多个模型</h1>
  <p class="desc">将多 API、多 Key 与多模型聚合为一个统一入口，自动轮换、限流避让、故障切换与恢复。</p>
</section>

<section class="section">
  <div class="section-title">模型状态${modelsResult.statusHtml}</div>
  ${modelsResult.html}
</section>

${usageHtml}
${quickHtml}`;

  return htmlResponse(shell({ title: 'AI Gateway · API 服务入口', body }));
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
