# Changelog

## Unreleased

### Fixed

- **P1 — 修复 `elapsedSinceStart` 引用错误对象导致 client-abort 延迟记录为 NaN。** `handleSuccess` 中误读 `s.attemptStartMs`(undefined)而非 `c.attemptStartMs`,两条 client-abort 路径传给 `recordOutcome` 的延迟为 NaN(被 `latency_ms` 判定静默丢弃)。改为正确引用。
- **修复:hedge loser 在 first-event 阶段被取消时可能被误记为真实失败。** 此前仅当 guard 错误码为 ABORTED 才走 neutral 路径;twin 赢家提交后 abort 导致的 body reader 异常(无 ABORTED 码)会落到 first-event 失败,降低节点健康分。现在先判 client abort,再判 `hedgeAbort` 已中止(与错误码无关)即按 neutral `cancelled_after_peer_commit` 处理;twin 自身真实 timeout / 5xx 仍正常计入。
- **修复:成功 dispatch 从不入账。** 成功路径此前从不递增 attempt 计数(成功即返回,旧语义下不可见);拆分计数器后,成功 dispatch 在 `attemptNode` 中恰好入账一次 `dispatches`(twin 不入账 `logicalAttempts`),保证日志与统计中的序号连续。
- (本条已被下方"Changed"的解耦语义取代,不再适用:旧"twin 启动要求 已完成 + 在飞 + twin <= max_attempts 且 tier 剩余预算 >= 2"的预算收费模型已整体移除,twin 改为不消耗逻辑 attempt / tier 预算,由 `MAX_HEDGES_PER_REQUEST` 与 `max_dispatches = max_attempts + max_hedges_per_request` 硬上限约束。)

### Changed

- **P0 — 调度器的延迟感知改为 TTFT(time-to-first-event)优先。** 修复前 `avgLatencyMs` 记录的是 `fetch()` 返回(收到 HTTP 响应头)的延迟,对 LLM 流式请求而言 headers 延迟 ≠ 首 Token 延迟:一个 headers 100ms 但首字 8s 的节点会战胜 headers 300ms 首字 1.5s 的节点。现在流式路径在 first-event guard 提交点测量 TTFT,`node-state` 新增 `avgTtftMs` EWMA(α=0.3,与延迟同参)并经 `snapshotNode` 暴露 `avg_ttft_ms`;`scheduler` 的 `betterThan` 在双方都测得 TTFT 时以 TTFT(1.5x 判定)决定胜者,未测得时回退 headers 延迟 EWMA,0 仍为中性(新节点照常获得流量)。非流式路径不产生 TTFT 测量,继续依赖 headers 延迟。
- **Hedge 与逻辑 attempt 彻底解耦(语义重定义)。** 此前 hedge twin 会消耗正式 `max_attempts` 配额与 tier 槽位:primary + twin 双失败会把剩余 fallback 次数从 4 直接压成 3。现在 `max_attempts` 表示**逻辑 attempt** 数——一个逻辑 attempt 由 primary + 最多 1 个 hedge twin 组成;twin 不再消耗 `max_attempts` 与 tier 预算,改由独立硬上限 `MAX_HEDGES_PER_REQUEST`(默认 1,环境变量可覆盖)约束,并新增总 dispatch 硬上限 `max_dispatches = max_attempts + max_hedges_per_request`(默认 5+1=6,不硬编码)。请求状态由单一 `totalAttempts` 拆分为三个独立计数器:`logicalAttempts` / `dispatches` / `hedges`;客户端错误的 `details` 中 `attempts` 继续表示逻辑 attempt 数,新增 `dispatches`(真实上游请求数)与 `hedges`(hedge twin 数)字段——只增不删,错误 envelope 与 OpenAI / Anthropic / Responses 兼容性不变。
- **primary 与 hedge 共用同一逻辑 attempt deadline。** 此前 twin 启动后会重新切分一份自己的预算切片(约再获得一份 48s);现在 twin 继承 primary 创建的绝对 `attemptDeadline`,按 `deadline - now` 计算剩余 header / first-event 超时——一个逻辑 attempt 可以有两个执行者,但只有一个时间预算。
- **超时分类改名:`timeout` → `headers_timeout`,`first_event` → `first_event_timeout`。** 内部 failure kind、`failure_kinds` 聚合与日志不再需要人工推断"是响应头超时还是首事件超时";`first_event_timeout` 记录携带 `status=200` 与独立的 `headers_ms` / `ttft_wait_ms` 计时。
- **`HEDGE_DELAY_MS` 默认 4000 → 6000。** 4s 对大模型 / 长上下文 / Coding Agent 略激进,10–15s 又会让救援过迟;仍允许环境变量覆盖。代码结构保留未来按 `avgHeaderLatency` / `avgTtftMs` 自适应计算的扩展空间,本次不引入。
- **dispatch 日志增强。** 每次 upstream dispatch(成功为 debug,失败为 info)输出一行:`request` / `logical_attempt=n/max` / `dispatch` / `node` / `tier` / `model=逻辑->上游` / `hedged` / `kind` / `status` / `headers_ms` / `ttft_wait_ms` / `latency_ms` / `counted`;hedge 生命周期分别输出 `hedge:`(触发,含 `deadline_remaining_ms`)、`hedge winner:`(含 `winner_ttft_ms`)、`hedge loser:`(`neutral=true`)、`hedge failed:`(双方 kind)。节点拓扑仍仅在 Worker 内部日志,客户端响应默认不暴露。

### Added

