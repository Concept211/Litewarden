# Throwaway HTTPS Vaultwarden WITH a web vault, for the tests that open a shared link as a stranger. The recipient's
# page only runs over HTTPS, so the plain test servers (start.ps1) can't show it. Each one has its own folder and its
# own copy of the exe, so start.ps1 and stop.ps1, which find processes by exe path, never mistake it for theirs.
# Needs _testserver/web-vault-copy (a web vault build) and _testserver/tls/{cert,key}.pem (self-signed, for localhost).
# A server needs a web vault from its own era: a newer one signs in to Sends in a way an older server doesn't know.
# Usage: powershell -File scripts/testserver/webvault.ps1 [-Version 1.37.4] [-Port 8305] [-WebVault folder] [-SendsOff] [-Stop]
# SPDX-License-Identifier: GPL-3.0-only
param([string]$Version = '1.37.4', [int]$Port = 8305, [string]$WebVault = '_testserver\web-vault-copy', [switch]$SendsOff, [switch]$Stop)
$ErrorActionPreference = 'Stop'
if ($Port -lt 8305) { throw "refusing port ${Port}: 8301-8304 are the plain test servers, and anything lower isn't a test server" }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dir = Join-Path $root "_testserver\webvault\$Port"
if ($dir -like '*Portable*') { throw 'refusing: path inside Portable' }
$exe = Join-Path $dir 'vw-webvault.exe'
$running = Get-CimInstance Win32_Process -Filter "Name='vw-webvault.exe'" | Where-Object { $_.ExecutablePath -eq $exe }
if ($Stop) {
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host "stopped $Port"
  exit 0
}
if ($running) { Write-Host "$Port already running"; exit 0 }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item (Join-Path $root "_testserver\$Version\vaultwarden.exe") $exe -Force
if (Test-Path "$dir\data") { Remove-Item "$dir\data" -Recurse -Force }
$envFile = Join-Path $dir '.env'
Set-Content -Path $envFile -Value '# empty on purpose: this script sets everything explicitly'
$tls = (Join-Path $root '_testserver\tls').Replace('\', '/')
$env:ENV_FILE = $envFile
$env:DATA_FOLDER = './data'
$env:ROCKET_ADDRESS = '127.0.0.1'
$env:ROCKET_PORT = "$Port"
$env:ROCKET_TLS = "{certs=`"$tls/cert.pem`",key=`"$tls/key.pem`"}"
$env:SIGNUPS_ALLOWED = 'true'
$env:WEB_VAULT_ENABLED = 'true'
$env:WEB_VAULT_FOLDER = Join-Path $root $WebVault
$env:DISABLE_ICON_DOWNLOAD = 'true'
$env:I_REALLY_WANT_VOLATILE_STORAGE = 'true'
$env:DOMAIN = "https://localhost:$Port"
$env:SENDS_ALLOWED = $(if ($SendsOff) { 'false' } else { 'true' })
$env:LOGIN_RATELIMIT_MAX_BURST = '1000'
$env:LOGIN_RATELIMIT_SECONDS = '1'
$env:UNAUTHENTICATED_RATELIMIT_MAX_BURST = '1000'
$env:UNAUTHENTICATED_RATELIMIT_SECONDS = '1'
$null = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"`"$exe`" > stdout.log 2> stderr.log`"" -WorkingDirectory $dir -WindowStyle Hidden -PassThru
for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = & curl.exe -sk --max-time 2 "https://localhost:$Port/alive"
    if ($LASTEXITCODE -eq 0 -and $r) { Write-Host "$Version alive on https://localhost:$Port (sends $(if ($SendsOff) { 'off' } else { 'on' }))"; exit 0 }
  } catch {}
  Start-Sleep -Milliseconds 500
}
throw "$Port did not start; see $dir\stderr.log"
