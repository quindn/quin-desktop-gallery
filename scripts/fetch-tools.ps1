# Downloads the helper programs the build embeds into the exe and puts them in src-tauri/bin/:
#   ffmpeg-x86_64-pc-windows-msvc.exe, ffprobe-x86_64-pc-windows-msvc.exe  (BtbN FFmpeg n9.0 GPL build)
#   yt-dlp-x86_64-pc-windows-msvc.exe                                       (latest yt-dlp release)
# They are not in git (≈ 350 MB). Run once after cloning:  powershell -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1
# Without them the app still builds, but then looks for the tools on PATH at run time.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "src-tauri\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("qg-fetch-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
    $ffmpeg = Join-Path $bin "ffmpeg-x86_64-pc-windows-msvc.exe"
    $ffprobe = Join-Path $bin "ffprobe-x86_64-pc-windows-msvc.exe"
    if ((Test-Path $ffmpeg) -and (Test-Path $ffprobe)) {
        Write-Output "FFmpeg / FFprobe already there."
    } else {
        $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip"
        Write-Output "Downloading FFmpeg (~190 MB)…"
        $zip = Join-Path $work "ffmpeg.zip"
        Invoke-WebRequest -Uri $url -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath $work -Force
        Copy-Item (Get-ChildItem $work -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1).FullName $ffmpeg -Force
        Copy-Item (Get-ChildItem $work -Recurse -Filter "ffprobe.exe" | Select-Object -First 1).FullName $ffprobe -Force
        Write-Output "Done: $ffmpeg"
        Write-Output "Done: $ffprobe"
    }

    $ytdlp = Join-Path $bin "yt-dlp-x86_64-pc-windows-msvc.exe"
    if (Test-Path $ytdlp) {
        Write-Output "yt-dlp already there."
    } else {
        Write-Output "Downloading yt-dlp…"
        Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $ytdlp
        Write-Output "Done: $ytdlp"
    }
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
