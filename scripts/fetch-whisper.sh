#!/bin/sh
# whisper.cpp's source, for the Android app's Turbo model (built with the app,
# shell/android/app/src/main/cpp), the Vulkan and SPIR-V headers its Vulkan
# backend builds against (newer than the NDK's), and Google's Dawn for its WebGPU
# backend (Dawn's own Android build, static, and its headers, from the release
# nearest whisper.cpp's), and the OpenCL headers its OpenCL backend builds against
# (the phone's own libOpenCL.so is opened at run time: src/main/cpp/opencl.c):
# release tarballs, each checked against a pinned hash,
# into shell/android/app/src/main/cpp/ (not in git).
# whisper.cpp gets the app's patches (src/main/cpp/patches/*.patch) on top; a
# change to them fetches it again. build-android.sh runs this.
set -eu
cd "$(dirname "$0")/.."
CPP=shell/android/app/src/main/cpp

# fetch <dir> <version> <sha256> <url> [patches...]
fetch() {
  out="$CPP/$1"
  version=$2
  [ -f "$out/VERSION-$version" ] && return 0
  tarball=$(mktemp)
  curl -fsSL -o "$tarball" "$4"
  echo "$3  $tarball" | sha256sum -c --status || { rm -f "$tarball"; echo "$1: hash mismatch" >&2; exit 1; }
  rm -rf "$out"
  mkdir -p "$out"
  tar xzf "$tarball" -C "$out" --strip-components=1
  rm -f "$tarball"
  shift 4
  for p in "$@"; do patch -s -p1 -d "$out" < "$p"; done
  touch "$out/VERSION-$version"
}

patches=$(ls "$CPP"/patches/*.patch)
patched=$(cat $patches | sha256sum | cut -c1-12)
fetch whisper.cpp "1.9.5-$patched" ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720 \
  https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz $patches
fetch vulkan-headers 1.4.350.1 6d1bb65e49520344cc0a48af3dc02e993781efff14c7ebdcb8ae9fa23ddf7e83 \
  https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/vulkan-sdk-1.4.350.1.tar.gz
fetch spirv-headers 1.4.350.1 9e6d5c78878172d2b810e97f3a74ecbbb14b4ad52b07384ce915fbbeb226d610 \
  https://github.com/KhronosGroup/SPIRV-Headers/archive/refs/tags/vulkan-sdk-1.4.350.1.tar.gz
DAWN=https://github.com/google/dawn/releases/download/v20261002.154047
fetch dawn-android v20261002.154047 d3543688c734da73f7fd742c308f6462b59360b6997be2d012819217b17c1fd5 \
  $DAWN/dawn-android-b1236a9bb4a47f1262bc3acb253bb1c2181e90dd.tar.gz
fetch dawn-headers v20261002.154047 dcaad42cf9298386ea390e8a4477992715bbb13d46888bce03b0a9a4aae68568 \
  $DAWN/dawn-headers-b1236a9bb4a47f1262bc3acb253bb1c2181e90dd.tar.gz
fetch opencl-headers v2024.10.24 159f2a550592bae49859fee83d372acd152328fdf95c0dcd8b9409f8fad5db93 \
  https://github.com/KhronosGroup/OpenCL-Headers/archive/refs/tags/v2024.10.24.tar.gz
