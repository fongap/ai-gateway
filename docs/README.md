# ai-gateway 文档

ai-gateway 将多个不稳定的上游 API Key 聚合为一个稳定、自动恢复的 AI API 端点。本文档体系围绕这一核心定位展开。

## 文档结构

```
docs/
├── architecture/           # 系统架构
│   ├── overview.md         # 设计目标与模块职责
│   ├── protocol-model.md   # OpenAI / Anthropic 双协议原生转发
│   ├── routing-model.md    # Tier 1/2/3 调度策略
│   ├── reliability-model.md # 熔断、TTFT、错误分类
│   └── repository-layout.md # 仓库目录职责
│
├── governance/             # 开发治理
│   ├── README.md           # 治理总则
│   ├── development-policy.md # 分支、提交、PR 规则
│   ├── quality-policy.md   # CI、测试、安全门禁
│   ├── dependency-policy.md # 依赖更新策略
│   ├── release-policy.md   # 版本管理、发布流程
│   └── documentation-policy.md # 文档同步规则
│
└── operations/             # 运维操作
    ├── configuration.md    # 节点配置与运行时参数
    ├── deployment.md       # GitHub Actions 部署流程
    ├── troubleshooting.md  # 429/502/503/504 排查
    ├── provider-discovery.md # Provider Discovery 机制
    ├── public-model-status.md # 公开模型状态投影
    └── github-repository-settings.md # GitHub 仓库配置
```

## 按职责分类

### 理解系统

| 文档 | 说明 |
|---|---|
| [architecture/overview.md](architecture/overview.md) | 系统整体设计：多 Key 聚合、Tier 分层、协议原生转发 |
| [architecture/protocol-model.md](architecture/protocol-model.md) | OpenAI / Anthropic 双协议如何实现原生透传 |
| [architecture/routing-model.md](architecture/routing-model.md) | Tier 1 P2C + Affinity、Tier 2/3 fallback 调度逻辑 |
| [architecture/reliability-model.md](architecture/reliability-model.md) | 熔断器、TTFT 被动学习、错误分类与冷却机制 |

### 配置与部署

| 文档 | 说明 |
|---|---|
| [operations/configuration.md](operations/configuration.md) | 节点 Schema、运行时参数、Model Registry、limits 语义 |
| [operations/deployment.md](operations/deployment.md) | GitHub Actions 自动部署、Cloudflare 配置、KV/D1 绑定 |
| [github-repository-settings.md](operations/github-repository-settings.md) | GitHub 仓库 Variable/Secret 配置规范 |

### 运维与排查

| 文档 | 说明 |
|---|---|
| [operations/troubleshooting.md](operations/troubleshooting.md) | 常见错误码排查：429 冷却、502/503/504 超时 |
| [operations/provider-discovery.md](operations/provider-discovery.md) | Provider Discovery v1.1 观察机制 |
| [operations/public-model-status.md](operations/public-model-status.md) | 公开模型状态、TTFT P50/P95 展示 |

### 开发治理

| 文档 | 说明 |
|---|---|
| [governance/development-policy.md](governance/development-policy.md) | 分支前缀、Commit 格式、PR 要求、Review 重点 |
| [governance/quality-policy.md](governance/quality-policy.md) | CI 验证流程、14 个单元测试套件、安全扫描 |
| [governance/dependency-policy.md](governance/dependency-policy.md) | Dependabot 配置、自动合并规则 |
| [governance/release-policy.md](governance/release-policy.md) | 版本号规范、Tag 创建、Release 流程 |
| [governance/documentation-policy.md](governance/documentation-policy.md) | 代码→文档映射、同步检查清单 |

## 快速导航

| 我想... | 查看 |
|---|---|
| 了解系统如何工作 | [architecture/overview.md](architecture/overview.md) |
| 配置一个新的上游节点 | [operations/configuration.md](operations/configuration.md#节点配置) |
| 部署到 Cloudflare Workers | [operations/deployment.md](operations/deployment.md) |
| 排查 429/502/503 错误 | [operations/troubleshooting.md](operations/troubleshooting.md) |
| 了解 Tier 1 调度策略 | [architecture/routing-model.md](architecture/routing-model.md#tier-1-eligibility--affinity--p2c) |
| 贡献代码 | [CONTRIBUTING.md](../CONTRIBUTING.md) |

## 项目入口

- [README.md](../README.md) — 项目主页（中文）
- [README_EN.md](../README_EN.md) — 项目主页（英文）
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
- [CHANGELOG.md](../CHANGELOG.md) — 版本历史
