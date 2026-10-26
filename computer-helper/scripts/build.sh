#!/usr/bin/env bash
# Builds the computer helper as a signed menu-bar .app in computer-helper/build/.
#
#   ./scripts/build.sh            release build, signed with the Apple Development identity
#   SIGN_IDENTITY=- ./scripts/build.sh   ad-hoc signature (permission grants won't survive rebuilds)
#
# The display name comes from packages/brand/brand.json. The bundle id and signing identity stay
# fixed, so macOS keeps the Accessibility and Screen Recording grants across rebuilds.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
bundle_id="org.privateaistack.computer-helper"
identity="${SIGN_IDENTITY:-Apple Development: yusefnathanson@me.com (N9HKM55LWY)}"

brand_name="$(/usr/bin/plutil -extract name raw -o - "$repo/packages/brand/brand.json" 2>/dev/null || true)"
if [[ -z "$brand_name" ]] && command -v jq >/dev/null; then
  brand_name="$(jq -r '.name // empty' "$repo/packages/brand/brand.json")"
fi
display_name="${brand_name:+$brand_name }Computer"
app="$here/build/$display_name.app"

cd "$here"
nice -n 15 swift build -c release --product ComputerHelper
bin="$(swift build -c release --show-bin-path)/ComputerHelper"

rm -rf "$here/build"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/ComputerHelper"

version="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo dev)"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>$display_name</string>
  <key>CFBundleDisplayName</key><string>$display_name</string>
  <key>CFBundleExecutable</key><string>ComputerHelper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSAccessibilityUsageDescription</key>
  <string>Lets chat read the window you are in and click and type for you when you ask it to.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Lets chat see your screen when you ask it to use this computer.</string>
</dict>
</plist>
PLIST

# One name can match several valid certificates (a renewed one); sign with the one that expires last.
sign_with="$identity"
if [[ "$identity" != "-" ]]; then
  valid="$(security find-identity -v -p codesigning | grep -F "\"$identity\"" | awk '{print $2}' || true)"
  sign_with=""
  best=0
  while read -r hash; do
    [[ -z "$hash" ]] && continue
    end="$(security find-certificate -a -c "$identity" -Z -p | awk -v want="$hash" '
      /SHA-1 hash/ { keep = ($3 == want) } keep { print } /END CERT/ { keep = 0 }' |
      openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    secs="$(date -j -f "%b %e %T %Y %Z" "$end" +%s 2>/dev/null || echo 0)"
    if (( secs >= best )); then best=$secs; sign_with=$hash; fi
  done <<< "$valid"
  if [[ -z "$sign_with" ]]; then
    echo "warning: signing identity \"$identity\" not found; signing ad-hoc." >&2
    echo "warning: macOS will ask for permissions again after every rebuild." >&2
    sign_with="-"
  fi
fi
codesign --force --options runtime --timestamp=none --sign "$sign_with" "$app"
codesign --verify --strict "$app"
echo "Built $app"
