// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public entry page served on GET /.
//
// Quiet Technical Interface — a warm, flat, restrained design:
//   Header     — δ Smart AI Gateway | GitHub
//   Hero       — 一个入口，应对所有变化
//   模型状态   — 动态模型列表（按 Logical Model ID 排序）
//   使用情况   — 4-column KPI + 52×7 heatmap + model usage donut/bars
//   快速开始   — OpenAI / Anthropic tabbed code snippets
//   Footer     — © 2026 Fongap Studio · tagline
//
// Public-safety rules:
//   * Unauthenticated, never leaks credentials, node ids, providers,
//     tiers, cooldowns, faults, protocol notes or version numbers.
//   * Logical-model status computed server-side, collapsed to a colored
//     dot with text label (可用 | 波动 | 未观测 | 不可用).
//   * Usage section exposes only AGGREGATE numbers — never per-provider /
//     per-tier / per-node breakdowns.
//   * Data from durable D1 hourly aggregate; degrades to "统计暂不可用"
//     when binding is absent or query fails — never a fake 0.
//
// No external fonts, no framework, no chart library, no runtime dependency.

import { loadGatewayConfig } from '../config/nodes.js';
import { MODEL_STATUS_RECENT_WINDOW_MS } from '../runtime/model-status.js';
import { htmlResponse } from '../protocol/http.js';
import { escapeHtml } from './format.js';
import { THEME_CSS } from './theme.js';
import { publicModelStatus, renderModels } from './model-status-view.js';
import { getCachedDashboardStats, usageSection } from './usage-view.js';
import { quickStartSection } from './quick-start-view.js';

export const GITHUB_URL = 'https://github.com/fongap/ai-gateway';

// Re-export for tests that import from pages.js
export { __resetDashboardCacheForTests } from './usage-view.js';

const GH_ICON = `<a class="github" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" aria-label="GitHub · ai-gateway 仓库" title="GitHub · ai-gateway">
<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
</svg></a>`;

// Inline script: tab switching, copy-to-clipboard, tooltip positioning.
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
var tipSel='[data-tooltip]';
function showTip(target){
  var text=target.getAttribute('data-tooltip');if(!text)return;
  tipEl.textContent=text;tipEl.classList.add('show');
  var r=target.getBoundingClientRect();
  var tw=tipEl.offsetWidth,th=tipEl.offsetHeight;
  var left=r.left+r.width/2-tw/2;var top=r.bottom+8;
  if(top+th>window.innerHeight-4)top=r.top-th-8;
  if(top<4)top=4;
  if(left<4)left=4;
  if(left+tw>window.innerWidth-4)left=window.innerWidth-tw-4;
  var section=target.closest('section')||target.closest('.heatmap-wrap');
  if(section){
    var sr=section.getBoundingClientRect();
    if(top<sr.top)top=sr.top+4;
    if(top+th>sr.bottom)top=sr.bottom-th-4;
    if(left<sr.left)left=sr.left+4;
    if(left+tw>sr.right)left=sr.right-tw-4;
  }
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
window.addEventListener('scroll',hideTip,{passive:true});
root.addEventListener('focusout',function(e){
  var t=e.target.closest&&e.target.closest(tipSel);if(t)hideTip();
});
})()</script>`;

function shell({ title, body }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Smart AI Gateway — 聚合不同模型、协议与供应商，在变化的上游之上保持一个稳定的 API 入口。">
<title>${escapeHtml(title)}</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='85' font-family='ui-monospace,SFMono-Regular,Consolas,monospace' fill='%230f5d53'>δ</text></svg>"><style>${THEME_CSS}</style></head>
<body>

<header>
  <div class="wrap header-row">
    <a class="brand" href="#" aria-label="Smart AI Gateway 首页">
      <span class="brand-mark" aria-hidden="true">δ</span>
      <span class="brand-name">Smart AI Gateway</span>
    </a>
    ${GH_ICON}
  </div>
</header>

<main class="main-content">${body}</main>

<footer>
  <div class="wrap footer-row">
    <span>© 2026 <a href="https://www.fongap.com/" target="_blank" rel="noopener noreferrer">Fongap Studio</a></span>
    <span class="footer-sep" aria-hidden="true">·</span>
    <span>保持一个端点，应对所有变化</span>
  </div>
</footer>

${PAGE_SCRIPT}
</body></html>`;
}

export async function dashboardResponse(request, env) {
  try {
    const config = loadGatewayConfig(env);
    const now = Date.now();
    const stats = await getCachedDashboardStats(env, now);
    const recentEvidence = stats.recentEvidence instanceof Set
      ? stats.recentEvidence
      : new Set();
    // Use the cached stats' observation time as the status clock so concurrent
    // loads within the 45s cache window render byte-identical output and the
    // freshness timestamp reflects when the data was actually observed.
    const statusNow = typeof stats.observedAt === 'string'
      ? new Date(stats.observedAt).getTime()
      : now;
    const models = publicModelStatus(config.nodes || [], env, recentEvidence, statusNow);
    const apiBase = `${new URL(request.url).origin}/v1`;

    const modelsResult = renderModels(models, stats.ttft);
    const usageHtml = await usageSection(env, now, stats);
    const quickHtml = quickStartSection(apiBase);

    const body = [
      '<div class="hero wrap">',
      '  <h1>一个入口，应对所有变化</h1>',
      '  <p>聚合不同模型、协议与供应商，在变化的上游之上，保持一个稳定、简洁的 API 入口。</p>',
      '</div>',
      '<section id="status">',
      '  <div class="wrap">',
      '    <div class="section-head">',
      '      <span class="section-title">模型状态</span>',
      '    </div>',
      '    ' + modelsResult.html,
      '  </div>',
      '</section>',
      usageHtml,
      quickHtml,
    ].join('\n');

    return htmlResponse(shell({ title: 'Smart AI Gateway', body }));
  } catch (e) {
    try { console.error('[dashboard] dashboardResponse error:', e?.message || e, e?.stack || ''); } catch { /* ignore */ }
    const body = `
  <div class="hero wrap">
    <h1>AI Gateway</h1>
    <p>服务暂时不可用，请稍后重试。</p>
  </div>`;

    return htmlResponse(shell({ title: 'Smart AI Gateway', body }), { status: 500 });
  }
}
