# 交互与高度契约（宪法）

> 所有实现 Agent 必须遵守。违反视为未完成，Review 一票否决。

## 1. 虚拟滚动高度生命周期

| 场景 | 允许 API | 禁止 |
|------|----------|------|
| 会话切换 / 消息列表清空 | `VirtualScrollManager.clear()` / `clearHeights()` | 保留旧会话 id 高度当新会话用 |
| 窗口平移 / expand older / 过滤窗口变化 | **仅** `syncOrder(ids)` | `clear()` 全量高度 |
| 容器宽度剧变 | `invalidateAllActual()`（或按 id invalidate） | `clear()` |
| 流式文本更新 | 节流 / 阈值后的 `invalidateActual(id)` | 每个 token 无合并地整表 clear |

权威注释见：`apps/crish-desktop/src/api/VirtualScrollManager.ts`（`syncOrder`：窗口平移应调用本方法，禁止 clear 全量高度）。

## 2. 冻结协议（唯一写入源）

- **唯一写入**：`layoutAnimationStore.startAnimation` / `endAnimation`（或薄封装 Coordinator，内部只调 store）。
- **业务组件禁止**再以「仅 `document.body.classList.add('resizing-active'|...)`」作为唯一冻结信号。
- **兼容期**：允许 store begin/end 时**由统一 helper 同步** body class（`resizing-active` / `window-resizing` / `dragging-card` / `is-layout-frozen`），便于旧 CSS 过渡；最终消费者以 `isLayoutFrozen` 为准。
- **对称清理**：`pointerup` / `pointercancel` / `lostpointercapture` / 组件卸载路径必须 `endAnimation`，禁止永久 frozen。
- **类型约定**：
  - `workspace-resizing` ← 列宽 / 组高 sash
  - `window-resizing` ← OS/浏览器窗口缩放 pulse（R3 `useWindowLayoutFreeze`；独立类型，避免与 sash 共用 Set 无引用计数时误 end；兼容 body class `window-resizing`）
  - `tab-dragging` ← Tab DragSession
  - `sidebar-transition` ← 侧栏过渡（已有）
  - 窗口缩放：**不**复用 `workspace-resizing`；统一走 `window-resizing` + store begin/end

## 3. Tab 拖拽（DragSession）

- 拖拽期间 **layout tree 结构冻结**：禁止 React `splice` 插入 placeholder 列/组并改 widthRatio/heightRatio 做预览。
- 指示器 **只读** `DropIntent` / `dropPreview` 纯数据 + 几何，由 **单一浮层** 渲染（`pointer-events: none`）。
- Hit-test 使用 **实时** `getBoundingClientRect` / `elementFromPoint`，禁止全程只用 pointerdown 静态 `cardSnapshots`。
- `resolveTabDrop` 等 pure helper **禁止**在 resolve 内改 DOM。
- Commit **仅**在 pointerup 成功路径一次调用 store（`mergeTab` / `detachTabToStandalone` 等）。
- 禁止往 tabsBar **插入**假 `.card-tab` 占位；插入线用 fixed/absolute 竖线。
- 禁止 CardPanel 私有 `dockOverlay` 与全局指示器双轨并存（迁移完成后删除私有轨）。

## 4. 消息数据

- `addMessage`（及等价 push）：同 `id` 必须 **upsert 或拒绝双插**，禁止静默重复 append。
- 消息 id 须有足够熵，避免纯 `Date.now()` 碰撞作为唯一来源。

## 5. CSS / 层叠

- 冻结期 iframe/webview：`pointer-events: none` 须覆盖 `is-layout-frozen`、`resizing-active`、`window-resizing`、`dragging-card`。
- 拖拽 z-index 使用 `--z-drag-*` token，禁止 ghost 内联魔法数字与 token 体系冲突。
- 删除 `.placeholder-card-group::before/::after` 双分块装饰（在废 placeholder 路径后）。

## 6. 已知边界（不强制 100%）

- 标题栏纯移动窗口：Web 可能无持续事件；OS 合成卡顿前端无法完全消除。
- 跨浏览器窗口 DnD：本契约不覆盖。

## 7. PR / 完成自检清单（实现 Agent 必填）

- [ ] 未在 `messageWindow.startIndex` 变化时 `clearHeights`
- [ ] 会话切换有 clear 或等价重置
- [ ] 新交互冻结走 store begin/end，且 cancel 路径 end
- [ ] 拖期无 placeholder 列/组进入 React 树（R4 完成后）
- [ ] 相关单测绿
