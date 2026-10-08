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


## 进度记录（lane-b，2026-10-08）

### 交付状态

| # | 项 | 状态 | 位置 |
| --- | --- | --- | --- |
| 1 | `openLedger(path, options?)`，better-sqlite3 12.x，WAL + `synchronous=FULL`，每次写 = 一个 `immediate` 事务，`busy_timeout` 5 s | 完成 | `packages/ledger/src/sqlite-ledger.ts`、`src/index.ts` |
| 2 | 迁移 `migrations/0001_init.sql`，`schema_version` 表，每条迁移独立事务；文件版本高于代码 → `LedgerUnavailableError('newer_schema: …')`；同版本名字不同 → `migration_mismatch`；列表不连续 → 拒绝 | 完成 | `migrations/`、`src/migrations.ts` |
| 3 | 11 张表；唯一索引 `tasks(operation_id)`、`attempts(task_id, step_id, attempt_ordinal)`、`attempts(request_id) WHERE NOT NULL`；额外 `quota_reservations(account_id, action_kind, intent_id) WHERE state <> 'released'` 保证同 intent 只有一条活动预留 | 完成 | `migrations/0001_init.sql` |
| 4 | `intake` 幂等 / 指纹冲突 | 完成，契约 + T05 | |
| 5 | `transitionTask` 用 `canTransition`，revision 不符抛 `revision`；状态与 `task_audit` 行同事务（`UPDATE … WHERE revision = ?` 二次校验） | 完成 | |
| 6 | 审批单次消费，过期用 `Date.parse` 比较 | 完成，契约 | |
| 7 | attempt 状态机按 `ATTEMPT_TRANSITIONS`；`requestId` 一经写入由唯一索引 + 状态机双重锁定；`findOpenAttempts` = dispatching / receipt_received；平台回执原文存 `attempts.receipt` | 完成 | |
| 8 | 额度：policy timezone 算 `policyDay`；`action_not_allowed` / `outside_hours` / `daily_limit` / `min_interval`；held / consumed 不会被 release 改回 | 完成，契约 + T40 | |
| 9 | 任一 SQLite 写错误（`SQLITE_*`）→ `writable=false`，之后所有写方法在进事务前就抛 `LedgerUnavailableError(reason)`；读继续可用；`diagnostics()` 返回版本 / 原因 / 最后错误 / quick_check / 大小 / 各表行数，并尽力导出 `<path>.diagnostics.json`（0600）。打开失败（非库文件、权限、更高版本）一律抛错，不建空库、不改原文件 | 完成，T38 | |
| 10 | `readLegacyState(path)` → `{entries, sourceHash, droppedFields}`；只取 `handled`，去重去空，`wechatPid`/`mode` 等全部丢弃并列在 `droppedFields`；缺文件 = 空，坏文件 = `LegacyStateError`（不静默成空导入） | 完成，T39 | `src/legacy.ts` |
| 11 | 库文件、`-wal`、`-shm`、诊断文件 0600；自建目录 0700（已存在的目录不改权限，避免误改用户目录） | 完成，有断言 | |

### 测试（`npm test -w packages/ledger`：36 passed / 0 failed）

- `test/contract.test.ts`：`packages/ports/test/ledger-contract.ts` 的 8 条契约用例跑在 SQLite 上 — passed。
- `test/ledger.test.ts`：T05 ×2、持久化回读、分页、policy、account、权限、T38 ×3、T39 ×3、T40 ×4、close 语义。
- `test/crash.test.ts`：崩溃边界 — (a) 提交前切断（`faultInjection.beforeCommit` 抛错回滚）覆盖 `TASK_TRANSITIONS` 全部 34 条边、`ATTEMPT_TRANSITIONS` 全部 6 条边，以及 intake / prepareAttempt / recordApproval / consumeApproval / reserveQuota / holdQuota / importLegacySuppressions / confirmAccount；每条都重开库断言状态、revision、audit 不变且随后可重做；(b) 子进程真 `SIGKILL`（`test/helpers/crash-child.ts`，`node --import tsx`）在 prepared / dispatching / receipt_received / 任务转换后各杀一次，重开库断言。
- `test/legacy.test.ts`：T39 旧文件转换与导入。

