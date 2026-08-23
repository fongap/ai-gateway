[简体中文](README.md) | [English](README_EN.md)

# AI Agent Node Scheduler

**Personal AI Agent Resource Scheduling Layer**


[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-43853d?logo=node.js&logoColor=white)](package.json)

运行在 Cloudflare Workers 上的个人 AI Agent 资源调度层。以 `free-node / paid-node / plus-node` 三层节点模型管理多个 AI 服务商资源，为 Coding Agent、办公 Agent 和本地 AI 应用提供低成本、高可靠、可自动故障切换的统一入口。

- OpenAI Chat Completions：`/v1/chat/completions`
- Anthropic Messages / Claude Code：`/v1/messages`
- Anthropic Token Count：`/v1/messages/count_tokens`

## 为什么需要它

AI Agent 需要同时管理多个模型供应商、不同资源等级、不同接口稳定性和临时限流。直接在每个 Agent 中维护这些差异，会导致配置分散、切换困难，并把故障处理逻辑重复写入多个应用。

AI Agent Node Scheduler 提供一个统一入口，用于：

- 将服务商和 API Key 隐藏到 Node 抽象之后，避免架构被特定免费 API 绑死；
- 以 `free → paid → plus` 三层资源池自动调度，优先使用免费资源；
- 在节点异常时自动切换至同层或更高层节点；
- 统一 OpenAI 与 Anthropic 两种接入方式；
- 面向 Agent 稳定运行，支持长连接、工具调用和流式响应；
- 在不引入独立服务器或数据库的情况下完成边缘部署。

## 架构

```
Logical Model (MODELS_CONFIG)
    ↓
Policy (POLICIES_CONFIG)
    ↓
Node Scheduler
    ↓
Node Pool (NODES_CONFIG)
    ↓
Provider / Account / API Key (secret_ref 环境变量)
```

### 三层 Node Pool

| 层级 | 名称 | 特点 | 默认用途 |
|------|------|------|----------|
| `free-node` | 免费资源池 | 成本最低，稳定性不确定 | 默认优先 |
| `paid-node` | 付费资源池 | 稳定性较高，成本可接受 | 主要 fallback |
| `plus-node` | 增强资源池 | 最高可靠性，成本最高 | 关键任务、Coding 长任务 |

默认调度顺序：`free → paid → plus`。禁止因为 paid/plus 更快而自动抢占 free。

### 代码结构

```text
src/
├─ index.js                   主入口，Node Scheduler 请求处理
├─ config/
│  ├─ nodes.js                Node 配置加载 + 节点模型映射
│  ├─ models.js               Model 逻辑模型加载
│  ├─ policies.js             Policy 策略加载
│  └─ node-state.js           Node 运行时状态管理
├─ scheduler/
│  ├─ selector.js             Node 选择器（按 tier/priority/health/latency）
│  └─ router.js               路由规划
├─ reliability/
│  ├─ health.js               健康检查响应
│  ├─ circuit.js              轻量 Circuit Breaker
│  └─ retry.js                Retry Budget + 超时拆分
├─ stream/
│  └─ guard.js                First Event Guard
└─ protocol/
   ├─ openai.js               OpenAI 协议工具
   └─ anthropic.js            Anthropic 协议工具
```

## 核心能力

- **Node 三层调度**：free/paid/plus 资源池，按 workload/model/tier/priority/cooldown/circuit/concurrency/health/latency 排序；
- OpenAI 与 Anthropic 双协议接入；
- 默认启用路径与方法白名单；
- 节点级 429 冷却与 Retry-After 支持，不整个 Provider 禁用；
- 503/502/504 轻量 Circuit Breaker，3 次同类失败后短暂熔断；
- First Event Guard：流式请求在首个有效 event 前允许 failover，之后禁止透明切换；
- 超时拆分：`UPSTREAM_HEADERS_TIMEOUT` / `FIRST_EVENT_TIMEOUT` / `STREAM_IDLE_TIMEOUT`；
- Retry Budget：free ≤2、paid ≤1、plus ≤1，总计 ≤5；
- 客户端取消不处罚节点；
- 按上游 hostname 配置模型映射、能力和独立 `invoke_url`；
- 支持普通响应、流式响应、图片和工具调用转换；
- 提供公开的 `/version`；
- 提供鉴权保护且支持多端点容错的 `/v1/models`；
- 提供鉴权保护的 `/health` 与 `/metrics`；
- 可选接入 Cloudflare Analytics Engine。

