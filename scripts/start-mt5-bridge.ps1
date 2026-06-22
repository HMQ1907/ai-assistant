$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot

$python = (Get-Command python -ErrorAction Stop).Source
$pythonRoot = Split-Path -Parent $python
$sitePackages = Join-Path $pythonRoot "Lib\site-packages"

if (Test-Path $sitePackages) {
  $env:PYTHONPATH = $sitePackages
}

function Test-BridgePackages {
  & $python -c "import numpy; import MetaTrader5, fastapi, uvicorn; print('MT5 bridge packages OK')"
  return $LASTEXITCODE -eq 0
}

if (-not (Test-BridgePackages)) {
  Write-Host "Installing MT5 bridge packages into current Python..."
  & $python -m ensurepip --upgrade
  if (Test-Path $sitePackages) {
    $env:PYTHONPATH = $sitePackages
  }
  & $python -m pip install -r (Join-Path $projectRoot "requirements-mt5.txt")

  if (-not (Test-BridgePackages)) {
    Write-Host "Repairing numpy and MetaTrader5 packages..."
    & $python -m pip install --force-reinstall --no-cache-dir numpy MetaTrader5
  }

  if (-not (Test-BridgePackages)) {
    throw "MT5 bridge packages could not be imported. Reinstall Python outside D:\ root if this repeats."
  }
}

Write-Host "Starting read-only MT5 bridge at http://127.0.0.1:8765"
& $python -m uvicorn mt5_bridge:app --host 127.0.0.1 --port 8765
