#!/bin/sh
# Renders the web app's icons from the SVGs in shared/brand/. Needs
# rsvg-convert (librsvg). The PNGs are committed; run this only after changing
# the SVGs.
set -eu
cd "$(dirname "$0")/.."
brand=shared/brand
out=web/icons
mkdir -p "$out"
for size in 192 512 1024; do
  rsvg-convert -w "$size" -h "$size" "$brand/icon.svg" -o "$out/icon-$size.png"
done
rsvg-convert -w 512 -h 512 "$brand/maskable.svg" -o "$out/maskable-512.png"
rsvg-convert -w 180 -h 180 "$brand/maskable.svg" -o "$out/apple-touch-icon.png"
# Android draws the badge as a white silhouette in the status bar.
rsvg-convert -w 72 -h 72 "$brand/badge.svg" -o "$out/badge-72.png"
cp "$brand/icon.svg" "$out/mark.svg"
