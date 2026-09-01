# 贡献指南

## 快速开始

```bash
git clone https://github.com/fongap/ai-gateway.git && cd ai-gateway
npm ci
npm run verify        # syntax + version + config checks + tests + secret scan
npm run check:deploy  # wrangler dry-run bundle
```

## 提交 PR

1. 创建分支（`feat/`、`fix/`、`refactor/`、`docs/`、`test/`、`chore/`）
2. 确保 `npm run verify` 和 `npm run check:deploy` 通过
3. 使用仓库 Pull Request 模板
4. 等待 CI 通过后请求 review

## 治理规则

完整开发治理详见：

- 开发治理：[docs/governance/development-policy.md](docs/governance/development-policy.md)
- 质量要求：[docs/governance/quality-policy.md](docs/governance/quality-policy.md)
- 依赖策略：[docs/governance/dependency-policy.md](docs/governance/dependency-policy.md)
- 发布流程：[docs/governance/release-policy.md](docs/governance/release-policy.md)
- 文档同步：[docs/governance/documentation-policy.md](docs/governance/documentation-policy.md)

## 架构文档

- 系统总览：[docs/architecture/overview.md](docs/architecture/overview.md)
- 协议模型：[docs/architecture/protocol-model.md](docs/architecture/protocol-model.md)
- 调度模型：[docs/architecture/routing-model.md](docs/architecture/routing-model.md)
- 可靠性模型：[docs/architecture/reliability-model.md](docs/architecture/reliability-model.md)

## 运维文档

- 配置参考：[docs/operations/configuration.md](docs/operations/configuration.md)
- 部署指南：[docs/operations/deployment.md](docs/operations/deployment.md)
- 故障排查：[docs/operations/troubleshooting.md](docs/operations/troubleshooting.md)
- Provider Discovery：[docs/operations/provider-discovery.md](docs/operations/provider-discovery.md)
- 公开 Model Status：[docs/operations/public-model-status.md](docs/operations/public-model-status.md)
