# Security Policy

## 支持范围

仅维护当前主分支和最新发布版本。历史版本可能不再接收安全修复。

## 报告漏洞

请不要在公开 Issue 中提交以下内容：

- API Token 或网关访问密钥
- 可直接利用的漏洞细节
- 用户数据、请求正文或内部域名

优先通过 GitHub 仓库的 **Security → Report a vulnerability** 私密报告。仓库未启用 Security Advisories 时，请先创建不含利用细节的普通 Issue，请求维护者提供私密联系渠道。

## 部署者责任

- `GATEWAY_ACCESS_KEY`、`PRIMARY_API_TOKENS` 和 Fallback Token 必须使用 Cloudflare Secrets；
- 不要把 `.dev.vars`、`.env`、`secrets*.json` 提交到 Git；
- 不要通过 URL 查询参数传递密钥；
- 定期轮换已暴露或疑似泄露的密钥；
- `/health` 与 `/metrics` 必须保持鉴权。
