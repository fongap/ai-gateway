# 可靠性模型

## 概述

Tier 1 使用 `tier1-state.ts`；Tier 2/3 使用 `node-state.ts`。两个状态系统有意分离。所有短期运行时状态均为 isolate-local best-effort，随 isolate 重启丢失。

## Tier 1 可靠性

### Smooth RPM Admission

Tier 1 的 hard `limits.rpm` 使用 isolate-local Token Bucket 平滑准入，不再使用日历分钟 fixed bucket。补充速率为 `rpm / 60s`，burst capacity 最多 2 个 token（即最多允许 1 个额外瞬时请求）；低于 2 RPM 时 capacity 自动降为 1。`rpmMode=soft` 行为不变，也不新增配置项。

429 仍沿用既有 `Retry-After` / model-scoped exponential backoff / rotate 语义。新增的唯一联动是 scoped recovery gate：cooldown 后首个真实准入成功后，同 scope 在 1 个 RPM interval 内不再立即二次准入；model-scoped 429 不影响 sibling models，显式 account-scoped 429 才作用于整个 account。共享 Token Bucket 不被推入未来。

### Account Scope

包含 in-flight count、account disable/cooldown 和显式 quota 状态。

### Model Scope

包含 disable/cooldown、`normal → cooldown → half_open → disabled` 恢复、consecutive failures/outliers/rate limits 和被动 TTFT。

- 401/403 禁用 account
- `model_not_found` 仅禁用该 account/model pair
- 模糊 429 默认 model scope，记录 `scope_ambiguous_429`
- `Retry-After` 被尊重；缺失 header 使用 model-scoped exponential backoff
- 普通 timeout/5xx 失败使用三重失败滞后
- 过期 cooldown 在真实请求时变为 half-open，需要两次成功返回 normal，half-open 失败立即重入 cooldown
- 没有主动恢复 probe

### Streaming Slot

Streaming 在 headers 后、首个 token 后和完整流期间保持 Tier 1 in-flight slot。完成、取消、reader error 或 idle timeout 通过幂等 token 释放，且仅一次。

### TTFT（Time to First Event）

被动 per-`(account, model)` TTFT 从上游 attempt dispatch 开始，到首个有意义的模型输出结束。状态起始为 `ttftEwma=null, sampleCount=0`；首次观测直接赋值，后续使用 EWMA alpha `0.25`。一个值超过 `4× EWMA` 被钳位，第二个连续高值被原始接受以使真实退化可见。

## Tier 2/3 可靠性

保留节点本地 health、latency、active-request slots、cooldown 和 circuit 状态机。

## 错误分类

Error classification (`src/reliability/classify.ts`) 是**单一事实源**——所有消费方 (dispatch / success / hedge / observability / errors) 都通过 `classify*` helper 或 `KIND` 常量引用，没有开放字符串字面量。

**FailureKind 词汇 (v1.3.0 完整 16 个值)**:

| KIND | 触发条件 | 动作 | Cooldown | 计入 circuit |
|---|---|---|---|---|
| `rate_limit` | 429 + Retry-After | rotate | Retry-After clamped [1s, 600s] | 否 |
| `rate_limit_global` | 预派发被分布式 rate limiter 拒绝 | rotate | 0 | 否 |
| `auth` | 401/403 | rotate | AUTH_FAIL_COOLDOWN_MS | 否 |
| `client` | 400/413/415/422 + 其他 4xx | stop | 0 | 否 |
| `model_missing` | 404 + body 是模型形状 | rotate | 5s (model-scoped) | 否 |
| `endpoint_not_found` | 404 + body 不是模型形状 | rotate | 5s | 否 |
| `server` | 5xx / 408/425/409 | rotate | 0 | **是** |
| `network` | 非 headers-timeout 的网络错 | rotate | 0 | **是** |
| `headers_timeout` | HTTP 响应头超时 | rotate | 0 | **是** |
| `first_event_timeout` | 收到 headers 但首事件超时 | rotate | 0 | **是** |
| `stream_interrupted` | 流中途截断 / 缺完成标记 | rotate | 60s | **是** |
| `client_abort` | 客户端中断 | neutral | 0 | 否 |
| `invalid_base_url` | 预派发: base_url 不可解析 | rotate | 0 | 否 |
| `upstream_200_non_json_body` | 200 + body 非 JSON | neutral | 0 | 否 |
| `cancelled_after_peer_commit` | Hedge loser 被 peer commit 取消 | neutral | 0 | 否 |
| `unknown` | Hedge catch-all | rotate | 0 | 否 |

