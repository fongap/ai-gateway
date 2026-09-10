[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-Wrangler([string[]]$Arguments) {
  & node scripts/cloudflare-wrangler.mjs @Arguments
  if ($LASTEXITCODE -ne 0) { throw "wrangler failed: $($Arguments -join ' ')" }
}
function Read-SecretText([string]$Prompt) {
  $s = Read-Host $Prompt -AsSecureString
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
function Read-FilePath([string]$Prompt, [bool]$Required) {
  $p = (Read-Host $Prompt).Trim()
  if ($p -eq '' -and -not $Required) { return $null }
  if ($p -eq '' -or !(Test-Path $p)) { throw "file not found: $p" }
  return $p
}

# Node.js version contract: single source of truth is package.json -> engines.node
$versionCheck = node scripts/version-check.mjs 2>$null
if ($LASTEXITCODE -ne 0) {
  $required = (Get-Content (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).engines.node
  throw "Node.js version check failed. Required: $required"
}

$configPath = Join-Path $Root 'wrangler.jsonc'
$baseConfig = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$defaultWorkerName = $baseConfig.name
$workerName = (Read-Host "Worker name [$defaultWorkerName]").Trim()
if (!$workerName) { $workerName = $defaultWorkerName }
if ($workerName -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') { throw 'Worker name must be 1-63 chars: lowercase letters, digits, hyphens.' }
$affinityKvId = (Read-Host 'Tier 1 affinity KV namespace ID (required)').Trim()
if ($affinityKvId -notmatch '^[a-fA-F0-9]{32}$') { throw 'Tier 1 affinity KV namespace ID must be 32 hexadecimal characters.' }

Write-Host '==> Installing dependencies and verifying project'
npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
npm run validate:merge; if ($LASTEXITCODE -ne 0) { throw 'project verification failed.' }

try {
  Invoke-Wrangler @('whoami')
} catch {
  Write-Host 'Not logged in to Cloudflare. Starting login...'
  Invoke-Wrangler @('login')
}

Write-Host '==> Node configuration'
Write-Host 'Node configs are PLAIN variables without credentials; credentials go into a separate NODE_SECRETS file.'
$tierFiles = @{}
foreach ($n in 1, 2, 3) {
  $required = ($n -eq 1)
  $p = Read-FilePath "tier-$n node config JSON file path$(if(-not $required){' (optional, empty to skip)'})" $required
  if ($p) { $tierFiles[$n] = (Resolve-Path $p).Path }
}
$secretsFile = Read-FilePath 'node secrets JSON file path ({ "node-id": "credential" })' $true
node scripts/plan-node-configuration.mjs validate --tier1 $tierFiles[1] $(foreach($n in 2,3){ if($tierFiles[$n]){ "--tier$n"; $tierFiles[$n] } }) --secrets $secretsFile
if ($LASTEXITCODE -ne 0) { throw 'node configuration is invalid.' }

Write-Host '==> Gateway Access Groups'
Write-Host 'Configure at least one of AIR / PRO / MAX / ULTRA / AGENT. Empty Key skips that Group.'
$accessKeys = [ordered]@{}
$accessModels = [ordered]@{}
$verificationKey = $null
foreach ($group in @('AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT')) {
  $key = Read-SecretText "GATEWAY_ACCESS_KEY_$group (empty to skip)"
  if ([string]::IsNullOrEmpty($key)) { continue }
  $models = (Read-Host "GATEWAY_ACCESS_MODELS_$group (CSV, required)").Trim()
  if ([string]::IsNullOrWhiteSpace($models)) {
    throw "GATEWAY_ACCESS_MODELS_$group is required when GATEWAY_ACCESS_KEY_$group is set."
  }
  $accessKeys[$group] = $key
  $accessModels[$group] = $models
  if (-not $verificationKey) { $verificationKey = $key }
}
if ($accessKeys.Count -eq 0) {
  throw 'At least one Gateway Access Group Key must be configured (AIR, PRO, MAX, ULTRA, or AGENT).'
}

Write-Host '==> Sharding config into variables + secrets'
$planFile = Join-Path ([IO.Path]::GetTempPath()) ("gateway-plan-" + [guid]::NewGuid().ToString('N') + '.json')
$tmpFiles = @($planFile)
try {
  $planArgs = @('plan', '--secrets', $secretsFile, '--out', $planFile)
  foreach ($n in 1, 2, 3) { if ($tierFiles[$n]) { $planArgs += @("--tier$n", $tierFiles[$n]) } }
  node scripts/plan-node-configuration.mjs @planArgs
  if ($LASTEXITCODE -ne 0) { throw 'sharding failed.' }

  $plan = Get-Content $planFile -Raw -Encoding UTF8 | ConvertFrom-Json

  # Build operator-local config; the tracked wrangler.jsonc remains immutable.
  $userConfigPath = Join-Path $Root 'wrangler.user.jsonc'
  $userConfig = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $userConfig.name = $workerName
  $varsMap = [ordered]@{}
  foreach ($prop in $plan.vars.PSObject.Properties) { $varsMap[$prop.Name] = $prop.Value }
  foreach ($group in $accessModels.Keys) { $varsMap["GATEWAY_ACCESS_MODELS_$group"] = $accessModels[$group] }
  $userConfig | Add-Member -NotePropertyName vars -NotePropertyValue $varsMap -Force
  $userConfig | Add-Member -NotePropertyName kv_namespaces -NotePropertyValue @(
    [ordered]@{ binding = 'TIER1_AFFINITY'; id = $affinityKvId }
  ) -Force
  [IO.File]::WriteAllText($userConfigPath, ($userConfig | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))

  $bulkPath = Join-Path ([IO.Path]::GetTempPath()) ("gateway-secrets-" + [guid]::NewGuid().ToString('N') + '.json')
  $tmpFiles += $bulkPath
  $bulk = [ordered]@{}
  foreach ($group in $accessKeys.Keys) { $bulk["GATEWAY_ACCESS_KEY_$group"] = $accessKeys[$group] }
  foreach ($prop in $plan.secrets.PSObject.Properties) { $bulk[$prop.Name] = $prop.Value }
  [IO.File]::WriteAllText($bulkPath, ($bulk | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))

  Write-Host "==> Deploying worker '$workerName' with secrets file"
  Invoke-Wrangler @('deploy', '-c', 'wrangler.user.jsonc', '--keep-vars', '--secrets-file', $bulkPath)
}
finally {
  foreach ($f in $tmpFiles) { if ($f -and (Test-Path $f)) { Remove-Item $f -Force } }
}

$url = (Read-Host 'Gateway URL after deploy (empty to skip verification)').Trim()
if ($url) {
  if (-not $url.StartsWith('https://')) { throw 'gateway URL must be https://' }
  curl.exe "$($url.TrimEnd('/'))/version" --fail --silent --show-error | Out-Null; if ($LASTEXITCODE -ne 0) { throw '/version failed.' }
  curl.exe "$($url.TrimEnd('/'))/health" --fail --silent --show-error -H "Authorization: Bearer $verificationKey" | Out-Null; if ($LASTEXITCODE -ne 0) { throw '/health failed.' }
  curl.exe "$($url.TrimEnd('/'))/v1/models" --fail --silent --show-error -H "Authorization: Bearer $verificationKey" | Out-Null; if ($LASTEXITCODE -ne 0) { throw '/v1/models failed.' }
  Write-Host 'Deploy and online verification passed.'
} else {
  Write-Host 'Deploy finished; online verification skipped.'
}
