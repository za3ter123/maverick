# Builds desktop/app-audio.exe (Rust, windows 0.62.2 from the local cargo cache, no download). Prints BUILD OK.
Push-Location $PSScriptRoot
try { $log = & cargo build --release --offline --locked 2>&1 | Out-String; $code = $LASTEXITCODE } finally { Pop-Location }
if ($code -ne 0) { Write-Host $log; Write-Host "BUILD FAILED (cargo exit $code)"; exit 1 }
Copy-Item (Join-Path $PSScriptRoot 'target\release\app-audio.exe') (Join-Path $PSScriptRoot '..\app-audio.exe') -Force
'BUILD OK'
