[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Read-SecretText([string]$Prompt) {
  $s = Read-Host $Prompt -AsSecureString
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
function Confirm-Yes([string]$Value) { return $Value -match '^(y|yes)$' }
function Read-FilePath([string]$Prompt, [bool]$Required) {
  $p = (Read-Host $Prompt).Trim()
  if ($p -eq '' -and -not $Required) { return $null }
  if ($p -eq '' -or !(Test-Path $p)) { throw "file not found: $p" }
  return (Resolve-Path $p).Path
}

npx --yes 'wrangler@4.114.0' whoami
if ($LASTEXITCODE -ne 0) { throw 'Login to Cloudflare first (npm run cf:login).' }
$workerName = ((Get-Content (Join-Path $Root 'wrangler.jsonc') -Raw -Encoding UTF8 | ConvertFrom-Json).name)
Write-Host "Target worker: $workerName"

$userConfigPath = Join-Path $Root 'wrangler.user.jsonc'

Write-Host '==> Node configuration update'
$tierFiles = @{}
foreach ($n in 1, 2, 3) {
  $required = ($n -eq 1)
  $p = Read-FilePath "tier-$n node config JSON file$(if(-not $required){' (optional, empty to skip)'})" $required
  if ($p) { $tierFiles[$n] = $p }
}
$secretsFile = Read-FilePath 'node secrets JSON file ({ "node-id": "credential" })' $true

# Existing managed names: vars from local wrangler.user.jsonc (if present),
# secrets from `wrangler secret list`.
$existingVarNames = @()
if (Test-Path $userConfigPath) {
  $prevVars = ((Get-Content $userConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).vars)
  if ($prevVars) { $existingVarNames = @($prevVars.PSObject.Properties.Name) }
}

$tmpFiles = @()
try {
  $existingVarsFile = Join-Path ([IO.Path]::GetTempPath()) ("gateway-vars-" + [guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($existingVarsFile, ($existingVarNames | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  $tmpFiles += $existingVarsFile

  $planFile = Join-Path ([IO.Path]::GetTempPath()) ("gateway-plan-" + [guid]::NewGuid().ToString('N') + '.json')
  $tmpFiles += $planFile

  $planArgs = @('plan', '--secrets', $secretsFile, '--existing-vars', $existingVarsFile, '--out', $planFile)
  foreach ($n in 1, 2, 3) { if ($tierFiles[$n]) { $planArgs += @("--tier$n", $tierFiles[$n]) } }
  node scripts/plan-node-configuration.mjs @planArgs
  if ($LASTEXITCODE -ne 0) { throw 'configuration planning failed.' }

  $plan = Get-Content $planFile -Raw -Encoding UTF8 | ConvertFrom-Json

  $userConfig = if (Test-Path $userConfigPath) {
    Get-Content $userConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    Get-Content (Join-Path $Root 'wrangler.jsonc') -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  $existingAffinity = @($userConfig.kv_namespaces | Where-Object { $_.binding -eq 'TIER1_AFFINITY' }) | Select-Object -First 1
  if (-not $existingAffinity) {
    $affinityKvId = (Read-Host 'Tier 1 affinity KV namespace ID (required)').Trim()
    if ($affinityKvId -notmatch '^[a-fA-F0-9]{32}$') { throw 'Tier 1 affinity KV namespace ID must be 32 hexadecimal characters.' }
    $userConfig | Add-Member -NotePropertyName kv_namespaces -NotePropertyValue @(
      [ordered]@{ binding = 'TIER1_AFFINITY'; id = $affinityKvId }
    ) -Force
  }
  $varsMap = [ordered]@{}
  foreach ($prop in $plan.vars.PSObject.Properties) { $varsMap[$prop.Name] = $prop.Value }
  $userConfig | Add-Member -NotePropertyName vars -NotePropertyValue $varsMap -Force
  [IO.File]::WriteAllText($userConfigPath, ($userConfig | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))

  $bulkPath = Join-Path ([IO.Path]::GetTempPath()) ("gateway-secrets-" + [guid]::NewGuid().ToString('N') + '.json')
  $tmpFiles += $bulkPath
  $bulk = [ordered]@{}
  if (Confirm-Yes (Read-Host 'Rotate GATEWAY_ACCESS_KEY? [y/N]')) {
    $bulk['GATEWAY_ACCESS_KEY'] = Read-SecretText 'new GATEWAY_ACCESS_KEY'
  }
  foreach ($prop in $plan.secrets.PSObject.Properties) { $bulk[$prop.Name] = $prop.Value }
  [IO.File]::WriteAllText($bulkPath, ($bulk | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))

  Write-Host "==> Deploying updated variables and code for '$workerName'"
  & npx --yes 'wrangler@4.114.0' deploy -c 'wrangler.user.jsonc' --keep-vars
  if ($LASTEXITCODE -ne 0) { throw 'deploy failed.' }

  Write-Host '==> Writing secrets'
  & npx --yes 'wrangler@4.114.0' secret bulk $bulkPath
  if ($LASTEXITCODE -ne 0) { throw 'secret bulk failed.' }

  foreach ($key in $plan.deleteSecrets) {
    'y' | & npx --yes 'wrangler@4.114.0' secret delete $key | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to delete stale secret $key" }
    Write-Host "deleted stale secret: $key"
  }
  foreach ($key in $plan.deleteVars) {
    Write-Host "note: variable '$key' is no longer planned; remove it in the Cloudflare dashboard if still present."
  }
}
finally {
  foreach ($f in $tmpFiles) { if ($f -and (Test-Path $f)) { Remove-Item $f -Force } }
}
Write-Host 'Configuration updated.'
