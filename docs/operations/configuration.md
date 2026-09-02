# 配置参考

> 当前 1.x 配置架构。生产环境通过 GitHub Repository Variables（非敏感 Worker 文本变量）和 Secrets（凭据）交付。旧版 blob（`GATEWAY_CONFIG` / `GATEWAY_SECRETS_CONFIG`）已废弃——见 [deployment.md](deployment.md) 迁移说明。

## 生产配置来源

| 来源 | 用途 | 示例 |
|---|---|---|
| `TIER{1,2,3}_NODES_CONFIG_01..10` | 各层节点池 | JSON 数组 |
| `MODELS_CONFIG` | 模型注册表覆盖 | JSON 对象 |
| `POLICIES_CONFIG` | Attempt budgets 和 tier 策略 | JSON 对象 |
| `NODE_SECRETS_01..20` | 节点凭据 | `{ "node-id": "credential" }` |
| `GATEWAY_ACCESS_KEY` | 网关访问密钥 | Bearer token |
| 运行时参数 | 超时、冷却等 | 见下方表格 |

GitHub Deployment Variables 持有非敏感配置；GitHub Secrets 持有凭据。Cloudflare Dashboard 不是日常配置界面。

## Worker Secrets

| 配置项 | 必需 | 内容 |
|---|---|---|
| `GATEWAY_ACCESS_KEY` | 是 | 客户端访问网关的密钥 |
| `NODE_SECRETS_01..99` | 是 | JSON 对象 `{ "node-id": "credential" }`，按 entry 边界分片 |

节点按 `id` 查找 credential。缺少 credential 的节点被排除调度；没有节点的 credential 在 `/health` 诊断中报告。

## 节点配置

### Node Schema

```json
{
  "id": "nvidia-01",
  "provider": "nvidia",
  "protocol": "openai",
  "surfaces": ["chat_completions"],
  "base_url": "https://integrate.api.nvidia.com/v1",
  "priority": 10,
  "models": { "general-air": "model-a", "code-pro": "model-b" },
  "limits": { "concurrency": 1 }
}
```

Anthropic 原生节点：

```json
{
  "id": "anthropic-01",
  "provider": "anthropic",
  "protocol": "anthropic",
  "surfaces": ["messages"],
  "base_url": "https://api.anthropic.com",
  "priority": 10,
  "models": { "max": "claude-sonnet-4-5" }
}
```

### 加载时规则

- `id` 匹配 `^[a-z0-9][a-z0-9-]{0,63}$`；重复 id 使整个配置 `invalid`
- Credential 字段（`token`、`api_key`、`apikey`、`authorization`、`password`、`secret`、`credential`）被**拒绝**——凭据属于 `NODE_SECRETS_*`
- `tier` 字段被拒绝；tier 来自变量前缀
- `base_url` 必须是绝对 URL；`https://` 除非 `ALLOW_INSECURE_HTTP_UPSTREAM=true`
- `priority`：数字，默认 `100`。Tier 2/3 使用；Tier 1 P2C 忽略
- `protocol`：`"openai"`（默认）或 `"anthropic"`
- `surfaces`：`openai` 协议可选 `chat_completions` / `responses`；`anthropic` 协议只能是 `messages`
- `models`：object mapping logical → upstream model。Missing 或显式空 `{}` = wildcard
- 未知字段被拒绝；无效 `protocol` / `surfaces` / `priority` / `limits.concurrency` / `limits.rpm` 被拒绝

### 迁移兼容

旧节点缺少 `protocol` 时默认 `"openai"`、缺少 `surfaces` 时默认对应协议的默认 surface，并输出 deprecated diagnostic。建议尽快显式声明。

## 运行时参数

