#!/bin/sh
# whisper.cpp's source, for the Android app's Turbo model (built with the app,
# shell/android/app/src/main/cpp), and the Vulkan and SPIR-V headers its GPU
# backend builds against (newer than the NDK's): release tarballs, each checked
# against a pinned hash, into shell/android/app/src/main/cpp/ (not in git).
# build-android.sh runs this.
set -eu
cd "$(dirname "$0")/.."
CPP=shell/android/app/src/main/cpp

# fetch <dir> <version> <sha256> <url>
fetch() {
  out="$CPP/$1"
  [ -f "$out/VERSION-$2" ] && return 0
  tarball=$(mktemp)
  curl -fsSL -o "$tarball" "$4"
  echo "$3  $tarball" | sha256sum -c --status || { rm -f "$tarball"; echo "$1: hash mismatch" >&2; exit 1; }
  rm -rf "$out"
  mkdir -p "$out"
  tar xzf "$tarball" -C "$out" --strip-components=1
  rm -f "$tarball"
  touch "$out/VERSION-$2"
}

fetch whisper.cpp 1.9.5 ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720 \
  https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz
fetch vulkan-headers 1.4.350.1 6d1bb65e49520344cc0a48af3dc02e993781efff14c7ebdcb8ae9fa23ddf7e83 \
  https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/vulkan-sdk-1.4.350.1.tar.gz
fetch spirv-headers 1.4.350.1 9e6d5c78878172d2b810e97f3a74ecbbb14b4ad52b07384ce915fbbeb226d610 \
  https://github.com/KhronosGroup/SPIRV-Headers/archive/refs/tags/vulkan-sdk-1.4.350.1.tar.gz
