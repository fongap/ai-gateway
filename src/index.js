/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Fongap Studio
 *
 * AI Agent Node Scheduler
 *
 * Personal AI Agent 资源调度层。以 free-node / paid-node / plus-node 三层节点池
 * 管理多个 OpenAI 兼容上游，为 Coding Agent、办公 Agent 与本地 AI 应用提供
 * 低成本、高可靠、可自动故障切换的统一入口。双协议接入 OpenAI / Anthropic。
 *
 * 架构：
 *   Logical Model (MODELS_CONFIG)
 *       ↓
 *   Policy (POLICIES_CONFIG)
 *       ↓
 *   Node Scheduler（workload → model → tier → priority → cooldown → circuit → concurrency → health → latency）
 *       ↓
 *   Node Pool (NODES_CONFIG)
 *       ↓
 *   Provider / Account / API Key (secret_ref 环境变量，Token@BaseURL 格式)
 *
 * 部署清单：
 * 1. 将 GATEWAY_ACCESS_KEY 设置为 Secret。
 * 2. 将 NODES_CONFIG 设置为 Secret（JSON 数组，定义节点）。
 * 3. 为每个节点的 secret_ref 添加凭据环境变量。
 * 4. 可选设置 MODELS_CONFIG 与 POLICIES_CONFIG；未设置时使用默认策略。
 * 5. 部署后使用 GATEWAY_ACCESS_KEY 访问 /health，确认节点状态。
 *
 * 核心配置：
 * - GATEWAY_ACCESS_KEY         : 客户端访问网关的鉴权密钥（必需）
 * - NODES_CONFIG               : JSON 数组，定义 free/paid/tier-3 节点（必需）
 * - MODELS_CONFIG              : JSON 对象，逻辑模型到 workload/policy 的映射（可选）
 * - POLICIES_CONFIG            : JSON 对象，策略 tiers/max_attempts/retry_budget（可选）
 * - FREE_NODE_01 等            : 节点 secret_ref 指向的凭据环境变量（必需）
 *
 * 运行保护：
 * - REQUEST_TIMEOUT_MS         : 上游首字节超时；默认 180000，范围 5000-180000
 * - MAX_BODY_BYTES             : OpenAI 请求体上限；默认 20 MiB
 * - AUTH_FAIL_COOLDOWN_MS      : 401/403 冷却；默认 86400000
 * - RATE_LIMIT_COOLDOWN_MS     : 429 冷却；默认 60000（优先读取 Retry-After）
 * - ALLOWED_ORIGIN             : CORS 来源；默认 *
 * - ALLOW_UNSAFE_PROXY_ROUTES  : true 时允许白名单外路径；默认 false
 * - ALLOW_INSECURE_HTTP_UPSTREAM: true 时允许 HTTP 上游；默认 false
 *
 * 可靠性机制：
 * - 429 节点级冷却与同层 failover，不整个 Provider 禁用
 * - 502/503/504 连续 3 次触发轻量 Circuit Breaker（30 秒）
 * - 流式请求 First Event Guard：首个有效事件前允许 failover，之后禁止透明切换
 * - Retry Budget：分层预算总计不超过 5 次
 * - 客户端取消不处罚节点健康分
 *
 * 其他配置：
 * - ANTHROPIC_MAX_BODY_BYTES   : Anthropic 请求体上限；默认 20 MiB
 * - ANTHROPIC_COUNT_TOKENS_MODE: approximate/disabled；默认 approximate
 * - ANTHROPIC_REASONING_REQUEST_MODE: none/reasoning_effort/chat_template_kwargs/thinking
 * - FAKE_STREAM_PROTECTION     : 非流式请求转上游流式并重组；默认 false
 * - CACHE_ENABLED / CACHE_MAX_AGE_SEC / CACHE_MAX_BODY_BYTES
 * - LOG_LEVEL                  : none/error/info/debug；默认 info
 * - EXPOSE_UPSTREAM_INFO       : true 时在诊断中暴露上游信息；默认 false
 * - PROJECT_REPOSITORY_URL     : 可选 HTTPS 源码地址；用于状态页与 /version
 * - AE_DATASET                 : 可选 Workers Analytics Engine binding
 *
 * 内置端点：
 * - GET /version              : 公开的项目版本信息
 * - GET /v1/models            : 已配置的逻辑模型列表；需要网关鉴权
 * - GET /health               : 当前 isolate 的节点健康快照
 * - GET /metrics              : 当前 isolate 的 Prometheus 指标
 * - POST /v1/chat/completions  : OpenAI Chat Completions
 * - POST /v1/messages          : Anthropic Messages
 *
 * 运行边界：健康分、并发和冷却状态保存在当前 isolate 内存中，
 * 不使用 KV/D1/Durable Objects，不代表跨全部边缘节点的严格全局状态。
 */

import { buildRoutePlan, getConfiguredNodes } from './scheduler/router.js';
import { resolveUpstreamModel } from './config/nodes.js';
import { isCoolingDown as isNodeCoolingDown, isCircuitOpen as isNodeCircuitOpen, getNodeState as getNodeRuntimeState, recordRequestStart as recordNodeStart, recordSuccess as recordNodeSuccess, recordFailure as recordNodeFailure, recordNeutralEnd as recordNodeNeutralEnd, checkCleanup as checkNodeCleanup, nextCooldownMs as nextNodeCooldownMs, getRetryAfterMs } from './config/node-state.js';
import { recordCircuitFailure, recordCircuitSuccess } from './reliability/circuit.js';

const APP_META = Object.freeze({
  name: 'AI Agent Node Scheduler',
  displayName: 'AI Agent Node Scheduler',
  version: '5.14.0',
});

