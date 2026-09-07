# TypeScript 迁移治理(v1.3.0)

v1.3.0 阶段的唯一工程目标:在完全冻结 v1.2.6 的架构、行为与公开接口的前提下,把 `src/` Runtime 源码从 Typed JavaScript 完整迁移到 strict TypeScript。本阶段不是功能开发、不是架构重构、不是算法优化。

本文件是 v1.3.0 迁移期间所有 TS 迁移 PR 的最高治理依据;分支、Commit、Review、Merge 与 Release 的通用规则仍以 [development-policy.md](development-policy.md) 与 [release-policy.md](release-policy.md) 为准。

## 核心原则

```text
先保证行为不变
再完成语言迁移
最后才进入下一阶段功能开发
```

- **TypeScript Migration = behavior-preserving。** 每个迁移 PR 必须满足 `before behavior == after behavior`。
- 迁移期间 **Feature Freeze / Architecture Freeze / Protocol Freeze / Scheduler Freeze** 持续有效,直到 v1.3.0 正式发布。
- 正式版本策略:v1.2.6 = 最后一个 JavaScript Runtime Stable Baseline;v1.3.0 = TypeScript Runtime Stable Baseline。迁移属于内部工程升级,公开 API 保持兼容,因此升 Minor 而非 Major。
- 迁移 PR 阶段不发布正式 Release,不反复变更版本号(1.2.7 / 1.3.0-dev 之类);全部迁移完成后统一升级 `package.json` / `APP_META` / `CHANGELOG` 到 1.3.0,按 [release-policy.md](release-policy.md) 走 final release 流程(tag 指向 main final squash commit,不得提前创建)。

## 冻结基线与回滚

```text
v1.2.6 = frozen rollback baseline(最后一个稳定 JS Runtime)
main   = TypeScript migration 工作线
```

v1.2.6 已固化的全部行为均为 **Frozen Behavior**:OpenAI / Anthropic Native First、显式 Anthropic → OpenAI Chat fallback、Tier 1 Eligibility + Affinity + P2C、Tier 2/3 fallback、Cooldown / Circuit / Half-open、Hedge、Failover Budget、Closed Model Catalog、Model Registry、Key-scoped Models、D1 Token Statistics、24h Recent Evidence、全模型 grouped TTFT、Calendar Heatmap 两模式、Production Gate、D1 migration-before-deploy、Release / Tag Governance、Typed JS strict 检查。

任何阶段出现严重协议回归、Scheduler 行为变化、Streaming 错误、Production 5xx 明显上升或类型迁移无法证明行为等价:

```text
停止下一阶段
↓
revert 当前迁移 PR
↓
必要时回滚到 v1.2.6 行为基线
```

禁止继续叠补丁掩盖问题。

## 禁止事项(直到 v1.3.0 发布)

### 禁止新增功能

Omni、Omni-Audio、Omni-Video、Omni-Images、Live、Realtime、新 Provider、新 Protocol、新 Surface、新 Tier、新 Scheduler、新 Dashboard 页面、新数据库、Redis、Durable Objects 架构、新 Plugin Framework。

### 禁止修改核心行为

Tier 1 Eligibility、Affinity、P2C、Passive TTFT Learning、Tier 2/3 Scheduler、Cooldown、Circuit、Half-open、Hedge、Failover、Failover Budget、Retry、RPM、Protocol fallback、Streaming、First Event Guard、Token accounting、Model Registry semantics、Closed Model Catalog、D1 retention semantics、KV affinity semantics、Public Model Status semantics。

### 禁止借迁移进行架构重构

禁止"既然改 TS,顺便重写"。不得新增 Strategy Pattern、全面 Class 化、DI Container、通用 Framework、Repository Pattern、Service Locator;不得改 Scheduler 算法、模型目录、错误码、公开 JSON 格式、环境变量、API 路径。

### 禁止新增 Runtime dependency

