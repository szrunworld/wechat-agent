# WeChat Agent 并行开发工作计划 v1.0

日期 2026-10-08 · 依据《独立 WeChat Agent 产品与开发方案 v1.0》（ChatGPT 交付包，下称「方案」）、ADR v2.2、agentdesktop-acp `4503416` 的 runtime/1 契约（`contracts/runtime/v1/methods.json`：34 个方法 implemented，`unit.run` frozen，`hub.pairing/grants` reserved）。

目标：同时启动 N 个 agent，各自开发一条 lane，彼此不互相影响；最后由协调者按固定顺序合并、集成、真机验收。

## 1. 正交性是怎么保证的

并行不出事的前提不是"任务不相关"，而是**接口先冻结、目录不重叠、依赖只走 Fake**。具体四条：

1. **阶段 0 先铺骨架**（协调者一人做，约 2 小时）：npm workspaces 单仓，每个 lane 一个 package；所有 lane 之间的接口放在 `packages/ports`（纯类型 + 内存 Fake），lane 只能 import `@wechat-agent/ports`，不能 import 其他 lane 的包。
2. **目录即所有权**：每条 lane 只改自己的目录（见 §3 表）。`packages/ports`、根 `package.json`、CI、`docs/plan` 只有协调者改；lane 需要改接口时在 PR 里写 `INTERFACE REQUEST`，由协调者在骨架分支改好后各 lane rebase。
3. **依赖只走 Fake**：Driver 的 Fake Runtime、Ledger 的内存实现、Recognizer 的夹具结果都在 `packages/ports/fakes`，由骨架提供最小版本；lane 可以在自己的 `test/` 里扩展，不能改共享 Fake。
4. **PR 只对骨架分支**：每个 lane 一个 worktree + 一个分支，PR base = `app-skeleton`；lane 不合并别人的分支，也不 merge 自己的 PR；协调者审、合、跑集成。

另外三条全局禁令（任何 lane 违反即打回）：
- 不碰真实微信：不启动、不移动、不点击用户的微信；真机验收只由协调者在授权测试账号上做（方案 §12/§13）。
- 不保留旧旁路：不 exec `2ndscreen`，不 osascript 前台化，不 `drag --foreground` 模拟真点击，不读 `~/.config/2ndscreen/*.env`（方案 §03、§07）。
- 不预写 pass：测试矩阵 T01–T42 的记录默认 `not_run`，只有执行过断言才能写 `passed`。

## 2. 阶段 0：骨架（协调者，先于所有 lane）

分支 `app-skeleton`（从 `main` 13b0fcc 切），内容：

| 项 | 内容 |
| --- | --- |
| 仓库布局 | `packages/{ports,driver,ledger,recognition,handlers,app}`、`apps/desktop`、`packaging/`、`tests/integration`、`fixtures/`、`contracts/agentdesktop-runtime-v1/`、`docs/{plan,acceptance,lanes}` |
| 契约快照 | 从 agentdesktop-acp `4503416` 复制 `methods.json / runtime.schema.json / errors.json`，附 `SHA256SUMS` 与来源 commit；lane A 只认这份快照 |
| `packages/ports` | 冻结接口（§2.1），纯 TS 类型 + 最小内存 Fake，自带测试 |
| 旧代码归档 | `src/`、`ocr/` 原样移到 `legacy/`（只读参考，不参与构建）；`parse.ts` 的解析函数和测试复制一份到 `packages/recognition/src/legacy-parse.ts` 作为 lane C 的起点 |
| CI | 根 `npm test` = 每个 package 的 `typecheck + test`；每个 lane 的 PR 只需自己的 package 绿 |
| 文档 | 本计划；`docs/lanes/03-ownership.md`（目录 → lane 表）；每条 lane 的 `docs/lanes/lane-X.md` 任务书 |

### 2.1 冻结接口（`packages/ports`）

