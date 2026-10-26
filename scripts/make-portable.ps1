# Produces the portable build: ONE file, "Quin Gallery.exe".
# FFmpeg, FFprobe, yt-dlp and the uBlock Origin extension are packed inside the exe at build time
# (see src-tauri/build.rs) and unpacked to %LOCALAPPDATA%\QuinGallery on first launch.
# Requires the WebView2 Runtime on the target machine (present on virtually all Windows 10/11 systems).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root "src-tauri\target\release"
$exe = Join-Path $release "quin-gallery.exe"
$outDir = Join-Path $release "portable"

if (-not (Test-Path $exe)) {
    Write-Error "Release build not found. Run 'npx tauri build --no-bundle' first."
    exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$target = Join-Path $outDir "Quin Gallery.exe"
Copy-Item $exe $target -Force

Write-Output "Portable build: $target ($([math]::Round((Get-Item $target).Length / 1MB)) MB)"
Write-Output "Copy that file anywhere and run it: it creates a 'data' folder next to itself and keeps EVERYTHING there"
Write-Output "(libraries, thumbnails, tools, browser profiles, downloads). Keep the 'data' folder with the exe to move the app."
