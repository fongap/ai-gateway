# 配置参考

> 当前 1.3.0 配置架构。生产环境通过 GitHub Repository Variables（非敏感 Worker 文本变量）和 Secrets（凭据）交付。节点配置（provider、base_url、models、priority）存储在 Variables 中；凭据（api_key、token）存储在 Secrets 中。

## 生产配置来源

| 来源 | 用途 | 示例 |
|---|---|---|
| `TIER{1,2,3}_NODES_CONFIG_01..10` | 各层节点池 | JSON 数组 |
| `MODELS_CONFIG` | 模型注册表覆盖 | JSON 对象 |
| `POLICIES_CONFIG` | Attempt budgets 和 tier 策略 | JSON 对象 |
| `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | 对应 Access Group 的模型 allowlist | `general-air,code-pro` |
| `TIER{1,2,3}_NODES_SECRETS_01..10` | 节点凭据（tier-scoped；`01..10` 仅为分片，同 Tier 可跨 suffix 按节点 ID 绑定） | `{ "node-id": "credential" }` |
| `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | 五组网关访问密钥 | Bearer token |
| 运行时参数 | 超时、冷却等 | 见下方表格 |

GitHub Deployment Variables 持有非敏感配置；GitHub Secrets 持有凭据。Cloudflare Dashboard 不是日常配置界面。

## Gateway Access Groups

当前 Runtime 使用五个独立 Access Group：`AIR`、`PRO`、`MAX`、`ULTRA`、`AGENT`。每组由以下两项组成：

```text
GATEWAY_ACCESS_KEY_<GROUP>
GATEWAY_ACCESS_MODELS_<GROUP>
```

规则以 `src/config/access-keys.ts` 为唯一事实来源：

- 新部署至少配置一个 `GATEWAY_ACCESS_KEY_<GROUP>`；
- 每个 Group 独立，无继承、无隐式默认；
- Key 已配置但对应 Models 缺失或为空时，该 Key 获得 **0 个模型**（fail-closed）；
- Models 是 CSV allowlist；运行时也支持显式 `*`，但安装脚本不会自动生成 `*`，也不会默认授予全部模型；
- 只要配置了任意新式 Group Key，legacy `GATEWAY_ACCESS_KEY` 就完全不参与鉴权。

### Legacy 兼容

`GATEWAY_ACCESS_KEY` 仅保留兼容路径：**只有未配置任何** `GATEWAY_ACCESS_KEY_AIR/PRO/MAX/ULTRA/AGENT` 时才生效。它不是当前生产默认，也不是新部署必需项或推荐方案。

## Worker Secrets

