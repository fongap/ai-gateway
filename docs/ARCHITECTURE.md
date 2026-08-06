# 架构说明 / Architecture

![Smart Edge Gateway architecture](architecture.svg)

## 请求路径

```text
OpenAI / Anthropic Client
           |
           v
Authentication and request validation
           |
           v
Protocol conversion and model mapping
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

- 当前冷却状态；
- 健康评分；
- 滑动窗口请求量；
- 当前并发；
- 平滑响应延迟。

单次客户端请求最多尝试 `PRIMARY_MAX_ATTEMPTS` 个符合条件的 Primary 端点。端点失败后，网关根据状态码设置健康扣分和冷却。

## Fallback

Fallback 不参与正常轮询。只有 Primary 有效尝试全部失败后才执行：

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

## Public and protected endpoints

| Endpoint | Authentication | Purpose |
|---|---|---|
| `/` | No | Static dashboard and deployment guide |
| `/version` | No | Project name and version |
| `/v1/models` | Yes | Primary model-list failover plus configured gateway aliases |
| `/health` | Yes | Current-isolate endpoint health snapshot |
| `/metrics` | Yes | Current-isolate Prometheus text metrics |
| `/v1/chat/completions` | Yes | OpenAI-compatible gateway |
| `/v1/messages` | Yes | Anthropic-compatible gateway |
| `/v1/messages/count_tokens` | Yes | Approximate or disabled token count mode |