// ============ 管理首页 ============
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>AI Agent Node Scheduler</title>
<style>
:root{--brand:#48636f;--bg:#fff;--text:#111827;--muted:#59636e;--line:#e4e8eb;--font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.7;overflow-x:hidden}header{position:fixed;inset:0 0 auto;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 max(5%,24px);background:rgba(255,255,255,.88);backdrop-filter:blur(16px);border-bottom:1px solid var(--line);z-index:100}.brand{display:flex;align-items:center;gap:11px;font-size:17px;font-weight:650}.brand-icon{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:var(--brand);box-shadow:0 6px 18px rgba(72,99,111,.22)}main{padding-top:64px;min-height:100vh}.doc-container{max-width:960px;margin:0 auto;padding:48px max(5%,24px) 96px}.hero h1{font-size:28px;font-weight:700;letter-spacing:-.02em;margin:0 0 12px}.hero p{font-size:16px;color:var(--muted);max-width:640px}.tags{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 0}.tag{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#f7f9fa;color:var(--muted);border:1px solid var(--line)}.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr;align-items:center;gap:12px;margin:24px 0;padding:17px 20px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(180deg,#fff,#f7f9fa)}.flow-node{text-align:center}.flow-node strong{display:block;font-size:13px}.flow-node small{display:block;margin-top:2px;color:var(--muted);font-size:11px}.flow-arrow{color:var(--brand);font-weight:800}.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:48px}.stat-card{padding:20px;border:1px solid var(--line);border-radius:12px}.stat-card .label{font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted);margin-bottom:6px}.stat-card .value{font-size:28px;font-weight:700}.section{margin-bottom:48px}.section h2{font-size:16px;font-weight:600;margin:0 0 12px}.node-list{display:grid;gap:8px}.step-list{counter-reset:step;margin-top:18px}.step-item{position:relative;padding:0 0 22px 48px}.step-item:last-child{padding-bottom:6px}.step-item:before{counter-increment:step;content:counter(step);position:absolute;left:0;top:0;width:30px;height:30px;display:grid;place-items:center;border-radius:9px;background:var(--brand);color:#fff;font-size:13px;font-weight:750;box-shadow:0 7px 17px rgba(72,99,111,.18)}.step-item:after{content:"";position:absolute;left:14px;top:36px;bottom:5px;width:1px;background:var(--line)}.step-item:last-child:after{display:none}.step-item h4{margin-bottom:5px;color:var(--text);font-size:15px}.step-item p{margin:0;color:var(--muted);font-size:13.5px}.code-editor{margin:17px 0;border:1px solid #2b3035;border-radius:11px;overflow:hidden;background:#171a1d;box-shadow:0 18px 55px rgba(17,24,39,.07)}.code-header{height:38px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#202429;border-bottom:1px solid #30353a}.mac-dot{width:9px;height:9px;border-radius:50%}.dot-r{background:#ff605c}.dot-y{background:#ffbd44}.dot-g{background:#00ca4e}.code-header span{margin-left:7px;color:#939aa3;font-family:var(--mono);font-size:11px}.code-editor pre{margin:0;padding:19px 20px;overflow:auto;color:#d7dce2;font-family:var(--mono);font-size:12.5px;line-height:1.68;tab-size:2}.kw{color:#79b8ff}.str{color:#e6a57e}.brand-str{color:#92c5d6}.fun{color:#e4d28b}.var{color:#9cc7f1}.callout{margin:16px 0;padding:15px 17px;border:1px solid rgba(72,99,111,.18);border-left:3px solid var(--brand);border-radius:10px;background:rgba(72,99,111,.08);color:var(--muted)}.callout strong{display:block;margin-bottom:3px;color:var(--text)}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-bottom:8px}.mini-card{padding:20px;border:1px solid var(--line);border-radius:12px;background:#fff}.mini-card h3{margin-bottom:7px;color:var(--text);font-size:16px}.mini-card p{margin:0;color:var(--muted);font-size:13.5px}.node-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border:1px solid var(--line);border-radius:10px;font-size:14px}.node-id{font-weight:600;font-family:var(--mono);font-size:13px}.tier-badge{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}.tier-1{background:#e8f5e9;color:#2e7d32}.tier-2{background:#e3f2fd;color:#1565c0}.tier-3{background:#fce4ec;color:#c62828}.model-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}.model-badge{padding:2px 8px;border-radius:4px;font-size:12px;font-family:var(--mono);background:#f7f9fa;border:1px solid var(--line);color:var(--muted)}.endpoints{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}.endpoint{display:flex;align-items:center;gap:6px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;transition:.2s ease;background:#fff}.endpoint:hover{border-color:var(--brand);background:rgba(72,99,111,.08);color:var(--brand)}footer{margin-top:64px;padding-top:24px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}@media(max-width:760px){header{height:56px;padding:0 18px}.brand{font-size:15px}.doc-container{padding:48px 20px 50px}.flow{grid-template-columns:1fr;padding:15px}.flow-arrow{transform:rotate(90deg)}.stats-grid{grid-template-columns:1fr 1fr}.section{margin-bottom:40px}}
</style>
</head>
<body>
<header>
  <div class="brand"><span class="brand-icon"></span>AI Agent Node Scheduler</div>
  <a href="{{PROJECT_REPOSITORY_URL}}" target="_blank" rel="noopener noreferrer" class="source-link" aria-label="查看源码"><span>源码</span></a>
</header>
<main><div class="doc-container">
  <section class="hero">
    <h1>AI Agent Node Scheduler</h1>
    <p>Personal AI Agent 资源调度层。以 tier-1 / tier-2 / tier-3 三层节点模型管理多个 AI 服务商资源，为 Agent 提供低成本、高可靠、可自动故障切换的统一入口。双协议接入，支持 OpenAI 与 Anthropic。</p>
    <div class="tags">
      <span class="tag">Version {{VERSION}}</span>
      <span class="tag">Cloudflare Workers</span>
      <span class="tag">双协议接入 OpenAI / Anthropic</span>
    </div>
  </section>
  <section class="section">
    <h2>调度流程</h2>
    <div class="flow">
      <div class="flow-node"><strong>Client</strong><small>OpenAI / Anthropic</small></div>
      <div class="flow-arrow">→</div>
      <div class="flow-node"><strong>Model</strong><small>逻辑模型映射</small></div>
      <div class="flow-arrow">→</div>
      <div class="flow-node"><strong>Policy</strong><small>策略选择</small></div>
      <div class="flow-arrow">→</div>
      <div class="flow-node"><strong>Node Pool</strong><small>tier-1 / tier-2 / tier-3</small></div>
    </div>
  </section>
  <section class="section" id="config">
    <h2>配置范例</h2>
    <p style="font-size:14px;color:var(--muted);margin:0 0 16px">按层级分别配置 Secret，每层一个 JSON 数组。节点中的 <code>tier</code> 字段由配置文件名隐含（tier-1 层自动为 tier-1 节点，依此类推）。</p>

    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>TIER1_NODES_CONFIG</span></div>
      <pre>[
  {
    "id": "tier-1-node-01",
    "secret_ref": "FREE_NODE_01",
    "models": {
      "general-air": "free-provider/model-air",
      "code-pro": "free-provider/code-pro"
    }
  }
]</pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>TIER2_NODES_CONFIG</span></div>
      <pre>[
  {
    "id": "tier-2-node-01",
    "secret_ref": "PAID_NODE_01",
    "models": {
      "code-pro": "paid-provider/code-pro"
    }
  }
]</pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>TIER3_NODES_CONFIG</span></div>
      <pre>[
  {
    "id": "tier-3-node-01",
    "secret_ref": "PLUS_NODE_01",
    "models": {
      "code-max": "plus-provider/code-max"
    }
  }
]</pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>节点凭据</span></div>
      <pre><span class="var">FREE_NODE_01</span>=<span class="str">sk-xxx@https://free-api.example/v1</span>
<span class="var">PAID_NODE_01</span>=<span class="str">sk-yyy@https://paid-api.example/v1</span>
<span class="var">PLUS_NODE_01</span>=<span class="str">sk-zzz@https://plus-api.example/v1</span></pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>MODELS_CONFIG（可选）</span></div>
      <pre>{
  "general-air": { "workload": "general", "policy": "general-fast" },
  "code-pro":    { "workload": "coding",  "policy": "coding-stable" }
}</pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>POLICIES_CONFIG（可选）</span></div>
      <pre>{
  "general-fast": {
    "tiers": ["tier-1", "tier-2"],
    "max_attempts": 3,
    "retry_budget": { "free": 2, "paid": 1 }
  }
}</pre>
    </div>
    <div class="callout"><strong>调度顺序</strong>默认 tier-1 → tier-2 → tier-3。429 节点级冷却不整个 Provider 禁用；503 连续 3 次触发轻量熔断（30 秒）；流式请求首事件前允许 failover，之后禁止透明重放。</div>
  </section>

  <section class="section" id="clients">
    <h2>客户端接入</h2>
    <div class="grid-2">
      <div class="mini-card"><h3>OpenAI 兼容客户端</h3><p>Base URL 使用网关地址的 <code>/v1</code>，接口路径为 <code>/chat/completions</code>。</p></div>
      <div class="mini-card"><h3>Claude Code</h3><p><code>ANTHROPIC_BASE_URL</code> 只填写网关地址，不需要 <code>/v1</code> 后缀。</p></div>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>OpenAI cURL</span></div>
      <pre><span class="fun">curl</span> https://YOUR-WORKER.workers.dev/v1/chat/completions \\
  -H <span class="str">"Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"</span> \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{"model":"general-air","messages":[{"role":"user","content":"Hello"}]}'</span></pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>Claude Code settings.json</span></div>
      <pre>{
  <span class="str">"env"</span>: {
    <span class="str">"ANTHROPIC_BASE_URL"</span>: <span class="brand-str">"https://YOUR-WORKER.workers.dev"</span>,
    <span class="str">"ANTHROPIC_AUTH_TOKEN"</span>: <span class="brand-str">"your-gateway-access-key"</span>,
    <span class="str">"ANTHROPIC_MODEL"</span>: <span class="brand-str">"code-pro"</span>
  }
}</pre>
    </div>
  </section>

  <section class="section">
    <h2>节点概览</h2>
    <div class="stats-grid" id="stats"></div>
    <div class="node-list" id="node-list"></div>
  </section>
  <section class="section">
    <h2>模型列表</h2>
    <div class="model-list" id="model-list"></div>
  </section>
  <section class="section">
    <h2>诊断端点</h2>
    <div class="endpoints">
      <a class="endpoint" href="/health">/health</a>
      <a class="endpoint" href="/version">/version</a>
      <a class="endpoint" href="/v1/models">/v1/models</a>
      <a class="endpoint" href="/metrics">/metrics</a>
    </div>
  </section>
  <footer><p>AI Agent Node Scheduler · 运行状态仅限当前 isolate · 无数据库 · 无 KV 热路径</p></footer>
</div></main>
<script>
(async function(){
  try {
    const h = await fetch('/health');
    const j = await h.json();
    const eps = j.endpoints || [];
    const active = eps.filter(e => e.status === 'active').length;
    const s = document.getElementById('stats');
    s.innerHTML = '<div class="stat-card"><div class="label">端点总数</div><div class="value">' + eps.length + '</div></div><div class="stat-card"><div class="label">活跃</div><div class="value">' + active + '</div></div><div class="stat-card"><div class="label">冷却中</div><div class="value">' + (eps.length - active) + '</div></div><div class="stat-card"><div class="label">客户端请求</div><div class="value">' + (j.client_stats ? j.client_stats.requests_total : 0) + '</div></div>';
    const nl = document.getElementById('node-list');
    nl.innerHTML = eps.map(e => '<div class="node-item"><span class="node-id">' + e.id + '</span><span>health: ' + e.health_score + '</span><span>active: ' + e.active_requests + '</span><span style="font-size:12px;color:var(--muted)">' + e.status + '</span></div>').join('');
  } catch(e) {
    document.getElementById('stats').innerHTML = '<div class="stat-card"><div class="label">状态</div><div class="value">需鉴权</div></div>';
  }
  const ml = document.getElementById('model-list');
  try {
    const mr = await fetch('/v1/models', {headers:{Authorization:'Bearer dev'}});
    if (mr.ok) { const mj = await mr.json(); if (mj.data) ml.innerHTML = mj.data.map(m => '<span class="model-badge">' + m.id + '</span>').join(''); }
    else { ml.innerHTML = '<span style="font-size:13px;color:var(--muted)">需要有效的 GATEWAY_ACCESS_KEY</span>'; }
  } catch(e) { ml.innerHTML = '<span style="font-size:13px;color:var(--muted)">模型列表需要鉴权</span>'; }
})();
</script>
</body>
</html>`;

function getDashboardHtml(env) {
  const configuration = getGatewayConfigurationState(env);
  if (!configuration.ready) return getSetupHtml(configuration);

  const repositoryUrl = readProjectRepositoryUrl(env);
  let content = DASHBOARD_HTML.replace('{{VERSION}}', APP_META.version);
  const sourceLink = /<a href="\{\{PROJECT_REPOSITORY_URL\}\}"[^>]*class="source-link"[^>]*>[\s\S]*?<\/a>/;
  content = repositoryUrl
    ? content.replace('{{PROJECT_REPOSITORY_URL}}', escapeHtmlAttribute(repositoryUrl))
    : content.replace(sourceLink, '');
  return content;
}

function getGatewayConfigurationState(env) {
  const gatewayAccessKeyBound = Boolean(readOptionalEnv(env, 'GATEWAY_ACCESS_KEY'));
  const nodesConfigBound = Boolean(readOptionalEnv(env, 'NODES_CONFIG') || readOptionalEnv(env, 'TIER1_NODES_CONFIG') || readOptionalEnv(env, 'TIER2_NODES_CONFIG') || readOptionalEnv(env, 'TIER3_NODES_CONFIG'));
  return {
    ready: gatewayAccessKeyBound && nodesConfigBound,
    gatewayAccessKeyBound,
    nodesConfigBound,
  };
}

function getSetupHtml(configuration) {
  const status = (configured) => configured
    ? '<span class="status ready">已配置</span>'
    : '<span class="status pending">待配置</span>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta http-equiv="refresh" content="5">
<title>AI Agent Node Scheduler · 初始化</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#172126;background:#f4f7f8}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}.card{width:min(680px,100%);padding:36px;border:1px solid #dce4e7;border-radius:18px;background:#fff;box-shadow:0 20px 60px rgba(27,48,58,.1)}.mark{width:48px;height:48px;display:grid;place-items:center;border-radius:14px;background:#48636f;color:#fff;font-size:24px}h1{margin:22px 0 8px;font-size:28px;letter-spacing:-.02em}p{margin:0;color:#66747b;line-height:1.75}.success{margin:22px 0;padding:14px 16px;border:1px solid #cde8d3;border-radius:12px;background:#f1faf3;color:#28723a}.list{margin:20px 0;display:grid;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border:1px solid #e2e8ea;border-radius:12px}.row code{font-size:13px;overflow-wrap:anywhere}.status{flex:none;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}.ready{background:#e9f7ed;color:#26713a}.pending{background:#fff3db;color:#995f00}.code-editor{margin:16px 0;border:1px solid #2b3035;border-radius:11px;overflow:hidden;background:#171a1d}.code-header{height:36px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#202429;border-bottom:1px solid #30353a}.code-header span{margin-left:7px;color:#939aa3;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px}.code-editor pre{margin:0;padding:14px 16px;overflow:auto;color:#d7dce2;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12.5px;line-height:1.68;white-space:pre-wrap;word-break:break-all}.str{color:#e6a57e}.note{margin-top:18px;font-size:13px}.actions{display:flex;align-items:center;gap:14px;margin-top:22px}.button{display:inline-block;padding:10px 16px;border-radius:10px;background:#48636f;color:#fff;text-decoration:none;font-weight:700}.auto{font-size:13px;color:#76838a}@media(max-width:560px){.card{padding:24px}.row{align-items:flex-start;flex-direction:column;gap:8px}h1{font-size:24px}}
</style>
</head>
<body>
<main class="card">
  <div class="mark">✓</div>
  <h1>Worker 已部署，等待完成配置</h1>
  <p>代码已经正常运行。添加以下配置后，网关会进入可用状态。</p>
  <div class="success">首次部署成功，无需重新修改或上传源代码。</div>
  <div class="list">
    <div class="row"><code>GATEWAY_ACCESS_KEY</code>${status(configuration.gatewayAccessKeyBound)}</div>
    <div class="row"><code>TIER1_NODES_CONFIG</code> + <code>TIER2_NODES_CONFIG</code> + <code>TIER3_NODES_CONFIG</code> / <code>NODES_CONFIG</code>${status(configuration.nodesConfigBound)}</div>
  </div>
  <div class="steps">
    <strong>在 Cloudflare 中完成配置</strong>
    <p style="font-size:13px;color:var(--muted);margin:5px 0 0">添加以下 5 个 Secret，全部为机密变量，不会出现在代码或日志中。</p>
    <div class="list" style="margin-top:14px">
      <div class="row"><code>GATEWAY_ACCESS_KEY</code>${status(configuration.gatewayAccessKeyBound)}</div>
      <div class="row"><code>TIER1_NODES_CONFIG</code>${status(configuration.nodesConfigBound)}</div>
      <div class="row"><code>TIER1_NODE_01</code>${status(Boolean(configuration.gatewayAccessKeyBound))}</div>
    </div>
    <div class="code-editor" style="margin:16px 0 0">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>GATEWAY_ACCESS_KEY</span></div>
      <pre><span class="str">your-random-access-key-here</span></pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>TIER1_NODES_CONFIG</span></div>
      <pre>[{"id":"tier-1-node-01","secret_ref":"TIER1_NODE_01","models":{"general-air":"your-provider/model","code-pro":"your-provider/code-model"}}]</pre>
    </div>
    <div class="code-editor">
      <div class="code-header"><i class="mac-dot dot-r"></i><i class="mac-dot dot-y"></i><i class="mac-dot dot-g"></i><span>TIER1_NODE_01</span></div>
      <pre><span class="str">your-api-token@https://your-api-endpoint/v1</span></pre>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-top:12px;line-height:1.6">可选：<code>TIER2_NODES_CONFIG</code> + <code>TIER2_NODE_01</code> 增加第二层回退节点；<code>MODELS_CONFIG</code> 定义逻辑模型映射；<code>POLICIES_CONFIG</code> 控制重试预算。保存后页面自动刷新。</p>
  </div>
  <p class="note">页面只显示是否已绑定，不会读取或显示 Secret 内容。</p>
  <div class="actions"><a class="button" href="/">立即检查</a><span class="auto">每 5 秒自动检查一次</span></div>
</main>
</body>
</html>`;
}

// ============ 运行参数 ============

const RETRYABLE_STATUS = new Set([401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504]);
const NON_HEALTH_IMPACT_STATUS = new Set([404]);

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;
// 默认请求体上限。较大 JSON 会产生额外内存副本，部署后按实际负载谨慎上调。
const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4096;
// 限制单次请求的主端点尝试次数，避免上游故障时放大延迟。
const DEFAULT_PRIMARY_MAX_ATTEMPTS = 3;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL_LIST_MAX_ATTEMPTS = 3;
const DEFAULT_MODEL_LIST_MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_AUTH_FAIL_COOLDOWN = 86_400_000;
const DEFAULT_RATE_LIMIT_COOLDOWN = 60_000;

const DEFAULT_PRIMARY_ROTATION_WINDOW_MS = 60_000;
const DEFAULT_PRIMARY_ROTATION_MAX_PER_WINDOW = 30;
// 限制单端点并发，避免瞬时流量集中。
const DEFAULT_PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT = 2;


const HEALTH_SCORE_INITIAL = 50;
const HEALTH_SCORE_MIN = 1;
const HEALTH_SCORE_MAX = 100;
const HEALTH_SCORE_SUCCESS_GAIN = 3;
const HEALTH_SCORE_COOLDOWN_RECOVERY = 10;
const LATENCY_EWMA_ALPHA = 0.3;
const MAX_EXPONENTIAL_BACKOFF_MULTIPLIER = 8;
const MAX_STATE_ENTRIES = 256;

const RING_BUFFER_MIN_SIZE = 200;
const CLEANUP_INTERVAL_MS = 30_000;

const LOG_LEVELS = { none: 0, error: 1, info: 2, debug: 3 };

const ASSEMBLE_TIMEOUT_MS = 180_000;
const FIRST_EVENT_TIMEOUT_DEFAULT = 60_000;
const MAX_SAFE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_UPSTREAM_JSON_BYTES = 20 * 1024 * 1024;


// ============ 请求体限制 ============

class BodyTooLargeError extends Error {
  constructor(message) {
    super(message || 'Request body exceeds limit.');
    this.name = 'BodyTooLargeError';
  }
}

// ============ Isolate 内运行状态 ============
const gatewayStats = {
  startedAt: Date.now(),
  clientRequests: 0,
  clientSuccesses: 0,
  clientFailures: 0,
  clientActiveRequests: 0,
  clientCancellations: 0,
  fallbackActivations: 0,
  fallbackSuccesses: 0,
};

// ============ 请求入口 ============