| 用例 | 状态 | 断言所在 |
| --- | --- | --- |
| T05 同 intent 一条任务 | passed | `ledger.test.ts` "T05: …" ×2（含两连接并发同 operationId） |
| T07 prepared 后崩溃不自动派发 | passed | `crash.test.ts` "T07: killed after prepareAttempt …"（真 SIGKILL 子进程；重开后 attempt 仍 prepared、无 requestId、`findOpenAttempts` 为空） |
| T38 注入写失败 → 停写 | passed | `ledger.test.ts` "T38: a real SQLITE_FULL …"（`max_page_count` 触发真实 `SQLITE_FULL`）、"T38: a file that is not a database …"、"T38: an unwritable file …" |
| T39 高版本库拒绝；旧 handled 只成 suppression | passed | `ledger.test.ts` "T39: …" ×3、`legacy.test.ts` ×2 |
| T40 跨日 / 并发预留 / unknown 不重复释放 | passed | `ledger.test.ts` "T40: …" ×4 |

以上全部是 Fake / 夹具级别的单元断言，不含真机。

### 跑过的命令

- `npm install better-sqlite3@^12 -w packages/ledger`、`npm install -D @types/better-sqlite3 -w packages/ledger`：预编译二进制安装成功（SQLite 3.53.2），未走 node:sqlite 回退。
- `npm run typecheck -w packages/ledger`、`npm test -w packages/ledger`：0 错误，36/36。
- 根 `npm run check`：bans clean，9 个 workspace typecheck 全过，全部测试通过，退出码 0。
- `scripts/check-ownership.sh b`：见 PR。

### 未完成 / 需要协调者处理

- **根 `package-lock.json`**：`npm install` 更新了它（better-sqlite3 及其依赖），但根文件归协调者，lane-b 分支**没有提交**它。合并时请在 `app-skeleton` 上跑一次 `npm install` 生成 lock（否则 `npm ci` 会报 lock 不同步）。
- better-sqlite3 是原生模块：lane G 打包进 Electron 时需要 `electron-rebuild`/prebuild 对应 ABI；如果 G 的 spike 结论是原生模块不可接受，可改成 Node 22 内置 `node:sqlite`（`DatabaseSync` API 与 better-sqlite3 几乎同构，`src/sqlite-ledger.ts` 里只有 `new Database()`、`pragma()`、`transaction().immediate()` 三处要换）。
- `SqliteLedger` 上有几个 `Ledger` 接口之外的方法（`listAudit`、`getApproval`、`getReceipt`、`getQuota`、`diagnostics`），其他 lane 通过 `Ledger` 类型拿不到；见下面的 INTERFACE REQUEST。

INTERFACE REQUEST: `Ledger.diagnostics()` 需要加入 port（返回 `{ schemaVersion, writable, reason?, lastError?, quickCheck?, rows? }`），原因：lane E 的 `diagnostics.export` 要把账本健康与最后一次写失败放进诊断包，现在只能把 `Ledger` 向下转型成 `SqliteLedger`。
INTERFACE REQUEST: `Ledger.getApproval(approvalId)` 需要加入 port，原因：lane D 在危险点击前"重新 observe 并校验审批版本"需要读审批而不消费它；lane F 任务详情页要显示审批是否已消费 / 过期。
INTERFACE REQUEST: `Ledger.getReceipt(attemptId)` 需要加入 port（或 `ActionAttempt` 加 `receipt?: Record<string, unknown>`），原因：`recordReceipt` 收的平台回执只能存不能读，lane E 的 Recovery / `task.reconcile` 无法把回执里的 delivery / verification 拿出来核实。
