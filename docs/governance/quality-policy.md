# 质量策略

## CI 验证

每次 push 和 PR 触发 CI 验证，包含以下检查：

```bash
npm ci
npm run validate:merge    # check + check:version + check:deployment-config + test + security:scan
npm run check:deploy    # wrangler dry-run bundle
```

CI 必须在 `main` 和 Pull Request 上通过。

## 检查项

### 代码质量
- `npm run check` — 语法验证
- `npm run check:version` — 版本一致性
- `npm run check:deployment-config` — 部署配置验证

### 测试
- `npm run test:unit` — 运行全部单元测试套件（CI 必需）
- `npm run test:all` — 运行全部测试套件（包含集成、压力和契约测试）
- 包含：配置、调度、可靠性、流处理、Token 使用、协议矩阵、集成、压力测试、契约测试、文档契约测试

### 安全
- `npm run security:scan` — 密钥扫描（排除 `.dev.vars`、`.env*`、`secrets*.json`、`wrangler.user.jsonc`）
- 确保仓库中不存在真实凭据
- 确认 `/health`、`/metrics`、`/v1/models` 均需鉴权
- 确认响应中无凭据与上游地址（未开 `EXPOSE_UPSTREAM_INFO` 时）

### 部署验证
- `npm run check:deploy` — Wrangler dry-run bundle
- Deploy workflow 中的 post-deploy health check

## 质量规则

### 协议一致性
- 保持 OpenAI / Anthropic 双协议路径行为一致
- Native First：跨协议 fallback 仅在 `PROTOCOL_FALLBACKS` 显式声明时启用
- 协议矩阵测试 + 转换测试断言 Native First 和转换 fallback 行为
- 契约测试覆盖原生协议行为

### 配置安全
- 节点配置中不含凭据字段（工具会拒绝）
- `wrangler.jsonc` 保持 `keep_vars: true` 且不含 `vars` 节点
- 示例配置中的 Token 均为占位符

### 文档检查
- README 与 README_EN 功能、边界和配置说明一致
- 架构图与当前目录逻辑一致
- 配置示例与当前 schema 一致
- 内部 Markdown 链接有效（`scripts/link-check.mjs`）

### 发布验证
- `package.json`、`APP_META.version`、`CHANGELOG.md` 版本一致
- ZIP 与 TAR.GZ 均可正常解压
- `release/SHA256SUMS` 与发布资产一致

## 自动化

能由 CI 自动完成的内容，不应继续要求人工勾 checklist。CI 失败时 PR 不能合并。

## 安全更新

已知安全漏洞的依赖应立即更新。Dependabot 自动创建 PR；安全更新优先于功能开发。