async function handleRequest(request, env, ctx) {
    const logger = getLogger(env);
    const requestId = crypto.randomUUID();
    const requestUrl = new URL(request.url);
    const normalizedPath = normalizeGatewayPath(requestUrl.pathname);
    const route = detectGatewayRoute(request.method, normalizedPath);
    const isAnthropicClient = route === 'anthropic_messages' || route === 'anthropic_count_tokens';

    checkNodeCleanup();

    if (request.method === 'OPTIONS') {
      const intendedMethod = request.headers.get('Access-Control-Request-Method') || 'POST';
      const allowUnsafeProxyRoutes = readBooleanEnv(env, 'ALLOW_UNSAFE_PROXY_ROUTES', false);
      if (!allowUnsafeProxyRoutes && !isSupportedGatewayRoute(intendedMethod, normalizedPath)) {
        return new Response(null, { status: 404, headers: corsHeaders(request, env) });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === 'GET' && normalizedPath === '/' && acceptsHtml(request)) {
      return html(getDashboardHtml(env));
    }

    if (request.method === 'GET' && normalizedPath === '/version') {
      return versionResponse(request, env);
    }

    const expectedGatewayAccessKey = readOptionalEnv(env, 'GATEWAY_ACCESS_KEY');
    if (!expectedGatewayAccessKey) {
      return gatewayError(request, env, isAnthropicClient, 500,
        'Gateway misconfigured: GATEWAY_ACCESS_KEY is not set.', undefined, requestId);
    }

    const bearerKey = parseBearer(request.headers.get('Authorization'));
    const xApiKey = String(request.headers.get('x-api-key') || '').trim();
    const [bearerMatches, xApiKeyMatches] = await Promise.all([
      timingSafeEqual(bearerKey, expectedGatewayAccessKey),
      timingSafeEqual(xApiKey, expectedGatewayAccessKey),
    ]);
    if (!bearerMatches && !xApiKeyMatches) {
      return gatewayError(request, env, isAnthropicClient, 401,
        'Unauthorized: gateway access key is invalid or missing.', undefined, requestId);
    }

    const allowUnsafeProxyRoutes = readBooleanEnv(env, 'ALLOW_UNSAFE_PROXY_ROUTES', false);
    if (!allowUnsafeProxyRoutes && !isSupportedGatewayRoute(request.method, normalizedPath)) {
      return gatewayError(request, env, isAnthropicClient, 404,
        'Route not found or not allowed by the gateway route policy.', {
          method: request.method,
          path: requestUrl.pathname,
        }, requestId);
    }

    if (request.method === 'GET' && normalizedPath === '/health') {
      return await healthCheck(request, env, requestId);
    }

    if (request.method === 'GET' && normalizedPath === '/metrics') {
      return await metricsCheck(request, env);
    }

    const maxBodyBytes = clampInt(
      readOptionalEnv(env, isAnthropicClient ? 'ANTHROPIC_MAX_BODY_BYTES' : 'MAX_BODY_BYTES'),
      1024,
      100 * 1024 * 1024,
      isAnthropicClient ? Math.min(DEFAULT_MAX_BODY_BYTES, 25 * 1024 * 1024) : DEFAULT_MAX_BODY_BYTES
    );
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > maxBodyBytes) {
      return gatewayError(request, env, isAnthropicClient, 413,
        'Request body exceeds limit.', undefined, requestId);
    }

    let originalBodyText = null;
    let originalBodyJson = null;
    let requestBodyBuffer = null;
    let bodyParsed = false;
    let targetWasNonStream = false;
    let isDirectStream = false;

    if (canHaveBody(request.method)) {
      const ct = (request.headers.get('content-type') || '').toLowerCase();
      const contentEncoding = (request.headers.get('content-encoding') || '').toLowerCase();
      const jsonRoute = route === 'openai_chat' || route === 'anthropic_messages' || route === 'anthropic_count_tokens';

      if (contentEncoding && contentEncoding !== 'identity') {
        return gatewayError(request, env, isAnthropicClient, 415,
          'Compressed request bodies are not supported by this gateway.', undefined, requestId);
      }

      try {
        if (jsonRoute) {
          if (!ct.includes('application/json')) {
            return gatewayError(request, env, isAnthropicClient, 415,
              'This endpoint requires Content-Type: application/json.', undefined, requestId);
          }
          originalBodyText = await readTextWithLimit(request, maxBodyBytes);
          try {
            originalBodyJson = JSON.parse(originalBodyText || '{}');
            bodyParsed = true;
          } catch (error) {
            return gatewayError(request, env, isAnthropicClient, 400,
              `Invalid JSON request body: ${error.message}`, undefined, requestId);
          }

          if (route === 'openai_chat') {
            const fakeStreamEnabled = readBooleanEnv(env, 'FAKE_STREAM_PROTECTION', false);
            if (fakeStreamEnabled && originalBodyJson.stream !== true) {
              targetWasNonStream = true;
              originalBodyJson.stream = true;
              originalBodyText = JSON.stringify(originalBodyJson);
            }
          }
        } else {
          requestBodyBuffer = createLimitedRequestBodyStream(request.body, maxBodyBytes);
          isDirectStream = Boolean(request.body);
        }
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return gatewayError(request, env, isAnthropicClient, 413,
            'Request body exceeds limit.', undefined, requestId);
        }
        throw error;
      }
    }

    if (route === 'anthropic_count_tokens') {
      const mode = (readOptionalEnv(env, 'ANTHROPIC_COUNT_TOKENS_MODE') || 'approximate').toLowerCase();
      if (!['approximate', 'disabled'].includes(mode)) {
        return anthropicErrorResponse(request, env, 500,
          'Gateway misconfigured: ANTHROPIC_COUNT_TOKENS_MODE must be approximate or disabled.',
          requestId, undefined, 'api_error');
      }
      if (mode === 'disabled') {
        return anthropicErrorResponse(request, env, 404,
          'Token counting is disabled on this gateway.', requestId,
          undefined, 'not_found_error');
      }
      const validationError = validateAnthropicCountTokensRequest(originalBodyJson);
      if (validationError) {
        return anthropicErrorResponse(request, env, 400, validationError, requestId,
          undefined, 'invalid_request_error');
      }
      const inputTokens = estimateAnthropicInputTokens(originalBodyJson || {});
      return new Response(JSON.stringify({ input_tokens: inputTokens }), {
        status: 200,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'cache-control': 'no-store',
          'x-request-id': requestId,
          ...corsHeaders(request, env),
        },
      });
    }

    if (route === 'anthropic_messages') {
      const validationError = validateAnthropicMessagesRequest(originalBodyJson);
      if (validationError) {
        return anthropicErrorResponse(request, env, 400, validationError, requestId,
          undefined, 'invalid_request_error');
      }
    }

    if (route === 'openai_chat') {
      const validationError = validateOpenAIChatRequest(originalBodyJson);
      if (validationError) {
        return gatewayError(request, env, false, 400, validationError, undefined, requestId);
      }
    }

    // 模型列表路由不依赖请求体，优先处理
    if (isModelsListRoute(request.method, normalizedPath)) {
      return modelsListResponse(request, env, requestId);
    }

    const requestedModel = originalBodyJson?.model || 'unknown';

    // 区分配置缺失（500）与节点暂不可用（429）
    const configuredNodes = getConfiguredNodes(env);
    if (configuredNodes.length === 0) {
      return gatewayError(request, env, isAnthropicClient, 500,
        'Gateway misconfigured: NODES_CONFIG is missing, invalid, or no node credentials are bound.',
        undefined, requestId);
    }

    let nodeEndpoints = buildNodeEndpoints(env, requestedModel, originalBodyJson);

    const cacheEnabled = readBooleanEnv(env, 'CACHE_ENABLED', false);
    const isStreamRequest = bodyParsed && originalBodyJson && originalBodyJson.stream === true;
    const cacheEligible = !isAnthropicClient
      && cacheEnabled
      && request.method === 'POST'
      && bodyParsed
      && !targetWasNonStream
      && !isStreamRequest;

    let cacheUrl = null;
    if (cacheEligible) {
      const cacheKeyStr = await generateCacheKey(originalBodyJson);
      if (cacheKeyStr) {
        cacheUrl = new Request(`https://internal.edge-gateway.cache/${cacheKeyStr}`, { method: 'GET' });
        const cachedResponse = await caches.default.match(cacheUrl);
        if (cachedResponse) {
          logger.debug('Cache HIT:', cacheKeyStr);
          const resp = cachedResponse.clone();
          const headers = new Headers(resp.headers);
          headers.set('x-edge-gateway-cache', 'HIT');
          return withCors(resp, request, env, headers);
        }
      }
    }

    const timeoutMs = clampInt(
      readOptionalEnv(env, 'REQUEST_TIMEOUT_MS'),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    );
    const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);

    const candidates = nodeEndpoints.filter(ep => {
      if (isNodeCoolingDown(ep.id)) return false;
      if (isNodeCircuitOpen(ep.id)) return false;
      const state = getNodeRuntimeState(ep.id);
      if (state.activeRequests >= (ep.limits?.concurrency || 2)) return false;
      return true;
    });

    if (candidates.length === 0) {
      const retryAfter = nextNodeCooldownMs(configuredNodes.map(ep => ep.id));
      return gatewayError(request, env, isAnthropicClient, 429,
        'All nodes are temporarily unavailable.', {
          retry_after_ms: retryAfter,
          nodes_total: configuredNodes.length,
          nodes_cooling: configuredNodes.filter(ep => isNodeCoolingDown(ep.id)).length,
          nodes_circuit_open: configuredNodes.filter(ep => isNodeCircuitOpen(ep.id)).length,
        }, requestId);
    }

    const attempts = [];
    const anthropicClientWantsStream = route === 'anthropic_messages' && originalBodyJson?.stream === true;

    for (let index = 0; index < candidates.length; index++) {
      const endpoint = candidates[index];
      recordNodeStart(endpoint.id);

      let targetUrl;
      let targetHost;
      let currentBody = requestBodyBuffer;
      const actualModel = resolveUpstreamModel(endpoint, requestedModel);
      const modelConfig = { model: actualModel };
      try {
        targetHost = new URL(endpoint.baseUrl).hostname;

        const upstreamRequestUrl = new URL(requestUrl.toString());
        if (route === 'openai_chat' || route === 'anthropic_messages') {
          upstreamRequestUrl.pathname = '/v1/chat/completions';
        }

        targetUrl = buildTargetUrl(upstreamRequestUrl, endpoint.baseUrl);

        if (route === 'anthropic_messages') {
          const openAIBody = anthropicToOpenAIRequest(originalBodyJson, modelConfig, env);
          openAIBody.model = actualModel;
          currentBody = JSON.stringify(openAIBody);
        } else if (originalBodyText !== null) {
          const outbound = bodyParsed && originalBodyJson
            ? { ...originalBodyJson, model: actualModel }
            : null;
          currentBody = outbound ? JSON.stringify(outbound) : originalBodyText;
        }
      } catch (e) {
        recordFailure(endpoint.id, 500, 5_000, 'Invalid Base URL or request conversion');
        attempts.push(await buildAttemptRecord({
          attempt: index + 1,
          status: 500,
          endpoint,
          error: `Gateway conversion error: ${e.message || String(e)}`,
          upstreamHost: targetHost || null,
          upstreamPath: null,
          exposeUpstreamInfo,
          endpointRole: endpoint.tier,
        }));
        continue;
      }

      const headers = buildStandardOpenAIHeaders(request, endpoint.token, requestId);
      const controller = new AbortController();
      let timeoutTriggered = false;
      let clientAbortTriggered = false;
      const timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, timeoutMs);
      const onClientAbort = () => {
        clientAbortTriggered = true;
        controller.abort();
      };
      let clientAbortListener = null;
      if (request.signal) {
        clientAbortListener = onClientAbort;
        if (request.signal.aborted) onClientAbort();
        else request.signal.addEventListener('abort', clientAbortListener, { once: true });
      }

      const requestStartTime = Date.now();
      try {
        let upstream = await fetch(targetUrl, {
          method: request.method,
          headers,
          body: currentBody,
          redirect: 'manual',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const elapsedMs = Date.now() - requestStartTime;

        if (upstream.ok || (upstream.status >= 400 && !RETRYABLE_STATUS.has(upstream.status))) {
          let isStreaming = isStreamingResponse(upstream);
          const extraHeaders = {
            'x-edge-gateway-attempts': String(index + 1),
            'x-edge-gateway-upstream-status': String(upstream.status),
            'x-edge-gateway-cache': 'MISS',
            'x-edge-gateway-node': endpoint.id,
            'x-edge-gateway-tier': String(endpoint.tier || ''),
            'x-request-id': requestId,
          };
          if (exposeUpstreamInfo) extraHeaders['x-edge-gateway-upstream-host'] = targetHost;

          // First Event Guard：流式响应在首个有效事件前允许 failover。
          // 仅用于 OpenAI 直通流；重组模式（targetWasNonStream）与 Anthropic 转换
          // （由转换层以 HTTP 200 + event:error 表达错误）跳过 guard。
          if (isStreaming && !targetWasNonStream && route === 'openai_chat') {
            try {
              upstream = await ensureFirstSseEvent(upstream, FIRST_EVENT_TIMEOUT_DEFAULT, request.signal);
              extraHeaders['x-edge-gateway-first-event'] = 'ok';
            } catch (e) {
              clearTimeout(timeoutId);
              if (request.signal && clientAbortListener) {
                request.signal.removeEventListener('abort', clientAbortListener);
              }
              recordFailure(endpoint.id, 504, 5_000, `first_event_${e.message}`);
              attempts.push(await buildAttemptRecord({
                attempt: index + 1,
                status: 504,
                endpoint,
                error: `First event guard failed: ${e.message}`,
                latencyMs: elapsedMs,
                upstreamHost: targetHost,
                upstreamPath: new URL(targetUrl).pathname,
                exposeUpstreamInfo,
                endpointRole: endpoint.tier,
              }));
              continue;
            }
          }

          if (route === 'anthropic_messages') {
            if (!upstream.ok) {
              if (request.signal && clientAbortListener) {
                request.signal.removeEventListener('abort', clientAbortListener);
              }
              const upstreamErrorText = await safeReadText(upstream);
              recordNeutralEnd(endpoint.id);
              return anthropicErrorResponse(
                request,
                env,
                upstream.status,
                extractUpstreamErrorMessage(upstreamErrorText) || `Upstream returned HTTP ${upstream.status}.`,
                requestId,
                exposeUpstreamInfo ? { upstream_url: new URL(targetUrl).toString() } : undefined,
                anthropicErrorTypeForStatus(upstream.status),
                extraHeaders
              );
            }

            if (env && env.AE_DATASET) {
              ctx.waitUntil(writeAnalytics(env, {
                endpointId: await fingerprint(endpoint.id),
                status: upstream.status,
                latencyMs: elapsedMs,
                attempt: index + 1,
                cacheStatus: 'MISS',
              }));
            }

            if (anthropicClientWantsStream) {
              let anthropicResponse;
              if (isStreaming) {
                anthropicResponse = transformOpenAIStreamToAnthropic(
                  upstream,
                  requestedModel,
                  requestId,
                  modelConfig,
                  request.signal,
                  clientAbortListener,
                  logger
                );
              } else {
                if (request.signal && clientAbortListener) {
                  request.signal.removeEventListener('abort', clientAbortListener);
                }
                const openAIData = await safeJsonResponse(upstream);
                const message = openAIToAnthropicMessage(openAIData, requestedModel, modelConfig);
                anthropicResponse = anthropicMessageToSseResponse(message);
              }
              return withCors(
                trackEndpointStream(anthropicResponse, endpoint.id, elapsedMs),
                request,
                env,
                extraHeaders
              );
            }

            if (request.signal && clientAbortListener) {
              request.signal.removeEventListener('abort', clientAbortListener);
            }
            let openAIData;
            if (isStreaming) {
              openAIData = await collectOpenAIStream(upstream, request.signal);
            } else {
              openAIData = await safeJsonResponse(upstream);
            }
            const anthropicMessage = openAIToAnthropicMessage(openAIData, requestedModel, modelConfig);
            recordSuccess(endpoint.id, elapsedMs);
            return new Response(JSON.stringify(anthropicMessage), {
              status: 200,
              headers: {
                'content-type': 'application/json;charset=UTF-8',
                'cache-control': 'no-store',
                ...corsHeaders(request, env),
                ...extraHeaders,
              },
            });
          }

          if (!isStreaming && request.signal && clientAbortListener) {
            request.signal.removeEventListener('abort', clientAbortListener);
          }

          if (targetWasNonStream && isStreaming) {
            logger.info('触发慢模型非流式响应重组...');
            const assembleResult = await assembleNonStreamResponse(
              upstream,
              requestedModel,
              requestId,
              request,
              env,
              extraHeaders,
              logger,
              ctx
            );
            if (assembleResult.status === 200) recordSuccess(endpoint.id, elapsedMs);
            else recordFailure(endpoint.id, 502, 5_000, 'stream_assemble_failed');
            return assembleResult;
          }

          if (!upstream.ok) recordNeutralEnd(endpoint.id);

          if (env && env.AE_DATASET) {
            ctx.waitUntil(writeAnalytics(env, {
              endpointId: await fingerprint(endpoint.id),
              status: upstream.status,
              latencyMs: elapsedMs,
              attempt: index + 1,
              cacheStatus: 'MISS',
            }));
          }

          if (cacheUrl && upstream.ok && !isStreaming) {
            const cacheMaxBytes = clampInt(readOptionalEnv(env, 'CACHE_MAX_BODY_BYTES'), 1024, 10 * 1024 * 1024, 2 * 1024 * 1024);
            const cacheTtl = clampInt(readOptionalEnv(env, 'CACHE_MAX_AGE_SEC'), 60, 86400 * 30, 600);
            const [stream1, stream2] = upstream.body.tee();
            const resForClient = new Response(stream1, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
            const resForCache = new Response(stream2, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
            ctx.waitUntil(cacheResponse(cacheUrl, resForCache, cacheMaxBytes, cacheTtl, logger));
            recordSuccess(endpoint.id, elapsedMs);
            return withCors(resForClient, request, env, extraHeaders);
          }

          if (!isStreaming && upstream.ok) {
            // 非流式：重写 model 字段为客户端请求的逻辑模型，隐藏上游真实模型名
            try {
              const data = await safeJsonResponse(upstream);
              if (data && typeof data === 'object') {
                if (requestedModel !== 'unknown') data.model = requestedModel;
                recordSuccess(endpoint.id, elapsedMs);
                return new Response(JSON.stringify(data), {
                  status: upstream.status,
                  statusText: upstream.statusText,
                  headers: upstream.headers,
                });
              }
            } catch {
              // 非 JSON 响应按原文透传
            }
            recordSuccess(endpoint.id, elapsedMs);
          }
          const responseForClient = isStreaming && upstream.ok
            ? trackEndpointStream(rewriteStreamModelField(upstream, requestedModel), endpoint.id, elapsedMs)
            : upstream;
          return withCors(
            responseForClient,
            request,
            env,
            extraHeaders,
            isStreaming ? { requestSignal: request.signal, clientAbortListener } : null
          );
        }

        const bodyText = await safeReadText(upstream);
        attempts.push(await buildAttemptRecord({
          attempt: index + 1,
          status: upstream.status,
          endpoint,
          error: trimDiagnostic(bodyText),
          latencyMs: elapsedMs,
          upstreamHost: targetHost,
          upstreamPath: new URL(targetUrl).pathname,
          exposeUpstreamInfo,
          endpointRole: endpoint.tier,
        }));

        if (NON_HEALTH_IMPACT_STATUS.has(upstream.status)) {
          recordNeutralEnd(endpoint.id);
        } else {
          const retryAfterMs = getRetryAfterMs(upstream.headers) || defaultCooldownMs(upstream.status, env);
          recordFailure(endpoint.id, upstream.status,
            applyExponentialBackoff(endpoint.id, upstream.status, retryAfterMs),
            `HTTP ${upstream.status}`);
          if (upstream.status >= 500) recordCircuitFailure(endpoint.id);
        }

        if (env && env.AE_DATASET) {
          ctx.waitUntil(writeAnalytics(env, {
            endpointId: await fingerprint(endpoint.id),
            status: upstream.status,
            latencyMs: elapsedMs,
            attempt: index + 1,
            cacheStatus: 'MISS',
          }));
        }
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof BodyTooLargeError) {
          recordNeutralEnd(endpoint.id);
          return gatewayError(request, env, isAnthropicClient, 413,
            error.message || 'Request body exceeds limit.', undefined, requestId);
        }
        if (request.signal && clientAbortListener) {
          request.signal.removeEventListener('abort', clientAbortListener);
        }
        const elapsedMs = Date.now() - requestStartTime;
        if (clientAbortTriggered || (request.signal?.aborted && !timeoutTriggered)) {
          recordNeutralEnd(endpoint.id);
          gatewayStats.clientCancellations++;
          return gatewayError(request, env, isAnthropicClient, 499,
            'Client closed the request before the upstream response started.', undefined, requestId);
        }
        const isTimeout = timeoutTriggered || error?.name === 'TimeoutError';
        const errorMessage = isTimeout
          ? `Upstream timed out after ${timeoutMs}ms.`
          : error?.message || String(error);

        attempts.push(await buildAttemptRecord({
          attempt: index + 1,
          status: 0,
          endpoint,
          error: errorMessage,
          latencyMs: elapsedMs,
          upstreamHost: targetHost,
          upstreamPath: targetUrl ? new URL(targetUrl).pathname : null,
          exposeUpstreamInfo,
          endpointRole: endpoint.tier,
        }));
        recordFailure(endpoint.id, 0,
          applyExponentialBackoff(endpoint.id, 0, isTimeout ? 30_000 : 2_000),
          isTimeout ? 'timeout' : 'fetch_error');
        logger.debug('Upstream fetch error:', error?.message || error);
      }
    }

    const last = attempts[attempts.length - 1];
    const status = last?.status === 429 ? 429 : 502;
    const isTimeoutError = last?.error?.includes('timed out');
    const message = last?.status === 404
      ? `Upstream returned 404 for model "${requestedModel}". Verify the models mapping on your nodes.`
      : isTimeoutError
        ? 'Upstream timed out for all nodes.'
        : 'Upstream request failed after node failover.';

    return gatewayError(request, env, isAnthropicClient, status, message, {
      attempts,
      request_id: requestId,
      request_path: requestUrl.pathname,
      requested_model: requestedModel,
      hint: route === 'anthropic_messages'
        ? 'The gateway converted /v1/messages to /v1/chat/completions. Node candidates were attempted in policy tier order.'
        : 'Inspect attempts[] and verify NODES_CONFIG, node health, and policy retry_budget.',
      nodes_total: configuredNodes.length,
      tiers: {
        'tier-1': configuredNodes.filter(n => n.tier === 'tier-1').length,
        'tier-2': configuredNodes.filter(n => n.tier === 'tier-2').length,
        'tier-3': configuredNodes.filter(n => n.tier === 'tier-3').length,
      },
    }, requestId);
}

function isCountedClientRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = normalizeGatewayPath(pathname);
  if (verb === 'GET') return path === '/v1/models' || path === '/models';
  if (verb !== 'POST') return false;
  return [
    '/v1/chat/completions', '/chat/completions',
    '/v1/messages', '/messages',
    '/v1/messages/count_tokens', '/messages/count_tokens',
  ].includes(path);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const counted = isCountedClientRoute(request.method, url.pathname);
    if (counted) {
      gatewayStats.clientRequests++;
      gatewayStats.clientActiveRequests++;
    }
    try {
      const response = await handleRequest(request, env, ctx);
      if (!counted) return response;
      return trackClientResponse(response);
    } catch (error) {
      if (counted) {
        gatewayStats.clientActiveRequests = Math.max(0, gatewayStats.clientActiveRequests - 1);
        gatewayStats.clientFailures++;
        if (request.signal?.aborted) gatewayStats.clientCancellations++;
      }
      throw error;
    }
  },
};

