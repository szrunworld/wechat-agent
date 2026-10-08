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