`production dependencies` 必须始终保持 0。禁止 lodash、axios、zod、date-fns、moment、rxjs、dependency injection 库、runtime schema framework 等;Cloudflare 类型(如 `@cloudflare/workers-types`)只能作为 devDependency,不得进入 Runtime bundle。

### 禁止修改契约与工作流

- Architecture Contract Tests 的预期不得修改以迁就迁移;任何契约失败优先视为迁移引入回归,而不是修改 contract。
- Deployment 工作流语义(push main → full CI → D1 migration → Worker deploy → health check;nightly / manual CI 永不部署;manual Deploy 必须先完整验证)不得因 `.js → .ts` 改变。

## 迁移顺序(固定范围,PR 0–PR 7)

```text
PR 0  治理冻结(本文件)
PR 1  TypeScript Toolchain Baseline(tsconfig / .ts 链路最小验证)
PR 2  config + scheduler + reliability + ratelimit
PR 3  request orchestration
PR 4  protocol + transport + stream + conversion
PR 5  observability + runtime
PR 6  dashboard
PR 7  worker entry(index)+ 最终清理收口
```

- 每个阶段单独 `branch → PR → CI → merge main(squash)`;不建立长期漂移的大型 TS 分支(禁止 `refactor/typescript` 攒几个月一次性合并)。
- 文件迁移必须使用 Git-aware rename(`git mv x.js x.ts`),保证 history 可追踪;不得删除旧文件再新建。
- 每个迁移 PR 的完成报告必须包含:Scope(迁移模块)、File Migration 列表、Type Changes、**Behavior Changes(必须 None,否则该 PR 原则上不属于 TypeScript Migration)**、Runtime Dependency Before/After(必须仍为 0)、Bundle Before/After/Delta、Verification 结果(validate:merge / typecheck / strict / test:all / check:deploy / contracts)、Risks(type assertion、外部 JSON 边界、Cloudflare typing compromise、临时兼容层)。
- ambient `src/types/domain.d.ts` 随模块迁移逐步收敛为显式模块类型(`src/types/*.ts`),迁一个模块搬对应 type 并替换 ambient usage,全部迁移后删除;不要求第一个迁移 PR 一次性重写全部 types。
- `scripts/*.mjs`、`tests/*.mjs`、`benchmark/*.mjs` 属于 build tooling / contract tests / migration tooling / CI tooling,不是 Worker Runtime,保持 JavaScript / MJS;不追求"100% repository TypeScript",不为此引入 tsx、ts-node 或复杂编译步骤。最终目标:`src/**/*.js` → 0(极个别必须保留 JS 的,在最终报告明确解释)。

## 工具链原则

- 构建链路:`TypeScript source → Wrangler bundler → JavaScript Worker bundle → Cloudflare Workers`。不引入 tsc emit、dist/、webpack、rollup、vite、babel,除非 Wrangler 确实无法完成现有构建。
- `tsc` 只承担 type checking(`noEmit: true`)。
- Node 侧测试直接以原生 type stripping 执行 `.ts`(Node ≥ 22.18 / ≥ 23.6 默认开启),不引入大型测试执行器或 loader。因此 Runtime TS 必须使用 **erasable-only 语法**:禁止 `enum`、`namespace`、构造函数参数属性;固定字符串集合使用 union type(与现有 domain types 约定一致)。
- **Import specifier 规则:相对 import 一律书写目标文件的真实扩展名。** 迁移期间引用未迁移模块写 `.js`,模块迁移后引用方同步改为 `.ts`;必须先统一 source imports / test imports / Wrangler resolution 规则,再批量迁移。不采用"TS 源码写 `.js` specifier"的 Bundler 惯例——Node 原生测试执行要求真实扩展名。tsconfig 以 `allowImportingTsExtensions` + `noEmit` 支撑该规则。
- 保持 ESM(`import` / `export`);禁止迁移成 CommonJS / `require()` / `module.exports`。
- tsconfig 收口:迁移期间保留 loose 主 tsconfig(存量 .js)与 strict gate(tsconfig.strict.json)双轨,所有 `.ts` 文件自诞生之日起必须 strict-clean;迁移完成后收敛为**一个** strict 主 tsconfig(`strict: true`、`noEmit: true`),tsconfig.strict.json 与 JS check 模式退役;测试或 tooling 如需独立配置只允许 `tsconfig.test.json`,Runtime 类型规则只有一套。

