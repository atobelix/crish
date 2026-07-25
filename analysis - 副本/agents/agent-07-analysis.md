# Agent 7: 前端拖拽库完整分析报告

## 目录
1. DnD Kit 完整分析
   - 1.1 架构概览
   - 1.2 Collision Detection 算法详解
   - 1.3 DragOverlay 的 Portal + 绝对定位实现
   - 1.4 不是用 DOM splice 而是纯视觉覆盖
   - 1.5 Sensors 系统
   - 1.6 Auto-scroll 机制
   - 1.7 性能优化策略
   - 1.8 无障碍支持
2. React Grid Layout 完整分析
   - 2.1 架构概览
   - 2.2 拖拽占位模式（纯 CSS + pointer-events: none）
   - 2.3 布局引擎
   - 2.4 React + DnD 的集成模式
   - 2.5 性能特性
3. react-resizable-panels 分析
   - 3.1 PanelGroup 架构
   - 3.2 PanelResizeHandle 事件处理
   - 3.3 CSS 样式策略
   - 3.4 Panel 大小管理
4. SortableJS 分析
   - 4.1 架构概览
   - 4.2 核心拖拽流程
   - 4.3 Ghost 元素机制
   - 4.4 Swap 算法
   - 4.5 动画系统
5. 各库的对比
   - 5.1 DnD Kit vs react-beautiful-dnd
   - 5.2 各库的优缺点
   - 5.3 适用场景
6. 对 Crish 的启示
   - 6.1 DnD Kit 碰撞检测 → useTabDrag 碰撞检测改进
   - 6.2 DragOverlay 架构 → 统一全局浮层方案
   - 6.3 PanelGroup → 列宽拖拽改进
   - 6.4 React Grid Layout → 布局占位方式

---

## 1. DnD Kit 完整分析

### 1.1 架构概览

DnD Kit 是当前 React 生态中最先进的拖拽库之一。其核心架构由以下几部分组成：

**核心组件：**
- `DndContext` — 拖拽全局上下文，管理状态机、碰撞检测、传感器协调
- `DragOverlay` — 拖拽视觉浮层，Portal 渲染，不修改原始 DOM
- `useDraggable` — 使元素可拖拽的 Hook
- `useDroppable` — 使元素可放置的 Hook

**状态管理：**
DnD Kit 使用 `useReducer` 管理内部状态，状态通过 React Context 传递。状态结构在 `store/index.ts` 中定义：

```typescript
// store 的核心结构（从源码反推）
interface State {
  draggable: {
    active: UniqueIdentifier | null;
    nodes: Map<UniqueIdentifier, DraggableNode>;
    translate: Coordinates;
  };
  droppable: {
    containers: DroppableContainer[];
  };
}
```

**数据流：**
```
用户交互 → Sensor → DndContext dispatch → useReducer state → 
Context 传播 → useDraggable/useDroppable 消费 → UI 更新
```

**关键源码分析（DndContext.tsx）：**

`DndContext` 是 memo 组件，使用 `useReducer` 创建内部 store。状态分三个层级传播：
- `PublicContext` — 公开上下文（active, over, collisions, droppableRects 等）
- `InternalContext` — 内部上下文（dispatch, draggableNodes, activators 等）
- `ActiveDraggableContext` — 仅当前拖拽项的 Transform 信息

```typescript
// DndContext.tsx — 核心状态机
export const DndContext = memo(function DndContext({ ... }: Props) {
  const store = useReducer(reducer, undefined, getInitialState);
  const [state, dispatch] = store;
  
  // 三层上下文
  <InternalContext.Provider value={internalContext}>
    <PublicContext.Provider value={publicContext}>
      <ActiveDraggableContext.Provider value={transform}>
        {children}
      </ActiveDraggableContext.Provider>
    </PublicContext.Provider>
  </InternalContext.Provider>
});
```

### 1.2 Collision Detection 算法详解

碰撞检测是 DnD Kit 最核心的设计之一。库提供了多个内置算法，并支持自定义。

#### rectIntersection（矩形交集算法）

```typescript
// rectIntersection.ts — 默认碰撞检测算法
export const rectIntersection: CollisionDetection = ({
  collisionRect,  // 拖拽元素的矩形
  droppableRects, // 所有可放置区域的矩形
  droppableContainers,
}) => {
  for (const droppableContainer of droppableContainers) {
    const rect = droppableRects.get(id);
    if (rect) {
      const intersectionRatio = getIntersectionRatio(rect, collisionRect);
      if (intersectionRatio > 0) {
        collisions.push({ id, data: { value: intersectionRatio } });
      }
    }
  }
  return collisions.sort(sortCollisionsDesc); // 按交集面积降序
};
```

**原理：** 计算拖拽矩形与每个 droppable 矩形的重叠面积所占百分比（IoU 变体：`intersectionArea / (targetArea + entryArea - intersectionArea)`）。然后将结果按交并比降序排列，第一个就是最佳命中目标。

**特点：**
- O(n) 遍历所有 droppable
- 适合大面积重叠场景（网格布局、卡片面板）
- 拖拽元素必须与目标有实际像素重叠才触发

#### closestCenter（最近中心算法）

```typescript
// closestCenter.ts
export const closestCenter: CollisionDetection = ({
  collisionRect, droppableRects, droppableContainers,
}) => {
  const centerRect = centerOfRectangle(collisionRect);
  for (const droppableContainer of droppableContainers) {
    const rect = droppableRects.get(id);
    if (rect) {
      const distBetween = distanceBetween(
        centerOfRectangle(rect), centerRect
      );
      collisions.push({ id, data: { value: distBetween } });
    }
  }
  return collisions.sort(sortCollisionsAsc); // 按距离升序
};
```

**原理：** 计算拖拽矩形的中心点到每个 droppable 矩形中心点的欧几里得距离，按距离升序排列。

**特点：**
- 不需要实际重叠
- 适合列表排序场景（如 Trello 看板）
- 鼠标在空区域也能找到最近目标

#### closestCorners（最近四角算法）

```typescript
// closestCorners.ts
export const closestCorners: CollisionDetection = ({
  collisionRect, droppableRects, droppableContainers,
}) => {
  const corners = cornersOfRectangle(collisionRect);
  for (const droppableContainer of droppableContainers) {
    const rect = droppableRects.get(id);
    if (rect) {
      const rectCorners = cornersOfRectangle(rect);
      const distances = corners.reduce((acc, corner, index) => {
        return acc + distanceBetween(rectCorners[index], corner);
      }, 0);
      collisions.push({ id, data: { value: distances / 4 } });
    }
  }
  return collisions.sort(sortCollisionsAsc);
};
```

