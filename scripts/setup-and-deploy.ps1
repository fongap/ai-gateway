[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Set-WorkerName([string]$Name) {
  if ($Name -notmatch '^[a-z0-9-]+$') {
    throw "Worker 名称只能包含小写字母、数字和连字符。"
  }
  $path = Join-Path $ProjectRoot "wrangler.jsonc"
  $content = Get-Content $path -Raw -Encoding UTF8
  $content = [regex]::Replace($content, '"name"\s*:\s*"[^"]+"', '"name": "' + $Name + '"', 1)
  [IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "未找到 Node.js 20+。" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "未找到 npm。" }

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "需要 Node.js 20 或更高版本。" }

$workerName = Read-Host "Worker 名称 [smart-edge-gateway]"
if ([string]::IsNullOrWhiteSpace($workerName)) { $workerName = "smart-edge-gateway" }
Set-WorkerName $workerName

Write-Host "安装依赖..."
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci 失败。" }
npm run verify
if ($LASTEXITCODE -ne 0) { throw "项目验证失败。" }

npx wrangler whoami | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "需要登录 Cloudflare..."
  npx wrangler login
  if ($LASTEXITCODE -ne 0) { throw "Cloudflare 登录失败。" }
}

$secrets = [ordered]@{}
$secrets.GATEWAY_ACCESS_KEY = Read-PlainSecret "GATEWAY_ACCESS_KEY"
$secrets.PRIMARY_API_TOKENS = Read-PlainSecret "PRIMARY_API_TOKENS（支持 Token@BaseURL，多个用逗号分隔）"

$primaryBaseUrl = Read-Host "PRIMARY_BASE_URL（Token 已绑定 URL 时留空）"
if (-not [string]::IsNullOrWhiteSpace($primaryBaseUrl)) { $secrets.PRIMARY_BASE_URL = $primaryBaseUrl.Trim() }

$mappingPath = Read-Host "MODEL_MAPPING JSON 文件路径（不需要则留空）"
if (-not [string]::IsNullOrWhiteSpace($mappingPath)) {
  $resolved = Resolve-Path $mappingPath
  $mapping = Get-Content $resolved -Raw -Encoding UTF8
  $null = $mapping | ConvertFrom-Json
  $secrets.MODEL_MAPPING = $mapping.Trim()
}

$enableFallback = Read-Host "配置 Fallback？[y/N]"
if ($enableFallback -match '^(y|yes)$') {
  $secrets.FALLBACK_API_TOKEN = Read-PlainSecret "FALLBACK_API_TOKEN"
  $secrets.FALLBACK_BASE_URL = (Read-Host "FALLBACK_BASE_URL").Trim()
  $secrets.FALLBACK_PRIMARY_MODEL = (Read-Host "FALLBACK_PRIMARY_MODEL").Trim()
  $secondary = (Read-Host "FALLBACK_SECONDARY_MODEL（默认关闭；填写模型名启用）").Trim()
  if ($secondary) { $secrets.FALLBACK_SECONDARY_MODEL = $secondary }
  $notice = (Read-Host "FALLBACK_CLIENT_NOTICE_MODE [headers]").Trim()
  $secrets.FALLBACK_CLIENT_NOTICE_MODE = $(if ($notice) { $notice } else { "headers" })
}

if ([string]::IsNullOrWhiteSpace($secrets.GATEWAY_ACCESS_KEY)) { throw "GATEWAY_ACCESS_KEY 不能为空。" }
if ([string]::IsNullOrWhiteSpace($secrets.PRIMARY_API_TOKENS)) { throw "PRIMARY_API_TOKENS 不能为空。" }
if (-not $secrets.PRIMARY_BASE_URL -and $secrets.PRIMARY_API_TOKENS -notmatch '@https?://') {
  throw "PRIMARY_API_TOKENS 未绑定 Base URL，必须填写 PRIMARY_BASE_URL。"
}

$tempFile = Join-Path ([IO.Path]::GetTempPath()) ("smart-edge-gateway-secrets-" + [guid]::NewGuid().ToString('N') + ".json")
try {
  $json = $secrets | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($tempFile, $json, [Text.UTF8Encoding]::new($false))
  Write-Host "部署 Worker 与 Secrets..."
  npx wrangler deploy --secrets-file $tempFile
  if ($LASTEXITCODE -ne 0) { throw "Worker 部署失败。" }
} finally {
  if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
  $secrets.Clear()
}

Write-Host "部署完成。运行 .\scripts\health-check.ps1 验证。"
