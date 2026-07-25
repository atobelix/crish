# Wave 1 参考集成笔记：Round 3 & Round 8 预分析

> 基于 VS Code Sash / SplitView / GridView 源码分析 + react-resizable-panels 拖拽策略
> 生成日期：2026-07-22

---

## 1. VS Code Sash 光标策略的 Crish 适配方案

### 1.1 现状分析

Crish 当前列宽拖拽（`useColumnResize`）存在以下光标问题（R04）：

- **iframe 指针穿透**：拖拽时指针滑入 `<webview>` / `<iframe>` 区域导致 `pointermove` 事件丢失
- **光标闪烁**：拖拽过程中部分子元素覆盖了 cursor 样式
- **无全局光标锁定**：拖拽时光标在快速移动中可能闪烁回默认样式

### 1.2 适配方案

参考 VS Code `sash.ts:529-554`，按以下步骤接入：

#### Step 1: 拖拽开始时注入全局光标样式

在 `useColumnResize` 的 `onDragStart` 回调中添加：

```
// Crish 适配伪代码
const cursorStyle = document.createElement('style');
cursorStyle.id = 'crish-drag-cursor';
cursorStyle.textContent = `* { cursor: ew-resize !important; }`;
document.head.appendChild(cursorStyle);
```

#### Step 2: 禁用 iframe 指针事件

参考 VS Code `sash.ts:514-518`：

```
for (const iframe of document.getElementsByTagName('iframe')) {
  iframe.style.pointerEvents = 'none';
}
```

#### Step 3: 拖拽结束时清理

```
const cursorStyle = document.getElementById('crish-drag-cursor');
if (cursorStyle) cursorStyle.remove();
for (const iframe of document.getElementsByTagName('iframe')) {
  iframe.style.pointerEvents = '';
}
```

#### 封装工具函数

建议提取为 `useGlobalCursor()` hook 或工具函数 `lockCursor(cursor: string)` / `unlockCursor()`，复用在整个 Crish 拖拽系统中。

### 1.3 与现有冻结系统的关系

拖拽光标锁定应与 `beginLayoutInteraction` / `endLayoutInteraction` 生命周期对齐：

| 事件 | 动作 |
|------|------|
| `mousedown` on sash / column divider | `beginLayoutInteraction()` + `lockCursor('ew-resize')` |
| `pointermove` | 拖拽 + resize |
| `pointerup` | `endLayoutInteraction()` + `unlockCursor()` |

---

## 2. VS Code Panel 约束接口分析

### 2.1 IView 接口（SplitView）

从 `splitview.ts:41-117` 提取核心约束：

```typescript
interface IView {
  element: HTMLElement;
  minimumSize: number;
  maximumSize: number;
  priority?: LayoutPriority; // Normal | Low | High
  proportionalLayout?: boolean;
  snap?: boolean;
  onDidChange: Event<number | undefined>;
  layout(size: number, offset: number, context?: TLayoutContext): void;
  setVisible?(visible: boolean): void;
}
```

**适用于 Crish 的点**：

| 接口 | Crish 当前等价物 | 差距 |
|------|-----------------|------|
| `minimumSize` / `maximumSize` | `COLUMN_RATIO_MIN` / `COLUMN_RATIO_PERSIST_MAX` | 基于比例而非像素 |
| `priority` | 无 | 未实现优先级弹性 |
| `snap` | `COLUMN_RATIO_TOOL_COLLAPSED_DETECT` | 隐式阈值，非显式 snap |
| `onDidChange` | Zustand store subscription | 依赖全局 store，非视图自省 |
| `layout(size, offset)` | CSS flex | 无主动 layout 调用 |
| `setVisible` | 无 | 面板隐藏无统一接口 |

### 2.2 建议（Round 3 参考）

Round 3 实现 `useColumnResize` 时，建议引入一个轻量约束接口，至少包含：

```
interface PanelConstraint {
  minWidth: number;   // 像素（从比率换算）
  maxWidth: number;
  onResize(width: number): void;
}
```

这为 Round 8 嵌套布局时的 SplitView 封装做准备。

---

## 3. 拖拽事件流分析

### 3.1 VS Code SplitView 拖拽事件流

