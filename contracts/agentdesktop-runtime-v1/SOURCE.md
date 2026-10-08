# runtime/1 契约快照

来源：szrunworld/agentdesktop，分支 **main**，commit `fa2222f`（含 PR #2 `134b451`：A2 单端点），目录 `contracts/runtime/v1`，复制于 2026-10-08；与 main `dddc0db` 逐字节一致（`git diff fa2222f dddc0db -- contracts/runtime/v1` 为空）。
上一版快照来自 acp-skeleton `4503416`（已废弃，不再作为平台现状依据）。

端点：宿主只监听一个 runtime/1 端点 `~/Library/Application Support/AgentDesktop/runtime.sock`（`methods.json` transport：runtime.sock today；`ai.sock` 已删除；`control.sock` 只是将来的改名，不是执行入口）。客户端不做回退探测。

与上一版的差异：我们使用的 33 个方法状态不变；新增 `ai.*`（模型配置，implemented）与过渡期 `gui.runs.*`；schema 只新增可选字段（`ActionReceipt.reason`、`Observation.coverage`、`Capabilities.gui`、`Run.unit`、`PlatformRunEvent` 事件目录、`FailureReason`）；新增 `service.schema.json`。`hub.pairing/clients/grants.*` 仍为 reserved（PR3 = CR01），`desktop.takeover/handback/stop` 仍为 reserved（A5 = CR03）。

更新快照是协调者的事：重新复制、更新 SHA256SUMS 与本文件。
