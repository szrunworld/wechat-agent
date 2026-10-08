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

