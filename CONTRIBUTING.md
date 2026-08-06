# 贡献指南

## 提交前

```bash
npm install
npm run verify
```

## 修改原则

- 不提交真实 Token、域名、账户 ID 或用户数据；
- 保持 OpenAI 与 Anthropic 两条协议路径兼容；
- Fallback 不得进入正常 Primary 轮询；
- 新增环境变量时同步更新源码顶部注释、首页说明和 `docs/CONFIGURATION.md`；
- 影响响应格式的变更必须说明兼容性风险；
- 避免为了展示效果引入运行时依赖。

## Pull Request

PR 说明至少包含：

1. 问题与目标；
2. 具体改动；
3. 测试方法；
4. 配置或兼容性变化；
5. 是否涉及安全、隐私或额外资源消耗。
