# 配置说明 / Configuration

网关以 Node Scheduler 为核心，通过 `TIER1_NODES_CONFIG` + `MODELS_CONFIG` + `POLICIES_CONFIG` 三个 JSON Secret 定义三层节点池（tier-1 / tier-2 / tier-3）。不依赖任何旧版 API 转发配置。

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

---

# 一、核心配置

## `TIER1_NODES_CONFIG`

JSON 数组，定义全部调度节点。每个节点字段：

| 字段 | 必需 | 说明 |
|------|------|------|
| `id` | 是 | 节点 ID，推荐格式 `{tier}-node-{number}`，如 `tier-1-node-01` |
| `tier` | 是 | `free` / `paid` / `plus` 三层之一 |
| `models` | 否 | 逻辑模型到实际上游模型名的映射对象；为空时同名透传 |
| `models` | 否 | 逻辑模型到实际上游模型名的映射对象；为空时同名透传 |
| `priority` | 否 | 可选，数值越小越优先；默认 100 |
| `provider` | 否 | 可选，服务商标识，仅用于诊断展示 |
| `limits.concurrency` | 否 | 可选，单节点并发上限；默认 2 |

示例（保存为 Secret `TIER1_NODES_CONFIG`）：

```json
[
  {
    "id": "tier-1-node-01",
    "tier": "tier-1",
    "token": "sk-xxx@https://provider-a/v1",
    "models": {
      "general-air": "tier-1-provider/model-air",
      "code-pro": "tier-1-provider/code-pro"
    }
  },
  {
    "id": "tier-2-node-01",
    "tier": "tier-2",
    "token": "sk-yyy@https://provider-b/v1",
    "models": {
      "code-pro": "tier-2-provider/code-pro"
    }
  },
  {
    "id": "tier-3-node-01",
    "tier": "tier-3",
    "token": "sk-zzz@https://provider-c/v1",
    "models": {
      "code-max": "tier-3-provider/code-max"
    }
  }
]
```

完整示例见 [../config/nodes.example.json](../config/nodes.example.json)。

## 节点凭据

每个节点的 `token` 直接内嵌在节点定义中，值为 OpenAI 兼容上游凭据：

```text
```

格式为 `Token@BaseURL`。所有节点凭据都必须保存为 Cloudflare Secret。默认仅接受 HTTPS 上游；只有显式设置 `ALLOW_INSECURE_HTTP_UPSTREAM=true` 才允许 HTTP（仅限本地受控测试）。

## `MODELS_CONFIG`

JSON 对象，定义客户端可见的逻辑模型。客户端只使用这些模型名，真实 Provider 模型名不暴露（由 `TIER1_NODES_CONFIG.models` 映射）。

每个模型字段：

| 字段 | 说明 |
|------|------|
| `workload` | 工作负载类型：`general` / `coding` / `critical`；决定调度偏好 |
| `policy` | 使用的策略名，对应 `POLICIES_CONFIG` 中的键 |

示例（保存为 Secret `MODELS_CONFIG`）：

```json
{
  "general-air": { "workload": "general", "policy": "general-fast" },
  "general-pro": { "workload": "general", "policy": "general-fast" },
  "code-air":    { "workload": "coding",  "policy": "coding-stable" },
  "code-pro":    { "workload": "coding",  "policy": "coding-stable" },
  "code-max":    { "workload": "coding",  "policy": "coding-stable" }
}
```

完整示例见 [../config/models.example.json](../config/models.example.json)。未在 `MODELS_CONFIG` 声明的模型使用默认策略 `general-fast`。

## `POLICIES_CONFIG`

JSON 对象，定义各策略如何选择节点层级。

每个策略字段：

| 字段 | 说明 |
|------|------|
| `tiers` | 层级尝试顺序，如 `["tier-1","tier-2","tier-3"]` |
| `max_attempts` | 单次请求最大尝试数，范围 1–5 |
| `retry_budget` | 各层级的尝试预算 `{ free, paid, plus }` |

示例（保存为 Secret `POLICIES_CONFIG`）：

```json
{
  "general-fast": {
    "tiers": ["tier-1", "tier-2"],
    "max_attempts": 3,
    "retry_budget": { "tier-1": 2, "tier-2": 1 }
  },
  "coding-stable": {
    "tiers": ["tier-1", "tier-2", "tier-3"],
    "max_attempts": 4,
    "retry_budget": { "tier-1": 2, "tier-2": 1, "tier-3": 1 }
  },
  "critical-only": {
    "tiers": ["tier-3", "tier-2", "tier-1"],
    "max_attempts": 3,
    "retry_budget": { "tier-3": 1, "tier-2": 1, "tier-1": 1 }
  }
}
```

完整示例见 [../config/policies.example.json](../config/policies.example.json)。

未定义的策略回退到默认值：`tiers: ["tier-1","tier-2"]`、`max_attempts: 3`、`retry_budget: { tier-1: 2, tier-2: 1, tier-3: 1 }`。

## 三层资源池语义

| 层级 | 特点 | 默认用途 |
|------|------|----------|
| `free-node` | 稳定性不确定，tier-1 优先 | 默认优先 |
| `paid-node` | 稳定性较高，tier-2 回退 | 主要 fallback |
| `plus-node` | 最高可靠性，tier-3 保底 | 关键任务、Coding 长任务使用 tier-3 |

默认调度顺序为 `tier-1 → tier-2 → tier-3`。禁止因为 paid/plus 更快而自动抢占 free。Critical 任务可通过策略反转为 `plus → paid → free`。

## 调度排序依据

Scheduler 按以下顺序筛选和排序候选节点：

