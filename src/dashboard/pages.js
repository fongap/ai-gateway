// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Minimal dashboard / setup pages served on GET / for browsers.
// Static templates; no client credentials are ever rendered here.

import { loadGatewayConfig } from '../config/nodes.js';
import { APP_META } from '../observability/status.js';
import { htmlResponse } from '../protocol/http.js';

const BASE_STYLES = `
:root{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#172126;background:#f4f7f8}
*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}
.card{width:min(720px,100%);padding:36px;border:1px solid #dce4e7;border-radius:18px;background:#fff;box-shadow:0 20px 60px rgba(27,48,58,.1)}
h1{margin:0 0 8px;font-size:26px;letter-spacing:-.02em}p{margin:0;color:#66747b;line-height:1.75}
code,.code pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.code{margin:14px 0;border:1px solid #2b3035;border-radius:11px;overflow:hidden;background:#171a1d}
.code span{display:block;height:34px;line-height:34px;padding:0 14px;color:#939aa3;background:#202429;border-bottom:1px solid #30353a;font-size:11px}
.code pre{margin:0;padding:12px 16px;color:#d7dce2;font-size:12.5px;line-height:1.65;overflow:auto;white-space:pre-wrap;word-break:break-all}
.status{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.ok{background:#e9f7ed;color:#26713a}.pending{background:#fff3db;color:#995f00}
.row{display:flex;justify-content:space-between;gap:16px;padding:12px 14px;border:1px solid #e2e8ea;border-radius:12px;margin-top:10px}
.note{margin-top:16px;font-size:13px}`;

export function dashboardResponse(request, env) {
  const config = loadGatewayConfig(env);
  if (!config.ready) return setupResponse(config);
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Gateway</title><style>${BASE_STYLES}</style></head>
<body><main class="card">
<h1>AI Gateway <span class="status ok">v${APP_META.version}</span></h1>
<p>多免费 API / Key 聚合为统一稳定 Endpoint。配置状态：${config.status}（可用节点 ${config.nodesUsable}/${config.nodesTotal}）。</p>
<div class="row"><code>GATEWAY_ACCESS_KEY</code><span class="status ok">已配置</span></div>
<div class="row"><code>TIERx_NODES_CONFIG_*</code><span class="status ${config.status === 'ready' ? 'ok' : 'pending'}">${config.status}</span></div>
<h1 style="font-size:17px;margin-top:24px">诊断端点（需鉴权）</h1>
<p><a href="/health">/health</a> · <a href="/metrics">/metrics</a> · <a href="/v1/models">/v1/models</a> · <a href="/version">/version</a></p>
<p class="note">健康、并发、熔断与冷却状态仅限当前 isolate。无数据库、无 KV 热路径。</p>
</main></body></html>`;
  return htmlResponse(html);
}

function setupResponse(config) {
  const mark = (ok) => `<span class="status ${ok ? 'ok' : 'pending'}">${ok ? '已配置' : '待配置'}</span>`;
  const accessKeyBound = Boolean(config.accessKeyBound);
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>AI Gateway · 初始化</title><style>${BASE_STYLES}</style></head>
<body><main class="card">
<h1>Worker 已部署，等待完成配置</h1>
<p>代码已正常运行；补齐以下配置后网关即可用。本版本为 Breaking Change 配置格式，请按新 schema 重新配置。</p>
<div class="row"><code>GATEWAY_ACCESS_KEY (Secret)</code>${mark(accessKeyBound)}</div>
<div class="row"><code>TIER1_NODES_CONFIG_01 (Variable)</code><span class="status pending">JSON 数组，不含密钥</span></div>
<div class="row"><code>NODE_SECRETS_01 (Secret)</code><span class="status pending">{ "node-id": "credential" }</span></div>
<div class="code"><span>TIER1_NODES_CONFIG_01 示例</span><pre>[
  {"id":"nvidia-01","provider":"nvidia","base_url":"https://integrate.api.nvidia.com/v1",
   "priority":10,"models":{"general-air":"model-a"},"limits":{"concurrency":1}}
]</pre></div>
<div class="code"><span>NODE_SECRETS_01 示例（Secret）</span><pre>{"nvidia-01":"nvapi-xxx"}</pre></div>
<p class="note">页面只显示是否已绑定，不读取任何 Secret 内容。保存后每 5 秒自动刷新。</p>
</main></body></html>`;
  return htmlResponse(html);
}
