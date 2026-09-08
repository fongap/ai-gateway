[CmdletBinding()]
param(
    [string[]]$ExtraArgs = @()
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Delegate to cloudflare-wrangler.mjs for all business logic
$args = @('deploy', '--keep-vars') + $ExtraArgs
& node scripts/cloudflare-wrangler.mjs @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }