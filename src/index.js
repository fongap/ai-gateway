/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Fongap Studio
 *
 * 智能边缘网关
 *
 * 将 OpenAI Chat Completions 与 Anthropic Messages / Claude Code 请求统一转发至
 * OpenAI 兼容上游。Primary 负责日常调度；Fallback 仅在 Primary 全部失败后接管。
 *
 * 一次部署清单：
 * 1. 将 GATEWAY_ACCESS_KEY 设置为 Secret。
 * 2. 将 PRIMARY_API_TOKENS 设置为 Secret。
 * 3. Token 未使用 Token@BaseURL 时，设置 PRIMARY_BASE_URL。
 * 4. 客户端模型别名与上游模型 ID 不一致时，设置 MODEL_MAPPING。
 * 5. 需要兜底时，至少设置 FALLBACK_API_TOKEN、FALLBACK_BASE_URL 和 FALLBACK_PRIMARY_MODEL。
 * 6. 部署后使用 GATEWAY_ACCESS_KEY 访问 /health，确认端点状态与兜底顺序。
 *
 * 最小可运行配置：
 * - GATEWAY_ACCESS_KEY         : 客户端访问网关的鉴权密钥
 * - PRIMARY_API_TOKENS         : 主端点 Token；支持 Token 或 Token@BaseURL
 * - PRIMARY_BASE_URL           : 未在 Token 中绑定 URL 时使用的共享 Base URL
 *
 * Primary 配置：
 * - PRIMARY_ENABLED            : true/false；未设置时根据 PRIMARY_API_TOKENS 自动判断
 * - PRIMARY_MAX_ATTEMPTS       : 单次请求最多尝试的主端点数；默认 min(端点数, 3)
 * - PRIMARY_ROTATION_WINDOW_MS : 请求统计窗口；默认 60000
 * - PRIMARY_ROTATION_MAX_PER_WINDOW: 单端点窗口请求上限；默认 30
 * - PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT: 单端点并发上限；默认 2
 *
 * Fallback 配置：
 * - FALLBACK_ENABLED           : true/false；未设置时根据完整兜底配置自动判断
 * - FALLBACK_API_TOKEN         : 主副兜底共用 Token
 * - FALLBACK_BASE_URL          : 主副兜底共用 HTTPS Base URL
 * - FALLBACK_PRIMARY_MODEL     : 第一兜底模型
 * - FALLBACK_SECONDARY_MODEL   : 第二兜底模型；默认关闭；填写模型名启用；仅 off 显式关闭
 * - FALLBACK_PRIMARY_TOKEN / FALLBACK_PRIMARY_BASE_URL: 第一兜底独立覆盖
 * - FALLBACK_SECONDARY_TOKEN / FALLBACK_SECONDARY_BASE_URL: 第二兜底独立覆盖
 * - FALLBACK_MAX_CONCURRENCY_PER_ENDPOINT: 单个 Fallback 端点并发上限；默认 3
 * - FALLBACK_CLIENT_NOTICE_MODE: headers/visible/off；默认 headers
 * - FALLBACK_CLIENT_NOTICE_TEXT: 可见提示模板；支持 provider、model、tier 等占位符
 *
 * 协议与模型：
 * - MODEL_MAPPING              : 按上游 hostname 分组的 JSON 模型映射
 * - ANTHROPIC_MAX_BODY_BYTES   : Anthropic 请求体上限；默认 20 MiB
 * - ANTHROPIC_COUNT_TOKENS_MODE: approximate/disabled；默认 approximate
 * - ANTHROPIC_REASONING_REQUEST_MODE: none/reasoning_effort/chat_template_kwargs/thinking
 * - FAKE_STREAM_PROTECTION     : 非流式请求转上游流式并重组；默认 false，按需启用
 *
 * 运行保护：
 * - REQUEST_TIMEOUT_MS         : 上游首字节超时；默认 180000，范围 5000-180000
 * - MAX_BODY_BYTES             : OpenAI 请求体上限；默认 20 MiB；无 Content-Length 同样生效
 * - 压缩请求体                  : 不支持 gzip/br/deflate 请求体，统一返回 415
 * - AUTH_FAIL_COOLDOWN_MS      : 401/403 冷却；默认 86400000
 * - RATE_LIMIT_COOLDOWN_MS     : 429 冷却；默认 60000
 * - ALLOWED_ORIGIN             : CORS 来源；默认 *
 * - STRICT_MODEL_MAPPING       : true 时只允许 MODEL_MAPPING 中声明的模型
 * - ALLOW_UNSAFE_PROXY_ROUTES  : true 时允许白名单外路径；默认 false
 * - ALLOW_INSECURE_HTTP_UPSTREAM: true 时允许 HTTP 上游；默认 false
 *
 * 缓存与诊断：
 * - CACHE_ENABLED / CACHE_MAX_AGE_SEC / CACHE_MAX_BODY_BYTES
 * - LOG_LEVEL                  : none/error/info/debug；默认 info
 * - EXPOSE_UPSTREAM_INFO       : true 时在诊断中暴露上游 host/path；默认 false
 * - PROJECT_REPOSITORY_URL     : 可选 HTTPS 源码地址；用于 Dashboard 与 /version
 * - AE_DATASET                 : 可选 Workers Analytics Engine binding
 *
 * 内置端点：
 * - GET /version              : 公开的项目版本信息
 * - GET /v1/models            : 汇总可用模型；需要网关鉴权
 * - GET /health               : 当前 isolate 的端点健康快照
 * - GET /metrics              : 当前 isolate 的 Prometheus 指标
 * - POST /v1/chat/completions  : OpenAI Chat Completions
 * - POST /v1/messages          : Anthropic Messages
 *
 * 运行边界：健康分、并发、滑动窗口和冷却状态保存在当前 isolate 内，
 * 不代表跨全部边缘节点的严格全局状态。大体积直通请求不会执行模型映射或多端点重试。
 */

const APP_META = Object.freeze({
  name: 'Smart Edge Gateway',
  displayName: '智能边缘网关',
  version: '5.14.0',
});

