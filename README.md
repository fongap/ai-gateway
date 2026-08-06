[简体中文](README.md) | [English](README_EN.md)

# 智能边缘网关

**Smart Edge Gateway**

[![CI](https://github.com/fongap/smart-edge-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/fongap/smart-edge-gateway/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/fongap/smart-edge-gateway?display_name=tag)](https://github.com/fongap/smart-edge-gateway/releases)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-43853d?logo=node.js&logoColor=white)](package.json)

运行在 Cloudflare Workers 上的轻量 AI API 网关。它把多个 OpenAI 兼容上游统一为一个入口，同时向客户端提供：

- OpenAI Chat Completions：`/v1/chat/completions`
- Anthropic Messages / Claude Code：`/v1/messages`
- Anthropic Token Count：`/v1/messages/count_tokens`

请求优先进入 Primary 端点池；只有 Primary 的有效尝试全部失败后，才进入两级 Fallback。

## 为什么需要它

AI 应用经常需要同时管理多个模型供应商、不同模型 ID、不同接口稳定性和临时限流。直接在每个客户端中维护这些差异，会导致配置分散、切换困难，并把故障处理逻辑重复写入多个应用。

智能边缘网关提供一个统一入口，用于：

- 隔离客户端与上游供应商配置；
- 统一 OpenAI 与 Anthropic 两种接入方式；
- 在主端点异常时自动切换至备用链路；
- 按 hostname 映射模型别名、能力和调用地址；
- 在不引入独立服务器的情况下完成边缘部署。

## 页面预览

![智能边缘网关 Dashboard](docs/screenshots/dashboard.png)

## 架构

![智能边缘网关架构](docs/architecture.svg)

Primary 负责正常流量。Fallback 不参与日常轮询，只在 Primary 尝试耗尽后按顺序接管。详细说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 核心能力

- OpenAI 与 Anthropic 双协议接入；
- 默认启用路径与方法白名单，避免把上游管理接口暴露给网关客户端；
- Primary 与 Fallback 默认强制 HTTPS；
- Primary 多端点轮换、重试、健康评分、硬并发上限与真实冷却排除；
- Primary 全部失败后自动进入两级 Fallback；
- 按实际上游 hostname 配置模型映射、能力和独立 `invoke_url`；
- 支持普通响应、流式响应、图片和工具调用转换；
- 支持 Claude Code 常见请求和并行工具调用；
- 提供公开的 `/version`；
- 提供鉴权保护且支持多端点容错的 `/v1/models`；
- 提供鉴权保护的 `/health` 与 `/metrics`；
- 可选接入 Cloudflare Analytics Engine。

## 适用边界

该项目用于把多个 OpenAI 兼容上游统一为一个稳定入口。它不是 Anthropic 官方代理，也不能让第三方模型自动获得 Anthropic 原生 thinking 签名、精确 Token 统计或全部协议语义。

`/health` 与 `/metrics` 展示的是当前 Worker isolate 的局部运行状态，不是 Cloudflare 全球节点聚合统计，也不等同于费用统计。流式连接在响应体结束或客户端取消后才释放活动计数。

客户端提供 `Idempotency-Key` 时，网关会向上游转发；但网关重试仍无法保证所有第三方供应商都支持幂等性。上游已经收到请求但网关在首字节前超时时，后续重试可能造成重复调用或重复计费。

## 仓库结构

```text
.
├─ src/index.js                  Worker 完整源码
├─ config/                       模型映射示例
├─ scripts/                      部署、检查和发布脚本
├─ docs/                         部署、配置、架构和截图
├─ .github/workflows/            CI 与 GitHub Release
├─ .github/ISSUE_TEMPLATE/       Issue 模板
├─ wrangler.jsonc                Wrangler 配置
├─ package.json                  npm 命令与固定 Wrangler 调用版本
├─ package-lock.json             可重复安装锁文件
├─ README.md                     中文说明
├─ README_EN.md                  English documentation
├─ SECURITY.md                   安全报告方式
├─ CONTRIBUTING.md               贡献说明
├─ OPEN_SOURCE_CHECKLIST.md      开源发布检查清单
└─ LICENSE                       MIT License
```

## 最快部署

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-and-deploy.ps1
```

### Linux / macOS

```bash
chmod +x scripts/*.sh
./scripts/setup-and-deploy.sh
```

脚本会完成 Node.js 检查、锁文件验证、Primary HTTPS 完整性检查、Worker dry-run、Cloudflare 登录、配置收集、安全默认值写入、密钥临时文件生成、Worker 与 Secrets 一次上传，并在部署结束后删除临时密钥文件。未配置 Fallback 时会显式关闭旧 Fallback。

真实凭据不会写入仓库。

## 从 GitHub 自动部署到 Cloudflare

1. 将本仓库推送到 GitHub；
2. 在 Cloudflare 控制台进入 **Workers & Pages → Create application → Import a repository**；
3. 选择该仓库和生产分支 `main`；
4. 确保 Cloudflare Worker 名称与 `wrangler.jsonc` 中的 `name` 一致；
5. 使用以下构建配置：

```text
Root directory: /
Build command: npm run verify
Deploy command: npx --yes wrangler@4.114.0 deploy --keep-vars
Non-production deploy command: npx --yes wrangler@4.114.0 versions upload --keep-vars
```

6. 首次部署后，在 Worker 的 **Settings → Variables and Secrets** 中添加真实配置；
7. 重新部署或再次推送提交。

后续每次推送 `main`，Cloudflare Workers Builds 都会自动验证并发布。非生产分支可生成预览版本。

> 真实 Token 必须存入 Cloudflare Secrets，不能提交到 GitHub。Cloudflare 的构建环境变量也不能替代 Worker 运行时 Secrets。

详细步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 最小配置

| 变量 | 是否必需 | 说明 |
|---|---|---|
| `GATEWAY_ACCESS_KEY` | 是 | 客户端访问网关的密钥 |
| `PRIMARY_API_TOKENS` | 是 | 一个或多个上游 Token；支持 `Token@BaseURL` |
| `PRIMARY_BASE_URL` | 条件必需 | Token 未绑定 URL 时使用 |
| `MODEL_MAPPING` | 否 | 客户端模型名到实际上游模型 ID 的映射 |
| `STRICT_MODEL_MAPPING` | 否 | `true` 时只允许配置中的模型名 |
| `ALLOW_UNSAFE_PROXY_ROUTES` | 否 | 默认 `false`，只开放已支持接口 |
| `FAKE_STREAM_PROTECTION` | 否 | 默认 `false`，按需启用非流式重组 |

Fallback 至少需要：

```text
FALLBACK_API_TOKEN
FALLBACK_BASE_URL
FALLBACK_PRIMARY_MODEL
```

第二兜底规则：

```text
未设置或空值  -> 默认关闭
具体模型名     -> 启用
值为 off       -> 显式关闭
```

完整变量说明见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

## 客户端调用

### OpenAI 兼容

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"model-alias","messages":[{"role":"user","content":"Hello"}]}'
```

### Claude Code

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://YOUR-WORKER.workers.dev",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_GATEWAY_ACCESS_KEY",
    "ANTHROPIC_MODEL": "model-alias"
  }
}
```

## 诊断接口

### 查看版本

`/version` 不需要鉴权：

```bash
curl https://YOUR-WORKER.workers.dev/version
```

### 模型列表

```bash
curl https://YOUR-WORKER.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

网关会跳过冷却中的端点，并在独立超时与最大尝试次数内依次尝试 Primary 上游。某个上游不支持 `/v1/models` 时会继续尝试下一个，并把成功返回的模型与 `MODEL_MAPPING` 中面向客户端的模型别名合并。上游均不提供模型列表时，只要已配置模型映射或 Fallback 模型，仍可返回本地配置的可用模型。

也可以运行：

```powershell
.\scripts\models-check.ps1
```

或：

```bash
./scripts/models-check.sh
```

### 健康检查

```bash
curl https://YOUR-WORKER.workers.dev/health \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

也可以运行：

```powershell
.\scripts\health-check.ps1
```

或：

```bash
./scripts/health-check.sh
```

### Metrics

```bash
curl https://YOUR-WORKER.workers.dev/metrics \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

`/health` 和 `/metrics` 同时提供两组当前 isolate 统计：

- 客户端请求数、成功数、失败数、Fallback 触发数与 Fallback 成功数；
- 各上游端点的尝试数、成功数、失败数、活动连接和平均首字节时间。

一次客户端请求可能产生多次上游尝试，因此两组数字不会相同。所有数据随 isolate 回收而重置，不是全球节点的每日累计值。

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
- 常见密钥格式扫描。

## GitHub Release

推送符合语义化版本格式的 Tag 后，GitHub Actions 会自动：

1. 执行 `npm ci` 和 `npm run verify`；
2. 检查 Tag 是否与 `package.json` 版本一致；
3. 生成 ZIP、TAR.GZ 和 SHA-256；
4. 创建 GitHub Release 并上传资产。

```bash
git tag v5.13.0
git push origin v5.13.0
```

发布规则见 [docs/RELEASE.md](docs/RELEASE.md)。

## 安全

- 不要提交 `.dev.vars`、`.env`、`secrets*.json`；
- 不要在 Issue 中粘贴真实 Token、完整鉴权头或用户请求正文；
- 不要通过 URL 查询参数传递网关密钥；
- 正式更新已有 Worker 使用 `scripts/deploy.*`，它会保留现有普通变量和 Secrets；
- 关闭 Fallback 使用 `scripts/disable-fallback.*`，不要只把新值留空；
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