## 类型纪律

- 最终必须 `strict: true` 并至少包含 `noImplicitAny`、`strictNullChecks`、`noImplicitThis`;禁止通过关闭检查"解决错误",禁止降低现有类型标准。
- `@ts-ignore` / `@ts-nocheck` = 0;迁移过程中临时存在的,必须在当前 PR 合并前清理。
- 禁止批量 `any`、大量非空断言(`!`)、脚本化"修类型"作为消错手段;`any` 仅允许出现在真正不可控的外部边界并注释原因,优先 `unknown → validate → narrow → typed internal value`。
- 类型必须描述真实 Runtime 语义:不把真实 nullable 字段硬写 non-null,不把所有属性都加 `?`。
- 外部边界(env、KV、D1 rows、上游 JSON、客户端 JSON)禁止 `JSON.parse(x) as T` 直转,除非紧接着有完整 validation。
- Cloudflare Runtime 类型明确 `Env`、`ExecutionContext`、`ScheduledController`、`KVNamespace`、`D1Database`、`Fetcher`、`RateLimit` 中真实使用的部分(只用什么声明什么);统一 `interface Env`,禁止每个模块 `env: Record<string, any>`。D1 查询结果定义明确 row 结构,禁止 `row as any`。

## 公开 API 与性能

- 公开 API 零变化:`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`、`POST /v1/messages/count_tokens`、`GET /v1/models`、`GET /health`、`GET /metrics`、`GET /version`、`GET /`。除 `/version` 允许新增向后兼容的 build/revision 字段外,不得删除或修改现有字段。
- Build Identity:Semantic Version = Release identity,Build SHA = Deployment identity(优先在 CI/Deploy 注入 `GITHUB_SHA`,不手工维护);不得把每次 deployment 变成 patch version bump。
- 性能:TS 类型是 compile-time only;迁移不得增加额外 Runtime validation 层、热路径对象拷贝、额外 JSON parse/stringify、数据库 / KV 查询或网络请求。Runtime 性能应与 v1.2.6 基本一致。
- Bundle:每个迁移 PR 记录 `npm run check:deploy` 的 Wrangler dry-run bundle size 并与迁移前对比;无业务原因增长 > 10% 必须分析。

## 每个 PR 的最低验证

```bash
npm ci
npm run validate:merge
npm run typecheck
npm run check:deploy
```

核心 Runtime PR(scheduler / reliability / request / protocol / transport / stream / conversion)另需 `npm run test:all`。strict 配置最终收口前,现有 strict gate 始终保留。

Architecture Contracts 必须始终全绿,至少覆盖:Native First、Explicit fallback only、No implicit conversion、Unsupported conversion → reject、Hedge protocol isolation、Stream commit boundary、Shared failover budget、Logical attempt ≠ dispatch count、Pre-dispatch denial 不计 budget、Closed Catalog、Visible == Callable、Model Missing Isolation、Runtime Projection 不反馈 hot path、D1 failure 不阻断 routing。

## 测试分层

`validate:merge` = 快速但覆盖所有轻量行为契约:Dashboard HTML contracts、Calendar heatmap renderer、route contracts、configuration contracts、model-status contracts、version/build identity contracts(新增轻量契约一律纳入 `test:unit`)。`validate:deploy` 保留:scheduler stability、stress、full integration、Codex / Claude contract、慢速协议端到端验证。不得让所有 PR 全跑全量慢测试,也不得让 PR CI 遗漏轻量契约(防止"PR CI green、merge 后 integration 才发现回归"复发)。
