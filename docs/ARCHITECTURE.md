# 架构说明 / Architecture

## 总体架构

```text
Logical Model (MODELS_CONFIG)
    ↓
Policy (POLICIES_CONFIG)
    ↓
Node Scheduler
    ↓
Node Pool (NODES_CONFIG)
    ↓
Provider / Account / API Key
```

## 请求路径

```text
OpenAI / Anthropic Client
           |
           v
Authentication, route allowlist, and body validation
           |
           v
Model resolution (logical model → workload + policy)
           |
           v
Node Scheduler (tier order → priority → health → latency)
           |
     free-node pool  (first)
           |
       exhausted / failed
           v
     paid-node pool
           |
       exhausted / failed
           v
     plus-node pool
```

## 核心抽象：Node

Node 是唯一调度单位。API Key、Token、Provider 都隐藏在 Node 之后。

每个 Node 包含：

- `id`：人工可读标识，格式 `{tier}-node-{number}`；
- `tier`：`free` / `paid` / `plus` 资源层级；
- `priority`：同层内的优先级；
- `secret_ref`：凭据引用，真实 Token 不进入配置主体；
- `workloads`：支持的工作负载类型；
- `capabilities`：能力声明（chat/stream/tools）；
- `models`：支持的逻辑模型列表；
- `limits.concurrency`：并发上限。

## 三层资源池

| 层级 | 特点 | 默认用途 |
|------|------|----------|
| `free-node` | 成本最低，稳定性不确定 | 默认优先 |
| `paid-node` | 稳定性较高 | 主要 fallback |
| `plus-node` | 最高可靠性 | 关键任务、Coding 长任务 |

默认顺序 `tier-1 → tier-2 → tier-3`。禁止 paid/plus 抢占 free。Critical 任务通过策略反转为 `plus → paid → free`。

## Scheduler 选择流程

按以下顺序筛选和排序：

1. workload 匹配（逻辑模型映射，不分析 Prompt）；
2. model 支持（节点 `models` 列表）；
3. tier 顺序（策略定义）；
4. priority 排序；
5. cooldown 排除；
6. circuit 状态排除；
7. concurrency 排除；
8. health 分数过滤；
9. latency 排序。

不做简单轮询。

## 运行时状态

Node 运行状态只保存在当前 Worker isolate 内存中：

```text
health, activeRequests, cooldownUntil,
recent429s, recent503s, avgLatency, circuitState
```

不使用 KV、D1、Durable Objects。isolate 回收后重置；不同 Cloudflare 节点之间不会自动合并。`/health` 与 `/metrics` 适合故障诊断，不适合精确计费或全局统计。

## 可靠性机制

### 429 处理

429 视为 Node 级限制：

```text
free-node-01 429 → cooldown → free-node-02 → free-node-03
```

不整个 Provider 禁用。支持 Retry-After 头。禁止 sleep。

### 503 处理与 Circuit Breaker

503/502/504 视为节点异常：

```text
Node 失败 → 记录失败
多个同类失败(3次) → Circuit Breaker 开启(30s) → half-open 试探
```

不一次失败永久禁用。

### First Event Guard

流式请求中 HTTP 200 不代表成功：

```text
upstream response → 等待第一个有效 event → 确认成功 → 提交客户端
```

首 event 前允许 failover（空流、连接重置、畸形 SSE、超时）。首 event 后禁止透明切换，避免 tool call 重复和 JSON 损坏。

### Retry Budget

分层预算限制，总计不超过 5 次，避免 retry storm：

| Workload | free | paid | plus |
|----------|------|------|------|
| General | ≤2 | ≤1 | - |
| Coding | ≤2 | ≤1 | ≤1 |

### 客户端取消

Client abort → AbortController → upstream abort → release Node state。客户端主动取消不处罚 Node。

## 协议桥接

Anthropic Messages 请求转换为 OpenAI Chat Completions；响应再转换回 Anthropic 格式。覆盖文本、图片、工具调用、并行工具、流式事件和部分 reasoning/thinking 兼容。

第三方模型未提供的 Anthropic 原生语义无法由网关补齐，包括可验证 thinking 签名和精确 Token 统计。

## 默认路由策略

白名单外路径和 `PUT`、`PATCH`、`DELETE` 等方法默认不会被转发。只有显式设置 `ALLOW_UNSAFE_PROXY_ROUTES=true` 才恢复通用透传模式。所有上游默认只允许 HTTPS。

## Endpoints

| Endpoint | Authentication | Purpose |
|---|---|---|
| `/` | No | Static status page |
| `/version` | No | Project version and readiness |
| `/v1/models` | Yes | Logical model list |
| `/health` | Yes | Current-isolate node health snapshot |
| `/metrics` | Yes | Current-isolate Prometheus metrics |
| `/v1/chat/completions` | Yes | OpenAI-compatible gateway |
| `/v1/messages` | Yes | Anthropic-compatible gateway |
