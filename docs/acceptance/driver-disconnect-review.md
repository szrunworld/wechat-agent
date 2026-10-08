# Delegated Run 断连语义审查（packages/driver · Fake Runtime · packages/app）

对照：`/Users/kevinshi/orca/agentdesktop-acp/docs/architecture/ADR-v2.2-hub-ui-run-lifetime.md` §三（Delegated Run：断开 → 立即撤销后续输入准入；执行中的原生动作安全取消并完成静止确认；无法确认的动作进入 unknown；重连不自动恢复旧 Run；Agent 进程不由平台终止）与 §五 ADR-03 / ADR-04。

证据：`tests/integration/test/driver-disconnect.test.ts`（真 `createDriver` + lane A 的 **Fake Runtime 服务端**（Unix socket）+ 真 app + 真 handlers + 真 SQLite 账本；**不**用 `FakeDriver`、不用它的 `endRunsOnDrop`）。命令 `npm test -w @wechat-agent/integration`，6 例全部执行过断言。

## 1. packages/driver（lane A）：控制连接丢失时

| 项 | 实现（`src/connection.ts`、`src/client.ts`） | ADR 要求 | 结论 |
| --- | --- | --- | --- |
| 在途请求 | socket `close` → 所有 pending 以 `connection_lost` 拒绝：`phase=transport`、`retryable=false`、`notSent=false`、`details.requestId` | "无法确认的动作进入 unknown"：调用方拿不到回执，只能按 requestId 核实 | 符合；`notSent=false` 正确地不承诺"未送达" |
| 之后的调用 | state 不是 `connected` → `connection_lost`，`notSent=true` | 断开后不得再送输入 | 符合（Driver 自己就不发） |
| state | `connected → disconnected`；`close()` → `closed` | — | 符合 |
| 自动重连 | 没有；`onClose` 只改 state（T34）。150 ms 后 `connectionsAccepted` 不变 | "重连：不自动恢复旧 Run"——由 App 决定何时重连 | 符合 |
| 订阅连接 | 独立连接；服务端在 Run 结束并发完事件后关连接，迭代器**结束不抛**，`cursor` 可续订 | UI/订阅断开不等于控制连接断开 | 符合（T35） |
| `deadline_exceeded` | `phase=transport`、`notSent=false`；**连接保留**，迟到应答被忽略；此时 `connect()` 抛 `invalid_argument`（connected 时拒绝重复连接） | — | 本身不违反 ADR，但与 App 的假设冲突，见 §4 |

## 2. Fake Runtime（lane A，`src/fake-runtime.ts`）：是否按 ADR 实现

| 项 | 实现 | 结论 |
| --- | --- | --- |
| 连接结束 → 其 connection_scoped Run 结束 | `socket.close` → 该连接 `run.start` 过的每个未结束 Run `endRun(cancelled, 'connection_closed')`：`phase=ended`、`outcome=cancelled`、`quiescence=confirmed`、`run.ended` 事件 | 符合 ADR-03 的终态 |
| 断开后的新输入 | `act` 对 `ended` 的 Run → `run_not_active`；**新增**：对 `stopping` 的 Run 也 `run_not_active`（之前只拦 ended） | 符合"立即撤销后续输入准入" |
| 未确认动作 | 回包前断连（`disconnect_before_reply`）的 act 已经完整处理：`request.show` 查到 `completed` + `receiptId`，Run 的 `receipts` 里有它，`unknownActions=0` | 平台视角它是 completed，只有客户端不知道——符合"按 requestId 核实、不重发" |
| 静止确认的时间差 | 原实现断连即 `confirmed`，没有"原生动作还在收尾"的 `pending` 阶段，App 的"重连后平台未确认静止前不判定"只能靠 FakeDriver 的 `confirmQuiescence` 证明 | **补齐**：新增选项 `quiescenceOnDrop: 'pending'`（默认 `'confirmed'`，老行为不变）：断连 → `phase=stopping`、`quiescence=pending`、`outcome=null`、`closingReason=connection_closed`、`run.stopping` 事件；`confirmQuiescence(runId)` 才 `ended/cancelled/confirmed` |
| 重连 | 新连接新握手；旧 Run 只能 `run.show / run.events / request.show`；`run.attach` 需要 attach token（Driver 丢弃不存，App 拿不到） | 符合 ADR-04 |
| 进程 | 平台不终止客户端进程（Fake 只关 socket） | 符合 |

## 3. packages/app（lane E）：连接丢失后

