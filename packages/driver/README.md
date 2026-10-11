# @wechat-agent/driver（lane A）

AgentDesktop `agentdesktop.runtime/1` 的客户端（`createDriver`）和一个可注入故障的 **Fake Runtime 服务端**（`FakeRuntime`）。契约唯一来源是 `contracts/agentdesktop-runtime-v1/`（`methods.json`、`runtime.schema.json`、`errors.json`）；接口来自 `@wechat-agent/ports` 的 `AgentDesktopDriver`。

包内不派生任何子进程，不碰真实微信、不模拟真实指针；Fake Runtime 的"派发"只产生回执和事件。

## 用法

```ts
import { createDriver } from '@wechat-agent/driver';

const driver = createDriver({
  client: { name: 'WeChat Agent', version: '0.1.0' },
  // endpoint 省略 = DEFAULT_RUNTIME_ENDPOINT（~ 会展开）；没有回退列表，连不上就是 runtime_offline
  requestTimeoutMs: 10_000,   // 默认 10 s；超时 → deadline_exceeded（phase transport，notSent=false）
  connectTimeoutMs: 5_000,
});

const { identity, principal } = await driver.connect();   // runtime.handshake；product/apiVersions 不符 → version_mismatch，state=incompatible
const [desktop] = await driver.listDesktops();
const session = await driver.openSession(desktop.desktopId);
const run = await driver.startRun(session.sessionId);     // run.start，params 永远是 {}（不发 lifetime/ownership/origin）
const snap = await driver.observe({ sessionId: session.sessionId, runId: run.runId });
const receipt = await driver.act(
  { sessionId: session.sessionId, runId: run.runId },
  { snapshotId: snap.snapshotId, action: { kind: 'click', target: { imagePoint: { x: 100, y: 200 } } } },
  'rq_persisted_by_caller',                                // requestId 由调用方先落账本；同 id 同参数 = 原回执，不同参数 = idempotency_conflict
);
const png = await driver.readArtifact(snap.image!.artifactId); // ≤512 KiB 分块直到 eof，校验 byteSize + sha256

const stream = await driver.subscribe({ runId: run.runId }); // 单独连接 + 单独握手
for await (const frame of stream) { /* frame.event, stream.cursor */ }
// 连接断开 → 迭代器结束（不抛）；用 stream.cursor 重订：driver.subscribe({ runId, after: stream.cursor })
await driver.close();
```

### 方法 → 契约方法

| 接口 | 线上方法 | 备注 |
| --- | --- | --- |
| `connect` | `runtime.handshake` | 校验 `product === 'AgentDesktop'` 且 `apiVersions ∋ agentdesktop.runtime/1` |
| `capabilities` / `status` | `runtime.capabilities` / `runtime.status` | |
| `listDesktops` | `desktop.list` | |
| `listWindows({desktopId, pid})` | `window.list` | `desktopId` 走 envelope `context.desktopId`（params 没有这个字段） |
| `bindWindow` / `unbindWindow` | `window.bind` / `window.unbind` | |
| `openSession` / `closeSession` | `session.open` / `session.close` | |
| `startRun(sessionId)` | `run.start`（context.sessionId，params `{}`） | 返回 `run`，attachToken 丢弃不存 |
| `finishRun(runId, outcome)` | `run.finish` | outcome → exitCode：success 0 / failed 1 / cancelled 130（见 INTERFACE REQUEST） |
| `showRun` / `waitRun` / `cancelRun` / `listRuns` | `run.show` / `run.wait` / `run.cancel` / `run.list`（翻页到 `next=null`） | `waitRun` 的本地超时 = `timeoutMs + max(requestTimeoutMs, 2 s)` |
| `observe` / `act` / `wait` | `observe` / `act` / `wait` | `act` 的 envelope `requestId` 就是调用方给的幂等键 |
| `showRequest` | `request.show` | |
| `showArtifact` / `readArtifact` | `artifact.show` / `artifact.read` | |
| `subscribe` | 新连接：`runtime.handshake` → `events.subscribe` | 推送帧解析为 `EventFrame` |

### 错误

所有方法只抛 `DriverError`（`error.code/phase/retryable/notSent/details`）。平台返回的错误**原样**透传（`idempotency_conflict`、`not_found`、`events_cursor_expired`、`input_disabled`、`stale_observation`…）。Driver 自己产生的：

| code | phase | notSent | 何时 |
| --- | --- | --- | --- |
| `runtime_offline` | connect | true | 端点不存在 / 拒绝 / 连接超时（无回退探测） |
| `permission_denied` | connect | true | 端点 EACCES/EPERM |
| `version_mismatch` | handshake | false | product 或 apiVersions 不符（state → `incompatible`） |
| `schema_invalid` | local | true | 出站请求未通过 `runtime.schema.json` 本地校验 |
| `frame_too_large` | local | true | 一帧（含 LF）> 1 MiB，未写出 |
| `deadline_exceeded` | transport | false | `requestTimeoutMs` 内无应答；连接保留，迟到的应答被忽略 |
| `connection_lost` | transport | false | 发出后、应答前连接断开（T08） |
| `connection_lost` | transport | true | 未连接 / 已断开时调用（state 不是 `connected`） |
| `internal_error` | local | — | `readArtifact` 的 byteSize / sha256 / 分块不一致 |
| `invalid_argument` | local | true | `createDriver` 缺 client，或在 connected 时再次 `connect()` |

状态机：`disconnected → connecting → connected`；控制连接断开 → `disconnected`，**不自动重连**（T34）；`close()` → `closed`（也会关掉本 driver 打开的订阅连接；反过来关订阅不影响控制连接，T35）。

