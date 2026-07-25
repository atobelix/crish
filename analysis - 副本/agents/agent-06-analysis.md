# Agent-06: Multi-Panel Layout &amp; Drag System Reference Analysis

> 研究目标：分析 VS Code、Obsidian、Linear、Arc Browser 四款软件的面板布局和拖拽系统，为 Crish 项目提供设计参考

---

## 1. VS Code Sash System 深度分析

### 1.1 Sash 类架构

VS Code 的拖拽分割条系统核心位于 `src/vs/base/browser/ui/sash/sash.ts`。Sash 是用户调整组件大小的 UI 组件，通常表现为不可见的水平或垂直线，hover 时高亮并可拖拽。

**核心类结构：**

```
Sash extends Disposable
├── el: HTMLElement              // DOM 节点
├── layoutProvider               // 位置/尺寸提供者
├── orientation                  // VERTICAL | HORIZONTAL
├── size                         // 宽度（垂直）或高度（水平）
├── state                        // Disabled | AtMinimum | AtMaximum | Enabled
├── linkedSash                   // 2x2 网格中联动 sash
├── orthogonalStartSash          // 起始端正交 sash
├── orthogonalEndSash            // 结束端正交 sash
├── hoverDelay                   // hover 延迟（默认 300ms）
├── onDidStart                   // 拖拽开始事件
├── onDidChange                  // 拖拽中事件
├── onDidReset                   // 双击重置事件
├── onDidEnd                     // 拖拽结束事件
└── onDidEnablementChange        // 状态变化事件
```

**SashState 枚举：**
```typescript
enum SashState {
  Disabled,   // 禁用交互
  AtMinimum,  // 只能向右/下拖拽
  AtMaximum,  // 只能向左/上拖拽
  Enabled     // 完全可拖拽
}
```

**全局配置：**
- `globalSize = 4` — 默认 sash 尺寸（CSS 变量 `--vscode-sash-size: 4px`）
- `globalHoverDelay = 300` — hover 延迟
- `setGlobalSashSize()` / `setGlobalHoverDelay()` — 运行时修改

### 1.2 PointerEvent 处理链

VS Code 使用 `MouseEventFactory` 和 `GestureEventFactory` 来封装不同输入源的指针事件：

```
mousedown/dblclick → onPointerStart()
  ├── EventHelper.stop(event)       // 阻止默认行为
  ├── 正交 sash 联动处理             // 如果拖拽在正交手柄上
  ├── linkedSash 联动处理            // 如果存在 linkedSash
  ├── iframe 遮罩处理                // 禁用所有 iframe 的指针事件
  ├── 创建 startEvent (ISashEvent)
  ├── 添加 active CSS class
  ├── 创建全局样式表 (cursor: * !important)
  ├── 注册 onPointerMove → _onDidChange.fire()
  └── 注册 onPointerUp → 清理、_onDidEnd.fire()
```

**关键设计决策：**

1. **全局光标覆盖**：拖拽期间创建一个 `style` 标签插入 DOM，设置 `* { cursor: xxx !important; }`，解决 iframe/子元素光标不一致问题
2. **iframe 禁用**：遍历 `el.ownerDocument.getElementsByTagName('iframe')`，添加 `pointer-events-disabled` CSS class
3. **工厂模式**：`IPointerEventFactory` 接口抽象了鼠标事件和触摸事件，便于扩展
4. **正交联动**：`OrthogonalPointerEventFactory` 代理同一个拖拽事件到正交 sash，实现 2x2 角部同步拖拽

### 1.3 全局遮罩层 Overlay 策略

VS Code **不**使用全局透明遮罩层（overlay），而是采用两种策略：

**策略 A — CSS 全局光标覆盖：**
```typescript
const style = createStyleSheet(this.el);
style.textContent = `* { cursor: ${cursor} !important; }`;
```
拖拽开始创建，拖拽结束移除。这比遮罩层更轻量，但只解决光标问题。

**策略 B — iframe 指针事件禁用：**
```typescript
const iframes = this.el.ownerDocument.getElementsByTagName('iframe');
for (const iframe of iframes) {
  iframe.classList.add('pointer-events-disabled');
}
// ... 拖拽结束移除
```
防止 iframe 中的鼠标事件干扰拖拽。

