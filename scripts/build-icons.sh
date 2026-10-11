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

# The Android shell: launcher icons (legacy, round, and the adaptive icon's
# foreground over a white background), the status-bar icon, and the splash.
res=shell/android/app/src/main/res
if [ -d "$res" ]; then
  tmp=$(mktemp -d)
  for pair in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
    density=${pair%%:*}
    scale=${pair#*:}
    px() { awk "BEGIN { printf \"%d\", $1 * $scale }"; }
    mkdir -p "$res/mipmap-$density" "$res/drawable-$density"
    rsvg-convert -w "$(px 48)" -h "$(px 48)" "$brand/icon.svg" -o "$res/mipmap-$density/ic_launcher.png"
    rsvg-convert -w "$(px 48)" -h "$(px 48)" "$brand/icon.svg" -o "$tmp/square.png"
    size=$(px 48)
    convert "$tmp/square.png" \( -size "${size}x${size}" xc:none -fill white -draw "circle $((size / 2)),$((size / 2)) $((size / 2)),0" \) \
      -compose DstIn -composite "$res/mipmap-$density/ic_launcher_round.png"
    rsvg-convert -w "$(px 108)" -h "$(px 108)" "$brand/foreground.svg" -o "$res/mipmap-$density/ic_launcher_foreground.png"
    rsvg-convert -w "$(px 24)" -h "$(px 24)" "$brand/badge.svg" -o "$res/drawable-$density/ic_stat_ivrit.png"
  done
  rm -rf "$tmp"
fi

# The iPhone shell: one 1024px icon, which iOS rounds and scales itself. Apple
# refuses transparency in it, so the full-bleed (maskable) art is flattened.
ios=shell/ios/App/App/Assets.xcassets/AppIcon.appiconset
if [ -d "$ios" ]; then
  rsvg-convert -w 1024 -h 1024 "$brand/maskable.svg" | convert - -background white -alpha remove -alpha off -type TrueColor "PNG24:$ios/AppIcon-512@2x.png"
  # The launch screen: the mark on the app's background, centred (iOS crops the square to the screen).
  splash=shell/ios/App/App/Assets.xcassets/Splash.imageset
  rsvg-convert -w 480 -h 480 "$brand/ayin.svg" -o "$splash/mark.png"
  convert -size 2732x2732 xc:'#F7F6F3' "$splash/mark.png" -gravity center -composite -type TrueColor "PNG24:$splash/splash-2732x2732.png"
  rm "$splash/mark.png"
  cp "$splash/splash-2732x2732.png" "$splash/splash-2732x2732-1.png"
  cp "$splash/splash-2732x2732.png" "$splash/splash-2732x2732-2.png"
fi
