# Agent 7: 拖拽系统重构方案

## 目录
1. DnD Kit 模式在 Crish 中的落地
   - 1.1 总体架构设计
   - 1.2 全局 DndContext 集成
   - 1.3 与现有 Zustand Store 的关系
   - 1.4 迁移策略
2. 碰撞检测算法选择
   - 2.1 当前方案的不足
   - 2.2 推荐算法设计
   - 2.3 五区域碰撞检测实现
   - 2.4 级联检测策略
   - 2.5 特殊列（Chat）处理
3. DragOverlay 模式实现
   - 3.1 DragOverlay 组件架构
   - 3.2 Portal 渲染策略
   - 3.3 动画系统
   - 3.4 与现有 dragOverlay 对比
4. 各文件修改细节
   - 4.1 useTabDrag.ts 重构
   - 4.2 新建 DragOverlay 组件
   - 4.3 layoutHelpers.ts 增强
   - 4.4 Workspace 布局组件调整
   - 4.5 列宽拖拽实现
   - 4.6 CSS 样式更新
   - 4.7 Store 接口调整
5. 测试策略
   - 5.1 单元测试（pure helpers）
   - 5.2 集成测试（hooks）
   - 5.3 E2E 测试（visual regression）

---

## 1. DnD Kit 模式在 Crish 中的落地

### 1.1 总体架构设计

Crish 当前没有使用任何第三方拖拽库，拖拽逻辑全部通过原生 pointer events 在 `useTabDrag.ts` 中手动实现。本方案不引入 DnD Kit 作为依赖，而是借鉴其架构模式改进现有实现。

**架构对比：**

```
当前架构：
useTabDrag.ts ← 直接操作 DOM + window.addEventListener
    ├── handlePointerDown → setPointerCapture
    ├── handlePointerMove → 碰撞检测 + cloneNode + appendChild + CSS 定位
    └── finishPointer → animateOverlayAway + removeChild

目标架构：
DndContext-like provider → useDragOverlay（Portal）+ useCollisionDetection
    ├── DragOverlayContext.Provider
    │   ├── <GlobalDragOverlay> → createPortal(document.body)
    │   └── <DragPreviewProvider>
    ├── useDragOverlay() ← 统一浮层管理
    └── useCollisionDetection() ← 级联碰撞检测
```

**核心分层：**
```
Layer 1: Store Layer (layoutStore / workspaceStore / types)
  └── draggedTab, dropPreview, DraggedTabState, DropPreviewState

Layer 2: Pure Logic Layer (layoutHelpers / useTabDrag helpers)
  ├── resolveTabDrop() — 纯函数落点判定
  ├── detectDropZone() — 五区域碰撞检测
  └── computeDragOverlayTargetSize() — 浮层尺寸计算

Layer 3: Hook Layer (useTabDrag / useDragOverlay / useColumnResize)
  ├── useTabDrag — 标签/卡片拖拽主逻辑
  ├── useDragOverlay — 浮层管理
  └── useColumnResize — 列宽调整

Layer 4: UI Layer (DragOverlay / DropPlaceholder / ColumnResizeHandle)
  ├── GlobalDragOverlay — Portal 渲染的全局浮层
  ├── DropPlaceholder — 方向指示占位
  └── ColumnResizeHandle — 列拖柄
```

### 1.2 全局 DndContext 集成

借鉴 DnD Kit 的 Context 架构，设计 Crish 的拖拽上下文：

```typescript
// contexts/dragContext.tsx
import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode, CSSProperties } from 'react';

// ── 类型定义 ────────────────────────────────────────────────

export type DragOverlayContent = ReactNode;

export interface DragOverlayState {
  content: DragOverlayContent;
  style: CSSProperties;
  uid: string;
}

export interface DragOverlayContextValue {
  showOverlay: (content: DragOverlayContent, style: CSSProperties) => string;
  updateOverlay: (uid: string, style: Partial<CSSProperties>) => void;
  animateAndHide: (uid: string, targetStyle: CSSProperties, duration?: number) => Promise<void>;
  hideOverlay: (uid: string) => void;
}

// ── Context ──────────────────────────────────────────────────

const DragOverlayContext = createContext<DragOverlayContextValue | null>(null);

export function useDragOverlay(): DragOverlayContextValue {
  const ctx = useContext(DragOverlayContext);
  if (!ctx) {
    throw new Error('useDragOverlay must be used within DragOverlayProvider');
  }
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────

let uidCounter = 0;
function nextUid(): string { return `drag-overlay-${++uidCounter}`; }

export function DragOverlayProvider({ children }: { children: ReactNode }) {
  const [overlays, setOverlays] = useState<Map<string, DragOverlayState>>(new Map());
  const overlayRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const showOverlay = useCallback((content: DragOverlayContent, style: CSSProperties) => {
    const uid = nextUid();
    setOverlays(prev => {
      const next = new Map(prev);
      next.set(uid, { content, style, uid });
      return next;
    });
    return uid;
  }, []);

  const updateOverlay = useCallback((uid: string, style: Partial<CSSProperties>) => {
    setOverlays(prev => {
      const existing = prev.get(uid);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(uid, { ...existing, style: { ...existing.style, ...style } });
      return next;
    });
  }, []);

  const animateAndHide = useCallback(async (
    uid: string, targetStyle: CSSProperties, duration = 280
  ) => {
    // Step 1: 过渡到目标位置
    updateOverlay(uid, {
      ...targetStyle,
      transition: `all ${duration}ms cubic-bezier(0.19, 1, 0.22, 1)`,
      opacity: '0.2',
    });
    // Step 2: 等待动画完成
    await new Promise(resolve => setTimeout(resolve, duration));
    // Step 3: 移除
    hideOverlay(uid);
  }, [updateOverlay]);

  const hideOverlay = useCallback((uid: string) => {
    setOverlays(prev => {
      const next = new Map(prev);
      next.delete(uid);
      return next;
    });
  }, []);

  const ctx: DragOverlayContextValue = {
    showOverlay, updateOverlay, animateAndHide, hideOverlay,
  };

  return (
    <DragOverlayContext.Provider value={ctx}>
      {children}
      {createPortal(
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 10000 }}>
          {Array.from(overlays.values()).map(({ uid, content, style }) => (
            <div
              key={uid}
              ref={(el) => { if (el) overlayRefs.current.set(uid, el); }}
              style={style}
            >
              {content}
            </div>
          ))}
        </div>,
        document.body,
        'global-drag-overlay'
      )}
    </DragOverlayContext.Provider>
  );
}
```

### 1.3 与现有 Zustand Store 的关系

**状态分离原则：**

| 状态类别 | 存储位置 | 说明 |
|---------|---------|------|
| 拖拽元数据 | Zustand Store | `draggedTab` — 拖拽源信息 |
| 预览状态 | Zustand Store | `dropPreview` — 落点预览方向 |
| 浮层视觉 | DragOverlay Context | 浮层位置、内容（非序列化） |
| 碰撞几何 | useRef/Zustand | 卡片快照、鼠标坐标 |

