# Agent-06: Crish 项目重构方案

> 基于 VS Code、Obsidian、Linear、Arc Browser 四款软件的深度分析，提取可落地的设计方案

---

## 1. 参考项目架构映射

### 1.1 Crish 当前架构问题

在应用参考方案前，需明确 Crish 的当前架构痛点：

```
Crish 当前问题矩阵：
├── 拖拽事件丢失（iframe 遮挡、pointer capture 未正确释放）
├── 列宽无约束（用户可以拖拽到负宽度）
├── 布局不可持久化（刷新后布局恢复默认）
├── 缺少比例分配（窗口缩放时列宽不按比例调整）
├── 缺少过滚动处理（内容溢出时无滚动条）
├── 无面板显隐控制（不能隐藏/显示列）
└── 无嵌套布局（当前只有单层行列）
```

### 1.2 目标架构映射

从参考项目中提取的核心架构对应关系：

| 参考项目 | 组件/模式 | Crish 映射 |
|---------|-----------|-----------|
| VS Code Sash | `Sash` + `IPointerEventFactory` | `CrishResizeHandle` 拖拽引擎 |
| VS Code SplitView | `IView` + `resize()` | `CrishSplitView` 列宽管理 |
| VS Code Grid | `BranchNode` + `LeafNode` | `CrishGrid` 嵌套布局 |
| VS Code Layout | `LayoutStateModel` | `CrishLayoutStore` 状态管理 |
| VS Code SerializableGrid | `serialize()` / `deserialize()` | `CrishLayoutSerializer` |
| Obsidian Leaf | `WorkspaceLeaf` + `View` | `CrishPanel` 面板单元 |
| Obsidian Tabs | Drag & Drop tabs | `CrishPanelTabs` 标签页 |
| Linear Ghost | Drag card ghost | `CrishDragPreview` 拖拽预览 |
| Arc Spaces | 多空间架构 | `CrishWorkspace` 工作区 |

### 1.3 目标架构层次

```
┌─────────────────────────────────────────────────────┐
│                    CrishWorkspace                    │
│  (多工作区管理，类似 Arc Spaces)                       │
├─────────────────────────────────────────────────────┤
│                    CrishLayoutStore                   │
│  (运行时状态 + 持久化，类似 VS Code LayoutStateModel)  │
├─────────────────────────────────────────────────────┤
│                     CrishGrid                         │
│  (树状嵌套布局，类似 VS Code Grid)                     │
├──────────────┬──────────────┬──────────────────────┤
│ CrishPane    │  CrishPane   │    CrishPane          │
│ (左侧栏)      │ (中间编辑区)  │   (右侧面板)          │
│ ├ tabs       │  ├ tabs      │    ├ tabs             │
│ └ views      │  └ views     │    └ views            │
├──────────────┴──────────────┴──────────────────────┤
│                   CrishResizeHandle                   │
│  (拖拽调整大小，类似 VS Code Sash)                     │
├─────────────────────────────────────────────────────┤
│                   CrishDragSystem                      │
│  (拖拽事件管理 + 全局光标 + iframe 保护)               │
└─────────────────────────────────────────────────────┘
```

---

## 2. 可落地的借鉴点

### 2.1 VS Code 的 Sash 架构 → Crish 的列宽拖拽

**借鉴点：Sash 的事件处理和状态管理**

```typescript
// 目标 API 设计
interface ICrishSashOptions {
  orientation: Orientation;       // VERTICAL | HORIZONTAL
  size?: number;                  // 默认 4px
  orthogonalStartSash?: CrishSash;
  orthogonalEndSash?: CrishSash;
  orthogonalEdge?: OrthogonalEdge;
}

interface ICrishSashEvent {
  readonly startX: number;
  readonly currentX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly altKey: boolean;
}
```

**关键实现要点：**
1. `CrishSash` 类继承 `Disposable` 模式（VS Code 的生命周期管理）
2. 使用 `IPointerEventFactory` 抽象 Mouse/Touch 事件
3. `onPointerStart` 中创建全局样式覆盖光标
4. `onPointerMove` / `onPointerUp` 通过 DisposableStore 管理
5. 状态管理：`SashState.Enabled | Disabled | AtMinimum | AtMaximum`