> 结论：VS Code 依靠 `pointer-events: none` 局部禁用 + 全局 CSS 光标覆盖，而非全页面遮罩层。

### 1.4 SplitView 布局管理器

SplitView 是 VS Code 一维弹性布局的核心，位于 `splitview.ts`：

```
SplitView extends Disposable
├── el: HTMLElement               // 容器 DOM
├── orientation                   // VERTICAL | HORIZONTAL
├── viewItems: ViewItem[]        // 视图项
├── sashItems: ISashItem[]       // Sash 项（始终 = viewItems.length - 1）
├── scrollable                    // 滚动支持
├── proportions: number[]         // 比例缓存（用于 proportionalLayout）
├── _contentSize                  // 所有视图内容总大小
├── minimumSize / maximumSize    // 聚合约束
├── addView()                     // 添加视图
├── removeView()                  // 移除视图
├── moveView() / swapViews()      // 视图重排
├── setViewVisible()              // 显隐控制
├── resizeView()                  // 指定大小
├── distributeViewSizes()         // 平均分配
├── layout()                      // 整体布局
└── onDidSashChange / onDidSashReset
```

**IView 接口（视图契约）：**
```typescript
interface IView {
  element: HTMLElement;
  minimumSize: number;
  maximumSize: number;
  priority?: LayoutPriority;    // Low | Normal | High
  proportionalLayout?: boolean;
  snap?: boolean;                // 到达最小尺寸时吸边
  onDidChange: Event<number | undefined>;
  layout(size, offset, context): void;
  setVisible?(visible): void;
}
```

**核心算法 — resize()：**
1. 计算出上侧（upIndexes）和下侧（downIndexes）的所有视图
2. 按优先级排序：High 优先被调整，Low 最后被调整
3. 计算 delta 的约束范围 minDelta/maxDelta
4. 处理 snap 状态（视图隐藏/显示切换）
5. 分配 delta 给上下两侧视图，满足每个视图的 min/max 约束

**Sizing 策略：**
```typescript
type Sizing = DistributeSizing | SplitSizing | AutoSizing | InvisibleSizing;
```
- `Distribute` — 在所有视图间均匀分布空间
- `Split(index)` — 与指定视图平分空间
- `Auto(index)` — 如果视图均匀分布则 Distribute，否则 Split
- `Invisible(cachedVisibleSize)` — 不可见状态，保留缓存尺寸

**Snap 机制：**
- 当拖拽达到某个视图的临界值时，自动隐藏/显示该视图
- `findFirstSnapIndex()` 在可见视图中寻找第一个 `snap=true` 的视图
- snap 状态改变后递归调用 resize，重新计算布局

**ProportionalLayout：**
- 保存每个视图占总尺寸的比例：`proportions = sizes.map(s => s / contentSize)`
- 当 SplitView 整体大小时按比例恢复视图尺寸
- 可通过 `proportionalLayout: false` 关闭

### 1.5 Grid / GridView 嵌套布局

GridView 是二维弹性布局，内部由多个 SplitView 组成正交树：

```
GridView
└── BranchNode (root, Orientation.VERTICAL)
    ├── SplitView (horizontal)
    │   ├── LeafNode (View A)
    │   └── LeafNode (View B)
    └── BranchNode (horizontal)
        ├── SplitView (vertical)
        │   ├── LeafNode (View C)
        │   └── LeafNode (View E)
        └── LeafNode (View D)
```

**GridLocation 地址系统：**
- 视图通过 `number[]` 定位，如 `A = [0,0]`, `B = [0,1]`, `C = [1,0,0]`
- `tail(location)` 取得 `[parentRest, index]` 在父节点中的位置

**BranchNode（分支节点）：**
- 内部包含一个 SplitView
- `orthogonalSize` = 正交方向尺寸（SplitView 固定）
- `size` = 当前方向尺寸（SplitView 可变）
- 递归传播 boundarySashes 给子节点

**LeafNode（叶节点）：**
- 包裹真正的 IView
- `linkedWidthNode` / `linkedHeightNode` — 2x2 网格联动
- 使用 `createLatchedOnDidChangeViewEvent()` 避免重复布局

