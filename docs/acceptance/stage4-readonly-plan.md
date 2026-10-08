# 阶段 4 · 真机只读验收执行计划（A01–A04）

依据 `docs/plan/00-parallel-work-plan.md` §5（阶段 4 = 真机只读基线，协调者在授权测试账号上做）、`docs/acceptance/README.md`（字段模板、别名、证据格式）、`steps/A01–A04.md`、ADR v2.2 §三（Delegated Run 的断连语义）。本文只是**执行计划与证据模板**；执行前所有 case 的 `result` 保持 `not_run`，本文不改任何 case。

Mock 演练（同一条路径在 Fake Runtime 上先跑一遍）：`tests/integration/test/rehearsal.test.ts`；断连语义审查：`driver-disconnect-review.md` + `tests/integration/test/driver-disconnect.test.ts`；环境检查：`scripts/stage4-env-check.sh`。

## 0. 前提

| 前提 | 来源 | 未满足时 |
| --- | --- | --- |
| 授权测试账号（`testAccountAlias`）与授权测试联系人（`targetAlias`）由 Kevin 提供，授权证据按 README 归档为 `authorizationEvidenceId` | Kevin | 全部步骤记 `blocked`，不执行 |
| AgentDesktop 发行分支在跑，`~/Library/Application Support/AgentDesktop/control.sock` 存在（冻结端点，不做回退探测） | `scripts/stage4-env-check.sh` | 不开始；端点若在发行分支上仍是 `runtime.sock`，先由协调者确认发行分支，不在 App 里加探测 |
| 契约快照 `contracts/agentdesktop-runtime-v1/SHA256SUMS` 与平台发行分支契约一致 | env-check 校验本地快照；与发行分支比对由协调者手工 `shasum -a 256` | 记 A01 失败原因，不开始 |
| 微信 for Mac 已由**人**登录测试账号、停在主界面；本 App 不启动、不移动、不点击它 | `ps` 看进程 | 不开始 |
| 识别 profile 适用：微信 4.1 · 1280×875 · 2x · 深色（lane C profile 1）；其他组合在 A05 另记 | `support-matrix.md` | `unreadable` → 记 blocked(layout_unreadable) |
| App 构建：`git rev-parse --short HEAD`（`appCommit`）；`npm run check` 退出码 0 | 本仓库 | 不开始 |

### 身份：受控开发模式（开发例外，不是正式认证方式）

CR01（paired principal / grants / 撤销）未落地。阶段 4 用**本机 owner 身份**连接 `control.sock`：握手回包里 `principal` 缺席或 `role=owner`，App 的连接状态是 `unpaired`，`pairing` 步骤显示 `blocked`，所有外发功能（接受/加好友/发消息）`enabled=false, reason=pairing_missing`，只有 `read_list` 可用。这是**开发例外**：

- 只允许协调者本人、本机、授权测试账号使用；不写入任何 App 配置、不出现在发行文档；
- 不是 CR01 的配对身份，不能作为 A03（配对权限）的证据；A03 在 CR01 落地前整体 `blocked`；
- 验收记录里 `platformCommit` 必须写发行分支 commit，`actualResult` 注明"owner 受控开发模式"。

## 1. 执行顺序与每步要确认的事

每步顺序：**前截图 → 执行 → 后截图 → 抄证据 → 写 Pass/Fail**。时间戳一律带时区（`+08:00`）。所有截图只记 sha256，文件放本地证据目录 `evidence/<caseId>/`。

### S0 · 环境检查（A01 的前置）

```
scripts/stage4-env-check.sh            # 人读
scripts/stage4-env-check.sh --json > <本地证据目录>/stage4/env-check-<时间>.json
```

只读：校验契约快照 sha256、`control.sock` 是否存在且是 socket、`runtime.handshake / runtime.capabilities / runtime.status`（打印 product、productVersion、apiVersion(s)、instanceId、principal、方法集合、相对 App 需要的 18 个方法的缺失、权限、`inputAdmission`）、`ps` 看微信主进程。不调 `window.*`、`session.*`、`run.*`、`observe`、`act`。输出 `READY` / `NOT READY` + 原因；AgentDesktop 没在跑时报告 `runtime_offline`，不是崩溃。退出码 0 = ready，1 = not ready。

