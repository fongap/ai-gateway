# Changelog

## 1.3.4 - 2026-09-12

### Changed

- **Adaptive 429 Cooldown**: Tier 1 的无显式恢复信号 429 改为受控阶梯 `15s → 30s → 1m → 2m → 5m → 15m → 30m → 60m`，连续恢复探测仍为 429 才进入下一档；达到 60 分钟后保持 60 分钟低频探测，真实恢复成功后立即清零。
- **Provider + Key Scope**: 自适应 429 状态严格绑定 `(provider, key-slot)`；同 Provider 的不同 Key、不同 Provider 下相同 Key 标识互不影响，不新增任何 Provider 特判，也不按模型共享 cooldown。Runtime node id 仅作为非密钥的 Key 槽位标识，原始 credential 不进入状态或日志。
- **Burst-Safe Escalation**: 同一 cooldown 尚未结束时，由已在途请求返回的额外 429 不提升阶梯，避免一次并发突发直接把 Key 推入 1 小时冷却；cooldown 到期后仅由受控真实恢复请求决定是否升级或恢复。
- **Retry-After Floor**: 上游 `Retry-After` 继续生效，并作为最低等待时间；它可以延长本地 cooldown，但不能把已经学到的自适应阶梯缩短。

## 1.3.3 - 2026-09-12

### Changed

- **Retryable Model-Family Exhaustion**: 完整模型家族在 bounded fallback 后若全部仅出现可恢复故障（429、5xx、network、headers timeout、first-event timeout、stream interrupted），客户端统一收到可重试 `503`，避免 OpenCode 等 Coding 客户端停在人工“继续”。
- **Family-Aware Retry-After**: 当家族耗尽由 429 主导时，`Retry-After` 取兼容 sibling models 中最早的真实恢复时间；不再机械使用 1 秒重试，避免对仍在 cooldown 的 Key/Provider 反复撞击。

### Fixed

- **429 Cause Preservation**: 对客户端包装为 `503` 只改变外部重试语义；内部 `failure_kinds.rate_limit`、单 Key cooldown、provider-model 429 heat、日志和节点状态仍保留真实 429，不掩盖 Key/额度问题。
- **Transient Guard Tightening**: model-family 只有在每一种已观察失败都属于明确的可恢复故障时才允许返回 retryable `503`；鉴权、客户端参数、model missing、endpoint/config 错误以及未知失败继续按原错误终止。

## 1.3.2 - 2026-09-11

### Added

- **Bounded Logical-Model Family Fallback**: 新增模型家族级最终兜底，不改现有 Node 调度器。`Code-Max ↔ Code-Pro → Code-Ultra`、`Max ↔ Pro → Ultra`；`Air → Pro → Max → Ultra` 仅允许单向上浮。兼容家族最多评估两轮，使前一模型在尝试 sibling pool 期间恢复后可被重新检查一次，同时禁止无限循环。
- **Tier 1 Provider-Model 429 Heat**: 当同一 `(provider, upstream model)` 在 90 秒窗口内出现多个独立 Key 的 429 时，仅增加软排序惩罚：1–2 个 Key 中性，3 个为 `1.15`，4+ 为 `1.35`。不改变 eligibility、P2C、单 Key cooldown、TTFT、Affinity、Hedge 或 Tier 2/3。

### Changed

- **Tier 1 429 Availability-First Recovery**: 无显式 `Retry-After` 时自动 cooldown 收敛为约 `30s → 45s → 60s`；模糊 429 默认按 account/key scope 处理，cooldown 后使用受控真实请求恢复，不再通过更长的本地抑制牺牲整个逻辑模型的可用性。
- **Shared Budget Across Model Fallback**: model-family fallback 与 native retry、protocol fallback 共用原请求的 `max_attempts`、dispatch ceiling、hedge ceiling 与 `FAILOVER_BUDGET_MS`；切换逻辑模型不会获得新的重试预算。客户端看到的 requested model 保持不变，内部仅切换 effective logical model。
- **PR Correctness Gate**: scheduler stability、integration、compatibility、reliability / fault-injection 等确定性套件进入 required PR gate，避免正确性问题在 merge 后才首次暴露。

### Fixed

- **Daily Token Totals**: 最近 7 个完整 UTC+8 日桶由保留的 hourly 数据重建，避免跨午夜后旧 daily snapshot 使前一天 Token 总量回退。
- **Model-Missing Isolation**: model-shaped 404 仍是模型映射/能力事实，仅隔离对应模型映射；不会因为新增 model-family fallback 而被静默改投到另一个逻辑模型。

## 1.3.1 - 2026-09-09

### Changed