// ============ 管理首页 ============
const DASHBOARD_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"color-scheme\" content=\"light\">\n<title>智能边缘网关</title>\n<style>\n:root{--brand:#48636f;--brand-strong:#2d424c;--brand-soft:rgba(72,99,111,.08);--brand-line:rgba(72,99,111,.18);--bg:#fff;--bg-soft:#f7f9fa;--bg-code:#171a1d;--text:#111827;--muted:#59636e;--subtle:#7b8490;--line:#e4e8eb;--shadow:0 18px 55px rgba(17,24,39,.07);--radius:12px;--font:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,\"Liberation Mono\",monospace}\n*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.7;-webkit-font-smoothing:antialiased;overflow-x:hidden}a{color:inherit}code{font-family:var(--mono);font-size:.92em}header{position:fixed;inset:0 0 auto;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 max(5%,24px);background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(228,232,235,.88);z-index:100}.brand{display:flex;align-items:center;gap:11px;font-size:17px;font-weight:650;letter-spacing:.1px}.brand-icon{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:var(--brand);box-shadow:0 6px 18px rgba(72,99,111,.22)}.source-link{display:flex;align-items:center;gap:8px;padding:7px 14px;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:13px;font-weight:600;transition:.2s ease}.source-link:hover{border-color:var(--brand);background:var(--brand-soft);color:var(--brand-strong);transform:translateY(-1px)}.source-link svg{width:18px;height:18px;flex:none}main{padding-top:64px;min-height:100vh}.doc-container{width:100%;max-width:960px;margin:0 auto;padding:70px 5% 64px}.doc-hero{text-align:center;margin:0 auto 64px;max-width:800px}.doc-hero h1{font-size:clamp(1.85rem,4.2vw,2.65rem);line-height:1.18;letter-spacing:-.035em;font-weight:700;margin-bottom:18px}.doc-hero h1 span{color:var(--brand)}.doc-hero p{max-width:730px;margin:0 auto;color:var(--muted);font-size:1.06rem}.hero-chips{display:flex;flex-wrap:wrap;justify-content:center;gap:9px;margin-top:24px}.chip{padding:6px 10px;border-radius:8px;background:var(--bg-soft);border:1px solid var(--line);font-size:12px;font-weight:650;color:var(--muted)}.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:12px;margin:30px 0 0;padding:17px 20px;border:1px solid var(--line);border-radius:var(--radius);background:linear-gradient(180deg,#fff,var(--bg-soft));box-shadow:0 12px 32px rgba(17,24,39,.04)}.flow-node{text-align:center}.flow-node strong{display:block;font-size:13px}.flow-node small{display:block;margin-top:2px;color:var(--subtle);font-size:11px}.flow-arrow{color:var(--brand);font-weight:800}.section{margin-bottom:58px;scroll-margin-top:92px}.section-title{display:flex;align-items:center;gap:11px;margin-bottom:22px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:1.42rem;font-weight:680;letter-spacing:-.02em}.section-title svg{width:23px;height:23px;color:var(--brand);flex:none}.section-content{font-size:15px;color:var(--muted)}.section-content>p{margin-bottom:13px}.section-content strong{color:var(--text)}.section-content ul{padding-left:21px;margin:10px 0 18px}.section-content li{margin:7px 0}.step-list{counter-reset:step;margin-top:18px}.step-item{position:relative;padding:0 0 25px 48px}.step-item:last-child{padding-bottom:0}.step-item:before{counter-increment:step;content:counter(step);position:absolute;left:0;top:0;width:30px;height:30px;display:grid;place-items:center;border-radius:9px;background:var(--brand);color:#fff;font-size:13px;font-weight:750;box-shadow:0 7px 17px rgba(72,99,111,.18)}.step-item:after{content:\"\";position:absolute;left:14px;top:36px;bottom:5px;width:1px;background:var(--line)}.step-item:last-child:after{display:none}.step-item h4{margin-bottom:5px;color:var(--text);font-size:16px}.step-item p{font-size:14px}.callout{margin:16px 0;padding:15px 17px;border:1px solid var(--brand-line);border-left:3px solid var(--brand);border-radius:10px;background:var(--brand-soft);color:var(--muted)}.callout strong{display:block;margin-bottom:3px}.code-editor{margin:17px 0;border:1px solid #2b3035;border-radius:11px;overflow:hidden;background:var(--bg-code);box-shadow:var(--shadow)}.code-header{height:38px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#202429;border-bottom:1px solid #30353a}.mac-dot{width:9px;height:9px;border-radius:50%}.dot-r{background:#ff605c}.dot-y{background:#ffbd44}.dot-g{background:#00ca4e}.code-header span{margin-left:7px;color:#939aa3;font-family:var(--mono);font-size:11px}.code-editor pre{padding:19px 20px;overflow:auto;color:#d7dce2;font-family:var(--mono);font-size:12.5px;line-height:1.68;tab-size:2}.kw{color:#79b8ff}.str{color:#e6a57e}.brand-str{color:#92c5d6}.cmt{color:#7d9b72}.fun{color:#e4d28b}.num{color:#b8d7a3}.var{color:#9cc7f1}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.mini-card{padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:#fff}.mini-card h3{margin-bottom:7px;color:var(--text);font-size:16px}.mini-card p{font-size:13.5px}.table-wrapper{overflow:auto;margin:17px 0;border:1px solid var(--line);border-radius:11px}table{width:100%;border-collapse:collapse;font-size:13.5px}th{padding:12px 15px;background:var(--bg-soft);border-bottom:1px solid var(--line);color:var(--text);text-align:left;font-weight:700;white-space:nowrap}td{padding:12px 15px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}td code{color:var(--brand-strong)}.tag{display:inline-block;padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700}.tag-req{background:#fff0ef;color:#b42318}.tag-opt{background:#eaf5f9;color:#276071}.tag-safe{background:#eef7ef;color:#397143}.features-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px;margin-top:18px}.feature-card{padding:22px;border:1px solid var(--line);border-radius:var(--radius);background:#fff;transition:.22s ease}.feature-card:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(17,24,39,.06);border-color:var(--brand-line)}.feature-icon{width:38px;height:38px;display:grid;place-items:center;margin-bottom:14px;border-radius:10px;background:var(--brand-soft);color:var(--brand)}.feature-card h3{margin-bottom:7px;font-size:15.5px}.feature-card p{color:var(--muted);font-size:13px;line-height:1.6}.subheading{margin:27px 0 9px;color:var(--text);font-size:16px}.header-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:13px 0 17px}.header-item{padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:var(--bg-soft);font-family:var(--mono);font-size:12px;color:var(--brand-strong)}footer{text-align:center;padding:34px 20px;border-top:1px solid var(--line);background:var(--bg-soft);color:var(--subtle);font-size:12.5px}.footer-link{text-decoration:none}.footer-link:hover{color:var(--brand-strong)}\n@media(max-width:760px){header{height:56px;padding:0 18px}.brand{font-size:15px}.brand-icon{width:25px;height:25px}.source-link{padding:6px 10px}.source-link span{display:none}main{padding-top:56px}.doc-container{padding:48px 20px 50px}.doc-hero{margin-bottom:48px}.doc-hero p{font-size:.98rem}.flow{grid-template-columns:1fr;padding:15px}.flow-arrow{transform:rotate(90deg)}.grid-2,.features-grid,.header-list{grid-template-columns:1fr}.section{margin-bottom:48px}.section-title{font-size:1.25rem}.code-editor pre{padding:16px;font-size:11.8px}.table-wrapper{margin-left:-4px;margin-right:-4px}}\n</style>\n</head>\n<body>\n<header><div class=\"brand\"><div class=\"brand-icon\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z\"/><polyline points=\"3.27 6.96 12 12.01 20.73 6.96\"/><line x1=\"12\" y1=\"22.08\" x2=\"12\" y2=\"12\"/></svg></div>智能边缘网关</div><a href=\"{{PROJECT_REPOSITORY_URL}}\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"source-link\" aria-label=\"查看源码\"><svg viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M12 .7a11.3 11.3 0 0 0-3.6 22c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17.3 4.9 18.3 5.2 18.3 5.2c.6 1.6.2 2.9.1 3.2.8.9 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.3 11.3 0 0 0 12 .7Z\"/></svg><span>源码</span></a></header>\n<main><div class=\"doc-container\">\n<section class=\"doc-hero\"><h1>双协议接入，<span>Primary → Fallback</span> 稳定路由</h1><p>同时兼容 OpenAI Chat Completions 与 Anthropic Messages / Claude Code。主端点负责日常调度，兜底端点仅在主链路不可用时接管，并通过响应头或可选正文提示向客户端反馈实际路由。</p><div class=\"hero-chips\"><span class=\"chip\">OpenAI SDK</span><span class=\"chip\">Claude Code</span><span class=\"chip\">模型映射</span><span class=\"chip\">健康轮换</span><span class=\"chip\">双级兜底</span></div><div class=\"flow\"><div class=\"flow-node\"><strong>Client</strong><small>OpenAI / Anthropic</small></div><div class=\"flow-arrow\">→</div><div class=\"flow-node\"><strong>Primary Pool</strong><small>轮换 · 健康评分 · 重试</small></div><div class=\"flow-arrow\">→</div><div class=\"flow-node\"><strong>Fallback</strong><small>Primary / Secondary</small></div></div></section>\n\n<section class=\"section\" id=\"deploy\"><h2 class=\"section-title\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M13 2L3 14h9l-1 8 10-12h-9l1-8z\"/></svg>部署步骤</h2><div class=\"section-content\"><div class=\"step-list\"><div class=\"step-item\"><h4>创建并部署 Worker</h4><p>在 Cloudflare Workers & Pages 中创建 Worker，用完整源码覆盖默认代码并部署。</p></div><div class=\"step-item\"><h4>设置网关鉴权</h4><p>将 <code>GATEWAY_ACCESS_KEY</code> 设置为机密。客户端通过 Bearer Token 或 <code>x-api-key</code> 提交该访问密钥。</p></div><div class=\"step-item\"><h4>配置 Primary 端点</h4><p>设置 <code>PRIMARY_API_TOKENS</code>，并通过共享 <code>PRIMARY_BASE_URL</code> 或 <code>Token@BaseURL</code> 绑定 OpenAI 兼容上游。</p></div><div class=\"step-item\"><h4>配置可选 Fallback</h4><p>设置兜底 Token、Base URL 与主副模型。兜底不会参与日常轮询，仅在 Primary 尝试失败后依次接管。</p></div><div class=\"step-item\"><h4>绑定域名并验证</h4><p>绑定自定义域名后访问 <code>/health</code>；再分别测试 <code>/v1/chat/completions</code> 与 <code>/v1/messages</code>。</p></div></div></div></section>\n\n<section class=\"section\" id=\"clients\"><h2 class=\"section-title\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M16 18l6-6-6-6\"/><path d=\"M8 6l-6 6 6 6\"/></svg>客户端接入</h2><div class=\"section-content\"><div class=\"grid-2\"><div class=\"mini-card\"><h3>OpenAI 兼容客户端</h3><p>Base URL 使用网关的 <code>/v1</code>，接口保持 <code>/chat/completions</code>。</p></div><div class=\"mini-card\"><h3>Claude Code</h3><p><code>ANTHROPIC_BASE_URL</code> 只填写域名根地址，不附加 <code>/v1</code>。</p></div></div><h3 class=\"subheading\">Claude Code 配置</h3><div class=\"code-editor\"><div class=\"code-header\"><i class=\"mac-dot dot-r\"></i><i class=\"mac-dot dot-y\"></i><i class=\"mac-dot dot-g\"></i><span>settings.json</span></div><pre><code>{\n  <span class=\"str\">\"env\"</span>: {\n    <span class=\"str\">\"ANTHROPIC_BASE_URL\"</span>: <span class=\"brand-str\">\"https://api.yourdomain.com\"</span>,\n    <span class=\"str\">\"ANTHROPIC_AUTH_TOKEN\"</span>: <span class=\"brand-str\">\"your-gateway-access-key\"</span>,\n    <span class=\"str\">\"ANTHROPIC_MODEL\"</span>: <span class=\"brand-str\">\"model-alias\"</span>,\n    <span class=\"str\">\"ANTHROPIC_DEFAULT_OPUS_MODEL\"</span>: <span class=\"brand-str\">\"model-alias\"</span>,\n    <span class=\"str\">\"ANTHROPIC_DEFAULT_SONNET_MODEL\"</span>: <span class=\"brand-str\">\"model-alias\"</span>,\n    <span class=\"str\">\"ANTHROPIC_DEFAULT_HAIKU_MODEL\"</span>: <span class=\"brand-str\">\"model-alias-fast\"</span>,\n    <span class=\"str\">\"CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS\"</span>: <span class=\"brand-str\">\"1\"</span>\n  }\n}</code></pre></div><h3 class=\"subheading\">OpenAI cURL</h3><div class=\"code-editor\"><div class=\"code-header\"><i class=\"mac-dot dot-r\"></i><i class=\"mac-dot dot-y\"></i><i class=\"mac-dot dot-g\"></i><span>Terminal</span></div><pre><code><span class=\"fun\">curl</span> https://api.yourdomain.com/v1/chat/completions \\\\\n  -H <span class=\"str\">\"Authorization: Bearer your-gateway-access-key\"</span> \\\\\n  -H <span class=\"str\">\"Content-Type: application/json\"</span> \\\\\n  -d <span class=\"str\">'{\"model\":\"model-alias\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'</span></code></pre></div><div class=\"callout\"><strong>协议桥接</strong>Claude Code 请求的 <code>/v1/messages</code> 会被转换为上游 <code>/v1/chat/completions</code>；工具调用、图片、thinking、usage 与 SSE 事件在网关内完成双向适配。</div></div></section>\n\n<section class=\"section\" id=\"env\"><h2 class=\"section-title\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z\"/></svg>环境变量</h2><div class=\"section-content\"><div class=\"table-wrapper\"><table><thead><tr><th>变量</th><th>类型</th><th>用途</th></tr></thead><tbody><tr><td><code>GATEWAY_ACCESS_KEY</code></td><td><span class=\"tag tag-req\">必填</span></td><td>客户端访问网关所使用的鉴权密钥。</td></tr><tr><td><code>PRIMARY_API_TOKENS</code></td><td><span class=\"tag tag-req\">必填</span></td><td>Primary Token 列表；支持 <code>Token@BaseURL</code>。</td></tr><tr><td><code>PRIMARY_BASE_URL</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>未单独绑定 URL 时使用的共享上游地址。</td></tr><tr><td><code>MODEL_MAPPING</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>按上游 hostname 映射客户端模型别名。</td></tr><tr><td><code>FALLBACK_API_TOKEN</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>主副兜底共用 Token，也可分别覆盖。</td></tr><tr><td><code>FALLBACK_BASE_URL</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>主副兜底共用 OpenAI 兼容 Base URL。</td></tr><tr><td><code>FALLBACK_PRIMARY_MODEL</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>第一兜底模型。</td></tr><tr><td><code>FALLBACK_SECONDARY_MODEL</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>第二兜底模型；默认关闭，填写模型名启用，填写 <code>off</code> 显式关闭。</td></tr><tr><td><code>FALLBACK_CLIENT_NOTICE_MODE</code></td><td><span class=\"tag tag-safe\">推荐</span></td><td><code>headers</code>、<code>visible</code> 或 <code>off</code>；默认 headers。</td></tr><tr><td><code>STRICT_MODEL_MAPPING</code></td><td><span class=\"tag tag-safe\">推荐</span></td><td>设为 <code>true</code> 后，只允许配置中声明的模型名。</td></tr><tr><td><code>FAKE_STREAM_PROTECTION</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>默认 <code>false</code>；启用后可能改变结构化输出行为。</td></tr><tr><td><code>ALLOW_UNSAFE_PROXY_ROUTES</code></td><td><span class=\"tag tag-safe\">安全</span></td><td>默认 <code>false</code>；仅开放聊天、模型和诊断接口。</td></tr><tr><td><code>ALLOW_INSECURE_HTTP_UPSTREAM</code></td><td><span class=\"tag tag-safe\">安全</span></td><td>默认 <code>false</code>；Primary 只接受 HTTPS。</td></tr><tr><td><code>MODEL_LIST_TIMEOUT_MS</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>单个模型列表上游请求超时；默认 5000 ms。</td></tr><tr><td><code>MODEL_LIST_MAX_ATTEMPTS</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>模型列表最多尝试的 Primary 数量；默认 3。</td></tr><tr><td><code>REQUEST_TIMEOUT_MS</code></td><td><span class=\"tag tag-opt\">可选</span></td><td>上游首字节超时，代码最大限制为 180000 ms。</td></tr></tbody></table></div><h3 class=\"subheading\">Primary 与 Fallback</h3><div class=\"code-editor\"><div class=\"code-header\"><i class=\"mac-dot dot-r\"></i><i class=\"mac-dot dot-y\"></i><i class=\"mac-dot dot-g\"></i><span>环境变量</span></div><pre><code><span class=\"var\">PRIMARY_API_TOKENS</span>=<span class=\"str\">token-a@https://primary-a.example/v1,token-b@https://primary-b.example/v1</span>\n<span class=\"var\">STRICT_MODEL_MAPPING</span>=<span class=\"str\">true</span>\n<span class=\"var\">FAKE_STREAM_PROTECTION</span>=<span class=\"str\">false</span>\n<span class=\"var\">ALLOW_UNSAFE_PROXY_ROUTES</span>=<span class=\"str\">false</span>\n\n<span class=\"var\">FALLBACK_ENABLED</span>=<span class=\"str\">true</span>\n<span class=\"var\">FALLBACK_API_TOKEN</span>=<span class=\"str\">fallback-token</span>\n<span class=\"var\">FALLBACK_BASE_URL</span>=<span class=\"str\">https://fallback.example/v1</span>\n<span class=\"var\">FALLBACK_PRIMARY_MODEL</span>=<span class=\"str\">model-pro</span>\n<span class=\"var\">FALLBACK_SECONDARY_MODEL</span>=<span class=\"str\">model-flash</span>\n<span class=\"var\">FALLBACK_CLIENT_NOTICE_MODE</span>=<span class=\"str\">headers</span></code></pre></div><div class=\"callout\"><strong>第二兜底开关</strong>不设置 <code>FALLBACK_SECONDARY_MODEL</code> 时默认关闭；填写具体模型名后启用；需要显式关闭时只使用 <code>off</code>。</div><h3 class=\"subheading\">模型映射</h3><div class=\"code-editor\"><div class=\"code-header\"><i class=\"mac-dot dot-r\"></i><i class=\"mac-dot dot-y\"></i><i class=\"mac-dot dot-g\"></i><span>MODEL_MAPPING</span></div><pre><code>{\n  <span class=\"str\">\"primary-a.example\"</span>: {\n    <span class=\"str\">\"model-alias\"</span>: <span class=\"str\">\"vendor/model-large\"</span>,\n    <span class=\"str\">\"model-alias-fast\"</span>: <span class=\"str\">\"vendor/model-fast\"</span>\n  },\n  <span class=\"str\">\"fallback.example\"</span>: {\n    <span class=\"str\">\"model-pro\"</span>: {\n      <span class=\"str\">\"model\"</span>: <span class=\"str\">\"actual-pro-id\"</span>,\n      <span class=\"str\">\"capabilities\"</span>: { <span class=\"str\">\"tools\"</span>: <span class=\"kw\">true</span>, <span class=\"str\">\"expose_reasoning\"</span>: <span class=\"kw\">true</span> }\n    }\n  }\n}</code></pre></div></div></section>\n\n<section class=\"section\" id=\"feedback\"><h2 class=\"section-title\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z\"/><path d=\"M8 9h8M8 13h5\"/></svg>兜底反馈</h2><div class=\"section-content\"><p>当 Primary 链路耗尽并切换至 Fallback 时，网关会向客户端返回结构化路由信息。浏览器客户端可直接读取这些响应头，因为页面已配置 <code>Access-Control-Expose-Headers</code>。</p><div class=\"header-list\"><div class=\"header-item\">x-edge-gateway-route: fallback</div><div class=\"header-item\">x-edge-gateway-fallback-provider</div><div class=\"header-item\">x-edge-gateway-fallback-tier</div><div class=\"header-item\">x-edge-gateway-fallback-model</div><div class=\"header-item\">x-edge-gateway-requested-model</div><div class=\"header-item\">x-edge-gateway-primary-attempts</div></div><div class=\"grid-2\"><div class=\"mini-card\"><h3>headers（默认）</h3><p>仅返回响应头，不改变模型正文，适合 Claude Code 与自动化 Agent。</p></div><div class=\"mini-card\"><h3>visible</h3><p>除响应头外，在普通文本回答首段加入提示；纯工具调用自动跳过，避免影响工具解析。</p></div></div><div class=\"code-editor\"><div class=\"code-header\"><i class=\"mac-dot dot-r\"></i><i class=\"mac-dot dot-y\"></i><i class=\"mac-dot dot-g\"></i><span>可选提示</span></div><pre><code><span class=\"var\">FALLBACK_CLIENT_NOTICE_MODE</span>=<span class=\"str\">visible</span>\n<span class=\"var\">FALLBACK_CLIENT_NOTICE_TEXT</span>=<span class=\"str\">[智能边缘网关] 主端点不可用，已切换至 {provider} / {model}（{tier}）。</span></code></pre></div><div class=\"callout\"><strong>安全规则</strong>Anthropic 响应的 <code>model</code> 字段会报告实际兜底模型。可见提示会改变文本正文，不适合严格 JSON 或结构化输出；工具调用、tool_result 与 JSON 参数不做改写。</div></div></section>\n\n<section class=\"section\" id=\"diagnostics\"><h2 class=\"section-title\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\"/><path d=\"M9 12l2 2 4-4\"/></svg>诊断与能力</h2><div class=\"section-content\"><div class=\"features-grid\"><article class=\"feature-card\"><div class=\"feature-icon\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M22 12h-4l-3 9L9 3l-3 9H2\"/></svg></div><h3>健康轮换</h3><p>冷却、窗口或并发达到上限时直接跳过端点；其余端点再按健康分与延迟排序。</p></article><article class=\"feature-card\"><div class=\"feature-icon\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M21 12a9 9 0 1 1-9-9\"/><path d=\"M21 3v6h-6\"/></svg></div><h3>严格兜底</h3><p>Fallback 不参与正常轮询；第一兜底失败后才尝试第二兜底，并分别维护冷却状态。</p></article><article class=\"feature-card\"><div class=\"feature-icon\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M4 4h16v16H4z\"/><path d=\"M8 9h8M8 13h5\"/></svg></div><h3>双协议桥接</h3><p>支持文本、图片、工具、并行工具、thinking、usage、错误体和 Anthropic SSE 事件序列。</p></article><article class=\"feature-card\"><div class=\"feature-icon\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6\"/></svg></div><h3>长文保护</h3><p>可按需把 OpenAI 非流式请求转为上游流式并在边缘重组；默认关闭，避免改变结构化输出语义。</p></article><article class=\"feature-card\"><div class=\"feature-icon\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M3 12h18M12 3v18\"/></svg></div><h3>动态映射</h3><p>按实际上游 hostname 翻译模型别名，并支持独立 invoke URL 与模型能力声明。</p></article><article class=\"feature-card\"><div class=\"feature-icon\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 8v4l3 2\"/></svg></div><h3>实时诊断</h3><p><code>/health</code> 查看客户端请求与端点状态，<code>/metrics</code> 输出当前 isolate 的 Prometheus 指标；包括 Fallback 触发次数，延迟表示到响应头的首字节时间，均需网关鉴权。</p></article></div><div class=\"callout\"><strong>兼容边界</strong>非 Anthropic 上游无法提供 Anthropic 原生可验证 thinking 签名与精确 token 计数。网关采用兼容签名和近似统计，适合协议桥接，不等同于 Anthropic 原生服务。</div></div></section>\n</div></main>\n<footer><p>&copy; <script>document.write(new Date().getFullYear())</script> <a href=\"https://www.fongap.com\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"footer-link\">Fongap EngineSuite WorkGroup</a></p></footer>\n</body>\n</html>";

