[CmdletBinding()]
param([string]$GatewayUrl,[string]$AccessKey)
$ErrorActionPreference='Stop'
if(-not $GatewayUrl){$GatewayUrl=Read-Host '网关地址，例如 https://name.account.workers.dev'}
$uri=$null
if(-not [Uri]::TryCreate($GatewayUrl,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or -not $uri.Host){throw '网关地址必须是完整 HTTPS URL。'}
if(-not $AccessKey){
  $secure=Read-Host 'GATEWAY_ACCESS_KEY' -AsSecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try{$AccessKey=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
}
$target=$GatewayUrl.TrimEnd('/')+'/metrics'
(Invoke-WebRequest -Uri $target -Headers @{Authorization="Bearer $AccessKey"}).Content
