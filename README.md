# 智能边缘网关

一个部署在 Cloudflare Workers 上的 AI API 网关，同时兼容：

- OpenAI Chat Completions：`/v1/chat/completions`
- Anthropic Messages / Claude Code：`/v1/messages`
- Anthropic Token Count：`/v1/messages/count_tokens`

请求优先进入 Primary 端点池；仅当 Primary 全部失败时才进入 Fallback。支持模型映射、端点健康评分、并发限制、冷却、重试、流式转换、工具调用和基础诊断。

## 项目定位

该项目用于把多个 OpenAI 兼容上游统一为一个稳定入口。它不是 Anthropic 官方代理，也不保证所有第三方模型完整实现 Anthropic 的 thinking、签名和 token 统计语义。

## 目录

```text
.
├─ src/index.js                  Worker 完整源码
├─ config/                       配置示例
├─ scripts/                      Windows / Linux / macOS 部署与检查脚本
├─ docs/                         部署、配置和架构说明
├─ wrangler.jsonc                Wrangler 配置
├─ package.json                  npm 命令与 Wrangler 版本
├─ LICENSE                       MIT License
├─ SECURITY.md                   安全报告方式
├─ OPEN_SOURCE_CHECKLIST.md      开源发布检查清单
└─ CHANGELOG.md                  版本记录
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

脚本会依次完成：

1. 检查 Node.js 与 npm；
2. 安装固定版本的 Wrangler；
3. 登录 Cloudflare；
4. 询问 Worker 名称、网关访问密钥和上游配置；
5. 将密钥写入临时 JSON；
6. 使用 `wrangler deploy --secrets-file` 一次上传代码与 Secrets；
7. 删除临时密钥文件。

仓库不会保存真实密钥。

## 手动部署

```bash
npm install
npm run verify
npx wrangler login
npx wrangler deploy --secrets-file ./secrets.production.json
```

`secrets.production.json` 示例：

```json
{
  "GATEWAY_ACCESS_KEY": "replace-with-a-long-random-key",
  "PRIMARY_API_TOKENS": "token@https://primary.example/v1"
}
```

部署完成后立即删除该文件，且不要提交到 Git。

## 最小配置

| 变量 | 是否必需 | 说明 |
|---|---|---|
| `GATEWAY_ACCESS_KEY` | 是 | 客户端访问网关的密钥 |
| `PRIMARY_API_TOKENS` | 是 | 一个或多个上游 Token；支持 `Token@BaseURL` |
| `PRIMARY_BASE_URL` | 条件必需 | Token 未绑定 URL 时使用 |
| `MODEL_MAPPING` | 否 | 客户端模型名到实际上游模型 ID 的映射 |

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

## 健康检查

浏览器直接打开 `/health` 会返回 401，因为该端点需要鉴权。

Windows：

```powershell
.\scripts\health-check.ps1
```

Linux / macOS：

```bash
./scripts/health-check.sh
```

`/health` 与 `/metrics` 展示的是当前 Worker isolate 的局部状态，不是跨全球节点的精确日统计。一次客户端请求可能重试多个上游，因此端点请求次数也不等于客户端请求次数。

## 可选 Analytics Engine

源码在存在 `AE_DATASET` binding 时会异步写入趋势数据。默认 `wrangler.jsonc` 不启用该 binding，避免为普通部署增加额外写入和配置。

启用方式见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

## 开源发布前检查

```bash
npm run verify
```

随后执行发布打包脚本：

```powershell
.\scripts\build-release.ps1
```

或：

```bash
./scripts/build-release.sh
```

发布到 GitHub 前请逐项检查 [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md)。

## 许可证

MIT License。详见 [LICENSE](LICENSE)。
