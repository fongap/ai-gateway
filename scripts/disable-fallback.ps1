[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$tempFile=Join-Path ([IO.Path]::GetTempPath()) ('smart-edge-gateway-disable-fallback-'+[guid]::NewGuid().ToString('N')+'.json')
try {
  [IO.File]::WriteAllText($tempFile,'{"FALLBACK_ENABLED":"false","FALLBACK_SECONDARY_MODEL":"off"}',[Text.UTF8Encoding]::new($false))
  npx --yes wrangler@4.114.0 deploy --keep-vars --secrets-file $tempFile
  if($LASTEXITCODE -ne 0){throw '关闭 Fallback 失败。'}
} finally { if(Test-Path $tempFile){Remove-Item $tempFile -Force} }
Write-Host 'Fallback 已显式关闭；旧值即使仍保留，也不会被路由使用。'
