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
  "keep_vars": true
}
```

`keep_vars` 用于在代码更新时保留控制台中的普通运行时变量。仓库不声明 `secrets.required`，因此首次自动部署不会因为 Secret 尚未创建而失败；受保护接口仍会在运行时拒绝未配置请求。

## 必需 Secret

两种配置方式二选一：

**方式一：Node Scheduler（推荐）**

```text
GATEWAY_ACCESS_KEY    客户端访问密钥
NODES_CONFIG          节点定义 JSON 数组
MODELS_CONFIG         逻辑模型映射（可选，缺省走 general-fast 策略）
POLICIES_CONFIG       策略定义（可选，缺省 free→paid 两层）
FREE_NODE_01 等       各节点 secret_ref 指向的凭据（Token@BaseURL）
```

配置示例见 `config/nodes.example.json`、`config/models.example.json`、`config/policies.example.json`。

**方式二：旧配置（兼容）**

```text
GATEWAY_ACCESS_KEY    客户端访问密钥
PRIMARY_API_TOKENS    上游 Token 列表（Token@BaseURL）
PRIMARY_BASE_URL      共享 Base URL（Token 未绑定 URL 时必需）
```

旧配置会自动转换为 free-node 节点，走同一个 Scheduler。详细说明见 [CONFIGURATION.md](CONFIGURATION.md)。

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

它不会尝试读取或重写已有 Secret。当前 Worker 尚未设置 `GATEWAY_ACCESS_KEY` 或 `NODES_CONFIG`/`PRIMARY_API_TOKENS` 时，代码仍可先部署；根页面会显示配置状态，受保护接口在配置完成前返回明确错误。

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
3. 在每个目标 Worker 的 **Settings → Builds** 中连接该仓库；Cloudflare 会把构建目标覆盖为当前连接的 Worker；
4. 使用：

```text
Build command: npm run build
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

5. 在实际 Worker 的 **Settings → Variables and Secrets** 中添加运行时 Secret（见上文"必需 Secret"）：

```text
GATEWAY_ACCESS_KEY
NODES_CONFIG          （推荐）或 PRIMARY_API_TOKENS
```

构建变量不能替代 Worker 运行时 Secret。第一次构建会先完成代码部署；随后在目标 Worker 中添加上述 Secret 并部署配置即可。多个 Worker 各自保存变量和 Secret，后续 GitHub 推送会继续自动覆盖各自代码。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

本地开发从 `.dev.vars` 读取测试配置。该文件已被 Git 忽略，不应提交真实密钥。

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
    "primary_api_tokens_bound": true,
    "nodes_config_bound": true
  }
}
```

`ready: true` 表示当前活动版本已绑定必需 Secret（`NODES_CONFIG` 或 `PRIMARY_API_TOKENS` 任一即可）。

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
