# 配置说明 / Configuration

## 配置方式

网关支持两种配置方式：

1. **Node Scheduler（推荐）**：以 `NODES_CONFIG` + `MODELS_CONFIG` + `POLICIES_CONFIG` 三个 JSON Secret 定义三层节点池，完整启用 Node 调度。
2. **旧配置（兼容）**：继续使用 `PRIMARY_API_TOKENS` / `FALLBACK_*` / `MODEL_MAPPING`，网关会自动将其转换为 `free-node` 节点。

两种方式只需选择其一。同时设置时，`NODES_CONFIG` 优先。

---

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

# 一、Node Scheduler 配置（推荐）

## `NODES_CONFIG`

JSON 数组，定义全部调度节点。每个节点字段：

| 字段 | 必需 | 说明 |
|------|------|------|
| `id` | 是 | 节点 ID，格式必须为 `{tier}-node-{number}`，如 `free-node-01` |
| `tier` | 是 | `free` / `paid` / `plus` 三层之一 |
| `priority` | 否 | 数值越小越优先；默认 100 |
| `provider` | 否 | 服务商标识，仅用于诊断展示 |
| `account` | 否 | 账户标识，仅用于诊断展示 |
| `secret_ref` | 是 | 指向环境变量的名称，变量值为 `Token@BaseURL` 格式 |
| `workloads` | 否 | 支持的工作负载类型，如 `["general","coding"]`；默认 `["general"]` |
| `capabilities` | 否 | 能力声明，如 `["chat","stream","tools"]`；默认 `["chat"]` |
| `models` | 否 | 该节点支持的逻辑模型列表；为空时支持所有模型 |
| `limits.concurrency` | 否 | 单节点并发上限；默认 2 |

示例（保存为 Secret `NODES_CONFIG`）：

```json
[
  {
    "id": "free-node-01",
    "tier": "free",
    "priority": 100,
    "provider": "provider-a",
    "account": "account-01",
    "secret_ref": "FREE_NODE_01",
    "workloads": ["general", "coding"],
    "capabilities": ["chat", "stream", "tools"],
    "models": ["general-air", "code-pro"],
    "limits": { "concurrency": 2 }
  },
  {
    "id": "paid-node-01",
    "tier": "paid",
    "priority": 80,
    "secret_ref": "PAID_NODE_01",
    "workloads": ["general", "coding"],
    "models": ["code-pro"]
  },
  {
    "id": "plus-node-01",
    "tier": "plus",
    "priority": 50,
    "secret_ref": "PLUS_NODE_01",
    "workloads": ["coding", "critical"],
    "models": ["code-max"]
  }
]
```

完整示例见 [../config/nodes.example.json](../config/nodes.example.json)。

## 节点凭据

每个节点的 `secret_ref` 指向一个独立的环境变量，值为 OpenAI 兼容上游凭据：

```text
FREE_NODE_01=sk-xxx@https://free-api.example/v1
PAID_NODE_01=sk-yyy@https://paid-api.example/v1
PLUS_NODE_01=sk-zzz@https://plus-api.example/v1
```

格式与旧版 `Token@BaseURL` 相同。所有节点凭据都必须保存为 Cloudflare Secret。默认仅接受 HTTPS 上游。

## `MODELS_CONFIG`

JSON 对象，定义客户端可见的逻辑模型。客户端只使用这些模型名，真实 Provider 模型名不暴露。

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

完整示例见 [../config/models.example.json](../config/models.example.json)。

## `POLICIES_CONFIG`

JSON 对象，定义各策略如何选择节点层级。

每个策略字段：

| 字段 | 说明 |
|------|------|
| `tiers` | 层级尝试顺序，如 `["free","paid","plus"]` |
| `max_attempts` | 单次请求最大尝试数，范围 1–5 |
| `retry_budget` | 各层级的尝试预算 `{ free, paid, plus }` |

