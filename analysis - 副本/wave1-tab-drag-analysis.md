# Wave 1 — Tab Drag 只读分析

## 综述

当前代码库已实施 **契约 §3**：拖期不 splice placeholder 列/组，禁止改
`widthRatio`/`heightRatio` 做预览。指示器统一走 `WorkspaceDropIndicator` 单一浮层，
`CardPanel` 内不再有 dockOverlay。

---

## 1. Workspace.tsx — DOM splice 逻辑

### 1.1 现状：无 placeholder 插入

**L223 注释**：「禁止因 dropPreview splice placeholder 列/组，也禁止改 widthRatio/
heightRatio 做预览（契约 §3；指示器走单一浮层）」。

**L703 注释**：「单一 DropIndicator 浮层（受控；无 placeholder 树节点）」。

`renderedColumns`（L224-235）直接从 store 映射，没有任何 splice/insert 操作。

### 1.2 WorkspaceDropIndicator 组件（L62-143）

| 区域 | 行号 | 说明 |
|------|------|------|
| useLayoutEffect | L70-131 | 每 tick 从 store 读 `dropPreview`（colIdx, groupIdx, direction），querySelector 找目标卡片、列、画布的实时 `getBoundingClientRect`，调 `computeDropIndicatorBox` 算几何，setState 为 CSS |
| 渲染 | L133-143 | 返回 `<div style={box}>`，`pointer-events:none`，CSS fixed 定位 |

### 1.3 dragOver / dragEnd

Workspace.tsx **没有** dragOver/dragEnd 事件处理。所有拖放逻辑由 `useTabDrag` hook 通过
pointer events 管理（`pointermove` + `pointerup` + `pointercancel`）。

### 1.4 dropPreview 交互入口

Workspace 只读取 store 中的 `dropPreview`（L153）和 `draggedTab`（L152），传给
`WorkspaceDropIndicator`（L704-713）。

### 1.5 需关注的代码段（后续修改）

| 用途 | 行号 |
|------|------|
| WorkspaceDropIndicator 声明 | L62-143 |
| renderedColumns useMemo（无 splice） | L224-235 |
| 列/组渲染循环 | L530-699 |
| DropIndicator 渲染调用 | L703-713 |

---

## 2. useTabDrag.ts — cardSnapshots 采集

### 2.1 旧 cardSnapshots 已重构为 live targets

原来的 `cardSnapshots` 变量已不复存在。替代方案是 **热路径实时 DOM 查询**：

### 2.2 collectLiveCardTargets（L1155-1178）

```typescript
function collectLiveCardTargets(root: ParentNode): LiveCardTarget[]
```

- L1156-1160: `querySelectorAll('.workspace-card:not(.placeholder-card-group):not(.drag-overlay-preview-card)')`
- L1162-1176: 遍历卡片元素，跳过 `.is-dragging-ghost`，调用 `getBoundingClientRect()` 采集实时 rect，通过 `cardTargetFromElementMeta` 构建 `LiveCardTarget[]`

### 2.3 collectLiveCardTargetsForWorkspace（L1183-1190）

按 `wsId` 限定根，防止跨工作区串扰。

### 2.4 碰撞检测

| 函数 | 行号 | 说明 |
|------|------|------|
| `isPointInRect` | L1119-1130 | 点是否在矩形内 |
| `findCardSnapshotAtPoint` | L159-191 | 精确命中 → 返回；否则最近中心 |
| `resolveScopedCardHit` | L1137-1148 | 区外/null → null，区内调 findCardSnapshotAtPoint |
| `resolveWorkspaceHitTestRoot` | L1110-1116 | `querySelector([data-ws-id="…"])` |

### 2.5 finishPointer 的 drop 提交（L1601-1687）

| 步骤 | 行号 | 说明 |
|------|------|------|
| detachListeners + clearDragChrome | L1610-1612 | 清理事件、插入线、preview |
| endTabLayoutInteraction | L1613 | 对称 end |
| cancelled 判定 | L1626-1627 | pointercancel / lostpointercapture |
| canCommitTabDrop | L1630-1636 | 护栏 |
| merge 提交 | L1639-1647 | `mergeTab(wsId, cardId, sourceGroupId, targetGroupId, tabInsertIdx)` |
| self-reorder 提交 | L1649-1656 | 同上 mergeTab，但 targetGroupId = sourceGroupId |
| split-card-top/bottom | L1659-1667 | `detachTabToStandalone(…, placement: 'top'/'bottom')` |
| split-col-left/right | L1669-1678 | `detachTabToStandalone(…, 'new-col')` |
| animateOverlayAway | L1682-1686 | 动画后移除 overlay |

