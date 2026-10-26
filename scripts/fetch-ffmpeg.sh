#!/usr/bin/env bash
# Downloads static Windows FFmpeg/FFprobe builds and yt-dlp, and places them as Tauri
# sidecar binaries under src-tauri/bin/ (scripts/fetch-tools.ps1 does the same in PowerShell). Not committed to git (see
# .gitignore) since they're ~160MB each — run this once after cloning.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p src-tauri/bin
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip"
echo "Downloading FFmpeg static build (~190MB)..."
curl -sL -o "$work/ffmpeg.zip" "$url"

python3 - "$work/ffmpeg.zip" "$work" <<'PYEOF'
import sys, zipfile
zip_path, out_dir = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zip_path)
for n in z.namelist():
    if n.endswith("bin/ffmpeg.exe") or n.endswith("bin/ffprobe.exe"):
        z.extract(n, out_dir)
PYEOF

ffmpeg_src=$(find "$work" -iname "ffmpeg.exe" | head -n1)
ffprobe_src=$(find "$work" -iname "ffprobe.exe" | head -n1)

cp "$ffmpeg_src" src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe
cp "$ffprobe_src" src-tauri/bin/ffprobe-x86_64-pc-windows-msvc.exe

echo "Done: src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe"
echo "Done: src-tauri/bin/ffprobe-x86_64-pc-windows-msvc.exe"

echo "Downloading yt-dlp..."
curl -sL -o src-tauri/bin/yt-dlp-x86_64-pc-windows-msvc.exe "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
echo "Done: src-tauri/bin/yt-dlp-x86_64-pc-windows-msvc.exe"
