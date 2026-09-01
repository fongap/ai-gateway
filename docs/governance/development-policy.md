# 开发治理

## 分支策略

- `main` 是唯一的长期分支，触发自动部署
- 禁止直接 push `main`
- 禁止绕过 Required Checks
- 禁止 force push `main`

### 分支命名

```text
feat/     新功能
fix/      修复
refactor/ 重构
ci/       CI 改动
chore/    杂务
docs/     文档
test/     测试
release/  发布
```

## Commit Messages

使用 Conventional Commits 风格：

```
feat: add request-level failover budget
fix: prevent half-open probe leak in circuit breaker
refactor: split model registry out of provider profiles
docs: clarify isolate-local quota semantics
test: cover hard RPM exhaustion and SSE error envelopes
chore: pin GitHub Actions to commit SHAs
ui: refine public gateway entry page
```

规则：一个逻辑变更一条 commit；subject line 描述**行为**变更，不是文件列表；scheduling/reliability 改动应引用覆盖它的回归测试。

## Pull Request

PR 必须说明：目标、改动点、验证结果、破坏性变更、安全影响。

一个 PR 聚焦一个主要目标。使用仓库 Pull Request 模板，确保所有 CI checks 通过后再请求 review。

## Review

- 至少 1 个 approval
- 作者不能 self-approve
- Reviewer 关注：架构一致性、安全影响、测试覆盖、文档同步

## Merge

- 使用 squash merge（线性历史）
- 禁止 merge commits 和 rebase merge
- 合并前 CI 必须通过

## Refactor 原则

- 不改变功能行为
- 不修改协议行为
- 不修改调度行为
- 不修改可靠性策略
- 不修改配置语义
- 不修改默认 timeout/cooldown
- 不借文档重构顺便做代码重构

## Breaking Change

- 必须在 PR 中明确标记
- 必须在 CHANGELOG 中记录
- 必须同步更新文档
- 必须确保版本号递增

## 文档同步要求

影响对外行为时更新 `README.md` 与 `README_EN.md`；修改版本时同步 `package.json`、`APP_META.version` 与 `CHANGELOG.md`。

影响调度/可靠性/配置格式时，同步更新集成测试（`scripts/integration-test.mjs`）与文档。

详见 [documentation-policy.md](documentation-policy.md)。
