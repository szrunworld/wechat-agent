# 目录所有权

机器可读版本是 `ownership.json`；CI 在 `lane-*` 分支的 PR 上跑 `scripts/check-ownership.sh`，越界即红。

| Lane | 可写目录 | 只读参考 |
| --- | --- | --- |
| a Driver | `packages/driver/` | `contracts/agentdesktop-runtime-v1/`、`packages/ports/` |
| b Ledger | `packages/ledger/` | `packages/ports/`、`legacy/src/store.ts` |
| c Recognition | `packages/recognition/`、`fixtures/wechat/` | `packages/ports/`、`legacy/src/parse.ts`、`legacy/ocr/` |
| d Handlers | `packages/handlers/` | `packages/ports/`、`legacy/src/friends.ts`（只学需求，不抄旁路） |
| e App core | `packages/app/` | `packages/ports/` |
| f UI | `apps/desktop/renderer/` | `packages/ports/src/ipc.ts`、`packages/ports/src/fakes/snapshots.ts` |
| g Shell & packaging | `apps/desktop/main/`、`packaging/` | `packages/ports/src/ipc.ts` |
| h Integration & acceptance | `tests/integration/`、`docs/acceptance/` | 全部 |
| 协调者 | `packages/ports/`、根配置、`scripts/`、`.github/`、`contracts/`、`docs/plan/`、`docs/lanes/` | — |

每条 lane 另可改自己的 `docs/lanes/lane-<x>.md`（记录进度与 INTERFACE REQUEST）。