**理由：**
- `draggedTab` 和 `dropPreview` 需要被其他组件读取（如 Workspace 渲染 DropPlaceholder），所以保持在 Zustand store
- 浮层视觉状态是 UI 层细节，不需要序列化/持久化，保持在 React Context
- 碰撞几何数据只在拖拽期间存在，用 useRef 避免不必要的渲染

**数据流：**
```
用户 pointerdown
  → useTabDrag: setDraggedTab(draggedTabState) [Zustand store]
  → DragOverlay: showOverlay(clonedContent, rect) [Context]
  
用户 pointermove
  → useTabDrag: 碰撞检测
  → useTabDrag: safeSetDropPreview(dropPreviewState) [Zustand store]
  → DragOverlay: updateOverlay(uid, { left, top }) [Context]
  
用户 pointerup
  → useTabDrag: canCommitTabDrop() ? commit() : skip
  → DragOverlay: animateAndHide(uid, targetRect) [Context]
  → useTabDrag: setDraggedTab(null) + setDropPreview(null) [Zustand store]
```

### 1.4 迁移策略

**增量迁移，非重写：**

| 阶段 | 任务 | 影响范围 |
|------|------|---------|
| Phase 1 | 创建 DragOverlay Context + Provider | 新建文件，无破坏性 |
| Phase 2 | 在 App.tsx 挂载 Provider | 一行代码 |
| Phase 3 | 重构 useTabDrag → 使用 DragOverlay | useTabDrag.ts 内部改动 |
| Phase 4 | 提取碰撞检测到 pure helpers | layoutHelpers.ts 增强 |
| Phase 5 | 添加 ColumnResizeHandle | 新建组件，不影响现有 |
| Phase 6 | 清理旧的 DOM 操作代码 | 删除临时 DOM 操作 |

---

## 2. 碰撞检测算法选择

### 2.1 当前方案的不足

Crish 当前的碰撞检测在 `useTabDrag.ts` 中实现（`findCardSnapshotAtPoint`）：

```typescript
function findCardSnapshotAtPoint<T extends { rect: CardSnapRect }>(
  snapshots: readonly T[], mouseX: number, mouseY: number
): T | null {
  // 1. 精确命中检测
  for (let i = 0; i < snapshots.length; i++) {
    if (mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom) {
      return snap;
    }
  }
  // 2. 最近中心回退
  let best = null, minDist = Infinity;
  for (let i = 0; i < snapshots.length; i++) {
    const dist = Math.hypot(mouseX - centerX, mouseY - centerY);
    if (dist < minDistance) { minDist = dist; best = snap; }
  }
  return best;
}
```

**问题：**
1. 未命中时直接回退到最近中心，可能选中预期外的目标
2. 没有距离阈值——即使很远也会返回结果
3. 不支持方向优先级（如垂直列表优先垂直方向）
4. 没有 chat 列特殊处理（chat 列只允许 left/right）
5. 命中检测是矩形，标签栏区域没有特殊优先级

### 2.2 推荐算法设计

借鉴 DnD Kit 的 `closestCenter`、`closestCorners` 和 `rectIntersection`，设计 Crish 的碰撞检测体系：

```typescript
// types/collisionDetection.ts
export interface CardSnapshot {
  element: HTMLElement;
  rect: CardSnapRect;
  colIdx: number;
  groupIdx: number;
  groupId: string;
  isChatColumn: boolean;
  hasTabsBar: boolean;
  tabBarH: number;
}

export interface CollisionArgs {
  activeSnapshot: { groupId: string; colIdx: number; groupIdx: number } | null;
  cardSnapshots: CardSnapshot[];
  mouseX: number;
  mouseY: number;
  config?: CollisionConfig;
}

export interface CollisionResult {
  snapshot: CardSnapshot | null;
  distance: number;
  isExactHit: boolean;
}

export interface CollisionConfig {
  /** 直接命中检测的优先级方向 */
  priorityAxis?: 'x' | 'y' | null;
  /** 最近中心的最大距离（px），超过则返回 null */
  maxNearestDistance?: number;
  /** 是否对 chat 列采用特殊检测 */
  chatColumnSpecial?: boolean;
  /** 标签栏区域优先级 */
  tabBarPriority?: boolean;
}
```

### 2.3 五区域碰撞检测实现

借鉴 DnD Kit 的 `closestCorners` 思想，但针对 Crish 的布局特点（五区域 + 标签栏）进行优化：