**2x2 优化：**
- `trySet2x2()` 检测两个 BranchNode 各有两个 LeafNode
- 通过 `linkedSash` 连接对应的 sash，实现两个视图联动调整
- 通过 `linkedWidthNode` / `linkedHeightNode` 联动约束

**Grid 高级 API（grid.ts）：**
```typescript
addView(newView, size, referenceView, direction)
removeView(view, sizing?)
moveView(view, sizing, referenceView, direction)
swapViews(from, to)
resizeView(view, size)
maximizeView(view, excludeViews?)
expandView(view)
distributeViewSizes()
getNeighborViews(view, direction, wrap?)
```

**Direction 枚举：**
```typescript
enum Direction { Up, Down, Left, Right }
```
`getRelativeLocation()` 计算相对于参考视图的新位置。

### 1.6 布局持久化（SerializableGrid）

**序列化接口：**
```typescript
interface ISerializedLeafNode {
  type: 'leaf';
  data: unknown;          // view.toJSON()
  size: number;
  visible?: boolean;
  maximized?: boolean;
}

interface ISerializedBranchNode {
  type: 'branch';
  data: ISerializedNode[];
  size: number;
  visible?: boolean;
}

interface ISerializedGrid {
  root: ISerializedNode;
  orientation: Orientation;
  width: number;
  height: number;
}
```

**关键方法：**
- `serialize()` → 递归遍历所有节点，生成 `ISerializedGrid`
- `deserialize(json, deserializer)` → 从 JSON 重建网格
- `from(gridDescriptor)` → 从描述符创建
- `sanitizeGridNodeDescriptor()` → 清理描述符，补充默认尺寸

**Workbench 布局恢复（layout.ts）：**
- `restoreParts()` 按顺序恢复：编辑者 → 侧边栏 → 面板 → 辅助栏
- `LayoutStateModel` 管理所有布局状态的持久化
- `onDidChangeConfiguration` 监听布局配置变化

### 1.7 VS Code Workbench Layout（layout.ts）

核心布局结构（主窗口）：
```
Layout (implements IWorkbenchLayoutService)
├── mainContainer
├── workbenchGrid: SerializableGrid<ISerializableView>
├── Parts:
│   ├── TITLEBAR_PART
│   ├── BANNER_PART
│   ├── ACTIVITYBAR_PART
│   ├── SIDEBAR_PART
│   ├── EDITOR_PART (main editor area)
│   ├── PANEL_PART (bottom panel)
│   ├── AUXILIARYBAR_PART (right sidebar)
│   └── STATUSBAR_PART
└── LayoutStateModel
    ├── Runtime states (zen mode, fullscreen, etc.)
    ├── Persistent states (sidebar/panel/auxbar visibility)
    └── Configuration-driven states
```

**布局类标记（CSS）：**
```typescript
enum LayoutClasses {
  SIDEBAR_HIDDEN = 'nosidebar',
  PANEL_HIDDEN = 'nopanel',
  AUXILIARYBAR_HIDDEN = 'noauxiliarybar',
  FULLSCREEN = 'fullscreen',
  MAXIMIZED = 'maximized',
  // ...
}
```

**布局注册和恢复流程：**
1. `initLayout(accessor)` — 初始化服务、创建 Grid
2. `registerLayoutListeners()` — 注册事件监听
3. `initLayoutState()` — 加载持久化状态
4. `restoreParts()` — 恢复所有部件（编辑者、侧边栏、面板、辅助栏）
5. `whenReady` / `whenRestored` — 就绪信号

### 1.8 VS Code 的优缺点总结

**优点：**
1. **松耦合架构**：Sash / SplitView / GridView / Grid 四层分离，职责清晰
2. **完备的约束系统**：minSize / maxSize / priority / snap 完整覆盖
3. **正交联动**：2x2 角部拖拽完美解决
4. **proportionalLayout**：窗口缩放时按比例恢复，避免布局抖动
5. **持久化完整**：serialize/deserialize 覆盖整个网格树
6. **事件驱动**：onDidChange 让视图可以动态改变约束
7. **不依赖全局遮罩层**：采用更轻量的 CSS 覆盖策略

