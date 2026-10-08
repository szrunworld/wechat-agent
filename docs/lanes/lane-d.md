# Lane D · Handlers（方案 E05 流程半边 + §09 算法）

可写：`packages/handlers/`。消费：`Handler`、`HandlerContext`、三个 port（`packages/ports`），测试全用 `@wechat-agent/ports/fakes`。参考 `legacy/src/friends.ts` 只为了解微信页面流程，**不要**搬它的 realClick/escape/clear 收尾逻辑。

## 交付

每个 handler 一个文件，导出 `createHandlers(): HandlerRegistry`：

1. `ReadRequestsHandler`（只读）：导航到通讯录 → 新的朋友（每步 observe → recognize → 必要 act → 再 observe 确认页面类型），输出 `list_read` fact（含 coverage、每行 rowKey/status/confidence）；零行不等于全部处理完。
2. `AcceptRequestHandler`：定位 rowKey → 打开详情 → 组 `ApprovalRequest`（targetLabel、visibleIdentifier、留言、evidenceIds、identityConfidence）→ `requestApproval` → **重新 observe** → verify-before-write（同窗口、同账号 revision、对象仍 pending、identity evidence 存在，否则 `approval_invalid`/`target_ambiguous`/`request_expired`→no_op）→ `writeGate.ensureOpen()` → ledger.prepareAttempt + markDispatching（requestId = ctx.newId()）→ driver.act → recordReceipt → 后续 完成/确定 对话框同样走 observe-approve-act（审批已覆盖"接受"动作本身，对话框只允许白名单文本）→ 再 observe：同一身份变为 added 才 `confirmed`；行消失不算；否则 `needs_reconciliation`。未知弹窗 → `unexpected_dialog` 停止，不点任意"确定"。
3. `AddFriendHandler`：搜索框输入 typedId（act type）→ observe 搜索结果 → 没有"网络查找"项或无结果 → `not_found`；点击结果 → observe 资料/添加朋友页面 → 出现 发消息 → `already_friend` no_op；找不到 添加到通讯录 → `capability_missing`（弹层需要 CR02，不做前台旁路）；点击 → 验证语字段必须定位到且替换后 OCR 回读与批准正文一致，否则 `content_mismatch`；审批后重新 observe；发送后 observe 出现 等待验证/已发送 且无 频繁/失败 提示 → `confirmed`，否则 `sent_unconfirmed`。
4. `ReplyDraftHandler`：白名单会话 → observe 可见消息 → 产出草稿（source manual：原样；model：调用 ctx 提供的草稿 provider——本 lane 定义 `DraftProvider` 接口放在 handlers 包内，默认实现返回固定文本）→ 只写 ledger（draft fact），**不输入到微信**。
5. `SendMessageHandler`：审批 → observe → 输入框必须 `empty`（否则 `user_draft_present` waiting_user）→ contextRevision 对比（新入站气泡 → `approval_invalid` 重审）→ type 正文 → observe 回读输入框与正文一致（中文/emoji/换行）→ act key return → observe：新增 self 气泡且 anchorKey 不在 before 集合中且文本匹配 → `confirmed`；输入框空但无新气泡 → `sent_unconfirmed`。
6. 通用：`steps.ts` 提供 observe+recognize 的组合（含 `applicability` 失败 → `layout_unreadable` blocked）、派发前断连/notSent 分支（notSent=true → 可重规划；否则 markUnknown → `needs_reconciliation`，**不换 requestId 重发**）、`signal` 中断 → `cancelled`。
7. 清理：只有在同窗口、同账号、输入框文本等于本任务刚输入的正文时才清理，否则保留现场并 `waiting_user`。

## 完成条件

- 用 Fake Driver/Recognizer/Ledger 的场景测试：T16（已过期/已添加 → no_op）、T19（点击后页面变成错误窗口 → 停止、无后续 act）、T20（验证语字段缺失 → content_mismatch，Fake 记录无发送 act）、T21（审批期间页面变化 → 重 observe 后不用旧坐标）、T22（无成功标识 → sent_unconfirmed）、T23（已有草稿 → waiting_user）、T24（中文/emoji/换行回读不符 → 不发送）、T27（空框无气泡 → unknown）、T28（contextRevision 变化 → 重审）全部有执行过的断言；另加"派发后断连 → unknown → 同 requestId 不重发"。
- 每个 handler 的 `requires` 列出所需平台方法和动作种类。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。

