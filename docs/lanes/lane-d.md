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


---

## 进度记录（lane-d，2026-10-08）

### 交付物（`packages/handlers/src/`）

| 文件 | 内容 |
| --- | --- |
| `steps.ts` | `Flow`：observe → applicability → recognize → `putEvidence`（coverage=unreadable / profile 不适用 → `blocked(layout_unreadable)`）；`act()` 每次都做 signal → `writeGate.ensureOpen()` → `prepareAttempt` → `requestId = ctx.newId()` → `markDispatching` → `driver.act`；派发后异常 → `markUnknown` → `needs_reconciliation`（同 requestId 不重发）；`notSent=true` → `markUnknown('not_sent:<code>')` + 可重规划的 `blocked`；回执 delivery/execution=unknown → `needs_reconciliation`；`not_dispatched` → 按 reason 转 `blocked`/`failed`；审批校验（任务/动作/contentHash/target revision/account revision/过期/已消费），危险动作前先 `ledger.getApproval` 重读账本副本再 `consumeApproval`（决策对象本身不被信任）、同窗口（pid+windowId）校验；`signal` → 危险动作前 `no_op(cancelled)`，之后 `needs_reconciliation(cancelled)`；流程结束不留半开 attempt（导航 attempt 在下一次 observe 后 verified，危险 attempt 无结论 → unknown）。 |
| `navigate.ts` | `openNewFriends`：通讯录 → 新的朋友 逐步 observe-act-observe（≤3 跳）；任何 dialog → 停止（`unexpected_dialog` / 频繁→`rate_limited`），不点任意"确定"。 |
| `read-requests.ts` | `list_read` fact（coverage、complete、每行 rowKey/status/confidence/hasAction）；零行且非 end_confirmed 不算处理完；partial → `coverage_partial`。 |
| `accept-request.ts` | rowKey 定位（缺/重/低置信 → no_op/ambiguous）→ 打开详情（同名校验）→ `ApprovalRequest`（targetLabel、visibleIdentifier、留言、evidenceIds、identityConfidence）→ 重新 observe → verify-before-write → consume → 一次危险点击 → 后续对话框只允许备注/标签 sheet 的 完成/确定（其他文本一律停）→ 同一 rowKey 变 added 或详情同名出现 发消息 才 `confirmed`；行消失 → `needs_reconciliation`。 |
| `add-friend.ts` | 搜索框 → 输入 typedId → 网络查找 项（无 → `not_found`）→ 弹层点击未落地 / 无 添加到通讯录 → `blocked(capability_missing)`（CR02）→ 验证语字段缺失 → `failed(content_mismatch)` 不发默认语 → 替换后回读必须与批准正文一致 → 审批 → 重新 observe 再核 → 一次点击 发送 → 等待验证/已发送 且无 频繁/失败 → `confirmed`，否则 `sent_unconfirmed`。 |
| `draft-provider.ts` | `DraftProvider` 接口；`fixedDraftProvider`（固定文本，不上传）；`manualDraft(text)`。 |
| `reply-draft.ts` | 白名单 + `resolveTarget` 身份核对（页面 texts 必须出现 displayName）→ 只写 ledger fact，不输入微信；`modelUpload=false` 时只允许固定文本 provider。 |
| `send-message.ts` | 审批 → 重新 observe → 输入框必须 empty（否则 `waiting_user(user_draft_present)`）→ `contextRevisionOf(bubbles)` 与 payload 对比（变化 → `blocked(approval_invalid)` 重审）→ 逐行 type（换行用 shift+return）→ 回读严格一致（NFC、换行、emoji）→ consume → 一次 return → 新 self 气泡（anchorKey 不在 before 集合）且文本一致 → `confirmed`；空框无气泡 → `sent_unconfirmed`；清理只在同窗口、同账号、输入框文本等于本任务刚输入时执行。 |
| `text.ts` | `normText/sameContent/sameLabel`、`contextRevisionOf`（入站气泡文本的 FNV-1a）、sha256/canonicalJson。 |
| `index.ts` | `createHandlers({ settle?, evidenceRetentionDays?, resolveTarget?, drafts? })`；每个 handler 的 `requires` 列出平台方法与动作种类。 |

### 命令与结果

- `npm run typecheck -w @wechat-agent/handlers`：通过。
- `npm test -w @wechat-agent/handlers`：49 passed / 0 failed（已合并 app-skeleton e357cd4，用上 `Ledger.getApproval`）。
- 根 `npm run check`：退出码 0（bans clean，全部 workspace typecheck + test 通过）。
- `scripts/check-ownership.sh d`：clean。

