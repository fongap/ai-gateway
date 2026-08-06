# 配置说明 / Configuration

## 鉴权

### `GATEWAY_ACCESS_KEY`

客户端访问网关时使用的密钥。OpenAI 客户端通常使用：

```http
Authorization: Bearer <GATEWAY_ACCESS_KEY>
```

也支持：

```http
x-api-key: <GATEWAY_ACCESS_KEY>
```

该密钥与上游 API Token 完全不同，必须作为 Cloudflare Secret 保存。

## Primary

### `PRIMARY_API_TOKENS`

共享 Base URL：

```text
TOKEN_A,TOKEN_B
PRIMARY_BASE_URL=https://primary.example/v1
```

每个 Token 独立绑定地址：

```text
TOKEN_A@https://primary-a.example/v1,TOKEN_B@https://primary-b.example/v1
```

`PRIMARY_API_TOKENS` 包含 Token，因此整体必须保存为 Secret。

### 常用 Primary 参数

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PRIMARY_ENABLED` | 自动判断 | 根据 `PRIMARY_API_TOKENS` 是否存在自动判断 |
| `PRIMARY_MAX_ATTEMPTS` | `min(端点数, 3)` | 单次客户端请求最多尝试的 Primary 端点数 |
| `PRIMARY_ROTATION_WINDOW_MS` | `60000` | 当前 isolate 的滑动窗口长度 |
| `PRIMARY_ROTATION_MAX_PER_WINDOW` | `15` | 单端点窗口请求上限 |
| `PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT` | `3` | 单端点并发上限 |

## Fallback

最小配置：

```text
FALLBACK_API_TOKEN
FALLBACK_BASE_URL
FALLBACK_PRIMARY_MODEL
```

第二兜底：

```text
FALLBACK_SECONDARY_MODEL=model-flash  # 启用
FALLBACK_SECONDARY_MODEL=off          # 显式关闭
```

不设置或填写空值时默认关闭。`none`、`disabled` 和 `false` 会被视为普通模型名。

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
| `FALLBACK_CLIENT_NOTICE_TEXT` | 内置模板 | 可使用 provider、model、tier 等占位符 |

## 模型映射

`MODEL_MAPPING` 按实际上游 hostname 分组。示例见 [../config/model-mapping.example.json](../config/model-mapping.example.json)。

简单映射：

```json
{
  "api.example.com": {
    "model-alias": "vendor/actual-model-id"
  }
}
```

带能力和独立调用地址：

```json
{
  "api.example.com": {
    "model-alias": {
      "model": "vendor/actual-model-id",
      "invoke_url": "https://api.example.com/v1/chat/completions",
      "capabilities": {
        "tools": true,
        "stream_usage": true,
        "expose_reasoning": true
      }
    }
  }
}
```

`stream_usage: true` 只是请求上游在流结束时返回 usage。上游不支持或不返回时，网关无法得到准确 Token 数。

## 请求与运行保护

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `REQUEST_TIMEOUT_MS` | `60000` | 上游首字节超时，范围 5000–180000 ms |
| `MAX_BODY_BYTES` | 20 MiB | OpenAI 请求体上限 |
| `ANTHROPIC_MAX_BODY_BYTES` | 20 MiB | Anthropic 请求体上限 |
| `AUTH_FAIL_COOLDOWN_MS` | `86400000` | 401/403 冷却 |
| `RATE_LIMIT_COOLDOWN_MS` | `60000` | 429 冷却 |
| `ALLOWED_ORIGIN` | `*` | CORS 来源 |

## 诊断端点

### `/version`

公开端点，返回项目名、版本、运行环境、协议和仓库地址。它不返回任何运行时密钥或上游配置。

### `/v1/models`

需要鉴权。网关依次尝试 Primary 上游的模型列表接口；遇到不支持、鉴权失败或无效响应时继续尝试下一个。成功结果会与当前已配置 hostname 对应的 `MODEL_MAPPING` 别名及 Fallback 模型名合并。

响应头 `x-edge-gateway-model-source` 表示来源：

- `upstream`：仅来自上游；
- `upstream+configured`：上游结果与本地配置合并；
- `configured`：上游均不可用，仅返回本地配置。

### `/health`

需要鉴权，返回当前 isolate 的端点调用次数、成功/失败、健康分、冷却和延迟。

### `/metrics`

需要鉴权，输出当前 isolate 的 Prometheus 文本指标。

这些数据会随 isolate 回收而消失，也不会自动汇总全球节点。一次客户端请求可能重试多个上游，因此端点尝试次数不等于客户端请求次数。

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

该功能默认关闭。启用后每次记录会产生 Analytics Engine 写入，应先评估实际需求。
