// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public entry page served on GET /.
//
// Single-screen-first status entry in a light, flat, Flyme-3-like design:
//   Header     — δ Smart AI Gateway | GitHub (brand & GitHub each appear once)
//   Hero       — 一个入口，应对所有变化 (compact)
//   模型状态   — ONE card: status + TTFT P50/P95 + sample count per model
//   使用情况   — ONE card: 4-column KPI strip + 52×7 Token 活动 heatmap
//   快速开始 — OpenAI / Anthropic 协议 tabs (no stacked code blocks)
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
//     durable D1 hourly aggregate (token-usage-store.mjs) and degrades to "统计暂不可
//     用" when the binding is absent or the query fails — never a fake 0.
//
// No external fonts, no framework, no chart library, no runtime dependency:
// plain HTML + inline CSS + one tiny inline script (copy + tabs). Heatmap is
// 364 server-rendered <i> cells; hover uses native title attributes.

import { loadGatewayConfig } from '../config/nodes.js';
import { getPublicModelStatus, MODEL_STATUS_RECENT_WINDOW_MS } from '../runtime/model-status.js';
import { htmlResponse } from '../protocol/http.js';
import {
  queryTokenSummary,
  queryTokenDailySeries,
  queryTokenModelUsage,
  queryRecentModelEvidence,
  queryModelTtftPercentiles,
  utc8DayStartUtcMs,
  isoDayUtc8,
} from '../observability/token-usage-store.mjs';

export const GITHUB_URL = 'https://github.com/fongap/ai-gateway';

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 52;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7; // 364 cells, exactly

// Short-lived cache for the public homepage's three D1 usage queries. The page
// is unauthenticated and the same queries run for every visitor; without this,
// a burst of concurrent anonymous GETs turns into N identical parallel D1
// reads and amplifies load on the free D1 budget. Caching only the
// *aggregate* D1 results (never per-request usage, never model health, never
// the rendered HTML) keeps node ids, providers, tiers and credential material
// out of the cache and out of the response.
//
// Contract:
//   * TTL is intentionally short (DASHBOARD_CACHE_TTL_MS, default 45s) so
//     numbers stay close to live without amplifying load.
//   * Concurrent requests in the same window SHARE the same in-flight promise
//     instead of stampeding D1 with parallel reads.
//   * A missing or failing D1 binding is still fail-open: the cached (or
//     freshly resolved) failure object is returned, the page keeps serving
//     200, and no fake 0 is fabricated.
//   * The cache holds only the public-facing aggregate (today / h24 / d7 /
//     cumulative totals, the per-day rollup, and the per-model 7d rollup) —
//     never access keys, node credentials, internal diagnostics, or HTML.
const DASHBOARD_CACHE_TTL_MS = 45_000;
let dashboardCaches = new WeakMap();
let missingBindingCache = newDashboardCacheEntry();

function newDashboardCacheEntry() {
  return { expiresAt: 0, inFlight: null, value: null };
}

// Cache state is isolated by the actual binding object. A string conversion is
// not a safe identity: most host objects and all plain test doubles stringify
// to "[object Object]", which can make one database receive another database's
// cached aggregate. If a runtime supplies a fresh wrapper on a later request,
// the safe failure mode is a cache miss rather than cross-binding data reuse.
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

async function getCachedDashboardStats(env, now) {
  const cache = dashboardCacheFor(env);
  const nowMs = typeof now === 'number' ? now : Date.now();
  // An in-flight promise is shared across concurrent callers using this exact
  // binding so they coalesce into one set of D1 reads.
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
    // Cache failures don't poison subsequent requests — refresh on next call.
    cache.expiresAt = 0;
    throw e;
  }
}

// Test-only escape hatch: every test that mutates D1 state must clear the
// dashboard cache or it will see stale fixtures for the rest of the run.
export function __resetDashboardCacheForTests() {
  dashboardCaches = new WeakMap();
  missingBindingCache = newDashboardCacheEntry();
}

