# 部署说明 / Deployment

## 运行要求

- Node.js 20 或更高版本；
- npm；
- Cloudflare 账户；
- 至少一个 OpenAI 兼容上游 Token 和 Base URL。

项目固定使用 `package-lock.json` 和 Wrangler `4.114.0`，以减少不同部署环境中的依赖差异。

## 方式一：一键脚本部署

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

1. 检查 Node.js 与 npm；
2. 使用 `npm ci` 安装锁定依赖；
3. 检查或启动 Cloudflare 登录；
4. 收集 Worker 名称与网关配置；
5. 将密钥写入系统临时目录；
6. 使用 `wrangler deploy --secrets-file` 一次上传代码与 Secrets；
7. 部署结束后删除临时密钥文件。

## 方式二：GitHub 自动部署

### 1. 上传仓库

仓库根目录必须直接包含：

```text
wrangler.jsonc
package.json
package-lock.json
src/
```

不要在 GitHub 根目录外再套一层解压目录。

### 2. 关联 Cloudflare

在 Cloudflare 控制台进入：

```text
Workers & Pages
→ Create application
→ Import a repository
```

选择 GitHub 仓库并设定：

```text
Production branch: main
Root directory: /
Build command: npm run verify
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

Cloudflare Worker 名称必须与 `wrangler.jsonc` 的 `name` 一致。默认名称为：

```text
smart-edge-gateway
```

### 3. 配置运行时 Secrets

首次代码部署后，进入：

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

需要共享 Primary 地址时再添加：

```text
PRIMARY_BASE_URL     Text or Secret
```

Fallback Token 必须使用 Secret。模型 ID、Base URL 和普通开关可以使用 Text，但含凭据的 `Token@BaseURL` 整体必须使用 Secret。

保存变量后重新部署。以后推送到 `main` 即可触发 Cloudflare Workers Builds 自动发布。

### 4. 预览分支

启用 Cloudflare 的 non-production branch builds 后，非 `main` 分支会执行：

```text
npx wrangler versions upload
```

该命令上传预览版本但不会直接替换正式部署。

## 方式三：手动 Wrangler 部署

```bash
npm ci
npm run verify
npx wrangler login
npx wrangler deploy --secrets-file ./secrets.production.json
```

示例文件：

```json
{
  "GATEWAY_ACCESS_KEY": "replace-with-a-long-random-key",
  "PRIMARY_API_TOKENS": "token@https://primary.example/v1"
}
```

部署完成后立即删除 `secrets.production.json`，且不得提交到 Git。

## 更新部署

已通过脚本部署并保存 Secrets 后，可运行：

```powershell
.\scripts\deploy.ps1
```

或：

```bash
./scripts/deploy.sh
```

Wrangler 部署代码时不会删除未包含在此次部署中的现有 Secrets。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

`.dev.vars` 已被 `.gitignore` 排除。

## 部署后验证

### 版本

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

未携带密钥访问 `/v1/models`、`/health` 或 `/metrics` 时返回 HTTP 401。

## 自定义域名

默认部署到 `workers.dev`。可在 Worker 的 **Settings → Domains & Routes** 中添加 Custom Domain。不要把个人域名写入开源示例或测试脚本。
