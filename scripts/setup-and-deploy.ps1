[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$Wrangler = @('npx','--yes','wrangler@4.114.0')

function Invoke-Wrangler([string[]]$Args) {
  & $Wrangler[0] $Wrangler[1] $Wrangler[2] @Args
  if ($LASTEXITCODE -ne 0) { throw "Wrangler 执行失败：$($Args -join ' ')" }
}
function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Test-Https([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $uri = $null
  return [Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -and $uri.Scheme -eq 'https'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '未找到 Node.js 20+。' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw '未找到 npm。' }
if ([int]((node --version).TrimStart('v').Split('.')[0]) -lt 20) { throw '需要 Node.js 20 或更高版本。' }

$workerName = Read-Host 'Worker 名称 [smart-edge-gateway]'
if ([string]::IsNullOrWhiteSpace($workerName)) { $workerName='smart-edge-gateway' }
if ($workerName -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
  throw 'Worker 名称必须为 1-63 位小写字母、数字或连字符，且不能以连字符开头或结尾。'
}
$configPath = Join-Path $ProjectRoot 'wrangler.jsonc'
$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$config.name = $workerName
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 20) + "`n", [Text.UTF8Encoding]::new($false))

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
npm run verify
if ($LASTEXITCODE -ne 0) { throw '项目验证失败。' }
npm run check:deploy
if ($LASTEXITCODE -ne 0) { throw 'Worker dry-run 打包失败。' }
& $Wrangler[0] $Wrangler[1] $Wrangler[2] whoami | Out-Null
if ($LASTEXITCODE -ne 0) { Invoke-Wrangler @('login') }

$secrets=[ordered]@{}
$secrets.GATEWAY_ACCESS_KEY=Read-PlainSecret 'GATEWAY_ACCESS_KEY'
$secrets.PRIMARY_API_TOKENS=Read-PlainSecret 'PRIMARY_API_TOKENS（Token@https://BaseURL，多个用逗号分隔）'
$primaryBase=(Read-Host 'PRIMARY_BASE_URL（Token 已绑定 URL 时留空）').Trim()
if ($primaryBase) { $secrets.PRIMARY_BASE_URL=$primaryBase }
if ([string]::IsNullOrWhiteSpace($secrets.GATEWAY_ACCESS_KEY)) { throw 'GATEWAY_ACCESS_KEY 不能为空。' }
$env:PRIMARY_API_TOKENS=$secrets.PRIMARY_API_TOKENS
$env:PRIMARY_BASE_URL=$primaryBase
try {
  node scripts/validate-primary-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Primary 配置检查失败。' }
} finally {
  Remove-Item Env:PRIMARY_API_TOKENS -ErrorAction SilentlyContinue
  Remove-Item Env:PRIMARY_BASE_URL -ErrorAction SilentlyContinue
}

$mappingPath=(Read-Host 'MODEL_MAPPING JSON 文件路径（不需要则留空）').Trim()
if ($mappingPath) {
  $resolved=Resolve-Path $mappingPath
  $mapping=Get-Content $resolved -Raw -Encoding UTF8
  $null=$mapping | ConvertFrom-Json
  $secrets.MODEL_MAPPING=$mapping.Trim()
}
$strict=(Read-Host '启用严格模型白名单？[y/N]').Trim()
$secrets.STRICT_MODEL_MAPPING=$(if($strict -match '^(y|yes)$'){'true'}else{'false'})

$enableFallback=(Read-Host '配置 Fallback？[y/N]').Trim()
$secrets.FALLBACK_ENABLED='false'
$secrets.FALLBACK_SECONDARY_MODEL='off'
$secrets.FALLBACK_CLIENT_NOTICE_MODE='headers'
if ($enableFallback -match '^(y|yes)$') {
  $secrets.FALLBACK_ENABLED='true'
  $secrets.FALLBACK_API_TOKEN=Read-PlainSecret 'FALLBACK_API_TOKEN'
  $fallbackBase=(Read-Host 'FALLBACK_BASE_URL').Trim()
  if (-not (Test-Https $fallbackBase)) { throw 'FALLBACK_BASE_URL 必须使用 HTTPS。' }
  $secrets.FALLBACK_BASE_URL=$fallbackBase
  $secrets.FALLBACK_PRIMARY_MODEL=(Read-Host 'FALLBACK_PRIMARY_MODEL').Trim()
  $secondary=(Read-Host 'FALLBACK_SECONDARY_MODEL（留空或 off 关闭）').Trim()
  $secrets.FALLBACK_SECONDARY_MODEL=$(if($secondary){$secondary}else{'off'})
  if ([string]::IsNullOrWhiteSpace($secrets.FALLBACK_API_TOKEN) -or [string]::IsNullOrWhiteSpace($secrets.FALLBACK_PRIMARY_MODEL)) {
    throw 'Fallback Token 和第一兜底模型不能为空。'
  }
}
$secrets.FAKE_STREAM_PROTECTION='false'
$secrets.ALLOW_UNSAFE_PROXY_ROUTES='false'
$secrets.ALLOW_INSECURE_HTTP_UPSTREAM='false'
$secrets.EXPOSE_UPSTREAM_INFO='false'

$tempFile=Join-Path ([IO.Path]::GetTempPath()) ('smart-edge-gateway-secrets-'+[guid]::NewGuid().ToString('N')+'.json')
try {
  [IO.File]::WriteAllText($tempFile,($secrets | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
  Invoke-Wrangler @('deploy','--keep-vars','--secrets-file',$tempFile)
} finally {
  if(Test-Path $tempFile){Remove-Item $tempFile -Force}
  $secrets.Clear()
}
Write-Host '部署完成。请用 health-check.ps1 和 models-check.ps1 验证实际域名。'
