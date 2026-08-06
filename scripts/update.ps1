[CmdletBinding()]param()
$ErrorActionPreference='Stop';$Root=Split-Path -Parent $PSScriptRoot;Set-Location $Root
npm ci;if($LASTEXITCODE-ne0){throw 'npm ci 失败。'}
npm run verify;if($LASTEXITCODE-ne0){throw '项目验证失败。'}
npm run check:deploy;if($LASTEXITCODE-ne0){throw 'dry-run 失败。'}
npx --yes 'wrangler@4.114.0' whoami;if($LASTEXITCODE-ne0){throw '请先登录 Cloudflare。'}
$workerName=(Get-Content 'wrangler.jsonc' -Raw -Encoding UTF8|ConvertFrom-Json).name
Write-Host "目标 Worker：$workerName"
Write-Host '安全更新只部署代码，使用 keep_vars 保留控制台变量和已有 Secret。'
if((Read-Host '确认更新上述 Worker？[y/N]')-notmatch'^(y|yes)$'){throw '已取消。'}
npx --yes 'wrangler@4.114.0' deploy --keep-vars;if($LASTEXITCODE-ne0){throw '部署失败。'}
Write-Host '代码更新完成。请执行 health-check.ps1 与 models-check.ps1。'