- **Tier 1 Smooth RPM Admission**: hard `limits.rpm` 从 fixed-minute bucket 改为 isolate-local Token Bucket，连续按 `rpm / 60s` 补充，burst capacity 最多 2 个 token；消除分钟边界双倍突刺。`rpmMode=soft`、Tier 2/3、分布式 Rate Limiting binding 均不变。
- **429 Resume Shaping**: 保留现有 `Retry-After`、model-scoped exponential backoff、jitter 与 rotate；cooldown 后首个真实准入成功后，同 scope 增加 1 个 RPM interval 的 recovery gate。model-scoped 429 不影响 sibling models；仅显式 account-scoped 429 才作用于整个 account。
- **Scope**: 不改 scheduler 主逻辑、tier-loop、request pipeline、protocol、transport、D1、deploy workflow、Access Key 或 Tier 2/3。

## 1.3.0 - 2026-09-09

### Added

- **Cross-Protocol Fallback (v1.3.0)**: OpenAI Chat ↔ Anthropic Messages 双向 fallback（默认 ON，可 `disable` 关闭或显式 JSON 覆盖）。OpenAI Responses 为 Native Only。跨协议 fallback 与 native retry 共享 `max_attempts` / `FAILOVER_BUDGET_MS` budget，不获取新 attempt slot。错误 envelope 保证客户端始终收到自己协议形状的错误。
- **Production Identity**: `/version` 新增 `build` 字段（commit SHA，7-40 hex），与 `version`（semver）分离。Deploy job 注入 `GITHUB_SHA`，bridge 白名单包含 `GITHUB_SHA`。
- **Adaptive Budget**: `POLICIES_CONFIG.budget_split` 控制 per-tier attempt surplus 分配（`even` / `weighted`）。`tier_attempts` 显式 override 不受 `budget_split` 影响。
- **协议矩阵测试** (`scripts/protocol-matrix-test.mjs`)、**转换测试** (`scripts/conversion-test.mjs`)、**架构契约测试** (`scripts/architecture-contract-test.mjs`)、**Deployment Workflow Contract Test** (`scripts/deployment-workflow-contract-test.mjs`)、**Reliability Core Contract** (`scripts/reliability-core-contract-test.mjs`)。
- **FailureKind 词汇闭合到 16 值**: `RATE_LIMIT_GLOBAL` / `INVALID_BASE_URL` / `STREAM_INTERRUPTED` / `NON_JSON_BODY` / `CANCELLED_AFTER_PEER_COMMIT` / `UNKNOWN`。`KIND` 为 `export const`，全 codebase 单一事实源。
- **`pickCandidate` 返回 `PickedCandidate`**（含 `raceLost` / `releaseToken`），与 `pickTier1Candidate` 一致，race-loss 可见。
- **Scheduler / Reliability / Transport / Request / Stream 核心未做结构性修改**。

### Changed

- **Deploy Correctness**: 三个 `workflow_run` job 全部显式 `checkout: ref: ${{ github.event.workflow_run.head_sha }}`，消除 SHA 漂移。手动 deploy 统一为 `npm run validate:deploy` 单一入口。Deployment summary / rollback 记录同一 `DEPLOYED_SHA`。
- **Deployment Workflow Contract Test 扩展至 ×18**: 覆盖 SHA pinning、DEPLOYED_SHA 注入、rollback 记录同一 SHA、npm 引用验证等。
- **Typed JS**: strict typecheck 范围扩展至 `src/request/**`、`src/config/**`、`src/reliability/**`、`src/scheduler/**` 并保持清零。核心类型提升为 ambient `type` 声明。
- **Dashboard 热力图色阶对比度增强**: 新增 `--heat-1..4` 专属色阶。

### Removed

- **Legacy 协议转换代码**: `src/protocol/convert.js`、`src/stream/transform.js`、`src/protocol/responses/{request,stream,response,reasoning,tools}.js`、`src/config/profiles.js`。原生透传替代转换。
- **`src/protocol/responses` 双向模拟**: Responses 原生透传 `src/protocol/responses/native-stream.js` + `src/stream/anthropic-native.js`。

## 1.2.6 - 2026-09-06

> 发布安全、事实一致性与架构收口版本。本阶段不含功能扩展；目标是将既有架构原则固化为代码、CI 与测试契约。
>
> 版本序列说明：`v1.2.7` 为 legacy/v1.2.7 分支维护版本，已真实发布；当前 mainline 从 v1.2.6 基线继续演进并收口为 **v1.3.0**。
>
> 1.2.6 及更早完整历史保持在 Git 仓库既有 Changelog 记录中；本节以下内容未因 1.3.4 修改而改变。
