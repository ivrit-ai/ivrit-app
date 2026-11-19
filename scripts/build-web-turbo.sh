#!/bin/bash
# The Turbo model for the browser (shell/native/wasm) into web/turbo/turbo.{mjs,wasm}:
# whisper.cpp with the app's patches (scripts/fetch-whisper.sh), the shared
# transcript code, on WebGPU. Needs Emscripten (emsdk, EMSDK or ~/.local/opt/emsdk)
# and Dawn's emdawnwebgpu package of the Android app's Dawn release.
set -eu
cd "$(dirname "$0")/.."
EMSDK=${EMSDK:-$HOME/.local/opt/emsdk}
source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
scripts/fetch-whisper.sh
BUILD=${BUILD:-build/web-turbo}
DAWN=v20261002.154047  # as fetch-whisper.sh's dawn-android
PKG=$BUILD/emdawnwebgpu_pkg
if [ ! -f "$PKG/VERSION.txt" ]; then
  mkdir -p "$BUILD"
  curl -fsSL -o "$BUILD/emdawn.zip" "https://github.com/google/dawn/releases/download/$DAWN/emdawnwebgpu_pkg-$DAWN.zip"
  (cd "$BUILD" && python3 -m zipfile -e emdawn.zip . && rm emdawn.zip)
fi
embuilder build zlib > /dev/null
emcmake cmake -S shell/native/wasm -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DEMDAWNWEBGPU_DIR="$(pwd)/$PKG" -DZLIB_INCLUDE_DIR="$EMSDK/upstream/emscripten/cache/sysroot/include" \
  -DZLIB_LIBRARY="$EMSDK/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libz.a" > "$BUILD/cmake.log"
cmake --build "$BUILD" --target turbo
mkdir -p web/turbo
cp "$BUILD/turbo.mjs" "$BUILD/turbo.wasm" web/turbo/
ls -la web/turbo