// Three D1 queries, run once per cache window. Each call inside still honors
// its own fail-open contract (missing binding / read error returns the
// dashboard's `available: false` shape). A fourth lightweight GROUP BY
// powers Public Model Status — it reads only model names with requests > 0
// in the recent window, and on failure returns an empty Set so model status
// falls back to runtime-only evidence (never `unavailable` for everything).
// TTFT percentiles are fetched for the top models to display in the model
// status section alongside current availability.
async function loadDashboardStats(env, now) {
  const gridStartUtc8 = utc8DayStartUtcMs(now);
  const dow = (new Date(isoDayUtc8(gridStartUtc8)).getUTCDay() + 6) % 7;
  const currentWeekStartUtc8 = gridStartUtc8 - dow * DAY_MS;
  const startIso = isoDayUtc8(currentWeekStartUtc8 - (HEATMAP_WEEKS - 1) * 7 * DAY_MS);
  const [summary, daily, modelUsage, recentEvidence] = await Promise.all([
    queryTokenSummary(env, now),
    queryTokenDailySeries(env, startIso, now),
    queryTokenModelUsage(env, 7, now),
    queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now),
  ]);
  // Fetch TTFT percentiles for top models (up to 4) in parallel.
  // Only models with sufficient samples get meaningful percentiles;
  // others show "--".
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
  return { summary, daily, modelUsage, recentEvidence, ttft };
}

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
.wrap{width:min(var(--content),calc(100% - 64px));margin:0 auto}
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

/* Hero: enough vertical breathing room without delaying the main content */
.hero{text-align:center;padding:28px 0 24px}
.hero h1{font-size:32px;line-height:1.2;font-weight:500;letter-spacing:-.035em}
.hero .desc{margin:7px 0 0;color:var(--muted);font-size:14px}

/* Sections: unified title + card rhythm */
.section{margin-top:20px}
.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;
  font-size:13px;font-weight:600;color:#666e78;margin:0 0 10px 2px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:0 1px 2px rgba(27,31,36,.025)}

/* Model status — one card, flat list with status + TTFT columns */
.models-card{overflow:hidden}
.models-head{display:grid;grid-template-columns:minmax(100px,1fr) 80px 72px 72px 56px;gap:10px;
  padding:10px 16px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted);font-weight:600}
.models-head span{text-align:right}
.models-body{padding:4px 0}
.model-item{display:grid;grid-template-columns:minmax(100px,1fr) 80px 72px 72px 56px;gap:10px;
  align-items:center;padding:7px 16px;font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  transition:background .15s}
.model-item:hover{background:rgba(0,0,0,.02)}
.model-name{color:#4a525d;word-break:break-all;min-width:0}
.model-status{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:11px}
.model-status.available{color:var(--green)}
.model-status.unobserved{color:var(--orange)}
.model-status.degraded{color:var(--orange)}
.model-status.unavailable{color:var(--faint)}
.dot{width:6px;height:6px;border-radius:50%;flex:none}
.dot.available{background:var(--green)}
.dot.unobserved{background:var(--orange)}
.dot.degraded{background:var(--orange)}
.dot.unavailable{background:var(--faint)}
.model-perf{color:var(--text);text-align:right;font-variant-numeric:tabular-nums}
.model-samples{color:var(--muted);text-align:right;font-size:11px;font-variant-numeric:tabular-nums}
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
.activity{border-top:1px solid var(--line);padding:18px 24px}
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
  background:#edf0f2;outline:1px solid transparent;outline-offset:0;
  transition:transform 120ms ease,outline-color 120ms ease}