```typescript
// layoutHelpers.ts — 增强版碰撞检测

export type DropZoneType = 
  | 'merge'
  | 'self-reorder'
  | 'split-card-top'
  | 'split-card-bottom'
  | 'split-col-left'
  | 'split-col-right';

export interface DropZoneResult {
  zone: DropZoneType;
  tabInsertIdx?: number;
}

/**
 * 五区域碰撞检测 — 将卡片矩形分为五个区域：
 * 
 * ┌─────────────┬─────────────────────┬─────────────┐
 * │ split-col   │                     │ split-col   │
 * │ left        │   tabBar (36px)     │ right       │
 * │  < 48px     │   → merge/self-reorder            │
 * ├─────────────┼─────────────────────┼─────────────┤
 * │             │   split-card-top                  │
 * │             │   (body 20%)                       │
 * │             ├─────────────────────┤             │
 * │  same as    │   center 60%        │  same as    │
 * │  left edge  │   → merge (safe)    │  right edge │
 * │             ├─────────────────────┤             │
 * │             │   split-card-bottom               │
 * │             │   (body 20%)                       │
 * └─────────────┴─────────────────────┴─────────────┘
 * 
 * split-col-left/right 需要特殊判断（chat 列有不同比例）
 */
export function detectDropZone(
  cardRect: CardSnapRect,
  mouseX: number,
  mouseY: number,
  tabBarH: number,
  isChatColumn: boolean,
  edgePaddingX: number = SPLIT_EDGE_PADDING_X,
  edgePaddingY: number = SPLIT_EDGE_PADDING_Y,
): { zone: 'split-col-left' | 'split-col-right' | null; bodyZone: 'top' | 'center' | 'bottom' } {
  const relX = mouseX - cardRect.left;
  const relY = mouseY - cardRect.top;
  const { width, height } = cardRect;

  // chat 列特殊处理：左右分区 + 中间禁区
  if (isChatColumn) {
    if (relX < width * CHAT_COL_LEFT_ZONE) {
      return { zone: 'split-col-left', bodyZone: 'center' };
    }
    if (relX > width * CHAT_COL_RIGHT_ZONE) {
      return { zone: 'split-col-right', bodyZone: 'center' };
    }
    // chat 列中间区域不响应
    return { zone: null, bodyZone: 'center' };
  }

  // 标准列：五区域检测
  // 左右边缘优先判断（因为 edgePaddingX < tabBarH，但列拆分比卡拆分优先级高）
  if (relX < edgePaddingX) {
    return { zone: 'split-col-left', bodyZone: 'center' };
  }
  if (relX > width - edgePaddingX) {
    return { zone: 'split-col-right', bodyZone: 'center' };
  }

  // 垂直方向：标签栏 / 上下边缘 / 中心
  if (relY < tabBarH) {
    // 标签栏区域 → body 不拆分
    return { zone: null, bodyZone: 'center' };
  }

  const bodyHeight = height - tabBarH;
  const bodyY = relY - tabBarH;

  if (bodyY < bodyHeight * 0.2) {
    // 顶部 20%
    return { zone: null, bodyZone: 'top' };
  }
  if (bodyY > bodyHeight * 0.8) {
    // 底部 20%
    return { zone: null, bodyZone: 'bottom' };
  }
  // 中心 60% 安全区
  return { zone: null, bodyZone: 'center' };
}

/**
 * 根据 zone + 业务上下文 → DropType
 * 对应 resolveTabDrop 的核心逻辑
 */
export function resolveDropType(
  zone: ReturnType<typeof detectDropZone>,
  ctx: {
    isSelfHover: boolean;
    isDragFromTabButton: boolean;
    cardsLength: number;
    isChatColumn: boolean;
    hasTabsBar: boolean;
    sourceColIdx: number;
    targetColIdx: number;
    sourceGroupIdx: number;
    targetGroupIdx: number;
    isOnlyCardInCol: boolean;
    sourceColGroupsLength: number;
  },
): DropType | null {
  const { zone: colZone, bodyZone } = zone;

  // ── 列拆分（左右边缘）──────────────────────────────────
  if (colZone === 'split-col-left') {
    if (isRedundantNonChatColumnSplit({ sourceColIdx: ctx.sourceColIdx, targetColIdx: ctx.targetColIdx, direction: 'left', isOnlyCardInCol: ctx.isOnlyCardInCol, sourceColGroupsLength: ctx.sourceColGroupsLength })) {
      return null;
    }
    return 'split-col-left';
  }
  if (colZone === 'split-col-right') {
    if (isRedundantNonChatColumnSplit({ sourceColIdx: ctx.sourceColIdx, targetColIdx: ctx.targetColIdx, direction: 'right', isOnlyCardInCol: ctx.isOnlyCardInCol, sourceColGroupsLength: ctx.sourceColGroupsLength })) {
      return null;
    }
    return 'split-col-right';
  }

  // ── 标签栏区域（bodyZone === 'center' + relY < tabBarH）───
  if (bodyZone === 'center' && colZone === null) {
    // 标签栏区域：merge / self-reorder
    // 这里的"标签栏区域"由调用方传入 relY < tabBarH 的判断结果
    if (ctx.isSelfHover) {
      return 'self-reorder';
    }
    return ctx.hasTabsBar ? 'merge' : null;
  }

  // ── 卡片上下拆分 ────────────────────────────────────────
  if (bodyZone === 'top') {
    if (ctx.isSelfHover && ctx.cardsLength <= 1) return null;
    if (ctx.isSelfHover && ctx.cardsLength > 1) return 'split-card-top';
    if (!ctx.isSelfHover) return 'split-card-top';
    return null;
  }
  if (bodyZone === 'bottom') {
    if (ctx.isSelfHover && ctx.cardsLength <= 1) return null;
    if (ctx.isSelfHover && ctx.cardsLength > 1) return 'split-card-bottom';
    if (!ctx.isSelfHover) return 'split-card-bottom';
    return null;
  }

  // ── 中心安全区 ──────────────────────────────────────────
  if (ctx.isSelfHover) return 'self-reorder';
  return ctx.hasTabsBar ? 'merge' : null;
}
```

### 2.4 级联检测策略

借鉴 DnD Kit 的多算法组合，设计 Crish 的检测链：

```typescript
// 级联碰撞检测配置
const collisionPipeline = [
  detectCollisionByExactHit,    // 1. 精确命中检测（同 rectIntersection）
  detectCollisionByNearest,     // 2. 最近距离检测（同 closestCenter）
  detectCollisionByEdge,        // 3. 边缘邻近检测（同 closestCorners 变体）
];

/**
 * 级联执行碰撞检测，前一个成功则返回，否则 fallback
 */
export function cascadeCollisionDetection(
  snapshots: CardSnapshot[],
  mouseX: number,
  mouseY: number,
): CardSnapshot | null {
  // 1. 精确命中：鼠标落在矩形内
  const exactHit = snapshots.find(s => pointInRect(mouseX, mouseY, s.rect));
  if (exactHit) {
    // 加上距离信息供下游决策
    return exactHit;
  }

  // 2. 最近距离：按中心距离排序（有阈值限制）
  const nearest = findNearestWithinThreshold(snapshots, mouseX, mouseY, 200);
  if (nearest) {
    return nearest;
  }

  // 3. 边缘检测：若鼠标靠近某个卡片边缘（用于快速跨列预览）
  const edge = findClosestEdge(snapshots, mouseX, mouseY, 100);
  return edge;
}

function pointInRect(x: number, y: number, r: CardSnapRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function findNearestWithinThreshold(
  snapshots: CardSnapshot[], x: number, y: number, threshold: number,
): CardSnapshot | null {
  let nearest: CardSnapshot | null = null;
  let minDist = Infinity;
  for (const s of snapshots) {
    const cx = s.rect.left + s.rect.width / 2;
    const cy = s.rect.top + s.rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < minDist && dist <= threshold) {
      minDist = dist;
      nearest = s;
    }
  }
  return nearest;
}

function findClosestEdge(
  snapshots: CardSnapshot[], x: number, y: number, threshold: number,
): CardSnapshot | null {
  let nearest: CardSnapshot | null = null;
  let minDist = Infinity;
  for (const s of snapshots) {
    const dist = Math.min(
      Math.abs(x - s.rect.left), Math.abs(x - s.rect.right),
      Math.abs(y - s.rect.top), Math.abs(y - s.rect.bottom),
    );
    if (dist < minDist && dist <= threshold) {
      minDist = dist;
      nearest = s;
    }
  }
  return nearest;
}
```

### 2.5 特殊列（Chat）处理

Chat 列有特殊的交互约束：
1. 不允许内部 merge（chat 卡不能与其他卡合并）
2. 只允许左右拆分出新列
3. 中间区域不响应拖拽

