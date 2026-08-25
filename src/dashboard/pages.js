// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Minimal dashboard / setup pages served on GET / for browsers.
// The setup page reflects REAL binding state (which shard variables and
// secrets exist) and renders configuration diagnostics, so a half-finished
// configuration is always explainable. No credential values are ever read
// or rendered.

import { loadGatewayConfig } from '../config/nodes.js';
import { APP_META } from '../observability/status.js';
import { htmlResponse } from '../protocol/http.js';

const BASE_STYLES = `
:root{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#172126;background:#f4f7f8}
*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}
.card{width:min(860px,100%);padding:36px;border:1px solid #dce4e7;border-radius:18px;background:#fff;box-shadow:0 20px 60px rgba(27,48,58,.1)}
h1{margin:0 0 8px;font-size:26px;letter-spacing:-.02em}h2{font-size:15px;margin:26px 0 8px}
p{margin:0;color:#66747b;line-height:1.75}
code,.code pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.code{margin:14px 0;border:1px solid #2b3035;border-radius:11px;overflow:hidden;background:#171a1d}
.code span{display:block;height:34px;line-height:34px;padding:0 14px;color:#939aa3;background:#202429;border-bottom:1px solid #30353a;font-size:11px}
.code pre{margin:0;padding:12px 16px;color:#d7dce2;font-size:12.5px;line-height:1.65;overflow:auto;white-space:pre-wrap;word-break:break-all}
.status{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
.ok{background:#e9f7ed;color:#26713a}.pending{background:#fff3db;color:#995f00}.bad{background:#fdeaea;color:#b3261e}
.row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 14px;border:1px solid #e2e8ea;border-radius:12px;margin-top:10px}
.row code{overflow-wrap:anywhere}
.diag{margin-top:10px;padding:12px 14px;border:1px solid #f3c8c8;border-radius:12px;background:#fdf4f4;color:#8f2626;font-size:13px;line-height:1.7}
.diag code{color:#8f2626}
.note{margin-top:16px;font-size:13px}`;

const escapeHtml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function dashboardResponse(request, env) {
  const config = loadGatewayConfig(env);
  if (!config.ready) return setupResponse(config);
  const diagHtml = config.diagnostics.length === 0
    ? ''
    : `<div class="diag"><b>配置诊断（${config.diagnostics.length} 条，被剔除的节点会在这里说明原因）</b><br>${config.diagnostics.map((d) => `· ${escapeHtml(d)}`).join('<br>')}</div>`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Gateway</title><style>${BASE_STYLES}</style></head>
<body><main class="card">
<h1>AI Gateway <span class="status ok">v${APP_META.version}</span></h1>
<p>多免费 API / Key 聚合为统一稳定 Endpoint。配置状态：<b>${config.status}</b>（可用节点 ${config.nodesUsable}/${config.nodesTotal}）。</p>
${diagHtml}
<div class="row"><code>GATEWAY_ACCESS_KEY</code><span class="status ok">已配置</span></div>
<div class="row"><code>TIERx_NODES_CONFIG_*</code><span class="status ${config.status === 'ready' ? 'ok' : 'pending'}">${config.status}</span></div>
<h2>诊断端点（需鉴权）</h2>
<p><a href="/health">/health</a> · <a href="/metrics">/metrics</a> · <a href="/v1/models">/v1/models</a> · <a href="/version">/version</a></p>
<p class="note">健康、并发、熔断与冷却状态仅限当前 isolate。无数据库、无 KV 热路径。</p>
</main></body></html>`;
  return htmlResponse(html);
}

function shardBadge(keys) {
  if (keys.length === 0) return '<span class="status bad">未绑定</span>';
  return `<span class="status ok">已绑定 ×${keys.length}</span>`;
}

function shardDetail(keys) {
  return keys.length === 0 ? '' : `<div style="margin-top:6px;font-size:12px;color:#66747b">${keys.map((k) => `<code>${escapeHtml(k)}</code>`).join(' · ')}</div>`;
}

function setupResponse(config) {
  const { bindings, diagnostics, status } = config;
  const accessKeyBound = Boolean(config.accessKeyBound);

  const diagHtml = diagnostics.length === 0
    ? ''
    : `<div class="diag"><b>配置诊断（${diagnostics.length}）</b><br>${diagnostics.map((d) => `· ${escapeHtml(d)}`).join('<br>')}</div>`;

  const statusHint = status === 'unconfigured'
    ? '关键配置尚未绑定齐全。'
    : status === 'invalid'
      ? '配置存在但无法构造任何可用节点，请按下方诊断修复。'
      : '';

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>AI Gateway · 初始化</title><style>${BASE_STYLES}</style></head>
<body><main class="card">
<h1>Worker 已部署，等待完成配置 <span class="status ${status === 'invalid' ? 'bad' : 'pending'}">${escapeHtml(status)}</span></h1>
<p>代码已正常运行；补齐以下配置后网关即可用。本版本为 Breaking Change 配置格式，请按新 schema 重新配置。${statusHint}</p>

<h2>绑定状态（实时检测）</h2>
<div class="row"><code>GATEWAY_ACCESS_KEY <span style="color:#8a94a0">(Secret)</span></code>${mark(accessKeyBound)}</div>
<div class="row"><div><code>TIER1/2/3_NODES_CONFIG_XX <span style="color:#8a94a0">(Variables，JSON 数组，不含密钥)</span></code>${shardDetail(bindings.tierShards)}</div>${shardBadge(bindings.tierShards)}</div>
<div class="row"><div><code>NODE_SECRETS_XX <span style="color:#8a94a0">(Secrets，{ "node-id": "credential" })</span></code>${shardDetail(bindings.secretShards)}</div>${shardBadge(bindings.secretShards)}</div>
${diagHtml}

<h2>配置示例（多 Key / 多账户 / 多模型）</h2>
<div class="code"><span>TIER1_NODES_CONFIG_01（普通变量）</span><pre>[
  {"id":"nvidia-01","provider":"nvidia","base_url":"https://integrate.api.nvidia.com/v1",
   "priority":10,"models":{"general-air":"deepseek-ai/deepseek-v3.1","code-pro":"qwen/qwen3-coder-480b"},
   "limits":{"concurrency":3,"rpm":40}},
  {"id":"nvidia-02","provider":"nvidia","base_url":"https://integrate.api.nvidia.com/v1",
   "priority":10,"models":{"general-air":"deepseek-ai/deepseek-v3.1"},"limits":{"concurrency":3,"rpm":40}},
  {"id":"glm-01","provider":"zhipu","base_url":"https://open.bigmodel.cn/api/paas/v4",
   "priority":20,"models":{"code-max":"glm-4.7"},"limits":{"concurrency":2}}
]</pre></div>
<div class="code"><span>NODE_SECRETS_01（Secret）</span><pre>{"nvidia-01":"nvapi-xxx","nvidia-02":"nvapi-yyy","glm-01":"zzzz.id"}</pre></div>
<p class="note">同层同 priority 的 key 会被 LRU 轮转摊流；不同 priority 严格先后；想省用的键放更低 tier。页面只显示变量名是否绑定，不读取任何 Secret 内容。保存后每 5 秒自动刷新。</p>
</main></body></html>`;
  return htmlResponse(html);
}

function mark(ok) {
  return ok
    ? '<span class="status ok">已配置</span>'
    : '<span class="status bad">未配置</span>';
}