**状态映射：**
```typescript
enum CrishSashState {
  Enabled,      // 完全可拖拽
  Disabled,     // 禁用拖拽
  AtMinimum,    // 邻居已到最小宽度，只能单向
  AtMaximum     // 邻居已到最大宽度，只能单向
}
```

### 2.2 VS Code 的全局遮罩 → Crish 的事件丢失修复

**借鉴点：不依赖全局遮罩层的轻量方案**

**方案 A — 全局 CSS 光标覆盖（主推）：**
```typescript
// 拖拽开始
const styleEl = document.createElement('style');
styleEl.id = 'crish-drag-cursor';
styleEl.textContent = `* { cursor: ${cursor} !important; }`;
document.head.appendChild(styleEl);

// 拖拽结束
styleEl.remove();
```

**方案 B — iframe 指针事件禁用：**
```typescript
// 拖拽开始
const iframes = document.getElementsByTagName('iframe');
for (const iframe of iframes) {
  iframe.style.pointerEvents = 'none';
}

// 拖拽结束
for (const iframe of iframes) {
  iframe.style.pointerEvents = '';
}
```

**方案 C — CrishDragOverlay（可选兜底）：**
对于复杂场景（拖拽面板跨容器移动），使用单个透明 overlay：

```typescript
class CrishDragOverlay {
  private el: HTMLElement;

  show(cursor: string) {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 99999;
      cursor: ${cursor};
    `;
    document.body.appendChild(this.el);
  }

  hide() { this.el?.remove(); }
}
```

**策略选择矩阵：**
| 场景 | 推荐策略 |
|------|---------|
| 简单列宽拖拽 | 方案 A（CSS 光标覆盖） |
| 含 iframe 的页面 | 方案 A + B |
| 面板拖拽跨容器移动 | 方案 C（overlay） |

### 2.3 VS Code 的 SplitView → Crish 的列宽约束系统

**借鉴点：IView 约束接口 + resize 算法**

```typescript
interface ICrishPanelConstraint {
  minimumSize: number;       // 最小宽度（像素）
  maximumSize: number;       // 最大宽度（像素）
  priority?: CrishPriority;  // Normal | Low | High
  proportionalLayout?: boolean;
  snap?: boolean;            // 是否支持 snap
}

type CrishPriority = 'normal' | 'low' | 'high';
```

**CrishSplitView 核心算法：**

```
resize(index, delta):
  1. 计算上侧面板（index 左侧）的总约束
  2. 计算下侧面板（index 右侧）的总约束
  3. 按优先级排序（High 优先调整，Low 最后调整）
  4. 计算 delta 的 min/max 边界
  5. 处理 snap（隐藏/显示面板）
  6. 分配 delta 给两侧面板
  7. 触发布局更新
```

**Sizing 策略（面板添加/移除时）：**

```typescript
type CrishSizing =
  | { type: 'distribute' }                          // 均匀分配
  | { type: 'split'; index: number }                // 与指定面板平分
  | { type: 'auto'; index: number }                 // 自动选择分配策略
  | { type: 'fixed'; size: number }                 // 固定大小
  | { type: 'invisible'; cachedVisibleSize: number }; // 隐藏状态
```

### 2.4 Obsidian 的面板 → Crish 的 Workspace 布局

**借鉴点：Leaf + Split 的简化模型**

```typescript
class CrishPanel {
  id: string;
  title: string;
  icon?: string;
  view: CrishView;
  containerEl: HTMLElement;
  tabs: CrishTab[];
  activeTab: CrishTab | null;
  pinned: boolean;
  size: number;
  visible: boolean;

  // 生命周期
  mount(container: HTMLElement): void;
  unmount(): void;
  activate(): void;
  deactivate(): void;
}

