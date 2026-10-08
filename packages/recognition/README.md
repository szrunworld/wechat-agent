# @wechat-agent/recognition（lane C）

从 artifact 图片文件到 `PageFacts`。本包**只读图片文件**：没有截屏、没有输入、没有子进程之外的任何系统交互（唯一的子进程是 `ocr/ocr`，它也只读文件）。

## 结构

| 文件 | 作用 |
| --- | --- |
| `profiles/*.json` | 版本化 `LayoutProfile`：冻结字段 + 以**点**为单位的实测几何 + 词表。profile 1 = 微信 4.1.x · 窗口 1280×875 点 · 2x · 深色。加 profile = 加一个 JSON，代码不写死版本。 |
| `src/profile.ts` | 加载/校验 profile；`Geometry` 把点几何按 `scale` 换成截图像素。 |
| `src/png.ts` | 纯 node 的 PNG 解码（8 位灰度/RGB/RGBA，非交错）+ `PixelSampler`（亮度、绿/红/白占比、绿色包围盒）。解不了就抛 `PngError`，不猜。 |
| `src/ocr.ts` | `ocr/ocr`（Apple Vision）子进程封装；输出像素坐标的 `TextItem[]`。 |
| `src/analyze.ts` | 纯函数：`TextItem[]` + `Sampler` → `PageFacts`。页面类型、`requests`、`chats`、`detail`、`bubbles`、`inputBox`、`buttons`、`coverage`、`warnings`、`conversation`。 |
| `src/identity.ts` | `identityCandidates(rows, name)`：候选行 + 是否 ambiguous（重名 / 截断 / 低置信度）。 |
| `src/recognizer.ts` | `createRecognizer(options)`：`profiles()` / `applicability()` / `recognize()`；bytes 输入落到 0600 临时文件后删除。 |

## 规则（任务书 → 实现）

- **坐标一律是截图像素**；profile 里的点只在 `Geometry` 里换算。
- **`applicability()`** 只比尺寸（含 `windowFrame`）和 `scale`；主题需要像素，`ImageMeta` 没有，所以在 `recognize()` 里采样 profile 指定的背景条（取中位数）：不是 profile 的主题 → `coverage: 'unreadable'` + `theme_mismatch`；介于深浅之间 → 同样 unreadable（不猜）。见 lane-c.md 的 INTERFACE REQUEST。
- **status 只来自文字**：`接受` → pending（`actionRect` = 文字框 ∪ 绿色包围盒）；`已添加/已过期/等待验证/已发送/已拒绝/已忽略` 按词表；没有文字 → `unknown`。绿色只能产生 warning 或修正 actionRect（T15）。
- **coverage** 只描述列表：下一节标题或"没有更多/暂无新的朋友"等结束标记 → `end_confirmed`；文字贴到侧栏底边或滚动条滑块可见（比左侧行背景亮 ≥30）→ `partial`；只有标题、无证据 → `current_viewport`；profile 不适用 / OCR 失败 / 无文字 → `unreadable`。
- **歧义**：同名行写进 `warnings`（`duplicate name "…"`）；截断名 ×0.8 置信度并 warning；`identityCandidates` 返回 `reason: duplicate_name | truncated_name | low_confidence | not_found`。Vision 的置信度只有 1 / 0.5 / 0.3，阈值默认 0.5。
- **气泡**：side 由位置决定（左对齐 other / 右对齐 self），颜色只用来确认，冲突时 ×0.6 并 warning；`anchorKey = side|文本|y像素|同文序号`，同文旧气泡 key 不同（T26）。
- **页面类型优先级**：dialog > add_friend > search_results > request_detail > contact_detail > new_friends/contacts > chat > chats > unknown。

## 夹具

`fixtures/wechat/*.png` 全部由 `fixtures/wechat/scenes.mjs`（场景）+ `fixtures/wechat/render/render.swift`（AppKit 画布）生成，姓名/微信号/留言都是编造的。重建：`npm run fixtures:render -w packages/recognition`。每张图配 `.expected.json`。

## 测试

```
npm run build:ocr -w packages/recognition   # 一次，编译 ocr/ocr（gitignored）
npm test -w packages/recognition            # 61 个用例：纯层 46 + 夹具（真实 OCR）15
```

没有 `ocr/ocr` 时夹具用例整体 **skip 并打印原因**，不会假装通过。

## 性能（2026-10-08，M 系列 Mac，8 条 lane 并行时测）

`recognize()` 对 2560×1750 的夹具，4 次连续调用：

| 阶段 | 耗时 |
| --- | --- |
| PNG 解码 + 主题采样 | 63–319 ms |
| OCR 子进程（启动 + Vision accurate） | 1060 / 3138 / 1980 / 1314 ms |
| 分析 | 1–8 ms |
| 合计 | 1153 / 3206 / 2304 / 1393 ms |

单独跑 `ocr/ocr` 稳态 0.9–1.0 s，冷启动 1.7 s。**"< 2 s" 在机器空闲时达到，并行负载下不稳定**；主要开销是每次 spawn 子进程重新加载 Vision。后续可选：让 helper 常驻（stdin 循环），未在本 PR 做。