function trackClientResponse(response) {
  const fallbackUsed = response.headers.get('x-edge-gateway-fallback') === 'true';
  const successfulStatus = response.status < 400;
  const streaming = successfulStatus && isStreamingResponse(response) && response.body;

  if (!streaming) {
    gatewayStats.clientActiveRequests = Math.max(0, gatewayStats.clientActiveRequests - 1);
    if (successfulStatus) {
      gatewayStats.clientSuccesses++;
      if (fallbackUsed) gatewayStats.fallbackSuccesses++;
    } else {
      gatewayStats.clientFailures++;
    }
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let diagnosticTail = '';
  let streamErrorEventSeen = false;
  let finalized = false;
  const inspectChunk = value => {
    if (streamErrorEventSeen) return;
    diagnosticTail = (diagnosticTail + decoder.decode(value, { stream: true })).slice(-256);
    streamErrorEventSeen = /(?:^|\r?\n)event:\s*error\s*(?:\r?\n|$)/.test(diagnosticTail);
  };
  const finalize = (result) => {
    if (finalized) return;
    finalized = true;
    gatewayStats.clientActiveRequests = Math.max(0, gatewayStats.clientActiveRequests - 1);
    if (result === 'success') {
      gatewayStats.clientSuccesses++;
      if (fallbackUsed) gatewayStats.fallbackSuccesses++;
    } else {
      gatewayStats.clientFailures++;
      if (result === 'cancelled') gatewayStats.clientCancellations++;
    }
  };

  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize(streamErrorEventSeen ? 'failure' : 'success');
          controller.close();
        } else {
          inspectChunk(value);
          controller.enqueue(value);
        }
      } catch (error) {
        finalize('failure');
        controller.error(error);
      }
    },
    async cancel(reason) {
      finalize('cancelled');
      try { await reader.cancel(reason); } catch {}
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// ============ Anthropic / OpenAI 协议转换 ============

function normalizeGatewayPath(pathname) {
  return String(pathname || '/').replace(/\/+$/, '').toLowerCase() || '/';
}

function detectGatewayRoute(method, pathname) {
  if (String(method).toUpperCase() !== 'POST') return 'other';
  const path = normalizeGatewayPath(pathname);
  if (path === '/v1/messages/count_tokens' || path === '/messages/count_tokens') return 'anthropic_count_tokens';
  if (path === '/v1/messages' || path === '/messages') return 'anthropic_messages';
  if (path === '/v1/chat/completions' || path === '/chat/completions') return 'openai_chat';
  return 'other';
}

function isSupportedGatewayRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = normalizeGatewayPath(pathname);
  if (verb === 'GET') return ['/version', '/health', '/metrics', '/v1/models', '/models'].includes(path);
  if (verb === 'POST') return [
    '/v1/chat/completions', '/chat/completions',
    '/v1/messages', '/messages',
    '/v1/messages/count_tokens', '/messages/count_tokens',
  ].includes(path);
  return verb === 'OPTIONS';
}

function isModelsListRoute(method, pathname) {
  if (String(method).toUpperCase() !== 'GET') return false;
  const path = normalizeGatewayPath(pathname);
  return path === '/v1/models' || path === '/models';
}

function validateAnthropicCountTokensRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) return 'model is required and must be a non-empty string.';
  if (!Array.isArray(body.messages)) return 'messages is required and must be an array.';
  return null;
}

function validateAnthropicMessagesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!body.model || typeof body.model !== 'string') return 'model is required and must be a string.';
  if (!Number.isFinite(Number(body.max_tokens)) || Number(body.max_tokens) <= 0) return 'max_tokens is required and must be greater than 0.';
  if (!Array.isArray(body.messages)) return 'messages is required and must be an array.';
  return null;
}

function validateOpenAIChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) return 'model is required and must be a non-empty string.';
  if (!Array.isArray(body.messages)) return 'messages is required and must be an array.';
  return null;
}

function anthropicToOpenAIRequest(body, modelConfig, env) {
  const caps = modelConfig?.capabilities || {};
  const messages = [];
  const systemContent = convertAnthropicSystem(body.system, caps);
  if (systemContent !== null && systemContent !== '') {
    messages.push({ role: 'system', content: systemContent });
  }

  for (const message of body.messages || []) {
    const converted = convertAnthropicMessageToOpenAI(message, caps);
    for (const item of converted) messages.push(item);
  }

  const fakeStreamEnabled = readBooleanEnv(env, 'FAKE_STREAM_PROTECTION', false);
  const clientWantsStream = body.stream === true;
  const upstreamStream = clientWantsStream || fakeStreamEnabled;
  const maxField = caps.max_tokens_field === 'max_completion_tokens'
    ? 'max_completion_tokens'
    : 'max_tokens';

  const out = {
    model: body.model,
    messages,
    stream: upstreamStream,
  };
  out[maxField] = Number(body.max_tokens);

  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.top_k === 'number' && caps.top_k === true) out.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body.metadata?.user_id) out.user = String(body.metadata.user_id);

  if (Array.isArray(body.tools) && body.tools.length && caps.tools !== false) {
    out.tools = body.tools.map(tool => convertAnthropicToolToOpenAI(tool, caps)).filter(Boolean);
    if (body.tool_choice) {
      const tc = convertAnthropicToolChoiceToOpenAI(body.tool_choice);
      if (tc !== undefined) out.tool_choice = tc;
      if (typeof body.tool_choice.disable_parallel_tool_use === 'boolean' && caps.parallel_tools !== false) {
        out.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
      }
    }
  }

  const format = body.output_config?.format;
  if (format && caps.json_schema === true) {
    if (format.type === 'json_schema' && format.schema) {
      out.response_format = {
        type: 'json_schema',
        json_schema: {
          name: format.name || 'response',
          schema: format.schema,
          strict: format.strict !== false,
        },
      };
    } else if (format.type === 'json_object') {
      out.response_format = { type: 'json_object' };
    }
  }

  applyAnthropicThinkingRequest(out, body, modelConfig, env);

  if (upstreamStream && caps.stream_usage === true) {
    out.stream_options = { include_usage: true };
  }

  return out;
}

