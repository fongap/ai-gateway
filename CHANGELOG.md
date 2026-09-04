# Changelog

## Unreleased

### Changed — 协议层架构收敛（OpenAI / Anthropic 双原生协议）

- **上游协议正式收敛为 OpenAI 与 Anthropic 两种原生协议族。** 客户端请求现在被原样转发到**同协议、同 surface** 的原生上游 endpoint,不再存在任何跨协议转换:
  - `Chat → 上游 /v1/chat/completions`(原已原生,不变)
  - `Responses → 上游 /v1/responses`(原为 Responses↔Chat 双向模拟,现删除转换、原生透传)
  - `Messages → 上游 /v1/messages`(原为 Anthropic→Chat→Anthropic 双重转换,现删除转换、原生透传)
- **Node Schema 新增 `protocol` 与 `surfaces`.** `protocol`(`openai`|`anthropic`)决定 wire format、上游 endpoint、认证 header(openai → `Authorization: Bearer`;anthropic → `x-api-key` + `anthropic-version`/`anthropic-beta` 透传)与协议头;`surfaces`(openai: `chat_completions`/`responses`;anthropic: `messages`)声明节点真正支持的接口。`provider` 退化为纯元数据(dashboard/metrics/诊断/quirks),**不再隐式决定 transport**。旧配置缺省时按 `openai` + 默认 surface 迁移并输出 deprecated diagnostic(节点仍可用,gateway 不因此 invalid)。
- **新增 Transport 层 `src/transport/`(index/openai/anthropic)。** 只负责 upstream path、协议 headers、模型替换、流式判定与协议特定响应语义;可靠性逻辑仍完全由 scheduler/reliability/request 层统一控制。`src/config/profiles.js` 删除,换成 `src/config/provider-quirks.js`(仅记录 `stream_options.include_usage` 等 wire-format 兼容差异,不决定协议/路径/transport)。
- **调度器升级为 protocol + surface + model 三重过滤**(`supportsRequest`)。`/v1/responses` 只路由到 `surfaces` 含 `responses` 的 openai 节点,`/v1/messages` 只进入 anthropic 节点;**禁止跨协议 fallback**,OpenAI 节点全失败时健康的 Anthropic 节点不会被调用(反向亦然)。同协议内的轮换/hedge/tier fallback 完整保留。
- **Hedge 强制协议隔离.** twin 由同一三重过滤选择器挑选,必然与 primary 同 protocol、同 surface;无可选 twin 时不启动 hedge。
- **各协议独立的 First Event Guard 判定.** OpenAI Chat 保持"任何可解析非错误事件提交";OpenAI Responses 仅 `response.*.delta` 提交(生命周期事件不提交);Anthropic 原生仅 `text_delta`/`thinking_delta`/`input_json_delta` 提交(`message_start`/block 生命周期/ping/`message_delta` 不提交)。提交前可 failover,提交后禁止透明切换——两个协议族不再共用一个错误的首事件判断。
- **诊断增强.** dispatch 日志与 attempts 记录新增 `provider` / `protocol` / `surface` 字段;`/health` 节点条目新增 `protocol`/`surfaces`;`/v1/models` 的 `protocols` 改为按服务节点的真实 surfaces 并集,`api_backends` 改用 provider 标签。topology hiding 与 secret 分离策略不变。

### Fixed

- **修复 hedge `kind=unknown` 可观测性 bug.** ① fetch 失败路径的 rotate outcome 现在携带已分类的 `kind`(此前丢弃,导致 `hedge failed ... primary_kind=unknown`);② 竞速已被赢家解决后,输家迟到的 neutral 结果不再触发误导性的 `hedge failed` 日志(赢家侧无 kind 被打成 `unknown`)。只修日志信息传播,错误分类/惩罚/circuit/retry 行为不变。
- **移除 `buildTargetUrl` 中遗留的调试 `console.log`(测试残留).**

### Removed — legacy 协议转换代码

- `src/protocol/convert.js`(Anthropic↔OpenAI 非流式转换)、`src/stream/transform.js`(Chat SSE→Anthropic SSE)、`src/protocol/responses/{request,stream}.js`(Responses↔Chat 双向模拟)、`src/protocol/responses/{response,reasoning,tools}.js`(仅服务于转换链路)、`src/config/profiles.js`(按 provider 名猜测 transport 的兼容 profile)。原生透传所需的防御性 stream↔object 组装以 `src/protocol/responses/native-stream.js` 与 `src/stream/anthropic-native.js` 重建(均在首字节交付前运行,失败仍可轮换)。

### Added

- **协议矩阵测试 `scripts/protocol-matrix-test.mjs` ×16**(已纳入 `npm test`):OpenAI Chat 成功/failover/hedge;Responses 原生链路(不经 Chat 转换、chat-only 节点被排除);Anthropic 原生链路(native 路径、`x-api-key`、`anthropic-beta` 透传、无 Bearer);**跨协议禁止 fallback**双向断言;hedge 同协议同 surface 断言;旧配置(无 `protocol`/`surfaces`)端到端迁移与 deprecated diagnostic 断言。

---
## 1.2.7 - 2026-09-04

### Changed — 模型治理与一致性收敛（v1.2.7）

