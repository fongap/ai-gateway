# GitHub 仓库设置

本文档记录项目期望的 GitHub repository 配置。

## Branch Protection / Ruleset

`main` 分支必须配置 Rulesets（**Settings → Rules → Rulesets**）：

### Ruleset: main

- **Target**: branch `main`
- **Require a pull request before merging**
  - 至少 1 approval
  - 作者不能 self-approve
- **Require status checks to pass**
  - `verify`（CI workflow）
  - `Deploy`（Deploy workflow）
  - 可选：Require branches to be up to date
- **Block force push**
- **Block branch deletion**

### Pull Requests

**Settings → General → Pull Requests**：
- Allow squash merge（推荐）
- 禁用 Allow merge commits
- 禁用 Allow rebase merge

## Required Checks

CI 在 `main` 和 Pull Request 上运行：

| Check | Workflow | 内容 |
|---|---|---|
| `validate:merge` | CI | `npm run validate:merge`（syntax + version + config + tests + security scan） |
| `Deploy` | Deploy | 完整部署流程 + health check |

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