要确认：契约三个文件 sha256 全部 `ok`；`product=AgentDesktop`，`apiVersions ∋ agentdesktop.runtime/1`；`missing: (none)`；`screenRecording=granted accessibility=granted`；`inputAdmission=enabled`；微信 `running`。`principal.role=owner` 会打 warning（受控开发模式），不阻断只读。

### S1 · 连接 AgentDesktop（A01 / A02 第 4 条）

启动 App（或测试壳），看 W01 连接页与 `app.getSnapshot`：

| 要确认 | 来源 | 通过 |
| --- | --- | --- |
| 握手 | `connection.product / apiVersion`，`steps.discover=done`（detail 为端点路径） | product `AgentDesktop`，apiVersion `agentdesktop.runtime/1` |
| 协议版本 | `steps.contract=done`，`missingCapabilities=[]` | 18 个核心方法齐全（`CORE_METHODS` + handlers 声明的 `observe/act/artifact.read`） |
| 能力清单 | `runtime.capabilities` 原样 JSON（env-check `--json` 的 `runtime.methods`）存档 | 与 `methods.json` 的 33 个 implemented 方法一致，记差异 |
| principal | `connection.principal`，`steps.pairing` | `role=owner`（或缺席）→ `pairing=blocked`，`features.accept_request.reason=pairing_missing`；这是预期 |
| 事件订阅 | 平台侧连接数 = 2（控制 + 订阅），`runtime.status.connections` | 订阅是独立连接、独立握手 |
| 零输入 | 平台 Run 列表 / `runtime.status.runs` | 连接阶段 `run.start=0`、`act=0` |

### S2 · 识别微信窗口（A02 / A04 前置）

App 在连接后自动 `desktop.list → window.list → window.bind`（过滤 `bundleId=com.tencent.xinWeChat`，取第一个在屏窗口）。

| 要确认 | 来源 | 通过 |
| --- | --- | --- |
| 过滤依据是 bundleId，不是标题 | `steps.window.detail`（`WeChat #<windowId>`）、平台 `window.bind` 请求参数 | pid/windowId 与 `window.list` 里 bundleId 匹配的那条一致 |
| 绑定前后微信窗口没动 | 前后截图（人工看位置/尺寸） | 一致；`unexpectedInputCount=0` |
| 多窗口/无窗口 | 若 `window.list` 返回多个微信窗口或零个 | 零个 → `steps.window=failed`，记 blocked；多个 → 记录选中的 windowId，后续 A05 再定 |

### S3 · 读取会话列表（只读观察）

本阶段**只有 ReadRequests 一个 App 驱动的读流程**（S4）。会话列表与聊天内容走"观察-识别"路线，不经任何 handler、不产生任何 `act`：

1. 人把微信停在主界面（会话列表可见）。
2. 触发一次只读观察：W01 的账号确认采集（`setupAccount` 对绑定桌面做一次 `session.open → observe(screenshot) → session.close`，无 Run、无 act），得到 `AppSnapshot.account.evidenceIds[0]`；用 `evidence.read {redacted:false}` 读回截图字节（只用于本次验收，归档前打码）。
3. 用 lane C 的 `createRecognizer().recognize()` 对该截图跑识别（离线、本机），记录 `facts.page`（应为 `chats`）、`facts.chats.length`、`coverage`、`warnings`、`confidence`。
4. 与人工截图比对：行数、顺序、未读标记；`coverage` 不是 `end_confirmed` 时不写"全部"。

缺口（记录，不在本阶段补）：App 没有"只观察不动作"的 IPC；步骤 2 借用账号确认的证据采集。若需要多次观察，另写只读探针（observe → recognize → 打印），列为阶段 4 后续项。

### S4 · 读取测试联系人内容（A04 主体：ReadRequests + 聊天内容观察）

**4a · 新的朋友列表（A04 第 1–4 条）**

