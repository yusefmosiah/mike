#!/bin/bash
# Build the Mac app: the iOS app built with Mac Catalyst (docs/mac-app.md).
#
#   scripts/build-mac.sh [Debug|Release] [extra xcodebuild settings...]
#
# Needs the iOS project (npm run ios:add) and the Catalyst dependencies
# (npm run mac:deps). Signs ad hoc ("Sign to Run Locally"), so it runs on this
# Mac only and the owner's signing settings in the project are untouched; a
# release is signed with the firm's Developer ID instead (docs/mac-app.md).
# The app lands in ios/App/build-mac/Build/Products/<Configuration>-maccatalyst/App.app.
# xcodebuild runs in a clean environment: a dev shell's LD, CC or SDKROOT
# would otherwise become build settings (README.md).
set -euo pipefail

configuration="${1:-Debug}"
shift || true
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$here/ios/App/MacCatalyst/pins.json" ]; then
  echo "No Mac Catalyst dependencies: run npm run mac:deps first" >&2
  exit 1
fi
cd "$here/ios/App"
exec env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin ${DEVELOPER_DIR:+DEVELOPER_DIR="$DEVELOPER_DIR"} \
  xcodebuild -project App.xcodeproj -scheme App -configuration "$configuration" \
  -destination 'platform=macOS,variant=Mac Catalyst' -derivedDataPath build-mac \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  "$@" build