| 接口 | 谁实现 | 谁消费 | 要点 |
| --- | --- | --- | --- |
| `AgentDesktopDriver` | lane A | D、E、H | `handshake/capabilities/sessionOpen/runStart/observe/act/requestShow/runCancel/runWait/artifactRead/subscribe`；`act` 入参带 `snapshotId`、`imagePoint`（截图像素）；返回平台回执原样（delivery/execution/verification、notSent、phase）；错误码 = `errors.json` |
| `Ledger` | lane B | D、E、H | `intake(operationId, fingerprint)`、`attempt.prepare → dispatching → receipt → verified`、`approval.consume`、`quota.reserve/release/hold`、`fact.append`、`evidence.put`、`outbox`；全部返回 `revision` |
| `Recognizer` + `LayoutProfile` | lane C | D、H | `recognize(image, profile) → PageFacts`（页面类型、行、详情、按钮、`coverage: current_viewport/partial/end_confirmed/unreadable`、每条 `confidence` 与 `evidenceRef`）；坐标一律是截图像素 |
| `Handler<TaskType>` | lane D | E、H | `prepare / verifyBeforeWrite / dispatch / verifyAfter`，每步只能拿 Driver/Recognizer/Ledger 三个 port；输出 `DomainResult`（confirmed / failed / no_op / needs_reconciliation / sent_unconfirmed / ambiguous / waiting_user） |
| `ApplicationService`（typed IPC schema） | lane E | F、H | 方案 §08 的 11 个本地方法：`app.getSnapshot, connection.check, account.confirm, task.create/list/show/approve/skip/cancel, app.pause/resume, task.reconcile, window.requestHandback, diagnostics.export`；全部带 `operationId / expectedRevision` |
| 领域类型 | 协调者 | 全部 | `AccountBinding, TargetRef, WeChatTask, BusinessApproval, ActionAttempt, DomainFact, Evidence, Policy, QuotaReservation, Outbox`；任务状态机枚举（方案 §08）；`AppSnapshot` |

接口一旦冻结，改动只走协调者；lane 在 PR 描述里提 `INTERFACE REQUEST: <port>.<method> 需要 …`。

## 3. Lane 表（8 条，可同时启动）

