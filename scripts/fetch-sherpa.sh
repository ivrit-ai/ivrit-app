#!/bin/sh
# The on-device transcription runtime for Android: sherpa-onnx's prebuilt library
# (onnxruntime linked in), from its GitHub release, checked against a pinned
# hash, into shell/android/app/libs (not in git: 38 MB). build-android.sh runs this.
set -eu
cd "$(dirname "$0")/.."
VERSION=1.13.8
SHA256=b22c3fc1b6a45666d28892bb2f7694beeb77a8362d7ebd77c1a5431ec9435471
OUT=shell/android/app/libs/sherpa-onnx.aar
if [ -f "$OUT" ] && echo "$SHA256  $OUT" | sha256sum -c --status; then exit 0; fi
mkdir -p "$(dirname "$OUT")"
curl -fsSL -o "$OUT.part" "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$VERSION/sherpa-onnx-static-link-onnxruntime-$VERSION.aar"
echo "$SHA256  $OUT.part" | sha256sum -c --status || { rm -f "$OUT.part"; echo "sherpa-onnx: hash mismatch" >&2; exit 1; }
mv "$OUT.part" "$OUT"