1. workload 匹配（通过逻辑模型映射，不分析 Prompt）；
2. model 支持（检查节点 `models` 映射是否有该逻辑模型）；
3. tier 顺序（按策略 `tiers`）；
4. priority 排序；
5. cooldown 排除（429 冷却中的节点直接跳过）；
6. circuit 状态排除（熔断中的节点跳过）；
7. concurrency 排除（达到 `limits.concurrency` 的节点跳过）；
8. health 分数（低于阈值的节点跳过）；
9. latency 排序。

## 模型名回写

网关在响应中把 `model` 字段回写为客户端请求的逻辑模型名，避免向上游透传或暴露真实 Provider 模型名。流式响应同样逐事件回写。

---

# 二、可靠性机制

## 429 处理

429 视为 Node 级限制。单个节点进入冷却并切换到同层其他节点或更高层节点，不会禁用整个 Provider。冷却时长优先读取上游 `Retry-After` 头，默认 60 秒。

## 503 处理与 Circuit Breaker

503/502/504 视为节点或 Provider 异常。同一节点累计 3 次同类失败后触发轻量 Circuit Breaker（开启 30 秒），之后进入 half-open 状态放行一次试探请求。试探成功即关闭熔断，失败则重新开启。

## Retry Budget

单次请求的分层尝试预算受策略控制，总计不超过 5 次，避免 retry storm。

## First Event Guard

OpenAI 直通流式请求中，HTTP 200 不代表成功。网关等待第一个有效 SSE data 事件后才确认成功并把响应提交给客户端。首个事件之前允许 failover（空流、连接重置、畸形 SSE、超时均触发切换）。首个事件之后禁止透明切换，避免 tool call 重复执行和 JSON 结构损坏。

Anthropic 转换路径与重组模式（`FAKE_STREAM_PROTECTION`）由各自的错误处理层以 `event: error` 表达，不经过 First Event Guard。

## 超时拆分

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `UPSTREAM_HEADERS_TIMEOUT` | `30000` | 等待上游响应头超时，范围 5000–60000 ms |
| `FIRST_EVENT_TIMEOUT` | `60000` | 流式请求等待第一个有效事件超时，范围 10000–120000 ms |
| `STREAM_IDLE_TIMEOUT` | `120000` | 流式传输空闲超时，范围 30000–300000 ms |

## 客户端取消

客户端主动取消请求时，网关立即中断上游连接并释放节点并发计数，**不处罚节点健康分**。

---

# 三、通用配置

## 默认安全策略

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `ALLOW_UNSAFE_PROXY_ROUTES` | `false` | 只允许文档列出的路径和方法 |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | `false` | 节点上游默认只接受 HTTPS |
| `EXPOSE_UPSTREAM_INFO` | `false` | 默认隐藏诊断中的上游 host 与 Base URL |
| `FAKE_STREAM_PROTECTION` | `false` | 默认不把非流式请求改成上游流式 |

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

`/` 仅用于浏览器状态页。白名单外路径默认返回 404。

## 请求体与协议

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `REQUEST_TIMEOUT_MS` | `180000` | 上游首字节超时，范围 5000–180000 ms |
| `ANTHROPIC_MAX_BODY_BYTES` | 20 MiB | Anthropic 请求体上限 |
| `ANTHROPIC_COUNT_TOKENS_MODE` | `approximate` | `approximate` 或 `disabled` |
| `ANTHROPIC_REASONING_REQUEST_MODE` | `none` | reasoning 参数桥接方式 |
| `ALLOWED_ORIGIN` | `*` | 单个允许的 HTTP/HTTPS Origin |
| `MAX_BODY_BYTES` | 20 MiB | OpenAI JSON 请求体上限 |

OpenAI 与 Anthropic 接口要求 `Content-Type: application/json`。除 `Content-Encoding: identity` 外压缩请求体一律返回 415。

## 模型列表

`/v1/models` 返回 `TIER1_NODES_CONFIG` 中所有节点声明过的逻辑模型并集，按名称排序。不会查询或暴露任何上游真实模型目录，也不暴露上游地址。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `MODEL_LIST_TIMEOUT_MS` | `5000` | 保留项 |
| `MODEL_LIST_MAX_ATTEMPTS` | `3` | 保留项 |

## 缓存

缓存默认关闭，仅适用于非流式成功响应：

```text
CACHE_ENABLED
CACHE_MAX_AGE_SEC
CACHE_MAX_BODY_BYTES
```

仅建议缓存确定性请求（显式 `temperature=0` 或固定 `seed`）。

## 日志

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `LOG_LEVEL` | `info` | `none`、`error`、`info` 或 `debug` |

日志只输出 Node ID，不输出 API Key、Token、Prompt 或 Response。

## Analytics Engine（可选）

需要跨 isolate 趋势分析时，在 `wrangler.jsonc` 中加入：

```jsonc
{
  "analytics_engine_datasets": [
    { "binding": "AE_DATASET", "dataset": "ai_gateway_events" }
  ]
}
```

默认不开启。

## 诊断端点

### `/version`

公开端点，返回项目版本及配置就绪状态（是否已绑定 `GATEWAY_ACCESS_KEY` 与 `TIER1_NODES_CONFIG`）。只返回布尔值，不返回 Secret 内容。

### `/health`

需要鉴权。返回当前 isolate 的节点健康快照（健康分、冷却、并发、熔断状态、tier、models 等）。默认不含上游地址；`EXPOSE_UPSTREAM_INFO=true` 后才显示 provider 名。

### `/metrics`

需要鉴权。输出当前 isolate 的 Prometheus 文本指标：客户端请求统计与各节点尝试数、成功率、延迟、冷却状态、熔断状态。
