# 贡献指南 / Contributing

## 提交前 / Before submitting

```bash
npm ci
npm run verify        # syntax + version + config checks + tests + secret scan
npm run check:deploy  # wrangler dry-run bundle
```

## 修改原则 / Principles

每个改动都应回答：是否提高上游配额利用率？是否提高稳定性？是否降低 Worker CPU 开销？代码是否更简单、更可预测？
Every change should answer: does it improve upstream quota utilization, reliability, Worker CPU cost, or predictability? If not, leave it out.

- 不提交任何真实凭据（Token / `GATEWAY_ACCESS_KEY` / 上游账号）。
  Never commit real credentials.
- 保持 OpenAI / Anthropic 双协议路径行为一致。
  Keep the OpenAI and Anthropic protocol paths behaviorally consistent.
- 超时/冷却默认值只允许出现在 `src/config/timeouts.js`。
  Timeout and cooldown defaults live only in `src/config/timeouts.js`.
- 节点运行时状态只允许通过 `src/reliability/node-state.js` 修改。
  Node runtime state is mutated only through `src/reliability/node-state.js`.
- 流式行为改动必须保持 First Event Guard 边界语义（首事件前可切换节点，之后绝不）。
  Streaming changes must preserve the first-event guard boundary.
- 影响调度/可靠性/配置格式时，同步更新集成测试（`scripts/integration-test.mjs`）与文档。
  Update integration tests and docs together with scheduling/config changes.
- 影响对外行为时更新 `README.md` 与 `README_EN.md`；修改版本时同步 `package.json`、`APP_META.version` 与 `CHANGELOG.md`。
  Update READMEs for user-visible changes; keep version fields in sync.

## Pull Request

PR 请说明：目标、改动点、验证结果、破坏性变更、安全影响。
Describe: goal, changes, verification, breaking changes, security impact.

Use the repository Pull Request template and ensure all CI checks pass before requesting review.
