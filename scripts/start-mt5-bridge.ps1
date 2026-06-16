$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvPython = Join-Path $projectRoot ".venv-mt5\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
  $python = (Get-Command python -ErrorAction Stop).Source
  Write-Host "Creating MT5 bridge virtual environment at .venv-mt5"
  & $python -m venv (Join-Path $projectRoot ".venv-mt5")
  & $venvPython -m pip install -U pip
  & $venvPython -m pip install -r (Join-Path $projectRoot "requirements-mt5.txt")
}

Write-Host "Starting read-only MT5 bridge at http://127.0.0.1:8765"
& $venvPython -m uvicorn mt5_bridge:app --host 127.0.0.1 --port 8765
