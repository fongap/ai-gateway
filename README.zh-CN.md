<div align="center">

# ai-gateway

**面向个人、家庭或小团队的简单、稳定 AI API 网关。**

Cloudflare Workers · 多 Provider 路由 · 多 Key 韧性 · 分层故障转移 · OpenAI / Anthropic 兼容

[English](README.md) · [**简体中文**](README.zh-CN.md)

[![CI](https://github.com/fongap/ai-gateway/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fongap/ai-gateway/actions/workflows/ci.yml)
[![Deploy](https://github.com/fongap/ai-gateway/actions/workflows/deploy.yml/badge.svg?branch=main&event=workflow_run)](https://github.com/fongap/ai-gateway/actions/workflows/deploy.yml)
![Version](https://img.shields.io/github/package-json/v/fongap/ai-gateway?label=Version)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/github/license/fongap/ai-gateway?label=License)

[实时面板](https://api.135468.xyz/) · [快速开始](#快速开始) · [架构](docs/architecture/overview.md) · [配置](docs/operations/configuration.md) · [产品规则](docs/governance/product-policy.md)

</div>

ai-gateway 把分散在不同 Provider、账户和 Key 上的 AI 容量汇聚成一个稳定端点，定位只面向个人、家庭或小型可信团队使用。

它不做公共 SaaS 网关，不做企业 API 管理平台，不做计费/转售平台，也不做通用多租户控制面。设计目标只有一个：**先把免费容量做稳定，再把付费容量保护好，同时保持简单好用。**

> 本页为中文阅读版。长期规则以 [English README](README.md) 和英文 canonical docs 为准。

## 三层定位

三层不是普通优先级编号，而是固定的长期职责：

| Tier | 长期职责 |
| --- | --- |
| **Tier 1** | 免费或近似免费的 Token 容量。承担日常主要流量，是长期可靠性建设重点。 |
| **Tier 2** | 预留给会员/订阅权益容量。不是第二个普通 API Key 池。 |
| **Tier 3** | 付费 API 容量，作为受保护的最终托底。 |

Tier 1 面对的本来就是额度碎片化、429、延迟波动、Provider 不稳定等问题，因此重点是：多 Key / 多 Provider 韧性、P2C 负载分散、被动 TTFT、实时 inFlight、429 自适应 Cooldown、Provider-Model 热度、Circuit/恢复和安全流式处理。

目标不是持续追打某个“最好”的 Key，而是让整个免费资源池 **长期稳定、高效、安全、持续可用**。

Tier 2 / Tier 3 保持简单，不因为“架构完整”就复制 Tier 1 的复杂状态机。只有真实使用证明必要时才增加机制。

## 核心能力

| 能力 | 当前行为 |
| --- | --- |
| **多 Key 韧性** | P2C、被动 TTFT、实时 inFlight 软负载、429 Cooldown、Provider-Model 热度 |
| **分层故障转移** | 在同一请求预算内按 **Tier 1 → Tier 2 → Tier 3** 逐层托底 |
| **模型家族兜底** | 在同一 `max_attempts` 硬上限内进行有界兼容模型切换 |
| **协议兼容** | 原生支持 OpenAI Chat、OpenAI Responses、Anthropic Messages |
| **安全协议转换** | 仅 OpenAI Chat ↔ Anthropic Messages；**OpenAI Responses 在协议转换层保持 Native Only** |
| **流式安全** | 首个有效输出前可故障转移，提交后不透明重放 |
| **消耗观测** | 成功交付统计与真实上游物理调用 Token 分开统计 |

## 架构

```text
Client
  ↓
鉴权 + 校验
  ↓
Logical Model
  ↓
原生协议节点池
  ↓
Tier 1 → Tier 2 → Tier 3
  ↓
可选 Chat ↔ Messages fallback
  ↓
有界兼容模型 fallback
  ↓
Response / Stream
```

原生重试、Protocol fallback、Model-family fallback 和 Hedge 共用同一套请求级 attempt / wall-clock 预算，任何 fallback 都不能偷偷扩大 `max_attempts`。

Code 家族不会转入非 Code 家族。`Air` 可以单向上浮到 `Pro → Max → Ultra`，高层 general 模型不会再向下回到 `Air`。模型型 404 只隔离失败的节点/模型映射，在同一请求预算内仍可尝试已授权的兼容同族模型。

项目默认采用有界、本地状态，不为了“架构更高级”引入全局协调。只有真实运行数据证明个人/家庭/小团队场景确实需要，才考虑更强的跨 PoP 协调机制。

## 不兼容旧版 ai-gateway

项目只维护一套当前规则。

当配置、Schema、内部契约或行为发生变化时，旧路径直接删除，不保留：

- 旧字段别名；
- 双读/双写；
- Deprecated 过渡窗口；
- Version Switch；
- 仅用于旧版 ai-gateway 的 Compatibility Shim。

旧版本由 Git 历史和 Tag 保存，不由当前 Runtime 背负。

这条规则**不影响 OpenAI / Anthropic 协议兼容**。这些协议是当前产品能力，不是对旧版 ai-gateway 的兼容。

永久规则见 [Product Policy](docs/governance/product-policy.md)。

## API Surface

| Method | Path | Surface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible 本地 Token 计数 |
| `GET` | `/v1/models` | 模型目录 |
| `GET` | `/health` | 鉴权健康诊断 |
| `GET` | `/version` | 源码版本与部署 Build |

## 快速开始

要求：Node.js **>=22.18.0**；生产部署需要 Cloudflare 账户。

```bash
git clone https://github.com/fongap/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh
```

Windows：

```powershell
powershell scripts/install.ps1
```

生产环境使用 [Deployment](docs/operations/deployment.md) 中的仓库驱动部署流程。

## 配置

| 层级 | 配置 |
| --- | --- |
| Nodes | `TIER{1,2,3}_NODES_CONFIG_01..10` |
| 上游凭据 | `TIER{1,2,3}_NODES_SECRETS_01..10` |
| Gateway Access | `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` |
| Model Access | `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` |
| 模型 / 请求策略 | `MODELS_CONFIG` · `POLICIES_CONFIG` |

凭据按 **Tier + node id** 绑定；Config 与 Secret 的 shard suffix 是彼此独立、互不关联的分片编号。Gateway Access 默认 fail-closed：Group Key 已配置但对应 `GATEWAY_ACCESS_MODELS_<GROUP>` 为空时，不获得任何模型访问权限。

Node `limits` 已不在现行 Schema 中，配置后会被拒绝。容量判断依赖真实 inFlight、429/Cooldown、Circuit 和延迟信号，而不是人工猜测的节点上限。

完整配置见 [Configuration](docs/operations/configuration.md)。

## 生产流程

```text
Pull Request
    ↓
validate-merge
    ↓
squash merge to main
    ↓
validate-deploy
    ↓
D1 migrations
    ↓
Worker deploy
    ↓
remote verification
```

仅文档修改不会触发 Worker 重部署。

## 文档

| 区域 | 作用 |
| --- | --- |
| [Product Policy](docs/governance/product-policy.md) | 永久产品范围、Tier 职责、简单化和彻底替换规则 |
| [Architecture](docs/architecture/overview.md) | 运行时架构、路由、协议与可靠性边界 |
| [Operations](docs/operations/configuration.md) | 配置、部署和排障 |
| [Governance](docs/governance/README.md) | 开发、质量、依赖、版本与文档治理 |
| [CHANGELOG](CHANGELOG.md) | 版本历史 |

## 安全

不要将上游凭据写入 Node Config 或公开日志。详见 [SECURITY.md](SECURITY.md)。

## License

MIT License，详见 [LICENSE](LICENSE)。