**缺点：**
1. **复杂度高**：GridView + BranchNode + SplitView + LeafNode 体系学习成本高
2. **DOM 结构深**：网格树多层嵌套，性能可能受影响
3. **Sash 仅 4px**：对触摸不够友好（虽然后来支持 touch events）
4. **没有内置拖拽排序**：Sash 只负责 resize，不负责视图重排
5. **LinkedSash 设计不够通用**：为 2x2 特殊优化，非通用方案

---

## 2. Obsidian 面板系统分析

### 2.1 面板拆分/合并机制

Obsidian 的面板系统基于 **Leaf（叶子）** 架构：

**核心概念：**
- **Workspace**：顶层容器，管理所有 Leaf
- **Leaf**：最小单元，每个 Leaf 维护一个 View（编辑器/预览/图等）
- **Split**：在方向（水平/垂直）上分割 Leaf
- **Tab**：多个 Leaf 堆叠在同一区域，通过标签切换

**面板拆分：**
- `Workspace.splitLeaf(leaf, direction, size?)` — 在指定方向拆分 Leaf
- `Workspace.getLeaf()` / `Workspace.createLeafInParent()` 
- 支持递归拆分：一个 Leaf 可以拆分为两个，每个又可以继续拆分

**面板合并：**
- `Workspace.mergeLeaf(leaf, targetLeaf)` — 将 Leaf 合并到目标 Leaf
- 移除空的父容器（自动 cleanup）

### 2.2 Leaf 和 Workspace 架构

```typescript
class Workspace {
  activeLeaf: Leaf | null;
  rootSplit: WorkspaceSplit;      // 根 Split

  getLeaf(newLeaf?: 'tab' | 'split' | 'window'): Leaf;
  createLeafInParent(parent: WorkspaceSplit, index: number): Leaf;
  splitLeaf(leaf: Leaf, direction: 'horizontal' | 'vertical', size?: number): Leaf;
  mergeLeaf(leaf: Leaf, targetLeaf: Leaf): void;
  setActiveLeaf(leaf: Leaf): void;
  detachLeaf(leaf: Leaf): void;
  getLeafById(id: string): Leaf | null;
  iterateLeaves(callback: (leaf: Leaf) => void): void;
}

class WorkspaceSplit {
  children: (WorkspaceSplit | WorkspaceLeaf)[];
  direction: 'horizontal' | 'vertical';
  parent: WorkspaceSplit | null;
  containerEl: HTMLElement;
}

class WorkspaceLeaf {
  id: string;
  view: View | null;
  containerEl: HTMLElement;
  parent: WorkspaceSplit | null;
  tabsContainerEl: HTMLElement;
  pinned: boolean;
  icon: string;
  title: string;
}
```

**View 类型：**
- `ItemView` — 基本视图（如文件列表、搜索）
- `FileView` — 文件编辑器视图
- `TextView` — 文本预览

### 2.3 标签拖拽交互

Obsidian 的标签拖拽系统：

**拖拽触发：**
- 拖拽标签页标签头（tab header）
- 拖拽结果视图图标
- 拖拽文件管理器的文件到面板

**拖拽状态指示：**
- 目标位置高亮（插入指示器）
- 方向指示（上/下/左/右/居中）
- 悬停预览（某些视图支持）

**放置逻辑：**
```
DragStart → Drag (移动) → DragEnd (放置)
  ├── 同一区域: 重新排序 tabs
  ├── 相邻区域: 移动到目标 split 的指定位置
  ├── 新区域: 拆分当前 Leaf 创建新面板
  ├── 侧边栏: 移动到侧边栏
  └── 外部: 创建新窗口
```

**Drop 事件处理：**
- `DragEvent.dataTransfer` 传递 drag data
- `onCanDrop()` 检查是否可以放置
- `onDrop()` 执行放置操作

### 2.4 工作区布局保存

**Workspace 布局持久化：**

```typescript
interface WorkspaceLayout {
  left: SplitLayout;
  right: SplitLayout;
  main: SplitLayout;
  leftRibbon: RibbonLayout;
  active: string;
  lastOpenFiles: string[];
}

interface SplitLayout {
  id: string;
  direction: 'horizontal' | 'vertical';
  children: SplitLayout[];
  type: string;
  state: any;
}
```

**保存/恢复：**
- `Workspace.saveLayout()` → JSON 序列化
- `Workspace.loadLayout(json)` → 重建布局
- 自动保存（基于 StorageService）
- 手动保存/加载 Workspace（插件功能）

### 2.5 侧边栏/标签页体系

**侧边栏体系：**
- 左侧边栏（Left Sidebar）：功能区（文件浏览器、搜索等）
- 右侧边栏（Right Sidebar）：辅助功能（大纲、标签等）
- 每个侧边栏可以包含多个标签页（tabs）
- 通过标签头切换
- 可以拖拽到主区域或另一个侧边栏

### 2.6 Obsidian 的优缺点总结

**优点：**
1. **简化模型**：Leaf + Split 模型直观易懂
2. **灵活性高**：支持拆分、合并、重排、新窗口
3. **拖拽完善**：标签拖拽覆盖所有场景
4. **布局持久化**：完整的工作区序列化
5. **视图类型丰富**：ItemView / FileView / TextView 分层

**缺点：**
1. **性能问题**：大量 Leaf 时 DOM 操作频繁
2. **不够稳定**：拖拽过程中偶尔出现视觉闪烁
3. **API 不公开**：部分布局 API 为内部使用
4. **缺少约束系统**：没有视图大小 min/max 约束
5. **缺少 Sash 联动**：复杂的网格布局难以实现

---

## 3. Linear UI 分析

### 3.1 设计系统

Linear 的设计系统以"极简"和"高效"著称：

**设计原则：**
- **数据密度适中**：信息密集但不过度
- **明快的交互反馈**：动画平滑、即时
- **键盘优先**：几乎所有操作支持快捷键
- **一致性**：组件库高度统一

**排版：**
- 左侧主导航（Projects / Issues / Teams）
- 中央内容区（列表/看板）
- 右侧详情面板（类似 VS Code 的侧边栏）
- 单窗口、多面板

### 3.2 拖拽交互

Linear 的拖拽系统主要用于：

**Issue 行列拖拽：**
- 看板视图下拖拽卡片切换状态（Todo → In Progress → Done）
- 列表视图下调整优先级、负责人等
- 拖拽时卡片跟随鼠标，源位置保留占位

**侧边栏调整：**
- 右侧详情面板可通过拖拽调整宽度
- 类似于 VS Code 的 Sash 但更简洁
- 使用 CSS `resize` 或自定义拖拽手柄

### 3.3 指示器样式

Linear 的拖拽指示器风格：

**拖拽状态：**
- **source**：半透明（opacity 0.5），保留占位
- **target**：蓝色或高亮边框
- **drag ghost**：跟随鼠标，轻微阴影
- **drop zone**：虚线边框或背景色变化

**CSS 实现推测：**
```css
.dragging {
  opacity: 0.5;
  cursor: grabbing;
}

.drop-target {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
  background: var(--color-primary-bg);
}

.drag-ghost {
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  transform: rotate(3deg);
  pointer-events: none;
}
```

### 3.4 Linear 的优缺点总结

**优点：**
1. **设计系统完整**：视觉一致性和交互一致性高
2. **交互轻量**：拖拽反馈即时不拖沓
3. **键盘+鼠标双模**：所有操作都有快捷键
4. **状态管理清晰**：乐观更新，拖拽不卡 UI

**缺点：**
1. **布局固定**：不支持自定义工作区布局
2. **无多面板**：不支持 VS Code 式的多面板拆分
3. **拖拽范围有限**：只看板内，不支持跨项目随意拖拽

---

## 4. Arc Browser 标签系统分析

### 4.1 空间设计（Spaces）

Arc 的空间系统是其核心创新：

**空间（Space）特性：**
- 每个空间有独立的标签集合、收藏夹、历史记录
- 空间之间通过侧边栏切换（类似工作区）
- 空间与 Profile（配置文件）绑定
- 每个空间可以有独立的主题色

**侧边栏布局：**
```
Arc Sidebar
├── Favorites (固定标签)
├── Today (今日标签)
├── Pinned (固定会话)
└── Spaces
    ├── Space 1 (Work)
    │   ├── Tab A
    │   ├── Tab B
    │   └── Tab C
    ├── Space 2 (Personal)
    │   ├── Tab D
    │   └── Tab E
    └── Space 3 (Study)
        └── Tab F
```

