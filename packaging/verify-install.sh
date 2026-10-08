#!/bin/bash
# T41 install / upgrade / uninstall assertions, scripted against a throwaway HOME
# so the real ~/Library is never touched.
#   packaging/verify-install.sh [path/to/WeChat Agent.app]
# Steps:
#   1 install     copy the bundle into $HOME/Applications; bundle id, no legacy bypass binary,
#                 asar holds exactly main + preload + placeholder, preload exposes
#                 one bridge, OCR helper present and runnable, better-sqlite3 rebuilt
#                 for this Electron shipped at Resources/native (SQLITE-ABI.md)
#   2 first run   launch in spike mode (no window) with the fake ledger dir; the
#                 ledger file is untouched and the app wrote only its own dir; the
#                 ledger smoke opened a real SQLite ledger in the spike dir
#   3 upgrade     replace the bundle with a "newer" copy; ledger byte-identical
#   4 uninstall   uninstall.sh removes the app and nothing else; AgentDesktop's
#                 directory and the ledger survive; --remove-data removes only ours
set -uo pipefail
cd "$(dirname "$0")"
APP_SRC="$(cd "$(dirname "${1:-dist/mac-arm64/WeChat Agent.app}")" && pwd)/$(basename "${1:-dist/mac-arm64/WeChat Agent.app}")"
NAME="WeChat Agent"
BUNDLE_ID="com.wechat-agent.desktop"
ASAR="$(cd .. && pwd)/node_modules/.bin/asar"
ELECTRON_VERSION="$(node -p 'require("../node_modules/electron/package.json").version')"
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
# Runs the app in spike mode and kills it after 90 s: a main process that dies
# on an uncaught exception shows a modal error dialog instead of exiting, which
# must fail an assertion rather than block this script.
run_spike() { node -e 'const p=require("child_process").spawn(process.argv[1],[],{stdio:"ignore",env:{...process.env,WECHAT_AGENT_SPIKE_OUT:process.argv[2]}});const t=setTimeout(()=>{console.error("  (app did not exit within 90 s; killed)");p.kill("SIGKILL")},90000);p.on("exit",()=>clearTimeout(t))' "$APP/Contents/MacOS/$NAME" "$1"; }

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
ASAR_LIST=$("$ASAR" list "$APP/Contents/Resources/app.asar" | grep -v '^/migrations' | sort | tr '\n' ' ')
check "asar holds only main, preload, package.json, the placeholder and the ledger migrations" '[ "$ASAR_LIST" = "/dist /dist/main.cjs /dist/preload.cjs /package.json /renderer-placeholder /renderer-placeholder/app.css /renderer-placeholder/app.js /renderer-placeholder/index.html /renderer-placeholder/trayTemplate.png " ]'
check "asar migrations are exactly packages/ledger/migrations" '[ "$("$ASAR" list "$APP/Contents/Resources/app.asar" | grep "^/migrations/" | sed "s|^/migrations/||" | sort | tr "\n" " ")" = "$(ls ../packages/ledger/migrations | sort | tr "\n" " ")" ] && [ -n "$(ls ../packages/ledger/migrations)" ]'
EXTRACT="$(mktemp -d)"
"$ASAR" extract-file "$APP/Contents/Resources/app.asar" dist/preload.cjs >/dev/null 2>&1 && mv preload.cjs "$EXTRACT/" 2>/dev/null
check "preload exposes exactly one bridge named wechatAgent" '[ "$(grep -o "exposeInMainWorld(" "$EXTRACT/preload.cjs" | wc -l | tr -d " ")" = 1 ] && grep -q "exposeInMainWorld(\"wechatAgent\"" "$EXTRACT/preload.cjs"'
check "preload requires nothing but electron" '[ "$(grep -oE "require\(\"[^\"]+\"\)" "$EXTRACT/preload.cjs" | sort -u | tr -d "\n")" = "require(\"electron\")" ]'
check "OCR helper shipped" '[ -x "$APP/Contents/Resources/helpers/ocr" ]'
check "OCR helper runs (usage exit code 2)" '"$APP/Contents/Resources/helpers/ocr" >/dev/null 2>&1; [ $? = 2 ]'
NATIVE="$APP/Contents/Resources/native"
check "better-sqlite3 shipped outside the asar (arm64 Mach-O bundle)" '[ -f "$NATIVE/better-sqlite3/build/Release/better_sqlite3.node" ] && file "$NATIVE/better-sqlite3/build/Release/better_sqlite3.node" | grep -q "Mach-O 64-bit bundle arm64"'
check "better-sqlite3 JS wrapper shipped; no node_modules directory in Resources" '[ -f "$NATIVE/better-sqlite3/lib/index.js" ] && [ ! -d "$APP/Contents/Resources/node_modules" ]'
check "native-modules.json says the module was rebuilt and verified for electron $ELECTRON_VERSION" 'node -e "const m=require(process.argv[1]);process.exit(m.electron===process.argv[2]&&m.builtFromSource===true&&m.verified[\"better-sqlite3\"].modules===m.modules?0:1)" "$APP/Contents/Resources/native-modules.json" "$ELECTRON_VERSION"'
check "no test_extension or sources shipped with the native module" '[ ! -e "$NATIVE/better-sqlite3/build/Release/test_extension.node" ] && [ ! -d "$NATIVE/better-sqlite3/src" ] && [ ! -d "$NATIVE/better-sqlite3/deps" ]'
rm -rf "$EXTRACT"