| 变量 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `MAX_BODY_BYTES` | 20971520 | 1KB–100MB | 请求体限制 |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 60000 | 5s–600s | 上游响应头超时 |
| `FIRST_EVENT_TIMEOUT_MS` | 120000 | 5s–600s | 流式首事件超时 |
| `STREAM_IDLE_TIMEOUT_MS` | 240000 | 10s–600s | 流块最大间隔 |
| `RATE_LIMIT_COOLDOWN_MS` | 60000 | 1s–600s | 429 cooldown（无 Retry-After） |
| `AUTH_FAIL_COOLDOWN_MS` | 3600000 | 1min–7d | 401/403 credential cooldown |
| `FAILOVER_BUDGET_MS` | 240000 | 5s–900s | 整请求 failover budget |
| `HEDGE_DELAY_MS` | 6000 | 0s–600s | Reactive hedge delay；`0` 禁用 |
| `MAX_HEDGES_PER_REQUEST` | 1 | 0–3 | 每请求最大 hedge twin 数 |
| `ALLOWED_ORIGIN` | *(unset)* | origin 或 `*` | CORS 默认关闭 |
| `EXPOSE_UPSTREAM_INFO` | false | | 暴露上游节点/provider/tier |
| `FAKE_STREAM_PROTECTION` | false | | 非流式请求转流式上游 + 重组 |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | false | | 允许 http:// base_url |
| `ANTHROPIC_COUNT_TOKENS_MODE` | approximate | approximate/disabled | 本地 token 计数 |
| `LOG_LEVEL` | info | none/error/info/debug | 日志级别 |
| `PROJECT_REPOSITORY_URL` | — | https URL | Dashboard 显示 |
| `PROTOCOL_FALLBACKS` | *(unset)* | JSON object | 跨协议 fallback 链，仅支持 `{"anthropic:messages":["openai:chat_completions"]}` |

运行时参数的唯一事实来源是 `src/config/runtime-vars.js`。超时/冷却默认值的唯一事实来源是 `src/config/timeouts.js`。

## limits.rpm 语义

- **hard（默认）**：isolate-local cap，exhausted 节点被跳过，完全 exhaustion 返回 503 + Retry-After
- **soft**：best-effort，exhausted 节点仍作为 last-resort fallback

## 分布式 Rate Shaping

可选的 Cloudflare Workers Rate Limiting binding（`QUOTA_RATE_LIMITER`）提供分布式 per-location fixed-window 检查。它是近似的、per-location 的，不是严格的全局/account quota。

## Tier 1 Session Affinity

必需的 `TIER1_AFFINITY` Cloudflare KV binding。客户端通过 `x-session-id`（8–128 字符）启用。原始 session ID 经 SHA-256 哈希后存储，30 分钟 TTL。

## Token-Usage Persistence（可选 D1）

`TOKEN_STATS_DB` Cloudflare D1 binding。fail-open、非计费可观测性组件。

**存储分层：**
- KV (TIER1_AFFINITY)：30 分钟 TTL，仅用于 Tier 1 会话亲和
- D1 `token_usage_totals`：单行 'global'，生命周期累计，永不清理
- D1 `token_usage_hourly`：7 天保留，UTC 小时桶
- D1 `token_usage_model_hourly`：7 天保留，按模型 UTC 小时桶
- D1 `token_usage_daily`：52 周保留，UTC+8 自然日桶
- D1 `token_usage_weekly`：52 周保留，UTC 周一起始周桶

**定时维护**（cron `0 3 * * *`）：`aggregateHourlyToDaily` → `aggregateDailyToWeekly` → `cleanupUsageRetention`；所有聚合幂等（覆盖而非累加）。

**Dashboard 读取路径：**
- 累计 KPI：`token_usage_totals`（部署过渡期回退 hourly）
- 52 周热力图：`token_usage_daily`（部署过渡期回退 hourly + 今日叠加）
- 模型用量：`token_usage_model_hourly`（7 天窗口）
- 公开 Model Status：`token_usage_model_hourly`（24h 证据窗口，不变）

Token 计数仅使用上游报告的 usage，缺失时从不估算。

## Configuration Status

| 状态 | 条件 |
|---|---|
| `unconfigured` | `GATEWAY_ACCESS_KEY` 或任何 `TIER*_NODES_CONFIG_*` 缺失 |
| `invalid` | 配置存在但零可用节点，或结构冲突 |
| `degraded` | 部分节点不可用，至少一个可用 |
| `ready` | 所有声明节点可用 |

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入值
npm run dev
```
