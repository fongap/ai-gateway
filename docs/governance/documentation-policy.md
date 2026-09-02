# 文档同步规则

## 文档原则

1. 正文以中文为主。
2. 文件名使用英文 `kebab-case`。
3. 代码、命令、路径、配置字段、协议名和 Git/GitHub 固有名称保持英文。
4. 文件名描述长期职责，不描述某次工作状态。
5. 一个文件只承担一个明确主题。
6. 当前已经失效、后续不再使用的文档直接删除。
7. 历史变更通过 Git commit、Pull Request、Release 和 `CHANGELOG.md` 追溯。
8. 现有规则发生变化时直接修改原文件，不创建重复版本。

## 核心原则

文档应和对应代码在同一个 PR 更新。不得留下 `TODO: later update docs` 这种明显的文档债务。

## 代码 → 文档映射

| 代码变化 | 必须同步更新的文档 |
|---|---|
| `src/config/*` | [operations/configuration.md](../operations/configuration.md) |
| `src/scheduler/*` | [architecture/routing-model.md](../architecture/routing-model.md) |
| `src/reliability/*` | [architecture/reliability-model.md](../architecture/reliability-model.md) |
| `src/transport/*` | [architecture/protocol-model.md](../architecture/protocol-model.md) |
| `src/protocol/*` | [architecture/protocol-model.md](../architecture/protocol-model.md) |
| `src/stream/*` | [architecture/protocol-model.md](../architecture/protocol-model.md), [architecture/reliability-model.md](../architecture/reliability-model.md) |
| `src/config/runtime-vars.js` | [operations/configuration.md](../operations/configuration.md)（运行时参数表） |
| `wrangler.jsonc` | [operations/deployment.md](../operations/deployment.md) |
| 顶层目录调整 | [architecture/repository-layout.md](../architecture/repository-layout.md) |
| CI / workflow | [governance/quality-policy.md](quality-policy.md) |
| Dependabot | [governance/dependency-policy.md](dependency-policy.md) |
| release workflow / version mechanism | [governance/release-policy.md](release-policy.md) |
| 新增/删除/修改对外端点 | README.md、README_EN.md |

## 文档同步检查

以下变更必须同步检查文档：

- 顶层目录变化
- 模块职责变化
- CI 规则变化
- Release 流程变化
- 用户配置方式变化
- `CHANGELOG.md` 维护规则变化

文档应随代码一起更新，不把明显过期内容留给后续处理。

## README 同步

影响用户可见行为时，必须同时更新：
- `README.md`
- `README_EN.md`

两版保持结构和语义一致。不要求逐字翻译，但不能出现功能、配置和边界差异。

## 版本同步

修改版本时，必须同步：
- `package.json` → `version`
- `CHANGELOG.md` → 版本条目
- Git Tag（发布时）

## 质量检查

CI 中的文档检查包括：
- `scripts/docs-check.mjs` — 文档结构和命名规范检查
- `scripts/link-check.mjs` — Markdown 内部链接有效性检查
- `scripts/docs-contract-test.mjs` — 防止旧架构语义回流

## 禁止事项

- 不在文档中保留已废弃的规则
- 不创建临时状态型文档
- 不为每个源码模块建 Markdown
- 不引入大型文档框架
- 不生成大量空壳文档
- 不创建带 `v2`、`new`、`latest`、`final` 等后缀的重复版本
