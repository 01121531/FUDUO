[CmdletBinding()]
param(
  [ValidateSet("docker", "source")][string]$Mode = "docker",
  [string]$Version,
  [string]$Rollback,
  [string]$Repository = $(if ($env:FUDUO_GITHUB_REPOSITORY) { $env:FUDUO_GITHUB_REPOSITORY } else { "01121531/FUDUO" })
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$stateDirectory = Join-Path $root ".updates"
$versionFile = Join-Path $stateDirectory "current-version"
New-Item -ItemType Directory -Force $stateDirectory | Out-Null

function Get-CurrentVersion {
  if (Test-Path -LiteralPath $versionFile) { return (Get-Content -LiteralPath $versionFile -Raw).Trim() }
  $tag = git -C $root describe --tags --exact-match 2>$null
  if ($LASTEXITCODE -eq 0) { return $tag.Trim() }
  return "unknown"
}

function Get-LatestVersion {
  $headers = @{ Accept = "application/vnd.github+json"; "User-Agent" = "fuduo-updater" }
  $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/latest"
  return [string]$release.tag_name
}

$target = if ($Rollback) { $Rollback } elseif ($Version) { $Version } else { Get-LatestVersion }
if ($target -notmatch '^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid version: $target" }
$oldVersion = Get-CurrentVersion
Write-Output "Updating FUDUO from $oldVersion to $target using $Mode mode."

if ($Mode -eq "docker") {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker is required for docker mode." }
  $base = Join-Path $root "deploy/docker-compose.yml"
  $release = Join-Path $root "deploy/docker-compose.release.yml"
  $env:FUDUO_IMAGE_TAG = $target
  docker compose -f $base -f $release pull
  docker compose -f $base -f $release up -d --remove-orphans --wait
  if ($LASTEXITCODE -ne 0) {
    if ($oldVersion -ne "unknown") {
      $env:FUDUO_IMAGE_TAG = $oldVersion
      docker compose -f $base -f $release up -d --remove-orphans --wait
    }
    throw "Update failed; the previous version was restored."
  }
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required for source mode." }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw "pnpm is required for source mode." }
  if (git -C $root status --porcelain) { throw "Source tree has local changes; update aborted." }
  $oldRevision = (git -C $root rev-parse HEAD).Trim()
  git -C $root fetch --tags origin
  git -C $root rev-parse --verify "refs/tags/$target" | Out-Null
  git -C $root checkout --detach $target
  try {
    Push-Location $root
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Build failed." }
  } catch {
    git -C $root checkout --detach $oldRevision
    throw
  } finally {
    Pop-Location
  }
  if ($env:FUDUO_RESTART_COMMAND) { Invoke-Expression $env:FUDUO_RESTART_COMMAND }
}

Set-Content -LiteralPath $versionFile -Value $target -NoNewline
Write-Output "FUDUO is now on $target."
