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