**Split View：**
- Arc 支持在同一窗口中并排显示多个标签
- 通过拖拽标签到侧边栏特定位置触发
- 支持 2 列、3 列、网格等布局
- 每个 split pane 独立加载页面

### 4.2 标签拖拽（Tab Swiping）

**标签拖拽系统：**
```
Drag Tab
├── 同一 Space 内: 重新排序
├── 不同 Space 间: 移动标签到目标空间
├── 到 Split View: 创建分栏
├── 到新窗口: 创建独立窗口（Arc 会变成画中画）
└── 到收藏区: 固定为收藏
```

**交互反馈：**
- 拖拽时标签跟随鼠标
- 目标位置显示插入指示器
- 空间名称高亮
- 拆分预览（显示将占用的区域）

### 4.3 Arc 的优缺点总结

**优点：**
1. **创新空间概念**：多空间+多 Profile 的完美结合
2. **侧边栏高效**：垂直标签布局充分利用宽屏
3. **Split View 简洁**：拖拽即拆分，无需复杂设置
4. **可视化反馈**：拖拽时有清晰的预览

**缺点：**
1. **空间隔离不够彻底**：空间间 Cookie/存储共享问题
2. **性能开销**：每个空间维护独立标签集
3. **学习曲线**：用户需要理解 Spaces/Profiles 的区别

---

## 5. 四款软件的对比

### 5.1 布局架构对比

| 特性 | VS Code | Obsidian | Linear | Arc Browser |
|------|---------|----------|--------|-------------|
| 布局模型 | Grid (树状 SplitView) | Leaf + Split 树 | 固定布局 | 侧边栏 + Split |
| 单位 | IView (约束驱动) | Leaf (内容驱动) | 固定 Panel | Tab + Space |
| 拆分维度 | 任意方向 | 水平/垂直 | 不可拆分 | 标签页拆分 |
| 约束系统 | min/max/priority/snap | 无 | 无 | 无 |
| 正交联动 | linkedSash | 不支持 | 不支持 | 不支持 |
| 显隐控制 | setViewVisible | close/open | 固定 | 固定 |
| 布局持久化 | SerializableGrid | WorkspaceLayout | 无 | 内置（Chromium） |
| 比例控制 | proportionalLayout | 无 | 无 | 无 |

### 5.2 拖拽系统对比

| 特性 | VS Code Sash | Obsidian Tabs | Linear Drag | Arc Tabs |
|------|-------------|---------------|-------------|----------|
| 触发方式 | mousedown | mousedown + dragstart | mousedown + pointer | mousedown |
| 事件类型 | Mouse + Touch | Drag & Drop | Pointer Events | Pointer Events |
| 全局光标 | CSS * | 无 | 无 | 无 |
| iframe 处理 | pointer-events: none | N/A | N/A | N/A |
| 正交联动 | OrthogonalPointerEventFactory | 无 | 无 | 无 |
| Snap 支持 | 有 (view.snap) | 无 | 无 | 无 |
| 连接线指示器 | 无 | 插入位置高亮 | 拖拽 ghost | 拆分预览 |
| 光标反馈 | 动态 cursor class | 默认 | pointer | default |

### 5.3 样式体系对比

| 方面 | VS Code | Obsidian | Linear | Arc |
|------|---------|----------|--------|-----|
| Sash 尺寸 | 4px (可配置) | 无独立 sash | ~8px | N/A |
| Hover 效果 | 渐变色高亮 | 背景色 | 背景色 | 高亮 |
| 过渡动画 | 100ms ease-out | 无 | 200ms ease | 300ms ease |
| 颜色变量 | --vscode-sash-hoverBorder | theme | --color-primary | 自定义 |
| 触控优化 | touch events | 无 | 无 | 有 |
| 主题化 | 完整主题系统 | theme CSS | dark/light | 主题色 |

### 5.4 性能策略对比

