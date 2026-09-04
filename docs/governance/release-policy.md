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
APP_META.version
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

当前发布流程：

1. 更新版本号（`package.json`、`APP_META.version`）
2. 更新 CHANGELOG
3. 提交并推送到 `main`
4. 创建 Git Tag（`v*.*.*`）
5. 维护者显式创建 GitHub Release
6. CI / Deploy 自动化（`npm ci → npm run validate:merge → npm run check:deploy`）

以后如果增加自动 Release workflow，再同步修改本文件。

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
