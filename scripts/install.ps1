[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-Wrangler([string[]]$Arguments) {
  & npx --yes 'wrangler@4.114.0' @Arguments
  if ($LASTEXITCODE -ne 0) { throw "wrangler failed: $($Arguments -join ' ')" }
}
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
  return $p
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required.' }
if ([int]((node --version).TrimStart('v').Split('.')[0]) -lt 20) { throw 'Node.js 20 or newer is required.' }

$defaultWorkerName = ((Get-Content (Join-Path $Root 'wrangler.jsonc') -Raw -Encoding UTF8 | ConvertFrom-Json).name)
$workerName = (Read-Host "Worker name [$defaultWorkerName]").Trim()
if (!$workerName) { $workerName = $defaultWorkerName }
if ($workerName -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') { throw 'Worker name must be 1-63 chars: lowercase letters, digits, hyphens.' }
$configPath = Join-Path $Root 'wrangler.jsonc'
$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$config.name = $workerName
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))

Write-Host '==> Installing dependencies and verifying project'
npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
npm run verify; if ($LASTEXITCODE -ne 0) { throw 'project verification failed.' }

Invoke-Wrangler @('whoami')
if ($LASTEXITCODE -ne 0) { Invoke-Wrangler @('login') }

Write-Host '==> Node configuration'
Write-Host 'Node configs are PLAIN variables without credentials; credentials go into a separate NODE_SECRETS file.'
$tierFiles = @{}
foreach ($n in 1, 2, 3) {
  $required = ($n -eq 1)
  $p = Read-FilePath "tier-$n node config JSON file path$(if(-not $required){' (optional, empty to skip)'})" $required
  if ($p) { $tierFiles[$n] = (Resolve-Path $p).Path }
}
$secretsFile = Read-FilePath 'node secrets JSON file path ({ "node-id": "credential" })' $true
node scripts/manage-nodes-config.mjs validate --tier1 $tierFiles[1] $(foreach($n in 2,3){ if($tierFiles[$n]){ "--tier$n"; $tierFiles[$n] } }) --secrets $secretsFile
if ($LASTEXITCODE -ne 0) { throw 'node configuration is invalid.' }

Write-Host '==> Sharding config into variables + secrets'
$planFile = Join-Path ([IO.Path]::GetTempPath()) ("gateway-plan-" + [guid]::NewGuid().ToString('N') + '.json')
$planArgs = @('plan', '--secrets', $secretsFile, '--out', $planFile)
foreach ($n in 1, 2, 3) { if ($tierFiles[$n]) { $planArgs += @("--tier$n", $tierFiles[$n]) } }
node scripts/manage-nodes-config.mjs @planArgs
if ($LASTEXITCODE -ne 0) { throw 'sharding failed.' }

try {
  $plan = Get-Content $planFile -Raw -Encoding UTF8 | ConvertFrom-Json

  # Build wrangler.user.jsonc with the plain vars for deploy.
  $userConfigPath = Join-Path $Root 'wrangler.user.jsonc'
  $userConfig = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $varsMap = [ordered]@{}
  foreach ($prop in $plan.vars.PSObject.Properties) { $varsMap[$prop.Name] = $prop.Value }
  $userConfig | Add-Member -NotePropertyName vars -NotePropertyValue $varsMap -Force
  [IO.File]::WriteAllText($userConfigPath, ($userConfig | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))

  # Secrets bulk file: GATEWAY_ACCESS_KEY + NODE_SECRETS_xx
  $bulkPath = Join-Path ([IO.Path]::GetTempPath()) ("gateway-secrets-" + [guid]::NewGuid().ToString('N') + '.json')
  $bulk = [ordered]@{}
  $bulk['GATEWAY_ACCESS_KEY'] = Read-SecretText 'GATEWAY_ACCESS_KEY'
  foreach ($prop in $plan.secrets.PSObject.Properties) { $bulk[$prop.Name] = $prop.Value }
  [IO.File]::WriteAllText($bulkPath, ($bulk | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))

  Write-Host "==> Deploying worker '$workerName'"
  Invoke-Wrangler @('deploy', '-c', 'wrangler.user.jsonc', '--keep-vars')
  Write-Host '==> Writing secrets'
  Invoke-Wrangler @('secret', 'bulk', $bulkPath)
}
finally {
  if (Test-Path $planFile) { Remove-Item $planFile -Force }
  if (Test-Path $bulkPath) { Remove-Item $bulkPath -Force }
}

$url = (Read-Host 'Gateway URL after deploy (empty to skip verification)').Trim()
if ($url) {
  if (-not $url.StartsWith('https://')) { throw 'gateway URL must be https://' }
  $access = Read-SecretText 'Enter GATEWAY_ACCESS_KEY again for online verification'
  curl.exe "$($url.TrimEnd('/'))/version" --fail --silent --show-error | Out-Null; if ($LASTEXITCODE -ne 0) { throw '/version failed.' }
  curl.exe "$($url.TrimEnd('/'))/health" --fail --silent --show-error -H "Authorization: Bearer $access" | Out-Null; if ($LASTEXITCODE -ne 0) { throw '/health failed.' }
  curl.exe "$($url.TrimEnd('/'))/v1/models" --fail --silent --show-error -H "Authorization: Bearer $access" | Out-Null; if ($LASTEXITCODE -ne 0) { throw '/v1/models failed.' }
  Write-Host 'Deploy and online verification passed.'
} else {
  Write-Host 'Deploy finished; online verification skipped.'
}