- **模型目录（Model Registry）新增 `ui_visible` 字段**：控制 Dashboard 与模型选择器的显示，与 API 可见性（`visibility`）解耦。8 个 Public 模型（Air/Pro/Max/Ultra, Code-Air/Code-Pro/Code-Max/Code-Ultra）为 `true`；Agent 能力模型 Omni/OCR 为 `false`，不出现在普通用户选择器与 Dashboard「模型状态」中，但保留完整的后台统计、健康监控与 Agent 发现能力。
- **正式逻辑模型收敛为 10 个**：8 个面向用户 + 2 个 Agent 能力（Omni/OCR）。Group 分类收敛为 `general` / `code` / `omni` / `ocr`，`deriveGroup` 仅作兼容 fallback。
- **MODELS_CONFIG 扩展 `ui_visible` 与 `ocr` capability**：Omni 默认 `vision=true`，OCR 为 `ocr=true`，均 `ui_visible=false`。`ui_visible` 默认 `true`，未知字段/非法类型仍产生 diagnostics。
- **Key-scoped `/v1/models`**：模型列表按 Key Scope（`configuredModels ∩ allowlist`）过滤。AGENT Key 可发现全部 10 个模型；受限 Key 仅返回被授权子集。Visible == Callable。
- **Closed Catalog 收敛**：`collectKnownModels = node mappings ∪ MODELS_CONFIG`。Wildcard node 仅服务已知目录模型，拒绝任意字符串，防止未声明模型被调用。
- **Key-scoped 权限去重**：`access-keys.js` 与 `model-authz.js` 的 `filterVisibleModels` 收敛为单一源，`/v1/models` 与请求授权共用同一逻辑。
- **Tier Secret 强制校验**：Node Tier 必须与 Secret Tier 一致（Tier1 node 不得使用 Tier2 secret），不匹配直接 diagnostics / fail closed。
- **Malformed shard 检测全覆盖**：TIER1/2/3 的 NODES_CONFIG / NODES_SECRETS 统一校验后缀格式（如 `_01`），格式错误直接报错不再静默忽略。

### Fixed — 可观测性一致性收敛

- **统计维度大小写归一化**：`normalizeModelKey = trim + toLowerCase`。新写入直接写入 canonical key；历史读取统一 `GROUP BY LOWER(TRIM(model))`，合并 `Code-Max` / `code-max` / `CODE-MAX` 为同一统计维度。覆盖 Token / Requests / Top-N / Percentage / Recent Evidence / TTFT / Coverage 全维度。不修改历史 D1 行，新写入走 canonical key，历史按读取时归一化聚合，7 天保留期后旧大小写自然淘汰。
- **Dashboard TTFT P50/P95 统一**：`queryAllModelsTtft` 单次 grouped D1 查询（`GROUP BY LOWER(TRIM(model))`）一次性拉取所有模型的 7 桶直方图，内存算 P50/P95，不再 N+1 查询 Top 4。8 个 Public Model 均可获取 TTFT（只要有数据），不再仅限 Usage Top 4。
- **Recent Evidence 窗口收敛 24h**：统一使用 `MODEL_STATUS_RECENT_WINDOW_MS = 24h`，不再有硬编码 7 天。
- **Public Model Status 仅显示 8 个 Public 模型**：Omni/OCR 后台继续完整统计与监控，但 Dashboard「模型状态」与 `/v1/models`（受限 Key）不再暴露。

### Changed — 协议文档与版本收敛

- **协议架构描述统一**：OpenAI / Anthropic 双原生协议，Native First；仅 Anthropic Messages 在显式配置 `PROTOCOL_FALLBACKS` 时允许单向 fallback 至 OpenAI Chat；不存在隐式跨协议 fallback；Hedge 永不跨 protocol / surface。文档与代码注释同步修正。
- **版本统一为 1.2.7**：`package.json` / `APP_META` / `CHANGELOG` / `README` / `docs` / `example config` 统一为 1.2.7。

### Removed

- 删除废弃的转换代码残留与未使用的兼容层。
- 冻结 Dashboard 布局调整（宽度/像素/间距/字体），专注治理正确性。

---

### Added

- **Public Model Status 使用 Runtime + D1 recent evidence。**
- **TTFT histogram** (7-bucket, per-model, per-hour)。
- **TTFT P50 / P95** 显示在模型状态区域。
- **Provider Discovery** 治理框架 (观察-only workflow)。
- **模型状态性能展示** (status + TTFT P50 + P95 + sample count)。
- 相关测试 (`reliability-performance-test.mjs` ×40)。

### Changed

- **Dashboard 信息架构调整**：TTFT 从"使用情况"移动至"模型状态"。
- **模型状态统一展示**当前状态和近期 TTFT (P50 / P95 / 样本数)。
- **使用情况只保留** Token / 请求 / 活动 / 模型占比。
- **Reliability 指标修正为 Usage Coverage 语义** (`queryModelUsageCoverage`)。
- npm 脚本重命名：`test:required` → `test:unit`、`test:full` → `test:all`、`verify` → `validate:merge`、`verify:full` → `validate:deploy`。

### Fixed

- **Public Model Status 在新 isolate 下容易全部显示"未观测"**。
- **Provider Discovery upload-artifact SHA 错误** (`bbb15f1f` → `330a01c4`)。
- **Usage Coverage 被错误称为 Reliability / Success Rate**。
- **migration 0003 注释与实际 SQL 不一致** (删除"idempotent"声明)。
- **版本信息不一致** (package.json / runtime / integration-test 统一为 1.2.6)。
- **ci.yml validate-deploy 使用 v6 SHAs** (统一为 v7.0.1)。

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
