# Changelog

## 5.13.0 - 2026-08-06

- 增加 `keep_vars: true`，代码更新不再删除控制台中的普通运行时变量；
- 补齐可直接执行 `npm ci` 的 `package-lock.json`，Wrangler 改为固定版本的按需 `npx` 调用；
- 默认启用路径与方法白名单，仅开放 Chat Completions、Anthropic Messages、模型列表和诊断端点；
- Primary 默认强制 HTTPS，并保留 Base URL 中的固定查询参数；
- `FAKE_STREAM_PROTECTION` 默认关闭，避免未经用户确认改变请求语义；
- 增加可选 `STRICT_MODEL_MAPPING` 模型白名单；
- 冷却、窗口上限和并发上限改为真正排除端点，不再仅做排序降权；
- 流式响应在连接结束后才释放 active request 并计为成功；
- 模型列表增加独立超时与最大尝试次数；
- 默认隐藏 `/health`、`/metrics` 和响应头中的上游基础设施信息；
- 增加安全更新与显式关闭 Fallback 的 Windows / Linux / macOS 脚本；
- 扩充路由、HTTPS、查询参数、冷却、并发与流式统计回归测试；
- CI 增加 Wrangler dry-run 检查；
- 部署脚本增加逐端点 HTTPS 校验，避免混合配置被静默忽略；
- 转发客户端提供的 `Idempotency-Key`，降低支持幂等上游的重复调用风险；
- 延迟指标明确为到响应头的首字节时间，并保留旧指标名称作为兼容别名；
- 默认错误响应进一步隐藏 Fallback Base URL 与真实 provider；
- 更新 Dashboard 安全变量说明与实际预览图；
- GitHub Actions 更新为当前 `checkout@v6` 与 `setup-node@v6`；
- `/health` 与 `/metrics` 增加独立的客户端请求、成功、失败、Fallback 触发与 Fallback 成功计数。

## 5.12.0 - 2026-08-06

- 将 `/v1/models` 从偶然的单端点透传改为独立能力：依次尝试 Primary，并合并 `MODEL_MAPPING` 别名；
- 增加模型列表检查脚本与多端点回归测试；
- 增加公开的 `/version` 版本接口；
- 增加中英文架构图与 Dashboard 实际预览图；
- 升级 GitHub Actions，并补充 Tag 自动创建 GitHub Release；
- 发布脚本改为从 `package.json` 自动读取版本并同时生成 ZIP、TAR.GZ 与校验值；
- 增加版本一致性检查、Markdown 本地链接检查和依赖锁文件；
- 增加 Issue 模板、Pull Request 模板与 Dependabot 配置；
- 完善中英文 README、Cloudflare GitHub 自动部署说明和运行指标边界说明；
- Wrangler 固定为 `4.114.0`。

## 5.11.0 - 2026-08-06

- 项目名称统一为“智能边缘网关”；
- 移除前端 Cloudflare Workers 与版本展示；
- 客户端鉴权变量统一为 `GATEWAY_ACCESS_KEY`；
- 第二兜底只保留 `off` 作为显式关闭值；
- 缩小首页主标题字号；
- 保留 OpenAI / Anthropic 双协议、Primary 池与双级 Fallback；
- 整理为可公开发布的 Wrangler 项目结构；
- 增加 Windows、Linux 和 macOS 部署脚本、健康检查脚本与开源文档；
- 增加中英文双语 README，并在两版顶部提供语言切换。