enum CrishPanelRole {
  SIDEBAR_LEFT,     // 左侧栏
  MAIN_EDITOR,      // 主编辑区
  SIDEBAR_RIGHT,    // 右侧面板
  BOTTOM_PANEL,     // 底部面板
  FLOATING          // 浮动面板
}
```

**面板生命周期：**
```
create → attach → mount → activate → (deactivate) → unmount → detach → destroy
        ↑         ↓
    (hidden)  (visible)
```

### 2.5 Linear 的拖拽样式 → Crish 的指示器设计

**借鉴点：拖拽 ghost + drop zone 样式**

```typescript
// 拖拽 ghost 样式
const dragGhostStyles = {
  '.crish-drag-ghost': {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: 100000,
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    transform: 'rotate(3deg) scale(1.02)',
    opacity: 0.9,
    transition: 'none',
  },
  '.crish-drag-source': {
    opacity: 0.4,
    transition: 'opacity 150ms ease',
  },
  '.crish-drop-target': {
    outline: '2px solid var(--color-accent)',
    outlineOffset: -2,
    backgroundColor: 'var(--color-accent-bg)',
  },
  '.crish-drop-indicator': {
    position: 'absolute',
    width: 3,
    backgroundColor: 'var(--color-accent)',
    borderRadius: 2,
    zIndex: 100,
    transition: 'all 100ms ease',
  },
};
```

**指示器类型：**
```
1. 插入指示器（Insertion Indicator）
   - 垂直方向：3px 宽的线条，显示在插入位置
   - 水平方向：3px 高的线条
   - 颜色：主题强调色

2. 目标高亮（Drop Zone Highlight）
   - 虚线/实线边框
   - 背景色变化
   - 适用于面板/区域级别的拖拽

3. 预览占位（Placeholder）
   - 拖拽来源位置保留占位空间
   - 半透明显示

4. Ghost（跟随鼠标）
   - 旋转 3 度
   - 阴影
   - 跟随鼠标位置
```

---

## 3. 各模块的具体方案

### 3.1 CrishSash 模块

**文件位置：** `src/core/sash/`

```
src/core/sash/
├── index.ts              // 导出
├── sash.ts               // CrishSash 类
├── sash.css              // Sash 样式
├── sashState.ts          // SashState 枚举 + 状态管理
├── eventFactory.ts       // IPointerEventFactory 实现
├── types.ts              // 接口和类型定义
└── __tests__/
    └── sash.test.ts
```

**CrishSash 类设计：**

```typescript
export class CrishSash extends Disposable {
  private el: HTMLElement;
  private layoutProvider: ISashLayoutProvider;
  private state: SashState;
  private size: number;
  private hoverDelay: number;

  // Events
  readonly onDidStart: Event<ICrishSashEvent>;
  readonly onDidChange: Event<ICrishSashEvent>;
  readonly onDidEnd: Event<void>;
  readonly onDidReset: Event<void>;

  constructor(
    container: HTMLElement,
    layoutProvider: ISashLayoutProvider,
    options: ICrishSashOptions
  );

  // Public API
  layout(): void;
  setState(state: SashState): void;
  getState(): SashState;
  clearHoverState(): void;

  // Linked sash (用于 2x2 联动)
  linkedSash: CrishSash | undefined;
}
```

**事件处理链实现：**

```typescript
private onPointerStart(event: PointerEvent, factory: IPointerEventFactory) {
  // 1. 阻止默认行为
  EventHelper.stop(event);

  // 2. 处理正交联动
  // 3. 处理 linkedSash
  // 4. 禁用 iframe
  // 5. 记录初始位置
  // 6. 应用全局光标覆盖
  // 7. 注册 onPointerMove / onPointerUp
  // 8. 触发 onDidStart
}

private onPointerMove(event: PointerEvent) {
  // 1. 计算 currentX/currentY
  // 2. 触发 onDidChange
}

