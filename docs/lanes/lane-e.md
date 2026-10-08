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

