# 协议模型

## 原生协议转发

网关原生支持恰好两种协议族——OpenAI 和 Anthropic。不做跨协议转换，不做跨协议 fallback。

```text
Client /v1/chat/completions → OpenAI transport    → upstream /v1/chat/completions
Client /v1/responses        → OpenAI transport    → upstream /v1/responses
Client /v1/messages         → Anthropic transport → upstream /v1/messages
```

节点通过 `protocol`（`openai` | `anthropic`）和 `surfaces` 声明自己真正支持的接口。调度器按 protocol + surface + model 三重过滤。`/v1/responses` 只路由到 `surfaces` 含 `responses` 的 openai 节点；`/v1/messages` 只路由到 anthropic 节点；禁止跨协议 fallback。

## Transport 层

Transport 层 (`src/transport/`) 负责上游路径、协议头、模型替换、流式判定与协议特定响应语义。

- `transport/openai.js`：OpenAI 上游路径、`Authorization: Bearer` 头、Responses 首事件判定
- `transport/anthropic.js`：`/v1/messages` 路径、`x-api-key` 认证头、`anthropic-version`/`anthropic-beta` 透传、Anthropic 首事件判定
- `transport/index.js`：按协议分发（`resolveUpstreamPath`、`buildUpstreamHeadersFor`）

Transport 层不调度节点；Scheduler 和 Reliability 层不解析协议事件。

## OpenAI Chat (`/v1/chat/completions`)

标准 OpenAI Chat Completions 协议。请求转发到上游 `/v1/chat/completions`，响应按 OpenAI SSE 或 JSON 格式返回。

- 首事件提交判定：非空 content、reasoning 或 tool-call 输出
- 流式 wire format 兼容差异由 `src/config/provider-quirks.js` 处理（如 `stream_options.include_usage`）
- 客户端认证通过 `Authorization: Bearer` 传递

## OpenAI Responses (`/v1/responses`)

原生 Responses 表面：客户端请求原样转发（模型替换）到上游 `/v1/responses` endpoint，上游原生 Responses 事件序列原样中继。

- 验证：最小契约（`model` + `input`）；字段级语义由上游负责
- 流式：guarded native stream 直接追踪（`response.completed`/`incomplete` 完成标记，`response.failed` 失败标记）；model 字段在 `response.model` 处内联重写
- 错误：OpenAI Responses envelope `{ error: { message, type, param, code } }`；终端错误（非 429/503 的任何 HTTP 错误）携带 `x-should-retry: false`
- 不做 Chat Completions 转换
- `previous_response_id` 被接受但忽略：网关是无状态中继

## Anthropic Messages (`/v1/messages`)

原生 Messages 表面：请求原样转发到上游 `/v1/messages` endpoint，上游原生 Anthropic SSE 生命周期原样中继。

- 认证：`x-api-key`，不使用 `Authorization: Bearer`
- `anthropic-version` 和 `anthropic-beta` 头透传
- `count_tokens` 为本地近似估算（script-aware，非 tokenizer）
- 错误保持 Anthropic envelope `{ type: 'error', error: { type, message } }`

## Protocol 隔离规则

- OpenAI 节点全失败时，健康的 Anthropic 节点不会被调用（反向亦然）
- Hedge twin 由同一三重过滤选择器挑选，必然与 primary 同 protocol、同 surface；无可选 twin 时不启动 hedge
- 协议矩阵测试 (`scripts/protocol-matrix-test.mjs`) 断言跨协议 fallback 被禁止

## Header / Endpoint / Stream 职责边界

| 层 | 职责 |
|---|---|
| Transport | 上游路径、协议头、流式判定、协议特定响应语义 |
| Protocol | 请求校验、错误构建、CORS |
| Stream | First-Event Guard、SSE 扫描、流追踪 |
| Reliability | 错误分类、节点状态、熔断 |

Provider quirks (`src/config/provider-quirks.js`) 仅记录 wire-format 兼容差异（如 `stream_options.include_usage` 是否可添加），不决定协议/路径/transport。
