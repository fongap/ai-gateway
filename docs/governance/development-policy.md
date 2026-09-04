# 开发治理

## 分支策略

- `main` 是唯一的长期分支，触发自动部署
- 禁止直接 push `main`
- 禁止绕过 Required Checks
- 禁止 force push `main`

### 分支命名

```text
feat/     新功能
fix/      修复
refactor/ 重构
ci/       CI 改动
chore/    杂务
docs/     文档
test/     测试
release/  发布
```

## Commit Messages

使用 Conventional Commits 风格：

```
feat: add request-level failover budget
fix: prevent half-open probe leak in circuit breaker
refactor: split model registry out of provider profiles
docs: clarify isolate-local quota semantics
test: cover hard RPM exhaustion and SSE error envelopes
chore: pin GitHub Actions to commit SHAs
ui: refine public gateway entry page
```

规则：一个逻辑变更一条 commit；subject line 描述**行为**变更，不是文件列表；scheduling/reliability 改动应引用覆盖它的回归测试。

## Pull Request

PR 必须说明：目标、改动点、验证结果、破坏性变更、安全影响。

一个 PR 聚焦一个主要目标。使用仓库 Pull Request 模板，确保所有 CI checks 通过后再请求 review。

## Review

- 至少 1 个 approval
- 作者不能 self-approve
- Reviewer 关注：架构一致性、安全影响、测试覆盖、文档同步

## Merge

- 使用 squash merge（线性历史）
- 禁止 merge commits 和 rebase merge
- 合并前 CI 必须通过

## Refactor 原则

- 不改变功能行为
- 不修改协议行为
- 不修改调度行为
- 不修改可靠性策略
- 不修改配置语义
- 不修改默认 timeout/cooldown
- 不借文档重构顺便做代码重构
- **所有结构重构默认采用 behavior-preserving refactor**
- **不得借重构修改 Scheduler 算法**
- **不得借重构修改 Reliability 策略**
- **不得借重构修改协议行为**
- **不得借重构修改 fallback 行为**
- **不得借重构修改 hedge 行为**
- **不得借重构修改 timeout / cooldown**
- **不得借重构修改配置语义**
- **不得顺便修复无关业务 Bug**
- **不得顺便增加新功能**
- 发现业务 Bug：
  ```text
  记录
  ↓
  单独 Issue / PR
  ```
- **不得混入结构重构**。

### 行为等价原则（行为等价重构）

所有结构性改动必须遵循 Strict Behavior-Preserving Refactor：
- 不改变外部 API 行为
- 不改变状态码
- 不改变错误 envelope
- 不改变 header 语义
- 不改变 stream / non-stream 行为
- 不改变 fallback 顺序
- 不改变 hedge 行为
- 不改变 failover budget
- 不改变 timeout 语义
- 不改变 cooldown / half-open / circuit 行为
- 不改变 Tier 1 P2C 行为
- 不改变 Tier 2/3 调度语义
- 不改变 Key Scope
- 不改变模型可见性语义
- 不改变 D1 retention 语义

如果发现业务 Bug：记录问题，单独开 Issue 或单独 PR。不得借结构重构顺手修复。

### 测试优先于类型，类型辅助重构

本轮统一采用以下防护顺序：
```text
行为测试
    ↓
类型约束
    ↓
结构重构
```

类型系统不是行为正确性的替代品。checkJs + JSDoc 可以捕获参数遗漏、字段拼写错误、返回值不完整、跨模块契约漂移、null/undefined 使用错误，但它不能证明 P2C 行为不变、hedge 时机不变、failover budget 不变、first-event commit point 不变、Retry-After 语义不变、stream 生命周期不变。

因此：每个核心重构 PR 都必须同时有行为回归测试。

### 不做全量重写

禁止：
- 整个仓库 .js → .ts
- 重构 + TypeScript + 业务修复 一次完成
TypeScript 只采用渐进式迁移。

### Runtime 依赖策略

继续保持：Runtime zero-dependency / minimal-dependency。
不得为了重构引入：Express、Hono、Axios、Lodash、Zod、Jest、Vitest 或其他非必要 Runtime framework。
Cloudflare Worker Runtime 优先使用：Web Standard API、Node built-in、当前已有轻量实现。
TypeScript 可作为 devDependency，但不得进入 Worker runtime 依赖链。

### 性能约束

不要使用“绝对零 allocation”作为形式主义 KPI。
正确约束是：不得引入可测量的、无必要的请求热路径性能回退。
重点禁止：重复 JSON parse、重复 JSON stringify、重复 Registry 构建、重复 env shard parse、重复 config load、无必要 deep clone、无必要 structuredClone、无必要 Object.freeze / deepFreeze、重复 D1 query。
为模块化增加明显的中间 buffer 或为类型安全增加 runtime 转换如确有少量新 Context Object / Result Object，只要：逻辑清晰、不产生明显热点、不造成可测量性能回退，可以接受。

## 明确模块职责

长期边界：

```text
config
→ 配置、Model Registry、Policy、Runtime Node

scheduler
→ 选择哪个节点

reliability
→ 节点当前是否可用，以及失败如何影响节点状态

request
→ 请求入口与跨模块 orchestration

transport
→ 如何与上游通信

protocol
→ 客户端协议校验与协议语义

stream
→ First Event、SSE、stream 生命周期

observability
→ 日志、指标、D1 统计、diagnostics

runtime
→ Runtime 状态与公开状态投影
```

特别明确：

> `src/request` 是 Orchestration Layer，不应复制 Scheduler、Reliability、Transport、Protocol 或 Stream 的领域逻辑。

## 增加结构演进顺序

长期统一采用：

```text
定义边界
↓
JavaScript behavior-preserving 拆分
↓
完整测试证明行为等价
↓
建立静态类型基线
↓
渐进 TypeScript
```

禁止：

```text
重构 + 功能新增 + 全量 TypeScript
```
一次完成。

## TypeScript 长期策略

TypeScript 采用：

```text
TypeScript compiler
+ allowJs
+ checkJs
+ strict
+ noEmit
+ JSDoc
```

作为第一阶段。

正式迁移原则：

```text
config
↓
scheduler / reliability
↓
request
↓
transport / protocol
↓
observability
↓
dashboard / scripts
```

禁止一次性：

```text
全仓 .js → .ts
```

明确：

TypeScript 可以作为 `devDependency`。

不得因为 TypeScript 引入新的 Runtime Framework。

继续优先保持：

**Runtime zero-dependency / minimal-dependency**。

## Breaking Change

- 必须在 PR 中明确标记
- 必须在 CHANGELOG 中记录
- 必须同步更新文档
- 必须确保版本号递增

## 文档同步要求

影响对外行为时更新 `README.md` 与 `README_EN.md`；修改版本时同步 `package.json`、`APP_META.version` 与 `CHANGELOG.md`。

影响调度/可靠性/配置格式时，同步更新集成测试（`scripts/integration-test.mjs`）与文档。

详见 [documentation-policy.md](documentation-policy.md)。
