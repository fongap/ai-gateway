# 配置说明

## 鉴权

### `GATEWAY_ACCESS_KEY`

客户端访问网关时使用的密钥。OpenAI 客户端通常放在：

```http
Authorization: Bearer <GATEWAY_ACCESS_KEY>
```

也支持：

```http
x-api-key: <GATEWAY_ACCESS_KEY>
```

该密钥与上游 API Token 完全不同。

## Primary

### `PRIMARY_API_TOKENS`

支持两种格式：

```text
TOKEN_A,TOKEN_B
```

配合共享地址：

```text
PRIMARY_BASE_URL=https://primary.example/v1
```

或将地址直接绑定到 Token：

```text
TOKEN_A@https://primary-a.example/v1,TOKEN_B@https://primary-b.example/v1
```

### 常用 Primary 参数

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PRIMARY_MAX_ATTEMPTS` | `min(端点数, 3)` | 单次客户端请求最多尝试的 Primary 端点数 |
| `PRIMARY_ROTATION_WINDOW_MS` | `60000` | 滑动窗口长度 |
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

不设置该变量时默认关闭。`none`、`disabled` 和 `false` 会被视为普通模型名，不是关闭指令。

## 模型映射

`MODEL_MAPPING` 以实际上游 hostname 分组。示例见 `config/model-mapping.example.json`。

简单映射：

```json
{
  "api.example.com": {
    "model-alias": "vendor/actual-model-id"
  }
}
```

带能力声明：

```json
{
  "api.example.com": {
    "model-alias": {
      "model": "vendor/actual-model-id",
      "capabilities": {
        "tools": true,
        "stream_usage": true,
        "expose_reasoning": true
      }
    }
  }
}
```

`stream_usage: true` 只是要求上游在流结束时返回 usage。上游不支持时，网关无法得到精确 Token 数。

## 诊断

### `/health`

返回当前 isolate 的端点状态、调用次数、成功/失败、健康分和延迟等信息。

### `/metrics`

输出当前 isolate 的 Prometheus 文本指标。

这些数据会随 isolate 回收而消失，也不会自动合并全球节点。

## Analytics Engine（可选）

需要跨 isolate 的趋势分析时，在 `wrangler.jsonc` 中加入：

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

该功能默认关闭。开启后，每次记录会产生 Analytics Engine 写入，请先评估实际需求。
