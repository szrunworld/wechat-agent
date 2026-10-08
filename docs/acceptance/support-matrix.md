# 支持矩阵（微信版本 × 缩放 × 主题 × 窗口尺寸）

状态只能是 `not_tested | supported | degraded | unsupported`，初始全部 `not_tested`；只有真机步骤 A04/A05 执行后由协调者改，并在对应 T 用例（T12/T13）记录证据。lane C 的 `LayoutProfile` 每新增一个 profile 在这里加一行。

列含义：识别 = `applicability` 返回 applicable 且 T11/T13/T14 夹具通过；输入 = A05 的坐标点击与中文输入通过；证据 = 对应 case 的 `afterEvidenceHash`。

| 微信版本 | 缩放 | 主题 | 窗口尺寸（pt） | profileId | 识别 | 输入 | 证据 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4.1.x | 2x | dark | 1280×875（默认） | `wechat-4.1-1280x875-2x-dark` | not_tested | not_tested | | profile 1（方案 E05） |
| 4.1.x | 2x | light | 1280×875 | | not_tested | not_tested | | 需要新 profile |
| 4.1.x | 1x | dark | 1280×875 | | not_tested | not_tested | | |
| 4.1.x | 1x | light | 1280×875 | | not_tested | not_tested | | |
| 4.1.x | 2x | dark | 非默认（拖大/拖小） | | not_tested | not_tested | | 期望 `size_mismatch → unreadable` |
| 4.1.x | 2x | dark | 1280×875，窗口移动后 | | not_tested | not_tested | | T12：旧 snapshot 必须被拒 |
| 4.0.x 及更早 | — | — | — | | not_tested | not_tested | | 期望 `unknown_version → unreadable`，不硬点 |
| 4.2+ | — | — | — | | not_tested | not_tested | | 布局变化 → T13 |

## 规则

- 未列出的组合视为 `unsupported`；识别到不在矩阵内的组合必须返回 `unreadable`，不得猜测。
- 任一行改为 `supported` 必须同时填证据列（sha256），并在 T12/T13 的记录里填 `testedAt / appCommit / operator`。
