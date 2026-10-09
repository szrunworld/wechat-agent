# WeChat Agent 的 A4 配对接入

依据：Kevin 2026-10-09 裁决的“工作线 B”（先做配对接入，不等 #143），以及 AgentDesktop #137（main `bb02b59`）的 `docs/security/a4-identity.md`。

本次只做配对接入，不包含以下内容：
- 物理窗口 Desktop（#143）；
- 窗口级授权；
- 第四阶段真机验收。

通用 Runtime 契约没有改动。契约快照只是按原样同步到 `bb02b59`。

## 做了什么

| 部分 | 内容 |
| --- | --- |
| 契约快照 | `contracts/agentdesktop-runtime-v1` 同步到 `bb02b59`，SHA256SUMS 已更新。driver 只允许 `hub.pairing.start` / `hub.pairing.status`；其他 `hub.*` 和 `runtime.enableInput` 属于所有者，driver 在本地直接拒绝（`schema.ts`）。 |
| driver | `connect({ credential })`：凭据只放在 `runtime.handshake` 里（控制连接和每条事件订阅连接都带），其他请求一律不带。新增 `startPairing()`、`pairingStatus()`。 |
| 凭据存储 | `CredentialStore` 端口有两种实现：<br>• `MemoryCredentialStore`：默认，每次启动重新配对；<br>• `FileCredentialStore`：文件 0600、目录 0700；其他用户能读或文件格式不对时，拒绝使用。<br>测试只用这两种，不写登录钥匙串。签名 App 改用钥匙串，要等外壳接线和 S4 一起做（见“未做”）。 |
| 连接器 | 状态分为：`unpaired` 未配对、`pairing` 等待确认、`ready` 已配对、`no_access` 授权不可用、`revoked` 已撤销。详见下一节。 |
| 界面（W01） | 有“配对”卡片：<br>• 状态、配对码、申请有效期；<br>• 客户端 ID、代码身份、获批的能力 / 桌面 / 应用 / 到期时间；<br>• AgentDesktop 的拒绝原因（中文）；<br>• “申请配对”或“重新申请配对”按钮；冷却期内按钮禁用。 |
| 错误映射 | 下表。 |

### 错误映射

| Runtime 返回 | 应用里的效果 |
| --- | --- |
| `pairing_required` | 未配对，所有功能显示 `pairing_missing` |
| `client_revoked`，或 `permission_denied` 且 reason 为 `bad_credential` / `code_identity_mismatch` | 已撤销：删除凭据，写入门关闭，不再自动重连 |
| `grant_expired`，或 `grant_missing` 且 reason 为 `no_grant` | 授权不可用：保留凭据，写入门关闭，不循环重试 |
| `grant_missing` 且是具体能力 / 应用缺失（如 `bind_requires_grant`、缺 `observe`） | 只在对应步骤上明确报权限错误，仍保持已配对 |
| `grant_missing` 且 reason 为 `grant_revoked` / `grant_narrowed` | 视为连接被所有者切断：重连一次，看剩下的授权还能做什么 |

### 连接器状态

- **未配对（`unpaired`）**：除配对外不向 Runtime 发任何请求，所有功能都标为 `pairing_missing`，读取也包括在内。
- **等待确认（`pairing`）**：在同一条未配对连接上发 `hub.pairing.start`，再在同一条连接上每 2 秒查一次 `hub.pairing.status`。
  - 结果是“批准”：保存凭据，用凭据重新连接。
  - 结果是“拒绝”：显示 `retryAfter`，本应用一分钟内不再申请。
  - 申请过期，或申请所在的连接断开：申请作废，可以立即再申请。
- **已配对（`ready`）**：能看到什么只取决于 Runtime 返回的内容。配对不等于能看所有窗口。
  - 默认申请的桌面范围是 `created`。当前 Runtime 里没有本应用创建的桌面，所以“窗口”一步显示：“授权范围内没有可用的桌面：物理窗口 Desktop 尚未开放（等待窗口级授权），本应用不创建虚拟桌面”。
- **授权不可用（`no_access`）**：授权过期或被收回。本应用保留凭据，不自行重连。由用户在 AgentDesktop 里续期，然后点“重新检查连接”。这时也不允许再配对一次，以免同一程序出现第二个 clientId（#198 第 2 项）。
- **已撤销（`revoked`）**：凭据被撤销，或 Runtime 不再认可它。本应用删除凭据，关闭写入门，不自动重连，“重新检查”也不会重连。唯一的恢复方式是重新申请配对：新开一条未配对连接，批准后得到一个新的 clientId。

### 申请的授权

见 `packages/app/src/config.ts`。

| 字段 | 申请内容 | 原因 |
| --- | --- | --- |
| capabilities | `observe` | 列出桌面和窗口、observe、读取截图等产物 |
|  | `act` | `session.open` 归在 act 下，observe 必须先开会话 |
|  | `desktop.manage` | `window.bind` |
|  | `run` | Delegated Run 和事件 |
| desktops | `["created"]` | 只申请本应用创建的桌面；所有者可以在授权里另外列出桌面 |
| apps | `["com.tencent.xinWeChat"]` | 只申请微信 |
| 期限 | 1 天 | 到期后由所有者续期 |

