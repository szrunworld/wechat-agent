#!/bin/bash
# Notarizes and staples the signed app or dmg with notarytool.
#   packaging/notarize.sh [path/to/WeChat Agent.app | .dmg]
# Needs a keychain profile (xcrun notarytool store-credentials) named by
# NOTARY_KEYCHAIN_PROFILE, or NOTARY_APPLE_ID + NOTARY_TEAM_ID + NOTARY_PASSWORD.
# Without credentials, or on an unsigned artifact, it explains the skip and exits 0.
set -euo pipefail
cd "$(dirname "$0")"
TARGET="${1:-dist/mac-arm64/WeChat Agent.app}"
[ -e "$TARGET" ] || { echo "notarize: not found: $TARGET"; exit 2; }
if ! codesign --verify --strict "$TARGET" >/dev/null 2>&1 || codesign -dv "$TARGET" 2>&1 | grep -q 'Signature=adhoc'; then
  echo "notarize: SKIPPED — $TARGET is not Developer-ID signed (run packaging/sign.sh with a certificate first)."
  exit 0
fi
AUTH=()
if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then AUTH=(--keychain-profile "$NOTARY_KEYCHAIN_PROFILE");
elif [ -n "${NOTARY_APPLE_ID:-}" ] && [ -n "${NOTARY_TEAM_ID:-}" ] && [ -n "${NOTARY_PASSWORD:-}" ]; then AUTH=(--apple-id "$NOTARY_APPLE_ID" --team-id "$NOTARY_TEAM_ID" --password "$NOTARY_PASSWORD");
else
  echo "notarize: SKIPPED — no notarytool credentials (NOTARY_KEYCHAIN_PROFILE or NOTARY_APPLE_ID/NOTARY_TEAM_ID/NOTARY_PASSWORD)."
  exit 0
fi
SUBMIT="$TARGET"
CLEANUP=""
if [ -d "$TARGET" ]; then
  SUBMIT="$(mktemp -d)/$(basename "$TARGET" .app).zip"
  ditto -c -k --keepParent "$TARGET" "$SUBMIT"
  CLEANUP="$SUBMIT"
fi
xcrun notarytool submit "$SUBMIT" "${AUTH[@]}" --wait
xcrun stapler staple "$TARGET"
[ -n "$CLEANUP" ] && rm -rf "$(dirname "$CLEANUP")"
echo "notarize: stapled $TARGET"