**原理：** 计算拖拽矩形四个角到每个 droppable 矩形对应角的平均距离（四个角的欧几里得距离之和 / 4）。

**特点：**
- 比 closestCenter 更精确，考虑了矩形形状
- 适合对齐要求高的场景
- 计算开销稍大（需要计算四个角）

**自定义碰撞检测：**
DnD Kit 允许组合多个算法，实现"先交集再最近"的级联策略：

```typescript
// 先尝试 rectIntersection，若无命中则 fallback 到 closestCenter
const customCollisionDetection = (args) => {
  const rectCollisions = rectIntersection(args);
  if (rectCollisions.length > 0) return rectCollisions;
  return closestCenter(args);
};
```

### 1.3 DragOverlay 的 Portal + 绝对定位实现

`DragOverlay` 是 DnD Kit 最具创新性的设计之一。它通过 React Portal 将拖拽视觉元素渲染到 DOM 树顶部，完全不修改原始 DOM 结构。

**核心源码（DragOverlay.tsx）：**

```typescript
export const DragOverlay = React.memo(({
  adjustScale, children, dropAnimation, modifiers, wrapperElement, zIndex = 999,
}: Props) => {
  const { active, activeNodeRect, dragOverlay, ... } = useDndContext();
  const transform = useContext(ActiveDraggableContext);
  const modifiedTransform = applyModifiers(modifiers, { ... });
  
  return (
    <NullifiedContextProvider>
      <AnimationManager animation={dropAnimation}>
        {active ? (
          <PositionedOverlay
            ref={dragOverlay.setRef}
            as={wrapperElement}
            rect={initialRect}
            style={{ zIndex }}
            transform={modifiedTransform}
          >
            {children}
          </PositionedOverlay>
        ) : null}
      </AnimationManager>
    </NullifiedContextProvider>
  );
});
```

**关键设计：**

1. **NullifiedContextProvider** — 内部 Context 置空，避免 DragOverlay 内的子元素响应拖拽事件
2. **PositionedOverlay** — 使用 `position: fixed` 绝对定位，通过 CSS transform 跟随鼠标
3. **useDragOverlayMeasuring** — 测量拖拽浮层的尺寸，供碰撞检测使用
4. **useDropAnimation** — 拖拽结束时的归位动画

**PositionedOverlay 实现原理：**
```typescript
// PositionedOverlay — 渲染为 body 的直接子级
// 使用 fixed 定位 + transform 实现视觉跟随
<style>
  position: fixed;
  z-index: 999;
  pointer-events: none;  // 避免阻挡下层交互
  transform: translate(${x}px, ${y}px) scale(${scale});
</style>
```

**DropAnimation 机制：**
- 拖拽结束时，DragOverlay 不会立即消失
- 先通过 CSS transition 将 overlay 动画到目标位置（落地位置）
- 动画完成后移除 DOM 节点
- `dropAnimation` 配置可自定义 duration、easing、sideEffects

### 1.4 不是用 DOM splice 而是纯视觉覆盖

DnD Kit 的一个重要设计哲学是：**拖拽过程中不修改原始 DOM 树**。

对比传统实现：

| 特性 | 传统方式（DOM splice） | DnD Kit 方式 |
|------|----------------------|-------------|
| 拖拽时 | 从原位置移除元素，插入到拖拽结束处 | 元素原地保留，overlay 浮层跟随鼠标 |
| DOM 操作 | 频繁插入/删除节点 | 完全不修改 children 结构 |
| 性能影响 | 重排重绘，可能丢失状态 | 仅 CSS transform，无重排 |
| 组件状态 | 卸载/重挂载导致状态丢失 | 组件始终保持 mounted |

**实现细节：**
```typescript
// DnD Kit 的 useDraggable 只做两件事：
// 1. 注册 draggable node（不修改 DOM）
// 2. 提供 listener（不自动包裹元素）
const { attributes, listeners, setNodeRef, transform } = useDraggable({ id });

// 用户自行决定如何应用 transform
// 通常：transform 来自 ActiveDraggableContext
// 当 isDragging 时，通过 CSS transform 偏移原始元素
```

**对 Crish 的启发：**
Crish 当前的 `useTabDrag` 使用了 `cloneNode(true)` 来创建 drag overlay，但原始元素仍然保留在原位。这与 DnD Kit 的纯视觉覆盖理念一致。改进方向：
- 用 React Portal 替代 `document.body.appendChild`
- 用 CSS transform 替代 `left/top` 定位
- 标准化 DragOverlay 组件

### 1.5 Sensors 系统

DnD Kit 的传感器（Sensor）系统是其灵活性的关键。传感器负责将原始 DOM 事件（pointer、touch、keyboard）转换为拖拽语义。

**传感器架构：**
```typescript
// 传感器接口
interface Sensor {
  new (props: SensorProps): SensorInstance;
  activators: SensorActivator[];
  setup?(): () => void;  // 可选：全局 setup/teardown
}

interface SensorInstance {
  autoScrollEnabled: boolean;
  // 由 DndContext 调用的生命周期方法
}

interface SensorActivator {
  eventName: string;  // React 事件名（onPointerDown, onTouchStart）
  handler: (event: ReactEvent, options, context) => boolean;
}
```

#### PointerSensor
```typescript
// PointerSensor.ts — 基础指针传感器
export class PointerSensor extends AbstractPointerSensor {
  constructor(props) {
    // 指针事件在目标卸载后会停止触发
    // 因此将监听器挂载到 ownerDocument
    const listenerTarget = getOwnerDocument(event.target);
    super(props, events, listenerTarget);
  }
  
  static activators = [{
    eventName: 'onPointerDown',
    handler: ({ nativeEvent }, { onActivation }) => {
      if (!event.isPrimary || event.button !== 0) return false;
      onActivation?.({ event });
      return true;
    },
  }];
}
```

关键点：当拖拽元素被卸载时，pointer events 停止触发。DnD Kit 将 move/up 监听器挂载到 `ownerDocument` 而非目标元素本身，确保拖拽过程中元素卸载时仍能正确捕获事件。