示例（保存为 Secret `POLICIES_CONFIG`）：

```json
{
  "general-fast": {
    "tiers": ["free", "paid"],
    "max_attempts": 3,
    "retry_budget": { "free": 2, "paid": 1 }
  },
  "coding-stable": {
    "tiers": ["free", "paid", "plus"],
    "max_attempts": 4,
    "retry_budget": { "free": 2, "paid": 1, "plus": 1 }
  },
  "critical-only": {
    "tiers": ["plus", "paid", "free"],
    "max_attempts": 3,
    "retry_budget": { "plus": 1, "paid": 1, "free": 1 }
  }
}
```

完整示例见 [../config/policies.example.json](../config/policies.example.json)。

未定义的策略回退到默认值：`tiers: ["free","paid"]`、`max_attempts: 3`、`retry_budget: { free: 2, paid: 1, plus: 1 }`。

## 三层资源池语义

| 层级 | 特点 | 默认用途 |
|------|------|----------|
| `free-node` | 成本最低，稳定性不确定 | 默认优先 |
| `paid-node` | 稳定性较高，成本可接受 | 主要 fallback |
| `plus-node` | 最高可靠性，成本最高 | 关键任务、Coding 长任务 |

默认调度顺序为 `free → paid → plus`。禁止因为 paid/plus 更快而自动抢占 free。Critical 任务可通过策略反转为 `plus → paid → free`。

## 调度排序依据

Scheduler 按以下顺序筛选和排序候选节点：

1. workload 匹配（通过逻辑模型映射）；
2. model 支持（检查节点 `models` 列表）；
3. tier 顺序（按策略 `tiers`）；
4. priority 排序；
5. cooldown 排除（429 冷却中的节点直接跳过）；
6. circuit 状态排除（熔断中的节点跳过）；
7. concurrency 排除（达到 `limits.concurrency` 的节点跳过）;
8. health 分数（低于阈值的节点跳过）；
9. latency 排序。

## 可靠性机制

### 429 处理

429 视为 Node 级限制。单个节点进入冷却并切换到同层其他节点或更高层节点，不会禁用整个 Provider。冷却时长优先读取上游 `Retry-After` 头，默认 60 秒。

### 503 处理

503/502/504 视为节点或 Provider 异常。同一节点累计 3 次同类失败后触发轻量 Circuit Breaker（开启 30 秒），之后进入 half-open 状态放行一次试探请求。试探成功即关闭熔断，失败则重新开启。

### Retry Budget

单次请求的分层尝试预算受策略控制，总计不超过 5 次，避免 retry storm。

### First Event Guard

流式请求中 HTTP 200 不代表成功。网关等待第一个有效 SSE event 后才确认成功并把响应提交给客户端。首个 event 之前允许 failover（空流、连接重置、畸形 SSE、超时均触发切换）。首个 event 之后禁止透明切换，避免 tool call 重复执行和 JSON 结构损坏。

### 超时拆分

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `UPSTREAM_HEADERS_TIMEOUT` | `30000` | 等待上游响应头超时，范围 5000–60000 ms |
| `FIRST_EVENT_TIMEOUT` | `60000` | 流式请求等待第一个有效 event 超时，范围 10000–120000 ms |
| `STREAM_IDLE_TIMEOUT` | `120000` | 流式传输空闲超时，范围 30000–300000 ms |

### 客户端取消

客户端主动取消请求时，网关立即中断上游连接并释放节点并发计数，**不处罚节点健康分**。

---

# 二、旧配置（兼容模式）

> 不设置 `NODES_CONFIG` 时自动生效。旧配置会被转换为 `free-node-*` 节点，走同一个 Scheduler。

## `PRIMARY_API_TOKENS`

共享 Base URL：

```text
PRIMARY_API_TOKENS=TOKEN_A,TOKEN_B
PRIMARY_BASE_URL=https://primary.example/v1
```

每个 Token 独立绑定地址：

