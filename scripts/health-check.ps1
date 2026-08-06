[CmdletBinding()]
param(
  [string]$GatewayUrl,
  [string]$AccessKey
)
$ErrorActionPreference = "Stop"
if (-not $GatewayUrl) { $GatewayUrl = Read-Host "网关地址，例如 https://name.workers.dev" }
if (-not $AccessKey) {
  $secure = Read-Host "GATEWAY_ACCESS_KEY" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $AccessKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
$uri = $GatewayUrl.TrimEnd('/') + '/health'
Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $AccessKey" } | ConvertTo-Json -Depth 20