## 适用边界

该项目用于把多个 OpenAI 兼容上游统一为一个稳定入口。它不是 Anthropic 官方代理，也不能让第三方模型自动获得 Anthropic 原生 thinking 签名、精确 Token 统计或全部协议语义。

`/health` 与 `/metrics` 展示的是当前 Worker isolate 的局部运行状态，不是 Cloudflare 全球节点聚合统计。Node 运行状态只保存在 Worker 内存中，不使用 KV、D1 或 Durable Objects。

## 最快部署

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

### Linux / macOS

```bash
chmod +x scripts/*.sh
./scripts/install.sh
```

安装脚本会完成 Node.js 检查、完整测试、Wrangler dry-run、Cloudflare 账户确认、配置校验、临时 Secrets 文件部署和可选在线验证。临时文件会在结束后删除。

真实凭据不会写入仓库。

### 已有 Worker 的更新与重新配置

只更新代码并保留现有运行时变量和 Secret：

```powershell
.\scripts\update.ps1
```

```bash
./scripts/update.sh
```

修改密钥、模型映射或 Fallback：

```powershell
.\scripts\reconfigure.ps1
```

```bash
./scripts/reconfigure.sh
```

`wrangler.jsonc` 已声明 `keep_vars: true`，代码更新不会读取或删除已有 Secret。首次部署不要求预先存在 Secret；未完成配置时，Worker 会正常上线，但受保护接口会返回明确的配置错误。

## 从 GitHub 自动部署到 Cloudflare

### 单个 Worker

1. 将本仓库推送到 GitHub；
2. 在 Cloudflare 控制台创建或选择目标 Worker；
3. 在 Worker 的 **Settings → Builds** 中连接本仓库和生产分支 `main`；
4. 使用以下构建配置：

```text
Root directory: /
Build command: npm run build
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

5. 点击 **Save and Deploy**，先完成 Worker 的首次部署；
6. 打开 `https://YOUR-WORKER.workers.dev/`，此时会显示"Worker 已部署，等待完成配置"的初始化页面；
7. 在该 Worker 的 **Settings → Variables and Secrets** 中添加 `GATEWAY_ACCESS_KEY` 与 `NODES_CONFIG`，类型选择 **Secret**，然后点击 **Deploy**；
8. 配置生效后，初始化页面会在 5 秒内自动刷新到正常网关主页。

### 一个仓库部署多个 Workers

相同源码可以直接绑定多个已有 Worker，不需要复制仓库。每个 Worker 必须在自己的 **Settings → Variables and Secrets** 中独立配置运行时 Secret。

详细步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 配置

通过三个 JSON Secret 配置完整的 Node 调度系统：

| 变量 | 说明 |
|------|------|
| `NODES_CONFIG` | JSON 数组，定义 free/paid/plus 节点 |
| `MODELS_CONFIG` | JSON 对象，逻辑模型到 workload/policy 的映射 |
| `POLICIES_CONFIG` | JSON 对象，策略定义 |
| `FREE_NODE_01` 等 | 节点 `secret_ref` 指向的环境变量（`Token@BaseURL` 格式） |

**NODES_CONFIG 示例：**

```json
[
  {"id":"free-node-01","tier":"free","priority":100,"provider":"provider-a","secret_ref":"FREE_NODE_01","workloads":["general","coding"],"models":{"general-air":"free-provider/model-air","code-pro":"free-provider/code-pro"},"limits":{"concurrency":2}},
  {"id":"paid-node-01","tier":"paid","priority":80,"secret_ref":"PAID_NODE_01","workloads":["general","coding"],"models":{"code-pro":"paid-provider/code-pro"},"limits":{"concurrency":5}},
  {"id":"plus-node-01","tier":"plus","priority":50,"secret_ref":"PLUS_NODE_01","workloads":["coding","critical"],"models":{"code-max":"plus-provider/code-max"},"limits":{"concurrency":3}}
]
```

**MODELS_CONFIG 示例：**