```typescript
export function detectChatColumnDropZone(
  cardRect: CardSnapRect,
  mouseX: number,
  mouseY: number,
  config?: {
    leftZone?: number;   // 默认 CHAT_COL_LEFT_ZONE = 0.45
    rightZone?: number;  // 默认 CHAT_COL_RIGHT_ZONE = 0.55
  },
): 'split-col-left' | 'split-col-right' | null {
  const leftZone = config?.leftZone ?? CHAT_COL_LEFT_ZONE;
  const rightZone = config?.rightZone ?? CHAT_COL_RIGHT_ZONE;
  const relX = mouseX - cardRect.left;
  const w = cardRect.width;

  if (w <= 0) return null;

  const ratio = relX / w;
  if (ratio < leftZone) return 'split-col-left';
  if (ratio > rightZone) return 'split-col-right';
  return null; // 中间禁区
}
```

---

## 3. DragOverlay 模式实现

### 3.1 DragOverlay 组件架构

借鉴 DnD Kit 的 `DragOverlay` 设计：

```
DragOverlayContext.Provider
  ├── <GlobalDragOverlay> → create portal to document.body
  │   ├── TabDragOverlay（标签拖拽浮层）
  │   └── CardDragOverlay（卡片拖拽浮层）
  └── children（应用组件）
```

**组件树：**
```tsx
<DragOverlayProvider>
  <Workspace>
    <CardPanel>
      <Tab onClick={handlePointerDown} />
    </CardPanel>
  </Workspace>
</DragOverlayProvider>
```

### 3.2 Portal 渲染策略

```typescript
// components/drag/GlobalDragOverlay.tsx
import { createPortal } from 'react-dom';

interface OverlayItem {
  uid: string;
  content: ReactNode;
  style: CSSProperties;
}

export function GlobalDragOverlay({ items }: { items: OverlayItem[] }) {
  return createPortal(
    <div
      className="global-drag-overlay-container"
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none', // 所有 overlay 不阻挡鼠标事件
        zIndex: 10000,
      }}
    >
      {items.map(item => (
        <div
          key={item.uid}
          className="drag-overlay-item"
          style={item.style}
        >
          {item.content}
        </div>
      ))}
    </div>,
    document.body,
  );
}
```

**与 cloneNode 方案的对比：**

| 方面 | 当前方案（cloneNode） | Portal 方案 |
|------|---------------------|-------------|
| 渲染方式 | 手动 DOM API | React 可控渲染 |
| 状态保持 | 克隆丢失 React 状态 | 重新渲染组件 |
| 事件 | cloneNode 会复制事件监听器 | 不会传播 | 
| 清理 | 需要手动 removeChild | React 自动卸载 |
| 多个浮层 | 需要独立管理 | 统一管理 |
| Portal | 无 | 渲染到 body |

**折中方案：**
对于 Tab 拖拽（需要精确的 DOM 克隆样式），使用 `cloneNode` 但通过 Portal 管理：

```typescript
function useTabDragOverlay() {
  const { showOverlay, updateOverlay, animateAndHide } = useDragOverlay();
  
  const startDragging = useCallback((tabElement: HTMLElement) => {
    // 1. 克隆 DOM（保持精确样式）
    const clone = tabElement.cloneNode(true) as HTMLElement;
    // 2. 调整克隆样式
    clone.style.pointerEvents = 'none';
    clone.style.width = tabElement.offsetWidth + 'px';
    clone.style.height = tabElement.offsetHeight + 'px';
    // 3. 删除关闭按钮
    clone.querySelectorAll('.tab-close-btn').forEach(btn => btn.remove());
    // 4. 通过 Portal 显示
    const uid = showOverlay(clone, {
      position: 'fixed',
      left: tabElement.getBoundingClientRect().left + 'px',
      top: tabElement.getBoundingClientRect().top + 'px',
      opacity: 0.95,
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.12)',
      borderRadius: '6px',
      overflow: 'hidden',
    });
    return uid;
  }, [showOverlay]);
  
  return { startDragging, updateOverlay, animateAndHide };
}
```

### 3.3 动画系统

借鉴 DnD Kit 的 `useDropAnimation` 和 `AnimationManager`：

```typescript
// hooks/useDropAnimation.ts

export interface DropAnimationConfig {
  duration?: number;
  easing?: string;
  scale?: number;
  opacityEnd?: number;
}

const DEFAULT_DROP_ANIMATION: DropAnimationConfig = {
  duration: 280,
  easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
  opacityEnd: 0,
};

/**
 * 拖拽结束动画：将浮层动画到目标位置后移除
 * 借鉴 DnD Kit 的 useDropAnimation
 */
export function useDropAnimation() {
  const { animateAndHide } = useDragOverlay();
  
  const animateToTarget = useCallback(async (
    uid: string,
    targetRect: DOMRect | null,
    config: DropAnimationConfig = {},
  ) => {
    const { duration = 280, easing = 'cubic-bezier(0.19, 1, 0.22, 1)', opacityEnd = 0 } = {
      ...DEFAULT_DROP_ANIMATION,
      ...config,
    };

    if (targetRect) {
      // 有目标：飞到目标位置
      await animateAndHide(uid, {
        left: targetRect.left + 'px',
        top: targetRect.top + 'px',
        width: targetRect.width + 'px',
        height: Math.min(targetRect.height, 160) + 'px',
        transition: `all ${duration}ms ${easing}`,
        opacity: String(opacityEnd),
      });
    } else {
      // 无目标：缩放消失
      await animateAndHide(uid, {
        transform: 'scale(0.5)',
        transition: `all ${Math.floor(duration * 0.7)}ms ease-out`,
        opacity: '0',
      });
    }
  }, [animateAndHide]);

  return { animateToTarget };
}
```

### 3.4 与现有 dragOverlay 对比

**现有实现（useTabDrag.ts 第 1146-1200 行）：**
```typescript
// 当前：每次拖拽手动创建/销毁 DOM
dragOverlay = targetEl.cloneNode(true) as HTMLDivElement;
dragOverlay.style.cssText = `position: fixed; width: ...; ...`;
document.body.appendChild(dragOverlay);
// ...
// 释放时：
animateOverlayAway(overlay, destGroupId);
// 内部 setTimeout(() => overlay.remove(), 280);
```

**新实现对比：**
```typescript
// 新：通过 Context 统一管理
const uid = startDragging(tabElement);
// 拖拽中：
updateOverlay(uid, { left: newX + 'px', top: newY + 'px' });
// 释放时：
await animateToTarget(uid, targetRect);
```

**差异总结：**
1. DOM 操作 → React Context（可预测、可测试）
2. 多个浮层 → 统一管理
3. 手动 timeout → Promise await
4. 固定内容 → 可定制 content

---

## 4. 各文件修改细节

### 4.1 useTabDrag.ts 重构

**修改说明：** 核心重构文件。将 DOM 操作提取出去，使用 DragOverlay Context；将碰撞检测逻辑精简。