### T 用例状态（全部为 Fake Driver/Recognizer/Ledger 级别，非真机）

| 用例 | 状态 | 测试 |
| --- | --- | --- |
| T16 已过期/已添加 → no_op | passed | `accept-request.test.ts`（列表态 added/expired/rejected；审批期间变 added → no_op 且审批未消费） |
| T19 点击后错误窗口 → 停止、无后续 act | passed | `accept-request.test.ts`（操作失败 / 未知问句 / 频繁；act 恰 2 次，accept attempt=unknown） |
| T20 验证语字段缺失 → content_mismatch，无发送 act | passed | `add-friend.test.ts`（字段缺失 → failed；回读不符 → waiting_user；均无 `send` attempt、无审批） |
| T21 审批期间页面变化 → 重 observe 后不用旧坐标 | passed | `accept-request.test.ts`（按钮位移 → 点击新坐标；详情关闭 → 用新列表行控件；页面变成 chats → blocked，不点） |
| T22 无成功标识 → sent_unconfirmed | passed | `add-friend.test.ts`（无 等待验证 → verification_missing；频繁 → rate_limited；attempt=unknown） |
| T23 已有草稿 → waiting_user | passed | `send-message.test.ts`（act 0 次，审批未消费） |
| T24 中文/emoji/换行回读不符 → 不发送 | passed | `send-message.test.ts`（emoji 丢失、换行变空格；无 bare return、无 `send` attempt、有 input_mismatch fact） |
| T27 空框无气泡 → unknown | passed | `send-message.test.ts`（sent_unconfirmed，attempt=unknown；旧同文气泡不算） |
| T28 contextRevision 变化 → 重审 | passed | `send-message.test.ts`（审批后新入站 → blocked(approval_invalid)、0 act；输入中新入站 → 清理自己的文本后重审） |
| 派发后断连 → unknown → 同 requestId 不重发 | passed | `accept-request.test.ts` + `send-message.test.ts`（act 次数不增、attempt.requestId == 派发的 requestId、state=unknown） |
| 附加：notSent=true 可重规划、写门关闭、账号 revision 变化、审批过期、账本里审批已消费/不存在、窗口变化、取消、unknown 回执、layout_unreadable、无截图 | passed | `accept-request.test.ts` / `registry.test.ts` / `read-requests.test.ts` |

### 未完成 / 已知边界

- 不滚动 新的朋友 列表：目标行不在当前视口且 coverage 非 end_confirmed → `ambiguous(coverage_partial)`，由上层决定是否重试。
- `settle` 默认不等待（Fake 场景）；真机由 lane E 传入一个延时函数。
- `contextRevision` 的定义在本 lane（入站气泡文本的 FNV-1a，见 `contextRevisionOf`，已导出）；lane E/F 需要把草稿 fact 里的 `contextRevision` 原样带进 `SendMessagePayload`。
- 聊天身份核对依赖 `createHandlers({ resolveTarget })` 提供 `TargetRef`，并要求页面 `texts` 中出现 `displayName`；缺 resolver 一律 `blocked(identity_unproven)`。
- 接受流程的最终确认依赖列表行同 rowKey 变 added，或详情面板同名出现 发消息；若识别结果里两者都没有（例如详情遮住列表且无按钮），4 轮后 `needs_reconciliation`。
- 草稿 fact 暂用 `manual_conclusion`（`data.kind = 'reply_draft'`），见下方 INTERFACE REQUEST。

### INTERFACE REQUEST

- `INTERFACE REQUEST: domain.AttemptState 需要增加 'not_sent'（或 Ledger.markNotSent(attemptId, reason)）`：driver 报 `notSent=true` 时平台确定未收到请求，现在只能 `markUnknown('not_sent:<code>')`，lane E 的 Recovery 会把它当 unknown 去 `request.show`。
- `INTERFACE REQUEST: domain.FactKind 需要增加 'draft_written'`：回复草稿目前写成 `manual_conclusion` + `data.kind='reply_draft'`，语义不准。
- `INTERFACE REQUEST: HandlerContext.target?: TargetRef（或 Ledger.getTarget(targetId)）`：handler 拿不到 `conversationTargetId` 背后的 TargetRef（displayName/visibleIdentifier/confidence），现在靠 `createHandlers({ resolveTarget })` 由 lane E 注入。
- `INTERFACE REQUEST: PageFacts 需要 conversation?: { title: string; rect: PixelRect }`：聊天页没有标题字段，现在在 `texts` 里找与 `displayName` 相等的项核对身份，OCR 噪声会误判为 `target_ambiguous`。