- **Hedge / attempt / dispatch 语义测试 ×13**(集成):`MAX_HEDGES_PER_REQUEST=0` 禁用 hedge;全失败时恰好 5 逻辑 attempt / 6 dispatch / 1 hedge;twin 赢时 primary neutral(不计失败、不进熔断、无 cooldown,覆盖 fetch 阶段与 first-event 阶段两条 loser 路径);primary 赢时挂起的 twin neutral;双失败只消耗 1 个逻辑 attempt 且下一 attempt 正常执行;twin 继承共享 deadline(约 300ms 启动、约 1000ms 终止,而非再拿一份独立 1s 预算);`headers_timeout`(status=0)与 `first_event_timeout`(status=200 + `ttft_wait_ms`)分类;client abort 为 neutral 不误记为超时;twin 自身 5xx 计真实失败;tier cap=1 仍允许 twin(反语义回归)。3 个旧语义 hedge 测试(twin 消耗 tier 槽位 / `max_attempts=2` 拒绝 twin / tier cap=1 禁 twin)按新语义重写。单元测试新增 timeout kind 改名与 hedge 默认值(6000ms / 1 次 / 覆盖与钳位)断言。
- **`MAX_HEDGES_PER_REQUEST` 运行时变量**加入 GitHub 部署桥白名单(`github-deployment-config.mjs`)与 `docs/CONFIGURATION.md` 运行时参数表;`HEDGE_DELAY_MS` 一并补入参数表。
- **Hedge / TTFT 边界集成测试 ×4**(此前 hedge 仅有"twin 赢"与"单候选不 hedge"两个用例):双失败仍按 tier cap 收敛 dispatch 数(`tier_attempts tier1=2` + 三节点,恰好 2 次而非 3 次);`max_attempts=2` 时在飞 primary 独占预算、不启动 twin;tier cap=1 无 twin 空间;TTFT 实测值(而非手写状态)驱动调度——headers 快但首字慢的节点让位于 headers 慢但首字快的节点。4 个用例在修复前的 `main` 上全部失败,具备回归判别力。(注:其中"双失败收 dispatch"与"max_attempts=2"、"tier cap=1"三条已按上方解耦语义重写,断言新语义。)

## 1.2.4 - 2026-08-29

### Fixed

- **P1 — CI 门禁：部署工作流在完整验证通过前不再执行迁移和发布。** `.github/workflows/deploy.yml` 现在在 `npm ci → npm run verify → npm run check:deploy` 全部通过后，才执行 D1 迁移和 Worker 部署，彻底阻断“CI 失败却上线”的风险。
- **P1 — 统一本地与 CI 的 D1 迁移应用。** `npm run deploy`、`scripts/deploy.sh` / `deploy.ps1` / `update.sh` / `update.ps1` 在所选配置包含 `TOKEN_STATS_DB` 时，会在部署前自动执行远端 D1 migrations；迁移失败直接阻断部署，dry-run 不修改远端数据。文档同步说明所有迁移文件需按顺序应用。
- **P1 — 公开首页 D1 查询增加短时缓存与并发合并。** `src/dashboard/pages.js` 新增 45s TTL 的内存缓存（`getCachedDashboardStats`），同一时间窗口内并发请求共享同一 in-flight Promise，避免缓存击穿放大 D1 读负载。无 D1 binding 或查询失败仍 fail-open，首页继续返回 200。
- **P1 — 限制上游流式/非流式响应的内存占用。** `src/stream/guard.js` 为首事件前累计字节（2 MiB）与单行 SSE（1 MiB）设置硬上限，超限取消 reader 并抛出可识别错误码（`PRE_EVENT_BYTES_EXCEEDED` / `SSE_LINE_EXCEEDED`），触发节点故障记录与安全轮换；`src/stream/track.js` 的 model rewrite `lineBuffer` 同步限制 1 MiB；`src/request/handler.js` 的 Anthropic 非流式路径改用 `safeReadErrorBody(2MiB)` 有上限读取。
- **P2 — 公开首页不再泄露原始 D1 错误。** 仅显示通用“统计暂不可用”，详细错误仅写入服务端日志；新增回归测试验证表名、SQL、binding 名、异常文本均不出现在 HTML 中。
- **P2 — 按模型统计写入错误不再静默吞掉或重复记录。** 全局与按模型写入并行完成后产生一个带 scope 的分类错误，由请求级 fail-open 边界统一记录，确保每个已交付响应至多一条 D1 持久化错误日志。
- **P2 — 实现按模型统计表的定期清理策略。** 新增 `cleanupModelStats` 与 Worker `scheduled` handler，并在公开配置、CI 配置和操作员配置中默认启用 `0 3 * * *` Cron，每日清理超过 7 天的 `token_usage_model_hourly` 行；全局累计表 `token_usage_hourly` 永不清理。清理失败会上抛给 Workers runtime，便于告警。
- **P2 — 修复测试文件字面 NUL 字节。** `scripts/mock-d1-database.mjs` 将 composite key 分隔符从 `\x00` 改为文本安全的 `|`，`git diff` 现可正常显示文本差异。
- **P2 — 修复热力图 hover 提示词格式。** 现在显示为两行：`6月1日` + `1235万 Token · 438 次请求`，宽度自动不再固定 280px。

### Added

