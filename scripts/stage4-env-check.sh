#!/bin/bash
# Stage 4 read-only environment check (docs/acceptance/stage4-readonly-plan.md §2).
# Reads only: the contract snapshot, whether runtime.sock exists, runtime.handshake /
# runtime.capabilities / runtime.status through packages/driver, and `ps` for the
# WeChat process. No window.bind, no session, no observe, no act, no input of any kind.
#   scripts/stage4-env-check.sh [--json]
#   WECHAT_AGENT_ENDPOINT=/path/to/runtime.sock overrides the default endpoint (a side instance's socket).
# Exit 0 = ready, 1 = not ready (reasons printed), 2 = usage / internal error.
set -u
cd "$(dirname "$0")/.."
if [ ! -x node_modules/.bin/tsx ]; then
  echo "node_modules/.bin/tsx missing: run npm install first" >&2
  exit 2
fi
exec node_modules/.bin/tsx tests/integration/src/env-check.ts "$@"
