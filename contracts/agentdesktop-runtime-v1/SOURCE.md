# runtime/1 契约快照

来源：szrunworld/agentdesktop，分支 **main**，commit `7cbbdec878c14876c39ccf648fa880ad1f692a88`（`7cbbdec`，#265 合并提交，2026-10-11），目录 `contracts/runtime/v1`，复制于 2026-10-11。四个文件与该 commit 逐字节一致（SHA256SUMS）。

与上一版（`bb02b59`）的差异，以及本应用怎么处理：
- **新增方法**：`hub.windows.request/list/revoke`（#205 窗口级授权）、`hub.displays.list/attach/detach`（#216 owner 挂接显示器）、`desktop.takeover/handback/stop/closePlan/resize/bindingStatus/recoverBinding`、`app.quit`、`observe.region/subscribe/unsubscribe`、`request.list/export`、`unit.run`。本应用都**不调用**：driver 改成按名单调用（`CALLED_METHODS`，`packages/driver/src/schema.ts`），名单外的方法在本地拒绝，新方法要本应用有意采用才会进入名单。`hub.displays.*` 只属于所有者；`hub.windows.*` 留到第四阶段（物理 Desktop 上绑定微信窗口时）再接。
- **撤回**：`gui.runs.*` 已从 runtime/1 删除。
- **错误码**：`client_revoked` / `grant_missing` / `grant_expired` 落在 Runtime 已经执行的写操作上时，`notSent: false`，`details.writeOutcome: "completed"`（只是不给回包）。本应用按 `notSent` 处理：这种 act 进入 `needs_reconciliation`，绝不重发，也不当作未配对（新增测试）。`unsupported_backend` 不再 reserved（macOS 上 hover / drag）。
- **Action.kind**：新增 `hover`、`press`、`drag`。本应用不规划这些动作。
- **事件目录**：`RunEvent` 中 `run.` / `action.` / `stop.` 前缀的事件必须符合 `PlatformRunEvent`。Fake Runtime 改为按目录发事件（`run.started` 带 kind/origin/ownership/lifetime，act 发 `action.accepted` → `action.dispatched` → `action.completed|failed|unknown`，未派发发 `action.refused`，结束发 `run.quiescent` → `run.ended`，断连收尾发 `stop.accepted`）。本应用不消费这些事件的内容。
- `methods.json` 的 `authorization` 段新增 `windowGrants`、`displays`、`policy`（#139 iPhone 镜像封禁）。

本应用只调用 `hub.pairing.start` 与 `hub.pairing.status`；其余 `hub.*` 和 `runtime.enableInput` 属于所有者或尚未采用，driver 在本地拒绝。

端点不变：宿主只监听一个 runtime/1 端点 `~/Library/Application Support/AgentDesktop/runtime.sock`，客户端不做回退探测。

更新快照是协调者的事：重新复制、更新 SHA256SUMS 与本文件。

---

## 上一版（bb02b59）说明，保留备查

来源：szrunworld/agentdesktop，分支 **main**，commit `bb02b59`（#137 A4 调用方身份合并提交），目录 `contracts/runtime/v1`，复制于 2026-10-09。`service.schema.json` 与上一版逐字节相同。

与上一版（`fa2222f`）的差异：
- `hub.pairing.start/status/approve/deny`、`hub.clients.*`、`hub.grants.*`、`hub.connections.list` 从 reserved 变为 implemented（A4，原 PR3 / CR01 的身份部分）。
- `runtime_handshake_params` 新增可选 `credential {clientId, token}`；`RuntimeIdentity.principal` 现在由 Runtime 按凭据给出：`owner`（只在宿主进程内，socket 上不存在）、`paired`（`app:<id>`）、`unpaired`（`unpaired:conn_<16 hex>`），并带 `codeIdentityLevel`。
- `pairing_required`、`client_revoked`、`grant_missing`、`grant_expired` 不再是 reserved。
- `methods.json` 新增 `authorization` 段（各方法需要的能力）。

本应用只调用 `hub.pairing.start` 与 `hub.pairing.status`；其余 `hub.*` 和 `runtime.enableInput` 属于所有者，driver 在本地拒绝（`packages/driver/src/schema.ts`）。

端点不变：宿主只监听一个 runtime/1 端点 `~/Library/Application Support/AgentDesktop/runtime.sock`，客户端不做回退探测。

更新快照是协调者的事：重新复制、更新 SHA256SUMS 与本文件。

---

## 上一版（fa2222f）说明，保留备查


来源：szrunworld/agentdesktop，分支 **main**，commit `fa2222f`（含 PR #2 `134b451`：A2 单端点），目录 `contracts/runtime/v1`，复制于 2026-10-08；与 main `dddc0db` 逐字节一致（`git diff fa2222f dddc0db -- contracts/runtime/v1` 为空）。
上一版快照来自 acp-skeleton `4503416`（已废弃，不再作为平台现状依据）。

端点：宿主只监听一个 runtime/1 端点 `~/Library/Application Support/AgentDesktop/runtime.sock`（`methods.json` transport：runtime.sock today；`ai.sock` 已删除；`control.sock` 只是将来的改名，不是执行入口）。客户端不做回退探测。

与上一版的差异：我们使用的 33 个方法状态不变；新增 `ai.*`（模型配置，implemented）与过渡期 `gui.runs.*`；schema 只新增可选字段（`ActionReceipt.reason`、`Observation.coverage`、`Capabilities.gui`、`Run.unit`、`PlatformRunEvent` 事件目录、`FailureReason`）；新增 `service.schema.json`。`hub.pairing/clients/grants.*` 仍为 reserved（PR3 = CR01），`desktop.takeover/handback/stop` 仍为 reserved（A5 = CR03）。

更新快照是协调者的事：重新复制、更新 SHA256SUMS 与本文件。