```typescript
// useTabDrag.ts — 重构后骨架
import { useDragOverlay, type DragOverlayContent } from '../contexts/dragContext';
import { useDropAnimation } from './useDropAnimation';
import { 
  cascadeCollisionDetection, detectDropZone, resolveDropType, 
  type CardSnapshot,
} from '../store/layoutHelpers';

export function useTabDrag({ wsId, groupId, cardsLength }: UseTabDragOptions) {
  // Store actions（不变）
  const setDraggedTab = useWorkspaceStore(s => s.setDraggedTab);
  const mergeTab = useWorkspaceStore(s => s.mergeTab);
  const detachTabToStandalone = useWorkspaceStore(s => s.detachTabToStandalone);
  
  // DragOverlay（新增）
  const { showOverlay, updateOverlay } = useDragOverlay();
  const { animateToTarget } = useDropAnimation();
  
  // Refs（替代原来的局部变量）
  const dragStateRef = useRef<{
    uid: string;
    isDragging: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    clickOffsetX: number;
    clickOffsetY: number;
    cardId: string;
    isDragFromTabButton: boolean;
    snapshots: CardSnapshot[];
    lastDropType: DropType | null;
    lastTargetColIdx: number;
    lastTargetGroupIdx: number;
    lastTargetGroupId: string | null;
    lastTabInsertIdx: number;
  } | null>(null);

  const handleTabPointerDown = useCallback((
    e: React.PointerEvent<HTMLDivElement>, cardId: string
  ) => {
    // ... 中间点击关闭逻辑不变 ...
    
    // 初始化 drag state（用 ref 而非局部变量）
    dragStateRef.current = {
      uid: '',
      isDragging: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      clickOffsetX: /* 计算偏移 */,
      clickOffsetY: /* 计算偏移 */,
      cardId,
      isDragFromTabButton: (e.target as HTMLElement)?.closest?.('.card-tab') != null,
      snapshots: captureCardSnapshots(),
      lastDropType: null,
      lastTargetColIdx: 0,
      lastTargetGroupIdx: 0,
      lastTargetGroupId: null,
      lastTabInsertIdx: undefined,
    };

    // 使用 pointer capture
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    
    // 开始监听从 window 级别监听 move/up
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handleFinish);
    window.addEventListener('pointercancel', handleFinish);
  }, [wsId, groupId, cardsLength]);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const state = dragStateRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    
    // 阈值检测
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    if (!state.isDragging) {
      if (!exceedsDragThreshold(dx, dy)) return;
      state.isDragging = true;
      
      // 启动拖拽：设置 store + 创建 overlay
      setDraggedTab({ cardId: state.cardId, sourceGroupId: groupId, workspaceId: wsId, isTabDrag: state.isDragFromTabButton });
      
      // 通过 DragOverlay Context 创建浮层
      const tabEl = /* 获取源元素 */;
      const clone = tabEl.cloneNode(true) as HTMLElement;
      const rect = tabEl.getBoundingClientRect();
      state.uid = showOverlay(clone, {
        position: 'fixed',
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
        pointerEvents: 'none',
        zIndex: 10000,
        opacity: 0.95,
        boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
      });
    }
    
    // 更新浮层位置
    const newLeft = e.clientX - state.clickOffsetX;
    const newTop = e.clientY - state.clickOffsetY;
    updateOverlay(state.uid, { left: newLeft + 'px', top: newTop + 'px' });
    
    // 碰撞检测
    const matched = cascadeCollisionDetection(state.snapshots, e.clientX, e.clientY);
    // ... 后续 resolveTabDrop 逻辑基本不变 ...
  }, [showOverlay, updateOverlay, setDraggedTab, groupId, wsId]);

  const handleFinish = useCallback(async (ev?: Event) => {
    const state = dragStateRef.current;
    if (!state) return;
    
    // 清理监听器
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handleFinish);
    window.removeEventListener('pointercancel', handleFinish);
    
    if (!state.isDragging) {
      dragStateRef.current = null;
      setDropPreview(null);
      return;
    }
    
    // 提交布局变更（逻辑不变）
    // ...
    
    // 使用 DragOverlay 动画归位
    if (destGroupId) {
      const targetCard = findDropTargetCardEl(state.cardId, destGroupId);
      if (targetCard) {
        await animateToTarget(state.uid, targetCard.getBoundingClientRect());
      } else {
        await animateToTarget(state.uid, null);
      }
    } else {
      await animateToTarget(state.uid, null);
    }
    
    // 清理
    setDraggedTab(null);
    setDropPreview(null);
    dragStateRef.current = null;
  }, [animateToTarget, setDraggedTab, setDropPreview, /* ... */]);

  return { handleTabPointerDown };
}
```

**变更要点：**
1. 局部变量 → `useRef` 管理（避免闭包问题，不再需要 useCallback 的 exhaustive deps）
2. DOM 操作 → DragOverlay Context API
3. 碰撞检测 → 提取到 `cascadeCollisionDetection` pure function
4. 动画 → `useDropAnimation` hook

### 4.2 新建 DragOverlay 组件

**新建文件：**
- `src/contexts/dragContext.tsx` — DragOverlayContext + Provider
- `src/hooks/useDropAnimation.ts` — 动画 hook
- `src/components/drag/GlobalDragOverlay.tsx` — 可选独立组件

参考 3.1-3.3 节的代码。

### 4.3 layoutHelpers.ts 增强

**新增函数：**

```typescript
// layoutHelpers.ts — 新增碰撞检测相关函数

export type DropZoneType = 'merge' | 'self-reorder' | 'split-card-top' | 'split-card-bottom' | 'split-col-left' | 'split-col-right';

export interface CardHitRect {
  left: number; top: number; right: number; bottom: number;
  width: number; height: number;
}

export interface CardSnapshot<T = unknown> {
  rect: CardHitRect;
  colIdx: number;
  groupIdx: number;
  groupId: string;
  isChatColumn: boolean;
  hasTabsBar: boolean;
  tabBarH: number;
  data?: T;
}

// cascadeCollisionDetection — 见 2.4 节
// detectDropZone — 见 2.3 节
// resolveDropType — 见 2.3 节
// detectChatColumnDropZone — 见 2.5 节
```

**已有函数保持不变：**
- `resolveTabDrop` — 保留，但内部使用新检测函数
- `canCommitTabDrop` — 不变
- `dropPreviewEquals` — 不变
- `findGroupIndicesInWorkspace` — 不变
- `isOnlyCardInSourceColumn` — 不变
- `isRedundantColumnSplit` — 不变
- `isRedundantGroupSplit` — 不变

### 4.4 Workspace 布局组件调整

**Workspace.tsx 修改：**

```typescript
// 使用 DropPlaceholder 替换直接读取 dropPreview
function Workspace({ wsId }: { wsId: string }) {
  const dropPreview = useWorkspaceStore(s => s.dropPreview);
  
  return (
    <div className="workspace">
      <DropPlaceholder preview={dropPreview} />
      {columns.map((col, idx) => (
        <Column key={col.id} column={col} colIdx={idx} />
      ))}
    </div>
  );
}
```

