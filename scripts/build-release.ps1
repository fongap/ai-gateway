[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

npm run verify:release
if ($LASTEXITCODE -ne 0) { throw "项目验证失败。" }

npm run checksums
if ($LASTEXITCODE -ne 0) { throw "校验值生成失败。" }

$baseName = (node scripts/release-metadata.mjs artifact).Trim()
if ($LASTEXITCODE -ne 0 -or -not $baseName) { throw "无法读取发布元数据。" }

node scripts/prepare-release.mjs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "发布目录准备失败。" }

$releaseDir = Join-Path $ProjectRoot "release"
$stageRoot = Join-Path $releaseDir ".staging"
$stageDir = Join-Path $stageRoot $baseName
$zipFile = Join-Path $releaseDir "$baseName.zip"
$tarFile = Join-Path $releaseDir "$baseName.tar.gz"

Compress-Archive -Path $stageDir -DestinationPath $zipFile -CompressionLevel Optimal -Force

$tarCommand = Get-Command tar -ErrorAction SilentlyContinue
if ($tarCommand) {
  Push-Location $stageRoot
  try {
    tar -czf $tarFile $baseName
    if ($LASTEXITCODE -ne 0) { throw "TAR.GZ 生成失败。" }
  } finally {
    Pop-Location
  }
}

Remove-Item $stageRoot -Recurse -Force

$checksumLines = @()
foreach ($file in @($zipFile, $tarFile)) {
  if (Test-Path $file) {
    $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumLines += "$hash  $([IO.Path]::GetFileName($file))"
  }
}
[IO.File]::WriteAllLines((Join-Path $releaseDir "SHA256SUMS"), $checksumLines, [Text.UTF8Encoding]::new($false))

Write-Host "已生成："
Write-Host "  $zipFile"
if (Test-Path $tarFile) { Write-Host "  $tarFile" }
Write-Host "  $(Join-Path $releaseDir 'SHA256SUMS')"
