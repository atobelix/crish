# Agent-04: Tab 跨列拖拽指示器与实际落点不一致问题 — 深度分析

> 分析日期：2026-07-22
> 项目版本：crish-desktop (conex)
> 分析范围：useTabDrag.ts, Workspace.tsx, CardPanel.tsx, layoutStore, layoutHelpers, workspaceActions, CSS

---

## 目录

1. [useTabDrag.ts 完整数据流分析](#1-usetabdragts-完整数据流分析)
   - 1.1 拖拽启动（dragStart）：cardSnapshots 采集
   - 1.2 拖拽中（dragOver）：碰撞检测
   - 1.3 拖拽结束（dragEnd）：drop 提交
   - 1.4 DropType 枚举和分支逻辑
2. [跨列拖拽的 DOM splice 机制分析](#2-跨列拖拽的-dom-splice-机制分析)
   - 2.1 Workspace.tsx 中 placeholderCol / placeholderGroup 的 splice 插入
   - 2.2 DOM 结构变化对卡片物理位置的影响
   - 2.3 新旧坐标偏差计算
3. [碰撞检测问题](#3-碰撞检测问题)
   - 3.1 cardSnapshots 的拍摄时机
   - 3.2 静态快照 vs 实时坐标
   - 3.3 碰撞检测函数的具体算法
   - 3.4 drop preview 的渲染逻辑
4. [两种拖拽模式的矛盾](#4-两种拖拽模式的矛盾)
   - 4.1 跨列：DOM splice 重排（破坏布局）
   - 4.2 同列：绝对定位叠加层（不破坏布局）
   - 4.3 两种模式的冲突点
5. [占位元素渲染分析](#5-占位元素渲染分析)
   - 5.1 placeholderGroup 的样式
   - 5.2 ::before / ::after 伪元素的"双分块"问题
   - 5.3 placeholderCol 的渲染
   - 5.4 指示器浮层 `#drop-indicator-{wsId}`
6. [参考项目对比](#6-参考项目对比)
   - 6.1 DnD Kit DragOverlay 架构
   - 6.2 react-beautiful-dnd 的 droppable 实现
   - 6.3 本项目 vs 参考项目的差异
7. [根因结论](#7-根因结论)

---

## 1. useTabDrag.ts 完整数据流分析

### 1.1 拖拽启动（dragStart）：cardSnapshots 采集

`useTabDrag.ts` 第 944-1474 行定义了 hook。拖拽启动的入口是 `handleTabPointerDown`（第 952 行），在 `pointerdown` 事件触发时执行。

**关键代码段（第 1017-1038 行）：**

```typescript
const cardElements = Array.from(
  document.querySelectorAll(
    '.workspace-card:not(.placeholder-card-group)'
  )
) as HTMLElement[];
const cardSnapshots = cardElements.map((el) => {
  const r = el.getBoundingClientRect();
  return {
    element: el,
    rect: {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    },
    colIdx: parseInt(el.getAttribute('data-col-idx') || '0', 10),
    groupIdx: parseInt(el.getAttribute('data-group-idx') || '0', 10),
    groupId: el.getAttribute('data-group-id') || '',
  };
});
```

**关键问题：** 快照在 `pointerdown` 时一次性拍摄，且在尚未进入 dragging 状态时就采集了。这意味着：
- 一旦用户开始拖拽，所有卡片的 `left, top, right, bottom, width, height` 都被冻结
- 无论后续 DOM 如何变化（splice 插入 placeholder），碰撞检测始终使用这些冻结坐标
- `cardSnapshots` 变量是 `handleTabPointerDown` 闭包内的局部变量，在整个拖拽生命周期内永远不会更新

**计时问题：** 快照拍摄和 `isDragging = true` 设置之间还有指针移动阈值判断（`TAB_DRAG_THRESHOLD_PX = 5`）。如果用户在 pointerdown 后立即快速移动，快照依然在 pointerdown 拍摄，与真正的「开始拖拽」之间有延迟。

**过滤问题：** 使用了 `.workspace-card:not(.placeholder-card-group)` 选择器，意图排除占位元素。但问题在于 placeholder 是后来 splice 插入的，初始采集时还没有 placeholder，所以没问题。但在后续拖拽过各中如果 React re-render 导致 DOM 更新，但快照仍然不变，会导致碰撞检测严重偏离。

**快照内容：** 每个 snapshot 包含：
- `element`: 真实 DOM 引用（唯一可以获取实时位置的信息源，但代码从未重新 getBoundingClientRect）
- `rect`: 冻结的坐标快照
- `colIdx/groupIdx/groupId`: 快照时的逻辑索引

### 1.2 拖拽中（dragOver）：碰撞检测

`handlePointerMove`（第 1130-1323 行）是 dragOver 的核心处理函数。

**碰撞检测过程（第 1211-1230 行）：**

```typescript
const matchedSnapshot = findCardSnapshotAtPoint(
  cardSnapshots,
  mouseX,
  mouseY
);

if (!matchedSnapshot) {
  clearIndicator();
  lastDropType = null;
  safeSetDropPreview(null);
  return;
}

const targetRect = matchedSnapshot.rect;
const relX = mouseX - targetRect.left;
const relY = mouseY - targetRect.top;
```

`findCardSnapshotAtPoint` 函数（第 155-187 行）是一个纯几何函数：
1. 遍历所有 snapshots，检查鼠标是否落在某个 snapshot rect 内（`mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom`）
2. 如果没有命中任何 rect，则找最近的中心点（最小欧几里得距离）

**问题：** 当 DOM 发生 splice 后，卡片的实际位置与 `cardSnapshots` 中记录的冻结坐标不一致。鼠标物理位置对应的是实时 DOM 坐标，而碰撞检测使用的是旧坐标。这将导致：
- 鼠标在某个实时卡片区域时，可能命中另一个旧坐标的卡片
- 或完全 miss（`clearIndicator` 执行，预览消失）
- 或命中错误的卡片导致落点决策失误

**坐标计算（第 1224-1226 行）：**

```typescript
const targetRect = matchedSnapshot.rect;
const relX = mouseX - targetRect.left;
const relY = mouseY - targetRect.top;
```

`relX/relY` 是鼠标相对于**冻结快照矩形**的相对位置。如果 DOM 已变化，这个相对位置是错误的，导致 `resolveTabDrop` 接收到错误的坐标，做出错误的落点决策。

**插入线逻辑（第 1268-1285 行）：**

```typescript
const needsInsert =
  hasTabsBar &&
  isDragFromTabButton &&
  relY < tabBarH &&
  (isSelfHover || !isChatGroupTarget(targetGroupId));

if (needsInsert && tabsBar) {
  if (isSelfHover) {
    removeInsertLine();
  }
  const shown = showTabInsertLine(tabsBar, mouseX);
  tabInsertIdx = shown.insertIdx;
}
```

这里的 `tabBarH` 来自 `matchedSnapshot.element.querySelector('.card-header')?.getBoundingClientRect().height`——虽然是实时值（因为使用了实时 DOM 查询），但 `relY` 来自冻结快照，而 `mouseX` 是实时鼠标坐标。这种混用导致插入线位置可能与实际 DOM 排版不一致。

**拖拽 overlay 的渲染（第 1146-1200 行）：**

有两种 overlay 模式：
1. **Tab 拖拽（`isDragFromTabButton`）**：克隆目标元素（`targetEl.cloneNode(true)`），创建 `position: fixed` 的浮层，跟随鼠标移动。尺寸固定为起始 tab 尺寸。
2. **卡片组拖拽（`!isDragFromTabButton`）**：克隆整个 source card（`sourceCard.cloneNode(true)`），创建 `position: fixed` 的浮层。

两种模式的 overlay 都是 `pointer-events: none`，不阻塞底层交互。

### 1.3 拖拽结束（dragEnd）：drop 提交

`finishPointer`（第 1366-1455 行）在 pointerup / pointercancel / lostpointercapture 时执行。

**关键逻辑（第 1391-1446 行）：**

```typescript
const cancelled =
  ev?.type === 'pointercancel' || ev?.type === 'lostpointercapture';

const commit = canCommitTabDrop({
  dropType: lastDropType,
  cancelled,
  sourceGroupId: latestSourceGroupId,
  targetGroupId: lastTargetGroupId,
  tabInsertIdx: lastTabInsertIdx,
});

if (commit && lastDropType) {
  if (lastDropType === 'merge' && lastTargetGroupId) {
    mergeTab(wsId, cardId, latestSourceGroupId, lastTargetGroupId, lastTabInsertIdx);
    destGroupId = lastTargetGroupId;
  } else if (lastDropType === 'self-reorder') {
    mergeTab(wsId, cardId, latestSourceGroupId, latestSourceGroupId, lastTabInsertIdx);
    destGroupId = latestSourceGroupId;
  } else {
    const placement = dropTypeToDetachPlacement(lastDropType);
    if (placement === 'top' || placement === 'bottom') {
      detachTabToStandalone(wsId, cardId, latestSourceGroupId, lastTargetColIdx, placement, lastTargetGroupIdx);
    } else if (placement === 'new-col') {
      detachTabToStandalone(wsId, cardId, latestSourceGroupId, lastTargetColIdx, 'new-col');
    }
  }
}
```

**关键问题：** `lastDropType`, `lastTargetColIdx`, `lastTargetGroupIdx` 等都是在 dragOver 过程中基于**可能错误的碰撞检测**计算并存储的。如果碰撞检测已经偏离真实位置，则 drop 提交的操作（merge / detach / split）将作用于错误的列和组。

**动画（第 1339-1363 行）：**

`animateOverlayAway` 使用 `findDropTargetCardEl` 在 DOM 中查找目标卡片，然后执行平滑过渡动画。注意这个函数是**在 drop 提交之后执行的**，提交可能会改变 DOM（merge/detach），所以 `findDropTargetCardEl` 可能找不到目标卡片，导致 overlay 直接 fade out。

### 1.4 DropType 枚举和分支逻辑

**DropType 定义（第 30-37 行）：**

```typescript
export const DROP_TYPES = [
  'merge',           // 合并到目标 group 的 tab 栏
  'self-reorder',    // 同组内 tab 重排
  'split-card-top',  // 目标 group 上方拆分为新 group
  'split-card-bottom', // 目标 group 下方拆分为新 group
  'split-col-left',  // 目标列左侧创建新列
  'split-col-right', // 目标列右侧创建新列
] as const;
```

**决策树 `resolveTabDrop`（第 365-764 行）：**

`resolveTabDrop` 根据鼠标相对坐标 `(relX, relY)` 和卡片尺寸 `(width, height)` 决定落点类型：

```
Tab drag (isDragFromTabButton === true):
  1. 左右边缘 (< edgeX || > width-edgeX) → split-col-left/right
  2. Chat 列左右分区 → split-col-left/right
  3. 标签栏 (y < tabBarH):
     - selfHover → self-reorder
     - 其他 → merge（需 hasTabsBar）
  4. 标签栏下方：
     - 上 20% → split-card-top
     - 下 20% → split-card-bottom
     - 中心 60% → merge/self-reorder

非 Tab 拖拽 (isDragFromTabButton === false):
  1. selfHover → null (no-op)
  2. Chat 列左右分区 → split-col-left/right
  3. 标签栏 (y < tabBarH) → split-card-top
  4. 左右边缘 → split-col-left/right
  5. 上下边缘 → split-card-top/bottom
  6. 上下半屏 → split-card-top/bottom
```

**分支逻辑依赖的输入：**
- `relX`, `relY`: 来自**冻结快照**的相对坐标
- `width`, `height`: 来自**冻结快照**的尺寸
- `tabBarH`: 来自实时 DOM 测量（混合来源）
- `targetColIdx/GroupIdx/GroupId`: 来自**冻结快照**
- `isSelfHover`: 基于 `targetGroupId === currentSourceGroupId`（但 sourceGroupId 可能已因之前的 merge 更新）

---

## 2. 跨列拖拽的 DOM splice 机制分析

### 2.1 Workspace.tsx 中 placeholderCol / placeholderGroup 的 splice 插入

Workspace.tsx 第 256-334 行是核心的 `renderedColumns` 计算逻辑。当 `dropPreview` 存在时，会动态修改列/组数组：

**列插入（第 264-291 行）：**

当 `direction === 'left' || direction === 'right'` 时：

```typescript
const targetBaseColIdx = baseCols.findIndex(
  (c) => c.origColIdx === colIdx
);
if (targetBaseColIdx >= 0) {
  const insertColIdx =
    direction === 'left' ? targetBaseColIdx : targetBaseColIdx + 1;
  const placeholderCol: RenderedColumn = {
    id: `col-placeholder-${phKey}`,
    origColIdx: -1,
    widthRatio: 0.25,
    groups: [/* placeholder group */],
  };

  baseCols.forEach((c) => {
    c.widthRatio *= 0.75;  // 所有现有列缩小到 75%
  });
  baseCols.splice(insertColIdx, 0, placeholderCol);  // 插入占位列
}
```

**组插入（第 292-331 行）：**

当 `direction === 'top' || direction === 'bottom'` 且 `!draggedTab.isTabDrag` 时：

```typescript
const insertGroupIdx = direction === 'top' ? groupIdx : groupIdx + 1;
// 计算均匀高度
const evenHeight = 1 / numGroups;
const placeholderGroup: RenderedGroup = {
  id: `group-placeholder-${phKey}`,
  origGroupIdx: -1,
  heightRatio: evenHeight,
  // ...
};

// 调整现有组高度
col.groups.forEach((g) => { g.heightRatio = evenHeight; });
col.groups.splice(insertGroupIdx, 0, placeholderGroup);
```

**重要条件：** 组的 splice（`direction === 'top' || direction === 'bottom'`）在 `draggedTab.isTabDrag` 时为 true 的情况下**跳过**（第 293-295 行）：

```typescript
if (draggedTab.isTabDrag) {
  return baseCols;  // 直接返回，不插入 placeholderGroup
}
```

这意味着：tab 拖拽的上下拆分**不会触发 DOM splice**，只触发 `dropPreview` 状态更新。

### 2.2 DOM 结构变化对卡片物理位置的影响

当 splice 插入 placeholder 时，React 会重新渲染整个列/组列表，导致：

1. **列插入场景：** 插入新列后，所有右侧列右移，宽度缩小到 75%。原有卡片在 DOM 中的 `left` 坐标发生变化，但 `cardSnapshots` 中记录的 `left` 仍然是旧值。

2. **组插入场景（非 tab 拖拽）：** 插入新 group 后，所有组高度重算为均匀分布（`evenHeight = 1/numGroups`）。原有卡片在 DOM 中的 `top` 和 `height` 发生变化，但 `cardSnapshots` 中的值冻结不变。

3. **占位列折叠（第 146-152 行）：** 当源列被掏空且 drop 预览在远处的列时，源列会被隐藏（`shouldHideSourceCol = true`）。这会导致：
   - 源列从 DOM 中移除
   - 剩余列宽度重新归一化
   - 卡片物理位置大幅偏移
   - `cardSnapshots` 中的坐标完全失效

### 2.3 新旧坐标偏差计算

以 3 列等宽布局为例：

**初始状态：**
- Col A: widthRatio = 0.33, left = 0%
- Col B: widthRatio = 0.33, left = 33%
- Col C: widthRatio = 0.33, left = 66%

**cardSnapshots 在 pointerdown 时采集：**
- Card A: left = 0, width = W * 0.33
- Card B: left = W * 0.33, width = W * 0.33
- Card C: left = W * 0.66, width = W * 0.33

**用户拖到 Col C 右侧（split-col-right），splice 后：**
- Col A: widthRatio = 0.33 * 0.75 = 0.2475, left = 0%
- Col B: widthRatio = 0.33 * 0.75 = 0.2475, left = 24.75%
- Col C: widthRatio = 0.33 * 0.75 = 0.2475, left = 49.5%
- Placeholder: widthRatio = 0.25, left = 74.25%

**实时坐标与快照偏差：**
- Card B 实际 left = W * 0.2475，快照 left = W * 0.33，偏差 = W * 0.0825（约 8% 视口宽度）
- Card C 实际 left = W * 0.495，快照 left = W * 0.66，偏差 = W * 0.165（约 16.5% 视口宽度）

在 1920px 视口宽度下，Card C 的偏差可达 317px。当鼠标移动到 Card C 的真实位置时，碰撞检测会认为鼠标在 Card C 的快照区域（旧位置），实际上可能已经落在 placeholder 区域或空白区域，导致 `findCardSnapshotAtPoint` 返回错误结果。

**组插入场景偏差（2 组等高管）：**
- Group A 初始高度 = 50%，快照 top = 0，height = H * 0.5
- Group B 初始高度 = 50%，快照 top = H * 0.5，height = H * 0.5

Splice 插入第 3 组后：
- 三组均匀：各 33.3%
- Group B 实际 top = H * 0.333，快照 top = H * 0.5，偏差 = H * 0.167
- Group B 实际 height = H * 0.333，快照 height = H * 0.5，偏差 = H * 0.167

在 1080px 视口高度下，偏差可达 180px。

---

## 3. 碰撞检测问题

### 3.1 cardSnapshots 的拍摄时机

`cardSnapshots` 的拍摄时机是 `handleTabPointerDown` 中的 `pointerdown` 事件处理阶段（第 1017-1038 行）。具体时序：

1. 用户 pointerdown 在 tab 上
2. `handleTabPointerDown` 被调用
3. **立即**采集 `cardSnapshots`（此时 isDragging = false）
4. 注册 `pointermove` / `pointerup` 监听器
5. 用户移动指针，超过 5px 阈值后 `isDragging = true`
6. 触发 `setDraggedTab` 设置 store 状态
7. React re-render → Workspace.tsx 检测到 `draggedTab` → 可能触发 splice

关键点：**snapshot 在真正的 DOM 变化之前拍摄**，且在后续整个拖拽过程中永不更新。这是所有碰撞检测问题的根源。

### 3.2 静态快照 vs 实时坐标

对比两种方案：

| 特性 | 静态快照（当前方案） | 实时坐标（推荐方案） |
|------|---------------------|---------------------|
| 性能 | 无额外开销 | 每次 pointermove 都要 querySelectorAll + getBoundingClientRect |
| 准确性 | 仅首次准确 | 始终保持准确 |
| 与 DOM splice 兼容性 | 完全不兼容 | 完全兼容 |
| 实现复杂度 | 低 | 中 |
| 对 React re-render 的敏感性 | 不敏感（snapshot 不变） | 敏感（但准确） |

当前方案选择静态快照的**唯一优势是性能**，但付出的代价是拖拽过程中一旦 DOM 变化，整个碰撞检测系统就失效了。

### 3.3 碰撞检测函数的具体算法

**`findCardSnapshotAtPoint`（第 155-187 行）：**

```typescript
export function findCardSnapshotAtPoint<T extends { rect: CardSnapRect }>(
  snapshots: readonly T[],
  mouseX: number,
  mouseY: number
): T | null {
  if (!snapshots || snapshots.length === 0) return null;
  
  // 第一阶段：精确命中检测
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const r = snap.rect;
    if (mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom) {
      return snap;
    }
  }
  
  // 第二阶段：最近中心回退
  let best: T | null = null;
  let minDistance = Infinity;
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const r = snap.rect;
    const centerX = r.left + r.width / 2;
    const centerY = r.top + r.height / 2;
    const dist = Math.hypot(mouseX - centerX, mouseY - centerY);
    if (dist < minDistance) {
      minDistance = dist;
      best = snap;
    }
  }
  return best;
}
```

**算法分析：**

第一阶段（精确命中）在 DOM 变化后会严重失效：
- 如果卡片已右移（splice 插入列后），鼠标在新位置点击，但快照中的 rect 是旧位置
- 鼠标可能落在两个快照之间的"间隙"中（实际 DOM 已连续，但快照不连续）
- 也可能鼠标落在某个快照内（旧位置），但实际 DOM 中该位置已是不同卡片

第二阶段（最近中心回退）稍微鲁棒一些，但仍然基于错误的快照坐标。它会找到距离鼠标最近的快照中心，但这个"最近的"可能是错误的卡片。

**竞态条件：** 当鼠标位于多个卡片快照的间隙时，第二阶段会被触发。在 DOM splice 后，这种间隙可能非常大（如上所述 317px 偏差），导致选择完全错误的卡片。

### 3.4 drop preview 的渲染逻辑

**setDropPreview（第 1040-1051 行）：**

```typescript
const safeSetDropPreview = (nextPreview: DropPreviewState | null) => {
  const currentPreview = getWorkspaceStoreState().dropPreview;
  if (!nextPreview) {
    if (currentPreview !== null) {
      setDropPreview(null);
    }
    return;
  }
  if (!dropPreviewEquals(currentPreview, nextPreview)) {
    setDropPreview(nextPreview);
  }
};
```

这是一个优化函数，避免在 dropPreview 未变化时触发无意义的 React re-render。`dropPreviewEquals`（第 801-812 行）进行浅比较。

**preview 流向：**
1. `handlePointerMove` → `resolveTabDrop` → `resolved.preview`
2. `safeSetDropPreview` → `setDropPreview` → zustand store 更新
3. Workspace.tsx 的 `renderedColumns` 检测到 `dropPreview` 变化
4. React re-render → splice 插入 placeholder / 调整宽度/高度
5. CardPanel.tsx 检测到 `isTargetPanel` → 渲染 `dockOverlayStyle`

**问题 1：** preview 的计算基于可能错误的碰撞检测。如果 `matchedSnapshot` 返回错误的卡片，preview 的 `colIdx/groupIdx/direction` 都是错的。

**问题 2：** preview 触发 DOM splice，而 splice 又进一步恶化碰撞检测的准确性，形成**正反馈循环**——错误越累积越严重。

---

## 4. 两种拖拽模式的矛盾

### 4.1 跨列：DOM splice 重排（破坏布局）

跨列拖拽（split-col-left / split-col-right）使用 DOM splice：

1. `resolveTabDrop` 计算落点为 `split-col-left` 或 `split-col-right`
2. `safeSetDropPreview` 设置 `{ colIdx, groupIdx: 0, direction: 'left' | 'right' }`
3. React re-render → `renderedColumns` 检测到 dropPreview
4. 创建 `placeholderCol`，`baseCols.splice(insertColIdx, 0, placeholderCol)`
5. 所有现有列 `widthRatio *= 0.75`
6. 实际 DOM 发生重排：列右移、宽度变化

**跨组（非 tab 拖拽）也使用 splice：**
1. `renderColumns` 创建 `placeholderGroup`
2. 计算 `evenHeight = 1/numGroups`
3. `col.groups.splice(insertGroupIdx, 0, placeholderGroup)`
4. 实际 DOM 发生重排：组下移、高度变化

### 4.2 同列：绝对定位叠加层（不破坏布局）

同列拖拽（merge / self-reorder）以及 tab 拖拽的上下拆分（`split-card-top/bottom` 在 `isTabDrag` 时）使用**绝对定位叠加层**：

**CardPanel.tsx（第 247-305 行）：**

```typescript
const showDockOverlay = !!(
  isTargetPanel && draggedTab && draggedTab.isTabDrag
);
const dockOverlayStyle = React.useMemo<React.CSSProperties | null>(() => {
  if (!showDockOverlay || !dropPreview) return null;
  const { direction } = dropPreview;
  if (direction === 'merge') {
    return {
      position: 'absolute',
      top: '6px', left: '10px', right: '10px',
      height: '32px',
      // ... 半透明蓝色虚线框
      pointerEvents: 'none',
      zIndex: 'var(--z-drag-highlight)',
    };
  } else if (direction === 'top') {
    // 上 50% 半透明区域
  } else if (direction === 'bottom') {
    // 下 50% 半透明区域
  }
  return null;
}, [showDockOverlay, dropPreview]);
```

**绝对定位叠加层（`dockOverlayStyle`）的特性：**
- `position: absolute` 相对于 `.workspace-card`（父级 `position: relative`）
- `pointer-events: none` 不阻塞交互
- 不改变 DOM 布局（`position: absolute` 脱离文档流）
- 通过 CSS `animation: pulse-merge-highlight` 实现闪烁效果

### 4.3 两种模式的冲突点

**根本矛盾：** 跨列/跨组使用 DOM splice 改变了卡片物理位置，而同列 merge 在同一次拖拽过程中依赖静态快照做碰撞检测。这两种模式在同一套碰撞检测系统中共存，但各自对 DOM 的副作用不同。

**具体冲突点：**

1. **拖拽路径切换问题：** 用户从 Col A 跨列拖到 Col B（触发 splice 插入 placeholderCol），然后又回到 Col A（此时 cardSnapshots 中的 Col A 坐标已过时，因为所有列宽度都变为了原来的 75%），碰撞检测会产生漂移。

2. **合并目标定位：** 当 placeholder 列占据物理空间后，真正的目标列被挤到旁边。碰撞检测可能命中 placeholder（但因为 `.placeholder-card-group` 被排除在初始采集之外，所以 snapshot 中根本没有 placeholder），导致 `findCardSnapshotAtPoint` 返回 null，预览消失。

3. **"幽灵"预览：** 用户看到 drop indicator（dockOverlayStyle / placeholderCol / placeholderGroup）在一个位置，但实际 drop 时 `lastTargetColIdx` 是基于错误碰撞检测算出的值，两者指向不同位置。

4. **self-reorder 与 splice 的不兼容：** 同组重排不应该触发任何 DOM 变化，但如果同时有跨组 dropPreview 存在，splice 已改变了 DOM，self-reorder 的碰撞检测也受影响。

5. **tab 拖拽的特殊性：** `isTabDrag` 时上下拆分不触发 splice（直接返回 `baseCols`），但左右拆分仍然触发列 splice。这意味着同一次拖拽中，移动路径从列边缘进入卡片内部，会突然从"触发 splice 的模式"切换到"不触发 splice 的模式"。

---

## 5. 占位元素渲染分析

### 5.1 placeholderGroup 的样式

**Workspace.module.css（第 234-252 行）：**

```css
.placeholderCardGroup {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1.5px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 40%, transparent);
  background: color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent);
  backdrop-filter: blur(4px);
  justify-content: center;
  align-items: center;
  font-size: var(--font-size-xs, 11px);
  color: var(--text-secondary);
  margin: var(--space-1, 4px);
  border-radius: var(--radius-sm, 6px);
  gap: var(--space-1, 4px);
  padding: var(--space-2, 6px);
}
```

**shell-workspace.css（第 1232-1249 行）：**

```css
.app-container .workspace-card.placeholder-card-group,
.placeholder-card-group {
  background: color-mix(in srgb, var(--border-color) 10%, var(--bg-secondary, #f9f9fb)) !important;
  border: none !important;
  border-radius: var(--radius-lg) !important;
  display: flex !important;
  flex-direction: column !important;
  justify-content: center !important;
  align-items: center !important;
  gap: var(--space-2) !important;
  padding: var(--space-4) !important;
  padding-top: 52px !important;
  position: relative !important;
  overflow: hidden !important;
}
```

注意两个文件都定义了 `.placeholderCardGroup` / `.placeholder-card-group`，shell-workspace.css 用 `!important` 覆盖了模块 css。这种双源定义存在维护风险。

### 5.2 ::before / ::after 伪元素的"双分块"问题

**shell-workspace.css（第 1260-1288 行）：**

```css
.placeholder-card-group::before {
  content: "" !important;
  position: absolute !important;
  top: 10px !important;
  left: 10px !important;
  right: 10px !important;
  height: 32px !important;
  background: var(--bg-primary, #ffffff) !important;
  border: 1px solid color-mix(in srgb, var(--border-color) 35%, transparent) !important;
  border-radius: var(--radius-md) !important;
  z-index: var(--z-decorative) !important;
  pointer-events: none !important;
}

.placeholder-card-group::after {
  content: "" !important;
  position: absolute !important;
  top: 52px !important;
  bottom: 10px !important;
  left: 10px !important;
  right: 10px !important;
  background: var(--bg-primary, #ffffff) !important;
  border: 1px solid color-mix(in srgb, var(--border-color) 35%, transparent) !important;
  border-radius: var(--radius-md) !important;
  z-index: var(--z-decorative) !important;
  pointer-events: none !important;
}
```

**"双分块"设计意图：**
- `::before`: 模拟一个 32px 高的 tab 栏（对齐真实 card-header 高度）
- `::after`: 模拟卡片主体区域（tab 栏下方剩余空间）
- 这样做的目的是让 placeholder 看起来像一个真实的卡片（有 tab 栏 + 内容区），使得用户能看到 tab 被插入后的视觉效果

**问题：**
1. 两个分离的白块视觉上不连续，且与真实卡片的 border-radius 不完全一致
2. `52px` 的 harcoded top 值（10px top padding + 32px ::before height + 10px gap）对某些主题/缩放不够灵活
3. 与 `backdrop-filter: blur(4px)` 一起使用时可能出现重影
4. ::before 和 ::after 的 border 分别渲染，在连接处有 10px 间隙，视觉上不连贯

### 5.3 placeholderCol 的渲染

**Workspace.tsx（第 705-727 行）：**

```tsx
<div
  className={
    isPlaceholderCol
      ? `${styles.placeholderCol} workspace-column--placeholder`
      : `${styles.column} workspace-column`
  }
  style={isPlaceholderCol ? undefined : { width: `${col.widthRatio * 100}%` }}
>
  {col.groups.map((group, groupIdx) => {
    const isPlaceholderGroup = group.origGroupIdx === -1;
    return isPlaceholderGroup ? (
      <div className={`${styles.placeholderCardGroup} workspace-card placeholder-card-group`}>
        <Plus size={16} /><span>{group.cards[0].title}</span>
      </div>
    ) : (
      <CardPanel ... />
    );
  })}
</div>
```

**问题：** placeholderCol 没有 `width` 样式（`style={isPlaceholderCol ? undefined : ...}`），它的宽度由 flex layout 隐式决定。虽然 `Workspace.module.css` 中 `.placeholderCol` 有 `flex: 1` 和 `margin: var(--space-3)`，但实际渲染时，由于 `renderedColumns` 中的 `widthRatio` 已被 splice 修改（所有现有列 * 0.75），且 placeholder 也有 `widthRatio: 0.25`，flex 的隐式计算可能不够精确。

另外，`.workspace-column--placeholder` 在 `shell-workspace.css`（第 1216-1229 行）中定义：

```css
.workspace-column--placeholder {
  background: var(--shell-inset-bg, var(--bg-secondary, #f2f2f2)) !important;
  border: none !important;
  border-radius: var(--radius-lg) !important;
  padding: 0 !important;
  margin: var(--space-3, 8px) !important;
  flex: 1 !important;
  height: calc(100% - var(--space-3) * 2) !important;
}
```

`margin: var(--space-3)` 给占位列添加了 8px 间距，但正常列 `.workspace-column` 没有 `margin`。这导致占位列的渲染位置与其他列不一致。

### 5.4 指示器浮层 `#drop-indicator-{wsId}`

**Workspace.tsx（第 843-848 行）：**

```tsx
<div
  id={`drop-indicator-${ws.id}`}
  className="drop-indicator"
  aria-hidden="true"
  style={{ display: 'none' }}
/>
```

这是一个空的 div，id 为 `drop-indicator-{wsId}`。在 `useTabDrag.ts` 中通过 `getIndicator()` 函数（第 1053-1056 行）获取引用，然后通过 `style.display = 'none'` 或设置自定义属性来控制。

**但整个代码库中没有任何地方设置这个 div 的 `style.display = 'block'` 或修改其尺寸/位置。** `getIndicator()` 只被以下函数调用：
- `clearIndicator()`（第 1071-1078 行）：设置 `display = 'none'`
- 在 `finishPointer` 中被 `clearIndicator()` 间接调用

这意味着 `drop-indicator` div **在当前代码库中完全未被使用**。它是一个残留的、空的、永远不可见的 div。

---

## 6. 参考项目对比

### 6.1 DnD Kit DragOverlay 架构

**核心设计：**
- DragOverlay 是一个独立的 React 组件树，渲染在 `position: fixed` 层
- 不受 droppable 容器的影响（在 DOM 树中位于 `document.body` 或 portal 中）
- 使用 `useDndContext` 获取 active / over / transform 状态
- transform 由 `applyModifiers` 链处理，允许自定义偏移/约束
- `DropAnimation` 在 dragEnd 时执行平滑动画

**碰撞检测（CollisionDetection）：**

DnD Kit 的碰撞检测函数签名：

```typescript
export type CollisionDetection = (args: {
  active: Active;
  collisionRect: ClientRect;       // 实时碰撞矩形（通常是 overlay 的 rect）
  droppableRects: RectMap;         // 实时 droppable 容器的 rect map
  droppableContainers: DroppableContainer[];
  pointerCoordinates: Coordinates | null;
}) => Collision[];
```

关键点：
- `collisionRect` 是**实时计算**的（每次 dragOver 时从 overlay 的 getBoundingClientRect 获取）
- `droppableRects` 也是**实时更新**的
- 内置各种碰撞检测算法（closestCenter, closestCorners, rectIntersection 等）

**与当前项目的对比：**
- DnD Kit 没有使用"静态快照"——所有坐标都是实时获取的
- DragOverlay 独立于布局 DOM，不触发 React re-render 导致的布局变化
- 碰撞检测的 `collisionRect` 基于实时 overlay 位置，而非冻结坐标

### 6.2 react-beautiful-dnd 的 droppable 实现

**核心设计：**
- `<DragDropContext>` 是整个拖拽系统的根组件
- `<Droppable>` 定义可放置区域，每个区域有唯一的 `droppableId`
- `<Draggable>` 定义可拖拽元素
- 使用 `react-with-direction` 处理 RTL

**碰撞检测：**
- rbd 使用 `getBoundingClientRect` 实时计算 droppable bounds
- 使用 `axis` 属性（x/y）限定拖拽方向
- 拖拽过程中动态计算 placeholder 在列表中的位置

**placeholder 设计（与当前项目的关键区别）：**
- rbd 中的 placeholder 是**纯视觉的**（不参与碰撞检测计算）
- placeholder 尺寸由被拖拽元素决定，插入不会改变其他 draggable 的位置计算
- 同列重排使用**绝对定位叠加层**，而非 DOM splice

### 6.3 本项目 vs 参考项目的差异

| 维度 | DnD Kit / rbd | 本项目 |
|------|--------------|--------|
| 碰撞检测数据源 | 实时 getBoundingClientRect | 静态 cardSnapshots (一次拍摄) |
| DragOverlay | 独立 portal，position: fixed | 直接 appendChild 到 body |
| 占位元素 | 纯视觉指示器 | DOM splice 改变真实布局 |
| 碰撞检测算法 | 多种内置可切换 | 自定义 findCardSnapshotAtPoint |
| 跨容器拖拽 | 内置支持，多 droppable | 通过 store state + splice 模拟 |
| re-render 影响 | DragOverlay 隔离，不影响 droppable | splice 触发 re-render，影响全工作区 |
| 性能优化 | 使用 LayoutRect 缓存 + 订阅 | 无缓存，每次 movem 都遍历快照 |

---

## 7. 根因结论

### 根因 1：静态快照 vs 动态 DOM 的根本矛盾

**问题陈述：** `cardSnapshots` 在 `pointerdown` 时一次性采集并冻结，但 DOM 在拖拽过程中因 splice 插入 placeholder 而发生变化，导致碰撞检测坐标与真实 DOM 位置严重偏离。

**严重程度：** 致命。这是所有问题的根源。只要碰撞检测使用过期数据，无论其他逻辑多正确，最终行为和视觉都会不一致。

### 根因 2：DOM splice 方案与碰撞检测方案的不兼容

**问题陈述：** 跨列/跨组使用 `Array.splice` 插入占位元素，改变了卡片的物理位置（位移可达数百像素），但没有任何机制同步更新碰撞检测的坐标数据。

**严重程度：** 致命。DOM splice 使得碰撞检测必然失效，而且 splice 触发的 re-render 发生在 React 的 commit 阶段，与 pointermove 事件不同步。

### 根因 3：指示器与实际落点的反馈循环

**问题陈述：** 
1. 用户移动鼠标 → 碰撞检测 → 计算落点
2. 落点 → setDropPreview → splice 插入占位元素
3. splice → DOM 变化 → 碰撞检测进一步失效
4. 碰撞检测失效 → 计算错误落点 → splice 更错误的占位
   → **形成正反馈，偏差持续放大**

**严重程度：** 严重。这不仅是指示器和落点不一致的问题，而且是系统性的不稳定性。

### 根因 4：混合使用两种不同的视觉指示方案

**问题陈述：** 系统同时使用两种矛盾的模式：
- **跨列/跨组：** 破坏性 DOM splice（placeholderCol / placeholderGroup 实际占据 DOM）
- **同列（tab drag）：** 非破坏性绝对定位叠加层（dockOverlayStyle 脱离文档流）

两种模式共享同一套碰撞检测系统，但各自对 DOM 的副作用完全不同且未隔离。

**严重程度：** 严重。用户在同一次拖拽中可能经历两种模式（从跨列到同列迁移），导致行为不一致。

### 根因 5：废弃的 drop-indicator 浮层

**问题陈述：** `#drop-indicator-{wsId}` 浮层在 DOM 中定义并可通过 id 访问，但从未被实际使用（永远 `display: none`）。这是一个未完成的特性残留。

**严重程度：** 中等。虽然不直接影响功能，但反映了设计意图和实现之间的差距——开发者本意是用一个独立浮层做指示器，但最终用了 DOM splice 方案。

### 根因 6：混合坐标源导致的累积误差

**问题陈述：** `useTabDrag.ts` 中的碰撞检测混合使用了多种坐标源：
- `matchedSnapshot.rect`（冻结坐标）
- `matchedSnapshot.element`（实时 DOM 引用，但只用于读取 tabBarH）
- `moveEvent.clientX/clientY`（实时鼠标位置）
- `showTabInsertLine` 中的 `getBoundingClientRect`（实时 DOM 查询）

这种混杂导致部分数据是实时的、部分是冻结的，计算结果不可预测。

**严重程度：** 中等。虽然不是根本问题，但加剧了不一致性。

### 根因 7：缺少实时 DOM 坐标查询的 fallback

**问题陈述：** 碰撞检测只有一种路径（基于快照）。当快照失效时，没有任何 fallback 机制（如实时 `getBoundingClientRect` 查询或重采集）。代码中虽然有 `matchedSnapshot.element`（真实 DOM 引用），但从未用于获取实时位置。

**严重程度：** 严重。如果代码能在每次 dragOver 时用 `matchedSnapshot.element.getBoundingClientRect()` 获取实时坐标，问题就能缓解，但当前设计完全依赖于冻结快照。

---

### 结论总结

| 根因 | 影响 | 修复优先级 |
|------|------|-----------|
| 静态快照 vs 动态 DOM | 碰撞检测数据完全失效 | P0 |
| DOM splice 与碰撞检测不兼容 | 布局变化导致坐标大幅偏移 | P0 |
| 指示器-落点反馈循环 | 偏差持续放大，系统不稳定 | P0 |
| 混合两种指示方案 | 行为不一致，维护难度高 | P1 |
| 废弃的 drop-indicator | 开发资源浪费 | P2 |
| 混合坐标源 | 计算结果不可预测 | P1 |
| 缺少实时坐标 fallback | 鲁棒性差 | P1 |

**核心解决方案方向：** 废弃 DOM splice 方案，改为纯视觉指示器（绝对定位浮层 + `pointer-events: none`），同时在 dragOver 事件中使用实时 `getBoundingClientRect()` 替代静态快照进行碰撞检测。