#### TouchSensor
```typescript
// TouchSensor.ts — 触屏传感器
export class TouchSensor extends AbstractPointerSensor {
  static activators = [{
    eventName: 'onTouchStart',
    handler: ({ nativeEvent }, { onActivation }) => {
      const { touches } = event;
      if (touches.length > 1) return false; // 多指触控忽略
      return true;
    },
  }];
  
  static setup() {
    // iOS Safari 需要非 passive touchmove 监听器
    // 才能动态调用 preventDefault()
    window.addEventListener('touchmove', noop, { capture: false, passive: false });
    return () => window.removeEventListener('touchmove', noop);
  }
}
```

#### KeyboardSensor
键盘传感器通过箭头键模拟拖拽，提供完整的无障碍支持。

**传感器协调（useCombineActivators）：**
```typescript
// DndContext 中传感器协调逻辑
const bindActivatorToSensorInstantiator = (handler, sensor) => {
  return (event, active) => {
    // 防止多个传感器冲突：
    // 1. 已有传感器在激活 → 跳过
    // 2. 事件已被捕获 → 跳过
    // 3. 事件已 preventDefault → 跳过
    if (activeRef.current !== null || !activeDraggableNode 
        || nativeEvent.dndKit || nativeEvent.defaultPrevented) {
      return;
    }
    if (shouldActivate) {
      nativeEvent.dndKit = { capturedBy: sensor.sensor };
      activeRef.current = active;
      instantiateSensor(event, sensor);
    }
  };
};
```

**对 Crish 的启示：**
Crish 当前在 `useTabDrag` 中直接使用 `window.addEventListener('pointermove', ...)` 和 `window.addEventListener('pointerup', ...)`，这本质上是手动实现了 PointerSensor。但缺少：
- 传感器协调（多点触控防串扰 → 已通过 `pointerId` 部分解决）
- 键盘导航支持
- 延迟激活（用户可配 delay/threshold）

### 1.6 Auto-scroll 机制

DnD Kit 的自动滚动机制非常完善，其核心实现在 `useAutoScroller.ts`：

```typescript
// useAutoScroller.ts — 自动滚动核心
export function useAutoScroller({
  acceleration,       // 加速度系数
  activator,           // 触发方式：Pointer 或 DraggableRect
  canScroll,           // 自定义可滚动判定
  enabled,
  interval = 5,        // 滚动步进间隔（毫秒）
  order,               // 遍历顺序
  pointerCoordinates,  // 指针坐标
  scrollableAncestors, // 所有可滚动祖先
  scrollableAncestorRects,
  delta,
  threshold,           // 激活滚动的边距阈值
}) {
  const scrollIntent = useScrollIntent({ delta, disabled: !enabled });
  
  // 遍历所有可滚动祖先（从内到外或从外到内）
  for (const scrollContainer of sortedScrollableAncestors) {
    const { direction, speed } = getScrollDirectionAndSpeed(
      scrollContainer, scrollContainerRect, rect, acceleration, threshold
    );
    if (speed.x > 0 || speed.y > 0) {
      // 找到第一个需要滚动的容器，开始自动滚动
      setAutoScrollInterval(autoScroll, interval);
      return;
    }
  }
}
```

**Scroll Intent Detection：**
DnD Kit 通过 `useScrollIntent` 跟踪用户的滚动意图。原理是检测 `delta` 的变化方向：
- 如果用户持续向某一方向移动（delta 递增/递减），则认为有滚动意图
- 滚动方向与指针移动方向一致

**Layout Shift Compensation：**
```typescript
// 当 DOM 因拖拽变化导致布局偏移时，补偿 scroll offset
useLayoutShiftScrollCompensation({
  activeNode,
  config: autoScrollOptions.layoutShiftCompensation,
  initialRect: initialActiveNodeRect,
  measure: measuringConfiguration.draggable.measure,
});
```

### 1.7 性能优化策略

DnD Kit 在性能方面做了大量优化：

**1.7.1 React.memo**
`DndContext` 和 `DragOverlay` 都使用 `React.memo` 包裹。

**1.7.2 useMemo 缓存**
```typescript
// DndContext 中使用 useMemo 缓存上下文
const publicContext = useMemo(() => ({
  active, activeNode, collisionRect, collisions,
  droppableContainers, droppableRects, over,
  // ... 数十个字段
}), [active, activeNode, collisions, over, /* 每个字段独立依赖 */]);

const internalContext = useMemo(() => ({
  activatorEvent, activators, active, dispatch,
  // ...
}), [activatorEvent, activators, active, dispatch, /* ... */]);
```

**1.7.3 unstable_batchedUpdates**
```typescript
// 批量更新，避免多次渲染
unstable_batchedUpdates(() => {
  onDragStart?.(event);
  dispatch({ type: Action.DragStart, ... });
  setActiveSensor(activeSensorRef.current);
  setActivatorEvent(activatorEvent);
});
```

**1.7.4 useLatestValue**
```typescript
// 使用 ref 保存最新 props，避免闭包捕获过期值
const latestProps = useLatestValue(props, Object.values(props));
// 然后在事件回调中读取 latestProps.current
```

**1.7.5 条件重渲染**
- 碰撞检测只在 `active && collisionRect` 时执行
- 通过 `enabledDroppableContainers` 仅在拖拽激活时测量 droppable rects
- DragOverlay 的 `useDropAnimation` 使用 requestAnimationFrame

### 1.8 无障碍支持

DnD Kit 内置了完整的无障碍支持，这在拖拽库中非常罕见。

**1.8.1 ARIA 属性**
```typescript
// useDraggable.ts — DraggableAttributes
const memoizedAttributes = useMemo(() => ({
  role: 'button',
  tabIndex: 0,
  'aria-disabled': disabled,
  'aria-pressed': isDragging && role === 'button' ? true : undefined,
  'aria-roledescription': 'draggable',
  'aria-describedby': ariaDescribedById.draggable,
}), [disabled, role, tabIndex, isDragging, roleDescription, ariaDescribedById]);
```

**1.8.2 Accessibility 组件**
```typescript
// DndContext 中渲染的 Accessibility 组件
<Accessibility
  announcements={accessibility?.announcements}
  hiddenTextDescribedById={draggableDescribedById}
/>
```

**1.8.3 ScreenReaderInstructions**
- 通过 `aria-describedby` 连接到一个隐藏的屏幕阅读器文本元素
- 告知用户"按空格键开始拖拽，按方向键移动"

**1.8.4 RestoreFocus**
```typescript
// 拖拽结束后恢复焦点
<RestoreFocus disabled={accessibility?.restoreFocus === false} />
```

**1.8.5 KeyboardSensor**
完整的键盘拖拽支持：
- Space/Enter：开始拖拽
- 方向键：在 droppable 之间移动
- Escape：取消拖拽

