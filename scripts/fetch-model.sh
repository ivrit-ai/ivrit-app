#!/bin/sh
# The on-device model, zipformer2-66m-streaming-he (the ivrit-ai mirror, at the
# revision web/transcription/local/worker.js and Android's LocalModel.java use),
# bundled into both apps: checked against pinned hashes, into shell/bundled/model
# (not in git: 72 MB). Android packs shell/bundled as assets, the iPhone app as
# the folder "model"; build-android.sh and build-ios.sh run this.
set -eu
cd "$(dirname "$0")/.."
REVISION=3d01a65d00e45cbb238996795be87e8e800a3226
BASE=https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he/resolve/$REVISION
OUT=shell/bundled/model
mkdir -p "$OUT"
# Path in the repo, and its SHA-256; bundled under its own file name.
while read -r path sha256; do
  file=$OUT/${path##*/}
  if [ -f "$file" ] && echo "$sha256  $file" | shasum -a 256 -c --status; then continue; fi
  curl -fsSL --retry 3 -o "$file.part" "$BASE/$path"
  echo "$sha256  $file.part" | shasum -a 256 -c --status || { rm -f "$file.part"; echo "model: hash mismatch for $path" >&2; exit 1; }
  mv "$file.part" "$file"
done <<EOF
sherpa-onnx/encoder.int8.onnx 6c6febcb74a09435315a1d872a6539f6e7fc2c333533f14c74edc0e85c49ffcd
sherpa-onnx/decoder.int8.onnx feb03e7c8aa761593a9284a6fa1e91259be3702de75f630062256c1a59c5a906
sherpa-onnx/joiner.int8.onnx 1d2c6d8e6dabc5eb52de52e95718e9bdfbffbfe7ead3808fb5ffd74e83bd9cae
sherpa-onnx/tokens.txt e4ebb5e72a6aeef47437a55fa2308ebbedb7c51c557de7a89bf965c23ea9af4a
onnx/config.json 6ad75405069d306cf96f1642e8093f7642773f40082c39a0ce7a3d270b1db920
EOF