Tier 1 (`classifyTier1Failure` in `tier1-state.ts`) 将这些 kind 映射到 (account, model) 状态机的具体动作(scope = account / model, action = disable / cooldown, backoff = rate_limit / server / timeout)。

相关 helper：
- `classifyPreDispatchRateLimit()` — 预派发被分布式 rate limiter 拒绝
- `classifyPreDispatchInvalidBaseUrl()` — base_url 不可解析
- `classifyStreamInterrupted()` — 流截断
- `classifyNonJsonBody()` — 200 + 非 JSON body
- `classifyHedgeRaceLoss()` — hedge 竞争失败
- `classifyHedgeUnknown()` — hedge catch-all

**类型安全** (FailureKind 全类型闭集):
- `AttemptOutcome.kind: FailureKind`
- `LoopState.failureKinds: Partial<Record<FailureKind, number>>`
- `terminalStatus` 使用 `KIND.*` 常量比较

**契约 (C19–C22)**:
- C19: `KIND` 是闭合的 failure-kind 词汇 (16 个值, 无遗漏无多余)
- C20: `src/` 中除 `classify.ts` 外没有任何 `kind: '<literal>'` 开放字面量
- C21: `AttemptOutcome.kind` 类型为 `FailureKind` (不是 `string`)
- C22: `src/types/request.ts` 从 `src/reliability/classify.ts` 导入 `FailureKind`

## Circuit Breaker

连续失败状态机（CLOSED → OPEN after 3 counted failures → HALF_OPEN after open period → single probe → CLOSED on success / OPEN on failure）。仅 transient failures 计数；任何 success 重置计数器并关闭 circuit。计数器有时间边界，使相隔多天的事件不能链式触发 trip。

- HALF_OPEN 允许恰好一个 probe，无论配置的 concurrency
- Probe success 关闭 circuit
- Probe failure 重新打开，带 fresh open period

## Stream Truncation

Stream 中途截断计为 transient failure（驱动 3-consecutive circuit counter），并在 `stream` 键下额外施加 health penalty（与 network failure 同级），因此持续截断的节点在 circuit 打开前就在候选排序中退化。

## Concurrency Slots

Concurrency slots 在 `acquireSlot` 中声明（与 eligibility checks 原子操作），在 success/failure/neutral outcome recording 中恰好释放一次。

## 首事件超时（First Event Guard）

`guard.js` 实现单一 first-event guard：消费上游 SSE 流直到提交事件——具有 per-protocol 的"首个真实输出"判定——或 timeout、abort、malformed data 或 JSON error envelope。两种协议族有意不共享同一判定：

- **OpenAI Chat**：仅在非空 content、reasoning 或 tool-call 输出时提交
- **OpenAI Responses**：仅在 `response.*.delta` 事件时提交——生命周期事件不是提交点
- **Anthropic Messages**：仅在 native content deltas（`text_delta` / `thinking_delta` / `input_json_delta`）时提交——`message_start`、block start/stop、`ping` 和 `message_delta` 不提交

提交前可 failover；提交后透明 failover 被禁止——中途死亡投递已缓冲的字节并干净关闭。

## Failure Classification

终端错误分类使用聚合的 failure kinds。耗尽响应从 dominant kind 派生终端状态——`rate_limit` → 429，`headers_timeout`/`first_event_timeout` → 504，否则 502。

## Neutral Outcomes

