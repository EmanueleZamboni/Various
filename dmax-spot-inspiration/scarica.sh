#!/usr/bin/env bash
# Scarica i reference in batch con yt-dlp (max 1080p, mp4).
# Uso:  ./scarica.sh                 -> scarica la TOP 15
#       ./scarica.sh links-tutti.txt -> scarica tutto (72 video)
# Serve: yt-dlp + ffmpeg  (macOS: brew install yt-dlp ffmpeg | Windows: winget install yt-dlp ffmpeg)
set -euo pipefail
LIST="${1:-links-priorita.txt}"
cd "$(dirname "$0")"
mkdir -p video
yt-dlp \
  -a "$LIST" \
  -f "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b" \
  --merge-output-format mp4 \
  -o "video/%(title).80s [%(id)s].%(ext)s" \
  --download-archive video/.scaricati.txt \
  --ignore-errors --no-overwrites
