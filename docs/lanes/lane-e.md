# Lane E · App core（方案 E02 + E03）

可写：`packages/app/`。消费：全部 port；实现 `ApplicationService`（`packages/ports/src/ipc.ts`）；测试用 fakes。

## 交付

1. `createApplication(deps): Application`，deps = { driver, ledger, recognizer, handlers, clock, config }；暴露 `service: ApplicationService`、`start()`、`stop()`。单实例（锁文件）。
2. `RuntimeConnector`：控制连接长存；事件订阅独立连接；断连 → 立即关写门 → 原 Run 置 stopping 等待 → 指数退避只做观察类重连；重连后旧 Run 不恢复，新任务重新 preflight。
3. `ConnectionCheck` + `SetupSteps`：discover → contract（product/apiVersion/方法集合）→ pairing（principal.role 必须是 paired；owner 也标 `pairing_missing`，CR01 前真实外发 blocked）→ window（选择并绑定微信窗口：window.list 过滤 bundleId `com.tencent.xinWeChat`，bind）→ account（人工确认，`account.confirm`）→ baseline（一次只读 ReadRequests）。失败定位到具体 step。
4. `FeatureGate`：按 capabilities.methods、principal、policy、inputGate 计算 `features`；每个 handler 的 `requires` 不满足 → disabled 且 reason 可解释。
5. `Dispatcher`：UI 与巡检统一入队；单账号写串行；`task.create` 走 ledger.intake（同 operationId 幂等）；状态机驱动 handler；取消域：running 时取消 → stopping → driver.cancelRun → waitRun → 静止确认后 cancelled/needs_reconciliation。
6. `PolicyGate`：白名单、动作白名单、时段、额度（ledger.reserveQuota）、账号 revision、审批有效期；任一不满足 → blocked 带 reasonCode。
7. `ApprovalFlow`：handler 的 `requestApproval` → 任务进 waiting_approval → 等 `task.approve`（校验 approvalRevision/contentHash）→ 写 BusinessApproval → 继续；等待期间释放 run（finishRun cancelled）并在批准后重新 openSession/startRun。
8. `InputGate`：`app.pause` → 关门、取消所属 Run、等静止；显示 stopping → 静止确认 closed；平台断连时 `quiescence_unconfirmed`；`app.resume` 不重放旧 Run 或 unknown。
9. `Recovery`：启动时 `ledger.findOpenAttempts` → `driver.showRequest(requestId)` → 结果 completed/failed/unknown/not_found 分别写 fact；not_found/过期 → needs_reconciliation，**绝不**判 not_sent。
10. `Patrol`：按 policy.patrolIntervalSeconds 入队 ReadRequests；页面不可见/写门关闭时跳过；发现 pending 且未被 suppress 的 rowKey → 创建 accept_request 任务（waiting_approval），跳过只抑制本次。
11. `AppSnapshot` 投影 + `subscribe` 推送；`diagnostics.export` 默认脱敏（手机号/昵称打码，不含正文/截图/凭证）。

## 完成条件

- T01（平台不可达 → 连接页，Driver act 调用 0）、T03（未配对 → 外发 blocked，act=0）、T05（UI 与巡检同 intent → 一条任务一次外发）、T10（账号 revision 变化 → 写门关、旧审批失效）、T28、T30（模型关闭仍可手写草稿）、T31（审批/模型晚到 → 取消后 act=0）、T32（cancel accepted 未静止 → stopping，无后续任务）、T33（ended + unknown 共存）、T34（断连阻断输入、旧 Run 不恢复）有执行过的断言。
- "同意图唯一执行、暂停无晚到动作、重连旧 Run 不恢复"三条各有专门测试。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。


## 进度记录（2026-10-08，协调者代为收尾）

lane E 的后台 agent 在会话重启时中断，代码已完成：`packages/app/src/`（application、connector、dispatcher、features、gate、patrol、policy、recovery、tasks、diagnostics、lock、config、support）与 4 个测试文件，24 个用例通过；协调者按真实退出码复核 typecheck / test / bans / ownership 后提交。

| 用例 | 状态 | 测试 |
| --- | --- | --- |
| T01 | passed（Fake） | connection.test.ts |
| T03 | passed（Fake） | connection.test.ts |
| T34 + 重连旧 Run 不恢复 | passed（Fake） | connection.test.ts |
| T05 同意图唯一执行 | passed（Fake） | dispatch.test.ts |
| T10 | passed（Fake） | dispatch.test.ts |
| T28a/b | passed（Fake） | dispatch.test.ts |
| T30 | passed（Fake） | dispatch.test.ts |
| T31 暂停无晚到动作 | passed（Fake） | dispatch.test.ts |
| T32 | passed（Fake） | stop.test.ts |
| T33 | passed（Fake） | stop.test.ts |
| 已取消任务的在途 handler 不能在 resume 后过写门 | passed（Fake） | stop.test.ts |

未完成：agent 的最终报告缺失，INTERFACE REQUEST 以代码里的用法为准（协调者审查时未发现接口之外的调用）。

## 进度记录（2026-10-08，Outbox，分支 `task-outbox`）

Kevin 的要求："在进入真实外发阶段之前，必须补齐 Outbox 的持久化、幂等、发送结果确认及异常恢复测试，否则容易出现断连或重试后的重复发送。"

- `packages/app/src/outbox.ts`：`OutboxWriter`（终态转换与关键业务事实落账时入队，`payloadHash = sha256(canonicalJson(payload))`，`revision` = 任务 revision，同 `(taskId, revision, payloadHash)` 不重复）、`OutboxDeliverer`（串行、按 eventId 幂等、指数退避、重启从 `pendingOutbox` 恢复、结果写 `reconciliation` fact `data.kind='outbox_delivery'`、不持有 driver）、`FileSink`（JSONL，`<dataDir>/outbox.jsonl`，按 eventId 去重）、`MemorySink`（可注入失败/超时/异常/重复）。
- `Dispatcher.transition` 终态走 `OutboxWriter.finalize`；`finish` 与 handler 的 `appendFact` 对 `friend_added / friend_request_sent / message_sent / draft_written` 另发一条 `fact` 事件。
- SQLite（lane B，经协调者允许）：迁移 `0003_outbox_delivery.sql`（attempts/last_error/receipt/enqueued_at/settled_at、唯一索引），`transitionTaskWithOutbox`（转换 + 事件同一事务）、`deferOutbox`、`settleOutbox`、`listOutbox`；App 以结构探测使用，fake 走两次写的回退。
- 测试：`packages/app/test/outbox.test.ts`（fakes，12 条）、`tests/integration/test/outbox.test.ts`（fake + 真 SQLite 各 6 条 + SQLite 原子性 + 两条 SIGKILL 子进程 + 两条真栈端到端）。

INTERFACE REQUEST（给协调者，现以 SQLite 扩展方法绕过）：
- `Ledger.transitionTask(..., outbox?: (task) => OutboxDraft)` 或独立 `transitionTaskWithOutbox`：终态与事件同一事务，fake 也应实现。
- `Ledger.deferOutbox(eventId, retryAt, error)`：可重试失败保持 pending 并持久化 `retryAt/attempts/lastError`；现有 `markOutbox('failed', retryAt)` 会让事件脱离 `pendingOutbox`，无法用于重试。
- `Ledger.settleOutbox(eventId, 'delivered'|'failed', { receipt?, error? }, now)` 与 `Ledger.listOutbox(taskId)`；`OutboxEvent` 增加 `attempts / lastError / receipt`。
- `enqueueOutbox` 的契约应写明对 `(taskId, revision, payloadHash)` 幂等（SQLite 已如此，fake 未改）。
