# Provider Discovery (v1.1)

> Runtime Node Config = 生产事实。
> Discovery Catalog = 外部观察 / 辅助事实。

Provider Discovery 追踪 Provider 在网关使用的生态系统中的**协议能力**、**Surface 支持**和 **base URL** 状态。它的存在是为了回答以下问题：

- 哪些 Provider 支持哪些协议？
- Provider X 是否支持 OpenAI Chat Completions？OpenAI Responses？
- Provider X 是否支持 Anthropic Messages？Anthropic `count_tokens`？
- Provider X 为每个协议使用什么 base URL？
- 每条信息来自哪里？
- 与上一个快照相比，Provider 能力如何变化？
- 当前 Runtime Node 配置是否与 Catalog 一致？

它**不会**修改 Runtime Node 配置、Model Registry、Worker Variables 或 Worker Secrets。Discovery Catalog 输出**仅供参考**。

## 边界

```text
Provider Capability
        ↓
Discovery Catalog
        ↓
Semantic Diff
        ↓
GitHub Report
        ↓
Human Review
        ↓
Node / Model Registry Config
```

Catalog 供人类和 CI 共同阅读；请求热路径中没有任何模块导入它。Runtime 请求热路径（`src/request/handler.js` → `src/scheduler/` → `src/transport/`）有意不受 Discovery 影响，也从不读取 `scripts/provider-discovery/*`。

## Catalog schema (v1.1)

```json
{
  "schema_version": "1.1",
  "providers": {
    "<provider>": {
      "openai": {
        "supported": true,
        "base_url": "https://api.example.com/v1",
        "surfaces": ["chat_completions"],
        "evidence": "configured"
      },
      "anthropic": {
        "supported": null,
        "base_url": null,
        "surfaces": [],
        "evidence": "unknown"
      }
    }
  }
}
```

三种支持状态：`true`（支持）、`false`（已验证不支持）、`null`（未知 / 未确认）。Surface 缺失为 `unknown`，**永不**为 `unsupported`（v1.1 第四节）。

### Surfaces

| 协议 | 允许的 surfaces |
|---|---|
| `openai` | `chat_completions`, `responses` |
| `anthropic` | `messages`, `count_tokens` |

`count_tokens` 在 Catalog 中仅供参考：Runtime Node schema（`src/config/nodes.js`）目前未将其建模为 `surfaces` 条目，因此 Runtime 一致性层不会在 `count_tokens` 不匹配时发出 Runtime 冲突。Catalog 仍会记录它。

### 证据级别

| 级别 | 含义 |
|---|---|
| `configured` | 来自运维人员维护的配置（Discovery 快照、runtime） |
| `official` | 来自 Provider 的官方文档 |
| `verified` | 通过安全元数据端点（`GET /models`、官方文档）确认 |
| `unknown` | 无可靠来源可用 |

`verified` **永不**由执行生成请求的代码声称。Discovery 永不 POST 到 `/v1/chat/completions`、`/v1/responses` 或 `/v1/messages`。

## 本地 CLI

`scripts/provider-discovery.mjs`：

```bash
# 验证和检查快照。
npm run discovery:check

# 打印简短的协议/surface 能力摘要。
npm run discovery:summary

# 子命令（脚本也直接接受这些）：
node scripts/provider-discovery.mjs check-snapshot <catalog.json>
node scripts/provider-discovery.mjs summary       <catalog.json>
node scripts/provider-discovery.mjs diff          <before.json> <after.json> \
                                                [--out FILE] [--json-out FILE]
node scripts/provider-discovery.mjs runtime-check <catalog.json> <runtime-view.json> \
                                                [--json-out FILE]
```

### 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功，无 P0/P1 问题 |
| 1 | 通用失败（参数错误、文件缺失） |
| 2 | 至少发出一个 P0 或 P1 Runtime 一致性警告 |

## 语义 diff

`scripts/provider-discovery/diff.js` 生成稳定、排序的 diff，带有严重性标记：

| 类型 | 默认严重性 |
|---|---|
| `protocol_support_changed` | P1 (true→false/null), P2 (false/null→true) |
| `surface_support_changed` | P1 (supported→unknown), P2 (unknown→supported) |
| `base_url_changed` | P3（仅元数据） |

严重性桶按 v1.1 第十二节：

| 优先级 | 含义 |
|---|---|
| **P0** | Runtime 正在使用，Catalog 标记为不支持 |
| **P1** | 已确认移除、Runtime 能力不匹配、supported→unsupported、supported→unknown |
| **P2** | 新能力、缺失模型、新模型 |
| **P3** | 其他元数据变更 |

Diff 输出对以下情况保持不变：

- 源 JSON 中的 Provider 键顺序
- Surface 数组顺序
- base URL 路径名的尾部斜杠
- `/models` 端点结果排序