function getDashboardHtml(env) {
  const configuration = getGatewayConfigurationState(env);
  if (!configuration.ready) return getSetupHtml(configuration);

  const repositoryUrl = readProjectRepositoryUrl(env);
  let content = DASHBOARD_HTML.replace(
    '</tbody>',
    '<tr><td><code>PRIMARY_ROTATION_MAX_PER_WINDOW</code></td><td><span class="tag tag-opt">可选</span></td><td>单个 Primary 在统计窗口内的请求硬上限；默认 40。</td></tr></tbody>'
  );
  const sourceLink = /<a href="\{\{PROJECT_REPOSITORY_URL\}\}"[^>]*class="source-link"[^>]*>[\s\S]*?<\/a>/;
  content = repositoryUrl
    ? content.replace('{{PROJECT_REPOSITORY_URL}}', escapeHtmlAttribute(repositoryUrl))
    : content.replace(sourceLink, '');
  return content;
}

function getGatewayConfigurationState(env) {
  const gatewayAccessKeyBound = Boolean(readOptionalEnv(env, 'GATEWAY_ACCESS_KEY'));
  const primaryApiTokensBound = Boolean(readOptionalEnv(env, 'PRIMARY_API_TOKENS'));
  return {
    ready: gatewayAccessKeyBound && primaryApiTokensBound,
    gatewayAccessKeyBound,
    primaryApiTokensBound,
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
<title>智能边缘网关 · 初始化</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#172126;background:#f4f7f8}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}.card{width:min(680px,100%);padding:36px;border:1px solid #dce4e7;border-radius:18px;background:#fff;box-shadow:0 20px 60px rgba(27,48,58,.1)}.mark{width:48px;height:48px;display:grid;place-items:center;border-radius:14px;background:#48636f;color:#fff;font-size:24px}h1{margin:22px 0 8px;font-size:28px;letter-spacing:-.02em}p{margin:0;color:#66747b;line-height:1.75}.success{margin:22px 0;padding:14px 16px;border:1px solid #cde8d3;border-radius:12px;background:#f1faf3;color:#28723a}.list{margin:20px 0;display:grid;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border:1px solid #e2e8ea;border-radius:12px}.row code{font-size:13px;overflow-wrap:anywhere}.status{flex:none;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}.ready{background:#e9f7ed;color:#26713a}.pending{background:#fff3db;color:#995f00}.steps{padding:18px;border-radius:12px;background:#f5f8f9}.steps strong{display:block;margin-bottom:7px}.steps ol{margin:0;padding-left:20px;color:#536168;line-height:1.8}.note{margin-top:18px;font-size:13px}.actions{display:flex;align-items:center;gap:14px;margin-top:22px}.button{display:inline-block;padding:10px 16px;border-radius:10px;background:#48636f;color:#fff;text-decoration:none;font-weight:700}.auto{font-size:13px;color:#76838a}@media(max-width:560px){.card{padding:24px}.row{align-items:flex-start;flex-direction:column;gap:8px}h1{font-size:24px}}
</style>
</head>
<body>
<main class="card">
  <div class="mark">✓</div>
  <h1>Worker 已部署，等待完成配置</h1>
  <p>代码已经正常运行。添加下面两个 Secret 后，网关会进入可用状态，本页将自动切换到正常主页。</p>
  <div class="success">首次部署成功，无需重新修改或上传源代码。</div>
  <div class="list">
    <div class="row"><code>GATEWAY_ACCESS_KEY</code>${status(configuration.gatewayAccessKeyBound)}</div>
    <div class="row"><code>PRIMARY_API_TOKENS</code>${status(configuration.primaryApiTokensBound)}</div>
  </div>
  <div class="steps">
    <strong>在 Cloudflare 中完成配置</strong>
    <ol>
      <li>打开当前 Worker 的“设置 → 变量和机密”。</li>
      <li>把以上缺少的项目添加为 Secret。</li>
      <li>保存并等待新部署生效。</li>
    </ol>
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
const MAX_SAFE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_UPSTREAM_JSON_BYTES = 20 * 1024 * 1024;


// ============ 主端点请求窗口 ============

class RequestRingBuffer {
  constructor(maxSize = RING_BUFFER_MIN_SIZE) {
    this.buffer = new Float64Array(maxSize);
    this.head = 0;
    this.count = 0;
  }

  record(timestamp) {
    this.buffer[this.head] = timestamp;
    this.head = (this.head + 1) % this.buffer.length;
    if (this.count < this.buffer.length) this.count++;
  }

  getRecentCount(windowMs, now) {
    const threshold = now - windowMs;
    const buf = this.buffer;
    let validCount = 0;
    for (let i = 0; i < this.count; i++) {
      if (buf[i] > threshold) validCount++;
    }
    return validCount;
  }

  resize(maxSize) {
    const nextSize = Math.max(RING_BUFFER_MIN_SIZE, Number(maxSize) || RING_BUFFER_MIN_SIZE);
    if (nextSize === this.buffer.length) return;
    const values = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.head - this.count + i + this.buffer.length) % this.buffer.length;
      values.push(this.buffer[index]);
    }
    const kept = values.slice(-nextSize);
    this.buffer = new Float64Array(nextSize);
    this.head = 0;
    this.count = 0;
    for (const value of kept) this.record(value);
  }
}

// ============ 请求体限制 ============

class BodyTooLargeError extends Error {
  constructor(message) {
    super(message || 'Request body exceeds limit.');
    this.name = 'BodyTooLargeError';
  }
}

