[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Thin wrapper for compatibility - delegate to install.ps1
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }