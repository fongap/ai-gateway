# 发布策略

## Semantic Versioning

项目遵循 Semantic Versioning：

- **Major**：不兼容的 API 变更
- **Minor**：向后兼容的功能新增
- **Patch**：向后兼容的问题修复

## 版本事实来源

版本号的唯一事实来源是 `package.json` 中的 `version` 字段。`APP_META.version` 和 `CHANGELOG.md` 必须与之保持一致。

## 版本同步

版本变更时必须同步更新：
1. `package.json` → `version`
2. `CHANGELOG.md` → 对应版本条目
3. Git Tag → `v*.*.*`

## CHANGELOG

CHANGELOG 记录所有版本的变化，格式遵循 [Keep a Changelog](https://keepachangelog.com/)。每个版本条目包含：
- 版本号和日期
- `Changed`、`Fixed`、`Added`、`Removed` 分类
- 变化的简明描述

CHANGELOG 只记录历史版本变化，不放长期治理规则。

## Git Tag

- 格式：`v*.*.*`（如 `v1.2.4`）
- 由发布 workflow 自动创建
- Tag 触发 Release 工作流

## GitHub Release

- 由 Tag `v*.*.*` 自动触发
- 包含：
  - CHANGELOG 中对应版本的条目
  - ZIP 和 TAR.GZ 发布资产
  - `release/SHA256SUMS` 校验文件

## Release Workflow

发布流程：
1. 更新版本号（`package.json`、`APP_META.version`）
2. 更新 CHANGELOG
3. 提交并推送到 `main`
4. 创建 Git Tag（`v*.*.*`）
5. Tag 触发 Release 工作流
6. 工作流构建、打包、创建 GitHub Release

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

正式 Release 必须满足：
- CI 全部通过
- 版本号一致
- CHANGELOG 已更新
- 发布资产完整且校验通过
- 健康检查通过
