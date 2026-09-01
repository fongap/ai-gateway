# 仓库目录结构

## 目录职责

```text
src/                          Worker 代码：所有运行时逻辑
├─ config/                    配置解析：env、nodes、models、registry、policies、timeouts、provider-quirks
├─ scheduler/                 调度：协议+surface+model 三重过滤、Tier 1 P2C、Tier 2/3 选择器
├─ reliability/               可靠性：节点状态、熔断、错误分类
├─ transport/                 协议传输：上游路径、协议头、流式判定
├─ protocol/                  协议校验：CORS、OpenAI/Anthropic 请求校验、Responses 模块
├─ stream/                    流处理：First-Event Guard、SSE 扫描、流追踪与改写
├─ request/                   请求处理：鉴权、路由、错误构建、编排
├─ observability/             可观测性：日志、指标、D1 聚合、诊断端点
└─ dashboard/                 浏览器页面

scripts/                      工具脚本：部署、测试、配置检查、CI 桥接
├─ *.mjs                      核心工具（deploy、config、health-check 等）
├─ *-test.mjs                 测试套件
└─ *.sh / *.ps1               跨平台部署脚本

config/                       示例配置文件（*.example.json）
benchmark/                    性能基准测试
migrations/                   D1 数据库迁移 SQL
docs/                         文档体系
├─ architecture/              系统架构文档
├─ governance/                开发治理文档
└─ operations/                运维操作文档

.github/                      GitHub 配置
├─ workflows/                 CI / Deploy 工作流
├─ ISSUE_TEMPLATE/            Issue 模板
├─ pull_request_template.md   PR 模板
└─ dependabot.yml             依赖更新配置
```

## 目录规则

- `src/` 只包含运行时代码；测试在 `scripts/` 中，配置示例在 `config/` 中
- `docs/` 只包含长期文档；临时状态不入文档
- `scripts/` 中的测试文件以 `-test.mjs` 结尾，工具文件不以 `-test.mjs` 结尾
- 新增顶层目录需满足：有明确的长期职责，且不与现有目录职责重叠
- `.dev.vars`、`wrangler.user.jsonc`、`.env*`、`secrets*.json` 均被 gitignore，不入仓库
