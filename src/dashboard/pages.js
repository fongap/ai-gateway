// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public entry page served on GET /.
//
// This is NOT an admin / node / metrics dashboard, nor a README or config
// reference page. It answers exactly three questions:
//   1. What is this?          (智能边缘网关 · 一个入口，多个模型)
//   2. Which logical models are usable right now?  (可用 / 降级 / 不可用)
//   3. How do I connect?      (OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL)
//
// Public-safety rules:
//   * The home page is unauthenticated, so it must never leak credentials,
//     node ids, providers, tiers, key counts, cooldowns, or internal faults.
//   * `/health`, `/metrics`, `/v1/models` stay auth-protected and untouched.
//   * Logical-model status is computed server-side from node availability and
//     collapsed to exactly { 可用 | 降级 | 不可用 }; no node-level detail.

import { loadGatewayConfig } from '../config/nodes.js';
import { loadModelRegistry, servesModel } from '../config/registry.js';
import { peekAvailability } from '../reliability/node-state.js';
import { APP_META } from '../observability/status.js';
import { htmlResponse } from '../protocol/http.js';

export const GITHUB_URL = 'https://github.com/fongap/ai-gateway';
export const DOCS_URL = 'https://github.com/fongap/ai-gateway#客户端接入';

const STYLES = `
:root{--bg:#f8f9fa;--card:#ffffff;--text:#16181d;--muted:#6b7280;--faint:#9aa1a9;
  --line:#e7eaef;--gap:20px}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{background:var(--bg);color:var(--text);
  font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  letter-spacing:-.01em;min-height:100vh;display:flex;flex-direction:column}
.wrap{max-width:720px;margin:0 auto;padding:0 24px;width:100%}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0}
.brand{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:640;letter-spacing:-.01em}
.brand .mark{font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:20px;
  color:var(--faint);font-weight:500;line-height:1}
nav{display:flex;align-items:center;gap:20px}
nav a{color:var(--muted);text-decoration:none;font-size:14px;transition:color .15s}
nav a:hover{color:var(--text)}
.icon{display:inline-flex;color:var(--muted);transition:color .15s}
.icon:hover{color:var(--text)}
.icon svg{width:20px;height:20px;display:block}
main{flex:1;padding:44px 0 48px}
.hero h1{font-size:clamp(30px,4.4vw,44px);font-weight:650;line-height:1.12;letter-spacing:-.028em}
.hero .lead{margin-top:14px;font-size:18px;color:var(--muted);font-weight:500}
.hero .desc{margin-top:12px;font-size:15px;color:#71767f;max-width:56ch}
.api{margin-top:26px;background:var(--card);border:1px solid var(--line);border-radius:11px;
  padding:13px 16px;display:flex;align-items:flex-start;gap:12px}
.api .lbl{font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:11.5px;
  color:var(--faint);letter-spacing:.1em;text-transform:uppercase;padding-top:2px;flex:none}
.api .url{font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:13.5px;
  color:var(--text);word-break:break-all;min-width:0}
.meta{display:flex;justify-content:space-between;gap:16px;margin-top:18px;
  font-size:12.5px;color:var(--faint);align-items:center}
.meta .v{font-family:ui-monospace,"SF Mono",Consolas,monospace}
section{margin-top:38px}
h2{font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:12px;font-weight:500;
  color:var(--faint);letter-spacing:.14em;text-transform:uppercase}
.models{margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.model{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:12px 15px;
  display:flex;align-items:center;justify-content:space-between;gap:10px}
.model .name{font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:13.5px;
  color:var(--text);word-break:break-all}
.model .state{display:flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.dot.available{background:#16a34a}.dot.degraded{background:#d4a72c}.dot.unavailable{background:#dc2626}
.state.ok{color:#15803d}.state.dim{color:#a16207}.state.bad{color:#b91c1c}
.empty{margin-top:12px;font-size:13.5px;color:var(--faint)}
.code{margin-top:12px;background:#f3f4f6;border:1px solid var(--line);border-radius:11px;overflow:hidden}
.code-head{display:flex;align-items:center;justify-content:space-between;padding:9px 14px 0}
.code-head .cap{font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:11.5px;color:var(--faint)}
button.copy{font:inherit;font-size:12.5px;color:var(--muted);background:var(--card);
  border:1px solid var(--line);border-radius:7px;padding:4px 11px;cursor:pointer;transition:all .15s}
button.copy:hover{color:var(--text);border-color:#d0d4da}
button.copy:focus-visible{outline:2px solid #111;outline-offset:2px}
pre{margin:0;padding:13px 15px 15px;font-family:ui-monospace,"SF Mono",Consolas,monospace;
  font-size:13.5px;line-height:1.85;color:#1f2937;white-space:pre-wrap;word-break:break-all;overflow:auto}
footer{margin-top:52px;padding:18px 0 26px;border-top:1px solid var(--line);
  display:flex;align-items:center;justify-content:space-between;gap:16px;
  font-size:13px;color:var(--faint)}
@media(max-width:560px){
  main{padding:32px 0 40px}
  .hero h1{font-size:30px}
  .api{flex-direction:column;gap:4px}
  nav{gap:16px}
}
@media (prefers-reduced-motion:reduce){button.copy{transition:none}}
`;