- **Worker `scheduled` handler 与默认 Cron trigger** 用于每日清理按模型统计表；1.2.4 之前生成的 `wrangler.user.jsonc` 需补上该 trigger。
- **Dashboard D1 缓存测试**：验证并发请求共享缓存、TTL 过期后刷新、不同 binding 隔离。
- **D1 错误不泄露测试**：验证降级状态下 HTML 不包含表名、SQL、binding 名、异常文本。
- **D1 写入错误日志测试**：验证错误不阻断 AI 响应、全局写入与 per-model 失败可区分，且单请求至多记录一次。

## 1.2.3 - 2026-08-27

Scheduling, config-reliability and streaming hardening. No new protocols, providers or features. This release makes the per-tier failover budget explicit and availability-aware, makes `MODELS_CONFIG`/`POLICIES_CONFIG` as fail-fast as the node config, and closes a set of real-request edge cases. 1.2.3 supersedes the provisional 1.2.2 code (which never shipped a release); the reserve heuristic is replaced by the cleaner per-tier budget below.

### Changed

- **P0 — Per-tier attempt budgets replaced the `fallback_reserve_per_tier` reserve heuristic.** `max_attempts` still bounds the total attempts per request across all tiers, but each tier now has its own explicit budget. By default `max_attempts` is split so every tier that actually holds a schedulable candidate (model supported, not cooling / circuit-open / model-cooling) gets at least one attempt, and the surplus goes to the highest (most-preferred) schedulable tier — maximizing free/priority resource use while always keeping the paid fallback reachable and never silently starving an intermediate tier. Tier precedence is strict: a higher-preference pool is exhausted (its budget spent) before the next tier is entered, and budget is never reserved for an unusable tier. `POLICIES_CONFIG`'s `tier_attempts` (`{"tier1": N, "tier2": N, "tier3": N}`, `0` disables a tier) optionally overrides a tier's budget. The guarantee now holds under configs the reserve got wrong (e.g. `max_attempts=2` with three tiers no longer silently zeroes the current tier).

### Fixed

- **P0 — Streaming no longer corrupts multi-byte UTF-8 across SSE chunks.** `track.js` fed the same stream-stateful `TextDecoder` from two places (rewrite + diagnostic tail), so its internal multi-byte carry was advanced twice per chunk, mangling characters (e.g. CJK) split across chunk boundaries. The rewrite and tail now each use their own decoder.
- **P0 — A distributed rate-limiter deny no longer consumes an upstream attempt or a local RPM charge** (from the provisional 1.2.2 code): the attempt is rolled back and the attempt budget is not charged, so a CF-denied free key cannot starve the fallback or exhaust its own RPM on traffic it never sent.
- **P1 — A pure `rate_limit_global` failure now returns a `Retry-After` at the next fixed-window reset** instead of omitting the header (previously all-CF-denied requests surfaced a bare 429).
- **P1 — 404s are disambiguated by error body**: a model-shaped 404 stays `model_missing` (model-scoped pair cooldown); an endpoint 404 is a new `endpoint_not_found` (whole-node cooldown), no longer masked as a model-mapping issue.
- **P0 — Anthropic streaming finalizes on `[DONE]` without `finish_reason`.** Some OpenAI-compatible providers (e.g. free keys) end with only `[DONE]` after the final content delta, never sending an explicit `finish_reason` chunk. The transform previously treated that as an error, so Claude Code saw a half-open stream and emitted `Streaming response ended before any complete data was received. Retrying without streaming.`. A content-producing stream that ends on `[DONE]` is now finalized into a complete `message_stop` lifecycle (missing `finish_reason` maps to `end_turn`); a genuinely empty stream is still rejected. A clean EOF without `[DONE]` and without `finish_reason` remains a failure so node health accounting stays correct.

### Added

- **P1 — `MODELS_CONFIG` / `POLICIES_CONFIG` are now fail-fast, like the node config.** Malformed JSON, unknown fields, non-boolean capabilities, unknown capability keys, invalid `reasoning_efforts`, invalid `max_attempts`, invalid `tier_attempts`, and models referencing undefined policies all surface as diagnostics. `/health` (which reads `loadGatewayConfig`) now folds these in and makes the config status `invalid` with `ready=false`, refusing service instead of silently falling back to guessed defaults.

### Changed

- **P1 — Removed the dead lenient `parseBearer` from `src/protocol/http.js`** (strict auth lives in `src/request/auth.js`); no non-Bearer `Authorization` header is treated as an access key.
- **P1 — Access keys and upstream Auth stay strict**: only `Bearer <token>` or `x-api-key` authenticate; pinned GitHub Actions full-commit SHAs remain.
- **P2 — `scripts/secret-scan.mjs` also flags AWS access key IDs** (`AKIA...`).
- Docs: `CONFIGURATION.md` / `ARCHITECTURE.md` updated for per-tier budgets, tier_attempts, and the availability-aware budget rule.

## 1.2.2 - 2026-08-27

Scheduling-boundary hardening release. No new protocols, providers or features; this round closes four ways the scheduler could waste free quota or starve the paid fallback, and makes the failure response's Retry-After honest. These only matter once free nodes grow past a handful — at 6→15→20 keys the original budget and RPM accounting stops guaranteeing that every fallback tier ever gets a turn.

### Fixed