| 策略 | VS Code | Obsidian | Linear | Arc |
|------|---------|----------|--------|-----|
| 布局计算 | 同步 size 分配 | DOM 重排 | React reconciliation | Chromium layout |
| 拖拽节流 | 无（直接 fire） | requestAnimationFrame | requestAnimationFrame | requestAnimationFrame |
| DOM 操作 | 最小化（仅更新 style） | 直接 DOM | React 虚拟 DOM | Chromium |
| 惰性布局 | LayoutController | N/A | N/A | N/A |
| 缓存策略 | cachedVisibleSize | 无 | memo | Chromium 缓存 |
| linkedSash | 联动不重复计算 | N/A | N/A | N/A |

---

## 6. 对 Crish 项目的启示

### 6.1 可直接借鉴的模式

**从 VS Code 借鉴：**

1. **Sash + SplitView 两层架构**：Sash 只负责拖拽事件处理，SplitView 负责尺寸约束分配
2. **IVIew 约束接口**：`minimumSize / maximumSize / priority / snap` 约束系统完整可靠
3. **proportionalLayout**：窗口缩放时按比例恢复尺寸，避免布局跳跃
4. **Sizing 策略枚举**：Distribute / Split / Auto 三种策略覆盖所有场景
5. **全局光标 CSS 覆盖**：比全局遮罩层更轻量，解决拖拽光标问题
6. **iframe pointer-events 禁用**：解决 iframe 事件丢失问题
7. **serialize/deserialize**：树形布局完整序列化方案
8. **LayoutStateModel**：运行时状态 + 持久化状态分离

**从 Obsidian 借鉴：**

9. **Leaf + Split 简化模型**：如果不需要复杂约束，可以用更简单的模型
10. **标签拖拽范式**：拖拽标签到新位置创建/移动面板
11. **左右侧边栏体系**：固定侧边栏 + 可切换标签页
12. **工作区手动保存/恢复**：用户可控的布局持久化

**从 Linear 借鉴：**

13. **拖拽 ghost 设计**：旋转 + 阴影的拖拽卡片视觉效果
14. **drop zone 样式**：蓝色高亮边框 + 背景色
15. **极简交互反馈**：不拖沓的即时响应

**从 Arc 借鉴：**

16. **空间/工作区概念**：多个独立布局上下文
17. **拖拽拆分预览**：拖拽时显示目标区域预览
18. **侧边栏垂直标签**：充分利用宽屏空间

### 6.2 应避免的设计

1. **避免多层 DOM 嵌套**（VS Code 的 GridView 树嵌套过深）
2. **避免无约束系统**（Obsidian 缺少尺寸约束导致面板大小不可控）
3. **避免全局遮罩层**（VS Code 已验证更轻量的 CSS 覆盖方案可行）
4. **避免拖拽节流不足**（Obsidian 缺少 requestAnimationFrame 导致闪烁）
5. **避免过度复杂的 linkedSash**（为 2x2 特殊优化增加了大量复杂度）
6. **避免布局计算耦合**（Linear 的固定布局不适合 Crish 的灵活需求）

### 6.3 最佳实践总结

**架构层面：**
1. **分层设计**：Event Handling → Layout Calculation → DOM Update 三层分离
2. **约束驱动**：每个视图声明自己的尺寸约束，布局算法自动分配
3. **事件冒泡**：子视图变化通过 Event 冒泡到父容器触发重排
4. **惰性布局**：首次 layout() 前冻结所有布局计算

**拖拽层面：**
5. **Pointer Events 统一**：用 PointerEvent 代替 MouseEvent + TouchEvent
6. **全局光标覆盖**：拖拽期间覆盖 `* { cursor: xxx !important }`
7. **iframe 保护**：拖拽时禁用 iframe 指针事件
8. **拖动预览**：拖拽卡片跟随鼠标 + 目标位置指示器

**持久化层面：**
9. **树状序列化**：递归 serialize/deserialize 覆盖整个布局树
10. **运行时/持久化状态分离**：LayoutStateModel 模式
11. **缓存可见尺寸**：隐藏视图保留尺寸用于恢复

**性能层面：**
12. **change detection 防抖**：`createLatchedOnDidChangeViewEvent` 模式
13. **requestAnimationFrame**：拖拽过程中避免同步布局
14. **最小化 DOM 操作**：仅更新 style 属性而非重建 DOM

---

*文档版本: v1.0*
*分析日期: 2026-07-22*
