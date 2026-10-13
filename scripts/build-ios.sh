#!/bin/sh
# Builds the iPhone app, on a Mac or in CI (.github/workflows/ios.yml): the Xcode
# project from shell/ios/App/project.yml (XcodeGen), Capacitor's files, then
#
#   scripts/build-ios.sh simulator    a build for the simulator, unsigned: does it compile
#   scripts/build-ios.sh testflight   a signed archive, uploaded to App Store Connect
#
# testflight signs with the distribution certificate (IOS_DIST_P12_PATH and
# IOS_DIST_P12_PASSWORD; IOS_CERT_ID is its id at Apple), with App Store profiles
# that scripts/ios-signing.py makes through the App Store Connect API key
# (ASC_KEY_PATH, the .p8 file, as private_keys/AuthKey_<ASC_KEY_ID>.p8;
# ASC_KEY_ID; ASC_ISSUER_ID), and uploads with that key. IVRIT_TEAM_ID is the
# Apple Developer team.
# Needs Xcode, Node 22 and xcodegen (brew install xcodegen).
set -eu
cd "$(dirname "$0")/.."
mode=${1:?simulator or testflight}
# As scripts/build-android.sh numbers Android's builds.
version=$(node -p 'require("./shared/app.json").version')
build=$(git rev-list --count HEAD)
out=$(pwd)/build/ios
project=shell/ios/App/App.xcodeproj

(cd shell && npm ci --no-audit --no-fund)
# Generated twice: Capacitor's sync needs a project, and the project needs the
# files the sync writes (the web assets, capacitor.config.json).
(cd shell/ios/App && xcodegen generate --quiet)
(cd shell && npx cap sync ios)
(cd shell/ios/App && xcodegen generate --quiet)

case $mode in
simulator)
  xcodebuild -project "$project" -scheme App -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$out/derived" CODE_SIGNING_ALLOWED=NO \
    MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" build
  ;;
testflight)
  : "${ASC_KEY_PATH:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${IVRIT_TEAM_ID:?}"
  : "${IOS_CERT_ID:?}" "${IOS_DIST_P12_PATH:?}" "${IOS_DIST_P12_PASSWORD:?}"
  # The distribution certificate, in a keychain of this build's own.
  keychain="$out/signing.keychain-db"
  keychain_password=$(uuidgen)
  rm -f "$keychain"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$IOS_DIST_P12_PATH" -k "$keychain" -P "$IOS_DIST_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  # App Store profiles for the app and its extensions, fresh from the API.
  python3 -m venv "$out/venv"
  "$out/venv/bin/pip" install --quiet pyjwt cryptography
  IOS_SIGNING_ENV="$out/signing.env" "$out/venv/bin/python" scripts/ios-signing.py profiles
  # shellcheck disable=SC1091
  . "$out/signing.env"
  xcodebuild -project "$project" -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$out/App.xcarchive" \
    -derivedDataPath "$out/derived" \
    IVRIT_TEAM_ID="$IVRIT_TEAM_ID" IVRIT_SIGN_STYLE=Manual IVRIT_SIGN_IDENTITY="Apple Distribution" \
    IVRIT_APS_ENVIRONMENT=production OTHER_CODE_SIGN_FLAGS="--keychain $keychain" \
    IVRIT_PROFILE_APP="$IVRIT_PROFILE_APP" \
    IVRIT_PROFILE_NOTIFICATION_SERVICE="$IVRIT_PROFILE_NOTIFICATION_SERVICE" \
    IVRIT_PROFILE_SHARE_EXTENSION="$IVRIT_PROFILE_SHARE_EXTENSION" \
    MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" archive
  cat > "$out/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$IVRIT_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>ai.ivrit</key><string>$IVRIT_PROFILE_APP</string>
    <key>ai.ivrit.NotificationService</key><string>$IVRIT_PROFILE_NOTIFICATION_SERVICE</string>
    <key>ai.ivrit.ShareExtension</key><string>$IVRIT_PROFILE_SHARE_EXTENSION</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
  rm -rf "$out/export"
  xcodebuild -exportArchive -archivePath "$out/App.xcarchive" -exportOptionsPlist "$out/export.plist" -exportPath "$out/export"
  # altool finds the key as private_keys/AuthKey_<id>.p8.
  # altool exits 0 even when Apple rejects the build, so its answer is read.
  API_PRIVATE_KEYS_DIR=$(dirname "$ASC_KEY_PATH") xcrun altool --upload-app --type ios \
    --file "$out/export/App.ipa" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | tee "$out/upload.log"
  if grep -q "ERROR" "$out/upload.log" || ! grep -qi "no errors uploading\|upload succeeded" "$out/upload.log"; then
    echo "App Store Connect refused the upload (above)" >&2
    exit 1
  fi
  echo "uploaded ivrit.ai $version ($build) to App Store Connect: it reaches TestFlight once Apple has processed it"
  ;;
*)
  echo "unknown mode: $mode (simulator or testflight)" >&2
  exit 2
  ;;
esac
