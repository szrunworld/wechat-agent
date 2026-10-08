# 阶段 4 验收矩阵（2026-10-08）

本页记录**真实环境**下实际执行过的步骤。Fake / 夹具级结果不计入本页；`cases/T01–T42.md` 的 `result` 仍全部为 `not_run`，因为没有一条在授权测试账号上跑过。

## 基线

| 项 | 值 |
| --- | --- |
| wechat-agent | 分支 `platform-baseline-fa2222f`（基于 main `095635a`） |
| AgentDesktop | `main@dddc0db`（含 PR #2 `134b451`，A2 单端点），`scripts/bundle-app.sh` 构建的测试副本 `0.1.0-dev`，build.source `dddc0db3…` |
| 契约快照 | agentdesktop main `fa2222f`，与 `dddc0db` 逐字节一致；sha256 见 `contracts/agentdesktop-runtime-v1/SHA256SUMS` |
| 端点 | 测试副本 `AGENTDESKTOP_SOCKET=/tmp/adt-wx/side.sock` → Runtime 端点 `/tmp/adt-wx/side.runtime.sock`（产品端点为 `~/Library/Application Support/AgentDesktop/runtime.sock`） |
| 身份 | 握手无 `principal`（契约：`runtime.handshake` 结果是 `RuntimeIdentity`，`Principal` 为 PR3 预留）→ 本机 owner，受控开发模式，**不是** CR01 认证 |
| 显示器 | 启动前 1、全程 1、结束后 1：未创建虚拟显示器 |
| 微信 | 未运行；未提供授权测试账号；未操作任何微信界面 |
| 证据 | `evidence/stage4-2026-10-08/`：`env-check.json`、`probe.json`、`app-connect.json`，哈希见同目录 `SHA256SUMS` |

## 步骤结果

| 步骤 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| S0 | 环境检查：契约哈希、端点、握手、能力、状态、微信进程 | 部分：平台侧全部就绪；微信未运行 → NOT READY | env-check.json |
| S1-1 | `runtime.handshake`：product、apiVersion、instance、build | passed | probe.json |
| S1-2 | 主体为配对应用（CR01） | **blocked**：无 principal，`hub.pairing.*` reserved | probe.json |
| S1-3 | 能力覆盖 App 需要的 18 个方法；权限 | passed：64 个方法，缺 0；屏幕录制、辅助功能已授权 | probe.json、env-check.json |
| S1-4 | `runtime.status`、`desktop.list`、`window.list`、`run.list` | passed：desktops 0、runs 0、inputAdmission enabled | probe.json |
| S1-5 | `session.open → run.start`（Run 创建） | **blocked**：没有 Desktop；Desktop 只能由 `desktop.create`（虚拟显示器）创建，阶段 4 禁止 | probe.json |
| S1-6 | 事件订阅走独立连接，关闭订阅不影响控制连接（ADR-02） | passed | probe.json |
| S1-7 | 真 App core 连接向导与功能门禁 | passed（行为符合预期）：discover/contract done，pairing blocked，window failed（无桌面），account blocked；外发 4 项 disabled（pairing_missing / account_unconfirmed），handback capability_missing | app-connect.json |
| S2 | 按 bundleId 识别微信窗口 | **blocked**：微信未运行，无授权账号 | probe.json |
| S3 | 读取会话列表 | **blocked**：依赖 S1-5、S2 | — |
| S4 | 读取测试联系人聊天内容 | **blocked**：依赖 S1-5、S2、授权联系人 | — |
| X-1 | 无效 session 启动 Run → 类型化拒绝，不产生 Run | passed：`not_found`，runs 仍为 0 | probe.json |
| X-2 | 查询未发送过的 requestId → `not_found`（App 不据此判定未发送） | passed | probe.json |
| X-3 | 请求超时 | **blocked**：本地 socket 应答快于 1 ms，无法在真平台触发；仅 Fake Runtime 演练覆盖 | probe.json |
| X-4 | 控制连接关闭后调用 → `connection_lost`，不自动重连 | passed | probe.json |
| X-5 | 窗口变化、人工干预时停止 | **blocked**：需要绑定的微信窗口；仅 Fake Runtime 演练覆盖 | — |

汇总：passed 8（含 S1-7），blocked 9，failed 0。

## A01–A04 对照

| 验收步骤 | 状态 | 说明 |
| --- | --- | --- |
| A01 固定基线 | 部分完成 | 平台、App、契约、显示器已记录；微信版本、测试账号别名缺 |
| A02 干净安装 | 部分完成 | WeChat Agent 包 `verify-install.sh` 33/0（一次性 HOME）；平台测试副本独立运行；未在干净 Mac 上做双 App 安装 |
| A03 配对权限 | **blocked** | CR01（PR3）未落地 |
| A04 只读基线 | **blocked** | 需要 Desktop（虚拟显示器）与授权测试账号 |

## 剩余阻塞

1. **Desktop 与"不创建虚拟显示器"冲突**：AgentDesktop 的 Desktop 只能由 `desktop.create` 创建（虚拟显示器），App 的 session/Run/观察都需要 Desktop。A04 及 S2–S4 要么允许在测试副本里创建一个 Desktop，要么等平台提供"绑定用户主屏窗口"的 Desktop。需要决定。
2. **CR01 配对认证**：`hub.pairing/clients/grants.*` reserved（PR3）；握手不返回 principal。外发保持 blocked。
3. **CR03 接管/归还**：`desktop.takeover/handback/stop` reserved（A5）。
4. **授权测试账号与联系人**：未提供；微信未运行。
5. **超时与窗口变化的真机异常测试**：需要绑定窗口后才能做。
6. 签名、公证、干净 Mac 安装：未做（无 Developer ID）。
7. OCR 依赖可达的 GUI 会话：锁屏时 Vision 失败（识别测试会失败），属于环境问题，不得据此把 GUI 验收标为通过。

## 复现

```bash
# 平台测试副本（agentdesktop main 的独立 worktree）
./scripts/bundle-app.sh
cp -R "build/Agent Desktop.app" /tmp/adt-wx/
open -n -g --env AGENTDESKTOP_SOCKET=/tmp/adt-wx/side.sock "/tmp/adt-wx/Agent Desktop.app"

# wechat-agent
export WECHAT_AGENT_ENDPOINT=/tmp/adt-wx/side.runtime.sock
scripts/stage4-env-check.sh --json
node_modules/.bin/tsx tests/integration/src/stage4-probe.ts --out probe.json
node_modules/.bin/tsx tests/integration/src/stage4-app-connect.ts --out app-connect.json
```
