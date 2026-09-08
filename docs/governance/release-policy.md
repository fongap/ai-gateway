# 发布策略

## Semantic Versioning

项目遵循 Semantic Versioning：

- **Major**：不兼容的 API 变更
- **Minor**：向后兼容的功能新增
- **Patch**：向后兼容的问题修复

## 版本事实来源

```text
软件版本
→ package.json.version

Node Runtime Requirement
→ package.json.engines.node
```

以下属于同步副本（必须保持一致）：

```text
package-lock.json
src/config/version.ts（由 scripts/generate-version.mjs 从 package.json 生成）
CHANGELOG.md
README.md
README_EN.md
```

版本变更时必须同步更新：

1. `package.json` → `version`
2. `package-lock.json` → `version`（通过 npm 正常生成，不得手动编辑）
3. `CHANGELOG.md` → 对应版本条目
4. Git Tag → `v*.*.*`

## CHANGELOG

CHANGELOG 记录所有版本的变化，格式遵循 [Keep a Changelog](https://keepachangelog.com/)。每个版本条目包含：
- 版本号和日期
- `Changed`、`Fixed`、`Added`、`Removed` 分类
- 变化的简明描述

CHANGELOG 只记录历史版本变化，不放长期治理规则。

## Git Tag

- 格式：`v*.*.*`（如 `v1.2.4`）
- 由维护者显式创建
- 不自动触发 Release workflow（当前由维护者手动创建）

## GitHub Release

- 由维护者显式创建
- 包含：
  - CHANGELOG 中对应版本的条目
  - ZIP 和 TAR.GZ 发布资产
  - `release/SHA256SUMS` 校验文件

## Release Workflow

本仓库使用 **Squash Merge**:PR 分支上的 commit 永远不会成为 `main` 历史的 ancestor。因此正式 release 的 tag 必须指向 **main 上的 squash commit**——指向 PR 分支 commit 的 tag 不在 `main` 的可达历史内,不是合法的 release 基线。

正式 release 生命周期(每一步依赖上一步成功):

```text
PR Merge (squash)
↓
main 完整 CI(validate-merge + validate-deploy 全绿 = Production Gate)
↓
Production Deploy 成功(gate: 仅 push 触发的 CI 允许部署)
↓
确认 main release commit(final main SHA)
↓
创建 tag:vX.Y.Z → 指向该 final main SHA
↓
创建 GitHub Release
```

### Tag 纪律(硬性规则)

1. **禁止在 PR merge 之前创建正式 release tag。** tag 不是"准备好就打"的标记,而是"该 commit 已通过完整 CI 并成功部署"的确认。
2. tag 必须指向 `main` 的 squash commit(final main SHA);禁止在 PR 分支上打 tag 或重建 tag。
3. 如果提前创建了 tag 但对应版本**尚未发布过 GitHub Release**(未形成不可修改的外部发布契约),必须删除并重建到正确的 main SHA:

   ```bash
   git push origin :refs/tags/vX.Y.Z
   git tag -a vX.Y.Z <FINAL_MAIN_SHA> -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   已发布 GitHub Release 的 tag 视为外部契约,不得移动;需要变更时走新版本号。
4. correctness/hardening 轮内版本号保持不变;下一功能版本的版本号单独决策,不与修复混在一起反复变更。

### 流程步骤

1. 更新版本号(`package.json`,然后运行 `scripts/generate-version.mjs` 生成 `src/config/version.ts`,同步副本自动校验)
2. 更新 CHANGELOG
3. 通过 PR(squash)合入 `main`
4. 等待 main 完整 CI + Production Deploy 成功
5. 创建 Git Tag(`v*.*.*`,指向 final main SHA)
6. 维护者显式创建 GitHub Release
7. CI / Deploy 自动化(`npm ci → npm run validate:merge → npm run check:deploy`)

## Deployment / Release Relationship

- Deployment 由 push 到 `main` 触发
- Release 由 Git Tag `v*.*.*` 触发
- 两者独立但相关：Deployment 更新生产环境，Release 归档发布资产

## 发布资产

每个 Release 包含：
- ZIP 归档
- TAR.GZ 归档
- `SHA256SUMS` 校验文件

归档排除：dry-run 产物、临时 Secrets 文件、node_modules、.wrangler 目录。

## 正式 Release

正式 Release 的唯一外部证据是：

```text
Git tag vX.Y.Z
+
GitHub Release
```

内部条件：

- CI 全部通过
- 版本号一致
- CHANGELOG 已更新
- 发布资产完整且校验通过
- 健康检查通过