.hd.lv1{background:#dceff9}
.hd.lv2{background:#b7ddf2}
.hd.lv3{background:#79c4ec}
.hd.lv4{background:var(--blue)}
.hd:hover{transform:scale(1.1);outline-color:rgba(0,0,0,.08)}
.hd:focus-visible{outline:2px solid var(--blue);outline-offset:1px;transform:scale(1.1)}

/* Custom tooltip — auto width, multi-line via pre-wrap */
.tooltip{position:fixed;pointer-events:none;z-index:1000;background:#fff;
  border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;
  color:var(--text);box-shadow:0 2px 6px rgba(27,31,36,.08);
  white-space:pre-wrap;width:max-content;max-width:90vw;
  opacity:0;transition:opacity 120ms ease}
.tooltip.show{opacity:1}
.months{display:grid;grid-template-columns:repeat(52,minmax(0,1fr));margin-top:6px;
  color:var(--faint);font-size:10.5px;line-height:1.2}
.months span{grid-row:1;text-align:left;white-space:nowrap}
.heat-empty{padding:26px 0 20px;text-align:center;font-size:12.5px;color:var(--faint)}

/* Model usage · 近 7 天: compact ranked list, not a full-width chart */
.model-usage{border-top:1px solid var(--line);padding:18px 24px}
.model-usage-head{min-height:22px;display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
.model-usage-head b{font-size:13px;font-weight:600;color:#606872}
.model-usage-empty{padding:14px 0 10px;text-align:center;font-size:12.5px;color:var(--faint)}
.model-usage-list{list-style:none;display:grid;grid-template-columns:1fr;gap:10px;margin:0;padding:0;flex:1;min-width:0}
.model-usage-row{display:grid;grid-template-columns:minmax(108px,220px) minmax(120px,1fr) max-content;align-items:center;
  gap:10px;padding:5px 6px;border-radius:6px;font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  transition:background 120ms ease,outline-color 120ms ease;
  outline:1px solid transparent;outline-offset:0}
.model-usage-row:hover,.model-usage-row:focus-visible{background:rgba(0,0,0,.025);outline-color:rgba(0,0,0,.06)}
.model-usage-row:focus-visible{outline:2px solid var(--blue);outline-offset:0}
.model-usage-name{color:#4a525d;word-break:break-all}
/* Per-model swatch: links each bar row to its donut segment color */
.model-usage-swatch{display:inline-block;width:8px;height:8px;border-radius:50%;
  margin-right:8px;vertical-align:0}
.model-usage-bar{height:6px;background:#eef1f3;border-radius:999px;overflow:hidden}
.model-usage-bar i{display:block;height:100%;background:var(--blue);border-radius:999px;
  transition:width 120ms ease}
.model-usage-value{color:var(--text);text-align:right;font-size:12px;font-variant-numeric:tabular-nums}

/* Model usage body: donut ring and bar list side by side (stacked on mobile) */
.model-usage-body{display:flex;align-items:center;gap:28px}
/* Model usage donut · 近 7 天: SVG ring, token share per model */
.model-usage-donut{position:relative;width:180px;height:180px;flex:0 0 auto;margin:0}
.donut-svg{width:100%;height:100%;display:block}
.donut-seg{transition:opacity 120ms ease,stroke-width 120ms ease;cursor:default}

.donut-seg:hover,.donut-seg:focus-visible{opacity:.85;stroke-width:19}
.donut-seg:focus-visible{outline:none}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;pointer-events:none;text-align:center}
.donut-center strong{font-size:22px;font-weight:600;color:var(--text);line-height:1.1;
  font-variant-numeric:tabular-nums}
.donut-center span{font-size:11px;color:var(--faint);margin-top:2px}

/* Client configuration — tabs so the three snippets never stack vertically */
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
   .wrap{width:calc(100% - 32px)}
   .hero{padding:24px 0 20px}
  .hero h1{font-size:28px}
  .models-head{grid-template-columns:minmax(80px,1fr) 64px 60px 60px;font-size:10px;padding:8px 12px}
  .models-head .model-samples{display:none}
  .model-item{grid-template-columns:minmax(80px,1fr) 64px 60px 60px;font-size:11px;padding:6px 12px}
  .model-samples{display:none}
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
    .model-usage{padding:16px}
   .model-usage-row{grid-template-columns:minmax(84px,1fr) 76px max-content;gap:8px}
   .activity{padding:16px}
   .model-usage-body{flex-direction:column;align-items:stretch}
   .model-usage-donut{width:148px;height:148px;margin:0 auto 8px}
  .snippet pre{white-space:pre-wrap;word-break:break-all;padding-right:17px}
  .snippet .copy{position:static;margin:8px 12px 0}
  .site-footer{flex-direction:column;align-items:flex-start;gap:4px}
}
@media (prefers-reduced-motion:reduce){.tab,button.copy,.hd,.tooltip{transition:none}.hd:hover,.hd:focus-visible{transform:none}}
@media (forced-colors:active){.dot,.hd{border:1px solid CanvasText}}
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
var tipEl=document.createElement('div');tipEl.className='tooltip';tipEl.setAttribute('role','tooltip');
document.body.appendChild(tipEl);
var tipSel='.hd[data-tooltip],.donut-seg[data-tooltip]';
function showTip(target){
  var text=target.getAttribute('data-tooltip');if(!text)return;
  tipEl.textContent=text;tipEl.classList.add('show');
  var r=target.getBoundingClientRect();
  var tw=tipEl.offsetWidth,th=tipEl.offsetHeight;
  // Keep the tooltip inside its card frame (intersection with the viewport):
  // prefer below the cell, flip above when the bottom would overflow, then
  // clamp on every edge.
  var card=target.closest&&target.closest('.card');
  var b=card?card.getBoundingClientRect():{left:0,top:0,right:window.innerWidth,bottom:window.innerHeight};
  var minL=Math.max(4,b.left+4),maxR=Math.min(window.innerWidth-4,b.right-4);
  var minT=Math.max(4,b.top+4),maxB=Math.min(window.innerHeight-4,b.bottom-4);
  var left=r.left+r.width/2-tw/2;var top=r.bottom+8;
  if(top+th>maxB)top=r.top-th-8;
  if(top<minT)top=maxB-th;
  if(left<minL)left=minL;
  if(left+tw>maxR)left=maxR-tw;
  tipEl.style.left=left+'px';tipEl.style.top=top+'px';
}
function hideTip(){tipEl.classList.remove('show');tipEl.textContent='';}
root.addEventListener('mouseover',function(e){
  var t=e.target.closest&&e.target.closest(tipSel);if(t)showTip(t);
});
root.addEventListener('mouseout',function(e){
  var t=e.target.closest&&e.target.closest(tipSel);if(t)hideTip();
});
root.addEventListener('focusin',function(e){
  var t=e.target.closest&&e.target.closest(tipSel);if(t)showTip(t);
});
// The tooltip is position:fixed — hide it on scroll instead of letting it
// drift away from its anchor cell.
window.addEventListener('scroll',hideTip,{passive:true});
root.addEventListener('focusout',function(e){
  var t=e.target.closest&&e.target.closest(tipSel);if(t)hideTip();
});
})();</script>`;

// Collapse node-level availability + cross-isolate recent-success evidence
// into a public-safe per-model status. See src/runtime/model-status.js for
// the full semantics. The previous implementation equated "this isolate has
// no Tier 1 TTFT sample" with "未观测", which made every model show
// unobserved on a fresh isolate even though D1 proved the model was just
// serving successfully. The new layer:
//   - Uses runtime availability as ONE input (not the only input).
//   - Uses D1's per-model recent-success evidence (requests > 0 in the last
//     24h) as the cross-isolate proof that the model is actually working.
//   - Never fabricates evidence and never marks every model unavailable
//     when D1 is missing/failing (fail-open -> empty Set -> `unobserved`).
//   - Never feeds back into the scheduler, reliability layer or request path.
// Model set = node mappings (a model in the registry with no serving node is
// unreachable and is not listed on the dashboard). No node ids, providers,
// tiers, counts or durations ever leave this function.
function publicModelStatus(nodes, env, evidence = new Set(), now = Date.now()) {
  return getPublicModelStatus(nodes, env, evidence, now);
}

const STATE_LABEL = { available: '可用', unobserved: '未观测', degraded: '波动', unavailable: '不可用' };
const GENERAL_PREFIX = 'general-';

function fmtModelTtft(modelTtft) {
  if (!modelTtft || modelTtft.available === false) return { p50: '--', p95: '--', samples: 0, insufficient: true };
  if (modelTtft.insufficient) return { p50: '--', p95: '--', samples: modelTtft.sampleCount || 0, insufficient: true };
  return {
    p50: modelTtft.p50 != null ? fmtTtft(modelTtft.p50) : '--',
    p95: modelTtft.p95 != null ? fmtTtft(modelTtft.p95) : '--',
    samples: modelTtft.sampleCount || 0,
    insufficient: false,
  };
}

function renderModels(models, ttft) {
  const allModels = [];
  for (const m of models) {
    if (m.id.toLowerCase().startsWith(GENERAL_PREFIX)) continue;
    allModels.push(m);
  }
  if (!allModels.length) {
    return { html: `<div class="card models-card"><div class="empty">模型映射配置后在此显示。</div></div>` };
  }
  const items = allModels.map((m) => {
    const label = STATE_LABEL[m.status] || '不可用';
    const t = fmtModelTtft(ttft?.get?.(m.id));
    const sampleTitle = t.insufficient ? 'TTFT 样本不足' : `${t.samples} 个 TTFT 样本`;
    return `<div class="model-item">` +
      `<span class="model-name">${escapeHtml(m.id)}</span>` +
      `<span class="model-status ${m.status}"><i class="dot ${m.status}" aria-hidden="true"></i>${label}</span>` +
      `<span class="model-perf">P50 ${t.p50}</span>` +
      `<span class="model-perf">P95 ${t.p95}</span>` +
      `<span class="model-samples" title="${escapeHtml(sampleTitle)}">${t.samples}</span>` +
      `<span class="sr-only">状态：${label}，TTFT P50 ${t.p50}，P95 ${t.p95}</span></div>`;
  }).join('');
  return { html: `<div class="card models-card"><div class="models-head"><b>模型</b><span>状态</span><span>P50</span><span>P95</span><span>样本</span></div><div class="models-body">${items}</div></div>` };
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

// Format a UTC+8 ISO date (YYYY-MM-DD) as "6月1日" for tooltip display.
function fmtTooltipDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
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
      const tip = future ? iso : `${fmtTooltipDate(iso)}\n${fmtTokens(total)} Token · ${fmtInt(requests)} 次请求`;
      cells.push(`<i class="hd lv${level}" tabindex="0" data-tooltip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></i>`);
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

async function usageCard(env, now) {
  const { summary, daily, modelUsage, recentEvidence, ttft } = await getCachedDashboardStats(env, now);
  return { summary, daily, modelUsage, recentEvidence, ttft };
}

function kpiCell(value, label) {
  const exact = typeof value === 'string' && /^[\d,]+$/.test(value) ? Number(value.replace(/,/g, '')) : null;
  const titleAttr = exact !== null ? ` title="${escapeHtml(fmtInt(exact))}"` : '';
  return `<div class="kpi"><strong${titleAttr}>${value}</strong><span>${label}</span></div>`;
}

// Fail-open: a missing D1 binding or a failed query renders em dashes and an
// error note — never a fake 0 and never a fabricated heatmap. Accepts the
// already-cached stats from the caller so the model-status path and the
// usage-rendering path share ONE cache read and ONE in-flight promise.
async function usageSection(env, now = Date.now(), stats = null) {
  const cache = stats || await getCachedDashboardStats(env, now);
  const { summary, daily, modelUsage } = cache;
  const summaryOk = summary && summary.available !== false;
  const dailyOk = daily && daily.available !== false;
  const available = summaryOk && dailyOk;
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
  // Collect error messages for server-side logging ONLY — never expose raw
  // D1 errors (table names, SQL, binding names, exception text) to the public
  // HTML. The public page shows only a generic "统计暂不可用" message.
  const errors = [];
  if (summary && summary.error) errors.push(summary.error);
  if (daily && daily.error) errors.push(daily.error);
  if (!summary) errors.push('TOKEN_STATS_DB binding missing');
  if (summary && !summary.available && !summary.error) errors.push('summary unavailable');
  if (daily && !daily.available && !daily.error) errors.push('daily unavailable');
  // Server-side log for debugging (the operator sees this in wrangler tail / logs)
  if (errors.length && env && env.LOG_LEVEL !== 'none') {
    try { console.warn(`[dashboard D1 degraded] ${errors.join('; ')}`); } catch { /* ignore */ }
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
  // Model usage for the last 7 days: one compact comparison bar per model,
  // ordered by total tokens desc. Degrades independently of the heatmap/KPIs
  // so a per-model query failure never blanks the whole card.
  const modelSection = renderModelUsage(modelUsage);
  return `<section class="section">
  <div class="section-title">使用情况</div>
  <div class="card">
    <div class="kpis">${kpis}</div>
    <div class="activity">
      <div class="activity-head"><b>Token 活动 · 52 周</b><span>${fmtInt(totalRequests)} 次请求</span></div>
      ${activity}
    </div>
    ${modelSection}
  </div>
</section>`;
}

function renderModelUsage(modelUsage) {
  const head = `<div class="model-usage-head"><b>模型使用 · 近 7 天</b></div>`;
  // Fail-open: a missing/failed per-model query renders an em-dash row, not
  // an error that breaks the rest of the card.
  if (!modelUsage || modelUsage.available === false) {
    return `<div class="model-usage"><div class="model-usage-head"><b>模型使用 · 近 7 天</b></div>` +
      `<div class="model-usage-empty">—</div></div>`;
  }
  const rows = Array.isArray(modelUsage.rows) ? modelUsage.rows : [];
  if (!rows.length) {
    return `<div class="model-usage"><div class="model-usage-head"><b>模型使用 · 近 7 天</b></div>` +
      `<div class="model-usage-empty">近 7 天暂无数据</div></div>`;
  }
  // Chart only the top 4 models; everything below folds into one "其他" row so
  // the donut center total still equals the sum of the displayed rows.
  const TOP_N = 4;
  let chartRows = rows;
  if (rows.length > TOP_N) {
    const rest = rows.slice(TOP_N);
    chartRows = [...rows.slice(0, TOP_N), {
      model: `其他（${rest.length} 个模型）`,
      total: rest.reduce((s, r) => s + r.total, 0),
      requests: rest.reduce((s, r) => s + r.requests, 0),
    }];
  }
  // Donut ring: each entry's share of total tokens in the 7-day window.
  const donut = renderModelDonut(chartRows);
  // Build a compact ranked row: name (with a donut-matching color swatch),
  // comparison bar in the same per-model color, then the Token count.
  // Bar width is relative to the max in this window, not a percentage share.
  const max = chartRows.reduce((m, r) => (r.total > m ? r.total : m), 0);
  const items = chartRows.map((r, i) => {
    const color = modelShade(i, chartRows.length);
    const pct = max > 0 ? Math.max(2, Math.round((r.total / max) * 100)) : 0;
    const exactTitle = `${fmtTokens(r.total)} Token · ${fmtInt(r.requests)} 次请求`;
    return `<li class="model-usage-row" data-tooltip="${escapeHtml(exactTitle)}" tabindex="0" aria-label="${escapeHtml(exactTitle)}">` +
      `<span class="model-usage-name"><i class="model-usage-swatch" style="background:${color}" aria-hidden="true"></i>${escapeHtml(r.model)}</span>` +
      `<span class="model-usage-bar" aria-hidden="true"><i style="width:${pct}%;background:${color}"></i></span>` +
      `<span class="model-usage-value">${fmtTokens(r.total)}</span>` +
      `<span class="sr-only">${escapeHtml(exactTitle)}</span></li>`;
  }).join('');
  return `<div class="model-usage">${head}<div class="model-usage-body">${donut}<ul class="model-usage-list">${items}</ul></div></div>`;
}

// Monochrome blue ramp shared by the donut ring and the bar list (matches the
// heatmap scale): rank 1 gets the page's --blue, later ranks fade toward a
// light tint. Every model stays identifiable without leaving the blue palette.
function modelShade(i, n) {
  const from = [0x08, 0x7b, 0xbd], to = [0xcf, 0xe8, 0xf8];
  const t = n <= 1 ? 0 : i / (n - 1);
  const c = from.map((f, k) => Math.round(f + (to[k] - f) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// SVG donut of token share per model (no chart library, plain inline SVG).
const DONUT_R = 40;
const DONUT_STROKE = 14;
const DONUT_CIRC = 2 * Math.PI * DONUT_R;

function renderModelDonut(rows) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  if (total <= 0) return '';
  let acc = 0;
  const segments = rows.map((r, i) => {
    const frac = total > 0 ? r.total / total : 0;
    const len = frac * DONUT_CIRC;
    const seg = `<circle class="donut-seg" cx="60" cy="60" r="${DONUT_R}" fill="none" ` +
      `stroke="${modelShade(i, rows.length)}" stroke-width="${DONUT_STROKE}" ` +
      `stroke-dasharray="${len} ${DONUT_CIRC - len}" stroke-dashoffset="${-acc}" ` +
      `transform="rotate(-90 60 60)" ` +
      `data-tooltip="${escapeHtml(`${r.model}\n${fmtTokens(r.total)} Token · ${fmtInt(r.requests)} 次请求 · ${(frac * 100).toFixed(1)}%`)}" ` +
      `tabindex="0" aria-label="${escapeHtml(`${r.model} ${(frac * 100).toFixed(1)}%`)}"></circle>`;
    acc += len;
    return seg;
  }).join('');
  return `<div class="model-usage-donut" role="img" aria-label="近7天各模型 Token 占比环形图">
  <svg viewBox="0 0 120 120" class="donut-svg">
    <circle cx="60" cy="60" r="${DONUT_R}" fill="none" stroke="#eef1f3" stroke-width="${DONUT_STROKE}"></circle>
    ${segments}
  </svg>
  <div class="donut-center"><strong>${fmtTokens(total)}</strong><span>近 7 天</span></div>
</div>`;
}

// ---- 快速开始 (tabbed, no stacked code blocks) -------------------------------

function snippetPane({ id, copyLabel, active, code }) {
  const target = `#code-${id}`;
  return `<div class="pane${active ? ' active' : ''}" id="pane-${id}" role="tabpanel" ` +
    `aria-labelledby="tab-${id}"${active ? '' : ' hidden'}>
    <div class="snippet">
      <button class="copy" type="button" data-copy="${target}" aria-label="复制${escapeHtml(copyLabel)}" aria-live="polite">复制</button>
      <pre id="code-${id}">${code}</pre>
    </div>
  </div>`;
}

function quickStartSection(apiBase) {
  const origin = new URL(apiBase).origin;
  const openai = `OPENAI_BASE_URL=${escapeHtml(apiBase)}
OPENAI_API_KEY=$GATEWAY_ACCESS_KEY`;
  const anthropic = `ANTHROPIC_BASE_URL=${escapeHtml(origin)}
ANTHROPIC_AUTH_TOKEN=$GATEWAY_ACCESS_KEY`;
  const tabs = [
    { id: 'openai', label: 'OpenAI 协议' },
    { id: 'anthropic', label: 'Anthropic 协议' },
  ].map((t, i) => `<button class="tab${i === 0 ? ' active' : ''}" id="tab-${t.id}" ` +
    `type="button" role="tab" aria-controls="pane-${t.id}" aria-selected="${i === 0}" ` +
    `tabindex="${i === 0 ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('');
  const panes = [
    snippetPane({ id: 'openai', copyLabel: 'OpenAI 协议环境变量', active: true, code: openai }),
    snippetPane({ id: 'anthropic', copyLabel: 'Anthropic 协议环境变量', active: false, code: anthropic }),
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
  try {
    const config = loadGatewayConfig(env);
    const now = Date.now();
    // ONE cached D1 read powers both the model-status evidence and the usage
    // card. Sharing the cache keeps the public homepage at a single D1 round
    // trip per 45s window, regardless of how many models or nodes exist.
    const stats = await getCachedDashboardStats(env, now);
    const recentEvidence = stats.recentEvidence instanceof Set
      ? stats.recentEvidence
      : new Set();
    const models = publicModelStatus(config.nodes || [], env, recentEvidence, now);
    const apiBase = `${new URL(request.url).origin}/v1`;

    const modelsResult = renderModels(models, stats.ttft);
    const usageHtml = await usageSection(env, now, stats);
    const quickHtml = quickStartSection(apiBase);

    const body = `
<section class="hero">
  <h1>一个入口，应对所有变化</h1>
  <p class="desc">模型、供应商、Key 与节点随时调整，自动轮换、切换与恢复，对外始终保持同一个端点。</p>
</section>

<section class="section">
  <div class="section-title">模型状态</div>
  ${modelsResult.html}
</section>

${usageHtml}
${quickHtml}`;

    return htmlResponse(shell({ title: 'AI Gateway · API 服务入口', body }));
  } catch (e) {
    // Graceful degradation: return a minimal HTML page instead of a 500 JSON error
    // This ensures the public homepage never returns {"error":{"message":"Internal gateway error."}}
    const body = `
<section class="hero">
  <h1>AI Gateway</h1>
  <p>服务暂时不可用，请稍后重试。</p>
</section>
<section class="section">
  <div class="section-title">模型状态</div>
  <div class="empty">模型映射配置后在此显示。</div>
</section>`;

    return htmlResponse(shell({ title: 'AI Gateway · 错误', body }), { status: 500 });
  }
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