1. W01 `account.confirm`（记 `accountId / revision`；人核对 `visibleLabel` 是测试账号）。
2. 跑一次 `read_requests`（`task.create {type:'read_requests'}`，或打开 `baselineOnConnect`）。lane D 的流程：observe → 若不在"新的朋友"则点 `通讯录` / `新的朋友`（**仅导航点击**）→ observe → `list_read` fact。
3. 比对 `list_read.data.rows` 与人工截图：行数、每行 `status`、`coverage`。
4. 故意让列表超过一屏：`coverage` 必须 `partial`，任务 `confirmed(coverage_partial)`；零行页：`current_viewport`（`complete=false`），不是"全部处理完"；只有识别到末尾标记才 `end_confirmed`。

| 要确认 | 来源 |
| --- | --- |
| 只发生导航点击 | 账本 `listAttempts(taskId)` 的 `stepId` 全是 `navigate:*`；平台 `run.events` 的 `action.receipt` 数 = 导航次数；`kind=click` |
| Run 生命周期 | `run.start` params 为 `{}`（无 lifetime/ownership/origin）；结束时 `run.finish`，`closingReason=finished`，`outcome=success` |
| 证据链 | `list_read.evidenceIds[0]` → `Evidence.artifactId/sha256` = 平台 `artifact.show` 的 sha256 = 本地截图 `shasum -a 256` |

**4b · 测试联系人聊天内容（观察-识别）**

1. 人打开测试联系人（`targetAlias`）的单聊窗口；App **不**打开它。
2. 同 S3 做一次只读观察，`recognize` 得 `facts.page=chat`、`conversation.title`、`bubbles[]`（side/text/anchorKey）、`inputBox.empty`。
3. 与人工截图比对气泡条数与顺序；`inputBox.empty` 应为 true（本阶段没有任何草稿）。
4. 不运行 `reply_draft` / `send_message`（前者会把草稿写进输入框，已经是状态改变）。

## 2. 异常步骤：必须正确停止

每条异常都先在 Fake Runtime 上演练过（`rehearsal.test.ts` 的 "stop condition" 用例）；真机上各做一次，顺序放在 S4 之后。预期行为来自 lane A/D/E 的实现与 ADR v2.2 §三。

| 异常 | 真机做法 | 预期（任务 / 写门 / 平台） | 证据 |
| --- | --- | --- | --- |
| 断连（控制连接丢失） | ReadRequests 进行中退出 AgentDesktop 或 `kill -STOP` 其进程 | 在途请求 `connection_lost`（notSent=false）；任务 `blocked(disconnected)`（若在 executing 则 `stopping`，等静止）；写门 `closed`；Driver `disconnected`，**不自动重连**（App 按退避重连，只重建观察）；平台侧该 Run `ended / closingReason=connection_closed`；重连后 `run.start` 次数不增、无 `run.attach`、无 `run.cancel` | 快照 `connection.state / inputGate / steps.discover.detail`；平台 `run.show`；前后截图 |
| 超时（请求无应答） | 用平台的注入/暂停能力（若有），否则 `kill -STOP` 平台进程 ≥ requestTimeoutMs 再 `-CONT` | `deadline_exceeded`（transport）；App 视为失联：任务 `blocked(disconnected)`，写门关；App 主动关闭陈旧连接（平台 Run 随之 `connection_closed`）；重连成功、无重放 | 同上；`driver-disconnect-review.md` §4 的修复 |
| 窗口变化 | 审批前后（或 observe 之间）人把微信重新打开/换窗口，使 `observation.target.windowId/generation` 变化 | 只读流程（ReadRequests）**不以窗口为锚**，会继续读新窗口——记录为已知限制；写流程在危险点击前 `requireSameWindow` → `approval_invalid`，从 executing 落到 `waiting_user`，`act` 不增 | 前后截图、`task.show.stateReason`、账本 attempts |
| 不可读画面 | 改缩放/主题或遮挡 | `blocked(layout_unreadable)`，无 act，无 `list_read` | `warnings` |
| 人工干预 | 任务进行中人敲一个键 | 写门关闭并保留现场（A05 第 4 条，本阶段只记录现象） | `unexpectedInputCount` |