## 硬约束是怎么落实的

| 要求 | 落实方式 | 测试 |
| --- | --- | --- |
| 不用所有者身份 | 握手返回 `owner` 时本应用拒绝运行（pairing 步骤 failed，不调用任何方法）；driver 本地拒绝所有者方法 | `T03b`、`schema.test.ts` |
| 不留开发后门 | 没有环境变量或开关能跳过配对。旧的 `principal: owner` 测试模式已从集成测试栈删除：所有集成测试都在 A4 模式的 Fake Runtime 上，以预先批准的配对身份运行 | `tests/integration` 全部 |
| 未配对返回 `pairing_required` | 由 Runtime 判定；Fake Runtime 的 A4 模式按 `RuntimeService+Auth.swift` 实现 | `packages/driver/test/a4.test.ts`；真实 Runtime 探测 P4–P6 |
| 已配对但权限不足时明确报错 | 带 `capability` / reason 的中文说明 | `a4.test.ts`、`pairing.test.ts`（app 和集成两份） |
| 撤销后立即拒绝 | Runtime 切断连接；本应用下一次调用即进入已撤销状态，删除凭据，写入门关闭，不再重连 | 集成测试 `A4 chain` 第 5 步：撤销后计时器空转 5 轮，`connectionsAccepted` 不变 |
| 凭据不外泄 | 快照、日志、诊断导出、发给 Runtime 的非握手请求里都没有 token（已断言） | app 与集成 `pairing.test.ts` |

## 测试

- 新增测试：
  - `packages/driver/test/a4.test.ts`：11 项，真实 driver 对 A4 模式 Fake Runtime；
  - `packages/app/test/pairing.test.ts`：9 项，基于 FakeDriver；
  - `packages/app/test/credentials.test.ts`：3 项；
  - `tests/integration/test/pairing.test.ts`：3 项，全链路为 未配对 → 等待确认 → 已配对 → 收窄授权 → 撤销 → 重新配对（拒绝、冷却、批准），另覆盖 `created` 授权和授权过期；
  - 渲染层：W01 配对界面 3 项，以及 3 个新样例状态 × 6 个页面。
- `npm run check`（禁用项、OCR 构建、类型检查、全部测试）结果见 PR 描述。
- 真实 Runtime：`scripts/pairing-acceptance.sh probe` 不需要人工操作。
  - 对象是一个独立测试副本（`/tmp/adt-wxpair`），构建来源 `b5154f4`，与 main `bb02b59` 的 `Sources/` 和 `contracts/` 完全相同。
  - 9/9 通过，证据在 `evidence/pairing-2026-10-09/probe.json`。
  - 没有发起配对申请，所以没有在屏幕上弹出确认窗口。

## 需要 Kevin 本人做的验收

所有回合都在测试副本上进行：不碰正式端点，不碰真实微信，不发任何消息。Touch ID 由 Kevin 本人操作。

前提：`APP` 指向一个用 agentdesktop main 构建的 `Agent Desktop.app`，例如 `scripts/bundle-app.sh` 的产物。

1. **批准、自我撤销**：
   ```
   APP=".../Agent Desktop.app" scripts/pairing-acceptance.sh approve
   ```
   - 第一次弹窗：核对配对码与终端打印的一致，并核对申请的权限（observe、act、desktop.manage、run；本应用创建的桌面；`com.tencent.xinWeChat`；1 天）。然后点“批准…”，用 Touch ID 确认。
   - 预期：A3 通过（凭据已存为 0600 文件，身份为已配对）；A4 通过（`created` 授权下看不到任何桌面，也不绑定任何窗口）。
   - 第二次弹窗：本应用申请撤销自己的授权（A4 R1）。点“批准…”，用 Touch ID 确认。
   - 预期：最后一次 check 显示“已撤销”，凭据被删除。
2. **拒绝**：
   ```
   APP=... scripts/pairing-acceptance.sh deny
   ```
   - 在弹窗里点“拒绝”。
   - 预期：A5 通过（一分钟内本应用不再申请）；审计记录里有 `user_denied`。

证据写到 `$OUT`（默认 `./pairing-acceptance-out`），不含 token。

## 未做 / 仍受阻

- **第四阶段真机验收仍受阻**，前提没有变：#143（等窗口级授权）、CR01 验收、授权的测试账号。配对完成不会开放任何微信窗口。
- **签名 App 的钥匙串凭据存储**：Electron 主进程目前仍接 Fake 服务（真实服务的接线未做）。接线时需要提供一个钥匙串实现的 `CredentialStore`。这要和 S4 一起做：Developer ID 签名、Data Protection 钥匙串、access group。
- **代码身份等级**：Electron App 在 Runtime 看来是 `shared_interpreter`（#137 文档），确认窗口会如实标出。要等 S4 签名才可能更进一步。
- **断连感知**：本应用在下一次调用失败时才发现控制连接被切断（与原有 T34 设计一致）。撤销本身由 Runtime 立即执行，不依赖本应用及时察觉。
- **集成测试 stub 应用**：`stub-app.ts`（lane H 的模型）仍按旧语义允许未配对时读取。它只用在默认的 stub 切片里，真实应用路径已全部按 A4 运行。
