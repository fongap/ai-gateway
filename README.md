[简体中文](README.md) | [English](README_EN.md)

# ai-gateway

**Free-API-first AI Gateway for Cloudflare Workers**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-43853d?logo=node.js&logoColor=white)](package.json)

> ⚠️ **Breaking Change**：本版本重新设计了 Node 配置与 Secret 管理（`TIERx_NODES_CONFIG_*` 普通变量 + `NODE_SECRETS_*` Secret），不再兼容旧的 `token@base_url` / 内嵌凭据格式。旧部署请按下方说明重新配置。

## 它解决什么问题

把多个容易限流、失效、抖动的免费 API / API Key，聚合成一个尽可能稳定、轻量、自动恢复的统一 AI API：

```text
多个免费 API / Key
        ↓
   ai-gateway
        ↓
节点选择 / 负载分散（priority + concurrency）
429 隔离 / Retry-After 冷却
失败切换 / Circuit Breaker
自动恢复 / HALF_OPEN 单探测
流式 First Event Guard
        ↓
客户端只看到一个稳定 Endpoint
```

设计决策只回答四个问题：是否提高免费 API 利用率？是否提高稳定性？是否降低 Worker 自身开销？代码是否更可预测？

- OpenAI Chat Completions：`/v1/chat/completions`
- Anthropic Messages / Claude Code：`/v1/messages`
- Anthropic Token Count：`/v1/messages/count_tokens`

不做数据库、Redis、KV 状态同步、多租户、计费、Semantic Cache。运行状态是 Worker isolate 内存中的 best-effort 状态。

## 快速开始

```bash
git clone https://github.com/fongap/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh     # Windows: powershell scripts/install.ps1
```

install 会引导你完成：Worker 命名 → 项目校验 → Cloudflare 登录 → 输入 Node 配置 JSON → 输入 Credential JSON → 分片校验 → 部署 → 写入 Secrets → 在线验证。

### Node 配置（普通变量，不含任何密钥）

典型配置是**多 Key、多账户、多模型**。下面的 tier-1 示例混跑了三个免费 provider 的五个账号，对外暴露三个逻辑模型：

```json
[
  { "id": "nvidia-01", "provider": "nvidia",   "base_url": "https://integrate.api.nvidia.com/v1", "priority": 10,
    "models": { "general-air": "deepseek-ai/deepseek-v3.1", "code-pro": "qwen/qwen3-coder-480b" }, "limits": { "concurrency": 3 } },
  { "id": "nvidia-02", "provider": "nvidia",   "base_url": "https://integrate.api.nvidia.com/v1", "priority": 10,
    "models": { "general-air": "deepseek-ai/deepseek-v3.1", "code-pro": "qwen/qwen3-coder-480b" }, "limits": { "concurrency": 3 } },
  { "id": "glm-01",    "provider": "zhipu",    "base_url": "https://open.bigmodel.cn/api/paas/v4", "priority": 20,
    "models": { "general-air": "glm-4.7", "code-max": "glm-4.7" }, "limits": { "concurrency": 2 } },
  { "id": "cerebras-01", "provider": "cerebras", "base_url": "https://api.cerebras.ai/v1", "priority": 20,
    "models": { "code-pro": "llama-3.3-70b", "code-max": "llama-3.3-70b" }, "limits": { "concurrency": 2 } }
]
```

对应的凭据 Secret（`NODE_SECRETS_01`）：

```json
{
  "nvidia-01": "nvapi-aaaaaaaa",
  "nvidia-02": "nvapi-bbbbbbbb",
  "glm-01":    "cccccccc.xxxxxxxx",
  "cerebras-01": "csk-dddddddd"
}
```

**组织约定**（这也是调度器发挥最大效果的方式）：

可直接编辑的完整示例见 [`config/`](config/) 目录（tier-1/tier-2 节点、凭据、models、policies 各一份）。