**对 Crish 的启示：**
Crish 当前的拖拽实现没有 ARIA 属性，也没有键盘导航支持。改进方向：
- 为 draggable tab 添加 `role="tab"` 和 `aria-grabbed` 属性
- 添加 `RoleDescription` 告知用户"可拖拽标签"
- 实现键盘排序（通过箭头键在 tabs 内移动）

---

## 2. React Grid Layout 完整分析

### 2.1 架构概览

React Grid Layout 是一个基于 React 的网格布局系统，支持拖拽和缩放。

**核心组件：**
- `ReactGridLayout` — 容器组件，管理布局状态
- `GridItem` — 网格项，包裹 draggable + resizable

**依赖：**
- `react-draggable` — 拖拽驱动（Core 版本，无 handle 的底层）
- `react-resizable` — 缩放驱动

**布局模型：**
```
┌─────────────────────────────────────────┐
│  ReactGridLayout (cols=12, rowHeight=150)│
│  ┌────────┐  ┌────────┐  ┌────────┐   │
│  │GridItem│  │GridItem│  │GridItem│   │
│  │  w=4   │  │  w=4   │  │  w=4   │   │
│  └────────┘  └────────┘  └────────┘   │
│  ┌────────────────────┐  ┌────────┐   │
│  │ GridItem  w=8     │  │ w=4   │   │
│  └────────────────────┘  └────────┘   │
└─────────────────────────────────────────┘
```

### 2.2 拖拽占位模式（纯 CSS + pointer-events: none）

React Grid Layout 使用**占位元素（placeholder）** 实现视觉反馈，而非 DragOverlay 方式。

**占位元素生成（ReactGridLayout.jsx）：**
```typescript
placeholder() {
  const { activeDrag } = this.state;
  if (!activeDrag) return null;
  return (
    <GridItem
      w={activeDrag.w}
      h={activeDrag.h}
      x={activeDrag.x}
      y={activeDrag.y}
      className="react-grid-placeholder"  // ← 灰色占位
      isDraggable={false}
      isResizable={false}
      // ... 其他 props
    >
      <div />
    </GridItem>
  );
}
```

**拖拽流程：**
```
1. onDragStart: 
   - 克隆当前 layout item 作为 oldDragItem
   - 创建 placeholder（旧位置标记）
   
2. onDrag:
   - 通过 moveElement → compact 计算新位置
   - placeholder 更新到新位置（视觉上灰色块跟随）
   - 实际 DOM 元素用 CSS transform 跟随鼠标
   - 其他元素重新排列（通过 compact 函数）

3. onDragStop:
   - 最终 compact 布局
   - placeholder 消失
   - 触发 onLayoutChange 回调
```

**CSS 实现：**
```css
.react-grid-placeholder {
  background: red;          /* 占位色 */
  opacity: 0.1;            /* 半透明 */
  transition-duration: 100ms; /* 平滑过渡 */
  z-index: 2;
  pointer-events: none;    /* 关键：不阻挡交互 */
  user-select: none;
}
```

**transform vs top/left：**
```typescript
// GridItem.jsx — createStyle
createStyle(pos) {
  if (useCSSTransforms) {
    style = setTransform(pos); // CSS transform（高性能）
  } else {
    style = setTopLeft(pos);   // top/left（兼容性好）
  }
}
```

### 2.3 布局引擎

**布局计算算法（compact）：**
```typescript
// 核心压缩算法
function compact(layout, compactType, cols) {
  // 1. 按 y 坐标排序（从上到下）
  const sorted = sortLayout(layout);
  // 2. 逐行扫描，将元素上移/左移填补空隙
  const compacted = [];
  for (const item of sorted) {
    // 找到可容纳的最靠上的位置
    let y = findAvailablePosition(compacted, item, cols);
    compacted.push({ ...item, y });
  }
  return compacted;
}
```

**碰撞检测（getAllCollisions）：**
```typescript
function getAllCollisions(layout, layoutItem) {
  // 检测 layoutItem 与 layout 中其他元素的重叠
  return layout.filter(l => 
    l.i !== layoutItem.i && isOverlapping(l, layoutItem)
  );
}

function isOverlapping(a, b) {
  // 两个矩形是否有重叠
  return !(
    a.x + a.w <= b.x || b.x + b.w <= a.x ||
    a.y + a.h <= b.y || b.y + b.h <= a.y
  );
}
```

**moveElement：**
```typescript
function moveElement(layout, l, x, y, isUserAction, preventCollision, compactType, cols, allowOverlap) {
  // 1. 计算新位置
  l.x = x;
  l.y = y;
  // 2. 如果 preventCollision 且发生碰撞，回退到原位置
  if (preventCollision && !allowOverlap) {
    const collisions = getAllCollisions(layout, l);
    if (collisions.length > 0) return layout;
  }
  // 3. 碰撞的元素向下/右推挤
  const sorted = sortLayout(layout);
  for (const item of sorted) {
    if (item.i === l.i) continue;
    // 如果与已放置的元素碰撞，移动它
    if (isOverlapping(item, currentlyPlaced)) {
      moveItemDown(item, compactType);
    }
  }
  return layout;
}
```

**布局单位转换：**
```typescript
// 像素 ↔ 网格单位转换
function calcGridItemPosition(positionParams, x, y, w, h, state) {
  const { margin, containerPadding, rowHeight, cols, containerWidth } = positionParams;
  
  // 计算每个网格列的像素宽度
  const colWidth = (containerWidth - margin[0] * (cols - 1) - containerPadding[0] * 2) / cols;
  
  return {
    left: containerPadding[0] + x * (colWidth + margin[0]),
    top: containerPadding[1] + y * (rowHeight + margin[1]),
    width: w * colWidth + Math.max(0, w - 1) * margin[0],
    height: h * rowHeight + Math.max(0, h - 1) * margin[1],
  };
}
```

### 2.4 React + DnD 的集成模式

React Grid Layout 使用类组件 + 第三方库的集成方式：

```typescript
// GridItem.jsx — mixinDraggable
mixinDraggable(child, isDraggable) {
  return (
    <DraggableCore
      disabled={!isDraggable}
      onStart={this.onDragStart}
      onDrag={this.onDrag}
      onStop={this.onDragStop}
      handle={this.props.handle}
      cancel={".react-resizable-handle" + (this.props.cancel ? "," + this.props.cancel : "")}
      scale={this.props.transformScale}
      nodeRef={this.elementRef}
    >
      {child}
    </DraggableCore>
  );
}

// GridItem.jsx — mixinResizable
mixinResizable(child, position, isResizable) {
  return (
    <Resizable
      draggableOpts={{ disabled: !isResizable }}
      width={position.width}
      height={position.height}
      minConstraints={minConstraints}
      maxConstraints={maxConstraints}
      onResizeStop={this.curryResizeHandler(position, this.onResizeStop)}
      resizeHandles={resizeHandles}
    >
      {child}
    </Resizable>
  );
}
```

