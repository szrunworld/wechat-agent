#!/bin/bash
# Removes WeChat Agent and only WeChat Agent.
#   packaging/uninstall.sh [--remove-data] [path/to/WeChat Agent.app]
# Default: the app bundle, its caches, saved state and preferences. The ledger
# directory (~/Library/Application Support/WeChat Agent) stays unless
# --remove-data is given. Nothing under AgentDesktop or any other app is touched.
set -euo pipefail
REMOVE_DATA=0
APP=""
for arg in "$@"; do
  case "$arg" in
    --remove-data) REMOVE_DATA=1 ;;
    *) APP="$arg" ;;
  esac
done
BUNDLE_ID="com.wechat-agent.desktop"
NAME="WeChat Agent"
[ -n "$APP" ] || { for c in "$HOME/Applications/$NAME.app" "/Applications/$NAME.app"; do [ -d "$c" ] && APP="$c" && break; done; }
if [ -n "$APP" ] && [ -d "$APP" ]; then
  # Refuse anything that is not our bundle.
  if ! grep -q "$BUNDLE_ID" "$APP/Contents/Info.plist" 2>/dev/null; then echo "uninstall: $APP is not $BUNDLE_ID; not touching it"; exit 2; fi
  pkill -f "$APP/Contents/MacOS/$NAME" 2>/dev/null || true
  rm -rf "$APP"; echo "uninstall: removed $APP"
else
  echo "uninstall: no app bundle found (already removed?)"
fi
for p in "$HOME/Library/Caches/$BUNDLE_ID" "$HOME/Library/Caches/$BUNDLE_ID.ShipIt" "$HOME/Library/Saved Application State/$BUNDLE_ID.savedState" "$HOME/Library/Preferences/$BUNDLE_ID.plist" "$HOME/Library/Logs/$NAME"; do
  [ -e "$p" ] && rm -rf "$p" && echo "uninstall: removed $p"
done
DATA="$HOME/Library/Application Support/$NAME"
if [ "$REMOVE_DATA" = 1 ]; then
  [ -d "$DATA" ] && rm -rf "$DATA" && echo "uninstall: removed $DATA (ledger and evidence)"
else
  [ -d "$DATA" ] && echo "uninstall: kept $DATA (ledger and evidence; pass --remove-data to delete)"
fi
echo "uninstall: AgentDesktop and other apps untouched"
