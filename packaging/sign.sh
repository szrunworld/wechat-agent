#!/bin/bash
# Developer ID signing for the packaged app (hardened runtime), helpers first.
#   packaging/sign.sh [path/to/WeChat Agent.app]
# Without a "Developer ID Application" identity in the keychain the script
# explains the skip and exits 0, so packaging on a machine without the
# certificate still produces an (unsigned) .app for local spikes.
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-dist/mac-arm64/WeChat Agent.app}"
[ -d "$APP" ] || { echo "sign: app not found: $APP (run npm run package -w apps/desktop/main first)"; exit 2; }
IDENTITY="${CODESIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"' || true)}"
if [ -z "$IDENTITY" ]; then
  echo "sign: SKIPPED — no 'Developer ID Application' identity in the keychain."
  echo "      The .app stays as electron-builder left it (unsigned or ad-hoc). Gatekeeper"
  echo "      will refuse it on other Macs; it runs here via right-click → Open or from the"
  echo "      terminal. Set CODESIGN_IDENTITY or import the certificate, then rerun."
  exit 0
fi
ENT="$(pwd)/entitlements.mac.plist"
ENT_INHERIT="$(pwd)/entitlements.mac.inherit.plist"
echo "sign: identity = $IDENTITY"
# 1. Helpers we ship ourselves (OCR). Plain hardened runtime, no entitlements needed.
if [ -d "$APP/Contents/Resources/helpers" ]; then
  for helper in "$APP"/Contents/Resources/helpers/*; do
    [ -f "$helper" ] || continue
    codesign --force --options runtime --timestamp --sign "$IDENTITY" --identifier "com.wechat-agent.desktop.helper.$(basename "$helper")" "$helper"
    echo "sign: helper $(basename "$helper")"
  done
fi
# 2. Electron frameworks and helper apps (inner to outer).
find "$APP/Contents/Frameworks" -depth \( -name '*.framework' -o -name '*.app' -o -name '*.dylib' \) | while read -r item; do
  case "$item" in
    *.app) codesign --force --options runtime --timestamp --entitlements "$ENT_INHERIT" --sign "$IDENTITY" "$item" ;;
    *)     codesign --force --options runtime --timestamp --sign "$IDENTITY" "$item" ;;
  esac
done
# 3. The app itself.
codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "sign: done; notarize with packaging/notarize.sh"