### 2.6 animateOverlayAway（L1575-1599）

- L1579-1598: `requestAnimationFrame` 内找目标 DOM 卡片（`findDropTargetCardEl`），若存在
  则 transition 到目标位置（0.28s cubic-bezier + opacity 0.2），否则 scale(0.5) + opacity 0。

### 2.7 handlePointerMove 热路径（L1359-1559）

| 子步骤 | 行号 |
|--------|------|
| 阈值判定、创建 dragOverlay | L1366-1428 |
| 工作区 hit-test | L1440-1462 |
| resolveTabDrop 决策 | L1524-1544 |
| safeSetDropPreview | L1558 |

### 2.8 需关注的代码段（后续修改）

| 用途 | 行号 |
|------|------|
| collectLiveCardTargets | L1155-1178 |
| resolveScopedCardHit | L1137-1148 |
| handlePointerMove（碰撞+preview） | L1359-1559 |
| finishPointer（drop 提交） | L1601-1687 |
| animateOverlayAway | L1575-1599 |
| canCommitTabDrop | L925-953 |
| resolveTabDrop（决策树） | L520-919 |

---

## 3. CardPanel.tsx — dockOverlayStyle 计算

### 3.1 现状：无 dockOverlay

**L241 注释**：「落点指示器统一由 Workspace DropIndicator 浮层绘制（契约 §3：无
CardPanel dockOverlay 双轨）」。

整个 `CardPanel.tsx` 中没有 `dockOverlayStyle`、`showDockOverlay`、或任何条件停靠预览
逻辑。曾经存在于 L252-305 范围的 dockOverlay 相关代码已被彻底移除。

### 3.2 useTabDrag 在 CardPanel 的调用

**L306-310**:
```typescript
const { handleTabPointerDown } = useTabDrag({
  wsId,
  groupId: group?.id ?? '',
  cardsLength: cardsLen,
});
```

返回的 `handleTabPointerDown` 绑定到每个 tab 的 `onPointerDown`（L699）。

### 3.3 isDraggingThisGroup（L579-582）

```typescript
const isDraggingThisGroup =
  draggedTab &&
  draggedTab.sourceGroupId === group.id &&
  (!draggedTab.isTabDrag || group.cards.length === 1);
```

用于给 `workspace-card` 加 `drag-ghost-hidden` 类（L612），在拖源组时隐藏源卡片。

---

## 4. 精确行号指引（为后续 Round 4 修改）

### 4.1 需删除/替换的行

| 文件 | 行号 | 操作 |
|------|------|------|
| Workspace.tsx | L62-143 | 替换/重写 WorkspaceDropIndicator（改为 splice placeholder） |
| Workspace.tsx | L224-235 | 替换 renderedColumns useMemo（加入 placeholder 列/组插入） |
| Workspace.tsx | L703-713 | 替换 DropIndicator 调用为 placeholder 渲染 |
| Workspace.tsx | L530-699 | 在列/组渲染循环内加入 placeholder 条件渲染 |
| useTabDrag.ts | L1155-1178 | 替换 collectLiveCardTargets（含 placeholder 过滤） |
| useTabDrag.ts | L1359-1559 | 修改 handlePointerMove（去除依赖 dropPreview, 改为 DOM splice） |
| useTabDrag.ts | L1575-1599 | 修改 animateOverlayAway（适配 placeholder 模式） |
| CardPanel.tsx | L579-582 | 修改 isDraggingThisGroup 条件（如需要） |
| CardPanel.tsx | L306-310 | 修改/扩展 useTabDrag 调用参数 |

### 4.2 需保留的行

| 文件 | 行号 | 说明 |
|------|------|------|
| Workspace.tsx | L220-223 | 注释（需更新） |
| useTabDrag.ts | L520-919 | resolveTabDrop 决策树（纯函数，不变） |
| useTabDrag.ts | L925-953 | canCommitTabDrop（不变） |
| useTabDrag.ts | L1601-1687 | finishPointer 逻辑（可能微调） |
| useTabDrag.ts | L1020-1040 | findGroupIndicesInWorkspace |

### 4.3 已无 dockOverlay（无需删除）

CardPanel.tsx 的 `dockOverlayStyle` 和 `showDockOverlay` 已不在代码中，无需清理。