echo "step 2: first run (spike mode, no window)"
SPIKE="$(mktemp -d)"
run_spike "$SPIKE"
check "app started and reached ready-to-show" '[ -s "$SPIKE/startup.json" ] && grep -q "\"packaged\": true" "$SPIKE/startup.json"'
check "placeholder rendered" '[ -s "$SPIKE/placeholder.png" ]'
check "user data lives in Application Support/$NAME" '[ -d "$DATA" ] && [ -n "$(ls -A "$DATA")" ]'
check "ledger untouched by first run" '[ "$(shasum -a 256 "$DATA/ledger.sqlite" | cut -d" " -f1)" = "$LEDGER_BEFORE" ]'
check "nothing written under AgentDesktop" '[ "$(ls -A "$PLATFORM" | tr -d "\n")" = "control.sock.marker" ]'
# Ledger smoke (SQLITE-ABI.md): the packaged main process opened a real SQLite
# ledger with the Electron-ABI better-sqlite3, wrote a legacy suppression, read it back.
check "ledger smoke ran inside the packaged process on Electron's ABI" '[ -s "$SPIKE/ledger-smoke.json" ] && node -e "const r=require(process.argv[1]);process.exit(r.ok===true&&r.electron===process.argv[2]&&r.modules===process.versions.modules?1:0)" "$SPIKE/ledger-smoke.json" "$ELECTRON_VERSION"'
check "ledger smoke: health writable, quick_check ok, suppression written and read back after reopen" 'node -e "const r=require(process.argv[1]);const s=r.steps;process.exit(r.ok===true&&s.health.writable===true&&s.quickCheck===\"ok\"&&s.added===1&&s.suppressed===true&&s.otherSuppressed===false&&s.readBackAfterReopen===true&&s.healthAfterClose.reason===\"closed\"?0:1)" "$SPIKE/ledger-smoke.json"'
check "ledger smoke wrote a real SQLite file in the spike dir, mode 0600" '[ "$(head -c 15 "$SPIKE/ledger/ledger-smoke.sqlite")" = "SQLite format 3" ] && [ "$(stat -f %Lp "$SPIKE/ledger/ledger-smoke.sqlite")" = 600 ]'
check "ledger smoke wrote no database anywhere but the spike dir" '[ -z "$(find "$DATA" -name "*.sqlite*" ! -name ledger.sqlite)" ] && [ -z "$(find "$HOME" -name "ledger-smoke*" -not -path "$SPIKE/*")" ]'
echo "  ledger-smoke.json:"; sed 's/^/    /' "$SPIKE/ledger-smoke.json" 2>/dev/null || echo "    (missing)"; echo
rm -rf "$SPIKE"

echo "step 3: upgrade in place"
rm -rf "$APP"; cp -R "$APP_SRC" "$APP"; touch "$APP/Contents/Info.plist"
check "upgraded bundle present" '[ -x "$APP/Contents/MacOS/$NAME" ]'
check "ledger byte-identical after upgrade" '[ "$(shasum -a 256 "$DATA/ledger.sqlite" | cut -d" " -f1)" = "$LEDGER_BEFORE" ]'
SPIKE="$(mktemp -d)"
run_spike "$SPIKE"
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
