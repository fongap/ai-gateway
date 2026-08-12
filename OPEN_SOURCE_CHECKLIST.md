# 开源发布检查清单

## 代码与验证

- [ ] `npm ci` 成功；
- [ ] `npm run verify` 全部通过；
- [ ] `npm run check:deploy` Wrangler dry-run 通过；
- [ ] `package.json`、`APP_META.version` 和 `CHANGELOG.md` 版本一致；
- [ ] Dashboard、`/version`、`/health`、`/metrics` 冒烟测试通过；
- [ ] ZIP 和 TAR.GZ 能正常解压；
- [ ] `release/SHA256SUMS` 与发布资产一致。

## 安全

- [ ] 仓库中不存在 `.dev.vars`、`.env`、`secrets*.json`；
- [ ] 示例 Token、域名和账户 ID 均为虚构值；
- [ ] Git 历史中不存在曾提交过的真实密钥；
- [ ] 已确认 `/health`、`/metrics` 和 `/v1/models` 仍需鉴权；
- [ ] 已确认白名单外路径和危险 HTTP 方法不会被转发；
- [ ] 已确认 Primary / Fallback 默认只接受 HTTPS；
- [ ] 已确认更新部署保留已有普通变量和 Secrets；
- [ ] 已确认 `wrangler.jsonc` 含 `keep_vars: true` 与两个 `secrets.required`；
- [ ] 已确认重新配置脚本可用 `null` 删除旧 Fallback Secret；
- [ ] 已确认 Release 不包含 `.wrangler-dry-run`、临时 Wrangler 配置或 Secrets 文件；
- [ ] 已开启 GitHub Security Advisories；
- [ ] 已确认 Security Advisory 私密报告链接可用。

## 文档与展示

- [ ] `README.md` 与 `README_EN.md` 的功能、变量和部署步骤一致；
- [ ] 架构图与当前路由逻辑一致；
- [ ] Dashboard 截图来自当前版本；
- [ ] 首页“源码”按钮指向实际公开仓库；
- [ ] GitHub Description、Topics 和仓库名称已设置；
- [ ] 页脚署名和 MIT License 版权主体已确认。

## GitHub 工程化

- [ ] CI 在 `main` 和 Pull Request 上通过；
- [ ] 主分支已启用 Pull Request 和必需检查；
- [ ] Dependabot 已启用；
- [ ] 使用与 `package.json` 匹配的语义化版本 Tag；
- [ ] GitHub Release 自动上传 ZIP、TAR.GZ 和 SHA-256。

## 真实部署

- [ ] 使用全新测试密钥完成一次 Cloudflare 部署；
- [ ] 验证 OpenAI Chat Completions；
- [ ] 验证 Anthropic Messages / Claude Code；
- [ ] 验证 Primary 失败后 Fallback 接管；
- [ ] 验证第二兜底关闭和启用两种状态；
- [ ] 验证 `/version` 的三个配置状态均为 `true`；
- [ ] 验证安全更新后原有运行时变量与 Secret 仍然有效。

## 特别提醒

删除当前文件不能清除 Git 历史中的密钥。任何曾进入 Git 提交历史的凭据都必须立即作废并重新生成。

