// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Dashboard / setup pages served on GET / for browsers.
// Airy editorial layout: generous whitespace, typographic hierarchy, hairline
// rules, one accent. Shows live binding state and configuration diagnostics.
// No credential values are ever read or rendered.

import { loadGatewayConfig } from '../config/nodes.js';
import { APP_META } from '../observability/status.js';
import { htmlResponse } from '../protocol/http.js';

export const GITHUB_URL = 'https://github.com/fongap/ai-gateway';

const STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{min-height:100vh;display:flex;flex-direction:column;background:#fcfcfc;color:#14171a;
  font:16px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  letter-spacing:-.01em}
a{color:inherit;text-decoration:none;border-bottom:1px solid #d8dce1;transition:border-color .15s}
a:hover{border-color:#14171a}
code{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;
  background:#f4f5f6;padding:2px 6px;border-radius:5px;color:#333}
header,footer{display:flex;align-items:baseline;justify-content:space-between;gap:16px;
  padding:26px max(7vw,28px);flex-wrap:wrap}
header{border-bottom:1px solid #e8eaed}
footer{border-top:1px solid #e8eaed;color:#9aa1a9;font-size:13px}
.name{font-size:15px;font-weight:650;letter-spacing:-.01em}
.name span{color:#9aa1a9;font-weight:400;margin-left:10px;font-size:14px}
.meta{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:12.5px;
  color:#9aa1a9;display:flex;gap:22px}
main{flex:1;width:100%;max-width:1060px;margin:0 auto;padding:88px max(7vw,28px) 96px}
.overline{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:12px;
  color:#9aa1a9;letter-spacing:.14em;text-transform:uppercase}
h1{margin-top:20px;font-size:clamp(34px,4.6vw,54px);font-weight:600;line-height:1.14;
  letter-spacing:-.028em;max-width:760px;text-wrap:balance}
.sub{margin-top:22px;font-size:17px;color:#6b7280;max-width:600px}
.status{margin-top:44px;font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-size:13px;color:#6b7280;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.dot.ok{background:#1a7f37}.dot.warn{background:#9a6700}.dot.bad{background:#cf222e}
.status b{color:#14171a;font-weight:600}
section{margin-top:88px}
h2{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:500;
  color:#9aa1a9;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px}
.mechs{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));column-gap:56px}
.mech{padding:26px 0 22px;border-top:1px solid #e8eaed}
.mech .idx{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#c3c9cf}
.mech h3{margin-top:8px;font-size:16px;font-weight:600;letter-spacing:-.01em}
.mech p{margin-top:6px;font-size:14px;color:#6b7280;max-width:46ch}
.links{display:flex;gap:28px;flex-wrap:wrap;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:13.5px}
.diag{margin-top:40px;padding:22px 26px;border-radius:12px;background:#f6f8fa;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:12.5px;
  line-height:1.9;color:#6b7280;white-space:pre-wrap;word-break:break-all}
.diag b{color:#14171a;font-weight:600}
table{width:100%;border-collapse:collapse}
th{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:500;
  color:#9aa1a9;letter-spacing:.1em;text-transform:uppercase;text-align:left;padding:0 16px 12px 0}
td{padding:18px 16px 18px 0;border-top:1px solid #e8eaed;vertical-align:baseline}
td:first-child{width:42%}
td code{font-size:13.5px;background:none;padding:0}
td .hint{font-size:13px;color:#9aa1a9}
td .bound{color:#1a7f37;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px}
td .unbound{color:#cf222e;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px}
td .shards{margin-top:6px;font-size:12px;color:#9aa1a9;font-family:ui-monospace,"SF Mono",Menlo,monospace}
.caption{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:12px;
  color:#9aa1a9;margin:34px 0 10px}
pre{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;
  line-height:1.75;background:#f6f8fa;border-radius:12px;padding:24px 28px;overflow:auto;
  white-space:pre-wrap;word-break:break-all;color:#333}
.note{margin-top:36px;font-size:14px;color:#6b7280;max-width:640px}`;

const GH_LINK = `<a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>`;

function shell({ title, body, refresh }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="5">' : ''}
<title>${title}</title><style>${STYLES}</style></head>
<body>
<header>
  <div class="name">Smart AI Gateway<span>智能边缘网关</span></div>
  <div class="meta"><span>v${APP_META.version}</span>${GH_LINK}</div>
</header>
<main>${body}</main>
<footer>
  <span>isolate-local best-effort · 无数据库 · 无 KV 热路径</span>
  <span>Cloudflare Workers · <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">fongap/ai-gateway</a></span>
</footer>
</body></html>`;
}

const MECHANISMS = `
<div class="mechs">
  <div class="mech"><div class="idx">01</div><h3>多 Key 轮转</h3><p>同优先级 Key 按最久未用轮转摊流，配额均匀消耗，在第一个 429 出现之前完成预防。</p></div>
  <div class="mech"><div class="idx">02</div><h3>429 节点级冷却</h3><p>限流只处罚当前节点，秒级遵守 Retry-After，绝不扩大到整个 Provider 或资源池。</p></div>
  <div class="mech"><div class="idx">03</div><h3>熔断自恢复</h3><p>连续失败熔断，冷却期满单探测试探，成功即回池，失败再冷却，全程无需人工干预。</p></div>
  <div class="mech"><div class="idx">04</div><h3>三层资源池</h3><p>tier-1 / 2 / 3 硬优先级，各层各司其职：上层有可用节点时绝不消耗下层兜底。</p></div>
  <div class="mech"><div class="idx">05</div><h3>流式首事件守卫</h3><p>首个有效事件前可切换节点，之后绝不透明切换，已产生内容完整送达。</p></div>
  <div class="mech"><div class="idx">06</div><h3>并发摊布</h3><p>槽位原子领取，瞬时高并发分散到全部可用节点，饱和时以 503 + Retry-After 规范退避。</p></div>
</div>`;

function statusLine(config) {
  const dot = { ready: 'ok', degraded: 'warn' }[config.status] || 'bad';
  return `<div class="status"><span class="dot ${dot}"></span><b>${config.status}</b><span>·</span>nodes ${config.nodesUsable}/${config.nodesTotal}<span>·</span>openai + anthropic<span>·</span>isolate-local</div>`;
}

export function dashboardResponse(request, env) {
  const config = loadGatewayConfig(env);
  if (!config.ready) return setupResponse(config);

  const diagHtml = config.diagnostics.length === 0
    ? ''
    : `<div class="diag"><b>配置诊断</b>\n${config.diagnostics.map((d) => escapeHtml(d)).join('\n')}</div>`;

  const body = `
<div class="overline">Smart AI Gateway · AI 聚合网关</div>
<h1>节点各司其职，<br>端点始终稳定。</h1>
<p class="sub">多 API、多 Key、多模型统一接入。轮转、冷却、熔断、分层兜底——每个节点在自己的位置上发挥最大作用，客户端只看到一个端点。</p>
<div style="margin-top:52px">${statusLine(config)}</div>
${diagHtml}
<section>
  <h2>机制</h2>
  ${MECHANISMS}
</section>
<section>
  <h2>诊断端点（需鉴权）</h2>
  <div class="links"><a href="/health">/health</a><a href="/metrics">/metrics</a><a href="/v1/models">/v1/models</a><a href="/version">/version</a></div>
</section>`;
  return htmlResponse(shell({ title: 'Smart AI Gateway · 智能边缘网关', body }));
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function setupResponse(config) {
  const { bindings, diagnostics, status } = config;
  const accessKeyBound = Boolean(config.accessKeyBound);

  const diagHtml = diagnostics.length === 0
    ? ''
    : `<div class="diag"><b>配置诊断</b>\n${config.diagnostics.map((d) => escapeHtml(d)).join('\n')}</div>`;

  const statusHint = status === 'unconfigured'
    ? '关键配置尚未绑定齐全。'
    : status === 'invalid'
      ? '配置存在但无法构造任何可用节点，请按上方诊断修复。'
      : '';

  const body = `
<div class="overline">初始化 / Setup</div>
<h1>等待完成配置。</h1>
<p class="sub">代码已正常运行；补齐以下配置后网关即可用。本版本为 Breaking Change 配置格式，请按新 schema 重新配置。${statusHint}</p>
<div style="margin-top:52px">${statusLine(config)}</div>
${diagHtml}
<section>
  <h2>绑定状态（实时检测）</h2>
  <table>
    <tr><th>配置项</th><th>状态</th></tr>
    <tr><td><code>GATEWAY_ACCESS_KEY</code><div class="hint">Secret · 客户端访问密钥</div></td>
        <td>${accessKeyBound ? '<span class="bound">已配置</span>' : '<span class="unbound">未配置</span>'}</td></tr>
    <tr><td><code>TIER1/2/3_NODES_CONFIG_XX</code><div class="hint">Variables · JSON 数组 · 不含密钥${bindings.tierShards.length ? `<div class="shards">${bindings.tierShards.map((k) => escapeHtml(k)).join(' · ')}</div>` : ''}</div></td>
        <td>${bindings.tierShards.length ? `<span class="bound">已绑定 ×${bindings.tierShards.length}</span>` : '<span class="unbound">未绑定</span>'}</td></tr>
    <tr><td><code>NODE_SECRETS_XX</code><div class="hint">Secrets · { "node-id": "credential" }${bindings.secretShards.length ? `<div class="shards">${bindings.secretShards.map((k) => escapeHtml(k)).join(' · ')}</div>` : ''}</div></td>
        <td>${bindings.secretShards.length ? `<span class="bound">已绑定 ×${bindings.secretShards.length}</span>` : '<span class="unbound">未绑定</span>'}</td></tr>
  </table>
  ${diagHtml}
</section>
<section>
  <h2>配置示例（多 Key / 多账户 / 多模型）</h2>
  <div class="caption">TIER1_NODES_CONFIG_01 · 普通变量</div>
  <pre>[
  {"id":"nvidia-01","provider":"nvidia","base_url":"https://integrate.api.nvidia.com/v1",
   "priority":10,"models":{"general-air":"deepseek-ai/deepseek-v3.1","code-pro":"qwen/qwen3-coder-480b"},
   "limits":{"concurrency":3,"rpm":40}},
  {"id":"nvidia-02","provider":"nvidia","base_url":"https://integrate.api.nvidia.com/v1",
   "priority":10,"models":{"general-air":"deepseek-ai/deepseek-v3.1"},"limits":{"concurrency":3,"rpm":40}},
  {"id":"glm-01","provider":"zhipu","base_url":"https://open.bigmodel.cn/api/paas/v4",
   "priority":20,"models":{"code-max":"glm-4.7"},"limits":{"concurrency":2}}
]</pre>
  <div class="caption">NODE_SECRETS_01 · Secret</div>
  <pre>{"nvidia-01":"nvapi-xxx","nvidia-02":"nvapi-yyy","glm-01":"zzzz.id"}</pre>
  <p class="note">同层同 priority 的 key 会被 LRU 轮转摊流；不同 priority 严格先后；想省用的键放更低 tier。页面只显示变量名是否绑定，不读取任何 Secret 内容。保存后每 5 秒自动刷新。完整示例见 <a href="${GITHUB_URL}/tree/main/config" target="_blank" rel="noopener noreferrer">config/</a>。</p>
</section>`;
  return htmlResponse(shell({ title: 'Smart AI Gateway · 初始化', body, refresh: true }));
}
