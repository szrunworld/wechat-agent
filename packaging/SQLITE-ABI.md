# SQLite 在 Electron 里的 ABI：结论与证据（2026-10-08）

对象：`packages/ledger`（lane B）用 **better-sqlite3 12.11.1**（原生模块，`npm install` 时按本机 Node 的 ABI 下载预编译二进制）；`apps/desktop/main`（lane G）用 **Electron 44.7.0** 打包。打包后的主进程跑在 Electron 内嵌的 Node 上，不是本机 Node，所以同一个 `.node` 文件装不上。lane G 的打包之前挂的是 Fake 服务、没有真账本，这个问题直到集成才暴露。

本文件所有数字都是本机实测（macOS 15.1、Apple Silicon、只有 Command Line Tools 没有完整 Xcode、无 Developer ID 证书）。

## 1. 事实

| 项 | 实测 |
| --- | --- |
| 本机 Node | 22.23.2，`NODE_MODULE_VERSION` **127** |
| Electron 44.7.0 内嵌 Node | **24.21.0**，`NODE_MODULE_VERSION` **149**（`ELECTRON_RUN_AS_NODE=1 electron -e 'process.versions'`） |
| 仓库 `node_modules/better-sqlite3` 的二进制 | ABI 127；在 Electron 下 `new Database()` 立即抛：`The module '.../better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 149.` |
| better-sqlite3 12.11.1 的 electron 预编译包 | **没有**：`https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-electron-v149-darwin-arm64.tar.gz` → 404。所以 electron-builder 的 `npmRebuild`（先 prebuild-install 再 node-gyp）也必须走源码编译 |
| `node:sqlite` 在 Electron 44 里 | **可用**（Node 24 内置）：`require('node:sqlite')` 导出 `DatabaseSync, StatementSync, Session, constants, backup` |
| 从源码重编 | 用仓库里已有的 node-gyp 12.4.0（`@electron/rebuild` 4.2.1 的依赖，electron-builder 带进来的）+ Command Line Tools 的 clang 编 SQLite 3.53.2 amalgamation：**24–33 秒**，无需完整 Xcode；头文件从 `electronjs.org/headers` 下载一次到 `~/.electron-gyp/44.7.0` |

## 2. 两条路的比较与选择

| | 路线 1：按 Electron ABI 重编 better-sqlite3（**选用**） | 路线 2：改用 `node:sqlite` |
| --- | --- | --- |
| 可行性 | 本机已证明：重编 24 s，产物在 Electron 下打开数据库返回 sqlite 3.53.2 | 可行：Electron 44 的 Node 24 有 `node:sqlite`；lane B 说只改 `new Database()`、`pragma()`、`transaction().immediate()` 三处 |
| 对 lane B 代码的影响 | **零**：`packages/ledger` 一行不改；36 个单元测试、崩溃边界测试继续在 Node ABI 上跑 | 要改 `sqlite-ledger.ts`、`migrations.ts`（`Database` 类型）、`peekSchemaVersion`，`transaction().immediate()` 要自己用 `BEGIN IMMEDIATE` 包；`pragma(..., {simple:true})` 要换成 `prepare('PRAGMA ...').get()`；`SqliteError.code`（`SQLITE_FULL` 等，T38 靠它判 `disk_full/corrupt`）在 `node:sqlite` 里是 `errcode` 数字 + `code: 'ERR_SQLITE_ERROR'`，停写逻辑要重写 |
| 开发态（`electron .`）与测试态的 ABI | 本机 Node 22 跑测试用仓库二进制（ABI 127）；Electron 用 `build/resources/native` 里的副本（ABI 149），两者并存、互不覆盖 | Node 22.23 的 `node:sqlite` 仍打 `ExperimentalWarning`，而且与 Node 24 的实现版本不同（例如 `backup`、`Session` 在 22 里的行为差异），测试态和打包态跑的是两套 SQLite 绑定 |
| 构建复杂度 | 多一步 `rebuild-native.mjs`（见 §3），需要 CLT；CI 机器要能下载 Electron 头文件 | 无原生步骤 |
| 签名/公证 | 多一个 `.node` 要签（`sign.sh` 已加） | 无 |

