#!/bin/sh
# Builds the iPhone app, on a Mac or in CI (.github/workflows/ios.yml): the Xcode
# project from shell/ios/App/project.yml (XcodeGen), Capacitor's files, then
#
#   scripts/build-ios.sh simulator    a build for the simulator, unsigned: does it compile
#   scripts/build-ios.sh testflight   a signed archive, uploaded to App Store Connect
#
# testflight signs with an App Store Connect API key (App Manager), so no
# certificates live anywhere: ASC_KEY_PATH (the .p8 file), ASC_KEY_ID,
# ASC_ISSUER_ID, and IVRIT_TEAM_ID (the Apple Developer team).
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
  auth="-allowProvisioningUpdates -authenticationKeyPath $ASC_KEY_PATH -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"
  # shellcheck disable=SC2086
  xcodebuild -project "$project" -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$out/App.xcarchive" \
    -derivedDataPath "$out/derived" $auth \
    IVRIT_TEAM_ID="$IVRIT_TEAM_ID" MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" archive
  cat > "$out/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$IVRIT_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
  # shellcheck disable=SC2086
  xcodebuild -exportArchive -archivePath "$out/App.xcarchive" -exportOptionsPlist "$out/export.plist" \
    -exportPath "$out/export" $auth
  echo "uploaded ivrit.ai $version ($build) to App Store Connect: it reaches TestFlight once Apple has processed it"
  ;;
*)
  echo "unknown mode: $mode (simulator or testflight)" >&2
  exit 2
  ;;
esac
