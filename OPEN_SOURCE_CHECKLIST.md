# 开源发布检查清单 / Open Source Checklist

## 构建与验证 / Build & verify

- [ ] `npm ci` 成功；
- [ ] `npm run verify` 全部通过（syntax + version + deployment-config + tests + secret scan）；
- [ ] `npm run check:deploy` Wrangler dry-run 通过；
- [ ] `package.json`、`APP_META.version`、`CHANGELOG.md` 版本一致；
- [ ] Dashboard、`/version`、`/health`、`/metrics` 冒烟不报错；
- [ ] ZIP 与 TAR.GZ 均可正常解压，`release/SHA256SUMS` 与发布资产一致。

## 安全 / Security

- [ ] 仓库中不存在 `.dev.vars`、`.env`、`secrets*.json`、`wrangler.user.jsonc`；
- [ ] 示例配置中的 Token 均为占位符；
- [ ] Git 历史无真实密钥提交；
- [ ] `/health`、`/metrics`、`/v1/models` 均需鉴权，响应中无凭据与上游地址（未开 EXPOSE_UPSTREAM_INFO 时）;
- [ ] 确认非白名单路径不会被转发到任何上游；
- [ ] 确认上游默认仅允许 `https://` 且 `redirect: 'manual'`；
- [ ] 确认节点配置变量中不含任何凭据字段（工具会拒绝）；
- [ ] 确认 `wrangler.jsonc` 保持 `keep_vars: true` 且不含 `vars` 节点；
- [ ] Release 打包排除 dry-run 产物与临时 Secrets 文件；
- [ ] 已开通 GitHub Security Advisories 私密报告渠道。

## 文档 / Docs

- [ ] `README.md` 与 `README_EN.md` 功能、边界和配置说明一致；
- [ ] Breaking Change 说明位于 README 顶部；
- [ ] 架构图与当前目录逻辑一致（`docs/ARCHITECTURE.md`）；
- [ ] 配置示例与新 schema 一致（`docs/CONFIGURATION.md`）。

## GitHub 流程 / GitHub

- [ ] CI 在 `main` 与 Pull Request 上通过；
- [ ] Tag `v*.*.*` 触发 Release 工作流并上传资产；
- [ ] 仓库描述、Topics 与实际定位一致；
- [ ] LICENSE（MIT）版权行正确。
