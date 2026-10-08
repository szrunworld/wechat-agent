# 壳选型 spike：Electron 44（lane G，2026-10-08）

对象：`apps/desktop/main` 的空壳（主进程 + preload + 占位页 + OCR helper），用 `npm run package -w apps/desktop/main` 打出的 `packaging/dist/mac-arm64/WeChat Agent.app`。本机：macOS 15.1（Darwin 24.1.0）、Apple Silicon、Xcode Command Line Tools（无完整 Xcode）、keychain 里**没有** Developer ID 证书。

所有数字都是本机实测，不是估计；测量脚本是 `packaging/measure-startup.sh`（spike 模式：窗口不显示、dock 隐藏、不抢焦点，拍一张离屏截图后退出）。

## 1. 体积

| 项 | 实测 |
| --- | --- |
| 空壳 `.app`（未签名，`--dir`） | **288 MB**（`du -sh`；bundle-manifest 计 272 个文件 / 287.3 MiB） |
| 其中 Electron Framework（Chromium + Node） | 286 MB |
| 我们自己的代码（`app.asar`） | 32 KB（main.cjs 22 KB、preload.cjs 2 KB、占位页） |
| OCR helper（`Contents/Resources/helpers/ocr`，swiftc -O，arm64） | 88 KB |
| DMG（`npm run package:dmg`，未签名） | **77 MB**（`WeChat Agent-0.1.0-arm64.dmg`，80 740 864 字节） |

说明：没有任何 npm 运行时依赖进包（主进程和 preload 用 esbuild 打成单文件，`@wechat-agent/ports` 内联）；electron-builder 日志 `no node modules found in collection` 证实。体积几乎全是 Electron 本体，`.lproj` 本地化目录 ~55 个可在正式包里裁剪，但影响不到 1 MB。目前只打 arm64；x64/universal 再翻倍。

## 2. 沙盒约束

### 2.1 渲染进程：Chromium 沙盒 + contextIsolation

- `BrowserWindow.webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false }`。
- `sandbox: true` 意味着 preload 不能 `require` 任何 workspace 包，只能 `require('electron')`。所以 preload 由 `build.mjs` 打包成单文件 CJS，白名单（`IPC_METHODS`）内联进去。`verify-install.sh` 断言包内 preload 唯一的 `require` 是 `electron`。
- preload 用 `contextBridge.exposeInMainWorld('wechatAgent', { call, subscribe })`，对象 `Object.freeze`；`call` 在进 `ipcRenderer.invoke` 之前先查白名单。主进程 `ipcMain.handle` 再查一次（第二道门）并校验发送者是本窗口主 frame。
- 实测：打包态占位页里 `window.wechatAgent` 只有 `call, subscribe` 两个键；`call('fs.read')` 被 preload 拒绝（`blocked: method not in IPC whitelist`），没有到达主进程；`call('connection.check')` 走通返回 Fake 的 `ready`。
- 占位页 CSP：`default-src 'none'; script-src 'self'; style-src 'self'`；`setWindowOpenHandler → deny`、`will-navigate` 阻止、`will-attach-webview` 阻止。

### 2.2 主进程：Hardened Runtime，**不是** App Sandbox

- 发行形态是 Developer ID + Hardened Runtime + 公证（`electron-builder.yml: mac.type: distribution, hardenedRuntime: true`），entitlements 只有 Electron JIT 需要的四项（见 `entitlements.mac.plist`），**没有** `com.apple.security.app-sandbox`。
- 为什么不能开 App Sandbox：
  1. 要连 AgentDesktop 的 Unix socket `~/Library/Application Support/AgentDesktop/control.sock`。App Sandbox 下进程只能访问自己的容器 `~/Library/Containers/<id>/Data`，别的 Application Support 目录里的 socket 连不上（需要对方放到 app group 容器或走 XPC/Mach service，平台侧没有这个承诺）。
  2. 要 `execFile` 包内的 OCR helper；App Sandbox 下子进程继承沙盒，helper 读 artifact 图片的路径也必须在容器内。
  3. 不进 Mac App Store，没有必须开 App Sandbox 的理由。
- 实测（打包态、spike 模式、`measure-startup.sh` 起一个临时 Unix socket 服务）：主进程 `net.connect(path)` 连接 + 一次往返 **4–7 ms**，三次全部 `pong`；`execFile(Resources/helpers/ocr, [截图])` 成功，Vision 识别占位页 24 段文字，耗时 1.4–2.9 s（accurate 模式、首次加载模型）。
- 一个真实的坑：macOS `sun_path` 上限 **104 字节**。测试时把 socket 放在 `$TMPDIR/Library/Application Support/AgentDesktop/control.sock`（约 110 字节）会出现 listen `EADDRINUSE` / connect `EINVAL` 这种误导性的错误。真实端点 `/Users/<user>/Library/Application Support/AgentDesktop/control.sock` 在 68 字节左右，不受影响；但 lane A 的 Driver 若允许自定义端点，应校验长度并给出明确错误。
- Electron 自己的用户数据固定在 `~/Library/Application Support/WeChat Agent/`（`app.setPath('userData')`），账本放这里；`verify-install.sh` 证明升级/重装不动它。