选路线 1。理由：lane B 的账本是经过崩溃边界测试的最关键部件，`node:sqlite` 的错误码模型不同会把 T38（停写）重写一遍；而重编在本机只要 CLT、24 秒、脚本化可验证。路线 2 作为后备保留：若将来 CI 不能编译原生模块，按上表改 `packages/ledger` 四处即可。

## 3. 实现

```
npm run package -w apps/desktop/main
  └ prepackage: build.mjs → packaging/prepare.mjs → rebuild-native.mjs
        1. 把 node_modules/better-sqlite3 复制到 apps/desktop/main/build/native/node_modules/（去掉 Node ABI 的 build/）
        2. 在副本目录跑 node-gyp rebuild --runtime=electron --target=44.7.0 --arch=arm64 --dist-url=https://www.electronjs.org/headers --build-from-source
        3. 校验仓库 node_modules 里的 .node sha256 没变（重编绝不动 Node 测试用的那份）
        4. 用 Electron 本体（ELECTRON_RUN_AS_NODE）以 nativeBinding 指向新 .node 打开 :memory:，读 sqlite_version() 与 process.versions.modules，必须等于 149
        5. 复制 package.json / LICENSE / lib / build/Release/better_sqlite3.node 到 build/resources/native/better-sqlite3/，写 native-modules.json
  └ electron-builder extraResources → Contents/Resources/native/better-sqlite3（asar 之外，dlopen 能读）
```

- **为什么不用 `@electron/rebuild` 命令本身**：它的依赖遍历会顺着 workspace 的 hoisting 找到仓库根 `node_modules/better-sqlite3` 并一起重编，结果把 Node ABI 的那份覆盖成 149，`npm test -w packages/ledger` 与所有用真账本的集成测试全部变红（本机实际发生过，已用 `npm rebuild better-sqlite3` 恢复）。所以 `rebuild-native.mjs` 直接调 node-gyp，参数与 `@electron/rebuild` 内部一致，只作用于 `build/native` 的副本，并在重编后断言仓库二进制 sha256 未变。
- **为什么放 `Resources/native/` 而不是 `Resources/node_modules/`**：electron-builder 的 file matcher 对 `extraResources` 也会插入 `!**/node_modules/**`，第一次打包时整个目录被静默丢掉。
- **主进程怎么拿到它**：`build.mjs` 用 esbuild `alias` 把 `better-sqlite3` 指到 `src/native-sqlite.ts`；该文件按 `app.isPackaged` 选 `process.resourcesPath` 或 `build/resources`，`require` 包目录拿到 better-sqlite3 的 JS，再用一个同原型的构造函数把 `nativeBinding` 固定成 `native/better-sqlite3/build/Release/better_sqlite3.node`。这样 `bindings` 包的查找根本不执行，不用随包发 `bindings`/`file-uri-to-path`。lane B 的 `import Database from 'better-sqlite3'` 不变；tsx 测试不经过 alias，照常解析仓库里的 Node ABI 版本。
- **迁移 SQL**：`packages/ledger/src/migrations.ts` 用 `import.meta.url` 找 `../migrations/*.sql`，CJS bundle 没有它。`build.mjs` 把 `import.meta.url` define 成 bundle 自己的 `file://` URL，并把 `packages/ledger/migrations` 复制到 `apps/desktop/main/migrations/`（gitignore），`electron-builder.yml` 把它打进 asar；`verify-install.sh` 断言 asar 里的迁移文件集合与 `packages/ledger/migrations` 完全一致。第一次打包时缺这一步，主进程在 `readdirSync` 处抛未捕获异常，Electron 弹错误框**挂住不退出**（`verify-install.sh` 因此加了 90 s 超时杀进程）。
- 缓存：`build/native/stamp.json` 记录 Electron 版本 / ABI / 模块版本，匹配时跳过重编（打包从 ~60 s 降到 ~30 s）；`REBUILD_NATIVE_FORCE=1` 强制。

