#!/bin/sh
# Builds the Android app and releases it on Google Play's internal testing
# track, where testers get it through the Play Store within minutes.
#
#   scripts/publish-android.sh ["release notes"] [track]
#
# Needs everything build-android.sh does, plus the play-publisher service
# account's key at ~/keys/ivrit-app-play-publisher.json (or
# PLAY_SERVICE_ACCOUNT), invited in the Play Console with release rights.
# Commit first: the version code is the commit count, and Play refuses one it
# has seen.
set -eu
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "commit first: the build is numbered by commit" >&2; exit 1; }
scripts/build-android.sh
. scripts/android-env.sh
code=$(git rev-list --count HEAD)
version=$(node -p 'require("./shared/app.json").version')
node scripts/play.mjs upload "dist/ivrit-app-$version-$code.aab" "${2:-internal}" "${1:-}"