**DropPlaceholder 组件：**
```typescript
function DropPlaceholder({ preview, containerRect }: {
  preview: DropPreviewState | null;
  containerRect?: DOMRect | null;
}) {
  if (!preview) return null;
  
  const style = computePlaceholderStyle(preview);
  if (!style) return null;
  
  return (
    <div
      className="drop-placeholder"
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: 5,
        background: 'var(--accent-color)',
        opacity: 0.12,
        borderRadius: 'var(--radius-md, 8px)',
        transition: 'all 0.12s ease-out',
        ...style,
      }}
    />
  );
}

function computePlaceholderStyle(preview: DropPreviewState): CSSProperties | null {
  const { direction } = preview;
  switch (direction) {
    case 'merge':
      return { inset: '4px' };
    case 'top':
      return { left: '4px', top: '4px', right: '4px', height: '40%' };
    case 'bottom':
      return { left: '4px', bottom: '4px', right: '4px', height: '40%' };
    case 'left':
      return { left: '4px', top: '4px', bottom: '4px', width: '50%' };
    case 'right':
      return { right: '4px', top: '4px', bottom: '4px', width: '50%' };
    default:
      return null;
  }
}
```

### 4.5 列宽拖拽实现

**新建文件：** `src/components/workspace/ColumnResizeHandle.tsx`

```typescript
interface ColumnResizeHandleProps {
  workspaceId: string;
  columnIndex: number;
  onResize?: (sizes: number[]) => void;
}

export function ColumnResizeHandle({
  workspaceId, columnIndex, onResize,
}: ColumnResizeHandleProps) {
  const [isActive, setIsActive] = useState(false);
  const startRef = useRef<{ x: number; sizes: number[] } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth <= 0) return;
    
    const state = getWorkspaceStoreState();
    const ws = state.workspaces.find(w => w.id === workspaceId);
    if (!ws) return;
    
    const sizes = ws.columns.map(c => c.widthRatio);
    
    startRef.current = { x: e.clientX, sizes };
    setIsActive(true);
    
    const handleMove = (me: PointerEvent) => {
      if (!startRef.current) return;
      const delta = me.clientX - startRef.current.x;
      const deltaPercent = (delta / containerWidth) * 100;
      
      const newSizes = resizeColumnSizes(sizes, columnIndex, deltaPercent);
      
      // 更新 store（通过 workspace action）
      setColumnWidthRatios(workspaceId, newSizes);
    };
    
    const handleUp = () => {
      setIsActive(false);
      startRef.current = null;
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };
    
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  }, [workspaceId, columnIndex]);

  return (
    <div
      className={`col-resize-handle ${isActive ? 'is-active' : ''}`}
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={/* 当前尺寸 */ 50}
      tabIndex={0}
    />
  );
}

/**
 * 列大小调整算法（纯函数）
 */
function resizeColumnSizes(
  sizes: number[], index: number, deltaPercent: number,
): number[] {
  const MIN_COL_WIDTH = 0.04;   // 最小 4%（对应工具列收起）
  const MAX_COL_WIDTH = 0.85;   // 最大 85%
  
  const newSizes = [...sizes];
  const left = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, sizes[index] + deltaPercent));
  const right = Math.max(MIN_COL_WIDTH, sizes[index + 1] - (left - sizes[index]));
  
  newSizes[index] = left;
  newSizes[index + 1] = right;
  
  // 归一化
  const total = newSizes.reduce((a, b) => a + b, 0);
  return total > 0 ? newSizes.map(s => s / total) : newSizes;
}
```

### 4.6 CSS 样式更新

```css
/* shell-dragdrop.css — 拖拽相关样式 */

/* DragOverlay 容器 */
.global-drag-overlay-container {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 10000;
}

.drag-overlay-item {
  position: fixed;
  will-change: transform, left, top, width, height;
  backface-visibility: hidden;
}

/* 标签拖拽浮层 */
.drag-overlay-tab {
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.06);
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  border-radius: var(--radius-sm, 6px);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 卡片拖拽浮层 */
.drag-overlay-card {
  pointer-events: none;
  box-shadow: 0 0 16px rgba(0, 0, 0, 0.12);
  border: 1.5px solid color-mix(in srgb, var(--accent-color) 35%, var(--border-color));
  background: var(--bg-card, var(--bg-primary));
  transition: opacity 0.12s ease-out;
  will-change: transform;
}

/* Drop Placeholder */
.drop-placeholder {
  position: absolute;
  pointer-events: none;
  z-index: 5;
  background: var(--accent-color);
  opacity: 0;
  border-radius: var(--radius-md, 8px);
  transition: all 0.12s cubic-bezier(0.19, 1, 0.22, 1);
}

.drop-placeholder.is-visible {
  opacity: 0.12;
}

/* 列调整手柄 */
.col-resize-handle {
  position: relative;
  width: 4px;
  cursor: col-resize;
  user-select: none;
  touch-action: none;
  z-index: 10;
  flex-shrink: 0;
  transition: background 0.15s;
}

.col-resize-handle::after {
  content: '';
  position: absolute;
  inset: -4px; /* 扩大点击区域 */
}

.col-resize-handle:hover,
.col-resize-handle.is-active {
  background: var(--accent-color);
  opacity: 0.5;
}

/* 拖拽中 body 样式 */
body.is-dragging {
  user-select: none;
  -webkit-user-select: none;
  cursor: grabbing;
}
```

### 4.7 Store 接口调整

**目前 Zustand Store 已有的拖拽相关状态（保持不变）：**
```typescript
interface WorkspaceActions {
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
  setDraggedTab: (tab: DraggedTabState | null) => void;
  setDropPreview: (preview: DropPreviewState | null) => void;
  mergeTab: (wsId: string, cardId: string, sourceGroupId: string, targetGroupId: string, insertIdx?: number) => void;
  detachTabToStandalone: (wsId: string, cardId: string, sourceGroupId: string, targetColIdx: number, placement: 'top' | 'bottom' | 'new-col', targetGroupIdx?: number) => void;
  closeTabInGroup: (wsId: string, groupId: string, cardId: string) => void;
}
```

**新增接口（如果需要列宽拖拽）：**
```typescript
// 在 workspaceActions.ts 或 layoutStore.ts 中新增
interface WorkspaceActions {
  // ... 现有接口 ...
  
  /** 更新列宽度比例 */
  setColumnWidthRatios: (wsId: string, ratios: number[]) => void;
}

// 使用 immer 的实现
setColumnWidthRatios: (wsId: string, ratios: number[]) => set((state) => {
  const ws = state.workspaces.find(w => w.id === wsId);
  if (!ws) return;
  for (let i = 0; i < ws.columns.length && i < ratios.length; i++) {
    ws.columns[i].widthRatio = ratios[i];
  }
}),
```

---

## 5. 测试策略

### 5.1 单元测试（pure helpers）

