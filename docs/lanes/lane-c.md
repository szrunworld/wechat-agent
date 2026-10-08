# Lane C · Recognition（方案 E05 识别半边）

可写：`packages/recognition/`、`fixtures/wechat/`。消费：`Recognizer`、`PageFacts`、`LayoutProfile`（`packages/ports/src/recognizer.ts`）。起点：`packages/recognition/src/legacy-parse.ts`（旧 parse.ts 的副本）和 `packages/recognition/ocr/ocr.swift`（旧 OCR helper 的副本，已改成读任意图片文件）。

## 交付

1. `createRecognizer(options): Recognizer`；OCR 通过 `ocr/ocr` 子进程（Swift Vision，`npm run build:ocr`），输入是 artifact 图片文件路径或 bytes 落盘后的临时文件；**没有任何截图或输入能力**。
2. `profiles/wechat-4.1-1280x875-2x-dark.json`：把旧 layout 常量版本化为 profile 1（点坐标 × scale = 像素）；`applicability()` 比对 width/height/scale/theme（主题用采样背景色判断），不匹配返回具体 reason，**不猜**。
3. `recognize()` 输出 `PageFacts`：页面类型判定（聊天/通讯录/新的朋友/申请详情/联系人详情/聊天窗口/搜索结果/添加朋友/对话框/未知）、`requests`（含 `status`：pending/added/expired/waiting_verification/rejected/unknown；`actionRect` 仅当识别到可点击的接受控件）、`chats`、`detail`、`bubbles`（side 由气泡位置/颜色判断，`anchorKey`）、`inputBox`（含 `empty`）、`buttons`、`texts`、`warnings`。
4. `coverage`：`current_viewport` 默认；列表底部出现"没有更多"/末尾标记 → `end_confirmed`；滚动条/截断迹象 → `partial`；profile 不适用或 OCR 失败 → `unreadable`（T13/T14）。
5. 歧义：同名/截断名/低置信度在 `RequestRow.confidence` 与 `warnings` 体现；提供 `identityCandidates(rows, name)` 纯函数返回候选与是否 ambiguous（T11）。
6. "绿色不等于接受"：颜色只用于 `warnings` 提示或 actionRect 的辅助，status=pending 必须有文本依据（T15）。
7. 夹具：`fixtures/wechat/` 放**合成**图片（用脚本渲染文字到画布，或对真实截图做不可逆脱敏后裁剪），每张配 `.expected.json`；禁止提交含真实姓名/头像的截图。
8. 性能：单张 2560×1750 识别 < 2 s（记录在 README）。

## 完成条件

- 旧 parse 的 12 个测试迁移后仍通过（改为 `PageFacts` 形状）。
- T11（重名 → ambiguous）、T13（未知尺寸 → unreadable）、T14（零行三种情况分别标 coverage）、T15（绿色选中行不判 pending）、T26（同文旧气泡 anchorKey 不同）有执行过的断言。
- 包内 grep 无 `click|type|key|scroll` 动作调用。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。


---

## 进度记录（2026-10-08，lane-c 分支）

### 交付对照

| 交付 | 状态 | 位置 |
| --- | --- | --- |
| 1 `createRecognizer(options)`，OCR 走 `ocr/ocr` 子进程，path 或 bytes（落 0600 临时文件后删） | 完成 | `packages/recognition/src/recognizer.ts`、`src/ocr.ts` |
| 2 `profiles/wechat-4.1-1280x875-2x-dark.json` + `applicability()` | 完成（主题检查在 `recognize()` 内，见 INTERFACE REQUEST） | `profiles/`、`src/profile.ts` |
| 3 `recognize()` → `PageFacts`：10 种页面类型、requests/chats/detail/bubbles/inputBox/buttons/texts/warnings | 完成 | `src/analyze.ts` |
| 4 `coverage` 四态 | 完成 | `requestSection()` |
| 5 歧义 + `identityCandidates()` | 完成 | `src/identity.ts` |
| 6 绿色不等于接受 | 完成 | `requestSection()` |
| 7 合成夹具 + `.expected.json` | 完成，15 张 | `fixtures/wechat/` |
| 8 性能 | 已记录；空闲机 < 2 s，并行负载下 1.2–3.2 s | `packages/recognition/README.md` |
| 协调者追加：`PageFacts.conversation?: { title, rect }` | 完成（本地交叉类型 `PageFactsWithConversation`，ports 合入后自动兼容） | `conversationTitle()` |

### 完成条件

- 旧 parse 测试：`legacy-parse.test.ts` 实际是 **7 个 `test()`**（任务书写 12），全部迁移到 `test/analyze.test.ts`（PageFacts 形状，像素坐标）并通过；`legacy-parse.ts` 已删除（`legacy/src/parse.ts` 仍是只读参考）。
- 动作调用 grep：`grep -rnE "\.(click|type|key|scroll|press|drag)\(" packages/recognition/src packages/recognition/ocr` 无结果。
- `npm run check`、`scripts/check-ownership.sh c` 退出码 0（见 PR）。

### T 用例状态

| 用例 | 状态 | 断言所在 |
| --- | --- | --- |
| T11 重名 → ambiguous | passed（夹具级） | `test/t11-identity.test.ts`（6 条）+ `test/fixtures.test.ts` "T11 on fixture"（真实 OCR，`new-friends-mixed`） |
| T13 未知尺寸 → unreadable | passed（夹具级） | `test/t13-unreadable.test.ts`（8 条：size/scale/windowFrame/主题/中间灰/OCR 失败/未知 profile/revision）+ fixtures "T13 on fixtures" |
| T14 零行三种 coverage | passed（夹具级） | `test/t14-coverage.test.ts`（4 条）+ fixtures "T14 on fixtures"：end_confirmed / current_viewport / partial（+ unreadable） |
| T15 绿色选中行不判 pending | passed（夹具级） | `test/t15-green.test.ts`（4 条）+ fixtures "T15 on fixture"（整行 #07C160） |
| T26 同文旧气泡 anchorKey 不同 | passed（夹具级） | `test/t26-bubbles.test.ts`（6 条）+ fixtures "T26 on fixture" |

全部是 Fake/夹具级别通过，没有真机证据（真机只由协调者做）。

### 未完成 / 已知限制

- `conversation.input`、`scrollbar`、`theme.samples` 的几何是**估计值**（profile JSON 里标了 `$comment: estimated`），需协调者在真机截图上校核。
- 性能在并行负载下超 2 s（OCR 子进程每次重载 Vision）；可做常驻 helper，未做。
- 非 PNG artifact 没有像素采样 → 主题无法验证 → 按 `unreadable` 返回（不猜）。
- 聊天列表 `unread` 来自角标数字或红色占比；无数字且无红色时为 false。

### INTERFACE REQUEST

- `INTERFACE REQUEST: Recognizer.applicability(image: ImageMeta)` 需要能拿到像素（`ImageInput`，或 `ImageMeta` 增加 `theme?: 'dark' | 'light'` 由平台/调用方采样后填入）—— 原因：任务书要求 `applicability()` 比对主题，但 `ImageMeta` 只有尺寸/scale，同步接口也无法读文件。当前做法：`applicability()` 只比尺寸/scale；主题在 `recognize()` 内采样，不匹配返回 `coverage: 'unreadable'` 并在 `warnings[0]` 写 `theme_mismatch: …`。
- `INTERFACE REQUEST: PageFacts.conversation?: { title: string; rect: PixelRect }`（协调者已宣布将加入）—— 本包已通过 `PageFactsWithConversation` 交叉类型输出该字段；ports 加入后无需改动。
