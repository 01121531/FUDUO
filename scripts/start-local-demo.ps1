$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root ".runtime"
$node = (Get-Command node -ErrorAction Stop).Source
$apiUrl = "http://127.0.0.1:3001/api/health/live"
$webUrl = "http://127.0.0.1:3100/dashboard"
$gatewayUrl = "http://127.0.0.1:18789/readyz"
$adminUrl = "http://127.0.0.1:18790/health/ready"
$openclawState = Join-Path $runtime "openclaw-local"

function Get-LocalToken([string]$Salt) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$root|$Salt")
    return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
  }
}

function Test-Endpoint([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Wait-Endpoint([string]$Url, [string]$Name) {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if (Test-Endpoint $Url) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become healthy within 60 seconds."
}

if (-not (Test-Path (Join-Path $root "apps/api/dist/main.js"))) {
  throw "API build is missing. Run pnpm build first."
}
if (-not (Test-Path (Join-Path $root "apps/web/.next/BUILD_ID"))) {
  throw "Web build is missing. Run pnpm build first."
}
if (-not (Test-Path (Join-Path $root "apps/openclaw-admin/dist/main.js"))) {
  throw "OpenClaw admin build is missing. Run pnpm build first."
}
if (-not (Test-Path (Join-Path $root "plugins/openclaw-fuduo/dist/index.js"))) {
  throw "OpenClaw Fuduo plugin build is missing. Run pnpm build first."
}

New-Item -ItemType Directory -Force $runtime | Out-Null
$internalToken = Get-LocalToken "internal-service"
$gatewayToken = Get-LocalToken "openclaw-gateway"
$env:INTERNAL_SERVICE_TOKEN = $internalToken
$env:FUDUO_INTERNAL_SERVICE_TOKEN = $internalToken
$env:OPENCLAW_GATEWAY_TOKEN = $gatewayToken
$env:OPENCLAW_STATE_DIR = $openclawState
$env:OPENCLAW_CONFIG_PATH = Join-Path $openclawState "openclaw.json"

& (Join-Path $PSScriptRoot "configure-local-openclaw.ps1") `
  -StateDir $openclawState `
  -FuduoPluginPath (Join-Path $root "plugins/openclaw-fuduo")

$weixinExtension = Join-Path $openclawState "extensions/openclaw-weixin/openclaw.plugin.json"
if (-not (Test-Path $weixinExtension)) {
  $weixinPackage = Join-Path $runtime "tencent-weixin-openclaw-weixin-2.4.6.tgz"
  if (-not (Test-Path $weixinPackage)) {
    $weixinSource = Join-Path $root "apps/openclaw-admin/node_modules/@tencent-weixin/openclaw-weixin"
    & npm pack $weixinSource --pack-destination $runtime | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $weixinPackage)) {
      throw "Tencent Weixin plugin package could not be prepared."
    }
  }
  $openclawCli = Join-Path $root "apps/openclaw-admin/node_modules/.bin/openclaw.cmd"
  & $openclawCli plugins install $weixinPackage --force
  if ($LASTEXITCODE -ne 0) {
    throw "Tencent Weixin plugin installation failed."
  }
}

if (-not (Test-Endpoint $apiUrl)) {
  $env:API_HOST = "127.0.0.1"
  $env:API_PORT = "3001"
  $env:DEMO_MODE = "true"
  $env:REQUIRE_AUTH = "false"
  $env:WEB_ORIGIN = "http://127.0.0.1:3100"
  $env:OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789"
  $env:OPENCLAW_ADMIN_URL = "http://127.0.0.1:18790"
  $env:OPENCLAW_ADMIN_TOKEN = $internalToken
  $apiMain = Join-Path $root "apps/api/dist/main.js"
  $api = Start-Process `
    -FilePath $node `
    -ArgumentList @("--conditions=production", $apiMain) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime "api-local.out.log") `
    -RedirectStandardError (Join-Path $runtime "api-local.err.log") `
    -PassThru
  Set-Content -LiteralPath (Join-Path $runtime "api-local.pid") -Value $api.Id -Encoding ascii
  Wait-Endpoint $apiUrl "API"
}

if (-not (Test-Endpoint $gatewayUrl)) {
  $openclaw = Join-Path $root "apps/openclaw-admin/node_modules/openclaw/openclaw.mjs"
  $gateway = Start-Process `
    -FilePath $node `
    -ArgumentList @($openclaw, "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--port", "18789", "--auth", "token", "--ws-log", "compact") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime "openclaw-local.out.log") `
    -RedirectStandardError (Join-Path $runtime "openclaw-local.err.log") `
    -PassThru
  Set-Content -LiteralPath (Join-Path $runtime "openclaw-local.pid") -Value $gateway.Id -Encoding ascii
  Wait-Endpoint $gatewayUrl "OpenClaw Gateway"
}

if (-not (Test-Endpoint $adminUrl)) {
  $env:OPENCLAW_ADMIN_HOST = "127.0.0.1"
  $env:OPENCLAW_ADMIN_PORT = "18790"
  $env:OPENCLAW_ADMIN_TOKEN = $internalToken
  $env:OPENCLAW_GATEWAY_HEALTH_URL = $gatewayUrl
  $adminMain = Join-Path $root "apps/openclaw-admin/dist/main.js"
  $admin = Start-Process `
    -FilePath $node `
    -ArgumentList @("--conditions=production", $adminMain) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime "openclaw-admin-local.out.log") `
    -RedirectStandardError (Join-Path $runtime "openclaw-admin-local.err.log") `
    -PassThru
  Set-Content -LiteralPath (Join-Path $runtime "openclaw-admin-local.pid") -Value $admin.Id -Encoding ascii
  Wait-Endpoint $adminUrl "OpenClaw admin"
}

if (-not (Test-Endpoint $webUrl)) {
  $env:DEMO_MODE = "true"
  $env:REQUIRE_AUTH = "false"
  $env:API_INTERNAL_URL = "http://127.0.0.1:3001/api"
  $env:API_PROXY_TARGET = "http://127.0.0.1:3001"
  $next = Join-Path $root "apps/web/node_modules/next/dist/bin/next"
  $web = Start-Process `
    -FilePath $node `
    -ArgumentList @($next, "start", "--hostname", "127.0.0.1", "--port", "3100") `
    -WorkingDirectory (Join-Path $root "apps/web") `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime "web-local.out.log") `
    -RedirectStandardError (Join-Path $runtime "web-local.err.log") `
    -PassThru
  Set-Content -LiteralPath (Join-Path $runtime "web-local.pid") -Value $web.Id -Encoding ascii
  Wait-Endpoint $webUrl "Web"
}

Write-Output "Local demo is ready: $webUrl (OpenClaw: $gatewayUrl)"
