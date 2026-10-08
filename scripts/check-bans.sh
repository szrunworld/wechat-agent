#!/bin/bash
# The three global bans of docs/plan/00-parallel-work-plan.md §1, as a grep:
# no legacy input bypass (2ndscreen CLI, osascript, CGEvent, real-pointer drags),
# no legacy model config files. legacy/ and docs/ are exempt (reference only).
set -u
cd "$(dirname "$0")/.."
pattern='2ndscreen|osascript|CGEvent|CGWarpMouse|--foreground|drag --from|ark\.env|model\.env|SECONDSCREEN_'
# Code only: Markdown may describe the bans; legacy-* copies are reference.
hits=$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' \
  --include='*.json' --include='*.sh' --include='*.swift' --include='*.yml' --include='*.yaml' --include='*.plist' \
  "$pattern" packages apps tests fixtures packaging 2>/dev/null \
  | grep -v node_modules | grep -v '/legacy-' || true)
if [ -n "$hits" ]; then
  echo "banned reference(s) found (see docs/plan/00-parallel-work-plan.md §1):"
  echo "$hits"
  exit 1
fi
echo "bans: clean"
