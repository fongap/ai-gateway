# 配置说明 / Configuration

## 鉴权

### `GATEWAY_ACCESS_KEY`

客户端访问网关使用的密钥。支持：

```http
Authorization: Bearer <GATEWAY_ACCESS_KEY>
```

或：

```http
x-api-key: <GATEWAY_ACCESS_KEY>
```

该密钥与上游 API Token 不同，必须保存为 Cloudflare Secret。

## 默认安全策略

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `ALLOW_UNSAFE_PROXY_ROUTES` | `false` | 只允许文档列出的路径和方法；设为 `true` 才允许其他路径透传 |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | `false` | Primary 与 Fallback 默认只接受 HTTPS |
| `STRICT_MODEL_MAPPING` | `false` | 设为 `true` 后，只允许 `MODEL_MAPPING` 和 Fallback 中声明的模型名 |
| `EXPOSE_UPSTREAM_INFO` | `false` | 默认隐藏诊断和响应头中的上游 host、Base URL 与基础设施信息 |
| `FAKE_STREAM_PROTECTION` | `false` | 默认不把非流式请求改成上游流式请求 |

默认允许的接口：

```text
GET  /version
GET  /v1/models
GET  /models
GET  /health
GET  /metrics
POST /v1/chat/completions
POST /chat/completions
POST /v1/messages
POST /messages
POST /v1/messages/count_tokens
POST /messages/count_tokens
```

`/` 仅用于浏览器 Dashboard。白名单外路径默认返回 404，不会转发到上游。

## Primary

### `PRIMARY_API_TOKENS`

共享 Base URL：

```text
PRIMARY_API_TOKENS=TOKEN_A,TOKEN_B
PRIMARY_BASE_URL=https://primary.example/v1
```

每个 Token 独立绑定地址：

```text
PRIMARY_API_TOKENS=TOKEN_A@https://primary-a.example/v1,TOKEN_B@https://primary-b.example/v1
```

`PRIMARY_API_TOKENS` 含凭据，必须保存为 Secret。默认仅接受 HTTPS。只有明确设置：

```text
ALLOW_INSECURE_HTTP_UPSTREAM=true
```

才允许 HTTP；该开关仅适合本地受控测试。

Base URL 可包含供应商要求的固定查询参数，例如：

```text
https://api.example/v1?api-version=2026-01-01
```

网关会保留这些参数，并合并客户端请求中的查询参数；客户端同名参数优先。

### Primary 调度参数

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PRIMARY_ENABLED` | 自动判断 | 根据 `PRIMARY_API_TOKENS` 是否存在判断 |
| `PRIMARY_MAX_ATTEMPTS` | `min(端点数, 3)` | 单次请求最多尝试的 Primary 数量 |
| `PRIMARY_ROTATION_WINDOW_MS` | `60000` | 当前 isolate 的请求窗口 |
| `PRIMARY_ROTATION_MAX_PER_WINDOW` | `15` | 达到后该端点在当前窗口内不再被选择 |
| `PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT` | `3` | 达到后该端点在并发释放前不再被选择 |
| `FALLBACK_MAX_CONCURRENCY_PER_ENDPOINT` | `3` | 每个 Fallback 端点的硬并发上限 |
| `AUTH_FAIL_COOLDOWN_MS` | `86400000` | 401/403 冷却时间 |
| `RATE_LIMIT_COOLDOWN_MS` | `60000` | 429 冷却时间 |

冷却中的端点会被排除，而不是只放到队列末尾。所有 Primary 都不可用时，网关尝试 Fallback；没有可用 Fallback 时返回 429。

## Fallback

最小配置：

```text
FALLBACK_ENABLED=true
FALLBACK_API_TOKEN=<secret>
FALLBACK_BASE_URL=https://fallback.example/v1
FALLBACK_PRIMARY_MODEL=model-pro
```

第二兜底：

```text
FALLBACK_SECONDARY_MODEL=model-flash  # 启用
FALLBACK_SECONDARY_MODEL=off          # 显式关闭
```

不设置或空值时默认关闭。`none`、`disabled`、`false` 会被当作普通模型名。

关闭整个 Fallback：

```text
FALLBACK_ENABLED=false
```

仓库提供：

```bash
./scripts/disable-fallback.sh
```

或：

```powershell
.\scripts\disable-fallback.ps1
```

脚本使用 `wrangler secret bulk` 写入关闭状态并删除旧 Fallback Secret，不会重新部署本地代码。

可分别覆盖两个兜底的 Token 和 URL：

```text
FALLBACK_PRIMARY_TOKEN
FALLBACK_PRIMARY_BASE_URL
FALLBACK_SECONDARY_TOKEN
FALLBACK_SECONDARY_BASE_URL
```

### 客户端兜底反馈

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FALLBACK_CLIENT_NOTICE_MODE` | `headers` | `headers`、`visible` 或 `off` |
| `FALLBACK_CLIENT_NOTICE_TEXT` | 内置模板 | 支持 provider、model、tier 等占位符 |

`visible` 会修改模型正文，不适合严格 JSON、JSON Schema 或其他结构化输出；此类场景应使用默认 `headers`。

## 模型映射

`MODEL_MAPPING` 按实际上游 hostname 分组。示例见 [../config/model-mapping.example.json](../config/model-mapping.example.json)。