### 2.3 Helper 执行与签名可行性

- OCR helper 是单文件 Swift（AppKit + Vision），`swiftc -O` 用 Command Line Tools 1.3 s 编完，无需完整 Xcode。`packaging/prepare.mjs` 在打包前自动编译（有 lane C 预编译产物时直接复制），放到 `Contents/Resources/helpers/ocr`。
- 签名方案（`packaging/sign.sh`）：helper 先以 Hardened Runtime 单独签（`--options runtime`，自定义 identifier `com.wechat-agent.desktop.helper.ocr`，不需要额外 entitlements，Vision 不需要 TCC 权限），再签 Electron 的 frameworks / helper apps，最后签外层 `.app`，然后 `codesign --verify --deep --strict`。公证走 `xcrun notarytool submit --wait` + `stapler`（`packaging/notarize.sh`）。
- **本机没有 Developer ID 证书**：electron-builder 自动跳过签名（日志 `skipped macOS application code signing`），`sign.sh` / `notarize.sh` 都检测到后打印 SKIPPED 并以 0 退出。因此"签名可行性"目前的结论是**流程可行、未在真证书上跑过**；Vision helper 没有 entitlement 依赖，`disable-library-validation` 只是给 Electron 自身，所以我看不到公证会拒的点。拿到证书后跑一遍 `sign.sh && notarize.sh` 即可闭环。
- 未签名的包在本机可以直接从终端或右键"打开"运行（spike 和 verify-install 就是这么跑的）；拷到别的 Mac 会被 Gatekeeper 拦。

## 3. 启动时间

打包态、窗口隐藏、三次连续运行（第一次冷一些）：

| 运行 | 进程启动 → `ready-to-show` | → 占位页 `did-finish-load` |
| --- | --- | --- |
| 一组（打包刚结束，系统忙） | 3354 / 2146 / 2080 ms | 3383 / 2181 / 2136 ms |
| 另一组（空闲） | 2240 / 1470 / 1142 ms | 2430 / 1507 / 1160 ms |

开发态（`electron .`）热启动 1.5 s。结论：**1–2 s 热启动、2–3.5 s 冷启动**到首帧，对一个常驻菜单栏的后台 App 可接受；真正的 W01 是 React 页，再加几百毫秒。

## 4. 退出流程与菜单栏（已实现，属于壳的验证点）

- 关窗 = 隐藏到菜单栏，首次弹一条系统通知"巡检仍在运行"（`shell-state.json` 记一次）。
- 显式退出（托盘"退出"、Cmd+Q、Dock 退出都走 `before-quit`）= `runQuitFlow`：读快照 → 门开则 `app.pause(operationId, expectedRevision)` → 订阅快照直到 `inputGate = closed`（15 s 超时）→ 才 `app.quit()`。`quiescence_unconfirmed`、`app.pause` 失败、超时三种情况各自弹框，按钮是"仍然退出 / 继续运行"，文案明确写"现在退出不会把未完成的动作记为已取消"。壳里没有任何写 `cancelled` 的代码路径。`test/quit.test.ts` 用脚本化服务覆盖了 8 条路径（含"结算后的晚到快照被忽略"）。
- 托盘：状态（运行中/停止中/已暂停/离线/静止未确认）、暂停、恢复、打开主窗口、退出；暂停/恢复只在 running/paused 下可点。
- 单实例锁：`requestSingleInstanceLock`，第二个实例只唤起主窗口。

## 5. 结论

**通过。** Electron 44 + React 作为壳成立：

- 体积 288 MB 是 Electron 的固定成本，对内部分发可接受；若后面要瘦身，替代方案是 Tauri/WKWebView（~10 MB），但要重做 IPC 桥与打包，且 lane F 的 React 视图和 `ApplicationService` 契约不变（方案 §8 已定）。目前没有换壳的理由。
- 沙盒：渲染层沙盒 + contextIsolation 完整落地；主进程必须不开 App Sandbox（Unix socket + helper），Hardened Runtime 够用。
- 签名/公证：脚本就绪，本机无证书所以**未实证**；这是唯一的未闭环项，不是壳的问题。
- 启动 1–3.5 s。

建议：拿到 Developer ID 后由协调者在干净 Mac 上跑 `sign.sh → notarize.sh → verify-install.sh` 各一次；同时让 lane A 校验端点路径长度 ≤ 104 字节。