const GH_ICON = `<a class="icon" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库">
<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>`;

const COPY_SCRIPT = `<script>(function(){var b=document.querySelector('[data-copy]');if(!b)return;
var label=b.textContent;b.addEventListener('click',function(){
var t=document.querySelector(b.getAttribute('data-copy'));var text=t?t.textContent:'';
function done(){b.textContent='已复制';setTimeout(function(){b.textContent=label;},1400);}
if(navigator.clipboard&&navigator.clipboard.writeText){
navigator.clipboard.writeText(text).then(done,function(){fallback(text);done();});}
else{fallback(text);done();}});
function fallback(text){var ta=document.createElement('textarea');ta.value=text;
ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);}
})();</script>`;

// Collapse node-level availability into a public-safe per-model status.
//   available    at least one serving node is currently healthy
//   degraded     serving nodes exist but none is currently available
//   unavailable  no configured node serves this logical model
// The model set = Model Registry (primary) ∪ node mappings. No node ids,
// providers, tiers, counts or durations ever leave this function.
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

const STATE_LABEL = { available: '可用', degraded: '降级', unavailable: '不可用' };
const STATE_CLASS = { available: 'ok', degraded: 'dim', unavailable: 'bad' };

function modelChips(models) {
  if (!models.length) return `<div class="empty">模型映射配置后在此显示。</div>`;
  const rows = models.map((m) => {
    const label = STATE_LABEL[m.status] || '不可用';
    const cls = STATE_CLASS[m.status] || 'bad';
    return `<div class="model"><span class="name">${escapeHtml(m.id)}</span><span class="state ${cls}"><span class="dot ${m.status}"></span>${label}</span></div>`;
  }).join('');
  return `<div class="models">${rows}</div>`;
}

function shell({ title, body, apiBase }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="智能边缘网关：一个入口，统一接入多个 AI 服务，自动完成节点切换、故障转移和模型映射。">
<title>${escapeHtml(title)}</title><style>${STYLES}</style></head>
<body>
<header class="wrap">
  <div class="brand"><span class="mark" aria-hidden="true">δ</span>智能边缘网关</div>
  <nav>
    <a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer">接入文档</a>
    ${GH_ICON}
  </nav>
</header>
<main class="wrap">${body}</main>
<footer class="wrap">
  <span>© 2026 Fongap Studio</span>
  ${GH_ICON}
</footer>
${COPY_SCRIPT}
</body></html>`;
}

export function dashboardResponse(request, env) {
  const config = loadGatewayConfig(env);
  const models = publicModelStatus(config.nodes || [], env);
  const apiBase = `${new URL(request.url).origin}/v1`;
  // Never hardcode a concrete model: use the first currently-available logical
  // model from the registry, else show a placeholder the operator must fill in.
  const firstAvailable = models.find((m) => m.status === 'available');
  const modelHint = firstAvailable ? firstAvailable.id : '<your-model>';

  const body = `
<section class="hero">
  <h1>智能边缘网关</h1>
  <p class="lead">一个入口，多个模型</p>
  <p class="desc">统一接入多个 AI 服务，自动完成节点切换、故障转移和模型映射，为客户端提供稳定、简洁的 API 入口。</p>
  <div class="api"><span class="lbl">API 地址</span><span class="url">${apiBase}</span></div>
  <div class="meta"><span>OpenAI 兼容协议</span><span class="v">v${escapeHtml(APP_META.version)}</span></div>
</section>
<section>
  <h2>模型</h2>
  ${modelChips(models)}
</section>
<section>
  <h2>快速接入</h2>
  <div class="code">
    <div class="code-head"><span class="cap">环境变量</span>
      <button class="copy" type="button" data-copy="#env" aria-label="复制环境变量">复制</button>
    </div>
    <pre id="env">OPENAI_BASE_URL=${apiBase}
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=${escapeHtml(modelHint)}</pre>
  </div>
</section>`;

  return htmlResponse(shell({ title: '智能边缘网关', body, apiBase }));
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
