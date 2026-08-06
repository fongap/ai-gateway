# 贡献指南 / Contributing

## 提交前 / Before submitting

```bash
npm ci
npm run verify
```

## 修改原则

- 不提交真实 Token、私有域名、账户 ID 或用户数据；
- 保持 OpenAI 与 Anthropic 两条协议路径兼容；
- Fallback 不得进入正常 Primary 轮询；
- 新增环境变量时同步更新源码顶部注释、Dashboard 和 `docs/CONFIGURATION.md`；
- 影响响应格式的变更必须说明兼容性风险；
- 避免为了展示效果引入 Worker 运行时依赖；
- 修改功能或部署方式时同步更新 `README.md` 与 `README_EN.md`；
- 修改版本时同步 `package.json`、`APP_META.version` 和 `CHANGELOG.md`。

## Pull Request

PR 至少说明：

1. 问题与目标；
2. 具体改动；
3. 验证方法；
4. 配置或兼容性变化；
5. 安全、隐私、延迟或资源消耗影响。

Use the repository Pull Request template and ensure all CI checks pass before requesting review.