| 配置项 | 必需 | 内容 |
|---|---|---|
| `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | 至少一个 Group | 客户端访问网关的分组密钥；对应 `GATEWAY_ACCESS_MODELS_<GROUP>` 存放于 Variables |
| `TIER{1,2,3}_NODES_SECRETS_01..10` | 至少一个 | JSON 对象 `{ "node-id": "credential" }`，按 entry 边界分片。Secret 的 Tier 前缀必须与节点所属 `TIER{1,2,3}_NODES_CONFIG_*` 一致；suffix 仅用于分片，不要求与 config shard 1:1 对应 |

节点按 `id` 在同 Tier 的 credential 中绑定。Secret Tier 与节点 Tier 不一致属于配置错误，启动校验会拒绝服务；缺少 credential 的节点被排除调度；没有节点的 credential 在 `/health` 诊断中报告。

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
- Credential 字段（`token`、`api_key`、`apikey`、`authorization`、`password`、`secret`、`credential`）被**拒绝**——凭据属于 `TIER{1,2,3}_NODES_SECRETS_*`
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
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 15000 | 5s–600s | 上游响应头超时 |
| `FIRST_EVENT_TIMEOUT_MS` | 30000 | 5s–600s | 流式首事件超时 |
| `STREAM_IDLE_TIMEOUT_MS` | 120000 | 10s–600s | 流块最大间隔 |
| `RATE_LIMIT_COOLDOWN_MS` | 30000 | 1s–600s | 429 cooldown（无 Retry-After） |
| `AUTH_FAIL_COOLDOWN_MS` | 3600000 | 1min–7d | 401/403 credential cooldown |
| `FAILOVER_BUDGET_MS` | 60000 | 1s–900s | 整请求 failover budget |
| `HEDGE_DELAY_MS` | 3000 | 0s–600s | Reactive hedge delay；`0` 禁用 |
| `MAX_HEDGES_PER_REQUEST` | 1 | 0–3 | 每请求最大 hedge twin 数 |
| `GATEWAY_KEY_RPM` | 0 | 0–100000 | 单 isolate 内每个 access key 的 60s 滑动窗口请求上限；`0` 禁用。需要跨 isolate 严格上限时使用 `QUOTA_RATE_LIMITER` binding |
| `ALLOWED_ORIGIN` | *(unset)* | origin 或 `*` | CORS 默认关闭 |
| `EXPOSE_UPSTREAM_INFO` | false | | 暴露上游节点/provider/tier |
| `FAKE_STREAM_PROTECTION` | false | | 非流式请求转流式上游 + 重组 |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | false | | 允许 http:// base_url |
| `ANTHROPIC_COUNT_TOKENS_MODE` | approximate | approximate/disabled | 本地 token 计数 |
| `LOG_LEVEL` | info | none/error/info/debug | 日志级别 |
| `STREAM_INCLUDE_USAGE` | auto | auto/always/never | 是否在流式请求中携带 `stream_options.include_usage` |
| `STREAM_USAGE_INCLUDE_OFF_PROVIDERS` | *(empty)* | provider 列表 | 按 provider 排除 usage hint |
| `PROJECT_REPOSITORY_URL` | — | https URL | Dashboard 显示 |
| `PROTOCOL_FALLBACKS` | *内置默认（v1.3.0 双向 fallback）* | unset / `disable` / JSON object | 跨协议 fallback 链。未配置或为空时使用 `{"anthropic:messages":["openai:chat_completions"], "openai:chat_completions":["anthropic:messages"]}`；设 `disable` 关闭；显式 JSON（即使为空数组）覆盖默认。OpenAI Responses 始终 Native Only。详细见 [protocol-model.md](../architecture/protocol-model.md) |

运行时参数的唯一事实来源是 `src/config/runtime-vars.ts`。

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

## POLICIES_CONFIG 详细字段 (v1.3.0)

`POLICIES_CONFIG` 是 per-model 策略映射（`MODELS_CONFIG.<model>.policy` 引用），决定 attempt budget 与 hedge 行为。v1.3.0 新增 `budget_split` 字段用于自适应 budget 分配。

### 完整 schema

```json
{
  "default": {
    "max_attempts": 5,
    "tier_attempts": null,
    "hedge": { "enabled": true },
    "first_event_timeout_ms": null,
    "budget_split": null
  }
}
```

### 字段说明

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `max_attempts` | int 1-8 | 5 | 整请求 logical attempt 上限（跨 tier 共享） |
| `tier_attempts` | object \| null | `null` | 显式 per-tier budget: `{"tier1": N, "tier2": N, "tier3": N}`。`0` 禁用该 tier。显式值优先级最高，不会被 `budget_split` 修改；显式值总和不得超过 `max_attempts`，否则配置 `invalid` |
| `hedge.enabled` | bool | true | 是否启用 reactive hedge。`false` 完全禁用 |
| `hedge.delay_ms` | int ≥ 0 | (env HEDGE_DELAY_MS) | Hedge twin 启动延迟 |
| `hedge.tiers` | array \| null | null | 仅这些 tier 允许 hedge twin；null = 全部 |
| `first_event_timeout_ms` | int 5000-600000 \| null | null | Per-model 首事件超时 override（覆盖 `FIRST_EVENT_TIMEOUT_MS`） |
| **`budget_split`** | `'even' \| 'weighted' \| null` | `null` | **v1.3.0 新增**：per-tier surplus 分配策略 |

### `budget_split` 详解

- **`'even'` (默认)**: 第一个 dispatchable tier 获得全部 surplus。最大化免费资源利用。
- **`'weighted'`**: 先锁定所有显式 `tier_attempts`，再计算 `remaining = max_attempts - sum(explicit tier_attempts)`；`remaining` 只按每个未显式配置且当前 dispatchable 的 tier 的 live 节点数比例分配。显式 cap 不参与补差或 remainder reconciliation。

**示例** (`max_attempts=6`, Tier 2=1 节点, Tier 3=4 节点, Tier 1 不可达):

```json
{ "balanced": { "max_attempts": 6, "budget_split": "even" } }
// → Tier 2: 5, Tier 3: 1
{ "spread":   { "max_attempts": 6, "budget_split": "weighted" } }
// → Tier 2: 1, Tier 3: 5
```

显式覆盖示例：

```json
{ "spread": { "max_attempts": 6, "tier_attempts": { "tier2": 3 }, "budget_split": "weighted" } }
// → Tier 2 始终为 3；剩余 3 只分配给未显式配置且可调度的 Tier
```

详细算法与示例见 [reliability-model.md → Adaptive Budget](../architecture/reliability-model.md#adaptive-budget-r5-v130)。

### 内置策略 (always present, user config merges on top)

| Name | max_attempts | hedge | budget_split | 用途 |
|---|---|---|---|---|
| `default` | 5 | enabled | `null` (= even) | 平衡模式 |
| `fast` | 1 | disabled | `null` | 速度优先 |
| `stable` | 5 | enabled, tier1 only | `null` | 可靠性优先 |
| `long-reasoning` | 3 | disabled | `null` | 长推理（first_event 120s） |

未知字段被拒绝（产生 diagnostic），非法值产生 fatal 配置错误。详细校验规则在 `scripts/gateway-configuration-test.mjs` 中。

## Configuration Status

| 状态 | 条件 |
|---|---|
| `unconfigured` | 未配置任何可用 Gateway Access Key，或任何 `TIER*_NODES_CONFIG_*` 缺失 |
| `invalid` | 配置存在但零可用节点，或结构冲突 |
| `degraded` | 部分节点不可用，至少一个可用 |
| `ready` | 所有声明节点可用 |

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入值
npm run dev
```
