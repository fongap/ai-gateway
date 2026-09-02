# GitHub 仓库设置

本文档记录项目期望的 GitHub repository 配置。

## Branch Protection / Ruleset

`main` 分支必须配置 Rulesets（**Settings → Rules → Rulesets**）：

### Ruleset: main

- **Target**: branch `main`
- **Require a pull request before merging**
  - 0 required approving reviews（由 `validate-merge` status check 守护质量；fork/solo 项目避免阻塞）
  - Require review thread resolution
- **Require status checks to pass**
  - `validate-merge`（CI workflow，唯一 PR 合并前的硬门控）
  - `Deploy` 是 main 合并**之后**才运行的工作流，**不**适合作为 PR 合并前的 required check
- **Require linear history**（仅允许 squash merge）
- **Block force push**
- **Block branch deletion**

### Pull Requests

**Settings → General → Pull Requests**：
- Allow squash merge（推荐）
- 禁用 Allow merge commits
- 禁用 Allow rebase merge

## Required Checks

CI 在 `main` 和 Pull Request 上运行：

| Check | Workflow | 何时运行 | 内容 |
|---|---|---|---|
| `validate-merge` | CI | PR + main | `npm run validate:merge`（syntax + version + config + tests + security scan） |
| `validate-deploy` | CI | main | 完整 deploy.yml 语法 + 配置 dry-run 校验 |
| `Deploy` | Deploy | main | 实际部署 Worker + health check（仅 main 合并后触发，不在 PR 阻塞链路上） |

## Actions Permissions

- Actions 限为 `contents: read`
- 使用 SHA-pinned actions：
  - `actions/checkout` — 完整 SHA
  - `actions/setup-node` — 完整 SHA

## Dependabot

`.github/dependabot.yml` 配置：
- npm 依赖：每月检查，最多 5 个 open PR
- GitHub Actions：每月检查，最多 5 个 open PR

## Auto Merge

Dependabot PR 在 CI 通过且为 patch/minor 更新时可自动合并。

## Branch Deletion

合并后的分支应自动删除。

## Security Advisories

已开通 GitHub Security Advisories 私密报告渠道。见 `SECURITY.md`。

## Repository Topics

仓库 Topics 应与实际定位一致：`cloudflare-workers`、`ai-gateway`、`openai-api`、`anthropic-api`、`llm-router`、`api-proxy`。

## License

MIT License。版权行正确。
