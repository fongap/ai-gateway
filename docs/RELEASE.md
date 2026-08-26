# 发布流程 / Release Process

## 版本同步

发布前必须同步以下位置：

1. `package.json` 中的 `version`；
2. `src/observability/status.js` 中的 `APP_META.version`；
3. `CHANGELOG.md` 中新增对应版本标题。

随后更新依赖锁文件：

```bash
npm install --package-lock-only
```

执行：

```bash
npm ci
npm run verify
```

`npm run check:version` 会阻止三个版本号不一致的发布。

## 本地生成发布包

Linux / macOS：

```bash
./scripts/build-release.sh
```

Windows PowerShell：

```powershell
.\scripts\build-release.ps1
```

输出：

```text
release/ai-gateway-vX.Y.Z.zip
release/ai-gateway-vX.Y.Z.tar.gz
release/SHA256SUMS
```

PowerShell 在系统没有 `tar` 命令时只生成 ZIP。

## GitHub 自动 Release

提交版本修改后创建与 `package.json` 匹配的 Tag：

```bash
git add .
git commit -m "Release v1.2.1"
git tag v1.2.1
git push origin main
git push origin v1.2.1
```

`.github/workflows/release.yml` 会：

1. 安装锁定依赖；
2. 执行完整验证与 Wrangler dry-run；
3. 验证 Tag 与版本号一致；
4. 生成 ZIP、TAR.GZ 和 SHA-256；
5. 创建 GitHub Release 并上传资产。

Tag 不匹配时工作流会终止，不会发布错误版本。

