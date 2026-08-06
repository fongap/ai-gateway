[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
npm run verify
if ($LASTEXITCODE -ne 0) { throw "项目验证失败。" }
$releaseDir = Join-Path $ProjectRoot "release"
New-Item -ItemType Directory -Force $releaseDir | Out-Null
$outFile = Join-Path $releaseDir "smart-edge-gateway-v5.11.0.zip"
if (Test-Path $outFile) { Remove-Item $outFile -Force }
$items = Get-ChildItem -Force | Where-Object {
  $_.Name -notin @('node_modules', '.wrangler', '.git', 'release', '.dev.vars') -and
  $_.Name -notmatch '^secrets.*\.json$'
}
Compress-Archive -Path $items.FullName -DestinationPath $outFile -CompressionLevel Optimal
Write-Host "已生成 $outFile"