private onPointerUp(event: PointerEvent) {
  // 1. 移除全局光标样式
  // 2. 恢复 iframe
  // 3. 清理 DisposableStore
  // 4. 触发 onDidEnd
}
```

### 3.2 CrishSplitView 模块

**文件位置：** `src/core/splitview/`

```
src/core/splitview/
├── index.ts
├── splitView.ts         // CrishSplitView 类
├── viewItem.ts          // ViewItem 封装（VerticalViewItem / HorizontalViewItem）
├── splitView.css
├── types.ts
└── __tests__/
```

**核心类：**

```typescript
export class CrishSplitView<T extends ICrishView> extends Disposable {
  readonly el: HTMLElement;
  readonly orientation: Orientation;

  // 只读属性
  get contentSize(): number;
  get length(): number;
  get minimumSize(): number;
  get maximumSize(): number;
  get sashes(): readonly CrishSash[];

  // 事件
  readonly onDidSashChange: Event<number>;
  readonly onDidSashReset: Event<number>;
  readonly onDidScroll: Event<ScrollEvent>;

  // 视图管理
  addView(view: T, size: number | CrishSizing, index?: number): void;
  removeView(index: number, sizing?: CrishSizing): T;
  removeAllViews(): T[];
  moveView(from: number, to: number): void;
  swapViews(from: number, to: number): void;

  // 可见性
  isViewVisible(index: number): boolean;
  setViewVisible(index: number, visible: boolean): void;
  getViewCachedVisibleSize(index: number): number | undefined;

  // 尺寸
  resizeView(index: number, size: number): void;
  getViewSize(index: number): number;
  distributeViewSizes(): void;
  isViewExpanded(index: number): boolean;

  // 布局
  layout(size: number, layoutContext?: TLayoutContext): void;
}
```

**CrishView 接口（视图约束）：**

```typescript
export interface ICrishView {
  readonly element: HTMLElement;
  readonly minimumSize: number;
  readonly maximumSize: number;
  readonly priority?: CrishPriority;
  readonly proportionalLayout?: boolean;
  readonly snap?: boolean;
  readonly onDidChange: Event<number | undefined>;

  layout(size: number, offset: number): void;
  setVisible?(visible: boolean): void;
}
```

**Resize 算法实现（核心逻辑）：**

```typescript
private resize(
  index: number,
  delta: number,
  sizes: number[] = this.getSizes(),
  lowPriorityIndexes?: number[],
  highPriorityIndexes?: number[],
  snapBefore?: ISnapState,
  snapAfter?: ISnapState
): number {
  // 1. 获取上下两侧的索引
  const upIndexes = range(index, -1);
  const downIndexes = range(index + 1, this.length);

  // 2. 按优先级排序
  if (highPriorityIndexes) {
    for (const idx of highPriorityIndexes) {
      pushToStart(upIndexes, idx);
      pushToStart(downIndexes, idx);
    }
  }
  if (lowPriorityIndexes) {
    for (const idx of lowPriorityIndexes) {
      pushToEnd(upIndexes, idx);
      pushToEnd(downIndexes, idx);
    }
  }

  // 3. 计算约束范围
  const minDeltaUp = upIndexes.reduce((r, i) => r + (this.viewItems[i].minimumSize - sizes[i]), 0);
  const maxDeltaUp = upIndexes.reduce((r, i) => r + (this.viewItems[i].maximumSize - sizes[i]), 0);
  const maxDeltaDown = downIndexes.length === 0 ? Infinity : downIndexes.reduce((r, i) => r + (sizes[i] - this.viewItems[i].minimumSize), 0);
  const minDeltaDown = downIndexes.length === 0 ? -Infinity : downIndexes.reduce((r, i) => r + (sizes[i] - this.viewItems[i].maximumSize), 0);
  const minDelta = Math.max(minDeltaUp, minDeltaDown);
  const maxDelta = Math.min(maxDeltaDown, maxDeltaUp);

  // 4. 处理 snap
  // 5. 分配 delta
  // 6. 返回实际 delta
}
```

### 3.3 CrishGrid 模块

**文件位置：** `src/core/grid/`

```
src/core/grid/
├── index.ts
├── grid.ts              // CrishGrid 类（高级 API）
├── gridView.ts          // CrishGridView 类（低级索引 API）
├── branchNode.ts        // BranchNode（分支配节点）
├── leafNode.ts          // LeafNode（叶节点）
├── node.ts              // Node 基础类
├── types.ts             // GridLocation, Direction 等
├── grid.css
└── __tests__/
```

**CrishGrid 高级 API：**

```typescript
export class CrishGrid<T extends ICrishView> extends Disposable {
  readonly element: HTMLElement;
  readonly orientation: Orientation;
  readonly width: number;
  readonly height: number;
  readonly minimumWidth: number;
  readonly minimumHeight: number;
  readonly maximumWidth: number;
  readonly maximumHeight: number;

