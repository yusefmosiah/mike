#!/bin/bash
# Build the app and run the AppUITests XCUITest target on a simulator, then
# export the screenshots the tests attach (README.md, "UI test").
#
#   scripts/ui-test-ios.sh <screenshots-dir> [page-url]
#
# page-url is what the app loads in place of server.url (default
# http://127.0.0.1:8766/). Serve the page yourself first. The URL is written
# into the BUILT app's capacitor.config.json, between build and test; nothing
# in the source tree changes. Environment: SIMULATOR (name or UDID, default
# "iPhone 17"), WORK (derived data and results, default $TMPDIR/mike-ui-test).
# Needs the iOS project (npm run ios:add, or ios:configure after cap add ios).
set -euo pipefail

out="${1:?usage: ui-test-ios.sh <screenshots-dir> [page-url]}"
url="${2:-http://127.0.0.1:8766/}"
sim="${SIMULATOR:-iPhone 17}"
work="${WORK:-${TMPDIR:-/tmp}/mike-ui-test}"
here="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

# Resolve the simulator to a UDID and boot it if needed (name or UDID).
udid="$(xcrun simctl list devices available -j | node -e '
  const want = process.argv[1];
  const all = Object.values(JSON.parse(require("fs").readFileSync(0, "utf8")).devices).flat();
  const hit = all.find((d) => d.udid === want) ?? all.find((d) => d.name === want);
  if (!hit) { console.error("no simulator " + want); process.exit(1); }
  console.log(hit.udid);' "$sim")"
xcrun simctl bootstatus "$udid" -b >/dev/null

rm -rf "$work/results.xcresult" "$out"
mkdir -p "$work" "$out"
# Idempotent; also refreshes AppUITests.swift. Keep this project's
# app-switcher preview setting, which configure-ios.mjs takes from the env.
plist="$here/ios/App/App/Info.plist"
if [ -z "${MIKE_APP_SWITCHER_PREVIEW:-}" ] && /usr/libexec/PlistBuddy -c "Print :MikeAppSwitcherPreview" "$plist" 2>/dev/null | grep -q true; then
  export MIKE_APP_SWITCHER_PREVIEW=1
fi
node "$here/scripts/configure-ios.mjs"
cd "$here/ios/App"

# A foreign compiler toolchain in the environment breaks xcodebuild (README).
clean=(env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin DEVELOPER_DIR="$DEVELOPER_DIR")
common=(-project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator
  -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$work/derived")

"${clean[@]}" xcodebuild "${common[@]}" build-for-testing

app="$work/derived/Build/Products/Debug-iphonesimulator/App.app"
node -e '
  const fs = require("fs");
  const [file, url] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.server = { ...config.server, url, allowNavigation: [new URL(url).hostname] };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));' "$app/capacitor.config.json" "$url"
codesign --force --sign - "$app" >/dev/null 2>&1 || true

status=0
"${clean[@]}" xcodebuild "${common[@]}" -resultBundlePath "$work/results.xcresult" \
  test-without-building || status=$?

# Export every attachment, then keep just the screenshots the tests named.
raw="$work/attachments"; rm -rf "$raw"; mkdir -p "$raw"
xcrun xcresulttool export attachments --path "$work/results.xcresult" --output-path "$raw" || true
node -e '
  const fs = require("fs");
  const [raw, out] = process.argv.slice(1);
  for (const test of JSON.parse(fs.readFileSync(`${raw}/manifest.json`, "utf8")))
    for (const a of test.attachments ?? []) {
      const name = (a.suggestedHumanReadableName ?? "").replace(/_\d+_[0-9A-F-]{36}(\.\w+)$/, "$1");
      if (!/^(top|end)-\d-.*\.png$/.test(name)) continue;
      fs.copyFileSync(`${raw}/${a.exportedFileName}`, `${out}/${name}`);
    }' "$raw" "$out"
echo "screenshots: $out"
ls "$out"
exit $status
