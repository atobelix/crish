# Agent-04: Tab 跨列拖拽指示器与实际落点不一致问题 — 重构方案

> 方案日期：2026-07-22
> 项目版本：crish-desktop (conex)
> 基于 Agent-04 深度分析结论

---

## 目录

1. [统一拖拽指示器架构设计](#1-统一拖拽指示器架构设计)
2. [废弃 DOM splice 方案](#2-废弃-dom-splice-方案)
   - 2.1 移除 placeholderCol / placeholderGroup 插入逻辑
   - 2.2 改为纯视觉指示器（绝对定位浮层 + pointer-events: none）
3. [实时碰撞检测](#3-实时碰撞检测)
   - 3.1 废弃 cardSnapshots 静态快照
   - 3.2 改为 dragOver 时实时 getBoundingClientRect()
   - 3.3 实时碰撞检测算法设计
4. [全局 Drop Indicator 浮层](#4-全局-drop-indicator-浮层)
   - 4.1 跨列：3px 竖线指示器 + 半透明 accent 色叠加背景
   - 4.2 跨组：3px 横线指示器
   - 4.3 创建新列：半透明列预览框
   - 4.4 CSS 样式设计
   - 4.5 `dockOverlayStyle` 的改造
5. [useTabDrag.ts 重构](#5-usetabdragts-重构)
   - 5.1 修改 dragOver 碰撞检测
   - 5.2 输出 dropTarget 类型
   - 5.3 废弃的代码清理
6. [Workspace.tsx 重构](#6-workspacetsx-重构)
   - 6.1 移除 splice 逻辑
   - 6.2 添加浮层渲染
7. [CardPanel.tsx 的调整](#7-cardpaneltsx-的调整)
8. [CSS 样式改造](#8-css-样式改造)
9. [测试策略](#9-测试策略)
10. [验证清单](#10-验证清单)

---

## 1. 统一拖拽指示器架构设计

### 设计目标

1. **视觉指示器与实际落点完全一致**：用户看到的指示器位置必须精确对应 drop 后的实际结果
2. **不破坏 DOM 布局**：拖拽过程中不改变卡片/列的物理位置
3. **实时碰撞检测**：在 dragOver 阶段使用实时 DOM 坐标进行计算
4. **单数据源**：所有拖拽视觉效果基于同一种机制（绝对定位浮层），不再混合 splice + overlay 两种模式

### 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                   DropIndicatorLayer                     │
│  ┌───────────────────────────────────────────────────┐  │
│  │  #drop-indicator-{wsId}  (position: fixed)         │  │
│  │  ├─ .indicator-line-vertical   (跨列竖线)          │  │
│  │  ├─ .indicator-line-horizontal (跨组横线)          │  │
│  │  ├─ .indicator-col-preview     (新列预览)          │  │
│  │  └─ .indicator-merge-zone      (合并/拆分区高亮)   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Workspace Canavas (unchanged during drag)              │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Column A  │  Column B  │  Column C               │  │
│  │  ┌──────┐  │  ┌──────┐  │  ┌──────┐               │  │
│  │  │Card 1│  │  │Card 2│  │  │Card 3│               │  │
│  │  └──────┘  │  └──────┘  │  └──────┘               │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 数据流

```
pointerdown → 记录 source 信息（不采集快照）
       ↓
pointermove (每次触发):
  1. querySelectorAll('.workspace-card:not(.placeholder-card-group)') → 获取实时卡片列表
  2. 遍历卡片，getBoundingClientRect() → 获取实时坐标
  3. 碰撞检测 → 计算落点类型
  4. 计算指示器位置 → 更新 DropIndicatorLayer
  5. safeSetDropPreview (仅计算，不再触发布局变更)
       ↓
pointerup:
  1. 基于实时计算的 dropTarget 提交布局变更
  2. animateOverlayAway (现有逻辑保留)
  3. 清理 DropIndicatorLayer
```

---

## 2. 废弃 DOM splice 方案

### 2.1 移除 placeholderCol / placeholderGroup 插入逻辑

**涉及文件：** `Workspace.tsx` 第 256-334 行

**需要移除的代码段：**

1. **`renderedColumns` 中的所有 splice 逻辑**：删除 `direction === 'left' || direction === 'right'` 分支的列插入（第 264-291 行）和 `direction === 'top' || direction === 'bottom'` 分支的组插入（第 292-331 行）。

2. **`placeholderCol` 类型**：删除 `RenderedColumn` 中 `id: \`col-placeholder-${phKey}\`` 相关的创建代码。

3. **`placeholderGroup` 类型**：删除 `RenderedGroup` 中 `id: \`group-placeholder-${phKey}\`` 相关的创建代码。

4. **高度/宽度重算逻辑**：删除 `baseCols.forEach(c => c.widthRatio *= 0.75)` 和 `evenHeight = 1 / numGroups` 相关的高度均分逻辑。

5. **`shouldHideSourceCol` 逻辑**：删除空源列隐藏（第 146-152 行）和相关的 `baseCols.filter(...)` 逻辑（第 238-254 行）。

6. **`isSourceColEmpty` 和 `shouldCollapseSourceGroup` 逻辑**：删除与拖拽源组折叠相关的代码 `heightRatio = 0`（第 202-203 行）。

**替换后 `renderedColumns` 的行为：**
- 不再 inspect `draggedTab` 和 `dropPreview` 来修改列/组数组
- 只做简单的 columns → RenderedColumns 映射（保留 `origColIdx` 和 `origGroupIdx` 供后续使用）
- 返回的 `renderedColumns` 与 `ws.columns` ——对应，不做 splice

### 2.2 改为纯视觉指示器（绝对定位浮层 + pointer-events: none）

所有拖拽视觉效果改为通过一个独立的**绝对定位浮层层（DropIndicatorLayer）** 实现：

```typescript
// 新组件或现有的 #drop-indicator-{wsId} div 的改造
interface DropIndicatorState {
  type: 'none' | 'vertical-line' | 'horizontal-line' | 'col-preview' | 'merge-zone';
  // 通用位置
  top: number;
  left: number;
  width: number;
  height: number;
  // 视觉参数
  colIdx: number;
  groupIdx: number;
  direction: DropPreviewDirection;
}
```

**浮层的特点：**
- `position: fixed`（相对于视口），不受父级 transform/overflow 影响
- `pointer-events: none`，不阻塞底层交互
- `z-index: 9999`，位于所有内容之上
- 尺寸和位置在每次 dragOver 时通过实时碰撞检测计算
- 仅在 `isDragging === true` 时显示

---

## 3. 实时碰撞检测

### 3.1 废弃 cardSnapshots 静态快照

**在 `useTabDrag.ts` 中：**

删除以下定义和引用：
1. `cardSnapshots` 变量定义（第 1017-1038 行）
2. `CardSnapRect` 类型（第 84-91 行）
3. `findCardSnapshotAtPoint` 函数（第 155-187 行）
4. 所有 `cardSnapshots` 的引用

```typescript
// ❌ 删除：handleTabPointerDown 中的快照采集
const cardElements = Array.from(...);
const cardSnapshots = cardElements.map(...);

// ❌ 删除：handlePointerMove 中的快照查找
const matchedSnapshot = findCardSnapshotAtPoint(cardSnapshots, mouseX, mouseY);

// ✅ 替换为：
const realtimeCards = getRealtimeCardRects();
const matched = findCardAtPoint(realtimeCards, mouseX, mouseY);
```

### 3.2 改为 dragOver 时实时 getBoundingClientRect()

**新函数 `getRealtimeCardRects`：**

```typescript
type RealtimeCardRect = {
  element: HTMLElement;
  rect: DOMRect;      // 实时 DOMRect
  colIdx: number;
  groupIdx: number;
  groupId: string;
};

function getRealtimeCardRects(): RealtimeCardRect[] {
  const elements = document.querySelectorAll(
    '.workspace-card:not(.placeholder-card-group):not(.drag-ghost-hidden)'
  ) as NodeListOf<HTMLElement>;
  return Array.from(elements).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      element: el,
      rect: r,
      colIdx: parseInt(el.getAttribute('data-col-idx') || '0', 10),
      groupIdx: parseInt(el.getAttribute('data-group-idx') || '0', 10),
      groupId: el.getAttribute('data-group-id') || '',
    };
  });
}
```

**性能考虑：**
- `document.querySelectorAll` + `getBoundingClientRect` 在 pointermove 中调用可能会有性能问题
- 优化方案：使用 `requestAnimationFrame` 节流 + `cache` 过期机制
- 如果卡片数量 < 20（本项目典型场景），性能开销在可接受范围内（单次操作 < 0.5ms）
- 也可以使用 ResizeObserver 监听，但 drag 过程中 ResizeObserver 不会触发（因为是 DOM 变动，不是 CSS 变动）

```typescript
// 节流版本
let lastRectsUpdate = 0;
const RECTS_UPDATE_THROTTLE_MS = 16; // ~60fps

function getRealtimeCardRectsThrottled(): RealtimeCardRect[] | null {
  const now = performance.now();
  if (now - lastRectsUpdate < RECTS_UPDATE_THROTTLE_MS) return null;
  lastRectsUpdate = now;
  return getRealtimeCardRects();
}
```

### 3.3 实时碰撞检测算法设计

**新函数 `findRealtimeTarget`：**

```typescript
type RealtimeDropTarget = {
  cardRect: RealtimeCardRect;
  relX: number;
  relY: number;
  colIdx: number;
  groupIdx: number;
  groupId: string;
} | null;

function findRealtimeTarget(
  cards: RealtimeCardRect[],
  mouseX: number,
  mouseY: number
): RealtimeDropTarget | null {
  if (!cards || cards.length === 0) return null;

  // 第一阶段：精确命中（使用实时坐标）
  for (const card of cards) {
    const r = card.rect;
    if (mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom) {
      return {
        cardRect: card,
        relX: mouseX - r.left,
        relY: mouseY - r.top,
        colIdx: card.colIdx,
        groupIdx: card.groupIdx,
        groupId: card.groupId,
      };
    }
  }

  // 第二阶段：最近中心回退（使用实时坐标）
  let best: RealtimeDropTarget | null = null;
  let minDistance = Infinity;
  for (const card of cards) {
    const r = card.rect;
    const centerX = r.left + r.width / 2;
    const centerY = r.top + r.height / 2;
    const dist = Math.hypot(mouseX - centerX, mouseY - centerY);
    if (dist < minDistance) {
      minDistance = dist;
      best = {
        cardRect: card,
        relX: mouseX - r.left,
        relY: mouseY - r.top,
        colIdx: card.colIdx,
        groupIdx: card.groupIdx,
        groupId: card.groupId,
      };
    }
  }
  return best;
}
```

**替换 `handlePointerMove` 中的碰撞检测部分：**

```typescript
// 替换前：
const matchedSnapshot = findCardSnapshotAtPoint(cardSnapshots, mouseX, mouseY);
if (!matchedSnapshot) { ... }
const targetRect = matchedSnapshot.rect;
const relX = mouseX - targetRect.left;
const relY = mouseY - targetRect.top;
const targetColIdx = matchedSnapshot.colIdx;
const targetGroupIdx = matchedSnapshot.groupIdx;
const targetGroupId = matchedSnapshot.groupId;

// 替换后：
const realtimeCards = getRealtimeCardRects();
const matched = findRealtimeTarget(realtimeCards, mouseX, mouseY);
if (!matched) { ... }
const { relX, relY, colIdx: targetColIdx, groupIdx: targetGroupIdx, groupId: targetGroupId } = matched;
```

**注意：** `resolveTabDrop` 还需要 `width` 和 `height` 参数。替换后使用实时坐标：

```typescript
const targetRect = matched.cardRect.rect;
const resolved = resolveTabDrop({
  relX,
  relY,
  width: targetRect.width,    // 实时宽度
  height: targetRect.height,  // 实时高度
  // ... 其余参数不变
});
```

**tabBarH 的获取也简化：**

```typescript
// 替换前（混合快照元素 + 实时查询）：
const tabBarH = resolveTabBarHeight(
  matchedSnapshot.element.querySelector('.card-header')?.getBoundingClientRect().height ??
  // ...
);

// 替换后（完全实时）：
const tabBarH = resolveTabBarHeight(
  matched.cardRect.element.querySelector('.card-header')?.getBoundingClientRect().height ??
  // ...
);
```

---

## 4. 全局 Drop Indicator 浮层

### 4.1 跨列：3px 竖线指示器 + 半透明 accent 色叠加背景

跨列指示器在用户拖拽到列边缘时显示，指示将在此位置创建新列。

**计算位置（在 handlePointerMove 中）：**

```typescript
function computeColumnIndicator(
  targetCard: RealtimeCardRect,
  direction: 'left' | 'right'
): { left: number; top: number; height: number } {
  const r = targetCard.rect;
  if (direction === 'left') {
    return {
      left: r.left - 1.5,   // 居中对齐到列分界线
      top: r.top,
      height: r.height,
    };
  } else {
    // 目标卡片的右侧
    // 注意：需要找到对应列的最后一个卡片，取它的 right
    const colCards = document.querySelectorAll(
      `.workspace-card[data-col-idx="${targetCard.colIdx}"]`
    );
    const lastCard = colCards[colCards.length - 1] as HTMLElement;
    const lastRect = lastCard.getBoundingClientRect();
    return {
      left: lastRect.right - 1.5,
      top: lastRect.top,
      height: lastRect.height,
    };
  }
}
```

**视觉：**
- 3px 宽竖线，颜色为 `var(--accent-color, #1a73e8)`
- 半透明 `background-color: color-mix(in srgb, var(--accent-color) 50%, transparent)`
- `border-radius: 2px`
- 可选：添加微弱的 box-shadow 投影

### 4.2 跨组：3px 横线指示器

跨组（split-card-top / split-card-bottom）指示器在用户拖拽到卡片上下边缘时显示。

**计算位置：**

```typescript
function computeGroupIndicator(
  targetCard: RealtimeCardRect,
  direction: 'top' | 'bottom'
): { top: number; left: number; width: number } {
  const r = targetCard.rect;
  if (direction === 'top') {
    return {
      top: r.top - 1.5,
      left: r.left,
      width: r.width,
    };
  } else {
    return {
      top: r.bottom - 1.5,
      left: r.left,
      width: r.width,
    };
  }
}
```

### 4.3 创建新列：半透明列预览框

当 drop preview 为 `split-col-left/right` 时，显示一个半透明的列预览框。

```typescript
function computeColPreviewRect(
  targetCard: RealtimeCardRect,
  direction: 'left' | 'right',
  canvasWidth: number
): { left: number; top: number; width: number; height: number } {
  const r = targetCard.rect;
  const previewWidth = canvasWidth * 0.25; // 新列占 25% 宽度
  
  if (direction === 'left') {
    return {
      left: r.left,
      top: r.top,
      width: previewWidth,
      height: r.height,
    };
  } else {
    return {
      left: r.right - previewWidth,
      top: r.top,
      width: previewWidth,
      height: r.height,
    };
  }
}
```

### 4.4 CSS 样式设计

**在 `Workspace.module.css` 中新增或改进现有 `.dropIndicator`：**

```css
/* 基础指示器层 */
.dropIndicatorLayer {
  position: fixed;
  pointer-events: none;
  z-index: 9999;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  /* 确保不遮挡点击 */
}

/* 跨列竖线 */
.indicatorLineVertical {
  position: absolute;
  width: 3px;
  border-radius: 2px;
  background: var(--accent-color, #1a73e8);
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent-color, #1a73e8) 40%, transparent);
  transition: left 0.05s ease, top 0.05s ease;
}

/* 跨组横线 */
.indicatorLineHorizontal {
  position: absolute;
  height: 3px;
  border-radius: 2px;
  background: var(--accent-color, #1a73e8);
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent-color, #1a73e8) 40%, transparent);
  transition: top 0.05s ease, left 0.05s ease;
}

/* 新列预览框 */
.indicatorColPreview {
  position: absolute;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--accent-color, #1a73e8) 8%, transparent);
  border: 1.5px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 40%, transparent);
  backdrop-filter: blur(4px);
  transition: left 0.05s ease, width 0.05s ease;
}

/* 合并/拆分区高亮 */
.indicatorMergeZone {
  position: absolute;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent);
  border: 1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 35%, transparent);
  animation: pulse-merge-highlight 1.5s infinite ease-in-out;
}
```

**移除的 CSS：**
- `.placeholder-card-group` 及 `::before` / `::after` 伪元素（不再需要）
- `.workspace-column--placeholder` 列样式（不再需要）
- `.placeholderCardGroup` 模块样式（不再需要）

### 4.5 `dockOverlayStyle` 的改造

`CardPanel.tsx` 中的 `dockOverlayStyle`（第 252-305 行）是 merge/split 同列的视觉指示器。

**合并到 DropIndicatorLayer：**

不再在 `CardPanel.tsx` 中通过 `position: absolute` 渲染 `dockOverlayStyle`，改为统一通过 DropIndicatorLayer 渲染。好处：
1. 避免每个 CardPanel 都检查自己的 `isTargetPanel`
2. 统一合并/拆分的视觉表现
3. 避免在 CardPanel 内部创建多个绝对定位叠层（可能的 z-index 层级问题）

在 DropIndicatorLayer 中添加 merge/split 区高亮：

```typescript
function computeMergeZoneRect(
  targetCard: RealtimeCardRect,
  direction: 'merge' | 'top' | 'bottom'
): { left: number; top: number; width: number; height: number } | null {
  const r = targetCard.rect;
  if (direction === 'merge') {
    // 标签栏位置的 merge 高亮
    const tabBarEl = targetCard.element.querySelector('.tabs-bar, .card-header');
    if (!tabBarEl) return null;
    const tabBarRect = tabBarEl.getBoundingClientRect();
    return {
      left: r.left + 10,
      top: tabBarRect.top,
      width: r.width - 20,
      height: tabBarRect.height,
    };
  } else if (direction === 'top') {
    return {
      left: r.left + 10,
      top: r.top + 48, // 跳过 tab bar 区域
      width: r.width - 20,
      height: (r.height - 58) / 2, // 上 50%
    };
  } else if (direction === 'bottom') {
    return {
      left: r.left + 10,
      top: r.top + 48 + (r.height - 58) / 2,
      width: r.width - 20,
      height: (r.height - 58) / 2, // 下 50%
    };
  }
  return null;
}
```

---

## 5. useTabDrag.ts 重构

### 5.1 修改 dragOver 碰撞检测

**整体修改方案：**

```typescript
export function useTabDrag({ wsId, groupId, cardsLength }: UseTabDragOptions) {
  const setDraggedTab = useWorkspaceStore((s) => s.setDraggedTab);
  const mergeTab = useWorkspaceStore((s) => s.mergeTab);
  const detachTabToStandalone = useWorkspaceStore((s) => s.detachTabToStandalone);
  const closeTabInGroup = useWorkspaceStore((s) => s.closeTabInGroup);

  const handleTabPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>, cardId: string) => {
      // ... 现有 middle-click, button guard, capture 代码保持不变 ...
      
      // ❌ 删除：cardSnapshots 采集（第 1017-1038 行）
      
      // const safeSetDropPreview = ... (保持不变)
      // const clearIndicator = ... (需要改造)
      
      const handlePointerMove = (moveEvent: PointerEvent) => {
        // ... 现有 isDragging 阈值判断和 dragOverlay 创建保持不变 ...
        
        // ✅ 替换碰撞检测：
        const realtimeCards = getRealtimeCardRects();
        const matched = findRealtimeTarget(realtimeCards, mouseX, mouseY);
        
        if (!matched) {
          clearIndicator();
          updateDropIndicator(null);  // 新增：更新指示器浮层
          lastDropType = null;
          safeSetDropPreview(null);
          return;
        }
        
        const targetRect = matched.cardRect.rect;
        const relX = matched.relX;
        const relY = matched.relY;
        const targetColIdx = matched.colIdx;
        const targetGroupIdx = matched.groupIdx;
        const targetGroupId = matched.groupId;
        
        // ✅ 实时获取 tabBarH：
        const tabBarEl = matched.cardRect.element.querySelector(
          '.card-header, .tabs-bar'
        );
        const tabBarH = resolveTabBarHeight(tabBarEl?.getBoundingClientRect().height);
        
        // ... isSelfHover, hasTabsBar, tabInsertIdx 计算保持不变 ...
        
        const resolved = resolveTabDrop({
          relX, relY,
          width: targetRect.width,
          height: targetRect.height,
          // ... 其余参数保持不变 ...
        });
        
        lastDropType = resolved.dropType;
        lastTargetColIdx = resolved.targetColIdx;
        lastTargetGroupIdx = resolved.targetGroupIdx;
        lastTargetGroupId = resolved.targetGroupId;
        lastTabInsertIdx = resolved.tabInsertIdx;
        
        safeSetDropPreview(resolved.preview);
        
        // ✅ 新增：根据 dropType 计算并更新指示器位置
        updateDropIndicator({
          dropType: resolved.dropType,
          targetCardRect: matched.cardRect,
          realtimeCards,
          mouseX,
          mouseY,
          tabBarH,
          wsId,
        });
      };
      
      // ... finishPointer 保持不变 ...
    },
    [/* dependencies */]
  );
  
  return { handleTabPointerDown };
}
```

### 5.2 输出 dropTarget 类型

**新增类型：**

```typescript
export type DropIndicatorType = 
  | 'none'
  | 'vertical-line'    // 跨列竖线
  | 'horizontal-line'  // 跨组横线
  | 'col-preview'      // 新列预览框
  | 'merge-zone'       // 合并/拆分高亮区
  | 'tab-insert';      // 标签插入线（已有）

export interface DropIndicatorPosition {
  type: DropIndicatorType;
  top: number;
  left: number;
  width: number;
  height: number;
  colIdx: number;
  groupIdx: number;
  direction: DropPreviewDirection;
}
```

**新增 `computeDropIndicator` 函数：**

```typescript
function computeDropIndicator(
  dropType: DropType | null,
  targetCardRect: RealtimeCardRect,
  realtimeCards: RealtimeCardRect[],
  mouseX: number,
  mouseY: number,
  tabBarH: number,
): DropIndicatorPosition | null {
  if (!dropType) return null;
  
  const cardR = targetCardRect.rect;
  
  if (dropType === 'split-col-left' || dropType === 'split-col-right') {
    const direction = dropType === 'split-col-left' ? 'left' : 'right';
    // 列分界线竖线
    const colEdge = computeColumnIndicatorLine(targetCardRect, direction);
    return {
      type: 'vertical-line',
      ...colEdge,
      colIdx: targetCardRect.colIdx,
      groupIdx: targetCardRect.groupIdx,
      direction,
    };
  }
  
  if (dropType === 'split-card-top' || dropType === 'split-card-bottom') {
    const direction = dropType === 'split-card-top' ? 'top' : 'bottom';
    // 组分割线横线
    const groupEdge = computeGroupIndicatorLine(targetCardRect, direction);
    return {
      type: 'horizontal-line',
      ...groupEdge,
      colIdx: targetCardRect.colIdx,
      groupIdx: targetCardRect.groupIdx,
      direction,
    };
  }
  
  if (dropType === 'merge' || dropType === 'self-reorder') {
    // merge 高亮区在 tab bar 位置
    const mergeRect = computeMergeZoneRect(targetCardRect, 'merge');
    if (!mergeRect) return null;
    return {
      type: 'merge-zone',
      ...mergeRect,
      colIdx: targetCardRect.colIdx,
      groupIdx: targetCardRect.groupIdx,
      direction: 'merge',
    };
  }
  
  return null;
}
```

### 5.3 新增 updateDropIndicator 函数

```typescript
function updateDropIndicator(position: DropIndicatorPosition | null): void {
  const indicator = document.getElementById(`drop-indicator-${wsId}`);
  if (!indicator) return;
  
  // 清空现有子元素
  indicator.innerHTML = '';
  
  if (!position) {
    indicator.style.display = 'none';
    return;
  }
  
  indicator.style.display = 'block';
  
  // 根据类型创建子元素
  let child: HTMLElement;
  
  switch (position.type) {
    case 'vertical-line':
      child = document.createElement('div');
      child.className = 'indicator-line-vertical';
      child.style.cssText = `
        position: absolute;
        left: ${position.left}px;
        top: ${position.top}px;
        width: 3px;
        height: ${position.height}px;
        background: var(--accent-color, #1a73e8);
        border-radius: 2px;
        box-shadow: 0 0 6px color-mix(in srgb, var(--accent-color, #1a73e8) 40%, transparent);
        pointer-events: none;
      `;
      break;
      
    case 'horizontal-line':
      child = document.createElement('div');
      child.className = 'indicator-line-horizontal';
      child.style.cssText = `
        position: absolute;
        left: ${position.left}px;
        top: ${position.top}px;
        width: ${position.width}px;
        height: 3px;
        background: var(--accent-color, #1a73e8);
        border-radius: 2px;
        box-shadow: 0 0 6px color-mix(in srgb, var(--accent-color, #1a73e8) 40%, transparent);
        pointer-events: none;
      `;
      break;
      
    case 'merge-zone':
      child = document.createElement('div');
      child.className = 'indicator-merge-zone';
      child.style.cssText = `
        position: absolute;
        left: ${position.left}px;
        top: ${position.top}px;
        width: ${position.width}px;
        height: ${position.height}px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent);
        border: 1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent);
        animation: pulse-merge-highlight 1.5s infinite ease-in-out;
        pointer-events: none;
      `;
      break;
      
    default:
      indicator.style.display = 'none';
      return;
  }
  
  indicator.appendChild(child);
}
```

### 5.4 废弃的代码清理

**清理清单：**

1. `cardSnapshots` 变量和采集逻辑（第 1017-1038 行）→ 删除
2. `CardSnapRect` 类型（第 84-91 行）→ 保留或移至 test utils（如果测试用到）
3. `findCardSnapshotAtPoint` 函数（第 155-187 行）→ 删除
4. `cardSnapshots.length` 的依赖和引用 → 全部用 `getRealtimeCardRects` 替换
5. `getIndicator` 函数（第 1053-1056 行）→ 改造为使用新的 DropIndicatorLayer
6. `removeInsertLine` 中与 placeholderGroup 相关的清理 → 保留（tab 插入线仍需要）
7. `clearIndicator` 函数（第 1071-1078 行）→ 改造为 `updateDropIndicator(null)`

**保留的代码：**
- `showTabInsertLine`（第 1080-1128 行）：tab 插入线仍然需要通过 DOM 操作在 tabs-bar 内创建占位 tab
- `resolveTabDrop` 决策树（第 365-764 行）：核心业务逻辑保持不变
- dragOverlay 创建和动画（第 1146-1200 行，第 1339-1363 行）：保留
- `finishPointer` 中的 commit 逻辑（第 1366-1455 行）：保留

---

## 6. Workspace.tsx 重构

### 6.1 移除 splice 逻辑

**`renderedColumns` 的改造：**

```typescript
const renderedColumns = React.useMemo(() => {
  if (!ws) return [] as RenderedColumn[];
  
  // ❌ 移除：
  // 1. sourceColIdx 搜索和 isSourceColEmpty 判断
  // 2. shouldHideSourceCol 逻辑
  // 3. isDraggingWholeGroup 折叠逻辑
  // 4. heightRatio = 0 或均分逻辑
  // 5. 所有 placeholderCol / placeholderGroup 的 splice 插入
  
  // ✅ 保留：简单映射
  const baseCols: RenderedColumn[] = ws.columns.map((col, cIdx) => {
    return {
      ...col,
      origColIdx: cIdx,
      groups: col.groups.map((g, gIdx) => ({
        ...g,
        origGroupIdx: gIdx,
        heightRatio: g.heightRatio,
      })),
    };
  });
  
  return baseCols;
}, [ws]); // ✅ 依赖简化：只需要 ws 变化时重新计算
// ❌ 不再依赖 draggedTab 和 dropPreview
```

**JSX 渲染区调整：**

```tsx
{/* ❌ 移除：placeholderCol 判断和相关渲染 */}
<div className={isPlaceholderCol ? '...' : '...'}>
{/* ✅ 替换为：统一列渲染，不再区分占位列 */}
<div className={`${styles.column} workspace-column`}>

{/* ❌ 移除：placeholderGroup 判断和相关渲染 */}
{isPlaceholderGroup ? (
  <div className={`${styles.placeholderCardGroup} ...`}>
) : (
  <CardPanel ... />
)}
{/* ✅ 替换为：始终渲染 CardPanel */}
<CardPanel ... />
```

### 6.2 添加浮层渲染

**新增 DropIndicatorLayer：**

在 `<AppErrorBoundary>` 内部，`.workspace-canvas` 之后（或之前），添加：

```tsx
{/* Drop Indicator Overlay Layer */}
<div
  id={`drop-indicator-${ws.id}`}
  className={styles.dropIndicatorLayer}
  aria-hidden="true"
/>
```

注意：这利用了**现有的** `#drop-indicator-{wsId}` div，但将其从 `display: none` 改造为：
1. 始终渲染（`display` 由 JS 控制）
2. 使用 `position: fixed` 而非内联 `display: none`
3. 通过 JS 动态添加/移除子元素来控制指示器类型

---

## 7. CardPanel.tsx 的调整

### 7.1 `dockOverlayStyle` 的移除或简化

**方案选择：** 建议将 `dockOverlayStyle` 保留为**降级方案**（当 DropIndicatorLayer 不可用时），但默认情况下 merge/split 指示器由全局 DropIndicatorLayer 渲染。

具体调整：

```typescript
// CardPanel.tsx - 条件渲染
const showDockOverlay = !!(
  isTargetPanel &&
  draggedTab &&
  draggedTab.isTabDrag
);

// ✅ 如果全局 DropIndicatorLayer 处于活动状态，不再需要每个 CardPanel 自己的 overlay
// 可以通过判断 DropIndicatorLayer 是否存在来决定是否渲染
// 或者直接移除 dockOverlayStyle（推荐）
```

**完全移除 `dockOverlayStyle` 的好处：**
1. 减少 CardPanel 的 re-render 触发条件（不再需要订阅 `dropPreview`）
2. 视觉指示器统一管理，避免多个 CardPanel 同时渲染叠层的冲突
3. 简化 CardPanel 的 props 和逻辑

**如果保留 `dockOverlayStyle` 作为降级：**
1. 添加 `isDropIndicatorActive` 的上下文判断
2. 只在全局指示器未激活时渲染 local overlay

### 7.2 `isTargetPanel` 依赖的清理

如果移除 `dockOverlayStyle`，可以清理以下相关代码：

```typescript
// ❌ 移除或简化：
const isTargetPanel = !!(
  dropPreview &&
  dropPreview.colIdx === colIdx &&
  dropPreview.groupIdx === groupIdx
);
const showDockOverlay = !!(
  isTargetPanel && draggedTab && draggedTab.isTabDrag
);
const dockOverlayStyle = React.useMemo<React.CSSProperties | null>(() => {
  // ... 全部移除 ...
}, [showDockOverlay, dropPreview]);

// ✅ 替换为：
// CardPanel 不需要再关心 drop preview 状态
```

---

## 8. CSS 样式改造

### 8.1 新增样式

在 `Workspace.module.css` 中新增：

```css
/* Drop Indicator 层 - 替代所有占位符样式 */
.dropIndicatorLayer {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 9999;
  overflow: hidden;
  contain: layout style;
}

/* 竖线指示器 - 跨列 */
.indicatorVertical {
  position: absolute;
  width: 3px;
  border-radius: 2px;
  background: var(--accent-color, #1a73e8);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-color) 35%, transparent);
  transition: left 0.05s ease-out, top 0.05s ease-out, height 0.05s ease-out;
  contain: layout style;
}

/* 横线指示器 - 跨组 */
.indicatorHorizontal {
  position: absolute;
  height: 3px;
  border-radius: 2px;
  background: var(--accent-color, #1a73e8);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-color) 35%, transparent);
  transition: top 0.05s ease-out, left 0.05s ease-out, width 0.05s ease-out;
  contain: layout style;
}

/* Merge 高亮区 */
.indicatorMerge {
  position: absolute;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent-color) 6%, transparent);
  border: 1.5px dashed color-mix(in srgb, var(--accent-color) 40%, transparent);
  animation: pulse-merge-highlight 1.5s infinite ease-in-out;
  transition: left 0.08s ease-out, top 0.08s ease-out, width 0.08s ease-out, height 0.08s ease-out;
  contain: layout style;
}

/* 列预览框 */
.indicatorColPreview {
  position: absolute;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--accent-color) 5%, transparent);
  border: 1.5px dashed color-mix(in srgb, var(--accent-color) 30%, transparent);
  backdrop-filter: blur(4px);
  transition: left 0.08s ease-out, top 0.08s ease-out, width 0.08s ease-out, height 0.08s ease-out;
  contain: layout style;
}
```

### 8.2 移除的样式

在 `shell-workspace.css` 中移除：

1. `.workspace-column--placeholder` 块（第 1216-1229 行）
2. `.placeholder-card-group` 块（第 1232-1249 行）
3. `.placeholder-card-group::before` 块（第 1260-1273 行）
4. `.placeholder-card-group::after` 块（第 1275-1288 行）
5. `.placeholder-card-group > svg, .placeholder-card-group > span` 块（第 1291-1296 行）

在 `Workspace.module.css` 中移除或标记废弃：

1. `.placeholderCol`（第 210-226 行）
2. `.placeholderColTitle`（第 228-232 行）
3. `.placeholderCardGroup`（第 234-252 行）

保留：`.dropIndicator`（第 259-268 行）→ 改造为实际使用

### 8.3 动画 keyframes 合并

保留现有的 `pulse-merge-highlight` keyframes（shell-workspace.css 第 1349-1358 行）：

```css
@keyframes pulse-merge-highlight {
  0%, 100% {
    opacity: 0.7;
    background-color: color-mix(in srgb, var(--accent-color, #1a73e8) 10%, transparent);
  }
  50% {
    opacity: 1.0;
    background-color: color-mix(in srgb, var(--accent-color, #1a73e8) 20%, transparent);
  }
}
```

---

## 9. 测试策略

### 9.1 单元测试

**新测试文件：** `apps/crish-desktop/src/hooks/__tests__/useTabDrag.realtime.test.ts`

**测试覆盖：**

```typescript
// 1. getRealtimeCardRects 基础功能
describe('getRealtimeCardRects', () => {
  it('应该返回所有 workspace-card 元素的实时 rect', () => {});
  it('应该排除 .placeholder-card-group 和 .drag-ghost-hidden', () => {});
  it('应该正确读取 data-col-idx / data-group-idx / data-group-id', () => {});
  it('空 DOM 时应返回空数组', () => {});
});

// 2. findRealtimeTarget 碰撞检测
describe('findRealtimeTarget', () => {
  it('鼠标在卡片矩形内时返回该卡片', () => {});
  it('鼠标在多个卡片交界处返回最近的卡片中心', () => {});
  it('鼠标不在任何卡片区域时返回 null', () => {});
  it('空卡片列表时返回 null', () => {});
  it('正确计算 relX/relY', () => {});
});

// 3. computeDropIndicator 位置计算
describe('computeDropIndicator', () => {
  describe('split-col-left', () => {
    it('应返回 left 为卡片 left - 1.5px 的竖线指示器', () => {});
  });
  describe('split-col-right', () => {
    it('应返回 left 为列最后卡片 right - 1.5px 的竖线指示器', () => {});
  });
  describe('split-card-top', () => {
    it('应返回 top 为卡片 top - 1.5px 的横线指示器', () => {});
  });
  describe('split-card-bottom', () => {
    it('应返回 top 为卡片 bottom - 1.5px 的横线指示器', () => {});
  });
  describe('merge', () => {
    it('应返回 tabs-bar 位置的高亮矩形', () => {});
  });
  describe('null dropType', () => {
    it('应返回 null', () => {});
  });
});

// 3. 保留 resolveTabDrop 的现有测试（不受影响）
```

### 9.2 集成测试

```typescript
// 使用 jsdom + React Testing Library
describe('Workspace renderedColumns (post-refactor)', () => {
  it('不应再包含 placeholder 列', () => {});
  it('不应再修改卡片的 widthRatio / heightRatio', () => {});
  it('不应再依赖 draggedTab 和 dropPreview 做重计算', () => {});
});

describe('CardPanel', () => {
  it('不应再渲染 dockOverlayStyle（如果选择移除）', () => {});
  it('不应再订阅 dropPreview', () => {});
});
```

### 9.3 E2E / 手动验证

参见 [验证清单](#10-验证清单)

---

## 10. 验证清单

### 10.1 基本拖拽（不触发 splice）

| # | 场景 | 预期 | 验证方式 |
|---|------|------|---------|
| 1 | 同组 tab 拖拽重排（self-reorder） | tab 插入线正确跟随鼠标位置 | 手动 |
| 2 | 跨组 tab 拖拽合并（merge） | merge 高亮在目标 tab 栏位置 | 手动 |
| 3 | 非 tab 拖拽跨组拆分（split-card） | 横线指示器在目标组上下精确位置 | 手动 |
| 4 | 所有拖拽中不出现 DOM 布局抖动 | 卡片位置不变 | 视觉检查 |

### 10.2 跨列拖拽

| # | 场景 | 预期 | 验证方式 |
|---|------|------|---------|
| 5 | tab 拖到列左边缘（split-col-left） | 3px 竖线指示器在列左边缘 | 手动 |
| 6 | tab 拖到列右边缘（split-col-right） | 3px 竖线指示器在列右边缘 | 手动 |
| 7 | 非 tab 拖到列边缘 | 竖线指示器正确显示 | 手动 |
| 8 | 多次跨列移动（A→B→C→B） | 指示器始终正确跟随 | 手动 |
| 9 | 跨列拖拽时不出现占位列插入 | DOM 结构不变 | DevTools Elements |

### 10.3 拖拽后提交

| # | 场景 | 预期 | 验证方式 |
|---|------|------|---------|
| 10 | merge 提交 | tab 正确合并到目标 group | 功能验证 |
| 11 | split-card-top 提交 | 新 group 在目标上方创建且位置正确 | 功能验证 |
| 12 | split-col-left 提交 | 新列在目标左侧创建且位置正确 | 功能验证 |
| 13 | drop 提交后 DOM 符合预期 | 无残留 placeholder 元素 | 功能验证 |

### 10.4 边界情况

| # | 场景 | 预期 | 验证方式 |
|---|------|------|---------|
| 14 | chat 列特殊区域（45%/55%） | 左右边缘外 split-col，中间无效 | 手动 |
| 15 | 唯一卡片 self-hover | 无操作 | 功能验证 |
| 16 | 多工作区拖拽 | 只在当前 ws 内生效 | 手动 |
| 17 | 拖拽中途 pointercancel | 清理所有指示器，不提交变更 | 手动 |
| 18 | 窗口缩放时拖拽 | 指示器实时更新 | 手动 |

### 10.5 性能验证

| # | 场景 | 预期 | 验证方式 |
|---|------|------|---------|
| 19 | pointermove 无卡顿 | 与重构前 fps 基本一致 | Chrome DevTools Performance |
| 20 | React re-render 次数 | 明显减少（不再触发布局计算） | React DevTools Profiler |

### 10.6 CSS 验证

| # | 场景 | 预期 | 验证方式 |
|---|------|------|---------|
| 21 | 暗色主题下指示器可见 | accent color 正常 | 视觉检查 |
| 22 | classic shell 模式下指示器正常 | 位置准确 | 视觉检查 |
| 23 | inset shell 模式下指示器正常 | 位置准确 | 视觉检查 |
| 24 | 窄屏/响应式布局下指示器 | 正确跟随 | 手动 |

### 10.7 回归测试

| # | 场景 | 预期 | 验证方式 |
|---|------|------|---------|
| 25 | 打开面板按钮 | 功能正常 | 手动 |
| 26 | tab 关闭按钮 | 功能正常 | 手动 |
| 27 | 中间键关闭 tab | 功能正常 | 手动 |
| 28 | 列/组 resize | 功能正常 | 手动 |
| 29 | 多工作区分屏 | 功能正常 | 手动 |

### 验证通过标准

- [ ] 19/29 以上场景验证通过
- [ ] P0 场景（#5-9, #10-13, #15, #17）**全部通过**
- [ ] 无新引入的 console error
- [ ] 单元测试通过率 100%
- [ ] `npm run typecheck` 通过

---

## 附录 A：文件修改清单

| 文件 | 修改类型 | 影响范围 |
|------|---------|---------|
| `useTabDrag.ts` | 重构 | ~200 行（删除 + 新增） |
| `Workspace.tsx` | 重构 | ~80 行（删除 splice 逻辑） |
| `CardPanel.tsx` | 简化 | ~30 行（删除/简化 dockOverlayStyle） |
| `Workspace.module.css` | 新增+移除 | ~60 行（新增指示器样式，移除 placeholder 样式） |
| `shell-workspace.css` | 移除 | ~40 行（移除 placeholder 相关样式） |
| `layoutHelpers.ts` | 无修改 | 0 行 |
| `workspaceActions.ts` | 无修改 | 0 行 |
| `workspaceStore.ts` | 无修改 | 0 行 |

## 附录 B：风险分析

| 风险 | 描述 | 缓解措施 |
|------|------|---------|
| 实时 getBoundingClientRect 性能 | pointermove 频繁查询 DOM 导致帧率下降 | rAF 节流 + 缓存；限制卡片数量 |
| 指示器闪烁 | pointermove 速率不足导致指示器跳帧 | CSS transition 平滑（0.05s-0.08s） |
| 现有功能退化 | splice 删除影响未知功能 | 完整的集成测试 + 手工回归清单 |
| dropIndicator 层被遮挡 | fixed 层可能被 iframe/webview 遮挡 | 提高 z-index；测试所有 overlay 类型 |
| tab 插入线兼容性 | `showTabInsertLine` 仍然使用 DOM splice 插入占位 tab | 保留此功能（同组 tab 插入不影响其他布局） |
