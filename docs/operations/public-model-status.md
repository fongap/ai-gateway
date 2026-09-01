# 公开 Model Status

> 公开首页展示的"模型状态"是 Public Model Status，不是 Runtime Availability。
>
> 两者**相关但不能等同**：
>
> - **Runtime Availability**（`src/runtime/availability.js`）描述**当前隔离区**的调度事实：Tier 1 passive TTFT 是否有样本、节点是否 cooldown/disabled/circuit-open。该信号喂给 P2C / cooldown / hedge / failover。
> - **Public Model Status**（`src/runtime/model-status.js`）描述**跨隔离区、跨重启、跨 PoP** 的近期服务状态，用 D1 已有的 per-model 成功计数作为"近期是否成功"证据。专门服务公开首页。

方向约束（**不可逆**）：

```text
Runtime / Observability
        ↓
Public Model Status
        ↓
公开首页 HTML
```

Public Model Status **永不**反向影响 Scheduler / Reliability / Transport / Request / Protocol / Hedge / Failover / Cooldown。

## 为什么需要这个分层

Cloudflare Worker 是 isolate-local 的。一个冷启动、新建或被踢出内存的 isolate 没有任何 Tier 1 passive TTFT 样本。旧实现 `getRuntimeAvailability(node, model)` 对 Tier 1 在没有样本的情况下会返回 `unobserved`，于是公开首页出现"所有模型全部未观测"的现象 —— 但 D1 明明有过去 24 小时的成功记录。

新实现将这个错误修复为一个独立的 read-only 投影：

- 用 runtime availability 作为**一个输入**（不是唯一输入）
- 用 D1 持久化的近期成功记录作为**跨隔离区证据**
- 永不捏造证据、永不将所有模型标记为 `unavailable`

## 四态语义

| 状态 | 含义 | 触发条件 |
|---|---|---|
| `available` 可用 | 存在可信的近期可用路径 | 至少一个候选 `available`，或 `unobserved` + D1 近期成功 |
| `degraded` 波动 | 近期有成功，但当前所有候选都不可用 | 所有候选 `unavailable` 且 D1 近期成功 |
| `unobserved` 未观测 | 配置存在但没有跨隔离区证据 | 所有候选 `unobserved`/`unavailable` 且 D1 无近期成功 |
| `unavailable` 不可用 | 无任何候选节点服务该模型，或所有候选都明确宕机且无近期证据 | `serving.length === 0`，或所有候选 `unavailable` 且 D1 无近期成功 |

四态与现有 UI 文案 / 颜色 / a11y 标记保持一致 —— 见 `src/dashboard/pages.js` 的 `STATE_LABEL` 和 `STYLES`。

## D1 证据来源

**完全复用**已有的 `token_usage_model_hourly` per-model 小时聚合表。新增的唯一函数是 `queryRecentModelEvidence(env, windowMs, now)`，返回 `Set<modelName>`，仅包含**最近窗口内** `requests > 0` 的模型。

- `persistTokenUsage()` 仅在请求**成功完成**（`onUsage` 回调，包括 interrupted-with-usage）时被调用，因此 `requests > 0` 就是"近期真实完成过至少一个请求"。
- 不引入新的持久化字段，不引入第二个统计系统。
- 窗口默认 **24 小时**（`MODEL_STATUS_RECENT_WINDOW_MS`），集中定义在 `src/runtime/model-status.js`，与 D1 既有的小时粒度对齐。

## D1 故障降级

`queryRecentModelEvidence` 是 fail-open 的：

| 情况 | 行为 |
|---|---|
| 无 `TOKEN_STATS_DB` 绑定 | 返回 `new Set()`，首页继续 200 |
| D1 读取失败 | 捕获异常，返回 `new Set()`，首页继续 200 |
| 查询超时 | 同上（与 `queryTokenSummary` / `queryTokenDailySeries` 一致） |

空 Set 配合**全新 isolate**（无 runtime 状态）→ 全部模型 `unobserved`，**绝不会是** `unavailable`。**永远不会**因为 D1 故障而把所有模型标成不可用，也永远不会因为 D1 故障而把所有模型标成可用。

## 性能

`queryRecentModelEvidence` 是单条 `SELECT model FROM token_usage_model_hourly WHERE hour >= ? AND requests > 0 GROUP BY model` 查询 —— **一次** 跨所有模型，与节点 / 模型数量解耦。查询结果通过现有 `getCachedDashboardStats` 缓存（45s TTL + in-flight coalescing）被所有 model-status 调用共享，因此**一次**首页渲染只会触发**一次** D1 读取。

## 与 Runtime 的边界

- 公开首页只读 model-status 输出
- 调度器只读 `getRuntimeAvailability` 输出
- 两层共享同一个 Tier 1 状态机但**仅在读路径上**共享 —— model-status 从不调用 `recordTier1*` / `applyTier1Outcome` / `claimTier1Slot`
- model-status 不在调度热路径上：它仅在 `dashboardResponse` 中被调用，请求热路径完全不引用它
- 公开 model-status 的失败**不会**导致 Runtime 请求链路失效

## 安全

Public Model Status 的输出是 `[{ id, status }]`。**绝不**携带：

- 节点 ID、provider、tier、protocol、surface
- base URL、credential、Authorization
- cooldown 原因、failure 状态、TTFT 数值
- 任何内部诊断字符串

测试 (`scripts/model-status-test.mjs`) 中通过 JSON 序列化扫描验证：输出中不出现 `mock`、`openai`、`tier-1`、节点 ID 等。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/runtime/model-status.js` | 新增：纯函数 `getPublicModelStatus`，集中常量 `MODEL_STATUS_RECENT_WINDOW_MS` |
| `src/observability/token-usage-store.mjs` | 新增：fail-open 查询 `queryRecentModelEvidence` |
| `src/dashboard/pages.js` | 接线：一次缓存读取驱动 model-status + usage card 两条路径 |
| `scripts/mock-d1-database.mjs` | 扩展 mock：识别 `requests > 0` 子句 |
| `scripts/model-status-test.mjs` | 新增：24 个单元测试 |
| `scripts/token-usage-test.mjs` | 更新：cache-coalesce 断言从 3 reads 调整为 4 reads（新查询）|
| `scripts/integration-test.mjs` | 更新：degraded 测试拆分为"有近期证据→degraded"和"无证据→unavailable"两个场景 |
| `package.json` | `test:required` 加入 `model-status-test.mjs` |

## 不影响的事

- Scheduler（Tier 1 P2C、passive TTFT、session affinity）
- Reliability（cooldown、half-open、circuit breaker、failover budget）
- Transport（路径、头、流式判定）
- Request（handler、route、error）
- Protocol fallback（Conversion Fallback / Native First）
- Hedge、retry、Native First
- D1 schema（未新增表、未新增列）
- 任何新的外部依赖
- Required CI 跑时的网络依赖
