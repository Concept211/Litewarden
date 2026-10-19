# Start throwaway Vaultwarden test servers from _testserver/<version>/ (ports from versions.json).
# Usage: powershell -File scripts/testserver/start.ps1 [-Versions 1.37.4,1.35.8] [-Wipe]
# SPDX-License-Identifier: GPL-3.0-only
param([string[]]$Versions, [switch]$Wipe)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$map = (Get-Content (Join-Path $PSScriptRoot 'versions.json') -Raw | ConvertFrom-Json).servers
if (-not $Versions) { $Versions = $map.PSObject.Properties.Name }
foreach ($v in $Versions) {
  $port = [int]$map.$v
  if (-not $port) { throw "unknown version $v (add it to versions.json)" }
  if ($port -eq 8222 -or $port -lt 8301) { throw "refusing port ${port}: test servers use 8301 and up" }
  $dir = Join-Path $root "_testserver\$v"
  if ($dir -like '*Portable*') { throw 'refusing: path inside Portable' }
  if (-not (Test-Path "$dir\vaultwarden.exe")) { throw "missing $dir\vaultwarden.exe" }
  $pidFile = Join-Path $dir 'server.pid'
  if (Test-Path $pidFile) {
    $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
    if ($p) { Write-Host "$v already running (pid $($p.Id)) on $port"; continue }
  }
  if ($Wipe -and (Test-Path "$dir\data")) { Remove-Item "$dir\data" -Recurse -Force }
  # Explicit env so nothing is inherited; ENV_FILE points at an empty .env inside the test folder.
  $envFile = Join-Path $dir '.env'
  if (-not (Test-Path $envFile)) { Set-Content -Path $envFile -Value '# empty on purpose: start.ps1 sets everything explicitly' }
  $env:ENV_FILE = $envFile
  $env:DATA_FOLDER = './data'
  $env:ROCKET_ADDRESS = '127.0.0.1'
  $env:ROCKET_PORT = "$port"
  $env:SIGNUPS_ALLOWED = 'true'
  $env:WEB_VAULT_ENABLED = 'false'
  $env:DISABLE_ICON_DOWNLOAD = 'true'
  $env:I_REALLY_WANT_VOLATILE_STORAGE = 'true'
  $env:DOMAIN = "http://127.0.0.1:$port"
  $env:LOGIN_RATELIMIT_MAX_BURST = '1000'
  $env:LOGIN_RATELIMIT_SECONDS = '1'
  # 1.37.4 added a separate limit for unauthenticated endpoints (prelogin, config); the e2e suite needs headroom.
  $env:UNAUTHENTICATED_RATELIMIT_MAX_BURST = '1000'
  $env:UNAUTHENTICATED_RATELIMIT_SECONDS = '1'
  # Launch through cmd with shell execute (no handle inheritance), so callers like `npm run` don't hang on our pipes.
  $exe = "$dir\vaultwarden.exe"
  $null = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"`"$exe`" > stdout.log 2> stderr.log`"" -WorkingDirectory $dir -WindowStyle Hidden -PassThru
  $proc = $null
  for ($i = 0; $i -lt 40 -and -not $proc; $i++) {
    Start-Sleep -Milliseconds 250
    $proc = Get-CimInstance Win32_Process -Filter "Name='vaultwarden.exe'" | Where-Object { $_.ExecutablePath -eq $exe } | Select-Object -First 1
  }
  if (-not $proc) { throw "$v did not start; see $dir\stderr.log" }
  $proc = Get-Process -Id $proc.ProcessId
  $proc.Id | Set-Content $pidFile
  Write-Host "$v started pid $($proc.Id) on 127.0.0.1:$port"
}
foreach ($v in $Versions) {
  $port = [int]$map.$v; $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:$port/alive" -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  Write-Host "$v alive: $ok"
  if (-not $ok) { exit 1 }
}
