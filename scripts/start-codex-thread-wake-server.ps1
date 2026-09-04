param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'codex-thread-wake-server.py'
Set-Location -LiteralPath $root
$python = Get-Command python -All -ErrorAction Stop |
  Where-Object { $_.Source -notlike '*\Microsoft\WindowsApps\*' } |
  Select-Object -First 1 -ExpandProperty Source
if (-not $python) {
  throw 'Không tìm thấy Python thật (chỉ thấy WindowsApps alias). Cài Python hoặc sửa PATH.'
}
$arguments = @($scriptPath)
if ($DryRun) {
  $arguments += '--dry-run'
}
& $python @arguments
exit $LASTEXITCODE