```json
{
  "api.example.com": {
    "model-alias": {
      "model": "vendor/actual-model-id",
      "invoke_url": "https://api.example.com/v1/chat/completions?api-version=2026-01-01",
      "capabilities": {
        "tools": true,
        "stream_usage": true,
        "expose_reasoning": true
      }
    }
  }
}
```

`STRICT_MODEL_MAPPING=true` 时，请求中的 `model` 必须是已声明的客户端别名或已配置的 Fallback 模型名，否则返回 400。网关会先筛选真正拥有该别名映射的 Primary，再应用最大尝试数；不会把别名原样发送给未配置该映射的上游。压缩请求体始终返回 415，无效 JSON 返回 400。

Hostname 会统一转成小写。`request_overrides` 与 `drop_params` 不允许改写或删除 `model`、`messages`、`stream`，避免静态映射破坏模型路由、用户消息或流式语义。

`stream_usage: true` 只是要求上游在流结束时返回 usage；上游不支持或不返回时，网关无法得到准确 Token 数。

## 模型列表

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `MODEL_LIST_TIMEOUT_MS` | `5000` | 每个上游模型列表请求的超时，范围 1000–30000 ms |
| `MODEL_LIST_MAX_ATTEMPTS` | `3` | 最多尝试的 Primary 数量 |

`STRICT_MODEL_MAPPING=true` 时，`/v1/models` 只返回本地配置的客户端别名，不访问上游模型目录；若未配置任何可用模型，接口直接返回配置错误，而不是误导性的空列表。非严格模式会跳过冷却中的 Primary，并把首个有效上游列表与本地模型别名合并。所有上游都不可用时，只要存在 `MODEL_MAPPING` 或 Fallback 模型，仍返回本地配置模型。默认错误详情不会暴露真实上游 hostname。

## 请求体与协议

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `REQUEST_TIMEOUT_MS` | `60000` | 上游首字节超时，范围 5000–180000 ms |
| `ANTHROPIC_MAX_BODY_BYTES` | 20 MiB | Anthropic 请求体上限 |
| `ANTHROPIC_COUNT_TOKENS_MODE` | `approximate` | `approximate` 或 `disabled` |
| `ANTHROPIC_REASONING_REQUEST_MODE` | `none` | reasoning 参数桥接方式 |
| `ALLOWED_ORIGIN` | `*` | 单个允许的 HTTP/HTTPS Origin；无效值按 `null` 处理 |
| `MAX_BODY_BYTES` | 20 MiB | OpenAI JSON 请求体上限，包含无 `Content-Length` 的流式上传 |

OpenAI 与 Anthropic 支持接口要求 `Content-Type: application/json`。除 `Content-Encoding: identity` 外，压缩请求体不被接受，避免压缩字节被错误转发。`ANTHROPIC_COUNT_TOKENS_MODE` 填写其他值会直接返回配置错误。`FAKE_STREAM_PROTECTION=true` 会把非流式 Chat Completions 请求改成上游流式请求，再在 Worker 中重组。该模式可能改变 usage、结构化输出和超长响应行为，因此默认关闭。

## 缓存

缓存默认关闭。可选变量：

流式响应不会进入网关缓存；缓存仅适用于 OpenAI 非流式成功响应，避免长连接回放、客户端取消与上游生成状态之间出现不一致。

```text
CACHE_ENABLED
CACHE_MAX_AGE_SEC
CACHE_MAX_BODY_BYTES
```

仅建议缓存具有确定性的请求，例如显式 `temperature=0` 或提供固定 `seed` 的请求。

## 诊断端点

### `/version`

公开端点，返回项目名、版本、协议、仓库地址，以及当前活动版本是否已绑定 `GATEWAY_ACCESS_KEY` 与 `PRIMARY_API_TOKENS`。只返回布尔状态，不返回任何 Secret 内容。

### `/health`

需要鉴权。默认不返回上游 Base URL 或真实 provider host；设置 `EXPOSE_UPSTREAM_INFO=true` 后才显示。

### `/metrics`

需要鉴权。输出当前 isolate 的两组数据：

- 客户端 API 请求、成功、失败、Fallback 触发与 Fallback 成功；
- 各端点尝试、成功、失败、活动连接、平均首字节时间、健康分和冷却状态。

流式连接在响应体结束或客户端取消后才释放活动计数。非流式请求按最终 HTTP 状态划分；流式请求只有在响应体完整结束后才计为成功，中断或客户端取消会计入失败，并单独记录取消次数。

这些数据随 isolate 回收而重置，也不会自动汇总全球节点。一次客户端请求可能尝试多个上游，因此端点尝试数不等于客户端请求数。

## Analytics Engine（可选）

需要跨 isolate 的趋势分析时，可在 `wrangler.jsonc` 中加入：

```jsonc
{
  "analytics_engine_datasets": [
    {
      "binding": "AE_DATASET",
      "dataset": "smart_edge_gateway_events"
    }
  ]
}
```

默认不开启，启用后每次写入会产生额外资源消耗。

## 日志

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `LOG_LEVEL` | `info` | `none`、`error`、`info` 或 `debug`；生产环境建议 `error` 或 `info` |

日志不会主动输出完整 Token，但启用上游信息暴露和调试日志仍应限制日志访问权限。