| 场景 | 配置方式 | 效果 |
|------|----------|------|
| 同一 provider 多账号 / 同一档位多 key | 放同一层、**priority 相同** | LRU 自动把顺序流量轮转摊到所有 key 上，首个 429 出现前可用配额 ≈ key 数 × 单 key 配额 |
| 同层内表达偏好 | 不同 `priority`（10 先于 20） | 小值优先；大值只在小值节点全忙/冷却/熔断后接管 |
| 备用键、付费键、兜底账号 | 放下一层 tier | 层是硬优先级：tier-1 有可用节点绝不消耗 tier-2 |
| 一个节点服务多个逻辑模型 | `models` 里写多条映射 | 每个逻辑模型可映射到各节点不同的上游名 |
| 万能兜底节点 | `"models": {}` 通配 | 任何请求都能落到它 |

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 稳定主键；`^[a-z0-9][a-z0-9-]{0,63}$`；全仓库唯一 |
| `provider` | 可选标签，用于诊断展示 |
| `base_url` | 必须 `https://`；不允许内嵌用户名/密码 |
| `priority` | 数值越小优先级越高，默认 100；同层同级 = 轮转摊流 |
| `models` | 逻辑模型 → 上游模型映射；空对象 = 通配所有逻辑模型 |
| `limits.concurrency` | 节点并发上限，默认 2；按上游账号的实际限流配置 |
| `limits.rpm` | 可选；该 key 每分钟请求软配额（如 `25`），到量后同层兄弟 key 优先 |

配置变量命名：

```text
TIER1_NODES_CONFIG_01, TIER1_NODES_CONFIG_02, ...   ← tier-1（第一资源池）
TIER2_NODES_CONFIG_01, ...                          ← tier-2（次级资源池）
TIER3_NODES_CONFIG_01, ...                          ← tier-3（最终兜底）
NODE_SECRETS_01, NODE_SECRETS_02, ...               ← Secret：{ "node-id": "credential" }
GATEWAY_ACCESS_KEY                                  ← Secret：客户端访问密钥
```

- Tier 只由变量前缀决定；节点 JSON 中出现 `tier` 字段会被拒绝。
- 单片上限 4500 字节（Cloudflare 变量限制为 5 KB，留有余量）；分片按完整 Node 边界切分，几十个节点自动拆成多个 `_02/_03...` 分片。
- 部署前校验：Duplicate ID、Missing Credential、Orphan Credential、Invalid URL、非法字段都会提前失败。

### 客户端接入

OpenAI 兼容客户端 Base URL 使用网关地址的 `/v1`；Claude Code 设置 `ANTHROPIC_BASE_URL` 为网关地址（不带 `/v1`），`ANTHROPIC_AUTH_TOKEN` 为 `GATEWAY_ACCESS_KEY`。

## 调度行为

| 场景 | 行为 |
|------|------|
| 选择 | 同层内单次 O(n) 扫描：priority ASC → activeRequests ASC → health（带内视为持平）→ lastUsedAt（LRU 轮转）→ latency ASC；同优先级空闲节点按最久未用轮转，把顺序流量摊开以减少 429 |
| 并发分散 | 多个 concurrency=1 的节点会自然摊开并发请求 |
| 429 | 只冷却当前节点，优先读取 `Retry-After`（秒或 HTTP-date，钳制 1s–600s），同层其他节点继续服务 |
| RPM 配额 | 节点可声明 `limits.rpm`（软上限）：未到配额的兄弟 key 优先；全部到配额时仍照常服务（不硬拒） |
| 容量饱和 | 全部候选节点并发/RPM 打满时返回 `503 + Retry-After: 1`，让多智能体客户端退避而非立即重试 |
| 断流 | 中途断开/空闲超时：已缓冲字节送达客户端，节点记为失败；透传流缺少 `[DONE]` 的"干净"提前关闭同样计为失败 |
| 401/403 | 视为凭据问题，该节点长冷却并退出当前请求候选 |
| 400/413/415/422 | 请求本身错误，立即返回，不换节点重放 |
| 5xx/网络/超时 | 失败计数 → 同层轮换 → 连续 3 次 OPEN 熔断 30s |
| Tier fallback | 仅当当前层没有任何 Eligible Node 时才进入下一层 |
| 自动恢复 | 冷却到期自动回池；OPEN → HALF_OPEN 单探测 → 成功 CLOSED |
| 流式 | 首个有效事件前可切换节点；之后绝不透明切换 |

