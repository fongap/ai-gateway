# 系统架构总览

## 设计目标

每个功能都必须回答：是否提高了上游配额利用率？是否提高了可靠性？是否降低了 Worker CPU 开销？是否更可预测？否则不在范围内。

## 概览

网关原生支持两种协议族——OpenAI 和 Anthropic。任何提供 OpenAI-compatible 或 Anthropic-compatible API 的服务均可作为节点接入。网关采用 Native First 策略：OpenAI Chat / Responses 只走原生路径；Anthropic Messages 优先原生，原生池耗尽后可选转换到 OpenAI Chat（通过 `PROTOCOL_FALLBACKS` 显式配置，仅支持 Anthropic → OpenAI Chat 单向转换）。

```text
Client (OpenAI / Anthropic SDK)
   ↓  auth (timing-safe), route allowlist, body limits
Request Orchestration (src/request/*)
   ↓  route → (protocol, surface): openai chat|responses, anthropic messages
Config Layer (src/config)          ← parses env shards ONCE per isolate
   ↓  Runtime Node { id, tier, provider, protocol, surfaces, baseUrl, credential, priority, models, limits }
Scheduler (src/scheduler)
   ↓  Tier 1: Eligibility → Affinity → P2C; Tier 2/3: existing selector
Reliability (src/reliability)      ← Tier 1 account/model state; legacy Tier 2/3 node state
Transport (src/transport)          ← openai.js / anthropic.js: native path, headers, stream semantics
   ↓
Upstream providers (native endpoint of the SAME protocol + surface)
```

## 职责划分

```text
Model Registry (src/config/registry.js)   →  logical model, its policy + capabilities
Node (src/config/nodes.js)                →  logical model → upstream model, protocol + surfaces
Transport (src/transport)                 →  HOW to talk to the upstream (path, headers, stream semantics)
Provider quirks (src/config/provider-quirks.js) → known wire-format compatibility differences
Scheduler (src/scheduler)                 →  decides WHICH node gets a request
Reliability (src/reliability)             →  whether a node is currently usable
```

`src/transport/*` 不调度节点；`src/scheduler` 和 `src/reliability` 不解析协议事件，也不知道上游使用什么 wire format。`provider` 仅为元数据（dashboard / metrics / diagnostics / quirks），不决定 transport。Model Registry 拥有模型能力声明；任何 transport 或 provider 标签都不声称模型能力。

## 不变量

- 原生协议转发：Chat → 上游 `/v1/chat/completions`，Responses → 上游 `/v1/responses`，Messages → 上游 `/v1/messages`
- Native First：OpenAI Chat / Responses 只走原生路径；Anthropic Messages 优先原生，原生池耗尽后可选转换到 OpenAI Chat（`PROTOCOL_FALLBACKS` 显式配置）
- `limits.rpm` 默认 hard，单 Worker isolate 内不主动越配额
- 整请求 failover budget，超时即停
- 所有短期运行时状态（Tier 1 TTFT/inFlight/cooldown，Tier 2/3 health/circuit/concurrency/RPM）均为 isolate-local best-effort，随 isolate 重启丢失
- D1 仅用于可选的 token-usage 聚合，不在 AI 请求热路径上
- KV (TIER1_AFFINITY)：30 分钟 TTL，仅用于 Tier 1 会话亲和
- D1 token_usage_totals：单行 'global'，生命周期累计，永不清理
- D1 token_usage_hourly：7 天保留，UTC 小时桶
- D1 token_usage_model_hourly：7 天保留，按模型 UTC 小时桶
- D1 token_usage_daily：52 周保留，UTC+8 自然日桶
- D1 token_usage_weekly：52 周保留，UTC 周一起始周桶
- 定时任务 (0 3 * * *)：hourly→daily 聚合 → daily→weekly 聚合 → 清理过期数据；所有聚合幂等（覆盖而非累加）

## Provider Discovery（v1.1，运维观察）

```text
Provider Capability
        ↓
Discovery Catalog
        ↓
Semantic Diff
        ↓
GitHub Report
        ↓
Human Review
        ↓
Node / Model Registry Config
```

`scripts/provider-discovery/` 是一个**只读观察**子系统：维护 Provider 的协议能力、Surface 与 Base URL 信息，并与 Runtime Node 配置做一致性校验。详见 [operations/provider-discovery.md](../operations/provider-discovery.md)。

边界约束：

- Discovery **从不**修改 Runtime Node、Model Registry、Worker Variables 或 Worker Secrets
- Discovery **从不**主动发送模型生成请求（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`）
- Discovery **从不**进入 Runtime 请求热路径
- Discovery 故障 **不会**导致 Runtime 请求链路失效

## 公开 Model Status（只读投影）

公开首页的"模型状态"是**跨隔离区**的投影，而不是当前 isolate 的 Runtime Availability：

```text
Runtime Availability (当前 isolate)
        ↓
+  持久化 D1 近期成功证据
        ↓
Public Model Status (跨 isolate 投影)
        ↓
公开首页 HTML
```

`src/runtime/model-status.js` 是一个**只读**投影层，**永不**反向影响 Scheduler / Reliability / Transport / Request / Hedge / Failover / Cooldown。它仅在 `dashboardResponse` 渲染时被调用，请求热路径完全不引用它。详见 [operations/public-model-status.md](../operations/public-model-status.md)。

## 协议边界

网关原生支持以下端点：

| 客户端路径 | 协议 | 上游路径 |
|---|---|---|
| `/v1/chat/completions` | OpenAI Chat | 上游 `/v1/chat/completions` |
| `/v1/responses` | OpenAI Responses | 上游 `/v1/responses` |
| `/v1/messages` | Anthropic Messages | 上游 `/v1/messages` |

每个客户端 surface 映射到 (protocol, surface) 对，转发到同一对的原生上游 endpoint。跨协议 fallback 是可选的：仅 `PROTOCOL_FALLBACKS` 显式声明的转换（当前只支持 Anthropic Messages → OpenAI Chat Completions）才会在原生池耗尽后尝试。
