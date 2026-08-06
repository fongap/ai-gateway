[CmdletBinding()]param()
$ErrorActionPreference='Stop';$Root=Split-Path -Parent $PSScriptRoot;Set-Location $Root
npx --yes 'wrangler@4.114.0' whoami;if($LASTEXITCODE-ne0){throw '请先登录 Cloudflare。'}
$workerName=(Get-Content 'wrangler.jsonc' -Raw -Encoding UTF8|ConvertFrom-Json).name
Write-Host "目标 Worker：$workerName"
if((Read-Host '确认关闭上述 Worker 的全部 Fallback 并删除旧 Fallback Secret？[y/N]')-notmatch'^(y|yes)$'){throw '已取消。'}
$out=[ordered]@{FALLBACK_ENABLED='false';FALLBACK_SECONDARY_MODEL='off';FALLBACK_API_TOKEN=$null;FALLBACK_BASE_URL=$null;FALLBACK_PRIMARY_MODEL=$null;FALLBACK_PRIMARY_TOKEN=$null;FALLBACK_PRIMARY_BASE_URL=$null;FALLBACK_SECONDARY_TOKEN=$null;FALLBACK_SECONDARY_BASE_URL=$null}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('smart-edge-gateway-disable-fallback-'+[guid]::NewGuid().ToString('N')+'.json')
try{[IO.File]::WriteAllText($temp,($out|ConvertTo-Json),[Text.UTF8Encoding]::new($false));npx --yes 'wrangler@4.114.0' secret bulk $temp;if($LASTEXITCODE-ne0){throw '关闭 Fallback 失败。'}}finally{if(Test-Path$temp){Remove-Item$temp-Force};$out.Clear()}
Write-Host 'Fallback 已关闭，旧 Fallback Secret 已删除；未重新部署本地代码。'