  // 事件
  readonly onDidChange: Event<{ width: number; height: number } | undefined>;
  readonly onDidScroll: Event<void>;

  // 视图管理
  addView(
    newView: T,
    size: number | CrishGridSizing,
    referenceView: T,
    direction: Direction
  ): void;

  removeView(view: T, sizing?: CrishGridSizing): void;
  moveView(view: T, sizing: number | CrishGridSizing, referenceView: T, direction: Direction): void;
  swapViews(from: T, to: T): void;

  // 布局控制
  layout(width: number, height: number, top?: number, left?: number): void;
  resizeView(view: T, size: Partial<{ width: number; height: number }>): void;
  expandView(view: T): void;
  distributeViewSizes(): void;

  // 可见性
  isViewVisible(view: T): boolean;
  setViewVisible(view: T, visible: boolean): void;

  // 查询
  getViewSize(view?: T): { width: number; height: number };
  getNeighborViews(view: T, direction: Direction, wrap?: boolean): T[];
  getViews(): GridNode<T>;
}
```

**GridLocation 寻址：**

```typescript
// GridLocation = number[]
// 示例：
//   A = [0, 0]  — 根 SplitView 的第一个子视图
//   B = [0, 1]  — 根 SplitView 的第二个子视图
//   C = [1, 0, 0] — 深度嵌套

function getRelativeLocation(
  rootOrientation: Orientation,
  location: GridLocation,
  direction: Direction
): GridLocation {
  const orientation = getLocationOrientation(rootOrientation, location);
  const directionOrientation = getDirectionOrientation(direction);

  if (orientation === directionOrientation) {
    // 同一方向：在父节点内调整索引
    let [rest, index] = tail(location);
    if (direction === Direction.Right || direction === Direction.Down) {
      index += 1;
    }
    return [...rest, index];
  } else {
    // 正交方向：创建新的子层级
    const index = (direction === Direction.Right || direction === Direction.Down) ? 1 : 0;
    return [...location, index];
  }
}
```

### 3.4 CrishLayoutSerializer 模块

**文件位置：** `src/core/layout/serializer.ts`

```typescript
// 序列化接口
export interface ICrishSerializedLeafNode {
  type: 'leaf';
  data: unknown;           // view.toJSON()
  size: number;
  visible?: boolean;
}

export interface ICrishSerializedBranchNode {
  type: 'branch';
  data: ICrishSerializedNode[];
  size: number;
  visible?: boolean;
}

export type ICrishSerializedNode = ICrishSerializedLeafNode | ICrishSerializedBranchNode;

export interface ICrishSerializedLayout {
  root: ICrishSerializedNode;
  orientation: Orientation;
  width: number;
  height: number;
}

// 序列化器
export class CrishLayoutSerializer {
  static serialize<T extends ICrishSerializableView>(
    grid: CrishGrid<T>
  ): ICrishSerializedLayout {
    return {
      root: this.serializeNode(grid.getViews(), grid.orientation),
      orientation: grid.orientation,
      width: grid.width,
      height: grid.height,
    };
  }

  static deserialize<T extends ICrishSerializableView>(
    json: ICrishSerializedLayout,
    deserializer: ICrishViewDeserializer<T>
  ): CrishGrid<T> {
    // 重建网格结构
  }