| 项 | 实现 | 结论 |
| --- | --- | --- |
| 关写门 | `RuntimeConnector.noteDisconnected` → `hooks.onDisconnected` → `gate.setConnection(false)`、`dispatcher.onDisconnected()`（在飞任务 `disconnected=true` + abort）、`gate.pause('disconnected')`；`guardDriver` 的 `act` 先 `ensureOpen()` | 立即阻断新输入：符合 ADR-03 |
| attempt 标 unknown | lane D `Flow.act`：act 抛 `connection_lost`（notSent=false）→ `markUnknown(attemptId, 'connection_lost')` + `platform_receipt: needs_reconciliation` fact；requestId 在 act 前已 `markDispatching` 持久化，与平台 envelope 的 `requestId` 一致（测试逐条比对） | 符合 |
| 任务停在哪 | executing/verifying → `stopping(disconnected)` + `gate.quiescenceUnconfirmed`；preparing 等 → `blocked(disconnected)` | 符合"先 stopping，拿到静止证据才 stopped" |
| 重连后 | `onConnected` → `recoverOpenAttempts`（request.show）→ `reviewParkedRuns`（只 `run.show`：`confirmed` 才结算为 `needs_reconciliation(platform_unknown)`；`pending` 则保持 `stopping`）；`task.reconcile` 只查 `request.show / run.show`；没有 `run.attach`、`run.cancel`、重发 act；`run.start` 次数不增；`app.resume` 不重放 | 符合 ADR-04；`quiescenceOnDrop: 'pending'` 一例证明"平台未确认静止前不判定、不 cancel" |
| 退避重连 | `scheduleReconnect` 指数退避；重连只重建观察（握手、能力、绑定、订阅） | 符合 |

## 4. 发现的偏差与修复

### 4.1 超时后无法重连（packages/app 的假设错了；已修）

- **现象**（`rehearsal.test.ts` "observe gets no reply within the deadline"，修复前）：`deadline_exceeded` 的 `phase=transport`，App 的 `isConnectionError` 把它当连接丢失（关写门、任务 `blocked(disconnected)`、安排重连）。但 Driver 在 `deadline_exceeded` 时**保留连接**（README："连接保留，迟到的应答被忽略"），state 仍是 `connected`；重连时 `connectOnce` 直接 `driver.connect()`，Driver 拒绝：`invalid_argument: connect() called while connected` → `steps.discover=failed`，再退避、再失败，**永远连不回去**，而平台侧那个 Run 一直 `running`（输入准入仍开着，和 App "已失联"的判断相反）。
- **谁的假设错了**：App 假设"凡是 transport 错误 Driver 都已断开连接"；Driver 的契约不是这样。`FakeDriver.connect()` 在 connected 时也直接成功，所以 Fake 级测试（`faults.test.ts`、`vertical-slice.test.ts` 的 deadline 用例）从未暴露它。
- **修复**（`packages/app/src/connector.ts`，两处）：
  1. `noteDisconnected`：App 判定失联时，若 `driver.state === 'connected'` 立即 `driver.close()`——平台看到连接结束，其 connection_scoped Run 按 ADR 结束，与 App 已经做出的"失联/停止"判断一致；
  2. `connectOnce`：重连前若 Driver 仍 `connected` 先 `close()`，保证每次重连都是新 socket、新握手。
- **证据**：`rehearsal.test.ts` 超时一例（修复后：陈旧连接关闭 → 平台 Run `connection_closed` → `connection.check` 成功 → `run.start` 仍为 1）；`driver-disconnect.test.ts` "deadline_exceeded keeps the socket" 记录 Driver 原行为并证明关闭后 Run 结束。Driver 不改：保留连接 + 忽略迟到应答本身是合理的，关不关由 App 决定。

### 4.2 Fake Runtime 对 `stopping` Run 仍接受 act（lane A，已修）

`act` 只拦 `ended`；ADR 要求断开后立即撤销输入准入，`stopping` 期间同样不得接受。改为 `ended || stopping → run_not_active`（新增的 `quiescenceOnDrop: 'pending'` 才会出现 stopping，默认行为无变化）。

### 4.3 无偏差但要记住的点

- Flow 对 `deadline_exceeded` 的 act 会 `markUnknown` 并 `needs_reconciliation(platform_unknown)`，对 observe/artifact.read 的 deadline 则 `halt('failed')`；App 层随后因 `rt.disconnected` 统一改判 `blocked(disconnected)`。两层结论不同但最终状态一致，不改。
- `task.reconcile` 会对任务的**每个**持久化 requestId 调 `request.show`（含导航点击），不只是危险动作；都是自己的 requestId，不是重发。
- `reviewParkedRuns` 只看 `stopUnconfirmed` 的任务；`blocked(disconnected)` 的只读任务重连后不会被重跑（需要人重新创建），符合"重连不恢复"。
- 平台若在断连时先回 `quiescence=pending`，App 保持 `stopping` + 写门 `quiescence_unconfirmed`，直到 `task.reconcile`/下一次重连的 `run.show` 看到 `confirmed`。

## 5. 结论

ADR v2.2 §三对 Delegated Run 的四条（断开即停输入、动作安全收尾并确认静止、未确认进 unknown、重连不恢复）在 Driver、Fake Runtime、App 三层都有执行过断言的证据。偏差两处（§4.1 App 超时后不能重连；§4.2 Fake 对 stopping 仍收 act），均已修并有测试。Fake Runtime 新增 `quiescenceOnDrop: 'pending'` + `confirmQuiescence()`，使"平台未静止前只查询不判定"不再依赖 FakeDriver。
