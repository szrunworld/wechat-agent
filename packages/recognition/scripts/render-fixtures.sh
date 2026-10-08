#!/bin/bash
# Rebuilds the synthetic fixtures: scenes (node) -> PNG (Swift/AppKit renderer).
# Nothing here captures a screen; it only draws made-up text on a canvas.
set -eu
cd "$(dirname "$0")/../../.."
node fixtures/wechat/scenes.mjs
swiftc -O fixtures/wechat/render/render.swift -o fixtures/wechat/render/render
for scene in fixtures/wechat/scenes/*.json; do
  name=$(basename "$scene" .json)
  fixtures/wechat/render/render "$scene" "fixtures/wechat/$name.png"
done
ls -la fixtures/wechat/*.png
