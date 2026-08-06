# 部署说明 / Deployment

## 运行要求

- Node.js 20 或更高版本；
- npm；
- Cloudflare 账户；
- 至少一个 OpenAI 兼容上游 Token 和 HTTPS Base URL。

项目固定调用：

```text
npx --yes wrangler@4.114.0
```

`wrangler.jsonc` 同时启用：

```json
{
  "keep_vars": true,
  "secrets": {
    "required": [
      "GATEWAY_ACCESS_KEY",
      "PRIMARY_API_TOKENS"
    ]
  }
}
```

`keep_vars` 用于在代码更新时保留控制台中的普通运行时变量；`secrets.required` 用于阻止缺少必需 Secret 的错误部署。脚本不会读取已有 Secret 明文，因为 Cloudflare 不提供已保存 Secret 的明文回读。

## 三种操作模式

### 1. 首次安装

Windows：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

Linux / macOS：

```bash
chmod +x scripts/*.sh
./scripts/install.sh
```

兼容入口 `setup-and-deploy.ps1` 和 `setup-and-deploy.sh` 会转到同一安装脚本。

安装脚本会：

1. 检查 Node.js、npm 和 Worker 名称；
2. 执行 `npm ci`、完整测试与 Wrangler dry-run；
3. 显示当前 Cloudflare 登录账户；
4. 校验 Primary、`MODEL_MAPPING` 和可选 Fallback；
5. 使用权限受限的临时 JSON 文件部署代码与 Secrets；
6. 结束后删除临时文件；
7. 可选执行 `/version`、`/health` 和 `/v1/models` 在线验证。

### 2. 安全更新代码

Windows：

```powershell
.\scripts\update.ps1
```

Linux / macOS：

```bash
./scripts/update.sh
```

兼容入口 `deploy.ps1` 和 `deploy.sh` 会转到同一更新脚本。

安全更新只执行代码部署：

```text
wrangler deploy --keep-vars
```

它不会尝试读取或重写已有 Secret。由于 `secrets.required` 已声明，当前 Worker 缺少 `GATEWAY_ACCESS_KEY` 或 `PRIMARY_API_TOKENS` 时，部署应直接失败，而不是发布一个运行后才报错的版本。

### 3. 重新配置运行时变量

Windows：

```powershell
.\scripts\reconfigure.ps1
```

Linux / macOS：

```bash
./scripts/reconfigure.sh
```

该脚本使用 `wrangler secret bulk` 更新运行时配置，不重新上传本地代码。关闭 Fallback 时会删除旧 Fallback Secret，而不是仅依赖“留空”。

单独关闭 Fallback：

```powershell
.\scripts\disable-fallback.ps1
```

或：

```bash
./scripts/disable-fallback.sh
```

## GitHub 自动部署到 Cloudflare

1. 将仓库推送到 GitHub；
2. 在 Cloudflare 中导入仓库；
3. Worker 名称必须与 `wrangler.jsonc` 的 `name` 一致；
4. 使用：

```text
Build command: npm run verify
Deploy command: npx --yes wrangler@4.114.0 deploy --keep-vars
Non-production deploy command: npx --yes wrangler@4.114.0 versions upload --keep-vars
```

5. 在实际 Worker 的 **Settings → Variables and Secrets** 中添加运行时 Secret：

```text
GATEWAY_ACCESS_KEY
PRIMARY_API_TOKENS
```

构建变量不能替代 Worker 运行时 Secret。第一次构建因为必需 Secret 缺失而失败时，先创建 Worker/项目、添加上述 Secret，再重新运行部署。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

项目的 `run-wrangler.mjs` 会为本地开发和 dry-run 临时移除 `secrets.required` 配置，使 `.dev.vars` 中的可选变量能够完整加载；临时配置写入项目根目录的随机隐藏文件，确保 Wrangler 能正确解析相对入口和 `.dev.vars`；命令结束后立即删除，且已被 Git 与 Release 打包规则排除。

## 部署前检查

```bash
npm ci
npm run verify
npm run check:deploy
```

`check:deploy` 只编译 Worker，不上传到 Cloudflare。

## 部署后验证

先检查公开版本与绑定状态：

```bash
curl https://YOUR-GATEWAY/version
```

返回中的：

```json
{
  "configuration": {
    "ready": true,
    "gateway_access_key_bound": true,
    "primary_api_tokens_bound": true
  }
}
```

表示当前活动版本已绑定两个必需 Secret。

随后执行：

```bash
curl https://YOUR-GATEWAY/health \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"

curl https://YOUR-GATEWAY/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

Windows CMD 必须使用单行命令，或用 `^` 换行；不要使用 Linux 的反斜杠 `\` 作为 CMD 换行符。

## workers.dev 与自定义域名

仓库默认保留：

```json
"workers_dev": true
```

这样首次部署后有可访问地址。正式只使用自定义域名时，可改为 `false` 后重新部署。该字段属于 Wrangler 声明式配置，不应只在控制台修改后继续保留仓库中的相反值。
