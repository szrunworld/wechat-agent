# Lane B · Ledger（方案 E04）

可写：`packages/ledger/`。消费：`Ledger` 接口（`packages/ports/src/ledger.ts`）与领域类型；行为参考 `packages/ports/src/fakes/ledger.ts`（内存实现是行为基准，SQLite 实现必须通过同一组契约测试）。

## 交付

1. `openLedger(path): Promise<Ledger>`，SQLite（建议 `better-sqlite3`，同步 API 包成 async），WAL，单 writer，`busy_timeout`。
2. 迁移：`migrations/0001_init.sql …`，`schema_version` 表；每条迁移独立事务，不可原地改写；库版本高于代码支持 → 抛 `LedgerUnavailableError('newer_schema')`（T39 降级拒绝）。
3. 表：tasks、task_audit、approvals、attempts、quota_reservations、facts、evidence、outbox、account、policy、legacy_suppression。唯一索引：`operationId`、`(taskId, stepId, attemptOrdinal)`、`attempts.requestId`。
4. `intake`：同 operationId 同 fingerprint 返回原任务；不同 fingerprint 抛 `LedgerConflictError('operation_fingerprint')`。
5. `transitionTask` 用 `canTransition` 校验，expectedRevision 不符抛 `LedgerConflictError('revision')`；状态变更与 audit 行同事务。
6. 审批单次消费；过期、revision 或 hash 不符都抛 `LedgerConflictError('approval')`。
7. attempt：`markDispatching` 写 requestId 后不可改；`findOpenAttempts` 返回 dispatching/receipt_received。
8. 额度：按 policy 的 timezone 算 policyDay；`maxDaily`、`minIntervalSeconds`、`activeHours` 任一不满足返回 `{ok:false, reason}`；`holdQuota` 保留占用。
9. 损坏/磁盘满：任何写失败后 `health()` 返回 `writable=false`，之后所有写方法抛 `LedgerUnavailableError`；**不能**在打开失败时建空库继续。
10. 旧数据导入 `importLegacySuppressions`：只写 legacy_suppression（key、sourceHash、migratedAt）；提供 `readLegacyState(path)` 把 `legacy/src/store.ts` 格式（`{handled: string[], wechatPid}`）转成 entries，丢弃 wechatPid。
11. 文件 0600、目录 0700。

## 完成条件

- 契约测试：把 `packages/ports/test/ledger-contract.ts` 的用例在 SQLite 实现上全部跑过（协调者提供的共享断言函数；若缺少，复制内存实现的测试作为起点）。
- T05（同 intent 一条任务）、T07（prepared 后崩溃：重开库，attempt 仍为 prepared，不自动派发）、T38（注入写失败 → 停写，health 不可写）、T39（高版本库拒绝；旧 handled 只成 suppression）、T40（跨日/并发预留/unknown 不重复释放）有执行过的断言。
- 崩溃边界测试：每个状态转换前杀掉写（用事务回滚模拟）后再打开库，数据一致。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。

