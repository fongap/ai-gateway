# Changelog

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

