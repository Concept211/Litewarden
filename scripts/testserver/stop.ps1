# Stop the throwaway test servers started by start.ps1 (by recorded pid, and only our copied exe).
# SPDX-License-Identifier: GPL-3.0-only
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$map = (Get-Content (Join-Path $PSScriptRoot 'versions.json') -Raw | ConvertFrom-Json).servers
foreach ($v in $map.PSObject.Properties.Name) {
  $pidFile = Join-Path $root "_testserver\$v\server.pid"
  if (-not (Test-Path $pidFile)) { continue }
  $id = [int](Get-Content $pidFile)
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.Path -like "$root\_testserver\*") { Stop-Process -Id $id -Force; Write-Host "$v stopped ($id)" }
  else { Write-Host "$v not running" }
  Remove-Item $pidFile
}