**设计模式：** Draggable 和 Resizable 通过 HOC 组合，而不是通过 Context 传递状态。这种模式的优点是组件自包含，缺点是状态管理在组件内部，不适合跨组件协调。

### 2.5 性能特性

**shouldComponentUpdate 优化：**
```typescript
// ReactGridLayout
shouldComponentUpdate(nextProps, nextState) {
  return (
    this.props.children !== nextProps.children ||
    !fastRGLPropsEqual(this.props, nextProps, deepEqual) ||
    this.state.activeDrag !== nextState.activeDrag ||
    this.state.mounted !== nextState.mounted ||
    this.state.droppingPosition !== nextState.droppingPosition
  );
}

// GridItem
shouldComponentUpdate(nextProps, nextState) {
  if (this.props.children !== nextProps.children) return true;
  if (this.props.droppingPosition !== nextProps.droppingPosition) return true;
  const oldPosition = calcGridItemPosition(...this.props...);
  const newPosition = calcGridItemPosition(...nextProps...);
  return !fastPositionEqual(oldPosition, newPosition) 
    || this.props.useCSSTransforms !== nextProps.useCSSTransforms;
}
```

**CSS Transform 渲染：**
- 默认启用 CSS Transforms（GPU 加速）
- `useCSSTransforms` 在服务端渲染时回退到百分比定位
- 拖拽时只更新 transform，不触发重排

**缺陷：**
- 全量布局计算 O(n²) 复杂度
- 每个 GridItem 独立计算位置，未使用虚拟列表
- 拖拽时所有子元素重新渲染（未隔离）

---

## 3. react-resizable-panels 分析

### 3.1 PanelGroup 架构

react-resizable-panels 是 bvaughn 开发的面板大小可调组件库，专为 IDE 类应用设计。

**核心组件：**
- `PanelGroup` — 容器，管理子面板大小分配
- `Panel` — 面板，通过 size 属性控制
- `PanelResizeHandle` — 拖拽手柄，调节相邻面板大小

**架构特点：**
```
PanelGroup (direction="horizontal")
├── Panel (defaultSize={40})
├── PanelResizeHandle
├── Panel (defaultSize={60})
│   ├── PanelGroup (direction="vertical")
│   │   ├── Panel (defaultSize={50})
│   │   ├── PanelResizeHandle
│   │   └── Panel (defaultSize={50})
│   └── PanelResizeHandle
└── Panel (collapsible={true})
```

**存储管理：**
- Panel 大小通过数组存储（`panels: PanelData[]`）
- 每个 Panel 有 `minSize`, `maxSize`, `defaultSize`, `collapsible` 等属性
- 大小使用百分比，而非像素
- 通过 `onLayout` 回调暴露当前布局

### 3.2 PanelResizeHandle 事件处理

PanelResizeHandle 实现了高效的拖拽事件处理：

**事件绑定模式：**
```typescript
// 使用 pointer events 而非 mouse/touch 事件
onPointerDown: (event) => {
  // 1. 记录起始位置和当前面板大小
  const startPosition = getPointerPosition(event);
  const sizes = panelGroup.getSizes();
  
  // 2. 在 document 上绑定 move/up（类似 DnD Kit 做法）
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  
  // 3. 阻止文本选择
  event.preventDefault();
}
```

**大小调整算法：**
```typescript
onPointerMove: (event) => {
  const currentPosition = getPointerPosition(event);
  const delta = currentPosition - startPosition;
  
  // 1. 将像素差转换为百分比
  const deltaPercent = (delta / panelGroupSize) * 100;
  
  // 2. 调整相邻两个 Panel 的大小
  const newSizes = [...sizes];
  newSizes[panelIndex] += deltaPercent;
  newSizes[panelIndex + 1] -= deltaPercent;
  
  // 3. 应用 min/max 约束
  if (newSizes[panelIndex] < minSize) {
    newSizes[panelIndex] = minSize;
    newSizes[panelIndex + 1] = sizes[panelIndex] + sizes[panelIndex + 1] - minSize;
  }
  
  // 4. 通过回调更新 PanelGroup
  panelGroup.resizePanel(panelIndex, newSizes);
}
```

**关键设计决策：**
- 使用 `pointer events`（统一鼠标和触控）
- 动态绑定/解绑（只在拖拽时绑定 document 事件）
- 百分比计算（自适应容器大小变化）

### 3.3 CSS 样式策略

**面板布局：**
```css
/* PanelGroup 使用 flexbox 布局 */
.panel-group {
  display: flex;
  flex-direction: row | column;  /* 根据 direction prop */
  width: 100%;
  height: 100%;
  overflow: hidden;  /* 防止溢出 */
}

/* Panel 使用 flex-grow 控制大小 */
.panel {
  flex: 0 0 auto;  /* 大小由 PanelGroup 通过 style.width/height 控制 */
  overflow: hidden; /* 防止内容溢出 */
}

/* ResizeHandle */
.panel-resize-handle {
  flex: 0 0 auto;   /* 固定宽度/高度 */
  user-select: none; /* 防止拖拽时选中文本 */
  touch-action: none; /* 防止触摸时浏览器滚动 */
  position: relative;
}
```

**大小管理：**
- Panel 的 `style.flexBasis` 设为百分比
- PanelResizeHandle 的宽度通过 CSS `width: 4px` 等设置
- 通过 `outline` 替代 `border` 避免影响布局计算

### 3.4 Panel 大小管理

**大小存储与持久化：**
```typescript
// 通过 onLayout 回调暴露布局信息
<PanelGroup onLayout={(sizes) => {
  // sizes 是 number[]，每个 panel 的百分比
  localStorage.setItem('panelLayout', JSON.stringify(sizes));
}}>
```

**受控/非受控模式：**
```typescript
// 受控模式
const [sizes, setSizes] = useState([40, 60]);
<PanelGroup sizes={sizes} onLayout={setSizes}>
  <Panel />
  <PanelResizeHandle />
  <Panel />
</PanelGroup>

// 非受控模式
<PanelGroup>
  <Panel defaultSize={40} minSize={20} />
  <PanelResizeHandle />
  <Panel defaultSize={60} collapsible />
</PanelGroup>
```

