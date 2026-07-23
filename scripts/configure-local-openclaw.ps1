param(
  [Parameter(Mandatory = $true)][string]$StateDir,
  [Parameter(Mandatory = $true)][string]$FuduoPluginPath
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $StateDir | Out-Null
$configPath = Join-Path $StateDir "openclaw.json"

$allowedTools = @(
  "list_shops",
  "get_shop_sales",
  "compare_shop_sales",
  "rank_shops_by_sales",
  "get_sales_summary",
  "get_shop_orders",
  "get_shop_refunds",
  "generate_daily_report",
  "generate_weekly_report",
  "get_data_freshness",
  "get_sync_status"
)

$envReference = {
  param([string]$Id)
  return [ordered]@{ source = "env"; provider = "default"; id = $Id }
}

$config = [ordered]@{
  plugins = [ordered]@{
    allow = @("fuduo-business", "openclaw-weixin")
    load = [ordered]@{ paths = @($FuduoPluginPath) }
    entries = [ordered]@{
      "fuduo-business" = [ordered]@{
        enabled = $true
        config = [ordered]@{
          apiBaseUrl = "http://127.0.0.1:3001/api"
          serviceToken = & $envReference "FUDUO_INTERNAL_SERVICE_TOKEN"
        }
      }
      "openclaw-weixin" = [ordered]@{ enabled = $true }
    }
  }
  tools = [ordered]@{
    profile = "full"
    allow = $allowedTools
    deny = @("group:openclaw", "group:fs", "group:runtime", "canvas")
  }
  models = [ordered]@{
    mode = "replace"
    providers = [ordered]@{
      "fuduo-runtime" = [ordered]@{
        baseUrl = "http://127.0.0.1:3001/api/internal/openclaw/v1"
        api = "openai-completions"
        apiKey = & $envReference "FUDUO_INTERNAL_SERVICE_TOKEN"
        models = @([ordered]@{
          id = "default"
          name = "富多后台当前模型"
          reasoning = $false
          input = @("text")
          cost = [ordered]@{ input = 0; output = 0; cacheRead = 0; cacheWrite = 0 }
          contextWindow = 32768
          maxTokens = 4096
          compat = [ordered]@{ supportsUsageInStreaming = $false }
        })
      }
    }
  }
  agents = [ordered]@{
    defaults = [ordered]@{
      workspace = Join-Path $StateDir "workspace"
      models = [ordered]@{ "fuduo-runtime/default" = @{} }
      model = [ordered]@{ primary = "fuduo-runtime/default"; fallbacks = @() }
    }
  }
  session = [ordered]@{ dmScope = "per-account-channel-peer" }
  channels = [ordered]@{ "openclaw-weixin" = [ordered]@{ dmPolicy = "pairing" } }
  logging = [ordered]@{ redactSensitive = "tools" }
  gateway = [ordered]@{
    auth = [ordered]@{
      mode = "token"
      token = & $envReference "OPENCLAW_GATEWAY_TOKEN"
    }
  }
}

$lastTouchedAt = (Get-Date).ToUniversalTime().ToString("o")
if (Test-Path $configPath) {
  try {
    $existing = Get-Content -Raw -Encoding utf8 $configPath | ConvertFrom-Json
    if ($existing.meta.lastTouchedAt -is [string]) {
      $lastTouchedAt = $existing.meta.lastTouchedAt
    }
  } catch {
    # Invalid existing JSON is replaced by the generated, validated structure.
  }
}
$config["meta"] = [ordered]@{ lastTouchedVersion = "2026.7.1"; lastTouchedAt = $lastTouchedAt }
$json = $config | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