  private static serializeNode(
    node: GridNode,
    orientation: Orientation
  ): ICrishSerializedNode {
    // 递归序列化
  }
}
```

### 3.5 CrishWorkspace 模块（多工作区）

**借鉴 Arc Spaces 的概念：**

```typescript
export class CrishWorkspace {
  id: string;
  name: string;
  icon?: string;
  theme?: CrishTheme;

  // 布局状态
  layout: CrishLayout;
  activePanels: string[];
  panelOrder: string[];

  // 序列化
  save(): ICrishSerializedLayout;
  restore(layout: ICrishSerializedLayout): void;
}

export class CrishWorkspaceManager {
  private workspaces: Map<string, CrishWorkspace>;
  private activeWorkspaceId: string;

  // 工作区管理
  createWorkspace(name: string, template?: CrishWorkspace): CrishWorkspace;
  deleteWorkspace(id: string): void;
  switchWorkspace(id: string): void;
  renameWorkspace(id: string, name: string): void;

  // 持久化
  saveWorkspaces(): void;
  loadWorkspaces(): void;
}
```

### 3.6 CrishDragSystem 模块（拖拽系统）

**文件位置：** `src/core/drag/`

```
src/core/drag/
├── index.ts
├── dragSystem.ts       // 全局拖拽管理器
├── dragSource.ts       // 拖拽源
├── dragTarget.ts       // 放置目标
├── dragOverlay.ts      // 拖拽遮罩层
├── dragGhost.ts        // 拖拽跟随元素
├── dragIndicator.ts    // 插入指示器
├── types.ts
├── drag.css
└── __tests__/
```

**CrishDragSystem — 全局拖拽管理器：**

```typescript
export class CrishDragSystem {
  private static instance: CrishDragSystem;
  private dragOverlay: CrishDragOverlay;
  private dragGhost: CrishDragGhost;
  private dragIndicator: CrishDragIndicator;
  private sources: Set<CrishDragSource>;
  private targets: Set<CrishDragTarget>;
  private activeDrag: CrishDragSession | null;

  // 单例
  static getInstance(): CrishDragSystem;

  // 注册/注销
  registerSource(source: CrishDragSource): void;
  unregisterSource(source: CrishDragSource): void;
  registerTarget(target: CrishDragTarget): void;
  unregisterTarget(target: CrishDragTarget): void;

  // 拖拽会话
  startDrag(session: CrishDragSession): void;
  endDrag(): void;
  cancelDrag(): void;

  // 命中检测
  findDropTarget(x: number, y: number): CrishDropTarget | null;
}
```

**CrishDragSession — 单次拖拽会话：**

```typescript
export class CrishDragSession {
  source: CrishDragSource;
  ghost: CrishDragGhost;
  data: any;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;

  constructor(source: CrishDragSource, data: any, event: PointerEvent) {
    this.source = source;
    this.data = data;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.currentX = event.clientX;
    this.currentY = event.clientY;

    // 创建 ghost
    this.ghost = new CrishDragGhost(source.getElement());
    this.ghost.show(event.clientX, event.clientY);

    // 设置 iframe 保护
    CrishDragSystem.getInstance().protectIframes(true);

    // 设置全局光标
    CrishDragSystem.getInstance().setGlobalCursor('grabbing');
  }

  update(event: PointerEvent) {
    this.currentX = event.clientX;
    this.currentY = event.clientY;
    this.ghost.move(event.clientX, event.clientY);

    // 命中检测
    const target = CrishDragSystem.getInstance().findDropTarget(
      event.clientX, event.clientY
    );

    // 更新指示器
    CrishDragSystem.getInstance().updateIndicator(target, event);
  }

  end() {
    this.ghost.hide();
    CrishDragSystem.getInstance().protectIframes(false);
    CrishDragSystem.getInstance().resetGlobalCursor();
    CrishDragSystem.getInstance().hideIndicator();
  }
}
```

### 3.7 CrishLayoutStore（布局状态管理）

**借鉴 VS Code 的 LayoutStateModel：**

```typescript
export class CrishLayoutStore {
  // 运行时状态（不持久化）
  private runtime: Map<string, any>;

  // 持久化状态（保存到 localStorage）
  private persistent: Map<string, any>;

