[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Wrangler = 'npx'
$WranglerArgs = @('--yes', 'wrangler@4.114.0')
$userConfig = Join-Path $Root 'wrangler.user.jsonc'

function Invoke-Wrangler {
    param([string[]]$ExtraArgs)
    & $Wrangler @WranglerArgs @ExtraArgs
    if ($LASTEXITCODE -ne 0) { throw "wrangler failed: $($ExtraArgs -join ' ')" }
}

function Test-HasD1Binding {
    if (-not (Test-Path $userConfig)) { return $false }
    $config = Get-Content $userConfig -Raw | Convert-FromJson
    $dbs = @($config.d1_databases | Where-Object { $_.binding -eq 'TOKEN_STATS_DB' })
    return $dbs.Count -gt 0
}

function Get-D1DatabaseName {
    $config = Get-Content $userConfig -Raw | Convert-FromJson
    $db = $config.d1_databases | Where-Object { $_.binding -eq 'TOKEN_STATS_DB' } | Select-Object -First 1
    return $db.database_name
}

function Test-HasAffinityKvBinding {
    if (-not (Test-Path $userConfig)) { return $false }
    $config = Get-Content $userConfig -Raw | Convert-FromJson
    return @($config.kv_namespaces | Where-Object { $_.binding -eq 'TIER1_AFFINITY' -and $_.id }).Count -gt 0
}

if (Test-Path $userConfig) {
    if (-not (Test-HasAffinityKvBinding)) { throw 'Required TIER1_AFFINITY KV binding is missing from wrangler.user.jsonc.' }
    if (Test-HasD1Binding) {
        $dbName = Get-D1DatabaseName
        Write-Host "applying D1 migrations to '$dbName' (remote)..."
        Invoke-Wrangler @('d1', 'migrations', 'apply', $dbName, '--remote', '-c', 'wrangler.user.jsonc')
    } else {
        Write-Host 'skip: no TOKEN_STATS_DB binding in wrangler.user.jsonc'
    }
    Invoke-Wrangler @('deploy', '-c', 'wrangler.user.jsonc', '--keep-vars')
} else {
    throw 'wrangler.user.jsonc is required and must contain the TIER1_AFFINITY KV binding.'
}