| Lane | 对应方案 | 目录（唯一可写） | 产出 | 完成条件 | 量 |
| --- | --- | --- | --- | --- | --- |
| **A Driver** | E01 | `packages/driver` | JSONL 帧（≤1 MiB）、超时、握手校验（product/apiVersion/principal/方法集合）、`session/run/observe/act/request.show/run.cancel/run.wait`、`artifact.read` 分块 ≤512 KiB + sha256 校验、`events.subscribe` 独立连接 + 游标恢复、`requestId` 幂等回查；**Fake Runtime 服务端**（可注入：断连、超时、`idempotency_conflict`、`events_cursor_expired`、过期 not_found、notSent）供其他 lane 与集成用 | 契约快照里每个请求示例通过 schema 校验；T02/T06/T08/T09/T34/T35/T36/T37 的 Driver 侧断言通过；全文 grep 无 `2ndscreen`、`osascript`、`CGEvent` | L |
| **B Ledger** | E04 | `packages/ledger` | SQLite（better-sqlite3，WAL，单 writer）、事务迁移 + `schema_version`、唯一索引 `operationId / (taskId,stepId,attemptOrdinal) / requestId`、attempt/approval/quota/outbox/fact/evidence 表、损坏/磁盘满 → 停写并导出诊断、旧 `handled` 数组只导入为 `legacy_suppression`（不生成任务、丢弃 `wechatPid`、不继承 `mode=auto`） | T05/T07/T38/T39/T40 单元断言通过；崩溃边界测试（每个状态转换前杀进程再恢复）通过；文件 0600/目录 0700 | L |
| **C Recognition** | E05 识别半边 | `packages/recognition` + `fixtures/wechat`（图像夹具） + OCR helper | 从 `legacy-parse.ts` 重建：版本化 `LayoutProfile`（微信 4.1 · 1280×900 · 2x 深色为 profile 1，不是硬编码）、适用性检测（尺寸/缩放/主题不匹配 → `unreadable`）、列表/新的朋友/详情/按钮/输入框/气泡识别、`coverage` 四态、重名/截断 → `ambiguous`、"绿色不等于接受"（T15）、OCR helper 改为读 artifact 图片文件、脱敏合成夹具 | T11/T13/T14/T15/T26 夹具通过；每个识别结果带 `confidence` 与 `evidenceRef`；无任何输入动作代码 | XL |
| **D Handlers** | E05 流程半边 + §09 算法 | `packages/handlers` | `ReadRequests`、`AcceptRequest`、`AddFriend`、`ReplyDraft`（草稿只写不发）、`SendMessage`；每个 handler 实现方案 §09 的 11 步 observe-act-verify，危险点击前重新 observe 并校验审批版本；成功判据按方案 §09 末段（接受 = 同一身份转已添加；加好友 = 出现等待验证/已发送；发消息 = 新增匹配气泡，排除旧同文）；验证语无法落位 → `content_mismatch`，不发默认语 | 全部用 Fake Driver/Recognizer/Ledger 跑：T16/T19/T20/T21/T22/T23/T24/T27/T28 断言通过；覆盖"派发后断连 → unknown → 不换 requestId 重发" | XL |
| **E App core** | E02 + E03 | `packages/app` | `ApplicationService`（单实例、typed IPC 实现）、`Dispatcher`（UI/巡检统一入队，单账号写串行）、任务状态机、`PolicyGate`（白名单/动作种类/时段/额度/账号 revision/审批有效期）、`QuotaReservation`、`AccountBinding`（换账号 → 旧审批全失效）、能力门禁（capability_missing → 功能 disabled 且可解释）、`pause/resume`（关写门、取消所属 Run、等静止；resume 不重放）、`Recovery`（遗留 dispatching → `request.show` 核实，不判 not_sent）、连接门（控制连接长存、事件订阅独立、断连先关写门、指数退避只重连观察） | T01/T03/T05/T10/T28/T30/T31/T32/T33/T34 用 Fake 通过；"同意图唯一执行、暂停无晚到动作、重连旧 Run 不恢复"三条有专门测试 | L |
| **F UI** | E06 + §14 六屏 | `apps/desktop/renderer` | React 六屏 W01–W06（连接与账号确认 / 工作台 / 好友审批 / 加好友与回复编辑 / 任务详情与未知核实 / 设置与诊断）；只依赖 typed IPC schema 与 `AppSnapshot` Fake；所有异常态（stopping、静止未确认、unknown、平台离线、身份歧义、审批过期、覆盖部分）有独立文案；键盘可达、不只靠颜色、<900px 单栏、长昵称不截断身份 | Fake 快照可切换全部状态；离屏渲染截图存 `docs/acceptance/ui/`；渲染层无 Node、无 Driver 调用 | L |
| **G Shell & packaging** | E00 选型 spike + E08 | `apps/desktop/main`、`packaging/` | Electron 主进程壳（contextIsolation、sandbox、无 nodeIntegration、固定 IPC 白名单）、菜单栏最小化与显式退出流程（退出 = 停止流程，不伪造取消成功）、打包（electron-builder）、OCR helper 与 Node 运行时打进包、签名/公证脚本、SBOM、升级保全账本、卸载不动平台；**spike 报告**：体积、沙盒约束、helper 签名可行性 | 干净 Mac 上能装出一个空壳 App 并显示 Fake W01；包内 grep 无 `2ndscreen` 二进制或路径；T41 的安装/卸载断言脚本化 | M |
| **H Integration & acceptance** | E07 + §12/§13 | `tests/integration`、`docs/acceptance` | 故障注入集成测试骨架（真 Driver + lane A 的 Fake Runtime + 真 Ledger + Fake Recognizer）；ADR-01～10 回归用例；T01–T42 每条一个记录文件（初始全部 `not_run`，带 caseId/requirementId/证据字段模板）；A01–A12 验收步骤文档与证据模板（方案 §13）；真机测试账号/目标别名约定；`docs/acceptance/support-matrix.md`（微信版本 × 缩放 × 主题，初始全部待测） | 集成骨架能在 CI 跑通一条 Fake 竖切（task.create → approve → dispatch → receipt → fact）；记录文件 lint（禁止未执行却写 passed） | L |

每条 lane 的任务书在 `docs/lanes/lane-X.md`，包含：可写目录、可读目录、消费的 port、交付清单、完成条件、禁止事项、对应的 T 编号。

## 4. 平台侧工作（另一个仓库，另一个负责人，不在本仓库 lane 内）

这些是方案 §07/§11 的 CR，归 agentdesktop 仓库（Runtime 负责人 f1）。本仓库只记录依赖与门禁，不替平台写微信特例。

| CR | 内容 | 阻断什么 | 本仓库对策 |
| --- | --- | --- | --- |
| CR01 | paired principal 身份、grants、撤销、跨主体 request/run/artifact 过滤；统一 `control.sock` | P0 真实外发 | lane E 能力门禁默认 `blocked(pairing_missing)`；lane A 的端点可配置、无回退探测 |
| CR02 | 通用前台 input route、弹层/子窗口目标绑定、中文输入与剪贴板保全 | 加好友、部分回复 | lane D 在缺路由时返回 `blocked(capability_missing)`，不做前台旁路 |
| CR03 | takeover/handback 或已验证的 `window.unbind` 归还语义 | 一键接管/归还 | lane E `window.requestHandback` 缺能力时显示手动指引 |
| CR04 | `unit.run` 与同一 Runtime 账本 | P1 | 不进 P0 |