**测试文件：** `src/store/layoutHelpers.collision.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  detectDropZone,
  resolveDropType,
  detectChatColumnDropZone,
  cascadeCollisionDetection,
  resizeColumnSizes,
  type CardSnapshot,
} from '../store/layoutHelpers';

// ── detectDropZone ─────────────────────────────────

describe('detectDropZone', () => {
  const cardRect = {
    left: 0, top: 0, right: 400, bottom: 400,
    width: 400, height: 400,
  };
  const tabBarH = 36;

  it('returns split-col-left when mouse is near left edge', () => {
    const result = detectDropZone(cardRect, 10, 200, tabBarH, false);
    expect(result.zone).toBe('split-col-left');
  });

  it('returns split-col-right when mouse is near right edge', () => {
    const result = detectDropZone(cardRect, 390, 200, tabBarH, false);
    expect(result.zone).toBe('split-col-right');
  });

  it('returns bodyZone=center when mouse is in tab bar', () => {
    const result = detectDropZone(cardRect, 200, 18, tabBarH, false);
    expect(result.zone).toBeNull();
    expect(result.bodyZone).toBe('center');
  });

  it('returns bodyZone=top when mouse is in top 20% of body', () => {
    const result = detectDropZone(cardRect, 200, 80, tabBarH, false);
    expect(result.bodyZone).toBe('top');
  });

  it('returns bodyZone=bottom when mouse is in bottom 20% of body', () => {
    const result = detectDropZone(cardRect, 200, 360, tabBarH, false);
    expect(result.bodyZone).toBe('bottom');
  });

  it('returns bodyZone=center when mouse is in center 60%', () => {
    const result = detectDropZone(cardRect, 200, 200, tabBarH, false);
    expect(result.bodyZone).toBe('center');
  });

  describe('chat column special handling', () => {
    it('returns split-col-left in chat left zone', () => {
      const result = detectDropZone(cardRect, 80, 200, tabBarH, true);
      expect(result.zone).toBe('split-col-left');
    });

    it('returns split-col-right in chat right zone', () => {
      const result = detectDropZone(cardRect, 320, 200, tabBarH, true);
      expect(result.zone).toBe('split-col-right');
    });

    it('returns null in chat center zone', () => {
      const result = detectDropZone(cardRect, 200, 200, tabBarH, true);
      expect(result.zone).toBeNull();
    });
  });
});

// ── resolveDropType ─────────────────────────────────

describe('resolveDropType', () => {
  const baseCtx: Parameters<typeof resolveDropType>[1] = {
    isSelfHover: false,
    isDragFromTabButton: true,
    cardsLength: 3,
    isChatColumn: false,
    hasTabsBar: true,
    sourceColIdx: 0,
    targetColIdx: 1,
    sourceGroupIdx: 0,
    targetGroupIdx: 0,
    isOnlyCardInCol: false,
    sourceColGroupsLength: 2,
  };

  it('returns split-col-left for colZone=same', () => {
    const zone = { zone: 'split-col-left' as const, bodyZone: 'center' as const };
    const result = resolveDropType(zone, baseCtx);
    expect(result).toBe('split-col-left');
  });

  it('returns merge for tab bar with hasTabsBar and not self', () => {
    const zone = { zone: null as const, bodyZone: 'center' as const };
    const result = resolveDropType(zone, { ...baseCtx, isSelfHover: false });
    expect(result).toBe('merge');
  });

  it('returns self-reorder for tab bar with isSelfHover', () => {
    const zone = { zone: null as const, bodyZone: 'center' as const };
    const result = resolveDropType(zone, { ...baseCtx, isSelfHover: true });
    expect(result).toBe('self-reorder');
  });

  it('returns null for tab bar with no hasTabsBar and not self', () => {
    const zone = { zone: null as const, bodyZone: 'center' as const };
    const result = resolveDropType(zone, { ...baseCtx, isSelfHover: false, hasTabsBar: false });
    expect(result).toBeNull();
  });

  it('returns split-card-top for bodyZone top (non-self)', () => {
    const zone = { zone: null as const, bodyZone: 'top' as const };
    const result = resolveDropType(zone, baseCtx);
    expect(result).toBe('split-card-top');
  });

  it('returns split-card-bottom for bodyZone bottom (non-self)', () => {
    const zone = { zone: null as const, bodyZone: 'bottom' as const };
    const result = resolveDropType(zone, baseCtx);
    expect(result).toBe('split-card-bottom');
  });
});

// ── cascadeCollisionDetection ───────────────────────

describe('cascadeCollisionDetection', () => {
  const makeSnapshot = (id: string, l: number, t: number, r: number, b: number): CardSnapshot => ({
    rect: { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t },
    colIdx: 0, groupIdx: 0, groupId: id,
    isChatColumn: false, hasTabsBar: true, tabBarH: 36,
  });

  it('returns exact hit when point is inside a snapshot', () => {
    const snapshots = [makeSnapshot('a', 0, 0, 100, 100)];
    const result = cascadeCollisionDetection(snapshots, 50, 50);
    expect(result?.groupId).toBe('a');
  });

  it('returns nearest when no exact hit but close enough', () => {
    const snapshots = [makeSnapshot('near', 0, 0, 100, 100), makeSnapshot('far', 500, 500, 600, 600)];
    const result = cascadeCollisionDetection(snapshots, 120, 50);
    expect(result?.groupId).toBe('near');
  });

  it('returns null when no snapshots', () => {
    expect(cascadeCollisionDetection([], 50, 50)).toBeNull();
  });
});

// ── resizeColumnSizes ───────────────────────────────

describe('resizeColumnSizes', () => {
  it('adjusts two adjacent columns', () => {
    const result = resizeColumnSizes([0.5, 0.5], 0, 10);
    expect(result[0]).toBeGreaterThan(0.5);
    expect(result[1]).toBeLessThan(0.5);
    expect(result[0] + result[1]).toBeCloseTo(1, 5);
  });

  it('clamps to min width', () => {
    const result = resizeColumnSizes([0.02, 0.98], 0, -10);
    expect(result[0]).toBeGreaterThanOrEqual(0.04);
  });

  it('handles three columns', () => {
    const result = resizeColumnSizes([0.3, 0.4, 0.3], 1, -20);
    expect(result[1]).toBeLessThan(0.4);
    const total = result.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});
```

### 5.2 集成测试（hooks）

