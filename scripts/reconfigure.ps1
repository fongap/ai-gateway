[CmdletBinding()]param()
$ErrorActionPreference='Stop';$Root=Split-Path -Parent $PSScriptRoot;Set-Location $Root
function Read-SecretText([string]$Prompt){$s=Read-Host $Prompt -AsSecureString;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}}
function Yes([string]$v){$v-match'^(y|yes)$'}
npx --yes 'wrangler@4.114.0' whoami;if($LASTEXITCODE-ne0){throw '请先登录 Cloudflare。'}
$workerName=(Get-Content 'wrangler.jsonc' -Raw -Encoding UTF8|ConvertFrom-Json).name
Write-Host "目标 Worker：$workerName"
$out=[ordered]@{GATEWAY_ACCESS_KEY=Read-SecretText '新的 GATEWAY_ACCESS_KEY';PRIMARY_API_TOKENS=Read-SecretText '新的 PRIMARY_API_TOKENS'}
$out.PRIMARY_BASE_URL=(Read-Host 'PRIMARY_BASE_URL（留空清除）').Trim();if(!$out.PRIMARY_BASE_URL){$out.PRIMARY_BASE_URL=$null}
if(!$out.GATEWAY_ACCESS_KEY-or!$out.PRIMARY_API_TOKENS){throw '必需 Secret 不能为空。'}
$env:PRIMARY_API_TOKENS=$out.PRIMARY_API_TOKENS;$env:PRIMARY_BASE_URL=$out.PRIMARY_BASE_URL
try{node scripts/validate-primary-config.mjs;if($LASTEXITCODE-ne0){throw 'Primary 配置无效。'}}finally{Remove-Item Env:PRIMARY_API_TOKENS,Env:PRIMARY_BASE_URL -ErrorAction SilentlyContinue}
$mapping=(Read-Host 'MODEL_MAPPING JSON 文件路径（留空清除）').Trim();$out.MODEL_MAPPING=$null
if($mapping){node scripts/validate-model-mapping.mjs $mapping;if($LASTEXITCODE-ne0){throw 'MODEL_MAPPING 无效。'};$out.MODEL_MAPPING=(Get-Content $mapping -Raw -Encoding UTF8).Trim()}
$out.STRICT_MODEL_MAPPING=$(if(Yes(Read-Host '启用严格模型白名单？[y/N]')){'true'}else{'false'})
$enable=Yes(Read-Host '启用 Fallback？[y/N]');$out.FALLBACK_ENABLED=$(if($enable){'true'}else{'false'});$out.FALLBACK_SECONDARY_MODEL='off'
foreach($k in @('FALLBACK_API_TOKEN','FALLBACK_BASE_URL','FALLBACK_PRIMARY_MODEL','FALLBACK_PRIMARY_TOKEN','FALLBACK_PRIMARY_BASE_URL','FALLBACK_SECONDARY_TOKEN','FALLBACK_SECONDARY_BASE_URL')){$out[$k]=$null}
if($enable){
 $out.FALLBACK_API_TOKEN=Read-SecretText 'FALLBACK_API_TOKEN';$out.FALLBACK_BASE_URL=(Read-Host 'FALLBACK_BASE_URL').Trim();$out.FALLBACK_PRIMARY_MODEL=(Read-Host 'FALLBACK_PRIMARY_MODEL').Trim();$s=(Read-Host 'FALLBACK_SECONDARY_MODEL（留空或 off）').Trim();if($s){$out.FALLBACK_SECONDARY_MODEL=$s}
 $env:FALLBACK_API_TOKEN=$out.FALLBACK_API_TOKEN;$env:FALLBACK_BASE_URL=$out.FALLBACK_BASE_URL;$env:FALLBACK_PRIMARY_MODEL=$out.FALLBACK_PRIMARY_MODEL;$env:FALLBACK_SECONDARY_MODEL=$out.FALLBACK_SECONDARY_MODEL
 try{node scripts/validate-fallback-config.mjs;if($LASTEXITCODE-ne0){throw 'Fallback 配置无效。'}}finally{Remove-Item Env:FALLBACK_API_TOKEN,Env:FALLBACK_BASE_URL,Env:FALLBACK_PRIMARY_MODEL,Env:FALLBACK_SECONDARY_MODEL -ErrorAction SilentlyContinue}
}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('gateway-reconfigure-'+[guid]::NewGuid().ToString('N')+'.json')
try{[IO.File]::WriteAllText($temp,($out|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false));if(-not(Yes(Read-Host '确认覆盖上述 Worker 的运行时配置？[y/N]'))){throw '已取消。'};npx --yes 'wrangler@4.114.0' secret bulk $temp;if($LASTEXITCODE-ne0){throw '配置更新失败。'}}finally{if(Test-Path$temp){Remove-Item$temp-Force};$out.Clear()}
Write-Host '配置已更新。'

