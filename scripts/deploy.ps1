[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install 失败。" }
npm run verify
if ($LASTEXITCODE -ne 0) { throw "项目验证失败。" }
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "Worker 部署失败。" }