**测试文件：** `src/hooks/useTabDrag.integration.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabDrag } from './useTabDrag';
import { DragOverlayProvider } from '../contexts/dragContext';

// 模拟 PointerEvent
function createPointerEvent(type: string, overrides?: Partial<PointerEvent>) {
  return new PointerEvent(type, {
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    button: 0,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
}

describe('useTabDrag integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns handleTabPointerDown', () => {
    const { result } = renderHook(
      () => useTabDrag({ wsId: 'ws-0', groupId: 'group-1', cardsLength: 3 }),
      { wrapper: DragOverlayProvider }
    );
    expect(result.current.handleTabPointerDown).toBeDefined();
    expect(typeof result.current.handleTabPointerDown).toBe('function');
  });

  it('does not start drag immediately on pointer down', () => {
    const { result } = renderHook(
      () => useTabDrag({ wsId: 'ws-0', groupId: 'group-1', cardsLength: 3 }),
      { wrapper: DragOverlayProvider }
    );
    
    const handler = result.current.handleTabPointerDown;
    const el = document.createElement('div');
    el.className = 'card-tab';
    el.setAttribute('data-card-id', 'files');
    
    // 模拟 pointerdown
    act(() => {
      const ev = createPointerEvent('pointerdown', { clientX: 100, clientY: 100 });
      Object.defineProperty(ev, 'currentTarget', { value: el });
      Object.defineProperty(ev, 'target', { value: el });
      (handler as any)(ev as React.PointerEvent<HTMLDivElement>, 'files');
    });
    
    // 此时 drag 尚未开始（未超过阈值）
    // 验证方式：检查 draggedTab 仍为 null
    const state = useWorkspaceStore.getState();
    expect(state.draggedTab).toBeNull();
  });

  it('starts drag after threshold is exceeded', async () => {
    // 模拟 pointerdown + pointermove 超过阈值
    const { result } = renderHook(
      () => useTabDrag({ wsId: 'ws-0', groupId: 'group-1', cardsLength: 3 }),
      { wrapper: DragOverlayProvider }
    );
    
    const handler = result.current.handleTabPointerDown;
    const el = document.createElement('div');
    el.className = 'card-tab';
    el.setAttribute('data-card-id', 'files');
    
    act(() => {
      const ev = createPointerEvent('pointerdown', { clientX: 100, clientY: 100 });
      Object.defineProperty(ev, 'currentTarget', { value: el });
      Object.defineProperty(ev, 'target', { value: el });
      (handler as any)(ev as React.PointerEvent<HTMLDivElement>, 'files');
    });
    
    // 模拟移动超过 5px 阈值
    act(() => {
      window.dispatchEvent(createPointerEvent('pointermove', {
        clientX: 120, clientY: 100, pointerId: 1,
      }));
    });
    
    // 等待异步状态更新
    await vi.waitFor(() => {
      const state = useWorkspaceStore.getState();
      expect(state.draggedTab).not.toBeNull();
      expect(state.draggedTab?.cardId).toBe('files');
    });
  });
});
```

### 5.3 E2E 测试（visual regression）

**测试文件：** `tests/e2e/drag-drop.spec.ts`

```typescript
// playwright 测试示例
import { test, expect } from '@playwright/test';

test.describe('Tab drag-and-drop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 等待应用加载完成
    await page.waitForSelector('.workspace');
  });

  test('drag tab shows preview indicator', async ({ page }) => {
    const tab = page.locator('.card-tab[data-card-id="files"]');
    const tabBox = await tab.boundingBox();
    
    // 开始拖拽
    await page.mouse.move(tabBox!.x + 10, tabBox!.y + 10);
    await page.mouse.down();
    // 移动超过阈值
    await page.mouse.move(tabBox!.x + 50, tabBox!.y + 50, { steps: 10 });
    
    // 验证拖拽浮层出现
    const overlay = page.locator('.drag-overlay-item');
    await expect(overlay).toBeVisible();
    
    // 验证 drop preview 出现
    const placeholder = page.locator('.drop-placeholder');
    await expect(placeholder).toBeVisible();
    
    // 释放
    await page.mouse.up();
    
    // 验证浮层消失（动画结束后）
    await expect(overlay).not.toBeVisible({ timeout: 500 });
  });

  test('drag tab to merge into another group', async ({ page }) => {
    // 设置布局：两列
    // ...
    
    const sourceTab = page.locator('.workspace-card').first().locator('.card-tab').first();
    const targetTabBar = page.locator('.workspace-card').last().locator('.tabs-bar');
    
    const sourceBox = await sourceTab.boundingBox();
    const targetBox = await targetTabBar.boundingBox();
    
    // 拖到目标标签栏
    await page.mouse.move(sourceBox!.x + 5, sourceBox!.y + 5);
    await page.mouse.down();
    await page.mouse.move(targetBox!.x + 10, targetBox!.y + 10, { steps: 20 });
    
    // 验证 merge preview
    const mergePlaceholder = page.locator('.drop-placeholder');
    await expect(mergePlaceholder).toHaveAttribute('data-direction', 'merge');
    
    // 释放
    await page.mouse.up();
    
    // 验证合并后的 tab 数量
    await expect(targetTabBar.locator('.card-tab')).toHaveCount(/* 预期数量 */);
  });

  test('column resize handle interaction', async ({ page }) => {
    const handle = page.locator('.col-resize-handle').first();
    const handleBox = await handle.boundingBox();
    
    // 拖拽调整列宽
    await page.mouse.move(handleBox!.x + 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x - 100, handleBox!.y + handleBox!.height / 2, { steps: 10 });
    await page.mouse.up();
    
    // 验证列宽变化（左侧列变宽）
    const leftCol = page.locator('.workspace-column').first();
    const rightCol = page.locator('.workspace-column').last();
    const leftBox = await leftCol.boundingBox();
    const rightBox = await rightCol.boundingBox();
    
    // 左侧应大于右侧（因为向左拖动了手柄）
    expect(leftBox!.width).toBeGreaterThan(rightBox!.width);
  });
});
```

---

## 总结

本方案围绕三个核心原则设计：
1. **增量改进** — 不重写现有逻辑，逐步提取优化
2. **借鉴最佳实践** — 学习 DnD Kit 的碰撞检测和 DragOverlay 架构
3. **可测试性** — 纯函数碰撞检测 + Hook 集成测试 + E2E 视觉回归

**关键变更文件列表：**

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/hooks/useTabDrag.ts` | 重构 | DOM 操作 → DragOverlay Context |
| `src/contexts/dragContext.tsx` | 新建 | DragOverlay Provider |
| `src/hooks/useDropAnimation.ts` | 新建 | 拖拽结束动画 |
| `src/store/layoutHelpers.ts` | 增强 | 新增碰撞检测函数 |
| `src/components/drag/GlobalDragOverlay.tsx` | 新建 | Portal 渲染 |
| `src/components/workspace/ColumnResizeHandle.tsx` | 新建 | 列宽拖动手柄 |
| `src/styles/shell/shell-dragdrop.css` | 更新 | 拖拽相关 CSS |
| `src/store/workspaceActions.ts` | 增强 | 新增 setColumnWidthRatios |

**不修改的文件：**
- `src/store/layoutStore.ts` — 仅需添加一行 action
- `src/store/layoutHelpers.tab.test.ts` — 已有测试互不冲突
- `src/store/types.ts` — 类型定义已有