## Fake Runtime

```ts
import { FakeRuntime } from '@wechat-agent/driver';

const fake = await FakeRuntime.start({ screenshot: { byteSize: 1_200_000 } });
const driver = createDriver({ endpoint: fake.endpoint, client: { name: 'x', version: '1' } });
...
await fake.close();   // 关掉所有连接，删掉临时 socket
```

实现本应用调用的全部 34 个方法（`CALLED_METHODS`）（每个方法的回包都用结果 schema 校验过，见 `test/fake-runtime.test.ts`）：握手（先握手否则 `handshake_required`；无共同版本 → `version_mismatch`）、请求 envelope 与 params 的 schema 校验（`schema_invalid`）、帧上限（`frame_too_large`，requestId=null）、请求账本（mutation 方法按 requestId 记 digest：同内容重放原应答，不同内容 `idempotency_conflict`；`request.show` 查任何请求的记录）、Desktop/Window/Session、Delegated Run（控制连接断开 → Run 结束，`closingReason=connection_closed`；`run.start` 带 lifetime/ownership/origin → `ownership_escalation_denied`）、observe（产出截图 artifact + 元素）、act（回执 + 事件目录里的 `action.accepted` / `action.dispatched` / `action.completed|failed|unknown` 或 `action.refused`）、wait、artifact 分块读、事件订阅（Run 流在 Run 结束且事件发完后由服务端关连接；全局流默认从"现在"开始；`after` 早于 `retainedEventsFrom` → `events_cursor_expired`）、`runtime.stopAll` 后 act 得 `input_disabled`。

默认状态：一个 Desktop `desk_1`，已绑定一个假 WeChat 窗口（pid 777 / windowId 11），元素里有 `el_accept`（AXButton "Accept"）、`el_input`、`el_row_1`。

### 选项

| 选项 | 作用 |
| --- | --- |
| `socketPath` | 自定义 socket 路径（默认临时目录） |
| `identity` | 覆盖握手身份，如 `{ product: 'OtherDesktop' }` 或 `{ apiVersions: ['agentdesktop.runtime/2'] }`（T02） |
| `acceptAnyApiVersion` | 服务端不做版本交集检查，让客户端自己拒绝 |
| `principal` | 握手里带 principal（`null`/缺省 = 不带，和冻结的 `RuntimeIdentity` 一致） |
| `retainedEventsFrom` | 小于它的 cursor 已过期（T37） |
| `screenshot.byteSize` | 截图大小，>524288 走多块读取 |
| `elements` | observe 返回的元素 |
| `bound: false` | 初始不绑定窗口（observe 无 target，act → `invalid_target`） |
| `refuseEscalation: false` | 不拒绝 run.start 的提升参数（默认拒绝） |
| `quiescenceOnDrop` | 控制连接断开时它的 Run 怎么收场：`'confirmed'`（默认）立刻 `ended/cancelled/confirmed`；`'pending'` 先 `stopping` + `quiescence: pending`（`act` → `run_not_active`），直到 `confirmQuiescence(runId)` 才结束（ADR v2.2 §三的"安全取消并完成静止确认"） |
| `faults` | 初始故障列表 |

### 注入点

`onCall` 省略 = 下一次调用；给定 = 第 n 次（绝对计数，从 1 起）；默认一次性，`sticky: true` 常驻。

| 方法 | 效果 |
| --- | --- |
| `injectDisconnectBeforeReply(method)` | 处理完请求但不回包，直接断连（T08：客户端 `connection_lost`，`request.show` 能查到结果） |
| `injectTimeout(method)` | 处理完但永不回包（客户端 `deadline_exceeded`；同 requestId 重试会重放） |
| `injectError(method, code, { phase?, retryable?, notSent?, details? })` | 回这个错误，不处理；phase 缺省取 `errors.json` |
| `injectIdempotencyConflict()` | = `injectError('act', 'idempotency_conflict')` |
| `injectCursorExpired()` | = `injectError('events.subscribe', 'events_cursor_expired')` |
| `injectRequestNotFound()` | = `injectError('request.show', 'not_found')`（记录过期） |
| `injectActNotSent(code = 'invalid_target')` | act 报错且 `notSent: true` |
| `injectInputDisabled()` / `injectStaleObservation()` | act 报对应错误 |
| `injectReceipt({ delivery: 'unknown', ... })` | act 正常处理但覆盖回执字段 |
| `inject(fault)` | 原始形式（`FakeFault`） |
| `dropConnections()` / `dropSubscriptions()` | 断掉全部 / 只断订阅连接 |
| `confirmQuiescence(runId)` | `quiescenceOnDrop: 'pending'` 下让一个 `stopping` 的 Run 到达静止（`ended/cancelled/confirmed`） |
| `corruptArtifact(id)` | 翻转一个字节但不改 sha256（`readArtifact` 必须报 `internal_error`） |
| `emitEvent(runId, type, data)` | 给订阅者制造事件 |

可观察：`requests`（每条通过 envelope 校验的请求：connectionId/requestId/method/context/params）、`callCount(method)`、`connectionCount`、`connectionsAccepted`、`desktops/sessions/runs/receipts/artifacts/records/snapshots`、`admission`。

## 测试

```
npm run typecheck -w @wechat-agent/driver
npm test -w @wechat-agent/driver
```

`test/driver.test.ts` 的用例名带 T 编号（T02/T06/T08/T09/T34/T35/T36/T37）；`test/schema.test.ts` 列出契约快照每个方法的示例校验；`test/fake-runtime.test.ts` 校验 Fake 每个方法的回包。