function convertAnthropicSystem(system, caps) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  const parts = [];
  for (const block of system) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text') parts.push(block.text || '');
    else if (block) parts.push(`[Unsupported system block ${block.type || 'unknown'} omitted]`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function convertAnthropicMessageToOpenAI(message, caps) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return [];
  if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
  const blocks = Array.isArray(message.content) ? message.content : [];
  return message.role === 'assistant'
    ? [convertAnthropicAssistantToOpenAI(blocks, caps)]
    : convertAnthropicUserToOpenAI(blocks, caps);
}

function convertAnthropicAssistantToOpenAI(blocks, caps) {
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') textParts.push(block.text || '');
    else if (block.type === 'thinking') reasoningParts.push(block.thinking || '');
    else if (block.type === 'redacted_thinking') reasoningParts.push('[redacted thinking]');
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${crypto.randomUUID().replace(/-/g, '')}`,
        type: 'function',
        function: {
          name: block.name || 'unknown_tool',
          arguments: JSON.stringify(isPlainObject(block.input) ? block.input : {}),
        },
      });
    }
  }

  const out = {
    role: 'assistant',
    content: textParts.length ? textParts.join('') : null,
  };
  if (toolCalls.length) out.tool_calls = toolCalls;
  if (reasoningParts.length && caps.preserve_reasoning_history === true) {
    out.reasoning_content = reasoningParts.join('\n\n');
  }
  return out;
}

function convertAnthropicUserToOpenAI(blocks, caps) {
  const results = [];
  const userParts = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      results.push({
        role: 'tool',
        tool_call_id: block.tool_use_id || '',
        content: convertToolResultContentToString(block.content, block.is_error === true),
      });
      continue;
    }

    const converted = convertAnthropicContentBlockToOpenAI(block, caps);
    if (converted !== null) {
      if (Array.isArray(converted)) userParts.push(...converted);
      else userParts.push(converted);
    }
  }

  if (userParts.length) {
    const onlyText = userParts.every(part => part?.type === 'text');
    results.push({
      role: 'user',
      content: onlyText ? userParts.map(p => p.text || '').join('') : userParts,
    });
  } else if (!results.length) {
    results.push({ role: 'user', content: '' });
  }
  return results;
}

function convertAnthropicContentBlockToOpenAI(block, caps) {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text || '' };
    case 'image': {
      if (caps.vision === false) return { type: 'text', text: '[Image omitted: upstream model is configured without vision support]' };
      const url = anthropicSourceToDataUrl(block.source);
      return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[Unsupported image source omitted]' };
    }
    case 'document':
      return { type: 'text', text: convertAnthropicDocumentToText(block) };
    case 'search_result':
      return { type: 'text', text: formatSearchResultBlock(block) };
    case 'tool_reference':
      return { type: 'text', text: `[Tool reference: ${block.tool_name || block.name || stableStringify(block)}]` };
    case 'tool_search_tool_result':
      return { type: 'text', text: `[Tool search result: ${stableStringify(block)}]` };
    default:
      return { type: 'text', text: `[Unsupported Anthropic content block ${block.type || 'unknown'} omitted]` };
  }
}

function anthropicSourceToDataUrl(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && source.data) {
    return `data:${source.media_type || 'application/octet-stream'};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return String(source.url);
  return null;
}

function convertAnthropicDocumentToText(block) {
  const source = block?.source || {};
  if (source.type === 'text') return String(source.data || source.text || '');
  if (source.type === 'url') return `[Document URL: ${source.url || ''}]`;
  if (source.type === 'base64') {
    const mediaType = source.media_type || 'application/octet-stream';
    if (mediaType.startsWith('text/') && source.data) {
      try { return decodeBase64Utf8(source.data); } catch {}
    }
    return `[Base64 document omitted: ${mediaType}, ${String(source.data || '').length} encoded characters]`;
  }
  return '[Unsupported document omitted]';
}

function formatSearchResultBlock(block) {
  const pieces = [];
  if (block.title) pieces.push(`Title: ${block.title}`);
  if (block.url) pieces.push(`URL: ${block.url}`);
  if (Array.isArray(block.content)) {
    pieces.push(block.content.map(x => x?.text || '').filter(Boolean).join('\n'));
  } else if (block.content) pieces.push(String(block.content));
  return pieces.filter(Boolean).join('\n');
}

function convertToolResultContentToString(content, isError) {
  const prefix = isError ? '[Tool execution error]\n' : '';
  if (content === undefined || content === null) return prefix;
  if (typeof content === 'string') return prefix + content;
  if (!Array.isArray(content)) return prefix + stableStringify(content);

  const parts = content.map(block => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return String(block ?? '');
    if (block.type === 'text') return block.text || '';
    if (block.type === 'image') {
      const source = block.source || {};
      return `[Tool-result image: ${source.media_type || 'unknown'}, ${String(source.data || source.url || '').length} bytes/chars]`;
    }
    if (block.type === 'document') return convertAnthropicDocumentToText(block);
    if (block.type === 'search_result') return formatSearchResultBlock(block);
    return stableStringify(block);
  });
  return prefix + parts.filter(Boolean).join('\n');
}

function convertAnthropicToolToOpenAI(tool, caps) {
  if (!tool || typeof tool !== 'object' || !tool.name) return null;
  const fn = {
    name: String(tool.name),
    description: String(tool.description || ''),
    parameters: isPlainObject(tool.input_schema)
      ? tool.input_schema
      : { type: 'object', properties: {} },
  };
  if (caps.strict_tools === true && typeof tool.strict === 'boolean') fn.strict = tool.strict;
  return { type: 'function', function: fn };
}

function convertAnthropicToolChoiceToOpenAI(choice) {
  if (!choice || typeof choice !== 'object') return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return 'auto';
}

function applyAnthropicThinkingRequest(out, body, modelConfig, env) {
  const caps = modelConfig?.capabilities || {};
  const mode = String(
    caps.reasoning_request
      || readOptionalEnv(env, 'ANTHROPIC_REASONING_REQUEST_MODE')
      || 'none'
  ).toLowerCase();
  const thinking = body.thinking;
  const effort = body.output_config?.effort || inferEffortFromThinking(thinking);
  const thinkingEnabled = thinking?.type === 'enabled' || thinking?.type === 'adaptive';
  if (!thinkingEnabled && !effort) return;

  if (mode === 'reasoning_effort') {
    out.reasoning_effort = normalizeReasoningEffort(effort || 'medium');
  } else if (mode === 'chat_template_kwargs') {
    out.chat_template_kwargs = {
      ...(isPlainObject(out.chat_template_kwargs) ? out.chat_template_kwargs : {}),
      enable_thinking: true,
    };
  } else if (mode === 'thinking') {
    out.thinking = thinking?.type === 'enabled'
      ? { type: 'enabled', budget_tokens: Number(thinking.budget_tokens || 1024) }
      : { type: 'adaptive' };
  }
}

function inferEffortFromThinking(thinking) {
  if (!thinking || thinking.type === 'disabled') return null;
  if (thinking.type === 'adaptive') return 'medium';
  const budget = Number(thinking.budget_tokens || 0);
  if (budget >= 16000) return 'high';
  if (budget >= 4096) return 'medium';
  return 'low';
}

function normalizeReasoningEffort(value) {
  const v = String(value || 'medium').toLowerCase();
  if (['low', 'medium', 'high'].includes(v)) return v;
  if (v === 'max') return 'high';
  if (v === 'minimal') return 'low';
  return 'medium';
}

function openAIToAnthropicMessage(data, requestedModel, modelConfig = {}) {
  const responseModel = requestedModel;
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const caps = modelConfig?.capabilities || {};
  const reasoning = extractOpenAIReasoning(message, choice);

  if (reasoning && caps.expose_reasoning !== false) {
    content.push({
      type: 'thinking',
      thinking: reasoning,
      signature: createGatewayThinkingSignature(responseModel),
    });
  }

  const text = extractOpenAITextContent(message.content);
  if (text) content.push({ type: 'text', text });
  if (message.refusal) content.push({ type: 'text', text: String(message.refusal) });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (message.function_call) {
    toolCalls.push({
      id: `call_${crypto.randomUUID().replace(/-/g, '')}`,
      type: 'function',
      function: message.function_call,
    });
  }
  for (const call of toolCalls) {
    const rawArgs = call?.function?.arguments ?? '{}';
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name: call?.function?.name || 'unknown_tool',
      input: parseToolArgumentsObject(rawArgs),
    });
  }

  const finalContent = content;
  if (finalContent.length === 0) {
    throw new Error('Upstream returned an empty response without text, reasoning, or tool calls.');
  }
  const usage = mapOpenAIUsageToAnthropic(data?.usage || {});
  return {
    id: normalizeAnthropicMessageId(data?.id),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: finalContent,
    stop_reason: mapOpenAIFinishReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage,
  };
}

function extractOpenAIReasoning(message, choice) {
  const candidates = [
    message?.reasoning_content,
    message?.reasoning,
    choice?.reasoning_content,
    choice?.reasoning,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
      const text = value.map(x => x?.text || x?.content || '').filter(Boolean).join('');
      if (text) return text;
    }
  }
  return '';
}

function extractOpenAITextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' || part?.type === 'output_text') return part.text || '';
    return '';
  }).join('');
}

function mapOpenAIUsageToAnthropic(usage) {
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0) || 0;
  const thinkingTokens = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.thinking_tokens ?? 0) || 0;
  const result = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
  };
  if (cached > 0) result.cache_read_input_tokens = cached;
  if (thinkingTokens > 0) result.output_tokens_details = { thinking_tokens: thinkingTokens };
  return result;
}

function mapOpenAIFinishReason(reason, hasTools = false) {
  if (hasTools || reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'refusal') return 'refusal';
  if (reason === 'stop' || reason === null || reason === undefined) return 'end_turn';
  return 'end_turn';
}

function normalizeAnthropicMessageId(id) {
  const raw = String(id || '');
  if (raw.startsWith('msg_')) return raw;
  return `msg_${raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || crypto.randomUUID().replace(/-/g, '')}`;
}

function createGatewayThinkingSignature(model) {
  return `edge_gateway_unsigned_${simpleHash(String(model || 'model')).toString(16)}`;
}

