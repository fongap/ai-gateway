# 架构说明 / Architecture

![Smart Edge Gateway architecture](architecture.svg)

## 请求路径

```text
OpenAI / Anthropic Client
           |
           v
Authentication, route allowlist, and body validation
           |
           v
HTTPS enforcement, protocol conversion, and model mapping
           |
           v
     Primary endpoint pool
           |
      all attempts failed
           v
       Fallback 1
           |
          failed
           v
  Fallback 2 (optional)
```

## Primary

Primary 端点参与正常流量调度。选择时综合：

- 当前冷却状态（冷却中直接排除）；
- 健康评分；
- 滑动窗口请求量（达到上限直接排除）；
- 当前并发（达到上限直接排除）；
- 平滑响应延迟。

单次客户端请求最多尝试 `PRIMARY_MAX_ATTEMPTS` 个符合条件的 Primary 端点。端点失败后，网关根据状态码设置健康扣分和冷却。流式请求会一直占用并发计数，直到响应体结束或客户端取消。

## Fallback

Fallback 不参与正常轮询，并受独立硬并发上限保护。只有 Primary 有效尝试全部失败后才执行：

1. `FALLBACK_PRIMARY_MODEL`；
2. 第一兜底失败后，再执行可选的 `FALLBACK_SECONDARY_MODEL`。

第二兜底未设置或为空时默认关闭，值为 `off` 时显式关闭。

## 协议桥接

Anthropic Messages 请求会转换为 OpenAI Chat Completions 请求；响应再转换回 Anthropic 格式。网关覆盖文本、图片、工具调用、并行工具、流式事件和部分 reasoning/thinking 兼容。

第三方模型未提供的 Anthropic 原生语义无法由网关凭空补齐，包括可验证 thinking 签名和精确 Token 统计。

## 运行状态边界

端点健康分、并发、窗口计数和冷却状态保存在当前 Worker isolate 内存中，属于局部近似状态：

- isolate 回收后会重置；
- 不同 Cloudflare 节点之间不会自动合并；
- `/health` 与 `/metrics` 适合故障诊断，不适合精确计费或每日全局统计；
- 一次客户端请求可能产生多次上游尝试。

需要跨 isolate 趋势时，可选接入 Analytics Engine。需要严格全局一致性时，应使用 Durable Objects 或外部协调存储。

## 默认路由策略

白名单外路径和 `PUT`、`PATCH`、`DELETE` 等方法默认不会被转发。只有显式设置 `ALLOW_UNSAFE_PROXY_ROUTES=true` 才恢复通用透传模式。Primary 和 Fallback 默认只允许 HTTPS。

## Public and protected endpoints

| Endpoint | Authentication | Purpose |
|---|---|---|
| `/` | No | Static dashboard and deployment guide |
| `/version` | No | Project version and required-binding readiness |
| `/v1/models` | Yes | Primary model-list failover plus configured gateway aliases |
| `/health` | Yes | Current-isolate endpoint health snapshot |
| `/metrics` | Yes | Current-isolate Prometheus text metrics |
| `/v1/chat/completions` | Yes | OpenAI-compatible gateway |
| `/v1/messages` | Yes | Anthropic-compatible gateway |
| `/v1/messages/count_tokens` | Yes | Approximate or disabled token count mode |

## 统计边界

`/health` 和 `/metrics` 分别记录客户端 API 请求与上游端点尝试。一次客户端请求可能触发多个 Primary 尝试和一次 Fallback 链，因此端点尝试数通常大于客户端请求数。所有计数仅属于当前 isolate。

## 部署配置边界

`wrangler.jsonc` 使用 `keep_vars: true` 保留控制台普通变量，并声明两个必需 Secret。首次安装、代码更新和运行时重新配置由不同脚本处理，避免把“更新代码”误当成“重新填写全部密钥”。本地开发和 dry-run 使用临时 Wrangler 配置移除 `secrets.required`，保证 `.dev.vars` 中的可选变量可以加载。
