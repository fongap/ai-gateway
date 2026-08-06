[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
npm ci
if($LASTEXITCODE -ne 0){throw 'npm ci 失败。'}
npm run verify
if($LASTEXITCODE -ne 0){throw '项目验证失败。'}
npx --yes wrangler@4.114.0 deploy --keep-vars
if($LASTEXITCODE -ne 0){throw 'Worker 部署失败。'}
