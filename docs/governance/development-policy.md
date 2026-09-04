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
