# 故障排查

## 部署错误

### `ERROR: CLOUDFLARE_ACCOUNT_ID is missing`

设置 GitHub Variable（见 deployment.md §2）。

### `ERROR: GATEWAY_ACCESS_KEY is missing`

设置 GitHub Secret（见 deployment.md §3）。

### `ERROR: No TIER{1,2,3}_NODES_CONFIG_XX Variable is configured`

添加至少一个 tier-config Variable，包含有效 JSON。

### `ERROR: No TIER{N}_NODES_SECRETS_XX Secret is configured`

添加至少一个 `TIER{1,2,3}_NODES_SECRETS_01` Secret，包含 JSON 对象 `{ "node-id": "credential" }`。Secret 的 tier 前缀必须与所配对的 `TIER*_NODES_CONFIG_*` 一致。

### `D1 persistence disabled: TOKEN_STATS_D1_ID is not configured`

如不需要持久化 token 统计，这是预期行为。如需启用，设置 `TOKEN_STATS_D1_ID` Variable。

### `GATEWAY_CONFIG is deprecated`

仍在使用旧版单 blob 格式。迁移到 individual Variables 和 Secrets。使用 `npm run config:migrate` 生成清单。

## 运行时错误

### 429 Too Many Requests

- 检查节点 `limits.rpm` 配置
- 检查是否有 `QUOTA_RATE_LIMITER` binding
- Retry-After header 指示最早可用时间
- 所有节点 exhausted 时返回 503 + Retry-After

### 502 Bad Gateway

- 所有节点均失败
- 检查 `failure_kinds` 确定失败类型
- 检查上游服务状态

### 503 Service Unavailable

- 配置状态为 `invalid` 或 `unconfigured`
- 检查 `/health` 确定配置状态
- 所有节点 RPM exhausted

### 504 Gateway Timeout

- Failover budget 耗尽
- 检查 `FAILOVER_BUDGET_MS` 配置
- 检查上游响应时间

### First-Event Timeout

- 上游返回 HTTP 200 但未产生有效 SSE 事件
- 检查 `FIRST_EVENT_TIMEOUT_MS` 配置
- 检查上游流式行为

### Headers Timeout

- 上游未在规定时间内返回响应头
- 检查 `UPSTREAM_HEADERS_TIMEOUT_MS` 配置
- 检查上游网络连通性

### All Nodes Failed

- 检查节点配置和凭据
- 检查上游服务可用性
- 检查 `/health` 节点状态

## 配置错误

### Configuration Invalid

- 检查 `/health` 中的 `config_status`
- 运行 `npm run config:check` 本地验证
- 检查重复 node id、无效 JSON、缺失凭据

### Model Unavailable

- 检查节点 `models` 映射
- 检查 `MODELS_CONFIG` 注册表覆盖
- 运行 `npm run config:check` 验证

### Responses Compatibility

- 确认节点 `surfaces` 包含 `responses`
- 确认 `protocol` 为 `openai`
- 检查上游是否真正支持 `/v1/responses`

### Anthropic Compatibility

- 确认节点 `protocol` 为 `anthropic`
- 确认 `surfaces` 包含 `messages`
- 检查 `anthropic-version` 头透传

## Cloudflare Deployment Errors

### Health Check Fails

检查 `wrangler tail` 查看已部署 Worker。`GATEWAY_ACCESS_KEY` Secret 中的密钥必须匹配运行时看到的值。

### `/v1/models` Returns Empty

当前 `TIER*_NODES_CONFIG_XX` 声明的节点 `models` map 为空（wildcard）或 `MODELS_CONFIG` 注册表覆盖无效。运行 `npm run config:check` 本地验证。

### Wrangler Dry-Run Fails

检查本地 `wrangler.user.jsonc` 配置。确保 KV namespace binding 正确。