```plaintext
Sash.onPointerStart(mousedown)
  → 禁用所有 ViewItem 的 pointer-events
  → 禁用所有 iframe 指针事件
  → 注入全局 cursor style
  → fire _onDidStart(startEvent)
  → 开始监听 pointermove / pointerup
  
pointermove:
  → clamp delta 到 [minDelta, maxDelta]
  → 按 priority 分配 delta 到 upIndexes / downIndexes
  → fire _onDidChange(event)
  
pointerup:
  → 移除 cursor style
  → 恢复 iframe 指针事件
  → 恢复所有 ViewItem 的 pointer-events
  → fire _onDidEnd()
  → fire _onDidSashChange(index)
```

### 3.2 Crish 当前流 vs 目标流

| 阶段 | 当前 Crish | 目标（参考 VS Code） |
|------|-----------|-------------------|
| mousedown | 直接开始拖拽 | 锁定光标 + 禁用 iframe |
| drag | 更新宽比 + store | 更新宽比 + 暂停 ResizeObserver |
| drop | 清理拖拽状态 | 清理 + 恢复 + 触发重排 |

### 3.3 React-resizable-panels 对比

react-resizable-panels 采用纯 React 实现，使用 `pointerdown` / `pointermove` / `pointerup` 事件链，通过 React state 驱动 resize。与 VS Code 的 imperative 模式相比，它更易于集成到 React 生态，但在高性能场景下（多点触控、raf-throttled 更新）不如 VS Code 直接操作 DOM 高效。

**Crish 建议**：由于 Crish 已经是 React 应用且使用 Zustand，推荐混合模式——用 React 管理状态变化，用 imperative 事件处理拖拽（避免 React 的事件合成延迟）。

---

## 4. Round 8（布局序列化）参考建议

### 4.1 VS Code 布局持久化模式

VS Code 的 `layout.ts` 使用 `LayoutStateModel` 模式：

1. **状态快照**：`serializeLayout()` → `{ orientation, views: [{ size, visible, view }] }`
2. **反序列化**：`deserializeLayout(snapshot)` → 恢复所有 View 的 size 和 visible 状态
3. **按需恢复**：不持久化 DOM 引用，只持久化 ID + size
4. **版本化**：快照携带 `version` 字段，支持迁移

### 4.2 Crish 现有序列化（layoutStore.ts）

Crish 已有 `serializeWorkspaceLayout` / `deserializeWorkspaceLayout` 函数（`layoutStore.ts:964-992`）：

```typescript
interface WorkspaceLayoutSnapshot {
  version: number;
  workspaces: Array<{ id: string; columns: ColumnState[] }>;
  sidebarCollapsed: boolean;
  activeWorkspaceIndex: number;
}
```

### 4.3 Round 8 建议

1. **引入 PanelConstraint 接口**（见第2节），使每个 panel 能独立序列化/反序列化
2. **迁移 `widthRatio` → 像素缓存**：参考 VS Code 持久化实际像素而非比例，避免窗口 resize 后比例失真
3. **恢复时验证约束**：反序列化时 clamp size 到 [minSize, maxSize]
4. **嵌套布局支持**：`ColumnState.groups` 内部引入递归的 split view 描述符

```typescript
// Round 8 建议的序列化结构扩展
interface LayoutSnapshotV2 {
  version: 2;
  workspaces: Array<{
    id: string;
    root: SplitNode; // 递归嵌套
  }>;
}

type SplitNode = 
  | { type: 'leaf'; view: ViewDescriptor }
  | { type: 'split'; orientation: 'horizontal' | 'vertical'; 
      children: [SplitNode, SplitNode]; 
      sizes: [number, number] };
```

5. **比例 vs 像素选择**：
   - 持久化时存像素 → 窗口 resize 时用比例重新分配
   - VS Code 模式：persist proportion + 缓存 absolute size
   - Crish 推荐：仿 VS Code 的 `proportions` 数组机制

---

## 5. 总结：两轮关联矩阵

| Round | 当前缺陷 | VS Code 参考 | 具体动作 |
|-------|---------|-------------|---------|
| R3 | iframe 指针穿透 + 光标闪烁 | `sash.ts` 的 CSS 全局 cursor + iframe PE 禁用 | 实现 `lockCursor` / `unlockCursor` 工具 |
| R3 | 拖拽时 ResizeObserver 未挂起 | SplitView 的 `item.enabled = false` | 拖拽开始调用 `beginLayoutInteraction` |
| R8 | 布局序列化无约束校验 | IView.minimumSize / maximumSize | 引入 PanelConstraint 接口 |
| R8 | 嵌套布局无数据结构 | GridView 的 BranchNode/LeafNode 树 | 设计递归 SplitNode 类型 |