---

## 4. SortableJS 分析

### 4.1 架构概览

SortableJS 是原生 JavaScript 拖拽排序库，支持所有主流浏览器，不依赖框架。

**核心概念：**
- `Sortable(el, options)` — 创建可排序列表
- `dragEl` — 被拖拽的原始元素
- `ghostEl` — 拖拽时显示的"幽灵"副本
- `cloneEl` — 用于多列表克隆拖拽的副本

### 4.2 核心拖拽流程

**启动流程（_onTapStart → _prepareDragStart → _triggerDragStart）：**

```typescript
_onTapStart(evt) {
  // 1. 过滤：只响应左键、启用的拖拽、有效的 draggable 选择器
  if (evt.button !== 0 || options.disabled) return;
  target = closest(target, options.draggable, el, false);
  if (!target || target.animated) return;
  
  // 2. 记录起始状态
  oldIndex = index(target);
  this._prepareDragStart(evt, touch, target);
}

_prepareDragStart(evt, touch, target) {
  // 记录 dragEl, parentEl, rootEl, nextEl
  dragEl = target;
  rootEl = el;
  
  // 延迟启动（支持 delay 配置）
  if (options.delay) {
    this._dragStartTimer = setTimeout(dragStartFn, options.delay);
  } else {
    dragStartFn();
  }
}
```

**移动逻辑（_onDragOver）：**
- `_onDragOver` 是 SortableJS 最复杂的函数（约 300 行）
- 核心是判断鼠标进入哪个目标元素，以及插入位置
- 使用 `swap` 算法确定拖拽元素应插入的位置

### 4.3 Ghost 元素机制

SortableJS 的 ghost 元素类似 DnD Kit 的 DragOverlay：

```typescript
_appendGhost() {
  // 1. 克隆原始元素
  ghostEl = dragEl.cloneNode(true);
  
  // 2. 设置样式（fixed/absolute 定位）
  css(ghostEl, 'position', 'absolute');  // iOS 用 absolute，其他 fixed
  css(ghostEl, 'top', rect.top);
  css(ghostEl, 'left', rect.left);
  css(ghostEl, 'width', rect.width);
  css(ghostEl, 'height', rect.height);
  css(ghostEl, 'opacity', '0.8');
  css(ghostEl, 'pointerEvents', 'none'); // 不阻挡交互
  
  // 3. 添加到容器
  container.appendChild(ghostEl);
}
```

**不同之处：**
- SortableJS 的 ghost 是真正的 DOM 克隆（包括内容、样式）
- DnD Kit 的 DragOverlay 是 React 组件，开发者可自定义渲染内容
- SortableJS 的 ghost 跟随使用 CSS transform 更新
- DnD Kit 的 DragOverlay 使用 position: fixed + transform

### 4.4 Swap 算法

SortableJS 使用基于交换阈值的排序算法：

```typescript
// swapThreshold 配置（默认 1）：鼠标需要穿过目标元素的多大比例才交换
// invertedSwapThreshold：反转阈值，用于检测边缘极端情况

function _getSwapDirection(evt, target, targetRect, vertical, swapThreshold, ...) {
  const mouseOnAxis = vertical ? evt.clientY : evt.clientX;
  const targetLength = vertical ? targetRect.height : targetRect.width;
  const targetS1 = vertical ? targetRect.top : targetRect.left;
  
  // 检查鼠标位置是否超过 swapThreshold
  if (mouseOnAxis > targetS1 + targetLength * (1 - swapThreshold) / 2
      && mouseOnAxis < targetS2 - targetLength * (1 - swapThreshold) / 2) {
    return 0; // 中间区域，不交换
  }
  
  // 根据鼠标位置决定交换方向（上/下，左/右）
  return mouseOnAxis > targetS1 + targetLength / 2 ? 1 : -1;
}
```

**多列表支持：**
- SortableJS 支持群组（group），同一 group 的列表间可拖拽
- `pull` 和 `put` 配置控制拖拽权限
- 跨列表拖拽时自动处理 `clone` 或 `move`

### 4.5 动画系统

SortableJS 有内置的 CSS transition 动画系统：

```typescript
// Animation.js — 动画管理器
captureAnimationState() {
  // 记录所有子元素的当前位置
  this.animationCaptureId = setInterval(() => {
    for (const child of children) {
      const rect = child.getBoundingClientRect();
      this.animationStates.push({ child, rect, targetRect: null });
    }
  }, 10); // 10ms 间隔采样
}

animateAll(callback) {
  // 将元素从旧位置过渡到新位置
  for (const state of this.animationStates) {
    const { child, rect } = state;
    const newRect = child.getBoundingClientRect();
    
    // 计算 offset
    const dx = rect.left - newRect.left;
    const dy = rect.top - newRect.top;
    
    // 应用 CSS transform（反向偏移到旧位置，再 transition 回来）
    child.style.transform = `translate(${dx}px, ${dy}px)`;
    child.style.transition = 'transform 300ms ease';
    
    // 下一帧移除 transform（触发 transition）
    requestAnimationFrame(() => {
      child.style.transform = '';
    });
  }
}
```

**动画流程：**
1. `captureAnimationState` — 记录所有元素当前位置
2. 执行插入/删除
3. `animateAll` — 计算新旧位置差，通过 CSS transition 动画

---

## 5. 各库的对比

### 5.1 DnD Kit vs react-beautiful-dnd

| 比较维度 | DnD Kit | react-beautiful-dnd |
|---------|---------|-------------------|
| **架构** | 基于 Context + Hook | 基于 Context + Connect |
| **虚拟列表** | 原生支持 | 需要额外配置 |
| **可定制性** | 极高（自定义碰撞检测、传感器、修饰器） | 较低（固定 API） |
| **无障碍** | 完整 ARIA + KeyboardSensor | 基础的 ARIA |
| **DragOverlay** | 通用 Portal 方案 | 仅支持列表内拖拽 |
| **多列表** | 任意多个 droppable | 有限制的多列表 |
| **性能** | 良好的 memo 优化 | 较好的 connect 优化 |
| **灵活性** | 极广（可用作基础库） | 较窄（仅列表排序） |
| **维护状态** | 积极维护（v1.0+） | 停止维护（已归档） |
| **React 版本** | React 16.8+ | React 16.8+ |

