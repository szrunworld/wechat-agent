# 验收记录（lane H）

方案 §12 测试矩阵与 §13 验收步骤的记录目录。**所有记录初始为 `not_run`；只有执行过断言或真机步骤才能改。** 真机步骤只由协调者在授权测试账号上执行，lane 不碰真实微信。

## 目录

| 路径 | 内容 |
| --- | --- |
| `cases/T01.md … T42.md` | 每条测试用例一个记录文件：front matter 是方案 §13 的全部字段，正文是条件/操作/预期/归属/关联测试 |
| `steps/A01.md … A12.md` | 验收步骤：执行与记录、通过条件、证据、关联用例 |
| `support-matrix.md` | 微信版本 × 缩放 × 主题 × 窗口尺寸的支持矩阵，初始全部 `not_tested` |
| `../../tests/integration/test/lint-acceptance.test.ts` | 记录 lint（`npm test -w tests/integration`） |

## 记录字段（方案 §13，每项必填，不得预写 pass）

```
caseId / requirementId / result: passed | failed | blocked | not_run
appCommit / platformCommit / contractSha256 / versions / testedAt
testAccountAlias / targetAlias / authorizationEvidenceId
operationId → taskId → attemptId → requestId → platformRunId → receiptId
beforeEvidenceHash / afterEvidenceHash / businessFactId
cancelAcceptedAt / quiescenceConfirmedAt / unexpectedInputCount
coverage / actualResult / defectId / operator / reviewer
```

front matter 是扁平的 `key: value`（空值写 `""`）。lint 规则：

- 42 个文件齐全，字段齐全，`result` 只能是四个值之一；
- `result: passed` 的文件必须有非空 `testedAt`（可解析的时间戳）、`appCommit`、`operator`，否则测试失败；
- `result: not_run` 的文件不得带 `testedAt / actualResult`；
- `unexpectedInputCount` 是整数。

### 字段来源

| 字段 | 从哪里抄 |
| --- | --- |
| `appCommit` | 被测 App 的 git commit（`git rev-parse --short HEAD`） |
| `platformCommit` | AgentDesktop 发行分支 commit |
| `contractSha256` | `contracts/agentdesktop-runtime-v1/SHA256SUMS` 中 `methods.json` 的值 |
| `versions` | 一行：`app=<x> platform=<y> wechat=<z> macos=<w> scale=<1x|2x> theme=<dark|light>` |
| `operationId … receiptId` | `task.show` 的 `platform` 与 `facts[].data`、账本导出；不手填 |
| `beforeEvidenceHash / afterEvidenceHash` | 前后截图的 sha256（`shasum -a 256`） |
| `businessFactId` | 得出结论的那条 `DomainFact.factId`（如 `friend_added`） |
| `cancelAcceptedAt / quiescenceConfirmedAt` | `run.cancel` 回执时间与 `run.wait` 返回 `quiescence: confirmed` 的时间，带时区 |
| `coverage` | 识别结果的 `coverage`：`current_viewport / partial / end_confirmed / unreadable` |

## Fake 级与真机级

方案 §8 的风险：lane 的全部通过记录都是 Fake / 夹具级别。集成骨架（`tests/integration`）里有执行过断言的 T 编号，在 case 正文"关联集成测试"列出；这**不**改变 `result`。`result: passed` 只在真机步骤完成后由协调者填写，并且要与对应 A 步骤的结果表一致。

## 测试账号与目标别名

记录里不写真实昵称、微信号、手机号，只写别名：

| 别名 | 含义 | 举例 |
| --- | --- | --- |
| `testAccountAlias` | 登录微信的授权测试账号 | `acct-test-a`、`acct-test-b` |
| `targetAlias` | 授权测试目标（发申请/收消息的一方） | `tgt-01`、`tgt-filehelper`（文件传输助手） |
| `authorizationEvidenceId` | 授权证据编号 | `auth-20261009-01` |

别名 → 真实身份的对照表只保存在协调者本地证据目录（见下），不进仓库。

## 授权证据格式

每个 `authorizationEvidenceId` 对应本地证据目录下一个文件夹：

```
<本地证据目录>/auth/auth-20261009-01/
  README.md        # 谁授权、授权范围（账号 / 目标 / 允许的动作 / 有效期）、方式（书面/聊天记录）
  consent.*        # 授权原件（截图或文档）
  SHA256SUMS       # 以上文件的 sha256
```

- 授权范围必须覆盖本次用到的账号别名与目标别名；超出范围的用例记 `blocked`，不执行。
- 本地证据目录默认 `~/Library/Application Support/WeChatAgent/acceptance-evidence/`，不在仓库内；仓库只保存 sha256。

## 截图证据

- 每步至少一张前后截图；文件名 `<caseId>-<before|after>-<yyyymmddTHHMMSS+0800>.png`，放本地证据目录 `evidence/<caseId>/`。
- 记录只写 sha256；诊断导出（`diagnostics.export`）默认脱敏，不含正文/截图/凭证。
- 截图里出现的任何非测试身份都要在本地打码后再归档。

## 执行顺序

