// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public entry page served on GET /.
//
// This is an API service ENTRY page, not an operations dashboard. It shows:
//   Header   — δ Smart AI Gateway | GitHub (brand & GitHub each appear once)
//   Hero     — 一个入口，多个模型
//   API 地址 — the derived /v1 origin + copy
//   模型     — 通用 / 编程 two flat groups, status-only colored dots
//   快速接入 — env snippet + copy
//   Footer   — © 2026 Fongap Studio
//
// Public-safety rules:
//   * Unauthenticated, so it never leaks credentials, node ids, providers,
//     tiers, counts, cooldowns, faults, protocol notes or version numbers.
//   * Logical-model status is computed server-side from node availability and
//     collapsed to exactly { 可用 | 波动 | 不可用 }; no node-level detail.
//   * `/health`, `/metrics`, `/v1/models` stay auth-protected and untouched.
//   * ONE exception, authenticated server-side: requests presenting the valid
//     GATEWAY_ACCESS_KEY additionally get a Token 使用量 panel appended (a
//     provider/tier/node usage breakdown, observability only, 非计费口径).
//     The anonymous page is byte-identical to the panel-free layout.
//
// No external fonts, no framework, no icons library, no runtime dependency:
// plain HTML + inline CSS + one tiny delegated copy handler.

import { loadGatewayConfig } from '../config/nodes.js';
import { loadModelRegistry, servesModel } from '../config/registry.js';
import { peekAvailability } from '../reliability/node-state.js';
import { htmlResponse } from '../protocol/http.js';
import { isAuthorized } from '../request/auth.js';
import { summarizeTokenStats } from '../observability/tokens.js';

export const GITHUB_URL = 'https://github.com/fongap/ai-gateway';

const STYLES = `
:root{
  --bg:#fafafa; --panel:#ffffff; --text:#16181d; --muted:#7a818c; --faint:#9aa1a9;
  --line:#e5e7eb; --blue:#2563eb; --blue-hover:#eef2ff;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{background:var(--bg);color:var(--text);
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",
    "Hiragino Sans GB","Microsoft YaHei",sans-serif;
  letter-spacing:-.005em;min-height:100vh;display:flex;flex-direction:column}
.wrap{max-width:1080px;margin:0 auto;padding:0 32px;width:100%}
a{color:var(--blue);text-decoration:none}

/* Header */
.site-header{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:22px 0;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:640;
  letter-spacing:-.01em;color:var(--text)}
.brand .mark{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  font-size:20px;color:var(--blue);font-weight:500;line-height:1}
.github{display:inline-flex;color:var(--muted);transition:color .15s}
.github:hover{color:var(--text)}
.github svg{width:20px;height:20px;display:block}

main{flex:1;padding-top:60px;padding-bottom:28px}

/* Hero */
.hero{text-align:center}
.hero h1{font-size:clamp(30px,3.4vw,36px);font-weight:650;line-height:1.25;
  letter-spacing:-.02em;color:var(--text)}
.hero .desc{margin:18px auto 0;font-size:16px;color:var(--muted);line-height:1.7;
  max-width:680px}

/* Section headings */
.sec{font-size:13px;font-weight:600;color:#4b5563;letter-spacing:.01em}
.sec + *{margin-top:12px}

/* API address */
.api-block{margin-top:52px}
.api{background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.api .url{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  font-size:14px;color:var(--text);word-break:break-all;min-width:0;flex:1}

button.copy{font:inherit;font-size:13px;color:var(--blue);background:transparent;
  border:1px solid transparent;border-radius:6px;padding:5px 10px;cursor:pointer;
  flex:none;transition:background .15s,color .15s}
button.copy:hover{background:var(--blue-hover)}
button.copy:focus-visible{outline:2px solid var(--blue);outline-offset:2px}

/* Models */
.models-block{margin-top:48px}
.group + .group{margin-top:32px}
.group-title{font-size:13px;font-weight:500;color:var(--muted);margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.model{background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:13px 16px;display:flex;align-items:center;justify-content:space-between;
  gap:10px;min-height:56px;transition:border-color .15s,background .15s}
.model:hover{border-color:#d6d9de;background:#fdfdfe}
.model .name{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  font-size:14px;color:var(--text);word-break:break-all}
.model .state{display:flex;align-items:center;gap:6px;font-size:12.5px;
  color:var(--muted);white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;flex:none}
.dot.available{background:#22a06b}
.dot.degraded{background:#d5971f}
.dot.unavailable{background:#a9aeb7}
.empty{margin-top:12px;font-size:13.5px;color:var(--faint)}

/* Quickstart */
.quickstart{margin-top:48px}
.code{background:#f5f6f8;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.code-bar{display:flex;justify-content:flex-end;padding:10px 12px 0}
pre{margin:0;padding:0 24px 24px;font-family:ui-monospace,SFMono-Regular,Consolas,
  "Liberation Mono",monospace;font-size:14px;line-height:1.7;color:#1f2937;
  white-space:pre-wrap;word-break:break-all;overflow:auto}

/* Footer */
.site-footer{margin-top:64px;padding:30px 0 36px;text-align:center;
  font-size:13px;color:var(--faint)}

@media(max-width:920px){
  .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:560px){
  .wrap{padding:0 20px}
  main{padding-top:44px}
  .hero h1{font-size:30px}
  .hero .desc{font-size:15px}
  .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  pre{font-size:13px}
}
@media (prefers-reduced-motion:reduce){button.copy,.model{transition:none}}
`;

