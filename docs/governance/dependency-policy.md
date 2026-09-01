# 依赖策略

## Dependabot 配置

项目使用 Dependabot 自动创建依赖更新 PR：

- **npm 依赖**：每月检查，最多 5 个 open PR
- **GitHub Actions**：每月检查，最多 5 个 open PR

配置见 `.github/dependabot.yml`。

## 更新策略

### Patch / Minor

- 自动创建 PR
- CI 通过后可自动合并
- 不引入行为变更

### Major

- 自动创建 PR
- 需要人工 review
- 检查 breaking changes
- 更新 CHANGELOG

## 自动合并

Dependabot PR 在以下条件下可自动合并：
- CI 全部通过
- 是 patch 或 minor 更新
- 不引入新的安全漏洞

## Breaking Dependency

当依赖更新引入 breaking change 时：
1. 在 PR 中明确标记
2. 评估对项目的影响
3. 必要时更新代码以适配新版本
4. 在 CHANGELOG 中记录

## Lockfile

- `package-lock.json` 必须提交到仓库
- CI 使用 `npm ci` 安装依赖，确保确定性构建
- 不手动编辑 lockfile

## 安全更新

安全漏洞的依赖应立即更新，不受月度周期限制。Dependabot 会自动为安全更新创建 PR。

## CI 要求

所有依赖更新 PR 必须通过：
- `npm run validate:merge`
- `npm run check:deploy`
- 安全扫描

## Wrangler 版本

Wrangler 版本固定在 `package.json` 中（当前 `4.114.0`）。升级 Wrangler 需要：
1. 检查 breaking changes
2. 更新 `package.json` 中的版本
3. 运行完整测试套件
4. 在 CHANGELOG 中记录