  // 配置驱动状态（来自配置文件）
  private config: Map<string, any>;

  constructor() {
    this.persistent = this.loadPersistent();
    this.runtime = new Map();
    this.config = this.loadConfig();
  }

  // 运行时状态
  setRuntime(key: string, value: any): void;
  getRuntime<T>(key: string): T | undefined;

  // 持久化状态
  setPersistent(key: string, value: any): void;
  getPersistent<T>(key: string): T | undefined;
  savePersistent(): void;
  loadPersistent(): Map<string, any>;

  // 配置
  setConfig(key: string, value: any): void;
  getConfig<T>(key: string): T | undefined;
  loadConfig(): Map<string, any>;

  // 事件
  readonly onDidChange: Event<LayoutStateChange>;
}
```

---

## 4. 各模块依赖关系

```
CrishSash
  └── 依赖: 无（独立模块）
  └── 被依赖: CrishSplitView

CrishSplitView
  └── 依赖: CrishSash
  └── 被依赖: CrishGrid

CrishGrid
  └── 依赖: CrishSplitView, CrishSash
  └── 被依赖: CrishWorkspace

CrishLayoutSerializer
  └── 依赖: CrishGrid
  └── 被依赖: CrishWorkspace

CrishWorkspace
  └── 依赖: CrishGrid, CrishLayoutSerializer, CrishLayoutStore
  └── 被依赖: 无（顶层模块）

CrishDragSystem
  └── 依赖: 无（独立模块）
  └── 被依赖: CrishSash, CrishWorkspace

CrishLayoutStore
  └── 依赖: 无（独立模块）
  └── 被依赖: CrishWorkspace
