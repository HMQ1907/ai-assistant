$ErrorActionPreference = "Stop"

$python = (Get-Command python -ErrorAction Stop).Source
$pythonRoot = Split-Path -Parent $python
$sitePackages = Join-Path $pythonRoot "Lib\site-packages"

if (Test-Path $sitePackages) {
  $env:PYTHONPATH = $sitePackages
}

Write-Host "Starting read-only MT5 bridge at http://127.0.0.1:8765"
& $python -m uvicorn mt5_bridge:app --host 127.0.0.1 --port 8765
