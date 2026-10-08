# WeChat 识别夹具（lane C）

只放**合成**图片。本目录里的每张 PNG 都由脚本生成：

- `scenes.mjs` —— 用 profile 1 的几何（微信 4.1，1280×875 点，深色，2x）构造场景，写出 `scenes/*.json` 和 `*.expected.json`（PageFacts 的期望子集）。
- `render/render.swift` —— AppKit 画布：背景、圆角矩形、系统字体文字 → PNG。编译产物 `render/render` 已 gitignore。
- 重建全部：`npm run fixtures:render -w packages/recognition`。

所有姓名（林小雨、王大为、张小明、李晓华、赵六、合成用户甲…）、微信号（`wxid_synthetic01/02`）、留言都是编造的。禁止提交含真实姓名、头像、手机号、微信号的图片。

| 夹具 | 覆盖 |
| --- | --- |
| `new-friends-mixed` | 7 行：pending/added/expired/waiting_verification/rejected、重名（T11）、截断长昵称与状态合读；右侧申请详情 + 通过验证按钮 |
| `new-friends-green-selected` | T15：整行微信绿 + 已添加 → added；整行绿无状态 → unknown；接受按钮 → pending |
| `new-friends-empty` / `new-friends-header-only` / `new-friends-partial` | T14：零行的 end_confirmed / current_viewport / partial（贴底 + 滚动条滑块） |
| `light-theme` / `wrong-size` / `scale-1x` | T13：主题 / 尺寸不匹配 → unreadable |
| `chats-list` | 聊天列表、红点未读 |
| `chat-open` / `chat-draft` | T26：同文两条气泡；输入框空 / 有草稿；会话标题 |
| `dialog` / `contact-detail` / `add-friend` / `search-results` | 其余页面类型 |
