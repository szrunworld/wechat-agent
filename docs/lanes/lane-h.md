# Lane H · Integration & acceptance（方案 E07 + §12/§13）

可写：`tests/integration/`、`docs/acceptance/`。消费：全部 port 与 fakes；lane A 的 Fake Runtime（在它合并前先用 `@wechat-agent/ports/fakes` 的 FakeDriver 占位，接口相同）。

## 交付

1. `tests/integration/` 包：竖切测试骨架 `vertical-slice.test.ts`：task.create → approve → dispatch → receipt → fact → stop，用真 Ledger（lane B 合并前用内存 Fake）、Fake Driver、Fake Recognizer、Fake handlers（本 lane 写最小 handler 桩，只走接口）。合并后逐个替换为真实现，测试不改。
2. 故障注入矩阵 `faults.test.ts`：断连（派发前/后/结果写库前）、超时、`idempotency_conflict`、`events_cursor_expired`、request.show not_found、账号变化、审批过期——每项对应 T 编号。
3. ADR-01～10 回归用例文件（Delegated 正常执行、Hub 关页不影响、控制失联停止、重连不恢复、Durable 提升拒绝、Explorer 关页继续、重载保留 Run、停止待静止、全局停止两类 Run、Runtime 崩溃不盲重做）：本仓库只断言消费方行为，平台侧标 `platform_owned`。
4. `docs/acceptance/cases/T01.md … T42.md`：每条一个记录文件，字段按方案 §13 模板（caseId、requirementId、result 默认 `not_run`、appCommit、platformCommit、contractSha256、versions、testedAt、testAccountAlias、targetAlias、authorizationEvidenceId、operationId→taskId→attemptId→requestId→platformRunId→receiptId、before/afterEvidenceHash、businessFactId、cancelAcceptedAt、quiescenceConfirmedAt、unexpectedInputCount、coverage、actualResult、defectId、operator、reviewer）。
5. `docs/acceptance/steps/A01.md … A12.md`：验收步骤与通过条件（方案 §13）。
6. `docs/acceptance/support-matrix.md`：微信版本 × 缩放 × 主题 × 窗口尺寸，初始全部 `not_tested`。
7. `scripts` 内不可写，所以 lint 放 `tests/integration/lint-acceptance.test.ts`：解析 cases/*.md，`result: passed` 的文件必须有非空 testedAt/appCommit/operator，否则测试失败。
8. 测试账号/目标别名约定与授权证据格式写入 `docs/acceptance/README.md`；真机步骤只由协调者执行，本 lane 不碰真实微信。

## 完成条件

- 竖切测试在 CI 上绿（全 Fake）。
- 42 个 case 文件 + 12 个 step 文件齐全，lint 通过。
- 故障矩阵每项至少一个执行过的断言（用 FakeDriver 的注入能力）。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。