// Token usage panel styles are kept OUT of STYLES and injected only for
// authenticated requests, so the public page carries zero token markup — the
// anonymous layout is byte-identical to the panel-free page.
const TOKEN_STYLES = `
/* Token usage panel (authenticated requests only) */
.tokens-block{margin-top:48px}
.tokens-head{display:flex;align-items:baseline;justify-content:space-between;
  gap:12px;flex-wrap:wrap}
.tokens-head .scope{font-size:12px;color:var(--faint);white-space:nowrap}
.tcards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;
  margin-top:12px}
.tcard{background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:14px 16px;min-width:0}
.tcard-k{font-size:12.5px;color:var(--muted)}
.tcard-v{font-size:22px;font-weight:640;letter-spacing:-.02em;margin-top:4px;
  font-variant-numeric:tabular-nums}
.ttables{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;
  margin-top:20px}
.tgroup{background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:14px 16px;min-width:0}
.ttable{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
.ttable th{font-weight:500;color:var(--muted);text-align:right;padding:4px 0;
  border-bottom:1px solid var(--line);white-space:nowrap}
.ttable td{padding:5px 0;border-bottom:1px solid var(--line);text-align:right;
  font-variant-numeric:tabular-nums}
.ttable th:first-child,.ttable td:first-child{text-align:left}
.ttable tr:last-child td{border-bottom:none}
.ttable .dim{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  word-break:break-all}
@media(max-width:560px){
  .tcards{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .ttables{grid-template-columns:1fr}
}
`;

const GH_ICON = `<a class="github" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库">
<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>`;

// One tiny delegated copy handler for every [data-copy] button; each button
// keeps its own label so "已复制" can revert independently.
const COPY_SCRIPT = `<script>(function(){var root=document.body;
root.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('[data-copy]');if(!b)return;
  var label=b.textContent;var t=document.querySelector(b.getAttribute('data-copy'));
  var text=t?t.textContent:'';
  function done(){b.textContent='已复制';setTimeout(function(){b.textContent=label;},1400);}
  function fallback(text){var ta=document.createElement('textarea');ta.value=text;
    ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done,function(){fallback(text);done();});}
  else{fallback(text);done();}
});})();</script>`;

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
const MODEL_RANK = { air: 1, max: 2, pro: 3, ultra: 4 };
const CODE_PREFIX = 'code-';

