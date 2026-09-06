# 部署

ai-gateway 通过 GitHub Actions 部署。推送到 `main` 自动触发部署;在 Actions 页手动运行 Deploy 工作流也会先执行完整验证再部署。部署流程:验证配置、同步 Worker 变量和 Secrets、执行 D1 迁移、发布 Worker、运行线上健康检查。

配置来源是 GitHub 仓库的 **Variables**（非敏感）和 **Secrets**（凭据）。Cloudflare Dashboard 不是日常配置界面。

## 首次部署

1. 在 GitHub 仓库中，打开 **Settings → Secrets and variables → Actions**
2. 创建 Cloudflare KV namespace 用于 Tier 1 session affinity，复制其 32 字符 namespace ID
3. 创建 §2 和 §3 中列出的 Variables 和 Secrets，包括 `TIER1_AFFINITY_KV_ID`
4. 推送到 `main`（或从 Actions 标签运行 Deploy 工作流）

部署工作流先运行 **preflight** 检查。任何必需 Variable 或 Secret 缺失时，工作流**失败**并报告确切缺失项。

Deploy workflow 由 CI workflow 的 `workflow_run` 完成事件触发,生产部署必须等待完整验证通过（Merge Gate ≠ Production Gate）。CI 在 push 到 main 时运行两个 job——`validate-merge`（语法/配置/unit/typecheck/strict/security/docs/bundle dry-run）与 `validate-deploy`（unit + scheduler stability + integration + stress + Codex/Claude contract + security + docs）——**两个 job 都成功 = Production Gate**,完整验证每次 push 只执行一次,不在 deploy 工作流内重复。

**触发事件规则**(由 `scripts/deploy-gate-decision.mjs` 决定,契约测试固化):只有 **push 触发的 CI 成功** 才允许自动部署。定时 nightly CI 与手动触发的 CI 仅测试,**永不部署**——gate 显式判断 `workflow_run.event == push`,不做任何 commit message / 时间 / 分支猜测。

```
CI workflow（push → main）:
  → job validate-merge（Merge Gate）
  → job validate-deploy（完整套件）

Nightly CI（schedule）/ 手动 CI（workflow_dispatch）:
  → 只测试,NO Deploy

Deploy workflow（workflow_run: CI completed, branch main）:
  → job gate（scripts/deploy-gate-decision.mjs）:
      CI 触发事件 ≠ push（nightly / 手动 CI）→ 阻断；
      CI conclusion ≠ success → 阻断（Production Gate）；fork head repo → 阻断；
      触发 commit 仅改动 **.md / docs/** → 跳过（沿用原 paths-ignore 策略）
  → job deploy（needs: [gate, manual-validate]）:
      → Preflight deployment configuration
      → Validate runtime configuration
      → Apply D1 migrations（仅当 TOKEN_STATS_D1_ID 已配置；未配置时跳过，不影响部署）
      → Deploy Worker (atomic code+secrets)
      → Verify deployed gateway（health check）
      → Deployment summary（失败且已部署时先执行 Worker 回滚）

手动 Deploy（workflow_dispatch）:
  → job gate 放行,但绝不绕过 Production Gate:
  → job manual-validate（完整套件: validate:deploy + typecheck + strict typecheck + bundle dry-run）
  → 全部通过后 job deploy 才开始（needs.manual-validate.result == 'success'）
```

手动路径是唯一在 deploy 工作流内重复完整验证的路径（低频操作）；自动 main-push 路径复用已完成的 CI,验证只执行一次。

任何验证步骤失败都会阻断后续步骤——Worker、Secrets 和 D1 不会被触碰。
**D1 migration 失败时 Worker 部署不会发生**，不会出现"新代码 + 旧 Schema"的线上状态。

部署是原子的：代码和 Secret 在同一次 `wrangler deploy --secrets-file` 操作中更新，确保它们属于同一 Worker version。

