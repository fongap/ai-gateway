# Security Policy

## Supported versions

Only the current `main` branch and the latest published release are actively maintained. Older releases may not receive security fixes.

## Reporting a vulnerability

Do not disclose exploitable details in a public Issue. Use the repository's **Security → Report a vulnerability** flow to create a private GitHub Security Advisory.

Never include:

- API tokens or `GATEWAY_ACCESS_KEY` values;
- full authorization headers;
- private upstream URLs;
- user prompts, request bodies, or personal data;
- live exploit details in a public thread.

If private advisories are unavailable, open a public Issue containing only a request for a private reporting channel.

## Deployment responsibilities

- Store `GATEWAY_ACCESS_KEY`, `PRIMARY_API_TOKENS`, and Fallback tokens as Cloudflare Secrets;
- never commit `.dev.vars`, `.env`, or `secrets*.json`;
- never pass credentials through URL query parameters;
- keep `/health` and `/metrics` protected;
- revoke and rotate exposed or suspected credentials immediately;
- review Worker logs before sharing them publicly.

## 中文说明

仅维护主分支和最新发布版本。漏洞应通过 GitHub Security Advisory 私密报告，不要在公开 Issue 中粘贴 Token、完整请求头、私有地址、用户请求正文或可直接利用的漏洞细节。

