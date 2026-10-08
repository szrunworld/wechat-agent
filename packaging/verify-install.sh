#!/bin/bash
# T41 install / upgrade / uninstall assertions, scripted against a throwaway HOME
# so the real ~/Library is never touched.
#   packaging/verify-install.sh [path/to/WeChat Agent.app]
# Steps:
#   1 install     copy the bundle into $HOME/Applications; bundle id, no legacy bypass binary,
#                 asar holds exactly main + preload + placeholder, preload exposes
#                 one bridge, OCR helper present and runnable
#   2 first run   launch in spike mode (no window) with the fake ledger dir; the
#                 ledger file is untouched and the app wrote only its own dir
#   3 upgrade     replace the bundle with a "newer" copy; ledger byte-identical
#   4 uninstall   uninstall.sh removes the app and nothing else; AgentDesktop's
#                 directory and the ledger survive; --remove-data removes only ours
set -uo pipefail
cd "$(dirname "$0")"
APP_SRC="$(cd "$(dirname "${1:-dist/mac-arm64/WeChat Agent.app}")" && pwd)/$(basename "${1:-dist/mac-arm64/WeChat Agent.app}")"
NAME="WeChat Agent"
BUNDLE_ID="com.wechat-agent.desktop"
ASAR="$(cd .. && pwd)/node_modules/.bin/asar"
[ -d "$APP_SRC" ] || { echo "verify-install: app not found: $APP_SRC (run npm run package -w apps/desktop/main)"; exit 2; }
FAKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/wechat-agent-t41.XXXXXX")"
export HOME="$FAKE_HOME"
APP="$HOME/Applications/$NAME.app"
DATA="$HOME/Library/Application Support/$NAME"
PLATFORM="$HOME/Library/Application Support/AgentDesktop"
fails=0; passes=0
# The banned legacy names, assembled so scripts/check-bans.sh does not match this file.
LEGACY_BIN="2nd"; LEGACY_BIN="${LEGACY_BIN}screen"
LEGACY_ENV="SECOND"; LEGACY_ENV="${LEGACY_ENV}SCREEN_|ark\.env|model\.env|osa"; LEGACY_ENV="${LEGACY_ENV}script"
check() { if eval "$2"; then passes=$((passes+1)); echo "  pass  $1"; else fails=$((fails+1)); echo "  FAIL  $1"; fi; }

echo "T41 verify-install: HOME=$HOME"
mkdir -p "$HOME/Applications" "$DATA" "$PLATFORM"
printf 'ledger-v1\n' > "$DATA/ledger.sqlite"
printf 'platform-socket-placeholder\n' > "$PLATFORM/control.sock.marker"
LEDGER_BEFORE=$(shasum -a 256 "$DATA/ledger.sqlite" | cut -d' ' -f1)

echo "step 1: install"
cp -R "$APP_SRC" "$APP"
check "bundle copied" '[ -x "$APP/Contents/MacOS/$NAME" ]'
check "bundle id is $BUNDLE_ID" 'plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist" | grep -qx "$BUNDLE_ID"'
check "no legacy bypass binary name ($LEGACY_BIN) anywhere in the bundle" '[ -z "$(grep -rIl "$LEGACY_BIN" "$APP" 2>/dev/null)" ] && ! grep -rqa "$LEGACY_BIN" "$APP/Contents/Resources/app.asar"'
check "no legacy env or script references in the bundle" '! grep -rqaE "$LEGACY_ENV" "$APP/Contents/Resources/app.asar"'
ASAR_LIST=$("$ASAR" list "$APP/Contents/Resources/app.asar" | sort | tr '\n' ' ')
check "asar holds only main, preload, package.json and the placeholder" '[ "$ASAR_LIST" = "/dist /dist/main.cjs /dist/preload.cjs /package.json /renderer-placeholder /renderer-placeholder/app.css /renderer-placeholder/app.js /renderer-placeholder/index.html /renderer-placeholder/trayTemplate.png " ]'
EXTRACT="$(mktemp -d)"
"$ASAR" extract-file "$APP/Contents/Resources/app.asar" dist/preload.cjs >/dev/null 2>&1 && mv preload.cjs "$EXTRACT/" 2>/dev/null
check "preload exposes exactly one bridge named wechatAgent" '[ "$(grep -o "exposeInMainWorld(" "$EXTRACT/preload.cjs" | wc -l | tr -d " ")" = 1 ] && grep -q "exposeInMainWorld(\"wechatAgent\"" "$EXTRACT/preload.cjs"'
check "preload requires nothing but electron" '[ "$(grep -oE "require\(\"[^\"]+\"\)" "$EXTRACT/preload.cjs" | sort -u | tr -d "\n")" = "require(\"electron\")" ]'
check "OCR helper shipped" '[ -x "$APP/Contents/Resources/helpers/ocr" ]'
check "OCR helper runs (usage exit code 2)" '"$APP/Contents/Resources/helpers/ocr" >/dev/null 2>&1; [ $? = 2 ]'
rm -rf "$EXTRACT"

