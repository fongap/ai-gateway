# 部署说明

## 运行要求

- Node.js 20 或更高版本
- npm
- Cloudflare 账户
- 至少一个 OpenAI 兼容上游 Token 和 Base URL

项目固定使用 Wrangler `4.114.0`，避免不同部署者因 CLI 行为差异产生不一致。

## 一键部署

### Windows

在项目根目录打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-and-deploy.ps1
```

### Linux / macOS

```bash
chmod +x scripts/*.sh
./scripts/setup-and-deploy.sh
```

脚本不会把真实密钥写入仓库。密钥只存在于系统临时目录中的短期 JSON 文件，传给 Wrangler 后立即删除。

## 更新部署

修改 `src/index.js` 后：

```powershell
.\scripts\deploy.ps1
```

或：

```bash
./scripts/deploy.sh
```

Wrangler 更新代码时会保留已存在的 Secrets。

## 本地开发

复制示例：

```bash
cp .dev.vars.example .dev.vars
```

填写假数据或测试密钥后运行：

```bash
npm install
npm run dev
```

`.dev.vars` 已在 `.gitignore` 中排除。

## 自定义域名

默认部署到 `workers.dev`。需要自定义域名时，在 Cloudflare 控制台为 Worker 添加 Route 或 Custom Domain。不要把真实域名硬编码进开源仓库的示例配置。

## 部署后验证

```bash
curl https://YOUR-WORKER.workers.dev/health \
  -H "Authorization: Bearer YOUR_GATEWAY_ACCESS_KEY"
```

预期返回 JSON。未携带密钥时返回：

```json
{
  "error": {
    "message": "Unauthorized: gateway access key is invalid or missing."
  }
}
```
