#!/bin/bash
# Cold-ish startup timing of the packaged app without showing a window:
# runs the bundle in spike mode N times and reports ready-to-show times.
#   packaging/measure-startup.sh [path/to/WeChat Agent.app] [runs]
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-dist/mac-arm64/WeChat Agent.app}"
RUNS="${2:-3}"
BIN="$APP/Contents/MacOS/WeChat Agent"
[ -x "$BIN" ] || { echo "measure: no executable at $BIN"; exit 2; }
OUT="$(pwd)/dist/spike"
rm -rf "$OUT"; mkdir -p "$OUT"
USERDATA="$(mktemp -d)/WeChat Agent"
# A throwaway Unix socket server stands in for the AgentDesktop control socket:
# answers "ping" with "pong". Kept under /tmp on purpose: sun_path is at most
# 104 bytes on macOS and $TMPDIR/Library/Application Support/... exceeds it
# (listen fails with EADDRINUSE, connect with EINVAL). The real endpoint,
# ~/Library/Application Support/AgentDesktop/control.sock, is well under.
SOCKDIR="$(mktemp -d /tmp/wa-spike.XXXXXX)/AgentDesktop"; mkdir -p "$SOCKDIR"
SOCK="$SOCKDIR/control.sock"
node -e 'const net=require("net");const s=net.createServer(c=>c.on("data",d=>{if(d.toString().trim()==="ping")c.write("pong\n")}));s.listen(process.argv[1]);process.on("SIGTERM",()=>{s.close();process.exit(0)})' "$SOCK" &
SOCK_PID=$!
sleep 0.5
for i in $(seq 1 "$RUNS"); do
  WECHAT_AGENT_SPIKE_OUT="$OUT/run$i" WECHAT_AGENT_USER_DATA="$USERDATA" WECHAT_AGENT_SPIKE_SOCKET="$SOCK" "$BIN" >/dev/null 2>&1 || true
  node -e 'const s=require(process.argv[1]);console.log(`measure: run ${process.argv[2]} readyToShow=${s.readyToShowMs} ms loaded=${s.loadedMs} ms socket=${JSON.stringify(s.socket)} helper=${JSON.stringify(s.helper)} (electron ${s.electron}, packaged=${s.packaged})`)' "$OUT/run$i/startup.json" "$i"
done
kill $SOCK_PID 2>/dev/null || true
rm -rf "$(dirname "$SOCKDIR")"
cp "$OUT/run1/placeholder.png" "$OUT/placeholder.png"
rm -rf "$(dirname "$USERDATA")"
echo "measure: screenshots and timings in $OUT"
