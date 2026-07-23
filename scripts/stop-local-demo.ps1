$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root ".runtime"

foreach ($name in @("web-local", "openclaw-admin-local", "openclaw-local", "api-local")) {
  $pidFile = Join-Path $runtime "$name.pid"
  if (-not (Test-Path -LiteralPath $pidFile)) {
    continue
  }

  $processId = [int](Get-Content -LiteralPath $pidFile -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -like "*$root*") {
    Stop-Process -Id $processId -Force
  }
  Remove-Item -LiteralPath $pidFile -Force
}

Write-Output "Local demo processes stopped."