```

---

## 5. 优先级建议

### Phase 1 — 核心基础（优先级：P0）

**目标：解决当前最紧迫的拖拽和布局问题**

| 模块 | 任务 | 预估工时 | 依赖 |
|------|------|---------|------|
| CrishSash | 实现基本 Sash 拖拽（Mouse + Touch） | 2-3d | 无 |
| CrishSash | 全局 CSS 光标覆盖 | 0.5d | CrishSash |
| CrishSash | iframe 指针事件保护 | 0.5d | CrishSash |
| CrishSplitView | 实现基本 SplitView（约束系统） | 3-4d | CrishSash |
| CrishSplitView | resize 算法（含 priority） | 2d | CrishSplitView |
| CrishSplitView | Sizing 策略（Distribute/Split/Auto） | 1d | CrishSplitView |
| 集成 | 替换现有列宽拖拽逻辑 | 2d | CrishSash + CrishSplitView |

**Phase 1 交付标准：**
- 列宽拖拽不再丢失事件
- 列宽有 min/max 约束
- 窗口缩放按比例调整列宽
- 添加/移除列时自动分配空间

### Phase 2 — 网格布局（优先级：P1）

**目标：支持嵌套面板布局**

| 模块 | 任务 | 预估工时 | 依赖 |
|------|------|---------|------|
| CrishGrid | BranchNode + LeafNode 实现 | 3-4d | CrishSplitView |
| CrishGrid | GridLocation 寻址系统 | 1d | CrishGrid |
| CrishGrid | addView/removeView 高级 API | 2d | CrishGrid |
| CrishLayoutSerializer | serialize/deserialize | 2d | CrishGrid |
| CrishLayoutStore | 运行时 + 持久化状态 | 1d | 无 |

**Phase 2 交付标准：**
- 面板可以嵌套（Split 内嵌 Split）
- 布局可以序列化/恢复
- 状态可持久化

### Phase 3 — 面板拖拽（优先级：P1）

**目标：面板级别的自由拖拽重排**

| 模块 | 任务 | 预估工时 | 依赖 |
|------|------|---------|------|
| CrishDragSystem | DragSource / DragTarget 注册 | 1d | 无 |
| CrishDragSystem | 命中检测算法 | 1.5d | CrishDragSystem |
| CrishDragGhost | 拖拽跟随元素 | 0.5d | CrishDragSystem |
| CrishDragIndicator | 插入指示器 | 0.5d | CrishDragSystem |
| CrishDragOverlay | 可选全局 overlay | 0.5d | CrishDragSystem |
| 集成 | 面板拖拽跨容器移动 | 2-3d | CrishDragSystem + CrishGrid |

**Phase 3 交付标准：**
- 面板可以通过拖拽移动到新位置
- 拖拽时有视觉反馈（ghost + 指示器）
- 面板可以在不同 Split 间移动

### Phase 4 — 多工作区（优先级：P2）

**目标：支持多工作区和复杂的交互模式**

| 模块 | 任务 | 预估工时 | 依赖 |
|------|------|---------|------|
| CrishWorkspace | 工作区 CRUD | 1-2d | CrishGrid |
| CrishWorkspace | 工作区切换动画 | 1d | CrishWorkspace |
| CrishWorkspace | 工作区配置持久化 | 0.5d | CrishWorkspace |
| CrishDragSystem | 标签页拖拽（类似 Obsidian） | 2d | CrishDragSystem |
| CrishSash | linkedSash（2x2 联动） | 1d | CrishSash |
| CrishSplitView | snap 支持 | 1d | CrishSplitView |

**Phase 4 交付标准：**
- 支持多工作区切换
- 标签页可以拖拽重排
- 2x2 网格支持联动 resize
- 面板支持 snap 行为

### Phase 5 — 优化与完善（优先级：P2）

**目标：性能优化和交互完善**

| 模块 | 任务 | 预估工时 | 依赖 |
|------|------|---------|------|
| CrishSplitView | proportionalLayout 优化 | 1d | CrishSplitView |
| CrishGrid | 惰性布局（LayoutController） | 0.5d | CrishGrid |
| CrishGrid | 2x2 trySet2x2 优化 | 1d | CrishGrid |
| CrishDragSystem | requestAnimationFrame 节流 | 0.5d | CrishDragSystem |
| 全局 | 拖拽事件性能分析 | 1d | 所有 |
| 测试 | 单元测试 + 集成测试 | 3-4d | 所有 |

**Phase 5 交付标准：**
- 布局计算性能达标
- 拖拽 60fps 流畅
- 测试覆盖率 > 80%

---

## 6. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 现有代码耦合度高，难以替换 | Phase 1 延迟 | 高 | 逐步替换，第一阶段只改拖拽层 |
| 嵌套布局性能问题 | Phase 2 | 中 | 惰性布局 + 变更防抖 |
| 拖拽系统与其他库冲突 | Phase 3 | 中 | 使用事件命名空间 + 单例模式 |
| 跨浏览器兼容性问题 | 全局 | 低 | PointerEvent polyfill + 测试覆盖 |
| 序列化版本兼容 | Phase 2 | 低 | 版本号 + migration 机制 |

---

## 7. 验证标准

### 7.1 功能验证

```
每个模块完成后验证：
├── CrishSash
│   ├── 鼠标拖拽正常
│   ├── 触摸拖拽正常
│   ├── 光标正确变化
│   ├── iframe 不干扰
│   └── 双击触发 reset
├── CrishSplitView
│   ├── 添加/移除视图
│   ├── 约束正确
│   ├── 比例分配正确
│   └── 滚动正常
├── CrishGrid
│   ├── 嵌套布局正确
│   ├── 方向转换正确
│   └── 视图移动/交换正确
├── CrishLayoutSerializer
│   ├── serialize = deserialize 完整
│   └── 旧版本兼容
└── CrishDragSystem
    ├── 拖拽开始/结束正常
    ├── 指示器位置正确
    └── 放置事件正确触发
```

### 7.2 性能验证

```
├── 500ms 内完成 100 次 resize 计算
├── 拖拽帧率 > 55fps
├── 序列化 < 50ms（100 个节点）
├── 反序列化 < 100ms（100 个节点）
└── 内存泄漏测试（拖拽 1000 次后无泄漏）
```

---

*文档版本: v1.0*
*方案日期: 2026-07-22*
