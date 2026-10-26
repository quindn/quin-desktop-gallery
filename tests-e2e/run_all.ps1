# Runs every e2e suite against one build:  powershell -File run_all.ps1 [exe]   (default: the release build)
param([string]$exe = "")
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $exe) { $exe = Join-Path $here "..\src-tauri\target\release\quin-gallery.exe" }
$out = Join-Path $env:TEMP "qg-e2e-shots"
Set-Location $here
foreach ($n in @("e2e_lock", "e2e_features", "e2e_timeline", "e2e_watch", "e2e_viewer_studio", "e2e_search")) {
    Write-Output "=============== $n"
    node "$n.mjs" $exe (Join-Path $out $n) 2>&1 | Select-String -Pattern "^(PASS|FAIL)|passed|FAILED|E2E run"
}
Write-Output "=============== DONE"