见 `docs/plan/00-parallel-work-plan.md` §5：集成竖切绿（阶段 3）→ 只读基线 A01–A04 + A05（阶段 4）→ 逐功能开放 A06–A10（阶段 5）→ A11 → A12 签收。

## Fake 级集成结果（阶段 3）

阶段 3（`docs/plan/00-parallel-work-plan.md` §5）的组合：**lane E 真 app core（`createApplication`）+ lane D 真 handlers（`createHandlers`）+ lane B 真 SQLite 账本（`openLedger`，临时文件）**，平台侧仍是 `FakeDriver`（lane A 的 Fake Runtime 服务端 API 未进 ports），识别是脚本化的 `GatedRecognizer`。测试文件 `tests/integration/test/real-stack.test.ts`，通过 `createSlice({ app: 'real', ledger, handlers })` 接线；命令 `npm test -w @wechat-agent/integration`（根 `npm run check` 退出码 0）。

这些是 **Fake 级证据**：没有真机、没有真实微信，下表只说明"在真 app+handlers+ledger 组合下哪些断言执行过"，对应 `cases/T*.md` 的 `result` 一律**保持 `not_run`**。

- appCommit：`2d74b3b`（分支 `integration-real`，基于 `app-skeleton` `ec3a792`）
- platformCommit：无（FakeDriver）
- contractSha256：见 `contracts/agentdesktop-runtime-v1/SHA256SUMS`（本阶段不经过真实契约）

| 用例 | 执行过的断言（真 app + 真 handlers + 真 SQLite 账本） | 测试 |
| --- | --- | --- |
| T05 | 同 operationId 两次 `task.create` 是同一任务；不同意图同 operationId → `operation_conflict`；同一任务第二次审批被拒；只有一条 `accept` attempt；已 confirmed 的意图换 operationId 再建仍是同一任务 | `real-stack.test.ts` "T05" |
| T08 | 危险点击时断连：attempt 为 `unknown`、requestId 已先持久化且与 act 使用的一致；任务停在 `stopping`、写门 `quiescence_unconfirmed`；重连后平台未确认静止前不判定、不 `run.cancel`；平台结束 connection_scoped Run 后 → `needs_reconciliation`（`platform_unknown`）；`task.reconcile` 用原 requestId 查 `request.show`；act 次数不增、无第二条 accept attempt；同意图再建仍是同一任务（额度 held，T40）；只有显式 `app.resume` 才重开写门且不重放 | `real-stack.test.ts` "T08" |
| T16 | 审批后重新 observe：详情出现 发消息 / 列表行已是 已添加 → `no_op(already_friend)`；无危险 act、无 `accept` attempt、审批未消费、无 `friend_added` fact | `real-stack.test.ts` "T16"（两例） |
| T21 | 危险点击使用审批后重新 observe 的坐标（详情按钮 1600,940），发生在审批后新获取的 Run 内 | `real-stack.test.ts` 竖切 |
| T31 | 审批后、点击前 `app.pause`：任务 `cancelled`、`run.cancel` 一次、晚到的 handler 续体不 act（act 仍为 1，仅审批前导航）、无 `accept` attempt；等待审批中被取消的任务拒绝晚到的 `task.approve` | `real-stack.test.ts` "T31" |
| T32 | 执行中 `task.cancel` 而平台 quiescence=pending：任务停在 `stopping`、写门 `quiescence_unconfirmed`、新任务 `blocked(write_gate_closed)`、`window.requestHandback` 返回 manual；平台确认静止后 `task.reconcile` → `cancelled`、写门重开；全程无危险 act | `real-stack.test.ts` "T32" |
| T33 | 断连后 Run 已结束且 `quiescence: confirmed` 的同时业务结果仍 `needs_reconciliation`，两者并存互不覆盖 | `real-stack.test.ts` "T08" |
| T36 | `run.start` 只带 sessionId；审批期间释放 Run（`run.finish`），批准后重新获取 | `real-stack.test.ts` 竖切 |
| 竖切 | `task.create → waiting_approval`（`pendingContentHash` 为 app 算的 sha256，`approval` 缺席）→ `task.approve`（原样回传 hash）→ 重新 observe → 一次危险 act → 已添加 → `confirmed`；attempt 链全部 `verified`、requestId 互不相同、`findOpenAttempts` 为空、回执原样入库、`approval.consumed = true`；UI 自造的 hash 被拒后任务重新准备并以同一 hash 再次请求审批 | `real-stack.test.ts` 前两例 |
| 基线 | `baselineOnConnect` 打开时，连接后先经 lane D 只读读取一次 新的朋友（act=0，step `baseline` done），之后的任务脚本正常 | `real-stack.test.ts` 末例 |

已知未覆盖/未解决（阶段 3 范围内）：lane E 不写 outbox 事件（任务书未要求，lane H 的 stub 写过，归属待定）；`FakeDriver` 不会在断连时结束 connection_scoped Run，T08 由测试代替平台调用 `confirmQuiescence`；lane D 在危险 act 前的 `consumeApproval` 发生在 `checkSignal` 之前，暂停后晚到的续体可能已消费审批但不会 act（保守，不断言）。
