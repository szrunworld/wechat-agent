# Lane A · Driver（方案 E01）

可写：`packages/driver/`。消费：`contracts/agentdesktop-runtime-v1/*`（唯一契约来源）、`AgentDesktopDriver` 及 wire 类型（`packages/ports/src/driver.ts`）。

## 交付

1. `createDriver(config): AgentDesktopDriver`：Unix socket 客户端；一行一帧 UTF-8 JSON，≤1 MiB（超出本地拒绝，`frame_too_large`，`notSent=true`）；同一连接按序应答；`requestTimeoutMs` 超时 → `deadline_exceeded`（phase transport，notSent 不确定时为 false）。
2. 端点：`config.endpoint ?? DEFAULT_CONTROL_ENDPOINT`，展开 `~`。**没有回退列表**，连不上就 `runtime_offline`（phase connect，notSent=true）。
3. `connect()`：`runtime.handshake`，校验 `product === 'AgentDesktop'`、`apiVersions` 含 `agentdesktop.runtime/1`；不符 → state `incompatible`，抛 `version_mismatch`。
4. 全部方法按 `methods.json` 的名字和 `runtime.schema.json` 的参数；`startRun` 永远不传 lifetime/ownership/origin。
5. `act(context, params, requestId)`：requestId 由调用方给；同 requestId 重发同参数应返回原回执（平台幂等）；不同参数得到 `idempotency_conflict` 要原样抛出。
6. `readArtifact`：按 ≤512 KiB 分块直到 `eof`，拼接后校验 `byteSize` 与 `sha256`，不符抛 `internal_error`（phase local）。
7. `subscribe`：**单独连接**，握手后 `events.subscribe`；推送帧解析为 `EventFrame`；`cursor` 随帧更新；连接断开时迭代器结束而不是抛错（调用方用 cursor 重订）；`events_cursor_expired` 原样抛出。
8. 出站请求在发送前用 `runtime.schema.json` 做本地校验（可用轻量 JSON Schema 子集校验器，自己写或引入无网络依赖的小库）。
9. **Fake Runtime 服务端** `packages/driver/src/fake-runtime.ts`：监听一个临时 Unix socket，实现握手、desktop/window/session/run/observe/act/request.show/artifact/events；可注入：断连（在 act 回执前）、超时、`idempotency_conflict`、`events_cursor_expired`、request.show `not_found`、act `notSent`、`input_disabled`、`stale_observation`。其他 lane 和集成测试都靠它。
10. `packages/driver/README.md`：用法、Fake Runtime 注入点一览。

## 完成条件

- 契约快照里的每个方法至少一个请求示例通过本地 schema 校验（测试列出方法名）。
- T02（不兼容握手）、T06（同 requestId 不同参数）、T08（回执前断连 → 调用方拿到 `connection_lost` 且 notSent=false）、T09（request.show not_found 原样返回）、T34（控制连接断开后 state=disconnected，不自动重连）、T35（关闭订阅不影响控制连接）、T36（startRun 不带提升参数；若 Fake 收到 lifetime 参数则测试失败）、T37（cursor 过期抛错）在 Driver 侧有执行过的断言。
- `scripts/check-bans.sh` 干净；包内无 child_process。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。

