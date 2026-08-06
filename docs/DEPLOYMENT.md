# 部署说明 / Deployment

## 运行要求

- Node.js 20 或更高版本；
- npm；
- Cloudflare 账户；
- 至少一个 OpenAI 兼容上游 Token 和 HTTPS Base URL。

仓库不把 Wrangler 安装到本地依赖中。所有脚本固定调用：

```text
npx --yes wrangler@4.114.0
```

因此 `package-lock.json` 不包含大型 CLI 依赖，`npm ci` 只验证项目元数据和锁文件一致性。

## 方式一：首次安装

### Windows

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-and-deploy.ps1
```

### Linux / macOS

```bash
chmod +x scripts/*.sh
./scripts/setup-and-deploy.sh
```

脚本会：

1. 检查 Node.js、npm 和 Worker 名称；
2. 执行 `npm ci` 与本地测试；
3. 登录 Cloudflare；
4. 收集网关、Primary、模型映射和可选 Fallback；
5. 显式写入默认安全开关；
6. 使用临时 JSON 文件将代码与 Secrets 一次上传；
7. 使用 `--keep-vars` 保留控制台已有普通变量；
8. 部署结束后删除临时文件。

未启用 Fallback 时，脚本会明确写入：

```text
FALLBACK_ENABLED=false
FALLBACK_SECONDARY_MODEL=off
```

因此旧 Fallback 配置即使仍存在，也不会继续参与路由。

## 方式二：安全更新已有 Worker

只更新代码，不改现有 Secrets：

```powershell
.\scripts\deploy.ps1
```

或：

```bash
./scripts/deploy.sh
```

`wrangler.jsonc` 已设置：

```json
"keep_vars": true
```

部署命令同时显式使用 `--keep-vars`。控制台中的普通运行时变量不会因代码更新被删除；Cloudflare Secrets 也不会被普通部署删除。

要显式关闭旧 Fallback：

```powershell
.\scripts\disable-fallback.ps1
```

或：

```bash
./scripts/disable-fallback.sh
```

## 方式三：GitHub 自动部署

### 1. 上传仓库

仓库根目录必须直接包含：

```text
wrangler.jsonc
package.json
package-lock.json
src/
```

### 2. 关联 Cloudflare

进入：

```text
Workers & Pages
→ Create application
→ Import a repository
```

建议配置：

```text
Production branch: main
Root directory: /
Build command: npm run verify
Deploy command: npx --yes wrangler@4.114.0 deploy --keep-vars
Non-production deploy command: npx --yes wrangler@4.114.0 versions upload --keep-vars
```

Cloudflare Worker 名称必须与 `wrangler.jsonc` 的 `name` 一致。

### 3. 配置运行时 Secrets

进入：

```text
Worker
→ Settings
→ Variables and Secrets
```

至少添加：

```text
GATEWAY_ACCESS_KEY   Secret
PRIMARY_API_TOKENS   Secret
```

按需添加：

```text
PRIMARY_BASE_URL
MODEL_MAPPING
FALLBACK_ENABLED
FALLBACK_API_TOKEN
FALLBACK_BASE_URL
FALLBACK_PRIMARY_MODEL
FALLBACK_SECONDARY_MODEL
```

构建阶段变量不能替代 Worker 运行时变量。保存运行时配置后必须部署新版本。

## 手动部署

首次部署并同时写入 Secrets：

```bash
npm ci
npm run verify
npx --yes wrangler@4.114.0 login
npx --yes wrangler@4.114.0 deploy --keep-vars --secrets-file ./secrets.production.json
```

示例：

```json
{
  "GATEWAY_ACCESS_KEY": "replace-with-a-long-random-key",
  "PRIMARY_API_TOKENS": "token@https://primary.example/v1",
  "FALLBACK_ENABLED": "false",
  "FALLBACK_SECONDARY_MODEL": "off",
  "FAKE_STREAM_PROTECTION": "false",
  "ALLOW_UNSAFE_PROXY_ROUTES": "false",
  "ALLOW_INSECURE_HTTP_UPSTREAM": "false",
  "EXPOSE_UPSTREAM_INFO": "false"
}
```

使用后立即删除该文件，且不得提交到 Git。

## 自定义域名与 workers.dev

默认 `wrangler.jsonc` 设置：

```json
"workers_dev": true
```

这适合首次部署和开源演示。正式使用自定义域名且不希望保留 `workers.dev` 入口时，把它改为：

```json
"workers_dev": false
```

再部署。不要只在控制台关闭后保留配置文件中的 `true`，否则后续 Wrangler 部署可能重新启用该入口。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

`.dev.vars` 已加入 `.gitignore`。本地开发可按需填入普通变量和 Secret。

## 部署前检查

```bash
npm ci
npm run verify
npm run check:deploy
```

`check:deploy` 使用 Wrangler dry-run 编译项目，不会上传到 Cloudflare。

## 部署后验证

公开版本接口：

```bash
curl https://YOUR-WORKER.workers.dev/version
```

模型列表：

```bash
./scripts/models-check.sh https://YOUR-WORKER.workers.dev
```

健康检查：

```bash
./scripts/health-check.sh https://YOUR-WORKER.workers.dev
```

PowerShell 对应脚本名称相同，扩展名为 `.ps1`。脚本会先校验 URL，避免把占位文字传给 `curl` 后出现 `Bad hostname`。

## 回滚建议

更新生产 Worker 前，先在 Cloudflare Deployments 中确认上一个可用版本。新版本异常时，应优先使用 Cloudflare 的版本回滚，而不是立即修改多个运行时变量。
