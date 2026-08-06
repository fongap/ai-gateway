# 开源发布检查清单

## 必须完成

- [ ] `npm run verify` 全部通过；
- [ ] 仓库中不存在 `.dev.vars`、`.env`、`secrets*.json`；
- [ ] 示例中的 Token、域名和账户 ID 均为虚构值；
- [ ] Git 历史中不存在曾经提交过的真实密钥；
- [ ] 已确认首页“源码”按钮指向实际公开仓库；
- [ ] 已确认页脚署名和 MIT License 版权主体；
- [ ] 已开启 GitHub Security Advisories；
- [ ] 已为主分支启用 Pull Request 与 CI 检查；
- [ ] 已使用全新密钥完成一次真实部署验证；
- [ ] 已验证 `/health`、`/metrics`、OpenAI 和 Claude Code 四条路径。

## 特别提醒

删除当前文件并不能清除 Git 历史中的密钥。任何曾经进入 Git 提交历史的密钥，都应立即作废并重新生成，而不是只做文本替换。