## Runtime 一致性检查

`scripts/provider-discovery/runtime-check.js` 将清理后的 Runtime Node 投影与 Catalog 进行比较，并发出警告。Runtime 视图有意是一个*投影*——仅包含 `id`、`provider`、`protocol`、`surfaces`、`base_url`——且**绝不**包含凭据。

该检查是只读的。它永不：

- 禁用节点
- 删除节点
- 修改 `protocol`、`surfaces` 或 `base_url`
- 更改 tier
- 触碰 Model Registry

警告按 P0 → P3 排序并打印到 stdout（或写入 `--json-out`）。

`base_url` 差异报告为 **differs**（不是 **invalid**）。该检查永不声称配置的 URL 已失效——那需要 Discovery 不收集的积极证据。

## 报告

### `changes.md`

`scripts/provider-discovery/report.js#formatChangesMarkdown` 编写人类可读的 Markdown 报告，包含以下部分：

- `## Changed` — 按 provider 分组，每个变更一个 bullet。
- `## Added` / `## Removed` — provider 级别转换。
- `## Runtime consistency` — 排序的警告列表。
- `## Catalog snapshot` — 每个 (provider, protocol) 一行。
- `## Notes` — v1.1 不变量固定。

### GitHub Action Summary

`formatActionSummary` 编写适合 `$GITHUB_STEP_SUMMARY` 的简短摘要：

```text
# Provider Discovery

Providers checked: 4

## Protocol support (supported only)

- OpenAI Chat: 3
- OpenAI Responses: 1
- Anthropic Messages: 2
- Anthropic count_tokens: 1

## Catalog changes

- Added providers: 0
- Removed providers: 0
- Protocol changes: 0
- Surface changes: 0
- Base URL changes: 0

## Runtime consistency

- Runtime configuration warnings: P0=0, P1=0, P2=0, P3=0
```

当存在 P0 警告时，Summary 会显示明确的标注。

## 工作流

`.github/workflows/provider-discovery.yml` 在夜间计划（04:00 UTC）和 `workflow_dispatch` 上运行管道。它：

1. 读取上一个和当前的 catalog 快照。
2. 规范化两者。
3. 计算 diff。
4. 运行 Runtime 一致性检查。
5. 将 `changes.md`、JSON artifact 和 runtime 警告作为单个 Artifact 上传。

该工作流**不是**必需 CI（`npm run validate:merge`）的一部分。它有意解耦，以便不稳定的第三方端点不会破坏 PR 合并。必需 CI 仅运行单元测试路径（`scripts/provider-discovery-test.mjs`），该路径是离线的。

## 安全

Discovery 模块永不：

- 读取或持久化凭据（Authorization headers、API keys、bearer tokens、cookies）。
- 从 provider 名称合成 URL。
- 执行主动探测（POST 生成请求、速度测试、健康探测）。
- 修改生产配置。

`base_url` 字段中的凭据承载 URL（`user:pass@host`）和类凭据 token（`sk-…`、`ghp_…`、`AKIA…`）会被丢弃并发出警告。Runtime-view 加载器仅读取从 Runtime Node 配置显式投影的字段；`credential`（秘密字段）永不加载。

## 模块布局

```
scripts/
├── provider-discovery.mjs               # CLI 驱动器
├── provider-discovery-test.mjs          # 单元测试（离线）
└── provider-discovery/
    ├── catalog-schema.js                # schema 常量 + 验证
    ├── normalize.js                     # 规范化 / 排序 / 标准化
    ├── diff.js                          # 语义 diff + 严重性
    ├── runtime-check.js                 # Runtime 一致性检查
    ├── report.js                        # changes.md + Action Summary 格式化器
    ├── load-snapshot.js                 # 快照 + runtime view 加载器
    ├── index.js                         # 公共导出
    └── samples/
        ├── catalog.example.json         # 示例 catalog
        └── runtime-view.example.json    # 示例清理后的 runtime view
```

Discovery 模块永不从 `src/runtime`、`src/scheduler`、`src/transport`、`src/request`、`src/reliability`、`src/stream`、`src/conversion`、`src/observability` 或 `src/protocol` 导入。这由不变量测试强制执行。

## 测试

`scripts/provider-discovery-test.mjs` 覆盖：

- Provider Capability schema（三态、surfaces、evidence）
- 规范化（稳定排序、secret 剥离、base URL 标准化）
- Diff 语义（added/removed/changed；严重性映射）
- Runtime 一致性（不匹配、base URL 漂移、无自动修改）
- 报告格式化器（markdown、summary、JSON）
- 安全不变量（任何输出路径中无 secrets）
- 边界不变量（无耦合到 runtime 热路径）

运行方式：

```bash
node scripts/provider-discovery-test.mjs
```

该测试通过 `npm run test:unit` 成为 `npm run validate:merge` 的一部分。