```text
PRIMARY_API_TOKENS=TOKEN_A@https://primary-a.example/v1,TOKEN_B@https://primary-b.example/v1
```

含凭据，必须保存为 Secret。默认仅接受 HTTPS；只有明确设置 `ALLOW_INSECURE_HTTP_UPSTREAM=true` 才允许 HTTP（仅限本地受控测试）。

Base URL 可包含供应商要求的固定查询参数，网关会保留这些参数并合并客户端查询参数，客户端同名参数优先。

## Primary 调度参数

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PRIMARY_ENABLED` | 自动判断 | 根据 `PRIMARY_API_TOKENS` 是否存在判断 |
| `PRIMARY_MAX_ATTEMPTS` | `min(端点数, 3)` | 单次请求最多尝试的 Primary 数量 |
| `PRIMARY_ROTATION_WINDOW_MS` | `60000` | 当前 isolate 的请求窗口 |
| `PRIMARY_ROTATION_MAX_PER_WINDOW` | `15` | 达到后该端点在当前窗口内不再被选择 |
| `PRIMARY_MAX_CONCURRENCY_PER_ENDPOINT` | `3` | 达到后该端点在并发释放前不再被选择 |

冷却中的端点会被排除。所有 Primary 都不可用时，网关尝试 Fallback；没有可用 Fallback 时返回 429。

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

不设置或空值时默认关闭。关闭整个 Fallback 使用 `FALLBACK_ENABLED=false` 或仓库提供的 `scripts/disable-fallback.*` 脚本。

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
| `FALLBACK_CLIENT_NOTICE_TEXT` | 内置模板 | 支持 provider、model、tier 占位符 |

`visible` 会修改响应正文，不适合严格 JSON 或结构化输出；此类场景应使用默认 `headers`。

## 模型映射

`MODEL_MAPPING` 按实际上游 hostname 分组。示例见 [../config/model-mapping.example.json](../config/model-mapping.example.json)。

```json
{
  "api.example.com": {
    "model-alias": {
      "model": "vendor/actual-model-id",
      "invoke_url": "https://api.example.com/v1/chat/completions?api-version=2026-01-01",
      "capabilities": { "tools": true, "stream_usage": true }
    }
  }
}
```

`STRICT_MODEL_MAPPING=true` 时，请求中的 `model` 必须是已声明的别名或已配置的 Fallback 模型名，否则返回 400。

Hostname 统一转小写。`request_overrides` 与 `drop_params` 不允许改写或删除 `model`、`messages`、`stream`。

---

# 三、通用配置

## 默认安全策略

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `ALLOW_UNSAFE_PROXY_ROUTES` | `false` | 只允许文档列出的路径和方法 |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | `false` | 上游默认只接受 HTTPS |
| `STRICT_MODEL_MAPPING` | `false` | 只允许已声明的模型名 |
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

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `MODEL_LIST_TIMEOUT_MS` | `5000` | 每个上游模型列表请求的超时，范围 1000–30000 ms |
| `MODEL_LIST_MAX_ATTEMPTS` | `3` | 最多尝试的上游数量 |

设置了 `MODELS_CONFIG` 时，`/v1/models` 返回其中声明的逻辑模型。旧模式下行为与原版一致。

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

公开端点，返回项目版本及配置就绪状态（是否已绑定 `GATEWAY_ACCESS_KEY` 与 `NODES_CONFIG`/`PRIMARY_API_TOKENS`）。只返回布尔值，不返回 Secret 内容。

### `/health`

需要鉴权。返回当前 isolate 的节点健康快照（健康分、冷却、并发、熔断状态等）。默认不含上游地址；`EXPOSE_UPSTREAM_INFO=true` 后才显示。

### `/metrics`

需要鉴权。输出当前 isolate 的 Prometheus 文本指标：客户端请求统计与各节点尝试数、成功率、延迟、冷却状态。