// Split flat model statuses into 通用 / 编程 with a fixed Air → Max → Pro →
// Ultra order inside each group. Air and code-air never mix: a `code-` prefix
// places a model in 编程, everything else in 通用. Unknown suffixes sort last.
function groupModels(models) {
  const groups = { general: [], program: [] };
  for (const m of models) {
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

function modelCard(m) {
  const label = STATE_LABEL[m.status] || '不可用';
  return `<div class="model"><span class="name">${escapeHtml(m.id)}</span>` +
    `<span class="state"><span class="dot ${m.status}"></span>${label}</span></div>`;
}

function renderModelGroups(models) {
  const groups = groupModels(models);
  const parts = [];
  if (groups.general.length) {
    parts.push(`<div class="group"><div class="group-title">通用</div>` +
      `<div class="grid">${groups.general.map(modelCard).join('')}</div></div>`);
  }
  if (groups.program.length) {
    parts.push(`<div class="group"><div class="group-title">编程</div>` +
      `<div class="grid">${groups.program.map(modelCard).join('')}</div></div>`);
  }
  if (!parts.length) return `<div class="empty">模型映射配置后在此显示。</div>`;
  return parts.join('\n');
}

// Pick the quick-start example model deterministically: prefer a known
// recommended, currently-available logical model; else any available model;
// else show a placeholder the operator must fill in (never a hardcoded model
// that may not exist). Never take the first string-sorted model.
const RECOMMENDED_ORDER = ['air', 'code-air', 'code-pro', 'code-max', 'general-air'];
const MODEL_PLACEHOLDER = '<model>';
function recommendedExampleModel(models) {
  for (const name of RECOMMENDED_ORDER) {
    if (models.some((m) => m.id === name && m.status === 'available')) return name;
  }
  const any = models.find((m) => m.status === 'available');
  return any ? any.id : MODEL_PLACEHOLDER;
}

// ---- Token usage panel (authenticated requests only) ------------------------

// K/M/B compaction for card values. Never scientific notation, never NaN:
// anything non-finite or negative renders as an em dash (it should not happen
// — counters only grow — but the panel must stay robust).
function fmtCount(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(Math.trunc(n));
  const [div, suffix] = n < 1e6 ? [1e3, 'K'] : n < 1e9 ? [1e6, 'M'] : [1e9, 'B'];
  const v = n / div;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${suffix}`;
}

// Usage coverage = reports / (reports + missing). 0/0 (nothing observed yet)
// renders as an em dash, never as a fake 100%.
function fmtCoverage(reports, missing) {
  const d = reports + missing;
  return d === 0 ? '—' : `${((reports / d) * 100).toFixed(1)}%`;
}

function tokenTable(title, rows) {
  const inner = rows.length
    ? `<table class="ttable"><thead><tr><th>维度</th><th>Input</th><th>Output</th><th>Total</th><th>覆盖率</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td class="dim">${escapeHtml(r.name)}</td>` +
        `<td>${fmtCount(r.input)}</td><td>${fmtCount(r.output)}</td>` +
        `<td>${fmtCount(r.total)}</td><td>${fmtCoverage(r.reports, r.missing)}</td></tr>`).join('') +
      `</tbody></table>`
    : `<div class="empty">暂无数据。</div>`;
  return `<div class="tgroup"><div class="group-title">${title}</div>${inner}</div>`;
}

// Server-rendered from summarizeTokenStats() directly — no browser fetch, no
// second stats store, no Prometheus parsing. Rows are pre-sorted (total desc)
// by the tokens module; the panel only slices Top-N. Dimension names were
// sanitized at storage time and pass through escapeHtml here as well.
function tokenPanel() {
  const s = summarizeTokenStats();
  return `
<section class="tokens-block">
  <div class="tokens-head">
    <div class="sec">Token 使用量</div>
    <span class="scope">Isolate-local · Observability only · 非计费口径</span>
  </div>
  <div class="tcards">
    <div class="tcard"><div class="tcard-k">Total Tokens</div><div class="tcard-v">${fmtCount(s.totals.total)}</div></div>
    <div class="tcard"><div class="tcard-k">Input Tokens</div><div class="tcard-v">${fmtCount(s.totals.input)}</div></div>
    <div class="tcard"><div class="tcard-k">Output Tokens</div><div class="tcard-v">${fmtCount(s.totals.output)}</div></div>
    <div class="tcard"><div class="tcard-k">Usage Coverage</div><div class="tcard-v">${fmtCoverage(s.totals.reports, s.totals.missing)}</div></div>
  </div>
  <div class="ttables">
    ${tokenTable('By Model', s.byModel.slice(0, 8))}
    ${tokenTable('By Provider', s.byProvider.slice(0, 8))}
    ${tokenTable('By Tier', s.byTier)}
    ${tokenTable('By Node (Top 5)', s.byNode.slice(0, 5))}
  </div>
</section>`;
}

function shell({ title, body, extraStyles = '' }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="统一接入多个 AI 服务，自动完成节点切换、故障转移和模型映射，为客户端提供稳定、简洁的 API 入口。">
<title>${escapeHtml(title)}</title><style>${STYLES}${extraStyles}</style></head>
<body>
<header class="wrap site-header">
  <div class="brand"><span class="mark" aria-hidden="true">δ</span>Smart AI Gateway</div>
  ${GH_ICON}
</header>
<main class="wrap">${body}</main>
<footer class="wrap site-footer">
  <span>© 2026 Fongap Studio</span>
</footer>
${COPY_SCRIPT}
</body></html>`;
}

export async function dashboardResponse(request, env) {
  const config = loadGatewayConfig(env);
  const models = publicModelStatus(config.nodes || [], env);
  const apiBase = `${new URL(request.url).origin}/v1`;
  const defaultModel = recommendedExampleModel(models);

  const body = `
<section class="hero">
  <h1>一个入口，多个模型</h1>
  <p class="desc">统一接入多个 AI 服务，自动完成节点切换、故障转移和模型映射，为客户端提供稳定、简洁的 API 入口。</p>
</section>

<section class="api-block">
  <div class="sec">API 地址</div>
  <div class="api">
    <span class="url" id="api-url">${escapeHtml(apiBase)}</span>
    <button class="copy" type="button" data-copy="#api-url" aria-label="复制 API 地址">复制</button>
  </div>
</section>

<section class="models-block">
  <div class="sec">模型</div>
  ${renderModelGroups(models)}
</section>

<section class="quickstart">
  <div class="sec">快速接入</div>
  <div class="code">
    <div class="code-bar"><button class="copy" type="button" data-copy="#env" aria-label="复制环境变量">复制</button></div>
    <pre id="env">OPENAI_BASE_URL=${escapeHtml(apiBase)}
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=${escapeHtml(defaultModel)}</pre>
  </div>
</section>`;

  // Token panel gate: only requests presenting the valid GATEWAY_ACCESS_KEY
  // see the usage breakdown. Without a valid key (or without a configured
  // key at all) the page is exactly the public layout — no token markup is
  // even present in the string.
  const accessKey = typeof env?.GATEWAY_ACCESS_KEY === 'string' ? env.GATEWAY_ACCESS_KEY : '';
  const showTokens = accessKey ? await isAuthorized(request, accessKey) : false;
  if (!showTokens) return htmlResponse(shell({ title: 'AI Gateway · API 服务入口', body }));

  return htmlResponse(shell({
    title: 'AI Gateway · API 服务入口 · Token 观测',
    body: body + tokenPanel(),
    extraStyles: TOKEN_STYLES,
  }));
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