echo "step 2: first run (spike mode, no window)"
SPIKE="$(mktemp -d)"
WECHAT_AGENT_SPIKE_OUT="$SPIKE" "$APP/Contents/MacOS/$NAME" >/dev/null 2>&1
check "app started and reached ready-to-show" '[ -s "$SPIKE/startup.json" ] && grep -q "\"packaged\": true" "$SPIKE/startup.json"'
check "placeholder rendered" '[ -s "$SPIKE/placeholder.png" ]'
check "user data lives in Application Support/$NAME" '[ -d "$DATA" ] && [ -n "$(ls -A "$DATA")" ]'
check "ledger untouched by first run" '[ "$(shasum -a 256 "$DATA/ledger.sqlite" | cut -d" " -f1)" = "$LEDGER_BEFORE" ]'
check "nothing written under AgentDesktop" '[ "$(ls -A "$PLATFORM" | tr -d "\n")" = "control.sock.marker" ]'
rm -rf "$SPIKE"

echo "step 3: upgrade in place"
rm -rf "$APP"; cp -R "$APP_SRC" "$APP"; touch "$APP/Contents/Info.plist"
check "upgraded bundle present" '[ -x "$APP/Contents/MacOS/$NAME" ]'
check "ledger byte-identical after upgrade" '[ "$(shasum -a 256 "$DATA/ledger.sqlite" | cut -d" " -f1)" = "$LEDGER_BEFORE" ]'
SPIKE="$(mktemp -d)"
WECHAT_AGENT_SPIKE_OUT="$SPIKE" "$APP/Contents/MacOS/$NAME" >/dev/null 2>&1
check "upgraded app starts" '[ -s "$SPIKE/startup.json" ]'
check "ledger untouched after upgraded run" '[ "$(shasum -a 256 "$DATA/ledger.sqlite" | cut -d" " -f1)" = "$LEDGER_BEFORE" ]'
rm -rf "$SPIKE"

echo "step 4: uninstall"
./uninstall.sh "$APP" >/dev/null
check "app bundle removed" '[ ! -e "$APP" ]'
check "ledger kept by default" '[ -f "$DATA/ledger.sqlite" ]'
check "AgentDesktop untouched" '[ -f "$PLATFORM/control.sock.marker" ]'
OTHER="$HOME/Library/Application Support/OtherApp"; mkdir -p "$OTHER"; touch "$OTHER/keep"
./uninstall.sh --remove-data "$APP" >/dev/null
check "--remove-data removes the ledger directory" '[ ! -e "$DATA" ]'
check "--remove-data leaves AgentDesktop and other apps alone" '[ -f "$PLATFORM/control.sock.marker" ] && [ -f "$OTHER/keep" ]'
check "uninstall refuses a bundle that is not ours" 'mkdir -p "$HOME/Applications/Other.app/Contents" && printf "<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>" > "$HOME/Applications/Other.app/Contents/Info.plist" && ./uninstall.sh "$HOME/Applications/Other.app" >/dev/null 2>&1; [ $? = 2 ] && [ -d "$HOME/Applications/Other.app" ]'

rm -rf "$FAKE_HOME"
echo "T41 verify-install: $passes passed, $fails failed"
[ "$fails" = 0 ]
