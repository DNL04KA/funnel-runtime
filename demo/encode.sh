#!/usr/bin/env bash
# Собирает записанный Playwright'ом webm в mp4 с фейдами на входе и выходе.
set -euo pipefail
cd "$(dirname "$0")"

SRC=$(ls reel-video/*.webm | head -1)
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC")
FADE_OUT=$(python3 -c "print(max(0, $DUR - 0.8))")

ffmpeg -v error -i "$SRC" \
  -vf "fade=t=in:st=0:d=0.7,fade=t=out:st=$FADE_OUT:d=0.8" \
  -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -profile:v high -level 4.0 \
  -movflags +faststart -r 25 -an \
  funnel-runtime-reel.mp4 -y

echo "готово: demo/funnel-runtime-reel.mp4 ($(du -h funnel-runtime-reel.mp4 | cut -f1))"
