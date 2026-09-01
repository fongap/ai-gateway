# 系统架构总览

## 设计目标

每个功能都必须回答：是否提高了上游配额利用率？是否提高了可靠性？是否降低了 Worker CPU 开销？是否更可预测？否则不在范围内。

## 概览

网关原生支持两种协议族——OpenAI 和 Anthropic。任何提供 OpenAI-compatible 或 Anthropic-compatible API 的服务均可作为节点接入。网关不做跨协议转换，不做跨协议路由，也不做跨协议 fallback。

```text
Client (OpenAI / Anthropic SDK)
   ↓  auth (timing-safe), route allowlist, body limits
Request pipeline (src/request/handler.js)
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
- 不做 OpenAI ↔ Anthropic 跨协议转换，不做跨协议 fallback
- `limits.rpm` 默认 hard，单 Worker isolate 内不主动越配额
- 整请求 failover budget，超时即停
- 所有短期运行时状态（Tier 1 TTFT/inFlight/cooldown，Tier 2/3 health/circuit/concurrency/RPM）均为 isolate-local best-effort，随 isolate 重启丢失
- D1 仅用于可选的 token-usage 聚合，不在 AI 请求热路径上

## 协议边界

网关原生支持以下端点：

| 客户端路径 | 协议 | 上游路径 |
|---|---|---|
| `/v1/chat/completions` | OpenAI Chat | 上游 `/v1/chat/completions` |
| `/v1/responses` | OpenAI Responses | 上游 `/v1/responses` |
| `/v1/messages` | Anthropic Messages | 上游 `/v1/messages` |

每个客户端 surface 映射到 (protocol, surface) 对，转发到同一对的原生上游 endpoint——不存在跨协议或跨 surface 的转换。