// ============ Isolate 内运行状态 ============
// endpointState 仅在当前 isolate 内共享。健康分、并发、窗口计数与冷却状态均为局部近似值；
// 如需跨边缘节点的严格一致性，应改用 Durable Object 或外部协调存储。
const endpointState = new Map();
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
let lastCleanupTime = 0;
let g_ringBufferSize = RING_BUFFER_MIN_SIZE;

// ============ 请求入口 ============

async function handleRequest(request, env, ctx) {
    const logger = getLogger(env);
    const requestId = crypto.randomUUID();
    const requestUrl = new URL(request.url);
    const normalizedPath = normalizeGatewayPath(requestUrl.pathname);
    const route = detectGatewayRoute(request.method, normalizedPath);
    const isAnthropicClient = route === 'anthropic_messages' || route === 'anthropic_count_tokens';

    const now = Date.now();
    if (now - lastCleanupTime > CLEANUP_INTERVAL_MS) {
      lastCleanupTime = now;
      cleanupStaleState();
    }

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

    const primaryEndpoints = buildPrimaryEndpoints(env);
    const fallbackEndpoints = buildFallbackEndpoints(env);
    if (primaryEndpoints.length === 0 && fallbackEndpoints.length === 0) {
      return gatewayError(request, env, isAnthropicClient, 500,
        'Gateway misconfigured: no primary endpoint token and no fallback API token are configured.',
        undefined, requestId);
    }

    let modelMapping = {};
    const mappingRaw = readOptionalEnv(env, 'MODEL_MAPPING');
    if (mappingRaw) {
      try {
        modelMapping = parseAndValidateModelMapping(mappingRaw, env);
      } catch (error) {
        logger.error('MODEL_MAPPING parse error:', error.message);
        return gatewayError(request, env, isAnthropicClient, 500,
          `Gateway misconfigured: MODEL_MAPPING is invalid (${error.message}).`,
          undefined, requestId);
      }
    }

    if (isModelsListRoute(request.method, normalizedPath)) {
      return await modelsListResponse({
        request,
        env,
        requestId,
        primaryEndpoints,
        fallbackEndpoints,
        modelMapping,
      });
    }

    const strictModelMapping = readBooleanEnv(env, 'STRICT_MODEL_MAPPING', false);
    if (strictModelMapping) {
      if (!bodyParsed || !originalBodyJson || typeof originalBodyJson.model !== 'string') {
        return gatewayError(request, env, isAnthropicClient, 400,
          'STRICT_MODEL_MAPPING requires a JSON request body with a model field.', undefined, requestId);
      }
      if (!isRequestedModelAllowed(originalBodyJson.model, primaryEndpoints, fallbackEndpoints, modelMapping)) {
        return gatewayError(request, env, isAnthropicClient, 400,
          `Model "${originalBodyJson.model}" is not allowed by STRICT_MODEL_MAPPING.`, undefined, requestId);
      }
    }

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

    const configuredPrimaryMaxAttempts = primaryEndpoints.length > 0
      ? clampInt(
          readOptionalEnv(env, 'PRIMARY_MAX_ATTEMPTS'),
          1,
          primaryEndpoints.length,
          Math.min(primaryEndpoints.length, DEFAULT_PRIMARY_MAX_ATTEMPTS)
        )
      : 0;
    const primaryMaxAttempts = isDirectStream ? Math.min(1, primaryEndpoints.length) : configuredPrimaryMaxAttempts;
    const timeoutMs = clampInt(
      readOptionalEnv(env, 'REQUEST_TIMEOUT_MS'),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    );
    const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);

    const primarySelectionConfig = {
      rotationWindowMs: clampInt(readOptionalEnv(env, 'PRIMARY_ROTATION_WINDOW_MS'), 10_000, 18_000_000, DEFAULT_PRIMARY_ROTATION_WINDOW_MS),
      rotationMaxPerWindow: clampInt(readOptionalEnv(env, 'PRIMARY_ROTATION_MAX_PER_WINDOW'), 1, 1000, DEFAULT_PRIMARY_ROTATION_MAX_PER_WINDOW),
      maxConcurrencyPerEndpoint: clampInt(readOptionalEnv(env, 'PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT'), 1, 100, DEFAULT_PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT),
    };

    g_ringBufferSize = Math.max(RING_BUFFER_MIN_SIZE, primarySelectionConfig.rotationMaxPerWindow * 4);
    const strictEligiblePrimaryEndpoints = strictModelMapping && originalBodyJson?.model
      ? primaryEndpoints.filter(endpoint => isModelAllowedForEndpoint(
          originalBodyJson.model,
          endpoint,
          modelMapping
        ))
      : primaryEndpoints;
    const primaryCandidates = strictEligiblePrimaryEndpoints.length > 0
      ? selectPrimaryEndpoints(
          strictEligiblePrimaryEndpoints,
          Math.min(primaryMaxAttempts, strictEligiblePrimaryEndpoints.length),
          primarySelectionConfig,
          originalBodyJson,
          request
        )
      : [];
    const candidates = [...primaryCandidates];

    // Fallback 不参与 Primary 轮询，并按 primary → secondary 顺序尝试。
    // 大体积直通请求体不可重复消费，因此最多发送至一个候选端点。
    const fallbackEligible = isFallbackEligible(route, normalizedPath)
      && (!isDirectStream || primaryCandidates.length === 0);
    if (fallbackEligible) {
      const fallbackMaxConcurrency = clampInt(
        readOptionalEnv(env, 'FALLBACK_MAX_CONCURRENCY_PER_ENDPOINT'),
        1,
        100,
        DEFAULT_PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT
      );
      const availableFallbacks = fallbackEndpoints.filter(ep => {
        const state = getEndpointState(ep.id);
        if (isCoolingDown(ep.id)) return false;
        if (state.activeRequests >= fallbackMaxConcurrency) return false;
        return true;
      });
      candidates.push(...(isDirectStream ? availableFallbacks.slice(0, 1) : availableFallbacks));
    }

    if (candidates.length === 0 && strictModelMapping && originalBodyJson?.model) {
      return gatewayError(request, env, isAnthropicClient, 400,
        `Model "${originalBodyJson.model}" is allowed globally but no currently available endpoint can route it.`,
        undefined, requestId);
    }

    if (candidates.length === 0) {
      const allKnownEndpoints = [...primaryEndpoints, ...fallbackEndpoints];
      const retryAfter = nextCooldownMs(allKnownEndpoints);
      return gatewayError(request, env, isAnthropicClient, 429,
        'All primary and fallback upstream endpoints are temporarily unavailable.', {
          retry_after_ms: retryAfter,
          primary_endpoints_total: primaryEndpoints.length,
          primary_endpoints_cooling: primaryEndpoints.filter(ep => isCoolingDown(ep.id)).length,
          fallback_configured: fallbackEndpoints.length > 0,
          fallback_endpoints: fallbackEndpoints.map(ep => ({
            tier: ep.fallbackTier,
            order: ep.fallbackOrder,
            provider: exposeUpstreamInfo ? ep.providerName : getEndpointRole(ep),
            model: ep.configuredModel,
            cooling: isCoolingDown(ep.id),
          })),
        }, requestId);
    }

    const attempts = [];
    const requestedModel = originalBodyJson?.model || 'unknown';
    const anthropicClientWantsStream = route === 'anthropic_messages' && originalBodyJson?.stream === true;
    let fallbackChainEntered = false;

    for (let index = 0; index < candidates.length; index++) {
      const endpoint = candidates[index];
      if (endpoint.role === 'fallback' && !fallbackChainEntered) {
        fallbackChainEntered = true;
        gatewayStats.fallbackActivations++;
      }
      recordRequestStart(endpoint.id);

      let targetUrl;
      let targetHost;
      let modelConfig;
      let currentBody = requestBodyBuffer;
      try {
        const endpointUrl = new URL(endpoint.baseUrl);
        targetHost = endpointUrl.hostname;
        modelConfig = endpoint.role === 'fallback'
          ? buildFallbackModelConfig(endpoint, modelMapping, requestedModel)
          : resolveModelConfig(modelMapping, targetHost, requestedModel);

        const upstreamRequestUrl = new URL(requestUrl.toString());
        if (route === 'openai_chat' || route === 'anthropic_messages') {
          upstreamRequestUrl.pathname = '/v1/chat/completions';
        }

        targetUrl = buildTargetUrl(upstreamRequestUrl, endpoint.baseUrl);
        if (modelConfig.invoke_url) {
          const forcedUrl = normalizeInvokeUrl(
            modelConfig.invoke_url,
            readBooleanEnv(env, 'ALLOW_INSECURE_HTTP_UPSTREAM', false)
          );
          if (!forcedUrl) throw new Error('MODEL_MAPPING invoke_url must be an absolute HTTPS URL without embedded credentials.');
          const forced = new URL(forcedUrl);
          mergeSearchParams(forced, requestUrl);
          targetUrl = forced.toString();
          targetHost = forced.hostname;
        }

        if (route === 'anthropic_messages') {
          const openAIBody = anthropicToOpenAIRequest(originalBodyJson, modelConfig, env);
          openAIBody.model = modelConfig.model || requestedModel;
          currentBody = JSON.stringify(openAIBody);
        } else if (originalBodyText !== null) {
          const outbound = bodyParsed && originalBodyJson
            ? { ...originalBodyJson, model: modelConfig.model || originalBodyJson.model }
            : null;
          currentBody = outbound ? JSON.stringify(applyModelRequestConfig(outbound, modelConfig)) : originalBodyText;
        }
      } catch (e) {
        recordFailure(endpoint.id, 500, 5_000, 'Invalid dynamic Base URL or request conversion');
        attempts.push(await buildAttemptRecord({
          attempt: index + 1,
          status: 500,
          endpoint,
          error: `Gateway conversion error: ${e.message || String(e)}`,
          upstreamHost: targetHost || null,
          upstreamPath: null,
          exposeUpstreamInfo,
          endpointRole: getEndpointRole(endpoint),
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
        const upstream = await fetch(targetUrl, {
          method: request.method,
          headers,
          body: currentBody,
          redirect: 'manual',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const elapsedMs = Date.now() - requestStartTime;

        if (upstream.ok || (upstream.status >= 400 && !RETRYABLE_STATUS.has(upstream.status))) {
          const isStreaming = isStreamingResponse(upstream);
          const primaryFailureCount = attempts.filter(item => item.endpoint_role === 'primary').length;
          const fallbackFeedback = endpoint.role === 'fallback'
            ? buildFallbackClientFeedback(env, endpoint, requestedModel, modelConfig.model || endpoint.configuredModel, primaryFailureCount)
            : null;
          const extraHeaders = {
            'x-edge-gateway-attempts': String(index + 1),
            'x-edge-gateway-upstream-status': String(upstream.status),
            'x-edge-gateway-cache': 'MISS',
            'x-edge-gateway-health': String(getEndpointState(endpoint.id).healthScore),
            'x-request-id': requestId,
            ...(fallbackFeedback?.headers || {}),
          };
          if (exposeUpstreamInfo) extraHeaders['x-edge-gateway-upstream-host'] = targetHost;
          if (fallbackFeedback) {
            logger.info(`Fallback activated: provider=${fallbackFeedback.provider}, tier=${fallbackFeedback.tier}, model=${fallbackFeedback.reportedModel}, primary_attempts=${fallbackFeedback.primaryAttempts}`);
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
                  fallbackFeedback,
                  logger
                );
              } else {
                if (request.signal && clientAbortListener) {
                  request.signal.removeEventListener('abort', clientAbortListener);
                }
                const openAIData = await safeJsonResponse(upstream);
                const message = openAIToAnthropicMessage(openAIData, requestedModel, modelConfig, fallbackFeedback);
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
            const anthropicMessage = openAIToAnthropicMessage(openAIData, requestedModel, modelConfig, fallbackFeedback);
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
              fallbackFeedback?.reportedModel || requestedModel,
              requestId,
              request,
              env,
              extraHeaders,
              logger,
              ctx,
              fallbackFeedback
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

          if (fallbackFeedback?.visible && upstream.ok && !isStreaming) {
            const openAIData = await safeJsonResponse(upstream);
            applyOpenAIFallbackNotice(openAIData, fallbackFeedback);
            recordSuccess(endpoint.id, elapsedMs);
            return new Response(JSON.stringify(openAIData), {
              status: 200,
              headers: {
                'content-type': 'application/json;charset=UTF-8',
                'cache-control': 'no-store',
                ...corsHeaders(request, env),
                ...extraHeaders,
              },
            });
          }

          if (fallbackFeedback?.visible && upstream.ok && isStreaming) {
            const transformed = transformOpenAIStreamWithFallbackNotice(
              upstream, fallbackFeedback, request.signal, clientAbortListener
            );
            return withCors(trackEndpointStream(transformed, endpoint.id, elapsedMs), request, env, extraHeaders);
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

          if (!isStreaming && upstream.ok) recordSuccess(endpoint.id, elapsedMs);
          const responseForClient = isStreaming && upstream.ok
            ? trackEndpointStream(upstream, endpoint.id, elapsedMs)
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
          endpointRole: getEndpointRole(endpoint),
        }));

        if (NON_HEALTH_IMPACT_STATUS.has(upstream.status)) {
          recordNeutralEnd(endpoint.id);
        } else {
          const retryAfterMs = getRetryAfterMs(upstream.headers) || defaultCooldownMs(upstream.status, env);
          recordFailure(endpoint.id, upstream.status,
            applyExponentialBackoff(endpoint.id, upstream.status, retryAfterMs),
            `HTTP ${upstream.status}`);
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
          endpointRole: getEndpointRole(endpoint),
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
      ? `Upstream returned 404 for model "${requestedModel}". Verify MODEL_MAPPING and the mapped invoke_url.`
      : isTimeoutError
        ? 'Upstream timed out for all endpoints.'
        : 'Upstream request failed after endpoint rotation.';

    return gatewayError(request, env, isAnthropicClient, status, message, {
      attempts,
      request_id: requestId,
      request_path: requestUrl.pathname,
      requested_model: requestedModel,
      hint: route === 'anthropic_messages'
        ? 'The gateway converted /v1/messages to /v1/chat/completions. Primary endpoints were attempted first, followed by the configured fallback endpoints.'
        : 'Inspect attempts[] and verify MODEL_MAPPING, primary endpoint availability, and fallback configuration.',
      fallback_configured: fallbackEndpoints.length > 0,
      fallback_order: fallbackEndpoints.map(ep => ({
        tier: ep.fallbackTier,
        order: ep.fallbackOrder,
        provider: exposeUpstreamInfo ? ep.providerName : getEndpointRole(ep),
        ...(exposeUpstreamInfo ? { base_url: ep.baseUrl } : {}),
        model: ep.configuredModel,
      })),
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

function parseAndValidateModelMapping(raw, env) {
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('root value must be a JSON object');
  const allowInsecureHttp = readBooleanEnv(env, 'ALLOW_INSECURE_HTTP_UPSTREAM', false);
  const normalized = {};
  for (const [rawHost, hostMapping] of Object.entries(parsed)) {
    const host = String(rawHost || '').trim().toLowerCase();
    if (!host || !isPlainObject(hostMapping)) throw new Error(`mapping for host "${rawHost}" must be an object`);
    if (Object.prototype.hasOwnProperty.call(normalized, host)) {
      throw new Error(`duplicate mapping host after case normalization: "${rawHost}"`);
    }
    const normalizedHostMapping = {};
    for (const [rawAlias, config] of Object.entries(hostMapping)) {
      const alias = String(rawAlias || '').trim();
      if (!alias) throw new Error(`host "${rawHost}" contains an empty model alias`);
      if (Object.prototype.hasOwnProperty.call(normalizedHostMapping, alias)) {
        throw new Error(`host "${rawHost}" contains duplicate model alias "${alias}"`);
      }
      if (typeof config === 'string') {
        if (!config.trim()) throw new Error(`mapping "${rawHost}.${alias}" must not be empty`);
        normalizedHostMapping[alias] = config.trim();
        continue;
      }
      if (!isPlainObject(config)) throw new Error(`mapping "${rawHost}.${alias}" must be a string or object`);
      if (config.model !== undefined && (typeof config.model !== 'string' || !config.model.trim())) {
        throw new Error(`mapping "${rawHost}.${alias}.model" must be a non-empty string`);
      }
      if (config.invoke_url !== undefined && !normalizeInvokeUrl(config.invoke_url, allowInsecureHttp)) {
        throw new Error(`mapping "${rawHost}.${alias}.invoke_url" must be an absolute HTTPS URL without embedded credentials`);
      }
      if (config.capabilities !== undefined && !isPlainObject(config.capabilities)) {
        throw new Error(`mapping "${rawHost}.${alias}.capabilities" must be an object`);
      }
      if (config.request_overrides !== undefined && !isPlainObject(config.request_overrides)) {
        throw new Error(`mapping "${rawHost}.${alias}.request_overrides" must be an object`);
      }
      const protectedRequestFields = new Set(['model', 'messages', 'stream']);
      if (config.request_overrides && Object.keys(config.request_overrides).some(key => protectedRequestFields.has(key))) {
        throw new Error(`mapping "${rawHost}.${alias}.request_overrides" must not override model, messages, or stream`);
      }
      if (config.drop_params !== undefined && (!Array.isArray(config.drop_params) || config.drop_params.some(item => typeof item !== 'string'))) {
        throw new Error(`mapping "${rawHost}.${alias}.drop_params" must be an array of strings`);
      }
      if (Array.isArray(config.drop_params) && config.drop_params.some(key => protectedRequestFields.has(key))) {
        throw new Error(`mapping "${rawHost}.${alias}.drop_params" must not remove model, messages, or stream`);
      }
      normalizedHostMapping[alias] = {
        ...config,
        ...(typeof config.model === 'string' ? { model: config.model.trim() } : {}),
      };
    }
    normalized[host] = normalizedHostMapping;
  }
  return normalized;
}

function isModelAllowedForEndpoint(requestedModel, endpoint, modelMapping) {
  if (!requestedModel || !endpoint) return false;
  if (endpoint.role === 'fallback' && endpoint.configuredModel === requestedModel) return true;
  let host = '';
  try { host = new URL(endpoint.baseUrl).hostname; } catch { return false; }
  const hostMapping = modelMapping?.[host];
  return isPlainObject(hostMapping) && Object.prototype.hasOwnProperty.call(hostMapping, requestedModel);
}

function resolveModelConfig(modelMapping, host, requestedModel) {
  const hostMapping = modelMapping?.[host] || {};
  const raw = hostMapping?.[requestedModel];
  if (typeof raw === 'string') return { model: raw, capabilities: {} };
  if (raw && typeof raw === 'object') {
    return {
      ...raw,
      model: raw.model || requestedModel,
      invoke_url: raw.invoke_url || '',
      capabilities: raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {},
      request_overrides: raw.request_overrides && typeof raw.request_overrides === 'object' ? raw.request_overrides : {},
      drop_params: Array.isArray(raw.drop_params) ? raw.drop_params : [],
    };
  }
  return { model: requestedModel, capabilities: {}, request_overrides: {}, drop_params: [] };
}

function applyModelRequestConfig(body, modelConfig) {
  const result = { ...body, ...(modelConfig?.request_overrides || {}) };
  for (const key of modelConfig?.drop_params || []) delete result[key];
  if (modelConfig?.model) result.model = modelConfig.model;
  return result;
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

  return applyModelRequestConfig(out, modelConfig);
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

function buildFallbackClientFeedback(env, endpoint, requestedModel, actualModel, primaryAttempts) {
  const rawMode = String(readOptionalEnv(env, 'FALLBACK_CLIENT_NOTICE_MODE') || 'headers').toLowerCase();
  const mode = ['headers', 'visible', 'off'].includes(rawMode) ? rawMode : 'headers';
  const provider = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false)
    ? (endpoint?.providerName || inferProviderName(endpoint?.baseUrl) || 'custom-openai')
    : getEndpointRole(endpoint);
  const tier = endpoint?.fallbackTier || 'primary';
  const model = actualModel || endpoint?.configuredModel || requestedModel || 'unknown';
  const attempts = Math.max(0, Number(primaryAttempts || 0));
  const reason = attempts > 0 ? 'primary-exhausted' : 'primary-unavailable';
  const template = readOptionalEnv(env, 'FALLBACK_CLIENT_NOTICE_TEXT')
    || '[智能边缘网关] 主端点不可用，已切换至 {provider} / {model}（{tier}）。';
  const noticeText = renderFallbackNotice(template, {
    provider,
    model,
    tier,
    requested_model: requestedModel || 'unknown',
    primary_attempts: String(attempts),
  });
  const headers = mode === 'off' ? {} : {
    'x-edge-gateway-route': 'fallback',
    'x-edge-gateway-fallback': 'true',
    'x-edge-gateway-fallback-provider': encodeHeaderValue(provider),
    'x-edge-gateway-fallback-tier': encodeHeaderValue(tier),
    'x-edge-gateway-fallback-model': encodeHeaderValue(model),
    'x-edge-gateway-requested-model': encodeHeaderValue(requestedModel || 'unknown'),
    'x-edge-gateway-primary-attempts': String(attempts),
    'x-edge-gateway-fallback-reason': reason,
  };
  return {
    mode,
    visible: mode === 'visible',
    noticeText,
    reportedModel: model,
    provider,
    tier,
    primaryAttempts: attempts,
    headers,
  };
}

function renderFallbackNotice(template, values) {
  return String(template || '').replace(/\{(provider|model|tier|requested_model|primary_attempts)\}/g,
    (_, key) => String(values?.[key] ?? ''));
}

function encodeHeaderValue(value) {
  return encodeURIComponent(String(value ?? '').slice(0, 512));
}

function applyAnthropicFallbackNotice(content, feedback, hasTools) {
  if (!feedback?.visible || hasTools || !feedback.noticeText) return content;
  const output = Array.isArray(content) ? [...content] : [];
  const noticeBlock = { type: 'text', text: `${feedback.noticeText}\n\n` };
  const firstTextIndex = output.findIndex(block => block?.type === 'text');
  if (firstTextIndex >= 0) {
    output[firstTextIndex] = {
      ...output[firstTextIndex],
      text: `${feedback.noticeText}\n\n${output[firstTextIndex].text || ''}`,
    };
  } else {
    const firstNonThinking = output.findIndex(block => block?.type !== 'thinking');
    output.splice(firstNonThinking >= 0 ? firstNonThinking : output.length, 0, noticeBlock);
  }
  return output;
}

function applyOpenAIFallbackNotice(data, feedback) {
  if (!feedback?.visible || !feedback.noticeText || !data || typeof data !== 'object') return data;
  for (const choice of data.choices || []) {
    const message = choice?.message;
    if (!message || (Array.isArray(message.tool_calls) && message.tool_calls.length) || message.function_call) continue;
    if (typeof message.content === 'string') {
      message.content = `${feedback.noticeText}\n\n${message.content}`;
    } else if (Array.isArray(message.content)) {
      const textIndex = message.content.findIndex(part => part?.type === 'text' || part?.type === 'output_text');
      if (textIndex >= 0) {
        message.content[textIndex] = {
          ...message.content[textIndex],
          text: `${feedback.noticeText}\n\n${message.content[textIndex].text || ''}`,
        };
      } else {
        message.content.unshift({ type: 'text', text: `${feedback.noticeText}\n\n` });
      }
    } else if (message.content == null) {
      message.content = feedback.noticeText;
    }
  }
  if (feedback.reportedModel) data.model = feedback.reportedModel;
  return data;
}

function transformOpenAIStreamWithFallbackNotice(upstream, feedback, requestSignal, clientAbortListener) {
  if (!feedback?.visible || !feedback.noticeText || !upstream.body) return upstream;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let emitted = false;
  let toolMode = false;

  const cleanup = async () => {
    if (requestSignal && clientAbortListener) requestSignal.removeEventListener('abort', clientAbortListener);
    try { await reader.cancel().catch(() => {}); } catch {}
  };

  const stream = new ReadableStream({
    async start(controller) {
      const pushEvent = data => controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      const processEvent = raw => {
        if (!raw || raw === '[DONE]') {
          if (raw) pushEvent(raw);
          return;
        }
        try {
          const json = JSON.parse(raw);
          const choice = json?.choices?.[0];
          const delta = choice?.delta || {};
          if (Array.isArray(delta.tool_calls) || delta.function_call) toolMode = true;
          const text = extractOpenAITextContent(delta.content);
          if (!emitted && !toolMode && text) {
            emitted = true;
            const noticeChunk = {
              ...json,
              model: feedback.reportedModel || json.model,
              choices: [{
                index: choice?.index ?? 0,
                delta: { role: 'assistant', content: `${feedback.noticeText}\n\n` },
                finish_reason: null,
              }],
            };
            pushEvent(JSON.stringify(noticeChunk));
          }
          if (feedback.reportedModel) json.model = feedback.reportedModel;
          pushEvent(JSON.stringify(json));
        } catch {
          pushEvent(raw);
        }
      };

      try {
        while (true) {
          if (requestSignal?.aborted) break;
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
            if (data) processEvent(data);
          }
        }
        if (buffer.trim()) {
          const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n');
          if (data) processEvent(data);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        await cleanup();
      }
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

function openAIToAnthropicMessage(data, requestedModel, modelConfig = {}, fallbackFeedback = null) {
  const responseModel = fallbackFeedback?.reportedModel || requestedModel;
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

  const finalContent = applyAnthropicFallbackNotice(content, fallbackFeedback, toolCalls.length > 0);
  if (finalContent.length === 0) {
    throw new Error('Upstream returned an empty response without text, reasoning, or tool calls.');
  }
  const usage = mapOpenAIUsageToAnthropic(data?.usage || {});
  return {
    id: normalizeAnthropicMessageId(data?.id),
    type: 'message',
    role: 'assistant',
    model: fallbackFeedback?.reportedModel || requestedModel,
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

function transformOpenAIStreamToAnthropic(upstream, requestedModel, requestId, modelConfig, requestSignal, clientAbortListener, fallbackFeedback = null, logger = console) {
  const responseModel = fallbackFeedback?.reportedModel || requestedModel;
  let fallbackNoticeEmitted = false;
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
          if (fallbackFeedback?.visible && !fallbackNoticeEmitted && pendingTools.size === 0 && fallbackFeedback.noticeText) {
            fallbackNoticeEmitted = true;
            emit('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: `${fallbackFeedback.noticeText}\n\n` },
            });
          }
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

// ============ 主端点选择 ============

function buildRequestAffinityKey(body) {
  if (!body || typeof body !== 'object') {
    return 'default-session';
  }

  // 对话尾部会随着每次工具调用变化，因此只使用稳定的前缀生成亲和键。
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return stableStringify({
      model: body.model || '',
      system: body.system || '',
      prefix: body.messages.slice(0, 2),
    });
  }

  return stableStringify({
    model: body.model || '',
    user: body.user || '',
  });
}

function selectPrimaryEndpoints(primaryEndpoints, maxAttempts, config, originalBodyJson, request) {
  const now = Date.now();
  const { rotationWindowMs, rotationMaxPerWindow, maxConcurrencyPerEndpoint } = config;

  for (const ep of primaryEndpoints) {
    const state = getEndpointState(ep.id);
    state.requestBuffer.resize(g_ringBufferSize);
    if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
      state.cooldownUntil = 0;
      state.cooldownReason = null;
      state.consecutiveFailures = 0;
      state.healthScore = Math.min(HEALTH_SCORE_MAX, state.healthScore + HEALTH_SCORE_COOLDOWN_RECOVERY);
    }
  }

  if (primaryEndpoints.length === 0 || maxAttempts <= 0) return [];

  const affinityKey =
    request?.headers?.get('x-claude-code-session-id') ||
    request?.headers?.get('x-claude-code-agent-id') ||
    request?.headers?.get('x-claude-code-parent-agent-id') ||
    buildRequestAffinityKey(originalBodyJson);

  // 首选端点只依赖传入 Primary 列表的原始稳定顺序，不能依赖动态健康排序。
  const preferredIndex = simpleHash(affinityKey) % primaryEndpoints.length;
  const preferredEndpoint = primaryEndpoints[preferredIndex];
  const preferredState = getEndpointState(preferredEndpoint.id);
  const preferredRecentRequests = preferredState.requestBuffer.getRecentCount(rotationWindowMs, now);

  // 粘滞优先：仅在冷却、硬请求/并发上限或严重低健康时跳过首选端点。
  const preferredUsable =
    preferredState.cooldownUntil <= now &&
    preferredRecentRequests < rotationMaxPerWindow &&
    preferredState.activeRequests < maxConcurrencyPerEndpoint &&
    preferredState.healthScore >= 20;

  // 其它端点只用于 failover；排除当前不可用端点后再按健康度和负载排序。
  const alternatives = primaryEndpoints
    .filter(ep => ep.id !== preferredEndpoint.id)
    .map(ep => {
      const state = getEndpointState(ep.id);
      return {
        ep,
        state,
        recentRequests: state.requestBuffer.getRecentCount(rotationWindowMs, now),
      };
    })
    .filter(item => item.state.cooldownUntil <= now)
    .filter(item => item.state.activeRequests < maxConcurrencyPerEndpoint)
    .filter(item => item.recentRequests < rotationMaxPerWindow)
    .sort((a, b) => {
      if (b.state.healthScore !== a.state.healthScore) return b.state.healthScore - a.state.healthScore;
      if (a.recentRequests !== b.recentRequests) return a.recentRequests - b.recentRequests;
      if (a.state.activeRequests !== b.state.activeRequests) return a.state.activeRequests - b.state.activeRequests;
      return (a.state.avgLatencyMs || 999999) - (b.state.avgLatencyMs || 999999);
    })
    .map(item => item.ep);

  const ordered = preferredUsable
    ? [preferredEndpoint, ...alternatives]
    : alternatives;

  return ordered.slice(0, maxAttempts);
}

function getEndpointState(id) {
  if (!endpointState.has(id)) {
    endpointState.set(id, {
      healthScore: HEALTH_SCORE_INITIAL,
      activeRequests: 0,
      requestBuffer: new RequestRingBuffer(g_ringBufferSize),
      consecutiveFailures: 0,
      avgLatencyMs: 0,
      cooldownUntil: 0,
      cooldownReason: null,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastUsedAt: 0,
    });
  }
  return endpointState.get(id);
}

function recordRequestStart(id) {
  const s = getEndpointState(id);
  s.activeRequests++;
  s.requestBuffer.record(Date.now());
  s.totalRequests++;
  s.lastUsedAt = Date.now();
}

function recordSuccess(id, latencyMs) {
  const s = getEndpointState(id);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
  s.healthScore = Math.min(HEALTH_SCORE_MAX, s.healthScore + HEALTH_SCORE_SUCCESS_GAIN);
  s.consecutiveFailures = 0;
  s.totalSuccesses++;
  s.avgLatencyMs = s.avgLatencyMs === 0 ? latencyMs : s.avgLatencyMs * (1 - LATENCY_EWMA_ALPHA) + latencyMs * LATENCY_EWMA_ALPHA;
}

function recordFailure(id, status, cooldownMs, reason) {
  const s = getEndpointState(id);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
  s.totalFailures++;
  s.consecutiveFailures++;
  const healthPenalty = status === 429 ? 15
    : (status === 401 || status === 403) ? 50
    : status === 404 ? 8
    : status >= 500 ? 20
    : status === 0 ? 12
    : 10;
  s.healthScore = Math.max(HEALTH_SCORE_MIN, s.healthScore - healthPenalty);
  if (cooldownMs > 0) {
    s.cooldownUntil = Date.now() + cooldownMs;
    s.cooldownReason = reason || `status:${status}`;
  }
}

// 404 等配置类错误只释放并发，不改变端点健康分或冷却状态。
function recordNeutralEnd(id) {
  const s = getEndpointState(id);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
}

function applyExponentialBackoff(id, status, baseCooldownMs) {
  const s = getEndpointState(id);
  if (status === 429 || status === 401 || status === 403) return baseCooldownMs;
  return baseCooldownMs * Math.min(MAX_EXPONENTIAL_BACKOFF_MULTIPLIER, Math.pow(2, Math.max(0, s.consecutiveFailures)));
}

function isCoolingDown(id) {
  const s = getEndpointState(id);
  if (s.cooldownUntil <= 0) return false;
  if (s.cooldownUntil <= Date.now()) {
    s.cooldownUntil = 0;
    s.cooldownReason = null;
    return false;
  }
  return true;
}

function nextCooldownMs(endpoints) {
  const now = Date.now();
  const values = endpoints.map(ep => {
    const s = getEndpointState(ep.id);
    return s.cooldownUntil > now ? s.cooldownUntil - now : 0;
  }).filter(Boolean);
  return values.length ? Math.min(...values) : 0;
}

function cleanupStaleState() {
  const now = Date.now();
  for (const [, state] of endpointState) {
    if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
      state.cooldownUntil = 0;
      state.cooldownReason = null;
      state.consecutiveFailures = 0;
      state.healthScore = Math.min(HEALTH_SCORE_MAX, state.healthScore + HEALTH_SCORE_COOLDOWN_RECOVERY);
    }
  }
  if (endpointState.size > MAX_STATE_ENTRIES) {
    const targetSize = Math.floor(MAX_STATE_ENTRIES * 0.75);
    const entries = [...endpointState.entries()];
    entries.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (let i = 0; i < endpointState.size - targetSize; i++) {
      endpointState.delete(entries[i][0]);
    }
  }
}

async function healthCheck(request, env, requestId) {
  const primaryEndpoints = buildPrimaryEndpoints(env);
  const fallbackEndpoints = buildFallbackEndpoints(env);
  const endpoints = [...primaryEndpoints, ...fallbackEndpoints];
  const now = Date.now();
  const rotationWindowMs = clampInt(readOptionalEnv(env, 'PRIMARY_ROTATION_WINDOW_MS'), 10_000, 18_000_000, DEFAULT_PRIMARY_ROTATION_WINDOW_MS);
  const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);

  // 端点标识使用异步 SHA-256 指纹，因此并行生成后再序列化。
  const endpointDetails = await Promise.all(endpoints.map(async ep => {
    const s = getEndpointState(ep.id);
    const cooling = s.cooldownUntil > now;
    return {
      id: await fingerprint(ep.id),
      ...(exposeUpstreamInfo ? { base_url: ep.baseUrl } : {}),
      role: getEndpointRole(ep),
      provider: exposeUpstreamInfo ? (ep.providerName || inferProviderName(ep.baseUrl)) : getEndpointRole(ep),
      primary_provider: ep.role === 'fallback' ? null : (exposeUpstreamInfo ? (ep.providerName || inferProviderName(ep.baseUrl)) : 'primary'),
      fallback_provider: ep.role === 'fallback' ? (exposeUpstreamInfo ? ep.providerName : getEndpointRole(ep)) : null,
      fallback_tier: ep.role === 'fallback' ? ep.fallbackTier : null,
      fallback_order: ep.role === 'fallback' ? ep.fallbackOrder : null,
      configured_model: ep.role === 'fallback' ? ep.configuredModel : null,
      health_score: Math.round(s.healthScore),
      status: cooling ? 'cooling_down' : 'active',
      cooldown_remaining_ms: cooling ? s.cooldownUntil - now : 0,
      cooldown_reason: s.cooldownReason || null,
      active_requests: s.activeRequests,
      recent_requests_in_window: s.requestBuffer.getRecentCount(rotationWindowMs, now),
      avg_ttfb_ms: Math.round(s.avgLatencyMs) || 0,
      avg_latency_ms: Math.round(s.avgLatencyMs) || 0,
      total_requests: s.totalRequests,
      total_successes: s.totalSuccesses,
      total_failures: s.totalFailures,
      success_rate: s.totalRequests > 0 ? (s.totalSuccesses / s.totalRequests * 100).toFixed(1) + '%' : 'N/A',
      consecutive_failures: s.consecutiveFailures,
      last_used_at: s.lastUsedAt > 0 ? new Date(s.lastUsedAt).toISOString() : null,
    };
  }));

  const cooling = endpointDetails.filter(e => e.status === 'cooling_down').length;
  const totalRequests = endpointDetails.reduce((sum, e) => sum + e.total_requests, 0);
  const totalSuccesses = endpointDetails.reduce((sum, e) => sum + e.total_successes, 0);

  return new Response(JSON.stringify({
    status: endpoints.length > 0 ? 'ok' : 'misconfigured',
    gateway_auth_enabled: true,
    primary_endpoints_total: primaryEndpoints.length,
    primary_providers: exposeUpstreamInfo
      ? [...new Set(primaryEndpoints.map(ep => ep.providerName || inferProviderName(ep.baseUrl)))]
      : (primaryEndpoints.length > 0 ? ['primary'] : []),
    ...(exposeUpstreamInfo ? { primary_base_urls: [...new Set(primaryEndpoints.map(ep => ep.baseUrl))] } : {}),
    fallback_configured: fallbackEndpoints.length > 0,
    fallback_order: fallbackEndpoints.map(ep => ({
        tier: ep.fallbackTier,
        order: ep.fallbackOrder,
        provider: exposeUpstreamInfo ? ep.providerName : getEndpointRole(ep),
      ...(exposeUpstreamInfo ? { base_url: ep.baseUrl } : {}),
      model: ep.configuredModel,
    })),
    note: 'This snapshot reflects only the current isolate\'s in-memory state, not a strictly global view across all edge locations.',
    endpoints_total: endpoints.length,
    endpoints_active: endpoints.length - cooling,
    endpoints_cooling_down: cooling,
    client_stats: {
      started_at: new Date(gatewayStats.startedAt).toISOString(),
      requests_total: gatewayStats.clientRequests,
      successes_total: gatewayStats.clientSuccesses,
      failures_total: gatewayStats.clientFailures,
      active_requests: gatewayStats.clientActiveRequests,
      cancellations_total: gatewayStats.clientCancellations,
      fallback_activations_total: gatewayStats.fallbackActivations,
      fallback_successes_total: gatewayStats.fallbackSuccesses,
      success_rate: gatewayStats.clientRequests > 0
        ? (gatewayStats.clientSuccesses / gatewayStats.clientRequests * 100).toFixed(1) + '%'
        : 'N/A',
    },
    isolate_stats: {
      endpoint_attempts_total: totalRequests,
      endpoint_successes_total: totalSuccesses,
      endpoint_success_rate: totalRequests > 0 ? (totalSuccesses / totalRequests * 100).toFixed(1) + '%' : 'N/A',
      // 兼容旧字段；该值是上游端点尝试次数，不是客户端请求数。
      total_requests_served: totalRequests,
      total_successes: totalSuccesses,
      overall_success_rate: totalRequests > 0 ? (totalSuccesses / totalRequests * 100).toFixed(1) + '%' : 'N/A',
    },
    endpoints: endpointDetails,
    request_id: requestId,
  }, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...corsHeaders(request, env),
    },
  });
}

// Prometheus 指标仅反映当前 isolate，适合趋势观察，不代表全局精确值。
async function metricsCheck(request, env) {
  const primaryEndpoints = buildPrimaryEndpoints(env);
  const fallbackEndpoints = buildFallbackEndpoints(env);
  const endpoints = [...primaryEndpoints, ...fallbackEndpoints];
  const now = Date.now();
  const rotationWindowMs = clampInt(readOptionalEnv(env, 'PRIMARY_ROTATION_WINDOW_MS'), 10_000, 18_000_000, DEFAULT_PRIMARY_ROTATION_WINDOW_MS);
  const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);

  const lines = [];
  lines.push('# HELP edge_gateway_client_requests_total Counted client API requests since isolate start.');
  lines.push('# TYPE edge_gateway_client_requests_total counter');
  lines.push(`edge_gateway_client_requests_total ${gatewayStats.clientRequests}`);
  lines.push('# HELP edge_gateway_client_successes_total Client API responses with HTTP status below 400 since isolate start.');
  lines.push('# TYPE edge_gateway_client_successes_total counter');
  lines.push(`edge_gateway_client_successes_total ${gatewayStats.clientSuccesses}`);
  lines.push('# HELP edge_gateway_client_failures_total Client API responses with HTTP status 400 or above, including thrown errors, since isolate start.');
  lines.push('# TYPE edge_gateway_client_failures_total counter');
  lines.push(`edge_gateway_client_failures_total ${gatewayStats.clientFailures}`);
  lines.push('# HELP edge_gateway_client_active_requests Current counted client API requests still active in this isolate.');
  lines.push('# TYPE edge_gateway_client_active_requests gauge');
  lines.push(`edge_gateway_client_active_requests ${gatewayStats.clientActiveRequests}`);
  lines.push('# HELP edge_gateway_client_cancellations_total Counted streaming client responses cancelled before completion.');
  lines.push('# TYPE edge_gateway_client_cancellations_total counter');
  lines.push(`edge_gateway_client_cancellations_total ${gatewayStats.clientCancellations}`);
  lines.push('# HELP edge_gateway_fallback_activations_total Requests that entered the Fallback chain since isolate start.');
  lines.push('# TYPE edge_gateway_fallback_activations_total counter');
  lines.push(`edge_gateway_fallback_activations_total ${gatewayStats.fallbackActivations}`);
  lines.push('# HELP edge_gateway_fallback_successes_total Successful client responses served by a Fallback endpoint since isolate start.');
  lines.push('# TYPE edge_gateway_fallback_successes_total counter');
  lines.push(`edge_gateway_fallback_successes_total ${gatewayStats.fallbackSuccesses}`);
  lines.push('# HELP edge_gateway_endpoint_health_score Current health score (1-100) per upstream endpoint.');
  lines.push('# TYPE edge_gateway_endpoint_health_score gauge');
  lines.push('# HELP edge_gateway_endpoint_active_requests Currently in-flight requests per upstream endpoint.');
  lines.push('# TYPE edge_gateway_endpoint_active_requests gauge');
  lines.push('# HELP edge_gateway_endpoint_cooldown_remaining_ms Remaining cooldown time in ms (0 if not cooling).');
  lines.push('# TYPE edge_gateway_endpoint_cooldown_remaining_ms gauge');
  lines.push('# HELP edge_gateway_endpoint_avg_ttfb_ms Exponentially-weighted time to response headers in ms.');
  lines.push('# TYPE edge_gateway_endpoint_avg_ttfb_ms gauge');
  lines.push('# HELP edge_gateway_endpoint_avg_latency_ms Deprecated alias of edge_gateway_endpoint_avg_ttfb_ms.');
  lines.push('# TYPE edge_gateway_endpoint_avg_latency_ms gauge');
  lines.push('# HELP edge_gateway_endpoint_requests_total Total requests served per endpoint since isolate start.');
  lines.push('# TYPE edge_gateway_endpoint_requests_total counter');
  lines.push('# HELP edge_gateway_endpoint_successes_total Total successful requests per endpoint since isolate start.');
  lines.push('# TYPE edge_gateway_endpoint_successes_total counter');
  lines.push('# HELP edge_gateway_endpoint_failures_total Total failed requests per endpoint since isolate start.');
  lines.push('# TYPE edge_gateway_endpoint_failures_total counter');

  for (const ep of endpoints) {
    const s = getEndpointState(ep.id);
    const cooling = s.cooldownUntil > now ? s.cooldownUntil - now : 0;
    const id = await fingerprint(ep.id);
    const role = getEndpointRole(ep);
    const fallbackTier = ep.role === 'fallback' ? ep.fallbackTier : '';
    const configuredModel = ep.role === 'fallback' ? ep.configuredModel : '';
    const provider = sanitizePrometheusLabel(exposeUpstreamInfo
      ? (ep.providerName || inferProviderName(ep.baseUrl))
      : getEndpointRole(ep));
    const fallbackProvider = ep.role === 'fallback' ? provider : '';
    const label = `endpoint_id="${id}",endpoint_role="${role}",provider="${provider}",fallback_provider="${fallbackProvider}",fallback_tier="${fallbackTier}",configured_model="${sanitizePrometheusLabel(configuredModel)}"`;
    lines.push(`edge_gateway_endpoint_health_score{${label}} ${Math.round(s.healthScore)}`);
    lines.push(`edge_gateway_endpoint_active_requests{${label}} ${s.activeRequests}`);
    lines.push(`edge_gateway_endpoint_cooldown_remaining_ms{${label}} ${cooling}`);
    lines.push(`edge_gateway_endpoint_avg_ttfb_ms{${label}} ${Math.round(s.avgLatencyMs) || 0}`);
    lines.push(`edge_gateway_endpoint_avg_latency_ms{${label}} ${Math.round(s.avgLatencyMs) || 0}`);
    lines.push(`edge_gateway_endpoint_requests_total{${label}} ${s.totalRequests}`);
    lines.push(`edge_gateway_endpoint_successes_total{${label}} ${s.totalSuccesses}`);
    lines.push(`edge_gateway_endpoint_failures_total{${label}} ${s.totalFailures}`);
    // 当前窗口请求数用于观察端点是否接近轮换阈值。
    lines.push(`edge_gateway_endpoint_recent_requests_in_window{${label}} ${s.requestBuffer.getRecentCount(rotationWindowMs, now)}`);
  }

  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

// AE_DATASET 存在时异步写入跨 isolate 趋势数据；写入失败不影响主请求。
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

async function modelsListResponse({ request, env, requestId, primaryEndpoints, fallbackEndpoints, modelMapping }) {
  const timeoutMs = clampInt(
    readOptionalEnv(env, 'MODEL_LIST_TIMEOUT_MS'),
    1_000,
    30_000,
    DEFAULT_MODEL_LIST_TIMEOUT_MS
  );
  const maxAttempts = clampInt(
    readOptionalEnv(env, 'MODEL_LIST_MAX_ATTEMPTS'),
    1,
    Math.max(1, primaryEndpoints.length),
    Math.min(DEFAULT_MODEL_LIST_MAX_ATTEMPTS, Math.max(1, primaryEndpoints.length))
  );

  const configuredModels = collectConfiguredModelEntries(primaryEndpoints, fallbackEndpoints, modelMapping);
  const strictModelMapping = readBooleanEnv(env, 'STRICT_MODEL_MAPPING', false);
  const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);
  if (strictModelMapping) {
    if (configuredModels.length === 0) {
      return gatewayError(request, env, false, 500,
        'Gateway misconfigured: STRICT_MODEL_MAPPING is enabled but no models are configured in MODEL_MAPPING or Fallback.',
        undefined, requestId);
    }
    return new Response(JSON.stringify({ object: 'list', data: configuredModels }), {
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
  const attempts = [];
  const modelListCandidates = primaryEndpoints.filter(endpoint => !isCoolingDown(endpoint.id)).slice(0, maxAttempts);

  for (const endpoint of modelListCandidates) {
    let targetUrl;
    try {
      targetUrl = buildTargetUrl(new URL(request.url), endpoint.baseUrl);
    } catch (error) {
      attempts.push({
        provider: exposeUpstreamInfo ? endpoint.providerName : 'primary',
        status: 0,
        error: `Invalid upstream URL: ${error.message || String(error)}`,
      });
      continue;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: buildStandardOpenAIHeaders(request, endpoint.token, requestId),
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!upstream.ok) {
        attempts.push({
          provider: exposeUpstreamInfo ? endpoint.providerName : 'primary',
          status: upstream.status,
          error: extractUpstreamErrorMessage(await safeReadText(upstream)) || `HTTP ${upstream.status}`,
        });
        continue;
      }

      let payload;
      try {
        payload = await safeJsonResponse(upstream, DEFAULT_MODEL_LIST_MAX_BYTES);
      } catch (error) {
        attempts.push({
          provider: exposeUpstreamInfo ? endpoint.providerName : 'primary',
          status: upstream.status,
          error: error instanceof BodyTooLargeError
            ? 'Upstream model list exceeds the safety limit.'
            : 'Upstream model list is not valid JSON.',
        });
        continue;
      }

      const upstreamModels = normalizeOpenAIModelEntries(payload?.data);
      const models = mergeModelEntries(upstreamModels, configuredModels);
      if (models.length === 0) {
        attempts.push({
          provider: exposeUpstreamInfo ? endpoint.providerName : 'primary',
          status: upstream.status,
          error: 'Upstream returned an empty model list.',
        });
        continue;
      }

      return new Response(JSON.stringify({ object: 'list', data: models }), {
        status: 200,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'cache-control': 'no-store',
          'x-request-id': requestId,
          'x-edge-gateway-model-source': configuredModels.length > 0 ? 'upstream+configured' : 'upstream',
          ...corsHeaders(request, env),
        },
      });
    } catch (error) {
      clearTimeout(timeoutId);
      attempts.push({
        provider: exposeUpstreamInfo ? endpoint.providerName : 'primary',
        status: 0,
        error: error?.name === 'AbortError' ? 'Upstream model-list request timed out.' : (error.message || String(error)),
      });
    }
  }

  if (configuredModels.length > 0) {
    return new Response(JSON.stringify({ object: 'list', data: configuredModels }), {
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

  return gatewayError(request, env, false, 502,
    'Unable to obtain a model list from any configured Primary endpoint.', {
      attempts: attempts.map(item => ({
        provider: item.provider,
        status: item.status,
        error: exposeUpstreamInfo
          ? item.error
          : item.status > 0 ? `Upstream returned HTTP ${item.status}.` : 'Upstream model-list request failed.',
      })),
    }, requestId);
}

function collectConfiguredModelEntries(primaryEndpoints, fallbackEndpoints, modelMapping) {
  const models = new Map();
  const configuredHosts = new Set();

  for (const endpoint of [...primaryEndpoints, ...fallbackEndpoints]) {
    try {
      configuredHosts.add(new URL(endpoint.baseUrl).hostname);
    } catch {}
  }

  for (const host of configuredHosts) {
    const hostMapping = modelMapping?.[host];
    if (!isPlainObject(hostMapping)) continue;
    for (const alias of Object.keys(hostMapping)) {
      addModelEntry(models, {
        id: alias,
        object: 'model',
        created: 0,
        owned_by: APP_META.name,
      });
    }
  }

  for (const endpoint of fallbackEndpoints) {
    if (!endpoint.configuredModel) continue;
    addModelEntry(models, {
      id: endpoint.configuredModel,
      object: 'model',
      created: 0,
      owned_by: APP_META.name,
    });
  }

  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeOpenAIModelEntries(data) {
  if (!Array.isArray(data)) return [];
  const models = new Map();
  for (const item of data) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()) continue;
    addModelEntry(models, {
      ...item,
      id: item.id.trim(),
      object: item.object || 'model',
      created: Number.isFinite(Number(item.created)) ? Number(item.created) : 0,
      owned_by: item.owned_by || 'upstream',
    });
  }
  return [...models.values()];
}

function mergeModelEntries(...groups) {
  const models = new Map();
  for (const group of groups) {
    for (const item of group || []) addModelEntry(models, item);
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function addModelEntry(models, item) {
  const id = String(item?.id || '').trim();
  if (!id || models.has(id)) return;
  models.set(id, { ...item, id });
}


function isRequestedModelAllowed(requestedModel, primaryEndpoints, fallbackEndpoints, modelMapping) {
  const requested = String(requestedModel || '').trim();
  if (!requested) return false;
  const configured = collectConfiguredModelEntries(primaryEndpoints, fallbackEndpoints, modelMapping);
  return configured.some(item => item.id === requested);
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

function buildPrimaryEndpoints(env) {
  const tokensRaw = readOptionalEnv(env, 'PRIMARY_API_TOKENS');
  const enabledRaw = readOptionalEnv(env, 'PRIMARY_ENABLED');
  const enabled = enabledRaw === null || enabledRaw === undefined || enabledRaw === ''
    ? Boolean(tokensRaw)
    : parseBooleanValue(enabledRaw, false);
  if (!enabled || !tokensRaw) return [];

  const defaultBaseUrl = readOptionalEnv(env, 'PRIMARY_BASE_URL') || '';
  const allowInsecureHttp = readBooleanEnv(env, 'ALLOW_INSECURE_HTTP_UPSTREAM', false);
  return parseTokens(tokensRaw, defaultBaseUrl, allowInsecureHttp)
    .filter(endpoint => endpoint.token && endpoint.baseUrl)
    .map(endpoint => ({
      ...endpoint,
      role: 'primary',
      providerName: inferProviderName(endpoint.baseUrl),
      fallbackTier: null,
      fallbackOrder: 0,
      configuredModel: null,
    }));
}

function buildFallbackEndpoints(env) {
  const sharedToken = readOptionalEnv(env, 'FALLBACK_API_TOKEN');
  const sharedBaseUrl = readOptionalEnv(env, 'FALLBACK_BASE_URL') || '';
  const primaryToken = readOptionalEnv(env, 'FALLBACK_PRIMARY_TOKEN') || sharedToken;
  const primaryBaseUrl = readOptionalEnv(env, 'FALLBACK_PRIMARY_BASE_URL') || sharedBaseUrl;
  const primaryModel = normalizeFallbackPrimaryModel(
    readOptionalEnv(env, 'FALLBACK_PRIMARY_MODEL')
  );

  const secondaryToken = readOptionalEnv(env, 'FALLBACK_SECONDARY_TOKEN') || sharedToken;
  const secondaryBaseUrl = readOptionalEnv(env, 'FALLBACK_SECONDARY_BASE_URL') || sharedBaseUrl;
  const secondaryModel = normalizeFallbackSecondaryModel(
    readOptionalEnv(env, 'FALLBACK_SECONDARY_MODEL')
  );

  const enabledRaw = readOptionalEnv(env, 'FALLBACK_ENABLED');
  const hasConfiguredFallback = Boolean(
    (primaryToken && primaryBaseUrl && primaryModel)
    || (secondaryToken && secondaryBaseUrl && secondaryModel)
  );
  const enabled = enabledRaw === null || enabledRaw === undefined || enabledRaw === ''
    ? hasConfiguredFallback
    : parseBooleanValue(enabledRaw, false);
  if (!enabled || !hasConfiguredFallback) return [];

  const definitions = [
    {
      tier: 'primary',
      order: 1,
      model: primaryModel,
      token: primaryToken,
      baseUrl: primaryBaseUrl,
    },
    {
      tier: 'secondary',
      order: 2,
      model: secondaryModel,
      token: secondaryToken,
      baseUrl: secondaryBaseUrl,
    },
  ];

  const endpoints = [];
  const seen = new Set();

  for (const definition of definitions) {
    if (!definition.model || !definition.token || !definition.baseUrl) continue;

    const normalizedBaseUrl = normalizeHttpsBaseUrl(definition.baseUrl);
    if (!normalizedBaseUrl) continue;

    const dedupeKey = [
      normalizedBaseUrl,
      definition.model,
      definition.token,
    ].join('|');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    endpoints.push({
      id: `fallback:${dedupeKey}`,
      role: 'fallback',
      token: definition.token,
      baseUrl: normalizedBaseUrl,
      providerName: inferProviderName(normalizedBaseUrl),
      fallbackTier: definition.tier,
      fallbackOrder: definition.order,
      configuredModel: definition.model,
    });
  }

  return endpoints.sort((a, b) => a.fallbackOrder - b.fallbackOrder);
}

function normalizeHttpsBaseUrl(value) {
  return normalizeUpstreamBaseUrl(value, false);
}


function inferProviderName(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname || 'custom-openai';
  } catch {
    return 'custom-openai';
  }
}

function sanitizePrometheusLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function normalizeFallbackPrimaryModel(value) {
  return String(value || '').trim();
}

function normalizeFallbackSecondaryModel(value) {
  const model = String(value || '').trim();
  if (!model || model.toLowerCase() === 'off') return '';
  return model;
}

function getEndpointRole(endpoint) {
  if (endpoint?.role !== 'fallback') return 'primary';
  return endpoint.fallbackTier === 'primary'
    ? 'fallback_primary'
    : 'fallback_secondary';
}

function buildFallbackModelConfig(endpoint, modelMapping, requestedModel) {
  const host = new URL(endpoint.baseUrl).hostname;
  const fallbackAlias = endpoint.configuredModel || requestedModel;
  const mapped = resolveModelConfig(modelMapping, host, fallbackAlias);

  const fallbackDefaults = {
    tools: true,
    parallel_tools: true,
    vision: false,
    json_schema: false,
    expose_reasoning: true,
    preserve_reasoning_history: false,
    reasoning_request: 'none',
    stream_usage: false,
  };

  return {
    ...mapped,
    model: mapped.model || fallbackAlias,
    invoke_url: mapped.invoke_url || '',
    capabilities: {
      ...fallbackDefaults,
      ...(mapped.capabilities || {}),
    },
    request_overrides: {
      ...(mapped.request_overrides || {}),
    },
    drop_params: Array.isArray(mapped.drop_params) ? mapped.drop_params : [],
  };
}

function isFallbackEligible(route, pathname) {
  if (route === 'anthropic_messages') return true;
  const path = String(pathname || '').replace(/\/+$/, '').toLowerCase();
  return path === '/v1/chat/completions' || path === '/chat/completions';
}

function parseTokens(raw, defaultBaseUrl, allowInsecureHttp = false) {
  const unique = new Map();
  const source = String(raw || '');
  if (source.includes(';')) return [];
  const items = source
    .split(/[,\r\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
  for (const item of items) {
    const match = item.match(/^(.*)@(https?:\/\/.+)$/i);
    const token = match ? match[1].trim() : item;
    const rawBaseUrl = match ? match[2] : defaultBaseUrl || '';
    const baseUrl = normalizeUpstreamBaseUrl(rawBaseUrl, allowInsecureHttp);
    if (!token || !baseUrl) continue;
    const id = `primary:${token}|${baseUrl}`;
    if (!unique.has(id)) unique.set(id, { id, token, baseUrl });
  }
  return [...unique.values()];
}

function normalizeUpstreamBaseUrl(value, allowInsecureHttp = false) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' && !(allowInsecureHttp && parsed.protocol === 'http:')) return '';
    if (parsed.username || parsed.password) return '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeInvokeUrl(value, allowInsecureHttp = false) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' && !(allowInsecureHttp && parsed.protocol === 'http:')) return '';
    if (parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
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
      primary_api_tokens_bound: configuration.primaryApiTokensBound,
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

function getRetryAfterMs(headers) {
  const value = headers.get('Retry-After');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000, 500, 60_000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return clamp(dateMs - Date.now(), 500, 60_000);
  return 0;
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
    endpoint_role: endpointRole || (getEndpointRole(endpoint)),
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

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

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
async function assembleNonStreamResponse(upstream, model, requestId, request, env, extraHeaders, logger, ctx, fallbackFeedback = null) {
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
    applyOpenAIFallbackNotice(responseBody, fallbackFeedback);

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