**react-beautiful-dnd 的局限：**
- 只支持列表拖拽（不支持自由放置）
- DragDropContext 包裹范围有限制
- 不支持触屏（需要额外库）
- 作者已停止维护

**DnD Kit 的优势：**
- 更通用的拖拽框架
- 可扩展的传感器系统
- 可自定义的碰撞检测
- 更好的 DragOverlay

### 5.2 各库的优缺点

**DnD Kit**
| 优点 | 缺点 |
|------|------|
| 高度可定制（碰撞检测、传感器、修饰器） | 学习曲线陡峭 |
| 完整的无障碍支持 | 文档不够清晰 |
| 性能优秀（memo、batchedUpdates） | 生态不够丰富 |
| DragOverlay 设计巧妙 | 类型复杂 |
| Auto-scroll 完善 | 初始化配置较多 |

**React Grid Layout**
| 优点 | 缺点 |
|------|------|
| 完整的网格布局系统 | 不支持自由放置 |
| 响应式布局 | 性能在大网格时下降 |
| Resizable + Draggable 一体 | 类组件，不够现代 |
| 服务端渲染支持 | 碰撞检测简单 |
| 稳定的 API | 定制性有限 |

**react-resizable-panels**
| 优点 | 缺点 |
|------|------|
| 极简 API | 只支持面板分割 |
| 性能优秀（最小化渲染） | 不支持拖拽排序 |
| 受控/非受控双模式 | 不支持跨面板拖拽 |
| 嵌套布局支持 | 文档较少 |
| 轻量（无外部依赖） | 仅 React 18+ |

**SortableJS**
| 优点 | 缺点 |
|------|------|
| 原生 JS，框架无关 | 不是 React 原生 |
| 兼容性好（IE11+） | React 集成需要包装 |
| 丰富的事件系统 | 状态管理不在 React |
| 完善的动画 | 拖拽 ghost 与 React 虚拟 DOM 冲突 |
| 轻量（~20KB gzip） | 配置分散 |

### 5.3 适用场景

| 场景 | 推荐库 | 理由 |
|------|--------|------|
| 列表排序（TODO、看板） | DnD Kit / SortableJS | 灵活、可定制的碰撞检测 |
| 网格仪表盘 | React Grid Layout | 完整网格布局系统 |
| IDE 面板分割 | react-resizable-panels | 专门的面板调整库 |
| 多列表交叉拖拽 | DnD Kit / SortableJS | 支持群组和跨列表 |
| 自由放置 | DnD Kit | 自定义碰撞检测 |
| 标签拖拽排序 | DnD Kit | DragOverlay + Sensors |
| 大表格/树拖拽 | SortableJS | 原生性能 |
| 复杂布局编辑器 | DnD Kit | 自定义传感器 + 碰撞检测 |

---

## 6. 对 Crish 的启示

### 6.1 DnD Kit 碰撞检测 → useTabDrag 碰撞检测改进

**当前 Crish 实现（useTabDrag.ts）：**
Crish 当前使用自定义的矩形命中检测和相对坐标落点判定：

```typescript
// 当前方案：遍历卡片快照 + 矩形命中 + 距离最近回退
const matchedSnapshot = findCardSnapshotAtPoint(cardSnapshots, mouseX, mouseY);
// 然后通过 resolveTabDrop 使用相对坐标决定落点
```

**改进方案（借鉴 DnD Kit）：**

1. **五区域碰撞检测模型：**
```typescript
// 将目标卡片分为 5 个区域（类似 closestCorners + 中心缓冲区）
export function detectDropZone(cardRect, mouseX, mouseY, config) {
  const { edgeX, edgeY, tabBarH } = config;
  const relX = mouseX - cardRect.left;
  const relY = mouseY - cardRect.top;
  
  // 标签栏区域 → merge
  if (relY < tabBarH) return 'merge';
  
  // 左右边缘（48px）→ split-col
  if (relX < edgeX) return 'split-col-left';
  if (relX > cardRect.width - edgeX) return 'split-col-right';
  
  // 上下边缘（36px）→ split-card
  if (relY < tabBarH + edgeY) return 'split-card-top';
  if (relY > cardRect.height - edgeY) return 'split-card-bottom';
  
  // 中心 60% → merge（安全区）
  return 'merge';
}
```

2. **级联碰撞检测（类似 DnD Kit 的风格）：**
```typescript
// 先命中检测 → 再最近距离
export function detectCollisionFirstHitThenNearest(snapshots, mouseX, mouseY) {
  // 1. 先找直接命中的
  const hit = snapshots.find(s => pointInRect(mouseX, mouseY, s.rect));
  if (hit) return hit;
  
  // 2. 没命中则找最近的（类似 closestCenter）
  let nearest = null, minDist = Infinity;
  for (const s of snapshots) {
    const dist = distanceToCenter(mouseX, mouseY, s.rect);
    if (dist < minDist) { minDist = dist; nearest = s; }
  }
  return nearest;
}
```

3. **Chat 列特殊处理（借鉴 closestCorners 边缘检测）：**
```typescript
// chat 列使用类似 closestCorners 的检测
// 但只返回 left/right 方向，禁止 merge
```

### 6.2 DragOverlay 架构 → 统一全局浮层方案

**当前 Crish 实现：**
```typescript
// useTabDrag 中直接操作 DOM：
dragOverlay = targetEl.cloneNode(true) as HTMLDivElement;
dragOverlay.style.cssText = `position: fixed; ...`;
document.body.appendChild(dragOverlay);
```

**问题：**
- 手动 DOM 操作，与 React 渲染不同步
- 每次拖拽创建/移除 DOM 节点
- 没有 Portal 隔离
- 多个拖拽源无法复用同一个浮层

**改进方案（借鉴 DnD Kit 的 DragOverlay）：**

1. **创建 DragOverlay 组件：**
```typescript
// 全局 DragOverlay 组件
const DragOverlayContext = createContext<{
  setOverlay: (content: ReactNode, rect: DOMRect) => void;
  clearOverlay: () => void;
  animateTo: (targetRect: DOMRect) => void;
} | null>(null);

function GlobalDragOverlay({ children }) {
  const [state, setState] = useState<{
    content: ReactNode;
    style: React.CSSProperties;
  } | null>(null);
  
  const setOverlay = useCallback((content, rect) => {
    setState({
      content,
      style: {
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: 'none',
        zIndex: 10000,
      },
    });
  }, []);
  
  return (
    <>
      {children}
      {ReactDOM.createPortal(
        state && (
          <div style={state.style}>
            {state.content}
          </div>
        ),
        document.body
      )}
    </>
  );
}
```