- **P0 — A wide failing Tier 1 can no longer eat the whole attempt budget.** The per-tier attempt loop previously shared one `maxAttempts` counter across all tiers, so six failing free Tier-1 nodes could consume all 5 attempts and Tier 2 / Tier 3 were never reached. Each lower tier that can still serve the requested model now has a reserved budget (`fallbackReservePerTier`, default 1, configurable via `POLICIES_CONFIG`'s `fallback_reserve_per_tier`; 0 restores the original behavior). Tier 1 is capped at `maxAttempts - reserve`, guaranteeing every capable fallback tier at least one attempt.
- **P0 — A distributed-rate-limiter deny no longer consumes an upstream attempt or a local RPM charge.** When `QUOTA_RATE_LIMITER` denied a candidate, the attempt never reached an upstream but the code still incremented `totalAttempts` and left the `acquireSlot` RPM reservation in place. A node that was CF-denied on every free key could therefore starve the fallback budget AND exhaust its own per-minute RPM on traffic it never sent. The deny path now rolls back the RPM reservation (`rollbackRpmBucket`) and does not charge the attempt budget — it still marks the node `attempted` so the tier drains via the candidate set rather than the budget.
- **P1 — `model_missing` (404) cools the (node, model) pair, not the whole node.** A 404 mapping mismatch previously set a node-level cooldown, taking the node's other models (and same-tier siblings) down for 5s. The runtime state now keeps a per-node `modelCooldowns` map; a 404 cools only that `(node, logicalModel)` pair via `recordModelMissing`, leaves node health and the circuit untouched, and `pickCandidate` skips the cooling pair while the same node still serves its other models. The 404 classification carries `modelScoped: true` so the handler routes it to the pair-level path.
- **P1 — `Retry-After` is now the real earliest availability, filtered by model and blocking reason.** The exhausted-response cooldown scan previously read every node's node-level cooldown regardless of whether it served the requested model, and the saturated case returned the RPM minute window whenever any node was hard-RPM-exhausted — so a concurrency-saturated node (frees in ~1s) could be masked by an unrelated node's 50s RPM window. Retry-After is now the min across all model-serving, currently-blocking nodes (`earliestBlockingRetryAfterSec`): node cooldown → model cooldown → RPM window → ~1s concurrency estimate, and unrelated-model nodes never contribute.

### Changed

- **P1 — The S6 "client abort mid-stream" stress test is no longer a fake test.** `chatRequest` did not pass its `AbortController` signal to the `Request`, and the mock `fetch` ignored `init.signal`, so `ac.abort()` never reached the worker and S6 passed only because the stream completed normally. The signal is now wired through and the mock honors it; S6 aborts after the first event reaches the client, genuinely exercising the `trackStreamResponse` `cancel()` → `onNeutral` → `recordNeutralEnd` path. Confirmed: the gateway does release the slot neutrally on a real mid-stream client abort (via `track.js`, not the handler's pre-first-event `onClientAbort`, which detaches once the first event is committed).
- The stress suite grew from 10 to 12 scenarios (S11 fallback-reserve guarantee, S12 `fallback_reserve_per_tier:0` escape hatch). The reliability unit tests grew by 3 `rollbackRpmBucket` contract cases; integration tests grew by the model_missing isolation case and the model-filtered Retry-After case.

## 1.2.1 - 2026-08-26

Reliability hardening release. No new features; this round makes the limits, capability claims and health semantics actually mean what they say.

### Fixed

- **P0 — RPM no longer breaks its own configured cap by default.** `limits.rpm` is now treated as a real upstream/account quota: an exhausted node is skipped (not used as a last-resort fallback), the tier is left, and when every candidate is exhausted the client gets `503` + `Retry-After` pointing at the RPM minute boundary. The previous always-break-through behavior remains available explicitly via `"limits": { "rpm": N, "rpm_mode": "soft" }`. Setting `limits.rpm_mode` to anything other than `soft`/`hard` is a config error.
- **P0 — Optional distributed rate shaping via Cloudflare Rate Limiting.** isolate-local state can only shape traffic per Worker isolate; several isolates share one upstream key. When a Workers Rate Limiting binding is present as `QUOTA_RATE_LIMITER`, hard-RPM nodes get a distributed (per-Cloudflare-location) fixed-window check before dispatch (denied → rotate without counting a node failure). This is **approximate and per-location** — not a strict global/account quota — and its threshold is fixed at the binding, so per-node `limits.rpm` remains the exact source of truth. Concurrency leasing stays isolate-local (a strict cross-PoP quota would require Durable Objects, which this project deliberately avoids).
- **P0 — Streaming relay no longer stalls on its final chunks.** The streaming path wrapped the upstream in several stacked pull-based streams (guard → node-track → rewrite → stats-track); the standalone `rewriteStreamModelField` wrapper could stall before delivering the last bytes, so clients saw the first events but the stream never terminated with `[DONE]`. The model-field rewrite is now done inline inside the tracked stream (`trackStreamResponse`'s `rewriteModel` option), reducing the relay to a single pull-based layer. Non-streaming was never affected.

### Added

- **Stress / fault-injection test suite** (`scripts/stress-test.mjs`, 10 scenarios, wired into `npm test`): concurrency never exceeds the cap and slots never leak; hard RPM never exceeds the configured cap under a burst; tier fallback drains the higher tier; a 429 cooling storm short-circuits with no wasted upstream calls; the circuit opens on sustained failure and recovers via a single held probe; client abort mid-stream releases everything neutrally; the failover budget stops further upstream calls once spent; a randomized fault-injection sweep keeps every invariant; and one node cooling / circuit-open never disturbs its same-tier siblings.

### Changed

- **P1 — Terminal error classification now uses the aggregated failure kinds.** The exhausted response previously picked 429/502 from whatever the *last* attempt happened to be (a trailing 429 could mask a dominant upstream failure). It now derives status from `failure_kinds`: dominant `rate_limit` → 429, dominant `timeout`/`first_event` → 504, otherwise 502. The exhausted/budget responses also expose an aggregate `failure_kinds` map (kinds only, no node ids) so operators can see how a request failed without enabling full topology exposure. Each failed attempt is now logged at info level (node, kind, status, latency).
- **P1 — Model Registry defaults are now actually conservative.** An undeclared model reports `tools:false`, `reasoning:false`, `vision:false` (stream stays `true`) and empty `reasoning_efforts`. Only an explicit MODELS_CONFIG capability declaration turns a capability on: `/v1/models` must under-report, never over-report.
- **P1 — Configuration status semantics unified.** A structural conflict (duplicate ids, conflicting shards, malformed shard JSON) now means `status:"invalid"` AND `ready:false` — the gateway refuses to serve instead of answering traffic while `/health` reports 503. `degraded`/`ready` remain servable (`ready:true`). `/health` now reports `nodes_total` (declared), `nodes_usable` and `nodes_active` separately instead of presenting usable count as total.
- **P1 — First-event guard recognizes SSE error envelopes.** An HTTP 200 stream whose first event is a parseable `{"error":{...}}` envelope is treated as a first-event failure and rotates, instead of committing a zero-output stream and closing the failover boundary. Common with third-party OpenAI-compatible providers.
- **P1 — count_tokens is script-aware and conservative.** ASCII ≈ chars/4; CJK ≈ 1 token per character; tool schemas charged at dense-JSON ratio + per-tool overhead; images at a fixed ~1600-token allowance. The old flat `chars/4` rule badly under-counted Chinese/Japanese input.
- P2 — public homepage quick-start shows `OPENAI_MODEL=<model>` (placeholder) when no model is currently available instead of hardcoding `air`.
- P2 — `src/request/handler.js` split: auth → `request/auth.js`, error builders → `request/errors.js`, routing → `request/router.js`. Orchestration and the attempt/success core stay in handler.js for now.
- Docs: isolate-local vs global quota semantics, RPM mode table, commit-message convention (CONTRIBUTING.md).

## 1.2.0 - 2026-08-26

Reliability + architecture-convergence release. No new protocols, providers or large features; this release makes the existing capability correct, stable and clear.

### Fixed

- **P0 — Half-Open circuit probe leak.** A half-open probe that ended in a non-counted outcome (429, 401/403, 404, client abort, or any neutral end) released only `activeRequests` but never `probeInFlight`, permanently stranding the node in `half-open`/`probeInFlight=true`. Probe completion is now centralized in `node-state.js` (`recoverFromHalfOpen`): success → `CLOSED`, counted transient failure → `OPEN` + fresh cooldown, 429/401/403/404/neutral → `CLOSED` + any node-local cooldown kept, always `probeInFlight=false` and `activeRequests` released. Nodes can be re-probed / re-scheduled afterwards.
- **P0 — Illegal `models` config misread as wildcard.** `normalizeModels` silently emptied invalid entries into `{}`, which the scheduler interpreted as "serve every model". Now only a missing, `null`, or explicitly-empty `{}` is a wildcard; a filled-but-invalid `models` map (non-string values, bad structure, empty/whitespace keys on a non-empty map) is a config error → node excluded + precise diagnostic. Scalar/boolean `models` values can no longer slip through `Object.keys` into a wildcard.
- **Fail-fast Node schema.** Unknown top-level fields (`prioirty`), unknown `limits` fields (`concurency`), and invalid `priority` / `limits.concurrency` / `limits.rpm` are now rejected with a named diagnostic instead of being silently defaulted. The deploy-time planner (`assertNodesArray`) was aligned to the same rules.

### Added

- `FAILOVER_BUDGET_MS` (default `180000`, clamped) — a whole-request failover budget. Time is counted from gateway request receipt; every new attempt checks the remaining budget and caps its own headers/first-event timeout to `min(configured, remaining)`. When the budget is gone the gateway stops rotating and returns a terminal 504 with an attempt count — no more worst-case `headersTimeout × maxAttempts` (≈600s) per Agent call. Client abort stays privileged; streaming never fails over after the first event; first-event-before is still allowed within budget.
- **Model Registry** (`src/config/registry.js`). Model capability (tools / reasoning / vision / stream, reasoning efforts) and policy are now owned by the logical model, fed from `MODELS_CONFIG` (`{ policy, capabilities?, reasoning_efforts? }`). Provider Profile no longer claims model capability or false `native` transport (all upstreams are genuinely reached via the OpenAI Chat Completions path today). `/v1/models` enumerates registry models, is served by node mapping, and reports `api_backends` (+ `apiBackend: "mixed"` when multiple backends) instead of pretending a single backend.
- Regression tests: half-open probe → 429 / 401 / 404 / neutral / client-abort with slot & probe leak checks; config fail-fast & wildcard cases; secret-shard index; failover budget behavior; topology-leak (default vs `EXPOSE_UPSTREAM_INFO=true`); model registry / `/v1/models` / homepage model status.

### Changed

- **Topology-leak reduction.** By default a client response exposes only `x-request-id`, requested model, attempt count, HTTP status, `Retry-After` and the necessary protocol error. `x-gateway-node`, `x-gateway-tier`, and the internal per-attempt sequence are only returned when `EXPOSE_UPSTREAM_INFO=true` (or via auth-protected `/health`). Config `diagnostics` and node ids are likewise gated.
- `/health` now returns **503** for `invalid`/`unconfigured` configuration instead of unconditional 200; `ready`/`degraded` stay 200. Response JSON shape is unchanged.
- `/version` is now purely public branding — the `configuration` block (`status`/`ready`/`nodes_total`/`nodes_usable`) is removed; the public homepage model hint is no longer hardcoded (`code-pro`) — it uses the first available registry model, or `<your-model>`.
- **Stream assembly byte-accounting** counts UTF-8 bytes (not JS string length) across content, reasoning, tool-call names / ids / arguments so oversized `arguments` can no longer bypass the 2 MiB memory guard.
- `limits.concurrency` / `limits.rpm` / cooldowns / circuit / health are explicitly documented as **isolate-local** shaping, not global or provider-wide quotas.

## 历史版本（6.x 及更早 — 版本方案已重置为 1.x）

> 以下为版本方案重置前的历史记录，仅作存档。当前版本线从 `1.2.0` 开始；
> 6.x 从未作为正式 GitHub Release 发布过。

## 6.1.0 - 2026-08-25

Protocol-compatibility release: adds a real OpenAI Responses `/v1/responses` surface and a Provider Capability/Profile layer, without touching the scheduling core. Everything is additive; no breaking changes.

### Added

- `POST /v1/responses` — a genuine OpenAI Responses endpoint (not a stub):
  - Non-streaming: converts a Responses request → the generic chat-completions upstream, then assembles a Responses response object (message / reasoning / function_call output items, usage, status).
  - Streaming: full Responses SSE lifecycle — `response.created` → `response.output_item.added` / `response.content_part.added` / `response.output_text.delta` · done / `response.reasoning_text.delta` · done / `response.function_call_arguments.delta` · done → `response.output_item.done` → `response.completed` / `response.incomplete` / `response.failed`, each with an ordered `sequence_number`.
  - Reasoning preserved as a `reasoning` item (never flattened to text); thinking/thinking-delta handled as reasoning; upstream `reasoning_content` + `reasoning_effort` mapping. Reasoning items now carry an optional `summary` facet and a verbatim `encrypted_content` payload — opaque/redacted reasoning is relayed unchanged, never rewritten as reasoning_text.
  - Function calling: tool definitions, `tool_choice`, `parallel_tool_calls`, `call_id` stability, streaming argument delta assembly, and function_call/function_call_output history round-trips.
  - Error shapes per protocol: Responses clients get `{ error: { message, type, param, code } }`; Anthropic clients keep Anthropic errors; Chat clients keep OpenAI Chat errors. Terminal errors (anything other than 429/503) also carry `x-should-retry: false` so SDKs (Codex / Claude) do not blind-retry a request the gateway already resolved — preventing duplicate tool execution. 429/503 stay retryable via Retry-After.
  - Unsupported host-managed tools (`web_search`, `file_search`, `computer_use`, `code_interpreter`, `custom`) return a clear 400 instead of being silently dropped. Fields a generic chat-completions upstream cannot represent losslessly (`context_management`, `mcp_servers`, `extra_body`, non-`effort` `output_config.*`) are likewise rejected with the exact field name; `stop_sequences` and `top_k` are converted (not rejected).
- Public homepage (`GET /`) rebuilt as a minimal, public edge-gateway entry page: title `智能边缘网关`, one-liner `一个入口，多个模型`, deriving the API base from the request origin (`/v1`), server-rendered logical-model status (可用 / 降级 / 不可用 only), a short quick-start env block with a copy button, and `© 2026 Fongap Studio` footer. No "服务正常" hero badge, no node/provider/tier/key/count internals, no admin/dashboard/README content. `/health`, `/metrics` and `/v1/models` remain auth-protected and unchanged; status is computed server-side and collapsed so no node-level detail leaks.
- `src/protocol/responses/` — a self-contained Responses protocol module (request / response / stream / events / reasoning / tools / index). Protocol layers never schedule nodes; Scheduler/Reliability never understand Responses events.
- Provider Capability/Profile layer (`src/config/profiles.js`): a static descriptor per node describing native-vs-convert protocols and capability flags. CRT credentials, circuit state, cooldowns, health, concurrency and tier remain on the Runtime Node / Scheduler / Reliability layers.
- `/v1/models` now reports additive capability metadata per logical model (`apiBackend`, `protocols`, `supports_reasoning_effort`, `reasoning_efforts`, `supports_tools`, `supports_vision`, `supports_stream`), derived from the provider profile — never from model-name guessing. Existing fields are unchanged (no breaking change).
- New env knob `RESPONSES_REASONING_MODE` (default `reasoning_effort`), mirroring `ANTHROPIC_REASONING_REQUEST_MODE`, to control how Responses `reasoning` is projected onto a chat-completions upstream.
- Contract tests: `scripts/codex-contract-test.mjs` (Responses, 14) and `scripts/claude-contract-test.mjs` (Claude Messages, 11), wired into `npm test`.

### Unchanged (explicitly preserved)

- Scheduling core, Reliability state machine (cooldowns, circuit, health, LRU, concurrency, RPM), Tier fallback, First Event Guard, stream idle timeout, request-scoped attempted-node set.
- The generic OpenAI-compatible provider stays the default; only genuine protocol-divergent providers (`anthropic-*`, `openai-*`, `gemini-*`) resolve to a distinct profile. NVIDIA NIM / OpenRouter / Cerebras / SiliconFlow / most OpenAI-compatible APIs keep the default `openai-compatible` profile.
- Provider recovery/retry from free-claude-code was NOT adopted; ai-gateway keeps its own lightweight Scheduler/Reliability responsibilities.

### Notes

- `/v1/responses` `previous_response_id` is accepted but ignored: ai-gateway is a stateless relay and the client supplies the full `input` items each turn; `store` is a no-op.
- Reasoning `effort: "none"` is a no-op (chat-completions is opt-in) — no field is emitted.

## 6.0.0 - 2026-08-24

Breaking release: the node configuration and secret management model was redesigned. Old deployments must re-run configuration/deployment; no migration is provided.

### Breaking

- Reworked Node configuration: node configs are now plain variables (`TIER1/2/3_NODES_CONFIG_01..99`) and contain NO credential material; credential fields (token/api_key/authorization/...) in node JSON are rejected.
- Removed the `token@base_url` format entirely. Provider credentials are stored separately in `NODE_SECRETS_*` secrets (`{ nodeId: credential }`).
- Removed legacy free/paid/plus naming and all legacy compatibility aliases, parsers and warnings.
- Removed the `tier` field from the node schema; a node's tier is derived only from its variable prefix.
- Removed the response Cache API layer (CACHE_ENABLED / CACHE_MAX_AGE_SEC / CACHE_MAX_BODY_BYTES) and the Analytics Engine binding (AE_DATASET).
- Removed ALLOW_UNSAFE_PROXY_ROUTES; the route allowlist is always enforced.
- Unified body limit to MAX_BODY_BYTES (removed ANTHROPIC_MAX_BODY_BYTES).
- Timeout variables renamed and unified: UPSTREAM_HEADERS_TIMEOUT_MS / FIRST_EVENT_TIMEOUT_MS / STREAM_IDLE_TIMEOUT_MS (removed REQUEST_TIMEOUT_MS and scattered per-module defaults).
- AUTH_FAIL_COOLDOWN_MS default changed from 24h to 1h.
- CORS is disabled by default; set ALLOWED_ORIGIN explicitly for browser clients.
- POLICIES_CONFIG simplified to `{ max_attempts }`; MODELS_CONFIG simplified to `{ policy }`. Tier order is fixed tier-1 -> tier-2 -> tier-3 and no longer configurable.
- Deployment scripts rewritten for the new variable + secret split; install/reconfigure generate a local wrangler.user.jsonc (gitignored).

### Fixed

- Priority semantics: priority ASC is the single ordering everywhere (smaller = higher precedence).
- Retry budget handling replaced by a dynamic eligible candidate set recomputed before every attempt; failed nodes are never retried within one request and healthy nodes are never skipped when state changes.
- Node-level 429 cooldown honors Retry-After (seconds or HTTP-date), clamped to [1s, 600s], and never expands beyond the failing node.
- Same-tier rotation is strictly separated from tier fallback; tier-N+1 is used only when tier-N has no eligible node left for the request.
- Circuit breaker consecutive-failure counting unified into one counter; interleaved successes keep it CLOSED, threshold failures OPEN it.
- HALF_OPEN allows exactly one probe regardless of configured concurrency; probe success closes the circuit, probe failure reopens it with a fresh open period.
- Concurrency slot accounting cannot leak: every attempt path decrements exactly once.
- Streaming failover boundary fixed: the first-event guard runs on ALL streaming paths before bytes reach the client; after the first event transparent failover is impossible.
- Gateway-generated 429 (all nodes cooling) now carries a Retry-After header.
- Mid-stream upstream death delivers already-buffered bytes and closes cleanly instead of raising an opaque client error.

### Changed

- Unified Runtime Node model ({id, tier, provider, baseUrl, credential, priority, models, limits}); only the config layer touches env parsing and credentials.
- src/index.js reduced to the Worker entry; logic moved to src/config, src/scheduler, src/reliability, src/protocol, src/stream, src/request, src/observability.
- One SSE scanner shared by guard and transformers: each upstream SSE event is parsed exactly once.
- Model-field rewriting skipped entirely when logical == upstream model; per-line parse skipped when a line cannot contain the field.
- New black-box integration test suite runs the real worker.fetch pipeline against mocked upstreams (24 scenarios).
- Added benchmark/benchmark.mjs measuring gateway added overhead vs a direct mocked upstream.
- Scheduler LRU tiebreak: sequential traffic rotates across equal-priority nodes instead of concentrating on one until it rate-limits (429 prevention, not reaction).
- Health score differences within a ±10 band are treated as ties so load spreading is not defeated by single-success noise.
- Gateway access key digest cached per isolate: one SHA-256 per request instead of two, same timing-safe either-header semantics.
- Tier grouping and priority sorting precomputed at config load; removed from the request hot path.
- Consecutive-failure counters decay after 5 minutes idle so time-separated incidents cannot chain into a circuit trip.
- Optional per-key RPM quota (`limits.rpm`): soft cap that rotates traffic to sibling keys with headroom; never hard-fails a request.
- Capacity saturation (all candidates busy at concurrency/RPM caps) now returns 503 + `Retry-After: 1` instead of a bare 429, so bursty multi-agent clients back off.
- Passthrough streams that close cleanly without the `[DONE]` marker are accounted as node failures (truncation detection).
- Upstreams that answer `stream:true` requests with `200 + JSON` (some free providers embed errors this way) are now handled explicitly: embedded errors rotate to healthy nodes with proper status mapping, valid completions are synthesized into a well-formed SSE stream for streaming clients. Previously such bodies were relayed verbatim, which SSE clients (e.g. Claude Code) cannot parse — "streaming response ended before any complete data was received".
## 5.14.0 - 2026-08-06

- 在 `wrangler.jsonc` 中声明 `GATEWAY_ACCESS_KEY` 与 `PRIMARY_API_TOKENS` 为必需 Secret，阻止缺少绑定的错误部署；
- 将部署流程拆分为 `install`、`update`、`reconfigure`，兼容旧脚本入口；
- `disable-fallback` 改用 `secret bulk` 删除旧 Fallback Secret，不再意外重新部署本地代码；
- `/version` 增加必需绑定就绪状态，便于不泄露密钥地定位运行时配置问题；
- 修复 `/health`、`/metrics` 缺少 CORS；CORS 预检不再反射任意请求头；
- 严格模型模式下 `/v1/models` 只返回配置别名，不暴露上游完整模型目录；
- 严格路由改为先筛选实际拥有别名映射的端点，再应用最大尝试数；
- 校验 `MODEL_MAPPING` 结构与 `invoke_url`，阻止 HTTP、内嵌凭据和错误字段类型；
- 修复 Token 中包含 `@` 时的 `Token@BaseURL` 解析，并避免 32 位端点 ID 碰撞；
- 拒绝压缩请求体；所有支持的 JSON 接口均执行有界读取和明确的 JSON/字段校验；
- 修复无 `Content-Length` 请求体绕过大小限制；上游 JSON 响应也增加有界读取；
- 3xx 上游响应不再直接透传，防止重定向与 `Location` 泄露；
- 流式客户端统计延迟到响应体真正结束，中断与取消分别计数；
- 修复无尾部分隔符 SSE 丢失、空流伪成功和诊断读取单块越界；
- Fallback 增加独立硬并发上限；健康、指标和 Analytics 使用完整端点身份指纹；
- 默认上游 `Accept-Encoding` 改为 `identity`，避免压缩 SSE/JSON 解析歧义；
- Release、校验和、链接及密钥扫描统一排除 dry-run 产物；
- 增加部署配置检查、模型映射检查和完整 hardening 回归测试；
- 修复已声明路由的大小写或尾斜杠被误当作普通上游路径转发；未知路径的 CORS 预检不再默认成功；
- 修复客户端同时发送两个鉴权头时，错误的 `Authorization` 覆盖正确 `x-api-key`；
- 修复客户端在首字节前取消后继续轮询并惩罚多个上游端点；
- 修复重复 Primary 或完全相同的两级 Fallback 导致同一上游被重复调用；
- 修复 Base URL 客户端重复查询参数只保留最后一个值；
- 修复缓存命中响应仍显示 `CACHED`，并移除未真正实现的流式缓存承诺；
- 默认改为响应头白名单，进一步阻止供应商私有响应头泄露；
- 模型列表响应增加 5 MiB 有界读取，防止异常上游返回超大 JSON；
- `MODEL_MAPPING` hostname 统一小写，禁止静态覆盖或删除 `model`、`messages`、`stream`；
- `/version` 改为 `no-store`，避免部署后配置状态被旧缓存误导；
- 修复 `Content-Encoding: identity` 被错误当作压缩请求拒绝；
- 修复无效 `PRIMARY_ENABLED` / `FALLBACK_ENABLED` 值可能采用启用状态；
- 配置校验脚本与运行时 Token 解析保持一致，并新增 Fallback URL/凭据校验；
- 临时 Wrangler 配置改为在项目根目录创建，确保相对入口和 `.dev.vars` 能被正确解析，同时仍会自动清理并排除发布包；
- 所有 Node 脚本改用 Node 20 全版本兼容的 `fileURLToPath(import.meta.url)`；
- 更新、重配和关闭 Fallback 前明确显示目标 Worker 并要求确认。

## 5.13.0 - 2026-08-06

- 增加 `keep_vars: true` 与安全更新脚本；
- 默认启用路由白名单与 HTTPS 上游；
- 增加严格模型白名单、真实冷却排除、并发限制和客户端统计；
- 默认关闭假流式保护，完善模型列表与上游信息隐藏。

## 5.12.0 - 2026-08-06

- 将 `/v1/models` 从偶然的单端点透传改为独立能力：依次尝试 Primary，并合并 `MODEL_MAPPING` 别名；
- 增加模型列表检查脚本与多端点回归测试；
- 增加公开的 `/version` 版本接口；
- 增加中英文架构图与 Dashboard 实际预览图；
- 升级 GitHub Actions，并补充 Tag 自动创建 GitHub Release；
- 发布脚本改为从 `package.json` 自动读取版本并同时生成 ZIP、TAR.GZ 与校验值；
- 增加版本一致性检查、Markdown 本地链接检查和依赖锁文件；
- 增加 Issue 模板、Pull Request 模板与 Dependabot 配置；
- 完善中英文 README、Cloudflare GitHub 自动部署说明和运行指标边界说明；
- Wrangler 固定为 `4.114.0`。

## 5.11.0 - 2026-08-06

- 项目名称统一为“智能边缘网关”；
- 移除前端 Cloudflare Workers 与版本展示；
- 客户端鉴权变量统一为 `GATEWAY_ACCESS_KEY`；
- 第二兜底只保留 `off` 作为显式关闭值；
- 缩小首页主标题字号；
- 保留 OpenAI / Anthropic 双协议、Primary 池与双级 Fallback；
- 整理为可公开发布的 Wrangler 项目结构；
- 增加 Windows、Linux 和 macOS 部署脚本、健康检查脚本与开源文档；
- 增加中英文双语 README，并在两版顶部提供语言切换。