**D1 迁移在 Worker 部署之前运行**。迁移文件按顺序应用（0001–0007），新增表 `token_usage_totals`、`token_usage_daily`、`token_usage_weekly`，`token_usage_hourly` 现为 7 天保留，冗余主键索引已移除。本地部署路径自动执行远端 D1 migrations（当 `TOKEN_STATS_DB` binding 存在时）。迁移失败阻断部署。

部署顺序由 `scripts/deployment-workflow-contract-test.mjs`（unit 套件内）固化为契约测试，防止再次漂移。

## GitHub Variables

| Variable | 必需 | 说明 |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 是 | 资源标识符 |
| `GATEWAY_PUBLIC_BASE_URL` | 是 | `https://` URL（无尾部 `/v1`） |
| `TOKEN_STATS_D1_ID` | 可选 | D1 数据库 ID |
| `TIER1_AFFINITY_KV_ID` | Tier 1 配置时必需 | KV namespace ID |
| `TIER1_NODES_CONFIG_01..99` | 至少一个 tier variable | JSON 数组 |
| `TIER2_NODES_CONFIG_01..99` | 可选 | 同上 |
| `TIER3_NODES_CONFIG_01..99` | 可选 | 同上 |
| `MODELS_CONFIG` | 可选 | 模型注册表覆盖 |
| `POLICIES_CONFIG` | 可选 | Attempt budgets |
| `DEPLOY_ENABLED` | 仅 Fork | 设为 `true` 启用 |

## GitHub Secrets

| Secret | 必需 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 是 | Cloudflare 部署 token |
| `GATEWAY_ACCESS_KEY` | 是 | 客户端访问密钥 |
| `TIER{1,2,3}_NODES_SECRETS_01..99` | 至少一个 | `{ "node-id": "credential" }`（tier-scoped，与 config shard 一一对应） |

## 节点管理

### 添加新节点

1. 编辑匹配的 `TIER*_NODES_CONFIG_XX` Variable——追加新节点对象
2. 将 credential 添加到匹配的 `TIER*_NODES_SECRETS_XX` Secret（tier 必须与 config shard 一致）
3. 推送到 `main`

### 编辑节点

修改匹配的 `TIER*_NODES_CONFIG_XX` Variable。URL/模型映射、priority/limits 等。

### 轮换 API Key

编辑包含该节点的 `TIER*_NODES_SECRETS_XX` Secret，更新 credential。

### 轮换 Gateway Access Key

编辑 `GATEWAY_ACCESS_KEY` Secret。

## 配置检查

```bash
npm run config:check -- \
  --tier1 config/tier1-nodes.example.json \
  --tier2 config/tier2-nodes.example.json \
  --secrets config/node-secrets.example.json
```

## 回滚

### 自动回滚（post-deploy health check 失败）

Deploy 工作流包含自动 Worker-code 回滚。如果 Worker 部署成功但 post-deploy health check 失败，自动运行 `wrangler rollback` 恢复之前版本。

**回滚范围**：Worker code/version only（包括通过 `--secrets-file` 部署的变量和 Secrets）
**不回滚**：通过 `wrangler secret put` 等命令手动更新的 Secrets、D1 migrations

### 手动回滚

1. 在 `main` 上 revert commit（或推送恢复之前 Variable/Secret 值的新 commit）
2. 下次 Deploy 恢复之前的代码和运行时变量

## D1 迁移

所有迁移文件按顺序应用。本地部署路径自动执行远端 D1 migrations（当 `TOKEN_STATS_DB` binding 存在时）。迁移失败阻断部署。

## Branch Protection

`main` 触发自动部署——必须配置 Rulesets：

- Require a pull request before merging
- Require status checks to pass（`validate-merge`，唯一 PR 合并前硬门控）
- Require linear history
- Block force push
- Block branch deletion
- Allow squash merge

详见 [github-repository-settings.md](github-repository-settings.md)。