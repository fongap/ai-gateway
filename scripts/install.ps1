[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
Set-Location $Root
function Invoke-Wrangler([string[]]$Arguments){ & npx --yes 'wrangler@4.114.0' @Arguments; if($LASTEXITCODE -ne 0){throw "Wrangler 执行失败：$($Arguments -join ' ')"} }
function Read-SecretText([string]$Prompt){$s=Read-Host $Prompt -AsSecureString;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}}
function Confirm-Yes([string]$Value){return $Value -match '^(y|yes)$'}
if(-not(Get-Command node -ErrorAction SilentlyContinue)){throw '未找到 Node.js 20+。'}
if(-not(Get-Command npm -ErrorAction SilentlyContinue)){throw '未找到 npm。'}
if([int]((node --version).TrimStart('v').Split('.')[0]) -lt 20){throw '需要 Node.js 20 或更高版本。'}
$defaultWorkerName=((Get-Content (Join-Path $Root 'wrangler.jsonc') -Raw -Encoding UTF8 | ConvertFrom-Json).name)
$workerName=(Read-Host "Worker 名称 [$defaultWorkerName]").Trim();if(!$workerName){$workerName=$defaultWorkerName}
if($workerName -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'){throw 'Worker 名称必须为 1-63 位小写字母、数字或连字符。'}
$configPath=Join-Path $Root 'wrangler.jsonc';$config=Get-Content $configPath -Raw -Encoding UTF8|ConvertFrom-Json;$config.name=$workerName
[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 30)+"`n",[Text.UTF8Encoding]::new($false))
npm ci;if($LASTEXITCODE -ne 0){throw 'npm ci 失败。'}
npm run verify;if($LASTEXITCODE -ne 0){throw '项目验证失败。'}
npm run check:deploy;if($LASTEXITCODE -ne 0){throw 'Worker dry-run 失败。'}
& npx --yes 'wrangler@4.114.0' whoami *> $null;if($LASTEXITCODE -ne 0){Invoke-Wrangler @('login')};Invoke-Wrangler @('whoami')
$secrets=[ordered]@{}
$secrets.GATEWAY_ACCESS_KEY=Read-SecretText 'GATEWAY_ACCESS_KEY'
$secrets.PRIMARY_API_TOKENS=Read-SecretText 'PRIMARY_API_TOKENS（Token@https://BaseURL，多个用逗号分隔）'
$secrets.PRIMARY_BASE_URL=(Read-Host 'PRIMARY_BASE_URL（Token 已绑定 URL 时留空）').Trim()
if(!$secrets.GATEWAY_ACCESS_KEY -or !$secrets.PRIMARY_API_TOKENS){throw '两个必需 Secret 均不能为空。'}
$env:PRIMARY_API_TOKENS=$secrets.PRIMARY_API_TOKENS;$env:PRIMARY_BASE_URL=$secrets.PRIMARY_BASE_URL
try{node scripts/validate-primary-config.mjs;if($LASTEXITCODE -ne 0){throw 'Primary 配置无效。'}}finally{Remove-Item Env:PRIMARY_API_TOKENS,Env:PRIMARY_BASE_URL -ErrorAction SilentlyContinue}
$mappingPath=(Read-Host 'MODEL_MAPPING JSON 文件路径（不需要则留空）').Trim()
$secrets.MODEL_MAPPING=''
if($mappingPath){node scripts/validate-model-mapping.mjs $mappingPath;if($LASTEXITCODE -ne 0){throw 'MODEL_MAPPING 无效。'};$secrets.MODEL_MAPPING=(Get-Content $mappingPath -Raw -Encoding UTF8).Trim()}
$secrets.STRICT_MODEL_MAPPING=$(if(Confirm-Yes (Read-Host '启用严格模型白名单？[y/N]')){'true'}else{'false'})
$secrets.FALLBACK_ENABLED='false';$secrets.FALLBACK_SECONDARY_MODEL='off';$secrets.FALLBACK_CLIENT_NOTICE_MODE='headers'
if(Confirm-Yes (Read-Host '配置 Fallback？[y/N]')){
 $secrets.FALLBACK_ENABLED='true';$secrets.FALLBACK_API_TOKEN=Read-SecretText 'FALLBACK_API_TOKEN'
 $secrets.FALLBACK_BASE_URL=(Read-Host 'FALLBACK_BASE_URL').Trim();$secrets.FALLBACK_PRIMARY_MODEL=(Read-Host 'FALLBACK_PRIMARY_MODEL').Trim()
 $secondary=(Read-Host 'FALLBACK_SECONDARY_MODEL（留空或 off 关闭）').Trim();$secrets.FALLBACK_SECONDARY_MODEL=$(if($secondary){$secondary}else{'off'})
 $env:FALLBACK_API_TOKEN=$secrets.FALLBACK_API_TOKEN;$env:FALLBACK_BASE_URL=$secrets.FALLBACK_BASE_URL;$env:FALLBACK_PRIMARY_MODEL=$secrets.FALLBACK_PRIMARY_MODEL;$env:FALLBACK_SECONDARY_MODEL=$secrets.FALLBACK_SECONDARY_MODEL
 try{node scripts/validate-fallback-config.mjs;if($LASTEXITCODE-ne0){throw 'Fallback 配置无效。'}}finally{Remove-Item Env:FALLBACK_API_TOKEN,Env:FALLBACK_BASE_URL,Env:FALLBACK_PRIMARY_MODEL,Env:FALLBACK_SECONDARY_MODEL -ErrorAction SilentlyContinue}
}
$tier1File=(Read-Host 'tier-1 节点配置 JSON 文件路径（必需）').Trim()
if(!$tier1File -or !(Test-Path $tier1File)){throw 'tier-1 节点配置文件不存在。'}
node scripts/manage-nodes-config.mjs validate --file $tier1File;if($LASTEXITCODE-ne0){throw 'tier-1 节点配置无效。'}
$tierFiles=@{}
$tierFiles[1]=$tier1File
foreach($n in 2,3){
 $p=(Read-Host "tier-$n 节点配置 JSON 文件路径（可选，留空跳过）").Trim()
 if($p){
  if(!(Test-Path $p)){throw "tier-$n 节点配置文件不存在。"}
  node scripts/manage-nodes-config.mjs validate --file $p;if($LASTEXITCODE-ne0){throw "tier-$n 节点配置无效。"}
  $tierFiles[$n]=$p
 }
}
$secrets.FAKE_STREAM_PROTECTION='false';$secrets.ALLOW_UNSAFE_PROXY_ROUTES='false';$secrets.ALLOW_INSECURE_HTTP_UPSTREAM='false';$secrets.EXPOSE_UPSTREAM_INFO='false'
$temp=Join-Path ([IO.Path]::GetTempPath()) ('gateway-install-'+[guid]::NewGuid().ToString('N')+'.json')
# 按完整 Node 边界自动拆分为 TIERx_NODES_CONFIG_01.. 分片（三个 Tier 共用同一套分片函数）。
$nodesPlan=Join-Path ([IO.Path]::GetTempPath()) ('gateway-install-nodes-'+[guid]::NewGuid().ToString('N')+'.json')
try{
 $planArgs=@('plan','--tier1',$tier1File,'--out',$nodesPlan)
 foreach($n in 2,3){if($tierFiles[$n]){$planArgs+=@("--tier$n",$tierFiles[$n])}}
 node scripts/manage-nodes-config.mjs @planArgs;if($LASTEXITCODE-ne0){throw '节点配置分片失败。'}
 foreach($prop in ((Get-Content $nodesPlan -Raw -Encoding UTF8|ConvertFrom-Json).secrets.PSObject.Properties)){$secrets[$prop.Name]=$prop.Value}
 [IO.File]::WriteAllText($temp,($secrets|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
 Write-Host "将首次部署 Worker：$workerName";if(-not(Confirm-Yes (Read-Host '确认继续？[y/N]'))){throw '已取消。'}
 Invoke-Wrangler @('deploy','--keep-vars','--secrets-file',$temp)
}finally{if(Test-Path $temp){Remove-Item $temp -Force};if(Test-Path $nodesPlan){Remove-Item $nodesPlan -Force};$secrets.Clear()}
$url=(Read-Host '部署后的网关 URL（留空跳过验证）').Trim()
if($url){
 $uri=$null;if(-not[Uri]::TryCreate($url,[UriKind]::Absolute,[ref]$uri)-or$uri.Scheme-ne'https'){throw '网关 URL 必须为完整 HTTPS 地址。'}
 $access=Read-SecretText '再次输入 GATEWAY_ACCESS_KEY 以执行在线验证'
 curl.exe "$($url.TrimEnd('/'))/version" --fail --silent --show-error|Out-Null;if($LASTEXITCODE-ne0){throw '/version 验证失败。'}
 curl.exe "$($url.TrimEnd('/'))/health" --fail --silent --show-error -H "Authorization: Bearer $access"|Out-Null;if($LASTEXITCODE-ne0){throw '/health 验证失败。'}
 curl.exe "$($url.TrimEnd('/'))/v1/models" --fail --silent --show-error -H "Authorization: Bearer $access"|Out-Null;if($LASTEXITCODE-ne0){throw '/v1/models 验证失败。'}
 Write-Host '部署和运行验证均通过。'
}else{Write-Host '部署完成；尚未执行线上验证。'}