以下情况记为 neutral（不计失败、不进熔断、无 cooldown）：
- Client abort
- Hedge loser 被 peer commit 取消
- 429/401/403/404 在 half-open probe 期间

## Isolate-Local State

所有短期运行时状态（Tier 1 passive TTFT/in-flight/cooldown/half-open state，Tier 2/3 circuit/health/concurrency/RPM）均为 **isolate-local** best-effort；随 isolate 重启丢失，不是全局或 provider-wide quota。`limits.concurrency`/`limits.rpm` 是 isolate-local shaping，不是全局硬限制。

## 分布式 Rate Limiter

当存在 `QUOTA_RATE_LIMITER` Rate Limiting binding 时，hard-RPM dispatch 额外通过分布式（per-Cloudflare-location）fixed-window 检查。该检查是近似的、per-location 的，不是严格的全局/account quota。Concurrency 无法在没有 Durable Objects 的情况下全局协调——`limits.concurrency` 按设计保持 isolate-local。

## Adaptive Budget

`POLICIES_CONFIG` 中的 `budget_split` 控制没有显式 `tier_attempts` 的可调度 Tier 如何获得 attempt budget：

- **`'even'`（默认）**：保持 Tier 优先级。没有显式 cap 时沿用默认 surplus 分配；存在显式 cap 时，只在未显式且 dispatchable 的 Tier 中分配 `remaining`，surplus 给第一个可调 Tier。
- **`'weighted'`**：先锁定显式 `tier_attempts`，再将 `remaining` 按未显式配置且 dispatchable 的 Tier 的 live 节点数比例分配。
- **未设置 (`null`)**：等同于 `'even'`。

显式 `tier_attempts` 是固定 cap，不会被 `even`、`weighted`、rounding 或 remainder 修改。显式值总和超过 `max_attempts` 时配置直接 `invalid`。Tier 1 不存在独立 attempt 上限；Tier 1、Tier 2、Tier 3 都由 `max_attempts`、`tier_attempts`、实时可调度性和整请求 failover budget 共同约束。

**预算算法** (`computeTierCaps` in `src/request/tier-loop.ts`):
1. 计算当前 `dispatchable` Tier。
2. 锁定所有显式 `tier_attempts`，计算 `explicitTotal`。
3. 配置解析保证 `explicitTotal <= max_attempts`。
4. 计算 `remaining = max_attempts - explicitTotal`。
5. `remaining` 只分配给未显式设置且当前 dispatchable 的 Tier。
6. `even` 保持 Tier 优先级；`weighted` 按 `liveCount(tier) / totalLive` 分配可调预算。
7. weighted 的 `Math.floor` remainder 只能补给未显式配置的 Tier；显式 cap 不参与补差。
8. `max_attempts` 始终是整请求 logical attempt 的总硬上限。

**示例**:
```
max_attempts=6, Tier 1 不可达, Tier 2 有 1 节点, Tier 3 有 4 节点:
  "even":     Tier 2=5, Tier 3=1
  "weighted": Tier 2=1, Tier 3=5

max_attempts=6, tier_attempts.tier2=3, Tier 3 未显式配置且可调度:
  "even":     Tier 2=3, Tier 3=3
  "weighted": Tier 2=3, Tier 3=3
```

`architecture-contract-test.mjs` 验证默认与 weighted 分配；`config-matrix-test.mjs` 验证显式 cap、超限配置和 Tier 1 统一预算契约。

## Unified Scheduler Return

`pickCandidate` (Tier 2/3) 与 `pickTier1Candidate` (Tier 1) 都返回 `PickedCandidate | null`：

| 情况 | 返回值 |
| --- | --- |
| 成功获取 slot | `{ node: RuntimeNode }` |
| Slot 被并发请求抢走 (race lost) | `{ raceLost: true }` |
| 无合格候选 | `null` |

`PickedCandidate` (`src/types/scheduler.ts`) 是两个 picker 的共同返回类型。`pickForTier` 直接处理这一统一结果，使 race loss 与“无合格候选”保持可区分。
