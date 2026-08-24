[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$userConfig = Join-Path $Root 'wrangler.user.jsonc'
if (Test-Path $userConfig) {
  & npx --yes 'wrangler@4.114.0' deploy -c 'wrangler.user.jsonc' --keep-vars
} else {
  & npx --yes 'wrangler@4.114.0' deploy --keep-vars
}
if ($LASTEXITCODE -ne 0) { throw 'deploy failed.' }