function parseToolArgumentsObject(value) {
  if (isPlainObject(value)) return value;
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  try {
    const parsed = JSON.parse(raw || '{}');
    return isPlainObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function normalizeToolArgumentsJson(value) {
  const obj = parseToolArgumentsObject(value);
  return JSON.stringify(obj);
}

function transformOpenAIStreamToAnthropic(upstream, requestedModel, requestId, modelConfig, requestSignal, clientAbortListener, logger = console) {
  const responseModel = requestedModel;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const messageId = normalizeAnthropicMessageId(upstream.headers.get('x-request-id') || requestId);
  const caps = modelConfig?.capabilities || {};
  let buffer = '';
  let eventDataLines = [];
  let finished = false;
  let nextBlockIndex = 0;
  let openBlock = null;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let validChoiceSeen = false;
  const pendingTools = new Map();

  const cleanup = async () => {
    if (requestSignal && clientAbortListener) requestSignal.removeEventListener('abort', clientAbortListener);
    try { await reader.cancel().catch(() => {}); } catch {}
  };

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const failStream = (message, error = null, rawData = '') => {
        if (finished) return;
        const reason = error?.message || (error ? String(error) : message);
        const diagnostic = String(rawData || '').replace(/\s+/g, ' ').slice(0, 1000);
        logger.error(
          `[${requestId}] ${message} reason=${reason}${diagnostic ? ` chunk=${diagnostic}` : ''}`
        );
        finished = true;
        emit('error', {
          type: 'error',
          error: { type: 'api_error', message },
        });
        try { controller.close(); } catch {}
      };
      const closeOpenBlock = () => {
        if (!openBlock) return;
        if (openBlock.type === 'thinking') {
          emit('content_block_delta', {
            type: 'content_block_delta',
            index: openBlock.index,
            delta: { type: 'signature_delta', signature: createGatewayThinkingSignature(responseModel) },
          });
        }
        emit('content_block_stop', { type: 'content_block_stop', index: openBlock.index });
        openBlock = null;
      };
      const ensureBlock = type => {
        if (openBlock?.type === type) return openBlock.index;
        closeOpenBlock();
        const index = nextBlockIndex++;
        const contentBlock = type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' };
        emit('content_block_start', { type: 'content_block_start', index, content_block: contentBlock });
        openBlock = { type, index };
        return index;
      };
      const absorbToolCalls = calls => {
        for (const tc of calls || []) {
          const idx = Number(tc.index ?? 0);
          if (!pendingTools.has(idx)) {
            pendingTools.set(idx, {
              id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
              name: '',
              arguments: '',
            });
          }
          const item = pendingTools.get(idx);
          if (tc.id) item.id = tc.id;
          if (tc.function?.name) item.name += tc.function.name;
          if (tc.function?.arguments) item.arguments += tc.function.arguments;
        }
      };
      const processChunk = json => {
        if (json?.error) {
          emit('error', {
            type: 'error',
            error: {
              type: anthropicErrorTypeForStatus(Number(json.error.status || 500)),
              message: json.error.message || 'Upstream streaming error.',
            },
          });
          finished = true;
          try { controller.close(); } catch {}
          return;
        }
        if (json?.usage) usage = mapOpenAIUsageToAnthropic(json.usage);
        const choice = json?.choices?.[0];
        if (!choice) return;
        validChoiceSeen = true;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning && caps.expose_reasoning !== false) {
          const index = ensureBlock('thinking');
          emit('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: reasoning },
          });
        }
        const text = extractOpenAITextContent(delta.content);
        if (text) {
          const index = ensureBlock('text');
          emit('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text },
          });
        }
        if (Array.isArray(delta.tool_calls)) {
          closeOpenBlock();
          absorbToolCalls(delta.tool_calls);
        }
        if (delta.function_call) {
          closeOpenBlock();
          absorbToolCalls([{ index: 0, id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`, function: delta.function_call }]);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
      };
      const isCompleteEventData = data => {
        if (!data) return false;
        if (data === '[DONE]') return true;
        try {
          JSON.parse(data);
          return true;
        } catch {
          return false;
        }
      };
      const processEventData = data => {
        if (!data || finished) return;
        if (data === '[DONE]') {
          if (finishReason === null) {
            failStream('Upstream stream ended before a completion marker was received.');
          } else {
            finalize();
          }
          return;
        }
        try {
          processChunk(JSON.parse(data));
        } catch (error) {
          failStream('Upstream returned malformed streaming data.', error, data);
        }
      };
      const dispatchEventData = () => {
        if (eventDataLines.length === 0 || finished) return;
        const data = eventDataLines.join('\n');
        eventDataLines = [];
        processEventData(data);
      };
      const processSseLine = line => {
        if (finished) return;
        if (line === '') {
          dispatchEventData();
          return;
        }
        if (line.startsWith(':') || !line.startsWith('data:')) return;
        const value = line.slice(5).trimStart();
        // Some OpenAI-compatible providers omit the blank line between events.
        // Dispatch an already complete payload before accepting the next data line.
        if (eventDataLines.length > 0 && isCompleteEventData(eventDataLines.join('\n'))) {
          dispatchEventData();
        }
        if (!finished) eventDataLines.push(value);
      };
      const drainSseBuffer = (flush = false) => {
        while (!finished) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          processSseLine(line);
        }
        if (flush && !finished) {
          const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
          buffer = '';
          if (tail) processSseLine(tail);
          dispatchEventData();
        }
      };
      const finalize = () => {
        if (finished) return;
        const hasOutput = nextBlockIndex > 0 || pendingTools.size > 0;
        if (!hasOutput) {
          failStream(
            validChoiceSeen
              ? 'Upstream returned an empty streaming response.'
              : 'Upstream returned an empty or malformed stream.'
          );
          return;
        }
        finished = true;
        closeOpenBlock();

        const sortedTools = [...pendingTools.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, tool] of sortedTools) {
          const index = nextBlockIndex++;
          const id = tool.id || `toolu_${crypto.randomUUID().replace(/-/g, '')}`;
          const name = tool.name || 'unknown_tool';
          emit('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name, input: {} },
          });
          emit('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: normalizeToolArgumentsJson(tool.arguments) },
          });
          emit('content_block_stop', { type: 'content_block_stop', index });
        }

        emit('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: mapOpenAIFinishReason(finishReason, sortedTools.length > 0),
            stop_sequence: null,
          },
          usage,
        });
        emit('message_stop', { type: 'message_stop' });
        controller.close();
      };

      emit('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: responseModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      try {
        while (!finished) {
          if (requestSignal?.aborted) {
            await cleanup();
            try { controller.close(); } catch {}
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          drainSseBuffer();
        }
        if (!finished) buffer += decoder.decode();
        drainSseBuffer(true);
        if (!finished && finishReason === null) {
          failStream('Upstream stream ended before a completion marker was received.');
        } else {
          finalize();
        }
      } catch (e) {
        if (!requestSignal?.aborted) {
          failStream(`Upstream stream interrupted: ${e.message || String(e)}`, e);
        }
      } finally {
        await cleanup();
      }
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

async function collectOpenAIStream(upstream, requestSignal) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let id = '';
  let created = Math.floor(Date.now() / 1000);
  let model = '';
  let usage = null;
  const choices = new Map();
  let currentBytes = 0;

  const processChunk = json => {
    if (json.id) id = json.id;
    if (json.created) created = json.created;
    if (json.model) model = json.model;
    if (json.usage) usage = json.usage;
    for (const choice of json.choices || []) {
      const idx = choice.index ?? 0;
      if (!choices.has(idx)) {
        choices.set(idx, {
          content: '', reasoning_content: '', toolCalls: new Map(), finish_reason: null,
        });
      }
      const state = choices.get(idx);
      const delta = choice.delta || {};
      const text = extractOpenAITextContent(delta.content);
      if (text) {
        state.content += text;
        currentBytes += new TextEncoder().encode(text).length;
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string') {
        state.reasoning_content += reasoning;
        currentBytes += new TextEncoder().encode(reasoning).length;
      }
      for (const tc of delta.tool_calls || []) {
        const tcIdx = tc.index ?? 0;
        if (!state.toolCalls.has(tcIdx)) {
          state.toolCalls.set(tcIdx, {
            id: '', type: 'function', function: { name: '', arguments: '' },
          });
        }
        const existing = state.toolCalls.get(tcIdx);
        if (tc.id) existing.id = tc.id;
        if (tc.type) existing.type = tc.type;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) state.finish_reason = choice.finish_reason;
    }
  };
  const parseAndProcessChunk = data => {
    try {
      processChunk(JSON.parse(data));
    } catch (error) {
      const diagnostic = String(data || '').replace(/\s+/g, ' ').slice(0, 1000);
      throw new Error(`Upstream returned malformed streaming data: ${error?.message || String(error)}${diagnostic ? `; chunk=${diagnostic}` : ''}`);
    }
  };

  while (true) {
    if (requestSignal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new Error('Client aborted during stream assembly');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const eventChunk of events) {
      const data = eventChunk.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      parseAndProcessChunk(data);
    }
    if (currentBytes > MAX_SAFE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('Assembled response exceeded gateway memory safety limit. Use stream:true.');
    }
  }

  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (data && data !== '[DONE]') {
      parseAndProcessChunk(data);
    }
  }
  if (choices.size === 0) throw new Error('Upstream returned an empty or malformed stream.');
  const hasOutput = [...choices.values()].some(state => (
    Boolean(state.content) || Boolean(state.reasoning_content) || state.toolCalls.size > 0
  ));
  if (!hasOutput) throw new Error('Upstream returned an empty streaming response.');
  const hasCompletionMarker = [...choices.values()].some(state => state.finish_reason !== null);
  if (!hasCompletionMarker) throw new Error('Upstream stream ended before a completion marker was received.');

  const finalChoices = [...choices.entries()].sort((a, b) => a[0] - b[0]).map(([index, state]) => {
    const message = { role: 'assistant', content: state.content || null };
    if (state.reasoning_content) message.reasoning_content = state.reasoning_content;
    if (state.toolCalls.size) message.tool_calls = [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x);
    return { index, message, finish_reason: state.finish_reason || 'stop' };
  });

  return {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: finalChoices,
    ...(usage ? { usage } : {}),
  };
}

function anthropicMessageToSseResponse(message) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const emit = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      emit('message_start', {
        type: 'message_start',
        message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: message.usage?.input_tokens || 0, output_tokens: 0 } },
      });
      message.content.forEach((block, index) => {
        if (block.type === 'text') {
          emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          if (block.text) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
          emit('content_block_stop', { type: 'content_block_stop', index });
        } else if (block.type === 'thinking') {
          emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
          if (block.thinking) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature || createGatewayThinkingSignature(message.model) } });
          emit('content_block_stop', { type: 'content_block_stop', index });
        } else if (block.type === 'tool_use') {
          emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
          emit('content_block_stop', { type: 'content_block_stop', index });
        }
      });
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
        usage: message.usage || { input_tokens: 0, output_tokens: 0 },
      });
      emit('message_stop', { type: 'message_stop' });
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

async function safeJsonResponse(response, maxBytes = DEFAULT_MAX_UPSTREAM_JSON_BYTES) {
  const text = await readResponseTextWithLimit(response, maxBytes);
  try { return JSON.parse(text); }
  catch { throw new Error(`Upstream returned invalid JSON: ${trimDiagnostic(text)}`); }
}

async function readResponseTextWithLimit(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError('Upstream JSON response exceeds the configured safety limit.');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function estimateAnthropicInputTokens(body) {
  let weightedChars = 0;
  const countText = value => { weightedChars += String(value || '').length; };
  if (typeof body.system === 'string') countText(body.system);
  else if (Array.isArray(body.system)) body.system.forEach(x => countText(x?.text || x));

  for (const message of body.messages || []) {
    weightedChars += 8;
    if (typeof message.content === 'string') countText(message.content);
    else for (const block of message.content || []) {
      if (block?.type === 'text') countText(block.text);
      else if (block?.type === 'tool_use') countText(stableStringify(block.input));
      else if (block?.type === 'tool_result') countText(convertToolResultContentToString(block.content, block.is_error));
      else if (block?.type === 'image') weightedChars += 6400;
      else countText(stableStringify(block));
    }
  }
  countText(stableStringify(body.tools || []));
  return Math.max(1, Math.ceil(weightedChars / 4));
}

function gatewayError(request, env, isAnthropic, status, message, details, requestId) {
  return isAnthropic
    ? anthropicErrorResponse(request, env, status, message, requestId, details, anthropicErrorTypeForStatus(status))
    : jsonError(request, env, status, message, details, requestId);
}

function anthropicErrorResponse(request, env, status, message, requestId, details, explicitType, extraHeaders = {}) {
  const error = {
    type: explicitType || anthropicErrorTypeForStatus(status),
    message: String(message || 'Unknown gateway error.'),
  };
  if (details) error.details = details;
  return new Response(JSON.stringify({ type: 'error', error }, null, 2), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'request-id': requestId || '',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

function anthropicErrorTypeForStatus(status) {
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}

function extractUpstreamErrorMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    return json?.error?.message || json?.message || trimDiagnostic(raw);
  } catch {
    return trimDiagnostic(raw);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64Utf8(data) {
  const binary = atob(String(data || ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ============ 响应缓存 ============

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    let out = '[';
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) out += ',';
      out += stableStringify(obj[i]);
    }
    return out + ']';
  }
  const keys = Object.keys(obj).sort();
  let out = '{';
  let first = true;
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v === undefined) continue;
    if (!first) out += ',';
    out += JSON.stringify(keys[i]) + ':' + stableStringify(v);
    first = false;
  }
  return out + '}';
}

async function generateCacheKey(bodyJson) {
  try {
    const { user, stream, n, ...cacheBody } = bodyJson;
    if (n && n > 1) return null; // 多 choice 不缓存，防止结果不匹配

    // 仅缓存显式 temperature=0 或提供 seed 的确定性请求；
    // 未提供 seed 且 top_p<1 时仍视为非确定性请求。
    const hasSeed = cacheBody.seed !== undefined && cacheBody.seed !== null;
    const isExplicitZeroTemp = cacheBody.temperature === 0;
    if (!isExplicitZeroTemp && !hasSeed) return null;
    if (!hasSeed && cacheBody.top_p !== undefined && cacheBody.top_p < 1) return null;

    const stableString = stableStringify(cacheBody);
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableString));
    return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function cacheResponse(cacheUrl, response, maxBytes, ttl, logger) {
  try {
    const cloned = response.clone();
    const reader = cloned.body.getReader();
    let receivedLength = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedLength += value.length;
      if (receivedLength > maxBytes) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }

    const fullBody = new Uint8Array(receivedLength);
    let offset = 0;
    for (const chunk of chunks) {
      fullBody.set(chunk, offset);
      offset += chunk.length;
    }

    const headers = new Headers({
      'Content-Type': response.headers.get('Content-Type') || 'application/json',
      'Cache-Control': `max-age=${ttl}`,
      'x-edge-gateway-cache': 'CACHED'
    });

    const resToCache = new Response(fullBody, { status: 200, headers });
    await caches.default.put(cacheUrl, resToCache);
  } catch (e) {
    logger?.error('Cache put failed:', e.message);
  }
}

function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

// ============ Health / Metrics / Models ============


async function healthCheck(request, env, requestId) {
  const nodes = getConfiguredNodes(env);
  const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);
  const now = Date.now();

  const nodeDetails = nodes.map(n => {
    const s = getNodeRuntimeState(n.id);
    const cooling = s.cooldownUntil > now;
    return {
      id: n.id,
      tier: n.tier,
      provider: exposeUpstreamInfo ? n.provider : n.tier,
      priority: n.priority,
      models: Object.keys(n.models || {}),
      health_score: Math.round(s.healthScore),
      status: cooling ? 'cooling_down' : 'active',
      cooldown_remaining_ms: cooling ? s.cooldownUntil - now : 0,
      cooldown_reason: s.cooldownReason || null,
      circuit_state: s.circuitState,
      active_requests: s.activeRequests,
      avg_ttfb_ms: Math.round(s.avgLatencyMs) || 0,
      total_requests: s.totalRequests,
      total_successes: s.totalSuccesses,
      total_failures: s.totalFailures,
      success_rate: s.totalRequests > 0 ? (s.totalSuccesses / s.totalRequests * 100).toFixed(1) + '%' : 'N/A',
      consecutive_failures: s.consecutiveFailures,
      last_used_at: s.lastUsedAt > 0 ? new Date(s.lastUsedAt).toISOString() : null,
    };
  });

  const cooling = nodeDetails.filter(e => e.status === 'cooling_down').length;

  return new Response(JSON.stringify({
    status: nodes.length > 0 ? 'ok' : 'misconfigured',
    gateway_auth_enabled: true,
    nodes_total: nodes.length,
    nodes_active: nodes.length - cooling,
    nodes_cooling_down: cooling,
    tiers: {
      'tier-1': nodes.filter(n => n.tier === 'tier-1').length,
      'tier-2': nodes.filter(n => n.tier === 'tier-2').length,
      'tier-3': nodes.filter(n => n.tier === 'tier-3').length,
    },
    note: "This snapshot reflects only the current isolate's in-memory state.",
    client_stats: {
      started_at: new Date(gatewayStats.startedAt).toISOString(),
      requests_total: gatewayStats.clientRequests,
      successes_total: gatewayStats.clientSuccesses,
      failures_total: gatewayStats.clientFailures,
      active_requests: gatewayStats.clientActiveRequests,
      cancellations_total: gatewayStats.clientCancellations,
      fallback_activations_total: gatewayStats.fallbackActivations,
      fallback_successes_total: gatewayStats.fallbackSuccesses,
      success_rate: gatewayStats.clientRequests > 0 ? (gatewayStats.clientSuccesses / gatewayStats.clientRequests * 100).toFixed(1) + '%' : 'N/A',
    },
    endpoints: nodeDetails,
    request_id: requestId,
  }, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store', 'x-request-id': requestId, ...corsHeaders(request, env) },
  });
}

async function metricsCheck(request, env) {
  const nodes = getConfiguredNodes(env);
  const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);
  const now = Date.now();

  const lines = [];
  lines.push('# HELP edge_gateway_client_requests_total Counted client API requests since isolate start.');
  lines.push('# TYPE edge_gateway_client_requests_total counter');
  lines.push('edge_gateway_client_requests_total ' + gatewayStats.clientRequests);
  lines.push('# HELP edge_gateway_client_successes_total Client API responses with HTTP status below 400 since isolate start.');
  lines.push('# TYPE edge_gateway_client_successes_total counter');
  lines.push('edge_gateway_client_successes_total ' + gatewayStats.clientSuccesses);
  lines.push('# HELP edge_gateway_client_failures_total Client API responses with HTTP status 400 or above since isolate start.');
  lines.push('# TYPE edge_gateway_client_failures_total counter');
  lines.push('edge_gateway_client_failures_total ' + gatewayStats.clientFailures);
  lines.push('# HELP edge_gateway_client_active_requests Current counted client API requests still active in this isolate.');
  lines.push('# TYPE edge_gateway_client_active_requests gauge');
  lines.push('edge_gateway_client_active_requests ' + gatewayStats.clientActiveRequests);
  lines.push('# HELP edge_gateway_node_health_score Current health score (1-100) per node.');
  lines.push('# TYPE edge_gateway_node_health_score gauge');
  lines.push('# HELP edge_gateway_node_active_requests Currently in-flight requests per node.');
  lines.push('# TYPE edge_gateway_node_active_requests gauge');
  lines.push('# HELP edge_gateway_node_cooldown_remaining_ms Remaining cooldown time in ms per node.');
  lines.push('# TYPE edge_gateway_node_cooldown_remaining_ms gauge');
  lines.push('# HELP edge_gateway_node_avg_ttfb_ms Exponentially-weighted time to response headers in ms per node.');
  lines.push('# TYPE edge_gateway_node_avg_ttfb_ms gauge');
  lines.push('# HELP edge_gateway_node_requests_total Total requests served per node since isolate start.');
  lines.push('# TYPE edge_gateway_node_requests_total counter');
  lines.push('# HELP edge_gateway_node_successes_total Total successful requests per node since isolate start.');
  lines.push('# TYPE edge_gateway_node_successes_total counter');
  lines.push('# HELP edge_gateway_node_failures_total Total failed requests per node since isolate start.');
  lines.push('# TYPE edge_gateway_node_failures_total counter');

  for (const n of nodes) {
    const s = getNodeRuntimeState(n.id);
    const cooling = s.cooldownUntil > now ? s.cooldownUntil - now : 0;
    const provider = sanitizePrometheusLabel(exposeUpstreamInfo ? n.provider : n.tier);
    const label = 'node_id="' + sanitizePrometheusLabel(n.id) + '",tier="' + n.tier + '",provider="' + provider + '"';
    lines.push('edge_gateway_node_health_score{' + label + '} ' + Math.round(s.healthScore));
    lines.push('edge_gateway_node_circuit_state{node_id="' + sanitizePrometheusLabel(n.id) + '"} ' + (s.circuitState === 'closed' ? '0' : s.circuitState === 'open' ? '2' : '1'));
    lines.push('edge_gateway_node_active_requests{' + label + '} ' + s.activeRequests);
    lines.push('edge_gateway_node_cooldown_remaining_ms{' + label + '} ' + cooling);
    lines.push('edge_gateway_node_avg_ttfb_ms{' + label + '} ' + (Math.round(s.avgLatencyMs) || 0));
    lines.push('edge_gateway_node_requests_total{' + label + '} ' + s.totalRequests);
    lines.push('edge_gateway_node_successes_total{' + label + '} ' + s.totalSuccesses);
    lines.push('edge_gateway_node_failures_total{' + label + '} ' + s.totalFailures);
  }

  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(request, env) },
  });
}

async function writeAnalytics(env, { endpointId, status, latencyMs, attempt, cacheStatus }) {
  try {
    env.AE_DATASET.writeDataPoint({
      blobs: [endpointId, String(status), cacheStatus || 'MISS'],
      doubles: [latencyMs || 0, attempt || 0],
      indexes: [endpointId],
    });
  } catch (e) {
    // 可观测性写入失败时保持请求链路可用。
  }
}

// ============ 模型列表 ============

function modelsListResponse(request, env, requestId) {
  const nodes = getConfiguredNodes(env);
  const models = new Map();
  for (const node of nodes) {
    for (const logical of Object.keys(node.models || {})) {
      if (!models.has(logical)) {
        models.set(logical, { id: logical, object: 'model', created: 0, owned_by: APP_META.name });
      }
    }
  }
  const data = [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  return new Response(JSON.stringify({ object: 'list', data }), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      'x-edge-gateway-model-source': 'configured',
      ...corsHeaders(request, env),
    },
  });
}

// ============ HTTP 处理 ============

function buildStandardOpenAIHeaders(request, token, requestId) {
  const headers = new Headers();
  const incoming = request.headers;
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', incoming.get('content-type') || 'application/json');
  const accept = incoming.get('accept');
  headers.set('Accept', accept || 'application/json');
  headers.set('User-Agent', 'Smart-Edge-Gateway OpenAI-Compatible');
  headers.set('Accept-Encoding', 'identity');
  const orgId = incoming.get('openai-organization');
  if (orgId) headers.set('OpenAI-Organization', orgId);
  const idempotencyKey = incoming.get('idempotency-key');
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  headers.set('X-Request-ID', requestId);
  return headers;
}

function buildTargetUrl(incomingUrl, targetBaseUrl) {
  const base = new URL(targetBaseUrl);
  let incomingPath = incomingUrl.pathname || '/';
  const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
  const lowerPath = incomingPath.toLowerCase();
  if (basePath.endsWith('/v1') && /^\/v1(?:\/|$)/.test(lowerPath)) {
    incomingPath = incomingPath.replace(/^\/[vV]1(?=\/|$)/, '') || '/';
  }
  base.pathname = joinPath(base.pathname, incomingPath);
  mergeSearchParams(base, incomingUrl);
  return base.toString();
}

function mergeSearchParams(targetUrl, incomingUrl) {
  const merged = new URLSearchParams(targetUrl.search);
  const incoming = new Map();
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (!incoming.has(key)) incoming.set(key, []);
    incoming.get(key).push(value);
  }
  for (const [key, values] of incoming.entries()) {
    merged.delete(key);
    for (const value of values) merged.append(key, value);
  }
  targetUrl.search = merged.toString();
}

function joinPath(left, right) {
  const a = String(left || '').replace(/\/+$/, '');
  const b = String(right || '').replace(/^\/+/, '');
  return `/${[a.replace(/^\/+/, ''), b].filter(Boolean).join('/')}`;
}

function isStreamingResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
}

function createAbortableStream(upstreamBody, requestSignal, clientAbortListener) {
  const reader = upstreamBody.getReader();
  let cleanedUp = false;
  const encoder = new TextEncoder();

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (requestSignal && clientAbortListener) {
      requestSignal.removeEventListener('abort', clientAbortListener);
    }
    try {
      await reader.cancel().catch(() => {});
    } catch {}
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          cleanup();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (requestSignal && requestSignal.aborted) {
          try { controller.close(); } catch {}
        } else {
          const actualReason = error?.message || error?.name || "Unknown network error";
          const errMsg = JSON.stringify({
            error: {
              message: `Stream interrupted by upstream gateway. Details: ${actualReason}`,
              type: "server_error"
            }
          });

          try {
            controller.enqueue(encoder.encode(`data: ${errMsg}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (e) {
          }
        }
        cleanup();
      }
    },
    cancel() { cleanup(); },
  });
}


function sanitizeUpstreamResponseHeaders(sourceHeaders, exposeUpstreamInfo) {
  const headers = new Headers();
  const alwaysBlocked = new Set([
    'set-cookie', 'content-encoding', 'content-length',
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
  ]);
  const publicAllowlist = new Set([
    'content-type', 'cache-control', 'content-language', 'content-disposition',
    'content-range', 'accept-ranges', 'etag', 'last-modified', 'expires',
    'x-accel-buffering'
  ]);
  for (const [name, value] of sourceHeaders.entries()) {
    const lower = name.toLowerCase();
    if (alwaysBlocked.has(lower)) continue;
    if (!exposeUpstreamInfo && !publicAllowlist.has(lower)) continue;
    headers.append(name, value);
  }
  return headers;
}

function trackEndpointStream(response, endpointId, latencyMs) {
  if (!response.body) {
    recordSuccess(endpointId, latencyMs);
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let diagnosticTail = '';
  let streamErrorEventSeen = false;
  let finished = false;
  const inspectChunk = value => {
    if (streamErrorEventSeen) return;
    diagnosticTail = (diagnosticTail + decoder.decode(value, { stream: true })).slice(-256);
    streamErrorEventSeen = /(?:^|\r?\n)event:\s*error\s*(?:\r?\n|$)/.test(diagnosticTail);
  };
  const finishSuccess = () => {
    if (finished) return;
    finished = true;
    recordSuccess(endpointId, latencyMs);
  };
  const finishNeutral = () => {
    if (finished) return;
    finished = true;
    recordNeutralEnd(endpointId);
  };
  const finishFailure = () => {
    if (finished) return;
    finished = true;
    recordFailure(endpointId, 0, 2_000, 'stream_interrupted');
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (streamErrorEventSeen) finishFailure();
          else finishSuccess();
          controller.close();
        } else {
          inspectChunk(value);
          controller.enqueue(value);
        }
      } catch (error) {
        finishFailure();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finishNeutral();
      try { await reader.cancel(reason); } catch {}
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function withCors(response, request, env, extraHeaders = {}, streamOptions = null) {
  const headers = sanitizeUpstreamResponseHeaders(response.headers, readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false));
  Object.entries(corsHeaders(request, env)).forEach(([k, v]) => {
    if (k.toLowerCase() === 'vary') headers.set(k, mergeVaryHeader(headers.get('vary'), v));
    else headers.set(k, v);
  });
  const extraEntries = extraHeaders instanceof Headers
    ? extraHeaders.entries()
    : Object.entries(extraHeaders || {});
  for (const [key, value] of extraEntries) headers.set(key, value);

  const ct = (headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }

  let body = response.body;
  if (streamOptions && body) {
    body = createAbortableStream(body, streamOptions.requestSignal, streamOptions.clientAbortListener);
  }

  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(request, env) {
  const allowedOrigin = normalizeAllowedOrigin(readOptionalEnv(env, 'ALLOWED_ORIGIN'));
  const allowedRequestHeaders = new Set([
    'authorization', 'x-api-key', 'content-type', 'accept', 'idempotency-key',
    'anthropic-version', 'anthropic-beta', 'x-claude-code-session-id',
    'x-claude-code-agent-id', 'x-claude-code-parent-agent-id'
  ]);
  const requested = String(request.headers.get('Access-Control-Request-Headers') || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  const accepted = requested.filter(value => allowedRequestHeaders.has(value.toLowerCase()));
  const allowHeaders = accepted.length > 0
    ? accepted.join(', ')
    : 'Authorization,X-Api-Key,Content-Type,Accept,Idempotency-Key,Anthropic-Version,Anthropic-Beta,X-Claude-Code-Session-Id,X-Claude-Code-Agent-Id,X-Claude-Code-Parent-Agent-Id';
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Expose-Headers': 'X-Request-Id,X-Edge-Gateway-Attempts,X-Edge-Gateway-Upstream-Status,X-Edge-Gateway-Cache,X-Edge-Gateway-Health,X-Edge-Gateway-Route,X-Edge-Gateway-Fallback,X-Edge-Gateway-Fallback-Provider,X-Edge-Gateway-Fallback-Tier,X-Edge-Gateway-Fallback-Model,X-Edge-Gateway-Requested-Model,X-Edge-Gateway-Primary-Attempts,X-Edge-Gateway-Fallback-Reason,X-Edge-Gateway-Model-Source',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (allowedOrigin !== '*') headers.Vary = mergeVaryHeader('', 'Origin');
  return headers;
}

function normalizeAllowedOrigin(value) {
  const raw = String(value || '*').trim();
  if (raw === '*') return '*';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'null';
    if (parsed.username || parsed.password) return 'null';
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return 'null';
    return parsed.origin;
  } catch {
    return 'null';
  }
}

function mergeVaryHeader(existing, value) {
  const values = new Set(String(existing || '').split(',').map(item => item.trim()).filter(Boolean));
  values.add(value);
  return [...values].join(', ');
}

// ============ 有界请求体读取 ============

async function readTextWithLimit(request, maxBytes) {
  if (!request.body) return await request.text();
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

function createLimitedRequestBodyStream(body, maxBytes) {
  if (!body) return null;
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        controller.error(new BodyTooLargeError());
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    },
  });
}

// ============ 配置与通用工具 ============

function buildNodeEndpoints(env, requestedModel, bodyJson) {
  let routePlan;
  try {
    routePlan = buildRoutePlan(env, requestedModel, bodyJson);
  } catch (e) {
    return [];
  }
  const nodes = routePlan?.nodes || [];
  if (nodes.length === 0) return [];

  return nodes.map(n => ({
    id: n.id,
    token: n._token,
    baseUrl: n._baseUrl,
    providerName: n.provider || inferProviderName(n._baseUrl),
    models: n.models || {},
    tier: n.tier,
    limits: n.limits || { concurrency: 2 },
  }));
}

