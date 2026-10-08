# Lane F · UI（方案 E06 + §14 六屏）

可写：`apps/desktop/renderer/`。消费：`ApplicationService`、`AppSnapshot`、`IpcMethods`（`packages/ports/src/ipc.ts`）和 `sampleSnapshots`（`packages/ports/src/fakes/snapshots.ts`）。渲染层**没有 Node**：只通过 `window.wechatAgent`（preload 暴露的 `ApplicationService` 形状）调用。

## 交付

1. React + TypeScript + Vite（或同类）工程；`npm run dev` 用 Fake service（内存实现 `ApplicationService`，可在界面上切换 `sampleSnapshots` 的每个状态）。
2. 六屏：W01 连接与账号确认（SetupStep 逐步状态与失败定位）、W02 工作台（账号/巡检/三计数/当前任务/暂停/接管）、W03 好友审批（证据卡：昵称、可见标识、留言、截图区、置信度；批准/先跳过；批准仅适用本对象本次）、W04 加好友与回复编辑（会话类型、上下文覆盖说明、草稿编辑、最终正文批准、对象不明则禁用）、W05 任务详情与未知核实（三层结果：平台投递/平台静止/业务核实；时间线；"仅核实"和"我已人工检查"，**没有"再发一次"**）、W06 设置与诊断（权限、策略、保留期、导出脱敏诊断、归还能力缺失的手动指引）。
3. 状态文案：stopping、静止未确认、unknown、平台离线、身份歧义、审批过期、覆盖部分 各自独立；按钮按 `features` 与任务状态禁用；状态不只靠颜色。
4. 可访问性：主控按钮键盘可达、焦点可见；<900px 单栏；长中文/英文昵称与正文不截断身份；截图支持裁剪/放大，默认脱敏。
5. 离屏渲染脚本：对每屏每状态输出 PNG 到 `docs/acceptance/ui/`（此目录归 lane H，所以 PNG 先放 `apps/desktop/renderer/acceptance/`，PR 里说明）。
6. 不包含任何 Driver/平台 act 参数；IPC 调用只用 `IPC_METHODS` 白名单里的方法。

## 完成条件

- 组件测试（Vitest 或 node:test + jsdom）：每屏在 Fake 的全部状态下渲染不报错，关键禁用逻辑有断言（如 identityConfidence 低或 `features.accept_request.enabled=false` 时批准按钮禁用）。
- typecheck 绿；渲染包 grep 无 `require('fs')`/`child_process`。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。


## 进度（2026-10-08，分支 lane-f）

- 工程：React 19 + TypeScript + Vite 7；`npm run dev -w @wechat-agent/renderer` 用 `FakeApplicationService`，页头下拉可切换 13 个 `sampleSnapshots` 状态；URL `?screen=W03&state=unknown_result&panel=0` 可直达。
- 六屏：`src/screens/W01Setup.tsx`（步骤逐项状态 + 失败定位 + 账号确认）、`W02Workbench.tsx`（账号/巡检/三计数/当前任务/暂停恢复/接管）、`W03Approval.tsx`（证据卡 + 批准/先跳过，批准仅本对象本次）、`W04Compose.tsx`（会话类型、上下文覆盖说明、草稿编辑/保存、最终正文批准、加好友表单；对象不明则禁用）、`W05TaskDetail.tsx`（三层结果、时间线、仅核实 / 我已人工检查；没有重发入口）、`W06Settings.tsx`（权限、策略、保留期、脱敏诊断导出、归还手动指引）。
- 文案：`src/copy.ts` 对 stopping / 静止未确认 / unknown / 平台离线 / 身份歧义 / 审批过期 / 覆盖部分 各有独立文案；状态标签都带字形 + 文字，不只靠颜色。
- 规则：`src/rules.ts` 是按钮启用/禁用的纯函数（按 `features`、`inputGate`、任务状态、置信度 ≥ 0.7、账号确认）；禁用时按钮旁列出原因并用 `aria-describedby` 关联。
- 可访问性：所有主控是 `<button>`，`:focus-visible` 描边，skip link；<900px 单栏；`.identity` 用 `overflow-wrap:anywhere`，昵称/正文不截断；`EvidenceViewer` 支持放大/平移（裁剪）/方向键，默认脱敏。
- 测试（vitest + jsdom + testing-library）：`test/screens.test.tsx` 六屏 × 13 状态渲染 + 无"再发"类按钮 + 七种异常态文案互不相同；`test/rules.test.ts` 禁用逻辑；`test/interactions.test.tsx` 关键交互（批准带 revision 与 sha256、低置信度禁用、stopping 禁用、仅核实/人工检查、暂停带 expectedRevision、账号确认、诊断导出）；`test/boundary.test.ts` IPC 白名单与渲染源码无 Node 导入/无平台 act 参数。
- 离屏渲染：`npm run acceptance:render -w @wechat-agent/renderer`（vite dev server + 无头 Chrome，不碰微信）输出 6 屏 × 13 状态 + 每屏一张 <900px 单栏图，共 84 张 PNG 到 `apps/desktop/renderer/acceptance/`（`docs/acceptance/ui/` 归 lane H，由协调者搬）。
- 未完成：留言与截图像素无法从 `TaskView` 得到（见下）；证据查看器的图片源留空，只显示证据编号。
- 根 `package-lock.json` 未随本分支提交（根配置归协调者）：合并后请在根目录 `npm install` 重新生成。

INTERFACE REQUEST: `TaskView.target` 需要 `message?: string`（好友申请留言，方案 W03 证据卡要显示留言；现在只能显示占位）。
INTERFACE REQUEST: `IpcMethods` 需要一个只读的 `evidence.read`（入参 `evidenceId`，返回脱敏后的图片 data URL 或本机路径 + 裁剪框），否则 W03/W05 的截图区只能显示证据编号；渲染层不能自己读文件。
INTERFACE REQUEST: `TaskView` 需要 `pendingContentHash?: string`（待批准内容的哈希由应用核心计算并下发）；现在渲染层用 WebCrypto 对最终正文 / 对象标识自行 sha256，应用核心必须用同一算法才能对上 `task.approve.approvedContentHash`。
INTERFACE REQUEST: `AppSnapshot.policy` 需要 `approvalTtlSeconds` 与 `evidenceRetentionDays`（W06 要显示保留期；W03/W04 的 `task.approve.expiresAt` 现在用渲染层常量 10 分钟）。
