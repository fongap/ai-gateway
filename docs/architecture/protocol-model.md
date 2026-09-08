# 协议模型

## 原生协议转发

网关原生支持恰好两种协议族——OpenAI 和 Anthropic。采用 Native First 策略：OpenAI Chat / Responses 只走原生路径；Anthropic Messages 优先原生，原生池耗尽后默认会尝试转换到 OpenAI Chat Completions（通过 `PROTOCOL_FALLBACKS` 启用默认链 `{"anthropic:messages":["openai:chat_completions"], "openai:chat_completions":["anthropic:messages"]}`，双向转换）。OpenAI Responses 为 Native Only，不参与跨协议 fallback。

```text
Client /v1/chat/completions → OpenAI transport    → upstream /v1/chat_completions
Client /v1/responses        → OpenAI transport    → upstream /v1/responses
Client /v1/messages         → Anthropic transport → upstream /v1/messages
↘ (native pool exhausted, fallback enabled)
                                   → OpenAI transport → upstream /v1/chat_completions
Client /v1/chat/completions ↘ (native OpenAI pool exhausted, fallback enabled)
                            → Anthropic transport → upstream /v1/messages
```

节点通过 `protocol`（`openai` | `anthropic`）和 `surfaces` 声明自己真正支持的接口。调度器按 protocol + surface + model 三重过滤。`/v1/responses` 只路由到 `surfaces` 含 `responses` 的 openai 节点；`/v1/messages` 优先路由到 anthropic 节点。

**v1.3.0 跨协议 fallback 矩阵**

| 客户端 / 上游 | OpenAI Chat | OpenAI Responses | Anthropic Messages |
| --- | --- | --- | --- |
| OpenAI Chat | Native | n/a (无 Responses → Chat 转换) | ✅ v1.3.0 默认 ON（双向） |
| OpenAI Responses | n/a (无 Responses → Chat 转换) | Native | n/a (Native Only) |
| Anthropic Messages | ✅ v1.3.0 默认 ON（双向） | n/a (无 Messages → Responses 转换) | Native |

跨协议 fallback 默认启用；要恢复 Native-Only 行为，设 `PROTOCOL_FALLBACKS=disable`；要换映射或单独关掉某条路由，传显式 JSON（例如 `{"anthropic:messages":[]}` 把这一条显式关掉）。所有跨协议 fallback 共享同一个 `max_attempts` / `FAILOVER_BUDGET_MS` budget,**不获取新的尝试配额**。

## Transport 层

Transport 层 (`src/transport/`) 负责上游路径、协议头、模型替换、流式判定与协议特定响应语义。

- `transport/openai.ts`：OpenAI 上游路径、`Authorization: Bearer` 头、Responses 首事件判定
- `transport/anthropic.ts`：`/v1/messages` 路径、`x-api-key` 认证头、`anthropic-version`/`anthropic-beta` 透传、Anthropic 首事件判定
- `transport/index.ts`：按协议分发（`resolveUpstreamPath`、`buildUpstreamHeadersFor`）

Transport 层不调度节点；Scheduler 和 Reliability 层不解析协议事件。

## OpenAI Chat (`/v1/chat/completions`)

标准 OpenAI Chat Completions 协议。请求转发到上游 `/v1/chat_completions`，响应按 OpenAI SSE 或 JSON 格式返回。

- 首事件提交判定：非空 content、reasoning 或 tool-call 输出
- 流式 wire format 兼容差异由 `src/config/provider-quirks.ts` 处理（如 `stream_options.include_usage`）
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

## v1.3.0 协议转换

跨协议 fallback 由 `src/conversion/` 中的独立转换器实现。每个方向是独立文件,**不依赖**其他方向的代码:

| 方向 | Request | Response | Stream |
| --- | --- | --- | --- |
| OpenAI Chat → Anthropic | `openai-chat-request-to-anthropic.ts` | `anthropic-response-to-openai-chat.ts` | `anthropic-stream-to-openai-chat.ts` |
| OpenAI Chat → Responses | (无 — n/a) | (无 — n/a) | (无 — n/a) |
| OpenAI Responses (native-only) | (native-only, no cross-protocol conversion) | (native-only, no cross-protocol conversion) | (native-only, no cross-protocol conversion) |
| Anthropic → OpenAI Chat | (Anthropic 是 native 起点) | `anthropic-response-to-openai-chat.ts` | `anthropic-stream-to-openai-chat.ts` |

每个转换器只支持**实际被使用的子集**(Codex 实际下发的字段)。不支持的字段(如 Responses 的 `reasoning` items, `image_generation_call`, `mcp_*` items 等)被**明确拒绝**(返回 `conversion_not_supported` 错误),不静默丢字段。

**错误 envelope 跨协议契约**: 跨协议 fallback 后,客户端始终收到**自己协议形状**的错误 envelope。例如:
- OpenAI Chat 客户端 fallback 到 Anthropic upstream 失败 → 收到 `{ error: { message, type, ... } }` (OpenAI Chat 形状)
- Anthropic 客户端 fallback 到 OpenAI upstream 失败 → 收到 `{ type: 'error', error: { ... } }` (Anthropic 形状)
- 上游的内部错误 envelope **从不泄漏**到客户端。

**Native First 调度契约**：
- 客户端请求首先被路由到**同 protocol、同 surface** 的原生上游
- 只有当原生池**完全耗尽**（所有候选失败或被 cooldown）且 fallback 启用时，跨协议转换才会启动
- Hedge twin 由同一三重过滤选择器挑选，必然与 primary 同 protocol、同 surface；**跨协议 hedge 被禁止**
- 跨协议 fallback 与 native retry 共享**同一个** `max_attempts` / `FAILOVER_BUDGET_MS` budget——fallback **不获取**新的 attempt slot

## Protocol 隔离规则

- **Native First**: 客户端请求优先走同 protocol、同 surface 的原生上游
- **跨协议 fallback 默认启用**(v1.3.0): 双向 `openai:chat_completions ↔ anthropic:messages`；`openai:responses` 为 Native Only
- 跨协议 fallback 共享 native retry 的 budget，fallback 不获取新 attempt slot
- Hedge twin 必须与 primary 同 protocol、同 surface；跨协议 hedge 被禁止

## Header / Endpoint / Stream 职责边界

| 层 | 职责 |
|---|---|
| Transport | 上游路径、协议头、流式判定、协议特定响应语义 |
| Protocol | 请求校验、错误构建、CORS |
| Stream | First-Event Guard、SSE 扫描、流追踪 |
| Reliability | 错误分类、节点状态、熔断 |
| Conversion (v1.3.0) | 跨协议请求/响应/流 转换,单向 |

Provider quirks (`src/config/provider-quirks.ts`) 仅记录 wire-format 兼容差异（如 `stream_options.include_usage` 是否可添加），不决定协议/路径/transport。