## 3. 每步必须留下的证据

沿用 `cases/T*.md` 的字段模板（README "记录字段"），每步一份记录，写进对应 case（T02/T42 → A01，T01/T02/T41 → A02，T11/T14/T15 → A04）的 `## 实际结果`，`result` 只在该步真机完成后由协调者改：

```
caseId / requirementId / result: passed | failed | blocked | not_run
appCommit / platformCommit / contractSha256 / versions / testedAt
testAccountAlias / targetAlias / authorizationEvidenceId
operationId → taskId → attemptId → requestId → platformRunId → receiptId
beforeEvidenceHash / afterEvidenceHash / businessFactId
cancelAcceptedAt / quiescenceConfirmedAt / unexpectedInputCount
coverage / actualResult / defectId / operator / reviewer
```

每步四类证据，缺一则该步 `failed`：

| 证据 | 怎么取 | 写到 |
| --- | --- | --- |
| 截图 artifact | `observe` 的 `image.artifactId` + `artifact.show.sha256`；本地 `shasum -a 256` 必须相等 | `beforeEvidenceHash / afterEvidenceHash`（本地前后截图），`actualResult` 里写 `artifactId=… sha256=…` |
| Runtime 事件 | `run.events {runId}` 原样 JSON（或订阅帧）存本地证据目录 `stage4/run-events-<runId>.json` | `platformRunId`；`receiptId` 取 `action.receipt` 事件 |
| Ledger 记录 | `task.show`（`platform.*`、`facts[]`）、`diagnostics.export`（脱敏）；attempts 用账本导出 | `operationId → … → receiptId`、`businessFactId`（`list_read` 的 factId）、`coverage` |
| 结论 | 明确 `Pass / Fail / Blocked` 与一句话原因；没有执行过的步骤不写 | `result`、`actualResult`、`defectId` |

命名：截图 `<caseId>-<before|after>-<yyyymmddTHHMMSS+0800>.png`；所有非测试身份本地打码后再归档；仓库只保存 sha256。

## 4. 明文禁止

- **任何发送**：不发消息、不发申请、不接受申请、不传文件、不写草稿到输入框；`reply_draft / send_message / add_friend / accept_request` 在本阶段不创建任务（它们在 owner 身份下也会被 `pairing_missing` 阻断，但这是双保险，不是依赖）。
- **不点击任何"确定 / 接受 / 发送 / 通过验证 / 完成"**；允许的 act 只有 lane D 导航到"新的朋友"的 `click`（`stepId=navigate:*`），且必须出现在 `run.events` 里可核对。
- 不启动、不移动、不前台化、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针；缺能力就记 `blocked`。
- 不预写 `passed`；Fake 级演练通过不等于真机通过。
- 不把 owner 受控开发模式写成"已配对"；A03 整体 `blocked` 直到 CR01。

## 5. 结果表（执行后填）

| 步骤 | 执行日期 | appCommit | platformCommit | operator | reviewer | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| S0 env-check | | | | | | not_run |
| S1 连接 (A01) | | | | | | not_run |
| S2 窗口 (A02) | | | | | | not_run |
| S3 会话列表 | | | | | | not_run |
| S4a 新的朋友 (A04) | | | | | | not_run |
| S4b 聊天内容 | | | | | | not_run |
| 断连 | | | | | | not_run |
| 超时 | | | | | | not_run |
| 窗口变化 | | | | | | not_run |

## 6. 已知缺口（阶段 4 执行前要知道）

- App 没有"只观察不动作"的 IPC；S3/S4b 借用账号确认的证据采集或另写只读探针。
- `AppSnapshot.patrol.coverage` 只跟随巡检/基线任务，UI 创建的 read 任务要看 `list_read` fact。
- ReadRequests 不以窗口为锚（窗口变化不停止只读流程）；真正的窗口守卫是平台的绑定 generation（`stale_observation / target_moved`），A05 再验。
- Fake Runtime 断连时默认立刻 `quiescence=confirmed`；真机上可能先 `pending`，App 的处理已在 `driver-disconnect.test.ts`（`quiescenceOnDrop: 'pending'`）演练。