## 4. 验证：打包态 ledger smoke

主进程在 spike 模式（`WECHAT_AGENT_SPIKE_OUT=<dir>`，不显示窗口）里多跑一步 `runLedgerSmoke(<dir>/ledger)`（`apps/desktop/main/src/ledger-smoke.ts`）：用 `SqliteLedger.open` 打开 `<dir>/ledger/ledger-smoke.sqlite`（永远不是用户数据目录）→ `health()` → `diagnostics().quickCheck` → `importLegacySuppressions([{key, sourceHash}])` → `isSuppressed(key)` 与一个不存在的 key → `close()` → `health()` 应为 `closed` → 第二个连接重开读回同一条 → 文件头 `SQLite format 3`。结果写到 `<dir>/ledger-smoke.json`，也并入 `startup.json.ledger`。同一段代码在 Node ABI 下有单元测试（`test/ledger-smoke.test.ts`，3 条），所以打包态失败只能是 ABI/打包问题，不是探针本身。

`packaging/verify-install.sh`（T41）新增 9 条断言：包内 `Resources/native/better-sqlite3/build/Release/better_sqlite3.node` 是 arm64 Mach-O bundle、JS wrapper 在、`Resources` 下没有 `node_modules`、`native-modules.json` 记录的 Electron 版本等于本仓库的 electron 且 `verified.modules === modules`、没带 `test_extension.node`/`src`/`deps`、asar 迁移文件集合一致、smoke 的 `ok/electron/modules`（必须 **不等于** 脚本所用 Node 的 ABI）、各步骤值、文件 0600、用户数据目录没有多出数据库。本机在一次性 HOME 下的输出（2026-10-08，33 passed / 0 failed）：

```json
{
  "path": "/var/folders/.../T/tmp.XXXX/ledger/ledger-smoke.sqlite",
  "modules": "149",
  "node": "24.21.0",
  "electron": "44.7.0",
  "ok": true,
  "ms": 6,
  "steps": {
    "health": { "writable": true, "schemaVersion": 2 },
    "quickCheck": "ok",
    "schemaVersion": 2,
    "added": 1,
    "suppressed": true,
    "otherSuppressed": false,
    "healthAfterClose": { "writable": false, "reason": "closed", "schemaVersion": 2 },
    "readBackAfterReopen": true,
    "rows": 1,
    "fileIsSqlite": true
  }
}
```

## 5. 签名与 entitlements

- 主进程仍然**不开 App Sandbox**（SPIKE.md §2.2 的理由不变：Unix socket + OCR helper）。
- Hardened Runtime 加载第三方 `.node`：`entitlements.mac.plist` 已有 `com.apple.security.cs.disable-library-validation`（Electron 自身需要），所以即使 `.node` 签名的 Team ID 不同也能加载；用同一个 Developer ID 签的话连这一项都用不上。**entitlements 不需要改。**
- 公证要求包内每个 Mach-O 都签名，`sign.sh` 新增一步：对 `Contents/Resources/native/**/*.node` 以 `--options runtime` 签名（在 helper 之后、frameworks 之前）。本机无证书，这一步与其余签名一样未实证。

## 6. 未闭环

- CI 要能装 CLT（或 Xcode）并访问 `electronjs.org/headers`；否则 `npm run package` 在 `rebuild-native.mjs` 处失败（故意不降级）。
- 只打 arm64；x64/universal 要按 `--arch` 各编一份（`rebuild-native.mjs` 用 `process.arch`）。
- Electron 升级时 ABI 变，stamp 自动失效重编；但 `electron-builder.yml` 里的 `electronVersion: 44.7.0` 与 `node_modules/electron` 必须一致（脚本读的是后者）。
