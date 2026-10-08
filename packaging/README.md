# 打包（lane G）

产物与脚本都在这里；配置里的相对路径以 `apps/desktop/main` 为基准（electron-builder 的 project dir）。包内不得出现 2ndscreen 二进制或路径（`verify-install.sh` 会 grep）。

| 文件 | 作用 |
| --- | --- |
| `electron-builder.yml` | electron-builder 配置：asar、Hardened Runtime、entitlements、`extraResources`（OCR helper、lane F 渲染层） |
| `entitlements.mac.plist` / `entitlements.mac.inherit.plist` | Electron 需要的 JIT entitlements；没有 App Sandbox（原因见 `SPIKE.md` §2.2） |
| `prepare.mjs` | 打包前准备 `apps/desktop/main/build/resources`：编译/复制 OCR helper、复制 `apps/desktop/renderer/dist`（存在时）、写 `manifest.json` |
| `sign.sh` | Developer ID 签名（helper → frameworks → app）；无证书时打印 SKIPPED 并退出 0 |
| `notarize.sh` | `notarytool submit --wait` + `stapler`；无凭据或未签名时跳过 |
| `sbom.sh` | `dist/sbom.cdx.json`（CycloneDX，npm）+ `dist/bundle-manifest.json`（包内每个文件的 sha256） |
| `uninstall.sh` | 只删自身：`.app`、缓存、偏好；账本目录默认保留，`--remove-data` 才删；不碰 AgentDesktop |
| `verify-install.sh` | T41：在一次性 HOME 里跑 安装 → 首次运行 → 升级 → 卸载，24 条断言 |
| `measure-startup.sh` | spike 模式启动 N 次（不显示窗口），记录 ready-to-show、Unix socket 往返、helper 执行 |
| `SPIKE.md` | 选型报告：体积、沙盒、签名可行性、启动时间、结论 |

## 命令

```bash
npm run package -w apps/desktop/main        # build + prepare + .app（packaging/dist/mac-arm64/）
npm run package:dmg -w apps/desktop/main    # 同上并打 dmg
packaging/sign.sh && packaging/notarize.sh  # 有证书时
packaging/sbom.sh
packaging/verify-install.sh                 # T41
packaging/measure-startup.sh
```

`dist/` 已被根 `.gitignore` 忽略。

## 运行时约定

- 用户数据（账本、证据、`shell-state.json`）在 `~/Library/Application Support/WeChat Agent/`；升级与重装不动它。测试用 `WECHAT_AGENT_USER_DATA` 覆盖。
- `WECHAT_AGENT_SPIKE_OUT=<dir>`：spike 模式，不显示窗口，写 `startup.json` 与 `placeholder.png` 后退出；`WECHAT_AGENT_SPIKE_SOCKET` 可指定要探测的 Unix socket。
- `WECHAT_AGENT_FAKE_SNAPSHOT=<SnapshotKey>`：主进程挂的 Fake 服务初始状态（lane E 的真实现接入后移除）。
- 渲染层：优先 `Contents/Resources/renderer/index.html`（lane F 产物），否则 `renderer-placeholder/`。
