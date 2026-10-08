# Lane G · Shell & packaging（方案 E00 spike + E08）

可写：`apps/desktop/main/`、`packaging/`。消费：`ApplicationService`、`IPC_METHODS`（`packages/ports/src/ipc.ts`）。决定已定：Electron + React；spike 不通过只换壳，视图与 IPC 契约不变。

## 交付

1. Electron 主进程：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；preload 用 `contextBridge` 只暴露 `{ call(method, params), subscribe(listener) }`，`call` 校验 method ∈ `IPC_METHODS`，否则拒绝。
2. 主进程里挂一个 `ApplicationService` 实现（本 lane 用内存 Fake，接口来自 ports；真实现由 lane E 提供，集成时替换）。
3. 窗口生命周期：关窗 → 最小化到菜单栏，首次提示"巡检仍运行"；显式退出 → 调 `app.pause` 等静止后再退出，**不伪造**取消成功；单实例锁。
4. 菜单栏：状态（运行中/停止中/已暂停/离线）、暂停/恢复、打开主窗口、退出。
5. 打包：electron-builder 配置、OCR helper（`packages/recognition/ocr/ocr` 的产物）与 Node 依赖进包、Developer ID 签名与公证脚本（无证书时跳过并说明）、SBOM 生成、升级不动用户数据目录（账本在 `~/Library/Application Support/WeChat Agent/`）、卸载脚本只删自身。
6. **spike 报告** `packaging/SPIKE.md`：空壳体积、沙盒约束（Electron 的 app sandbox 与 Unix socket 连接、helper 执行）、helper 签名可行性、启动时间；结论"通过 / 不通过 + 替代壳建议"。
7. 不包含任何 `2ndscreen` 二进制、路径或环境变量。

## 完成条件

- 本机 `npm run package -w apps/desktop/main` 产出 `.app`，启动显示 Fake 的 W01（lane F 未就绪时用占位页）。
- 脚本化断言：包内 grep 无 `2ndscreen`；preload 只暴露两个方法；非白名单 method 被拒绝（单元测试）。
- T41 的安装/卸载/升级步骤写成脚本 `packaging/verify-install.sh`（可在干净用户目录模拟）。

## 通用规则（所有 lane 相同）

- 读 `docs/plan/00-parallel-work-plan.md` §1 的四条机制和三条禁令；读 `docs/lanes/03-ownership.md`。
- 只改本文列出的可写目录。接口只从 `@wechat-agent/ports` 来；测试里可用 `@wechat-agent/ports/fakes`。不要改 `packages/ports`；需要改接口就在 PR 描述和本文末尾写 `INTERFACE REQUEST: <port>.<member> 需要 …（原因）`，继续用当前接口做能做的部分。
- 不启动、不移动、不点击真实微信；不 exec `2ndscreen`、不 osascript、不模拟真实指针点击；不读 `~/.config/2ndscreen/*.env`。`scripts/check-bans.sh` 会 grep。
- 测试用 `node:test` + `tsx`（`npm test -w <package>`），夹具用合成姓名。T 用例记录默认 `not_run`，只有执行过断言才写 `passed`。
- 包内：`npm run typecheck -w <package>`、`npm test -w <package>` 必须绿；根 `npm run check` 也要绿。
- 完成后开 **draft PR** 到 `app-skeleton`，不要合并；PR 描述列：改了哪些文件、跑了什么命令和结果、T 用例状态、未完成项、INTERFACE REQUEST。
- 别碰别的 lane 的目录，哪怕只是"顺手修一下"。

