# 可靠性模型

## 概述

Tier 1 使用 `tier1-state.js`；Tier 2/3 继续使用 `node-state.js`。两个状态系统有意分离。所有短期运行时状态均为 isolate-local best-effort，随 isolate 重启丢失。

## Tier 1 可靠性

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

保留旧版节点本地 health、latency、active-request slots、cooldown 和 circuit 状态机。

## 错误分类

Error classification (`classify.js`) 共享。分类表：

| 结果 | 动作 | Cooldown | 计入 circuit |
|---|---|---|---|
| 429 (+Retry-After) | rotate | Retry-After clamped [1s, 600s] | 否 |
| 401/403 | rotate | AUTH_FAIL_COOLDOWN_MS | 否 |
| 400/413/415/422 | stop | none | 否 |
| 404 | rotate | 5s | 否 |
| 5xx, network, headers/first-event timeout | rotate | none | **是** |
| client abort, hedge-loser cancellation | neutral | none | 否 |

Tier 1 将这些 kind 映射到上述 account/model 状态。

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

终端错误分类现在使用聚合的 failure kinds。耗尽响应从 dominant kind 派生终端状态——`rate_limit` → 429，`headers_timeout`/`first_event_timeout` → 504，否则 502——而不是从最后一次 attempt 的结果。

## Neutral Outcomes

以下情况记为 neutral（不计失败、不进熔断、无 cooldown）：
- Client abort
- Hedge loser 被 peer commit 取消
- 429/401/403/404 在 half-open probe 期间

## Isolate-Local State

所有短期运行时状态（Tier 1 passive TTFT/in-flight/cooldown/half-open state，Tier 2/3 circuit/health/concurrency/RPM）均为 **isolate-local** best-effort；随 isolate 重启丢失，不是全局或 provider-wide quota。`limits.concurrency`/`limits.rpm` 是 isolate-local shaping，不是全局硬限制。

## 分布式 Rate Limiter

当存在 `QUOTA_RATE_LIMITER` Rate Limiting binding 时，hard-RPM dispatch 额外通过分布式（per-Cloudflare-location）fixed-window 检查。该检查是近似的、per-location 的，不是严格的全局/account quota。Concurrency 无法在没有 Durable Objects 的情况下全局协调——`limits.concurrency` 按设计保持 isolate-local。
