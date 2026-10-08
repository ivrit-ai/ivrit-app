#!/bin/sh
# Builds the whisper-gpu engine's pages (demo, kernel benchmark, unattended
# run) into web/lab/whisper/ from a whisper-gpu checkout.
#
#   scripts/build-lab.sh [path to whisper-gpu]   (default ../whisper-gpu)
set -eu
cd "$(dirname "$0")/.."
. scripts/android-env.sh
WHISPER_GPU_DIR=$(cd "${1:-../whisper-gpu}" && pwd)
LAB_OUT_DIR=$(pwd)/web/lab/whisper
export WHISPER_GPU_DIR LAB_OUT_DIR
(cd "$WHISPER_GPU_DIR" && npx vite build --config "$OLDPWD/scripts/lab.vite.config.mjs" --logLevel warn)
date -u +"built %Y-%m-%dT%H:%MZ from $WHISPER_GPU_DIR" > web/lab/whisper/SOURCE
ls web/lab/whisper