Circuit 是连续失败状态机（非滑动窗口）：CLOSED →(连续 3 次 5xx/网络/超时)→ OPEN →(30s)→ HALF_OPEN → 单探测 → 成功 CLOSED / 失败重新 OPEN。429 与 401 不计入熔断。

## 配置状态

| 状态 | 含义 |
|------|------|
| `unconfigured` | 关键配置不存在 |
| `invalid` | 存在配置但无法构造任何可用 Node（含 Duplicate ID 等结构性冲突） |
| `degraded` | 部分 Node 无效但仍可服务 |
| `ready` | 全部声明节点可用 |

`GET /health`（需鉴权）返回每个节点的健康、冷却、熔断与并发快照及配置诊断信息。

## 运行参数（全部可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAX_BODY_BYTES` | 20 MiB | 请求体上限 |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 120000 (5s–600s) | 上游响应头超时 |
| `FIRST_EVENT_TIMEOUT_MS` | 60000 (5s–600s) | 流式首事件超时 |
| `STREAM_IDLE_TIMEOUT_MS` | 120000 (10s–600s) | 流式空闲超时 |
| `RATE_LIMIT_COOLDOWN_MS` | 60000 (1s–600s) | 无 Retry-After 时的 429 冷却 |
| `AUTH_FAIL_COOLDOWN_MS` | 3600000 (1min–7d) | 401/403 凭据冷却 |
| `ALLOWED_ORIGIN` | 未设置 | 未设置时 CORS 完全关闭；设置具体 origin 或 `*` 开启 |
| `EXPOSE_UPSTREAM_INFO` | false | true 时在诊断中暴露上游 host/path |
| `FAKE_STREAM_PROTECTION` | false | 非 stream 请求转上游流式再重组 |
| `ALLOW_INSECURE_HTTP_UPSTREAM` | false | 允许 http:// 上游（不推荐） |
| `MODELS_CONFIG` | — | `{ "逻辑模型": { "policy": "策略名" } }` |
| `POLICIES_CONFIG` | — | `{ "策略名": { "max_attempts": 5 } }` |
| `LOG_LEVEL` | info | none/error/info/debug |

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | Dashboard（浏览器） |
| GET | `/version` | 版本与配置状态（公开） |
| GET | `/health` `/metrics` `/v1/models` | 诊断端点（需鉴权） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/messages` `/v1/messages/count_tokens` | Anthropic Messages |

## 安全模型

- 客户端鉴权：Bearer 或 `x-api-key`，SHA-256 摘要 timing-safe 比较。
- Header allowlist：客户端的 Cookie / Forwarded / CF 私有头等不会转发给上游；上游 Authorization 只由 Runtime Node credential 生成。
- 上游仅允许 `https://`（可显式放开 http），`redirect: 'manual'` 禁止带凭据跟随重定向。
- Credential 永不出现在任何响应、日志或诊断端点中。
- 平台层防护建议使用 Cloudflare WAF / Rate Limiting Rules（以 [官方文档](https://developers.cloudflare.com/waf/) 当前能力为准），Worker 内不维护全局限流状态。

## 性能

调度候选选择是每次尝试前的单次 O(n) 扫描；静态配置在 isolate 内解析一次；SSE 事件全程只解析一次。`node benchmark/benchmark.mjs --quick` 可在本机测量 Gateway 相对直连 Mock Upstream 的附加开销（p50/p95/p99/RPS）。README 不发布跨项目绝对性能对比。

更多内容见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/CONFIGURATION.md](docs/CONFIGURATION.md)、[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## License

[MIT](LICENSE)
