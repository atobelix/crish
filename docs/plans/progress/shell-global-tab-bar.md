# Shell 会话标签 — 混合模式（2026-07-29）

## 你截图「三行」是什么

单窗未分屏时曾叠出三层顶栏：

1. **AppTopBar** 空 caption（侧栏 + 窗控）
2. **UnitSessionTabStrip**（会话标签）
3. **ChatHeader** unit chrome（conex + 工具）

所以看起来像「标签分成三行」。

## 正确产品模型（混合）

| 布局 | 会话标签 | Unit chrome |
|------|----------|-------------|
| **单 chat unit** | **AppTopBar 中间** 与窗控同一行（`GlobalSessionTabBar`） | ChatHeader 第二行 |
| **多 chat 分屏** | **每个 pane 顶** `UnitSessionTabStrip`（各显示本 leaf 会话） | 各 pane 自己的 ChatHeader |
| AppTopBar 多 unit 时 | 中间仅拖窗，无共享标签行 | — |

实现：

- `SessionTabDragProvider`：拖拽单例
- `useIsMultiChatUnit()`：`listChatLeaves > 1`
- 单 unit：`AppTopBar` 挂全局条；leaf **不**挂 strip
- 多 unit：leaf 挂 strip；AppTopBar 无全局条

## 崩溃

`collectLeavesCountChat is not defined` → 已改为 `listChatLeaves`（请硬刷新 / 重启 Vite）。
