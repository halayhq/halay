#!/bin/sh
# Builds the halay Mac app: macos/build/halay.app, a universal (arm64 + x86_64) menu-bar app, ad-hoc signed.
# Needs macOS with the Xcode command line tools (swiftc, lipo, codesign, sips, iconutil); no Xcode project.
#
#   macos/build.sh              build macos/build/halay.app
#   macos/build.sh --prepack    what `npm pack` / `npm publish` run (package.json prepack): the same build, so the tarball carries a
#                               fresh app; HALAY_SKIP_MAC_APP=1 skips it (publishing from somewhere that is not a Mac: the package then
#                               has no app and `halay app` says so)
#   macos/build.sh --selftest   build a separate test binary (macos/build/halay-selftest) with the checks in SelfTest.swift
#
# Not notarized, on purpose: files npm installs are not quarantined, so Gatekeeper never looks at an ad-hoc signed
# app that came this way (an arm64 binary still needs *a* signature to run, which `codesign -s -` gives it).
set -eu
cd "$(dirname "$0")"

if [ "${1:-}" = --prepack ] && [ "${HALAY_SKIP_MAC_APP:-}" = 1 ]; then echo "build.sh: HALAY_SKIP_MAC_APP=1, packing without the Mac app"; exit 0; fi
[ "$(uname)" = Darwin ] || { echo "build.sh: the Mac app can only be built on macOS" >&2; exit 1; }
for tool in swiftc lipo codesign sips iconutil node; do
  command -v "$tool" >/dev/null || { echo "build.sh: $tool not found (install the Xcode command line tools: xcode-select --install)" >&2; exit 1; }
done

OUT=build
APP=$OUT/halay.app
MIN=13.0
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('../package.json','utf8')).version")
SELFTEST=0; [ "${1:-}" = --selftest ] && SELFTEST=1

if [ $SELFTEST = 1 ]; then
  SRC="Sources/*.swift SelfTest/*.swift"; FLAGS="-D SELFTEST"; ARCHS=$(uname -m)
else
  SRC="Sources/*.swift"; FLAGS=""; ARCHS="arm64 x86_64"
  rm -rf "$APP"
fi
mkdir -p "$OUT"

# One slice per architecture, then lipo. -swift-version 5: the sources don't use the Swift 6 strict concurrency checks.
for arch in $ARCHS; do
  # shellcheck disable=SC2086
  swiftc -O -swift-version 5 $FLAGS -target "$arch-apple-macos$MIN" -o "$OUT/halay-$arch" $SRC
done

if [ $SELFTEST = 1 ]; then
  APP=$OUT/halay-selftest.app
  rm -rf "$APP"
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# shellcheck disable=SC2086
lipo -create -output "$APP/Contents/MacOS/halay" $(for a in $ARCHS; do echo "$OUT/halay-$a"; done)
rm -f $(for a in $ARCHS; do echo "$OUT/halay-$a"; done)
sed "s/__VERSION__/$VERSION/g" Info.plist > "$APP/Contents/Info.plist"
[ $SELFTEST = 1 ] && /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.halay.mac.selftest" "$APP/Contents/Info.plist"

# icon: the web app's 512 px icon -> halay.icns
ICONS=$OUT/halay.iconset
rm -rf "$ICONS"; mkdir -p "$ICONS"
for s in 16 32 128 256 512; do
  sips -z $s $s ../public/icon-512.png --out "$ICONS/icon_${s}x${s}.png" >/dev/null
  [ $s -le 256 ] && sips -z $((s * 2)) $((s * 2)) ../public/icon-512.png --out "$ICONS/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONS" -o "$APP/Contents/Resources/halay.icns"
rm -rf "$ICONS"

# ad-hoc signature ("-"): no developer account, no notarization
chmod 755 "$APP/Contents/MacOS/halay"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"
echo "built $APP ($(lipo -archs "$APP/Contents/MacOS/halay"), $VERSION, ad-hoc signed)"