// 兼容内部调用名的节点状态委托（统一走 node-state 模块）。
function recordSuccess(id, latencyMs) { recordNodeSuccess(id, latencyMs); }
function recordNeutralEnd(id) { recordNodeNeutralEnd(id); }
function recordFailure(id, status, cooldownMs, reason) { recordNodeFailure(id, status, cooldownMs, reason); }

// 轻量指数退避：429/401/403 使用固定冷却，其余按连续失败翻倍。
function applyExponentialBackoff(id, status, baseCooldownMs) {
  const s = getNodeRuntimeState(id);
  if (status === 429 || status === 401 || status === 403) return baseCooldownMs;
  return baseCooldownMs * Math.min(8, Math.pow(2, Math.max(0, s.consecutiveFailures)));
}

// First Event Guard：读取上游 SSE 流直到出现第一个有效 data 事件。
// 成功时返回一个重放已消费字节并继续转发剩余流的新 Response；
// 失败（空流 / [DONE] 无数据 / 畸形 / 超时 / 客户端取消）时抛错，允许 failover。
async function ensureFirstSseEvent(upstream, timeoutMs, requestSignal) {
  if (!upstream.body) throw new Error('empty');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const consumed = [];
  let buffer = '';
  let timerId = null;
  try {
    while (true) {
      if (requestSignal && requestSignal.aborted) throw new Error('aborted');
      const readPromise = reader.read();
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });
      let result;
      try {
        result = await Promise.race([readPromise, timeoutPromise]);
      } finally {
        clearTimeout(timerId);
        timerId = null;
      }
      if (result.done) throw new Error('empty');
      consumed.push(result.value);
      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const eventChunk of events) {
        const data = eventChunk.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') continue; // 只有 DONE，无有效输出
        try {
          JSON.parse(data);
          // 有效 JSON 事件确认成功；构造重放流
          const stream = new ReadableStream({
            start(controller) {
              for (const chunk of consumed) controller.enqueue(chunk);
              void (async () => {
                try {
                  while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    controller.enqueue(next.value);
                  }
                  controller.close();
                } catch (e) {
                  try { controller.error(e); } catch {}
                }
              })();
            },
            cancel() { reader.cancel().catch(() => {}); },
          });
          return new Response(stream, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
          });
        } catch {}
      }
    }
  } catch (e) {
    clearTimeout(timerId);
    await reader.cancel().catch(() => {});
    throw e;
  }
}

// 流式响应中把上游真实模型名重写为客户端请求的逻辑模型。
// 按行缓冲解析 data: 载荷；解析失败的行原样透传。
function rewriteStreamModelField(upstream, logicalModel) {
  if (!upstream.body || logicalModel === 'unknown') return upstream;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = '';

  const rewriteDataPayload = (payload) => {
    if (!payload || payload === '[DONE]') return null;
    try {
      const json = JSON.parse(payload);
      if (json && typeof json === 'object' && json.model !== undefined) {
        json.model = logicalModel;
        return JSON.stringify(json);
      }
    } catch {}
    return null;
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            const outLine = rewriteSseLine(line, rewriteDataPayload);
            controller.enqueue(encoder.encode(outLine + '\n'));
          }
        }
        if (lineBuffer) {
          controller.enqueue(encoder.encode(rewriteSseLine(lineBuffer, rewriteDataPayload)));
        }
        controller.close();
      } catch (e) {
        try { controller.error(e); } catch {}
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });

  return new Response(stream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

function rewriteSseLine(line, rewriteDataPayload) {
  if (!line.startsWith('data:')) return line;
  const prefix = 'data:';
  const raw = line.slice(prefix.length).replace(/^ /, '');
  const rewritten = rewriteDataPayload(raw);
  return rewritten === null ? line : prefix + ' ' + rewritten;
}

function sanitizePrometheusLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function inferProviderName(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname || 'unknown'; }
  catch { return 'unknown'; }
}



function parseBearer(value) {
  const raw = String(value || '').trim();
  return raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
}

function canHaveBody(method) { return !['GET', 'HEAD'].includes(String(method).toUpperCase()); }
function acceptsHtml(request) { return (request.headers.get('Accept') || '').includes('text/html'); }

function html(content) {
  return new Response(content, {
    status: 200,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
  });
}

function versionResponse(request, env) {
  const repository = readProjectRepositoryUrl(env);
  const configuration = getGatewayConfigurationState(env);
  return new Response(JSON.stringify({
    name: APP_META.name,
    display_name: APP_META.displayName,
    version: APP_META.version,
    runtime: 'Cloudflare Workers',
    protocols: ['OpenAI Chat Completions', 'Anthropic Messages'],
    ...(repository ? { repository } : {}),
    configuration: {
      ready: configuration.ready,
      gateway_access_key_bound: configuration.gatewayAccessKeyBound,
      nodes_config_bound: configuration.nodesConfigBound,
    },
  }, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

function readProjectRepositoryUrl(env) {
  const value = readOptionalEnv(env, 'PROJECT_REPOSITORY_URL');
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href.replace(/\/$/, '') : '';
  } catch {
    return '';
  }
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function jsonError(request, env, status, message, details, requestId) {
  return new Response(JSON.stringify({ error: { message, ...(details ? { details } : {}) } }, null, 2), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
    },
  });
}

async function safeReadText(response) {
  try {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) return '[streaming response - body skipped]';
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let total = 0;
    while (total < MAX_DIAGNOSTIC_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_DIAGNOSTIC_BYTES - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (slice.byteLength < value.byteLength) break;
    }
    await reader.cancel().catch(() => {});
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  } catch { return ''; }
}

function defaultCooldownMs(status, env) {
  if (status === 401 || status === 403) return clampInt(readOptionalEnv(env, 'AUTH_FAIL_COOLDOWN_MS'), 1000, 7 * 86_400_000, DEFAULT_AUTH_FAIL_COOLDOWN);
  if (status === 429) return clampInt(readOptionalEnv(env, 'RATE_LIMIT_COOLDOWN_MS'), 1000, 600_000, DEFAULT_RATE_LIMIT_COOLDOWN);
  if (status === 404) return 5_000;
  if (status === 503 || status === 504) return 8_000;
  if (status >= 500) return 3_000;
  return 1_000;
}

// 使用 SHA-256 截断指纹区分端点，不返回原始密钥片段。
async function fingerprint(token) {
  const text = String(token || '');
  if (!text) return 'tok_empty';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `tok_${hex.slice(0, 10)}`;
}

async function buildAttemptRecord({ attempt, status, endpoint, error, latencyMs, upstreamHost, upstreamPath, exposeUpstreamInfo, endpointRole }) {
  const publicError = exposeUpstreamInfo
    ? error
    : status > 0
      ? `Upstream returned HTTP ${status}.`
      : String(error || '').toLowerCase().includes('timed out')
        ? 'Upstream request timed out.'
        : 'Upstream request failed.';
  const record = {
    attempt,
    status,
    token: await fingerprint(endpoint.id),
    endpoint_role: endpointRole,
    error: publicError,
  };
  if (latencyMs !== undefined) record.latency_ms = latencyMs;
  // 默认隐藏上游域名与路径；仅在 EXPOSE_UPSTREAM_INFO=true 时用于诊断。
  if (exposeUpstreamInfo && upstreamHost) {
    record.upstream_url = `${upstreamHost}${upstreamPath || ''}`;
  }
  return record;
}

async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a || ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b || ''))),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  let result = 0;
  for (let i = 0; i < 32; i++) result |= viewA[i] ^ viewB[i];
  return result === 0;
}

function readOptionalEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : value;
}

function parseBooleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readBooleanEnv(env, name, fallback = false) {
  return parseBooleanValue(readOptionalEnv(env, name), fallback);
}

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}


function trimDiagnostic(text) { return String(text || '').replace(/\s+/g, ' ').slice(0, 600); }

// ============ 日志 ============

function getLogger(env) {
  const levelKey = (readOptionalEnv(env, 'LOG_LEVEL') || 'info').toLowerCase();
  const level = LOG_LEVELS[levelKey] ?? LOG_LEVELS.info;
  return {
    error: (msg, ...args) => { if (level >= 1) console.error(msg, ...args); },
    info:  (msg, ...args) => { if (level >= 2) console.log(msg, ...args); },
    debug: (msg, ...args) => { if (level >= 3) console.debug(msg, ...args); },
  };
}

// ============ 非流式响应重组 ============
async function assembleNonStreamResponse(upstream, model, requestId, request, env, extraHeaders, logger, ctx) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  const choicesMap = new Map(); // 按 choice.index 聚合多路输出
  let usage = null;
  let completionId = `chatcmpl-${requestId}`;
  let created = Math.floor(Date.now() / 1000);

  let currentBytes = 0;
  let isTruncated = false;
  const assembleStart = Date.now();

  try {
    while (true) {
      // 客户端中断后立即停止读取上游。
      if (request.signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error('Client aborted during stream assembly');
      }
      // 重组超时后返回已接收内容并标记截断。
      if (Date.now() - assembleStart > ASSEMBLE_TIMEOUT_MS) {
        isTruncated = true;
        await reader.cancel().catch(() => {});
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          if (json.id) completionId = json.id;
          if (json.created) created = json.created;
          if (json.usage) usage = json.usage;

          if (Array.isArray(json.choices)) {
            for (const choice of json.choices) {
              const idx = choice.index ?? 0;
              if (!choicesMap.has(idx)) {
                choicesMap.set(idx, {
                  content: '',
                  reasoning_content: '',
                  tool_calls_map: new Map(),
                  finish_reason: null
                });
              }
              const c = choicesMap.get(idx);
              const delta = choice.delta || {};

              if (delta.content) {
                c.content += delta.content;
                currentBytes += encoder.encode(delta.content).length;
              }
              if (delta.reasoning_content) {
                c.reasoning_content += delta.reasoning_content;
                currentBytes += encoder.encode(delta.reasoning_content).length;
              }
              // 按 tool_call.index 合并分片参数。
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const tcIdx = tc.index ?? 0;
                  if (!c.tool_calls_map.has(tcIdx)) {
                    c.tool_calls_map.set(tcIdx, {
                      id: '', type: 'function', function: { name: '', arguments: '' }
                    });
                  }
                  const existingTc = c.tool_calls_map.get(tcIdx);
                  if (tc.id) existingTc.id = tc.id;
                  if (tc.type) existingTc.type = tc.type;
                  if (tc.function?.name) existingTc.function.name += tc.function.name;
                  if (tc.function?.arguments) existingTc.function.arguments += tc.function.arguments;
                }
              }
              if (choice.finish_reason) c.finish_reason = choice.finish_reason;
            }
          }
        } catch (e) {}

        // 超过重组内存预算时停止缓冲。
        if (currentBytes > MAX_SAFE_BYTES) {
          isTruncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (isTruncated) break;
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data && data !== '[DONE]') {
          try {
            const json = JSON.parse(data);
            if (json.id) completionId = json.id;
            if (json.created) created = json.created;
            if (json.usage) usage = json.usage;
            for (const choice of json.choices || []) {
              const idx = choice.index ?? 0;
              if (!choicesMap.has(idx)) choicesMap.set(idx, { content: '', reasoning_content: '', tool_calls_map: new Map(), finish_reason: null });
              const c = choicesMap.get(idx);
              const delta = choice.delta || {};
              if (delta.content) c.content += delta.content;
              if (delta.reasoning_content) c.reasoning_content += delta.reasoning_content;
              if (choice.finish_reason) c.finish_reason = choice.finish_reason;
            }
          } catch {}
        }
      }
    }

    // 空流视为上游异常，不返回伪造成功响应。
    if (choicesMap.size === 0) {
      logger.error('Stream assemble produced empty response (no choices)');
      return jsonError(request, env, 502, 'Upstream returned empty stream after reassembly.', undefined, requestId);
    }

    const finalChoices = [...choicesMap.entries()].sort((a, b) => a[0] - b[0]).map(([index, c]) => {
      const message = { role: 'assistant', content: c.content || null };
      if (c.reasoning_content) message.reasoning_content = c.reasoning_content;
      if (c.tool_calls_map.size > 0) {
        message.tool_calls = [...c.tool_calls_map.entries()].sort((a,b) => a[0]-b[0]).map(([,v]) => v);
      }
      let finishReason = c.finish_reason || 'stop';
      if (isTruncated) finishReason = 'length';
      return { index, message, finish_reason: finishReason };
    });

    const hasContent = finalChoices.some(c =>
      (c.message.content && c.message.content.length > 0) ||
      (c.message.reasoning_content && c.message.reasoning_content.length > 0) ||
      (c.message.tool_calls && c.message.tool_calls.length > 0)
    );

    if (!hasContent && !isTruncated) {
      logger.error('Stream assemble produced empty content without truncation');
      return jsonError(request, env, 502, 'Upstream returned empty content after reassembly.', undefined, requestId);
    }

    if (isTruncated && finalChoices[0]) {
       finalChoices[0].message.content = (finalChoices[0].message.content || '') + "\n\n[⚠️ 网关警告：生成的文本过长，为保护边缘节点内存，已强制截断返回。请使用原生流式(stream: true)客户端获取完整内容。]";
    }

    const responseBody = {
      id: completionId,
      object: 'chat.completion',
      created: created,
      model: model,
      choices: finalChoices
    };

    if (usage) responseBody.usage = usage;

    const responseStr = JSON.stringify(responseBody);
    const headers = new Headers();
    headers.set('Content-Type', 'application/json;charset=UTF-8');
    Object.entries(corsHeaders(request, env)).forEach(([k, v]) => headers.set(k, v));
    const extraEntries = extraHeaders instanceof Headers
    ? extraHeaders.entries()
    : Object.entries(extraHeaders || {});
  for (const [key, value] of extraEntries) headers.set(key, value);

    return new Response(responseStr, { status: 200, headers });

  } catch (e) {
    logger.error('Stream assemble failed:', e.message);
    return jsonError(request, env, 502, '网关在重组长文本时发生错误。', { error: e.message }, requestId);
  }
}