## 5. 合并与集成顺序

```
阶段 0  骨架 app-skeleton（协调者）                       ~2h
阶段 1  8 条 lane 并行（各自 worktree/分支/PR）            并行
阶段 2  协调者合并：A、B、C 先（被依赖），再 D、E，再 F、G，最后 H
阶段 3  lane H 的集成竖切在 app-skeleton 上跑绿：
        Fake Runtime + 真 Driver + 真 Ledger + 真 App core + 真 Handlers + Fake Recognizer
阶段 4  真机只读基线（协调者，授权测试账号）：A01–A04 + A05 坐标 spike
阶段 5  逐功能开放：列表 → 接受（A06）→ 加好友（A07，需 CR02）→ 回复（A08）→ 停止/恢复（A09/A10）
阶段 6  打包/升级（A11）→ 签收（A12）
```

门禁：每条 lane PR 合并条件 = 自己 package 的 typecheck + test 绿 + 没有越界改动（CI 用 `git diff --name-only` 对照 ownership 表）+ 无全局禁令违反（grep）。阶段 3 不绿不进阶段 4。真机步骤只由协调者执行并写证据记录，lane 不碰。

## 6. 怎么启动 N 个 agent

每条 lane 一个后台 agent，worktree 隔离，分支 `lane-<x>`，PR base `app-skeleton`：

```bash
cd ~/orca/wechat-agent
git worktree add ../wechat-agent-a -b lane-a app-skeleton   # A 同理 b…h
```

agent 提示词模板（每条 lane 替换 X 和任务书路径）：

> 你是 WeChat Agent 仓库的 lane X。读 `docs/plan/00-parallel-work-plan.md` 和 `docs/lanes/lane-X.md`，只改任务书列出的目录。接口全部来自 `packages/ports`，不要 import 其他 lane 的包，不要改 `packages/ports`；需要改接口就在 PR 描述写 `INTERFACE REQUEST`。不要启动、移动或点击真实微信；不要 exec 2ndscreen、osascript 或模拟真实点击。完成条件是任务书里的 T 用例全部有执行过的断言；测试记录默认 not_run。做完开 draft PR 到 `app-skeleton`，不要合并。最后报告：改了哪些文件、跑了什么命令、通过/失败数、未完成项。

协调者（本会话）负责：骨架、接口变更、合并、集成竖切、真机验收、与 agentdesktop 仓库的 CR 对接。

## 7. 与方案的映射

| 方案 | 本计划 |
| --- | --- |
| E00 基线与 spike | 阶段 0（契约快照、SHA、ADR 引用）+ lane G 的壳 spike |
| E01 | lane A |
| E02 | lane E（权限/账号绑定/能力门禁部分） |
| E03 | lane E（App 与 Dispatcher 部分） |
| E04 | lane B |
| E05 | lane C（识别）+ lane D（handlers） |
| E06 | lane F |
| E07 | lane H |
| E08 | lane G |
| E09 | 阶段 4–6（协调者 + Kevin） |
| E10 | P1，不启动 |
| CR01–CR04 | §4，agentdesktop 仓库 |
| T01–T42 | 按 lane 分配（§3 表）；lane H 维护记录文件 |
| A01–A12 | lane H 写模板，协调者执行 |

## 8. 已知风险与提前决定

- **壳选型**：方案建议 Electron + React（D 级设计）。本计划按它启动 F/G；若 lane G 的 spike 结论是体积/签名不可接受，F 的 React 视图与 IPC schema 不变，只换壳。
- **端点不一致**：冻结文档说 `control.sock`，acp 分支 EndpointResolver 仍是 `runtime.sock`。lane A 把端点做成显式配置项，默认按冻结文档，不做回退探测；真机前由协调者确认发行分支。
- **配对未落地**：hub.pairing/grants reserved。真实外发在 CR01 完成前始终 `blocked`，lane 不得为了测试申请 owner 权限。
- **真机证据只有协调者产出**：lane 的全部通过记录都是 Fake/夹具级别，签收时必须区分。