2. **Tab 拖拽浮层：**
```typescript
function TabDragOverlay({ tabId, children }) {
  const { setOverlay } = useDragOverlay();
  const handlePointerDown = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setOverlay(
      <TabContent tabId={tabId} />,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    );
  }, [tabId, setOverlay]);
  
  return <div onPointerDown={handlePointerDown}>{children}</div>;
}
```

3. **动画归位（借鉴 useDropAnimation）：**
```typescript
// 拖拽结束时，浮层飞到目标位置再消失
const animateTo = useCallback((targetRect: DOMRect) => {
  if (!state) return;
  setState(prev => ({
    ...prev,
    style: {
      ...prev.style,
      transition: 'all 0.28s cubic-bezier(0.19, 1, 0.22, 1)',
      left: targetRect.left,
      top: targetRect.top,
      width: targetRect.width,
      height: targetRect.height,
      opacity: 0.2,
    },
  }));
  setTimeout(() => clearOverlay(), 280);
}, [state]);
```

### 6.3 PanelGroup → 列宽拖拽改进

**当前 Crish 实现：**
列宽通过 `widthRatio` 管理，但拖拽调整列宽未实现。用户目前只能通过代码或预设改变列宽。

**改进方案（借鉴 react-resizable-panels）：**

1. **列大小管理：**
```typescript
// 类似 PanelGroup 的 sizes 数组
type ColumnSizes = number[]; // 各列百分比，总和 = 100

// 调整逻辑
function resizeColumn(sizes: number[], columnIndex: number, deltaPercent: number): number[] {
  const newSizes = [...sizes];
  newSizes[columnIndex] += deltaPercent;
  newSizes[columnIndex + 1] -= deltaPercent;
  
  // 应用 minWidth 约束
  // 列最小宽度为 15%（来自 isToolColumnCollapsed 的阈值）
  const MIN_COL_WIDTH = 15;
  if (newSizes[columnIndex] < MIN_COL_WIDTH) {
    newSizes[columnIndex] = MIN_COL_WIDTH;
    newSizes[columnIndex + 1] = sizes[columnIndex] + sizes[columnIndex + 1] - MIN_COL_WIDTH;
  }
  
  return newSizes;
}
```

2. **ColumnResizeHandle 事件处理：**
```typescript
function useColumnResize(workspaceId: string, columnIndex: number) {
  const [isResizing, setIsResizing] = useState(false);
  
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setIsResizing(true);
    
    const startX = e.clientX;
    const startSizes = getColumnSizes(workspaceId);
    
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const containerWidth = getContainerWidth();
      const deltaPercent = (delta / containerWidth) * 100;
      
      const newSizes = resizeColumn(startSizes, columnIndex, deltaPercent);
      setColumnSizes(workspaceId, newSizes);
    };
    
    const handlePointerUp = () => {
      setIsResizing(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
    
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [workspaceId, columnIndex]);
  
  return { handlePointerDown, isResizing };
}
```

3. **CSS 支持：**
```css
.col-resize-handle {
  width: 4px;
  cursor: col-resize;
  user-select: none;
  touch-action: none;
  position: relative;
  z-index: 10;
}

.col-resize-handle:hover,
.col-resize-handle.is-resizing {
  background: var(--accent-color);
  width: 2px;
  opacity: 0.6;
}
```

### 6.4 React Grid Layout → 布局占位方式

**当前 Crish 实现：**
- 拖拽时在目标位置显示 `DropPreviewState`（方向指示器）
- 通过 `setDropPreview` 更新 store
- 在 Workspace 组件中根据 `dropPreview` 渲染覆盖层

**改进方案（借鉴 React Grid Layout 的 placeholder）：**

1. **统一占位组件：**
```typescript
// Placeholder 组件 — 类似 RGL 的 react-grid-placeholder
function DropPlaceholder({ preview, containerRect }) {
  if (!preview) return null;
  
  const style = computePlaceholderStyle(preview, containerRect);
  return (
    <div
      className="drop-placeholder"
      style={{
        ...style,
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: 5,
        background: 'var(--accent-color)',
        opacity: 0.15,
        borderRadius: '8px',
        transition: 'all 0.1s ease-out',
      }}
    />
  );
}

// 与 RGL 不同的是，Crish 的占位需要显示方向（merge、split-top、split-col-left 等）
// 方向指示：merge 显示全卡覆盖、split 显示边缘条
function computePlaceholderStyle(preview, containerRect) {
  const { direction } = preview;
  switch (direction) {
    case 'merge':
      return { left: 0, top: 0, width: '100%', height: '100%' };
    case 'top':
      return { left: 0, top: 0, width: '100%', height: '40%' };
    case 'bottom':
      return { left: 0, bottom: 0, width: '100%', height: '40%' };
    case 'left':
      return { left: 0, top: 0, width: '50%', height: '100%' };
    case 'right':
      return { left: '50%', top: 0, width: '50%', height: '100%' };
    default:
      return null;
  }
}
```

2. **占位动画（借鉴 RGL 的 transition-duration）：**
```css
.drop-placeholder {
  transition: all 0.15s ease-out;
}

/* 首次出现时的入场动画 */
.drop-placeholder-enter {
  opacity: 0;
  transform: scale(0.95);
}

.drop-placeholder-enter-active {
  opacity: 0.15;
  transform: scale(1);
}
```

3. **性能优化（保持 React 可控）：**
- 占位信息保存在 zustand store（`dropPreview`）
- 只有方向/位置变化时才更新（`dropPreviewEquals` 防抖）
- 占位渲染在 Workspace 层，不触发每个 Card 的重新渲染

---

## 总结

本报告对 DnD Kit、React Grid Layout、react-resizable-panels、SortableJS 四个拖拽库进行了深入的源码级分析。

**核心发现：**
1. DnD Kit 的碰撞检测系统可扩展性极强，适合作为 Crish 拖拽逻辑的基础
2. DragOverlay 的 Portal 模式比当前手动 DOM 操作更符合 React 哲学
3. react-resizable-panels 为列宽拖拽提供了简洁的参考实现
4. React Grid Layout 的 placeholder 系统为 drop preview 提供了好的交互模式

**Crish 改进方向：**
- 碰撞检测：引入 DnD Kit 风格的多策略级联检测
- DragOverlay：采用 Portal + fixed 定位 + CSS transform 的统一浮层
- 列宽拖拽：使用 pointer events + 百分比计算的 PanelGroup 模式
- 占位符：优雅的 CSS transition 动画
