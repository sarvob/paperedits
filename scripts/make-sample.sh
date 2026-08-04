#!/usr/bin/env bash
# Generate a reproducible test clip with REAL speech (macOS `say`) and hard scene
# cuts, so the import→edit→render pipeline can be exercised without shipping media.
#
#   bash scripts/make-sample.sh          # → samples/buildlog.mp4
#
# Requires: ffmpeg, and macOS `say` (falls back to a silent clip elsewhere).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p samples

NARR="In this section I am wiring the motor with the drill. It is quite loud right now. \
Let me pause and explain the theory. This part is mostly background talk, nothing to see. \
Okay, back to building. I am drilling the final holes now. And that is the finished assembly."

if command -v say >/dev/null 2>&1; then
  say -o samples/narration.aiff "$NARR"
  AUDIO_IN=(-i samples/narration.aiff)
  AUDIO_MAP=(-map 3:a)
else
  echo "note: no macOS 'say' — generating a silent clip"
  AUDIO_IN=(-f lavfi -i "anullsrc=r=16000:cl=mono:d=19")
  AUDIO_MAP=(-map 3:a)
fi

ffmpeg -y -v error \
  -f lavfi -i "smptebars=size=640x360:rate=25:duration=6" \
  -f lavfi -i "testsrc2=size=640x360:rate=25:duration=7" \
  -f lavfi -i "color=c=navy:size=640x360:rate=25:duration=6" \
  "${AUDIO_IN[@]}" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]" \
  -map "[v]" "${AUDIO_MAP[@]}" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  samples/buildlog.mp4

echo "wrote samples/buildlog.mp4"
