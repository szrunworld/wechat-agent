#!/bin/bash
# Fails when a lane branch touches files outside its directories.
#   scripts/check-ownership.sh <lane-letter> [base-ref]
# Ownership comes from docs/lanes/ownership.json. Paths every lane may touch
# are listed under "shared" (its own lane doc only, through the pattern).
set -u
cd "$(dirname "$0")/.."
lane="${1:?lane letter, e.g. a}"
base="${2:-app-skeleton}"
allowed=$(node -e '
  const o = JSON.parse(require("fs").readFileSync("docs/lanes/ownership.json", "utf8"));
  const lane = process.argv[1];
  const list = [...(o.lanes[lane] ?? []), ...o.shared.map((p) => p.replace("{lane}", lane))];
  console.log(list.join("\n"));
' "$lane")
if [ -z "$allowed" ]; then echo "unknown lane: $lane"; exit 2; fi
bad=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  ok=0
  while IFS= read -r prefix; do
    [ -z "$prefix" ] && continue
    case "$file" in "$prefix"*) ok=1 ;; esac
  done <<< "$allowed"
  if [ "$ok" = 0 ]; then echo "outside lane $lane: $file"; bad=1; fi
done <<< "$(git diff --name-only "$base"...HEAD)"
[ "$bad" = 0 ] && echo "ownership: clean (lane $lane vs $base)"
exit $bad
