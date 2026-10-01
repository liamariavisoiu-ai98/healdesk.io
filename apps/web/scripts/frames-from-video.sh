#!/usr/bin/env bash
# Cut one row of the hero frame grid out of a generated video.
#
#   ./frames-from-video.sh <video> <row> [cols]
#
# HeyGen, Synthesia and Seedance all hand you a clip, not a grid. One clip can
# only trace ONE path through the grid, so it becomes one row: film her sweeping
# her gaze left to right at a fixed head pitch, and this samples that sweep at
# `cols` evenly spaced instants. Run it once per pitch level with row = 0..rows-1.
#
# Sampling by timestamp rather than by frame number on purpose — generated clips
# vary in frame rate and length, and evenly spaced *times* keep the yaw steps
# even regardless.
set -euo pipefail

VIDEO="${1:?usage: frames-from-video.sh <video> <row> [cols]}"
ROW="${2:?usage: frames-from-video.sh <video> <row> [cols]}"
COLS="${3:-9}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/hero-frames"
WIDTH=900

command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }
mkdir -p "$OUT"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")
echo "$VIDEO — ${DUR}s, sampling $COLS frames into row $ROW"

for ((c = 0; c < COLS; c++)); do
  # Nudge off the exact endpoints: the first and last frames of generated clips
  # are the most likely to carry compression or fade artefacts.
  T=$(awk -v d="$DUR" -v i="$c" -v n="$((COLS - 1))" 'BEGIN{printf "%.3f", 0.04*d + (0.92*d)*i/n}')
  # Out as PNG, then convert with Pillow: many ffmpeg builds (including the one
  # on this machine) ship without a WebP encoder, and failing at the last step
  # of a long extraction is a miserable way to find that out.
  ffmpeg -nostdin -v error -ss "$T" -i "$VIDEO" -frames:v 1 \
    -vf "scale=${WIDTH}:-2" "$OUT/.tmp_${ROW}_${c}.png" -y
  python3 - "$OUT/.tmp_${ROW}_${c}.png" "$OUT/f_${ROW}_${c}.webp" <<'CONV'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
Image.open(src).convert("RGB").save(dst, "WEBP", quality=86, method=4)
CONV
  rm -f "$OUT/.tmp_${ROW}_${c}.png"
  printf "  f_%s_%s.webp  t=%ss\n" "$ROW" "$c" "$T"
done

echo
echo "Now update cols/rows in $OUT/frames.json, then verify with:"
echo "  python3 $(dirname "$0")/build-hero-frames.py --verify"