```json
{
  "general-air": {"workload":"general","policy":"general-fast"},
  "code-pro": {"workload":"coding","policy":"coding-stable"},
  "code-max": {"workload":"coding","policy":"coding-stable"}
}
```

**POLICIES_CONFIG 示例：**

```json
{
  "general-fast": {"tiers":["free","paid"],"max_attempts":3,"retry_budget":{"free":2,"paid":1}},
  "coding-stable": {"tiers":["free","paid","plus"],"max_attempts":4,"retry_budget":{"free":2,"paid":1,"plus":1}}
}
```

配置示例文件见 `config/nodes.example.json`、`config/models.example.json`、`config/policies.example.json`。

### Node 命名规范

统一格式：`{tier}-node-{number}`

```
free-node-01
free-node-02
paid-node-01
plus-node-01
```

禁止使用 `key1`、`token1`、`provider-key1`、`backup-key` 等命名。Node ID 会出现在日志、错误和健康状态中，必须人工可读。

## 客户端调用

### OpenAI 兼容

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"general-air","messages":[{"role":"user","content":"Hello"}]}'
```

### Claude Code

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://YOUR-WORKER.workers.dev",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_GATEWAY_ACCESS_KEY",
    "ANTHROPIC_MODEL": "code-pro"
  }
}
```

## 诊断接口

### 查看版本

```bash
curl https://YOUR-WORKER.workers.dev/version
```

### 模型列表

```bash
curl https://YOUR-WORKER.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

### 健康检查

```bash
curl https://YOUR-WORKER.workers.dev/health \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

### Metrics

```bash
curl https://YOUR-WORKER.workers.dev/metrics \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

`/health` 和 `/metrics` 同时提供客户端请求统计和各节点的尝试数、成功数、失败数、活动连接和平均延迟。一次客户端请求可能产生多次节点尝试。所有数据随 isolate 回收而重置。

## 可靠性机制

### 429 处理

429 视为 Node 级限制：单个节点冷却，切换至同层其他节点或更高层。支持 `Retry-After` 头。不整个 Provider 禁用。

### 503 熔断

503/502/504 视为节点或 Provider 异常。3 次同类失败后轻量 Circuit Breaker 开启（30 秒），之后进入 half-open 状态试探。不一次失败永久禁用。

### First Event Guard

流式请求中 HTTP 200 不代表成功。Gateway 等待第一个有效 event 后才确认成功并提交给客户端。首 event 前允许 failover（包括空流、连接重置、畸形 SSE、超时）。首 event 后禁止透明切换，避免 tool call 重复和 JSON 损坏。

### Retry Budget

| Workload | free | paid | plus | 总计 |
|----------|------|------|------|------|
| General | ≤2 | ≤1 | - | ≤3 |
| Coding | ≤2 | ≤1 | ≤1 | ≤4 |

总计不超过 5 次，禁止 retry storm。

## 本地验证

```bash
npm ci
npm run verify
npm run check:deploy
```

验证内容包括：

- Worker JavaScript 语法；
- 版本号一致性；
- Markdown 本地链接；
- Dashboard、`/version`、`/v1/models`、`/health`、`/metrics` 冒烟测试；
- Node Scheduler 调度测试（12 项）；
- 可靠性测试（12 项：429 冷却、503 熔断、Retry-After、Retry Budget、超时拆分、Client Abort 等）；
- 常见密钥格式扫描。

## 安全

- 不要提交 `.dev.vars`、`.env`、`secrets*.json`；
- 不要在 Issue 中粘贴真实 Token、完整鉴权头或用户请求正文；
- 不要通过 URL 查询参数传递网关密钥；
- 日志禁止输出 API Key、Token、Prompt、Response，只允许输出 Node ID；
- `ALLOW_UNSAFE_PROXY_ROUTES=false`、`ALLOW_INSECURE_HTTP_UPSTREAM=false`、`EXPOSE_UPSTREAM_INFO=false` 为默认安全策略；
- 已泄露的密钥必须立即作废并重新生成；
- 漏洞请通过 GitHub Security Advisory 私密报告。

详见 [SECURITY.md](SECURITY.md)。

## 贡献

提交前运行：

```bash
npm ci
npm run verify
```

详细要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT License](LICENSE)
