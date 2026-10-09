#!/bin/sh
# WeChat Agent A4 pairing acceptance against an AgentDesktop TEST COPY.
#
# Never the product endpoint, never real WeChat: the app asks to pair, the person
# answers in AgentDesktop's trusted window with their own Touch ID; nothing here
# clicks, authenticates, reads WeChat, binds a window or sends input.
# The test copy keeps everything under /tmp/adt-wxpair (removed afterwards); the
# app's credential is a 0600 file there, never the login keychain.
#
#   APP="$HOME/orca/agentdesktop/build/Agent Desktop.app" scripts/pairing-acceptance.sh probe
#   APP=... scripts/pairing-acceptance.sh approve   # 批准 + Touch ID, then 批准 + Touch ID again (self-revocation)
#   APP=... scripts/pairing-acceptance.sh deny      # 拒绝
#
# APP must be a bundle built from agentdesktop main (bb02b59 or later). Evidence
# goes to $OUT (default ./pairing-acceptance-out); the token is never written.
set -u
ROUND="${1:-}"
case "$ROUND" in probe|approve|deny) ;; *) echo "usage: APP=<Agent Desktop.app> $0 probe|approve|deny"; exit 2 ;; esac
[ -n "${APP:-}" ] && [ -x "$APP/Contents/MacOS/Agent Desktop" ] || { echo "APP must point at an Agent Desktop.app built from agentdesktop main"; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR=/tmp/adt-wxpair
EP="$DIR/side.runtime.sock"
OUT="${OUT:-$PWD/pairing-acceptance-out}"
TSX="$ROOT/node_modules/.bin/tsx"
RUN="$ROOT/tests/integration/src/pairing-acceptance.ts"
fails=0

cleanup() {
    [ -n "${HOST:-}" ] && kill "$HOST" 2>/dev/null && wait "$HOST" 2>/dev/null
    rm -rf "$DIR"
}
trap cleanup EXIT INT TERM

rm -rf "$DIR"; mkdir -p "$DIR" "$OUT"; chmod 700 "$DIR"
echo "== AgentDesktop test copy: $(sed -n 's/.*"source": "\([0-9a-f]*\)".*/\1/p' "$APP/Contents/Resources/build.json" | head -1)"
AGENTDESKTOP_SOCKET="$DIR/side.sock" "$APP/Contents/MacOS/Agent Desktop" > "$DIR/host.log" 2>&1 &
HOST=$!
i=0; while [ ! -S "$EP" ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
[ -S "$EP" ] || { echo "the test copy did not start (see $DIR/host.log)"; exit 1; }
echo "   listening at $EP"

export WECHAT_AGENT_ENDPOINT="$EP" WECHAT_AGENT_CREDENTIAL="$DIR/wechat-agent/credential.json"
step() { # mode label
    echo "== $2"
    "$TSX" "$RUN" "$1" --out "$OUT/$ROUND-$1-$(date +%H%M%S).json" || fails=$((fails + 1))
}

case "$ROUND" in
    probe)
        step probe "unpaired wire against the real Runtime (no person needed)" ;;
    approve)
        step probe "unpaired wire"
        step pair "pairing: compare the code, press 批准…, then Touch ID"
        step check "paired: reconnect with the stored credential"
        step revoke-self "self-revocation: press 批准…, then Touch ID"
        step check "after revocation: expect revoked, credential dropped, no reconnect" ;;
    deny)
        step pair "pairing: press 拒绝" ;;
esac

echo "== audit (A4 decisions of this test copy)"
sqlite3 -readonly "$DIR/side.runtime/hub.sqlite" \
    "SELECT at, client_id, method, decision, reason FROM auth_events WHERE method LIKE 'hub.%' OR decision IN ('approved','revoked','cut') ORDER BY rowid" 2>/dev/null | tail -20
cp "$DIR/host.log" "$OUT/$ROUND-host.log" 2>/dev/null
echo "evidence: $OUT   failed steps: $fails"
[ $fails -eq 0 ]
