# 调度模型

## 调度器概述

调度器 (`src/scheduler/scheduler.js`) 实现 protocol + surface + model 三重过滤（`supportsRequest`）。协议、surface、model 和 tier 始终是硬性门控。OpenAI 请求永远不会到达 Anthropic 节点，Tier 2/3 永远不会进入 Tier 1 调度器。

## Model Registry

Model Registry (`src/config/registry.js`) 是逻辑模型的策略和能力（`capabilities.tools/reasoning/vision/stream`、`reasoning_efforts`）的唯一事实来源，由 `MODELS_CONFIG` 驱动。`/v1/models` 枚举至少一个节点服务的注册模型，报告 `api_backends`（provider 标签，或 `apiBackend: "mixed"`）和节点 `surfaces` 的并集——不从 provider 标签推导能力。

## Node 与 Tier

节点配置通过 `src/config/nodes.js` 合并 `TIER{1,2,3}_NODES_CONFIG_01..99` Worker 文本变量与 `NODE_SECRETS_01..99` Worker Secrets 生成 Runtime Node：

- Tier 仅从变量前缀派生；节点 JSON 不能声明它
- Credential lookup 在此且仅在此发生；下游模块只看到 `runtimeNode.credential`
- `protocol`（`openai` | `anthropic`）决定 wire format、上游 endpoint、认证头和协议头
- `surfaces` 声明节点真正支持的接口
- `provider` 为自由标签，仅用于诊断，不影响 transport
- Tier 顺序固定：tier-1 → tier-2 → tier-3

## Tier 1: Eligibility → Affinity → P2C

Tier 1 有一条刻意精简的决策路径：

```text
Eligibility → soft session affinity → sample two eligible accounts
→ compare simple scores → real upstream request → passive TTFT/failure update
→ retry within Tier 1 → existing Tier Router → Tier 2 → Tier 3
```

### Eligibility

网络无关，要求节点支持协议/surface/model、已启用、不在 account/model cooldown 内、有 isolate-local concurrency 和 hard-RPM 容量、且没有已知 exhausted quota。Cooldown 是严格的：没有 blocked account 的 fail-open 选择。

### Affinity

客户端可通过 `x-session-id`（8–128 字符）启用会话亲和。亲和存储在必需的 `TIER1_AFFINITY` Cloudflare KV binding 中，30 分钟 TTL。原始 session ID 在成为 KV key 前经过 SHA-256 哈希。KV 每个客户端请求读取一次，仅在首次 Tier 1 成功或成功 affinity 逃逸后写入；Tier 2/3 fallback 永不改变它。Affinity 是 `0.85` 分数乘数，不是硬绑定。

### P2C（Power of Two Choices）

采样两个不同的 eligible account，选择得分较低的。无全池性能排序。得分仅包含：被动 per-`(account, model)` TTFT、capacity-relative 当前负载、recovery/quota 因子、soft affinity 因子和小 UNKNOWN 探索因子。Tier 1 忽略静态 `priority`、旧 health score、LRU、节点级 latency/TTFT 和 probe freshness。因此不承诺每次请求都选到全局最快 account。

### 被动 TTFT

从上游 attempt dispatch 开始，到首个有意义的模型输出结束。OpenAI Chat 要求非空 content/reasoning/tool-call 输出；Responses 要求非空 supported output delta；Anthropic 要求非空 text/thinking/tool-input delta。状态起始为 `ttftEwma=null, sampleCount=0`；首次观测直接赋值，后续使用 EWMA alpha `0.25`。

## Tier 2 / Tier 3

Tier 2 和 Tier 3 继续使用旧版动态候选选择器和 `node-state.js`：priority、active requests、health band、LRU、latency preference、cooldown 和 circuit breaker。不受 Tier 1 TTFT 训练，不读写 Tier 1 affinity。

## Priority

`priority` 字段在共享节点 schema 中保留用于 Tier 2/3 兼容性。Tier 1 P2C 有意忽略它。较小的 priority 值 = 更高优先级。

## Eligible Candidate

候选节点需满足：支持请求的 protocol + surface + model，不在 cooldown 中，有可用 concurrency 和 RPM 容量，circuit 未 OPEN。

## Node Rotation

同一 tier 内轮换；移动到 tier N+1 仅在当前 tier 无 eligible candidate 或花完 per-tier budget 时发生。Tier 保持硬优先级。

## Tier Fallback

Tier 间 fallback 严格按优先级顺序。Budget 分配在当前可调度的 tier 上，`tier_attempts` 可覆盖。全局 `max_attempts` 和 `FAILOVER_BUDGET_MS` 仍限制整个请求。

## Attempt Budget

每个请求有 per-tier attempt budget。默认 `max_attempts` 拆分为：每个实际持有 schedulable candidate 的 tier 至少获得一次 attempt，剩余分配给最高 tier。`POLICIES_CONFIG` 的 `tier_attempts`（`{"tier1": N, "tier2": N, "tier3": N}`，`0` 禁用 tier）可覆盖。

Tier 1 额外硬限制为最多 3 个 logical attempt，且在重试前检查共享 wall-clock deadline。

## Failover Budget

整个请求由 `FAILOVER_BUDGET_MS`（默认 60s）限制。时间从网关收到请求开始计算；每次新 attempt 检查剩余 budget。Budget 耗尽时停止轮换，返回 504 + attempt count。客户端 abort 是特权的；首事件后透明 failover 不安全。

## Hedge（Reactive per-try hedge）

当 logical attempt 在 `HEDGE_DELAY_MS`（默认 3s；`0` 禁用）内未提交时，启动 ONE twin attempt 对抗下一个最佳候选者。Twin 是同一 logical attempt 的额外执行者，不消耗 `max_attempts` 或 tier budget，继承 logical attempt 的绝对 deadline。

- 被赢家的 peer commit 取消的 loser 是 NEUTRAL——无 health penalty、无 cooldown、无 circuit failure
- Twin 自身真实 timeout/5xx 计为真实失败
- 受 `MAX_HEDGES_PER_REQUEST`（默认 1）和硬 dispatch 上限 `max_attempts + max_hedges_per_request` 约束

## RPM

`limits.rpm` 默认 **hard**——exhausted 节点被跳过（不作为 last-resort fallback），在单 Worker isolate 内网关永远不超过配置配额；完全 exhaustion 返回 503 + Retry-After。`"rpm_mode":"soft"` 恢复 best-effort 行为。

当存在 `QUOTA_RATE_LIMITER` Rate Limiting binding 时，hard-RPM dispatch 额外通过分布式（per-Cloudflare-location）fixed-window 检查。该检查是近似的、per-location 的，不是严格的全局/account quota。

## Concurrency

`limits.concurrency` 是 isolate-local shaping，不是全局硬限制或 provider-wide accurate quota。没有 Durable Objects 的跨 PoP 配额。
