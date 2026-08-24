[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
& npx --yes 'wrangler@4.114.0' whoami
if ($LASTEXITCODE -ne 0) { & npx --yes 'wrangler@4.114.0' login }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1')
