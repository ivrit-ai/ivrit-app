#!/bin/sh
# Builds the Android app: an .aab for Google Play and an .apk to install
# directly, both signed with the upload key, into dist/.
#
# Needs, outside the repo:
#   ~/keys/ivrit-app-upload.jks and ~/keys/ivrit-app-upload.password
#   ~/keys/ivrit-app-google-services.json  (Firebase's config for ai.ivrit.app)
# Override with IVRIT_UPLOAD_KEYSTORE, IVRIT_UPLOAD_PASSWORD_FILE, GOOGLE_SERVICES.
set -eu
cd "$(dirname "$0")/.."
. scripts/android-env.sh

: "${IVRIT_UPLOAD_KEYSTORE:=$HOME/keys/ivrit-app-upload.jks}"
: "${IVRIT_UPLOAD_PASSWORD_FILE:=$HOME/keys/ivrit-app-upload.password}"
: "${GOOGLE_SERVICES:=$HOME/keys/ivrit-app-google-services.json}"
export IVRIT_UPLOAD_KEYSTORE IVRIT_UPLOAD_PASSWORD_FILE

if [ -f "$GOOGLE_SERVICES" ]; then
  cp "$GOOGLE_SERVICES" shell/android/app/google-services.json
else
  echo "warning: no $GOOGLE_SERVICES: this build cannot receive notifications" >&2
  rm -f shell/android/app/google-services.json
fi
[ -f "$IVRIT_UPLOAD_KEYSTORE" ] || { echo "missing upload key $IVRIT_UPLOAD_KEYSTORE" >&2; exit 1; }

IVRIT_VERSION_CODE=$(git rev-list --count HEAD)
IVRIT_VERSION_NAME=$(node -p 'require("./shared/app.json").version')
export IVRIT_VERSION_CODE IVRIT_VERSION_NAME

(cd shell && npm ci --silent && npx cap sync android)
(cd shell/android && ./gradlew --no-daemon -q bundleRelease assembleRelease)

mkdir -p dist
name="ivrit-app-$IVRIT_VERSION_NAME-$IVRIT_VERSION_CODE"
cp shell/android/app/build/outputs/bundle/release/app-release.aab "dist/$name.aab"
cp shell/android/app/build/outputs/apk/release/app-release.apk "dist/$name.apk"
ls -l dist/"$name".*
