# Demo 参考架构与 CSS 几何对齐排查报告

> **文档定位**：`docs/pane-tab-system/analysis/03-Demo参考架构与CSS几何对齐排查.md`  
> **审查对象**：  
> - `reference/chat-composer-component/index.html`  
> - `reference/chat-composer-component/css/composer.css`  
> - `reference/chat-composer-component/css/design-tokens.css`  
> - `reference/chat-composer-component/js/popovers.js`  
> - `apps/crish-desktop/src/components/top-bar/AppTopBar.tsx` / `AppTopBar.module.css`  
> - `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx` / `BinaryTreeWorkspace.module.css`  
> - `apps/crish-desktop/src/components/shell/GlobalSessionTabBar.tsx`  
> **核心任务**：全面剖析金标 Demo 的卡片岛屿拓扑（Card Island Architecture）、标签栏物理几何、标签状态微交互、1:1 几何对齐机制与动态智能固定（Smart Pinning）逻辑，为桌面端标签页系统重构提供精确的几何基线与源码参照。

---

## 1. 概述与核心结论

通过对金标 Demo（`reference/chat-composer-component`）与当前桌面端（`apps/crish-desktop`）的全面代码审计与几何测量，得出以下核心结论：

1. **宿主归属本质差异**：
   - **Demo** 采用 **卡片岛屿体系（Card Island Architecture）**：标签栏（`.tree-pane-header`，高度 36px）与卡片主体（`.tree-pane-content`）同属叶子面板（`.tree-leaf-pane`）的直接子元素。标签栏物理上就作为外卡片的「头顶」，天然达成与卡片主体的 **1:1 严格左对齐与几何同宽**。
   - **当前桌面端** 采用了 **全局顶栏 + 单大画布体系**：顶栏（`AppTopBar.tsx`）是一个通栏组件，标签栏（`GlobalSessionTabBar.tsx`）被强塞在全局顶栏中间，而下方工作区被画成了一个巨大的单一卡片（`.canvas`），导致标签栏与卡片主体在几何、分屏与层级上完全脱节。

2. **微观交互与视觉规格**：
   - **单个标签页（`.session-tab-item`）**：高度锁定 **26px**，圆角 **6px**，字体 **12px**，默认透明底，悬停 `rgba(0,0,0,0.05)`，激活态采用 `#ffffff` 纯白背景 + `rgba(0,0,0,0.08)` 浅色 1px 细边框 + 双层柔和微阴影（`0 1px 3px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.04)`）。
   - **新建按钮双模架构**：内置流内按钮（`in-flow`）与固定悬浮按钮（`pinned`）双 DOM 节点，通过 `ResizeObserver` 监听溢出并切换 `.tree-pane-header.has-overflow`，辅以横向滚轮重定向（`wheel` 事件拦截转换）。

---

## 2. Demo 物理 DOM 拓扑树剖析

在 Demo 中，整个工作区的 DOM 树状层级由 `WorkspaceSplitRenderer`（[`popovers.js:1957-2265`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L1957-L2265)）与核心 CSS（[`composer.css:71-165, 1756-1848`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L71-L165)）严格定义：

```text
.chat-app-layout (100vw * 100vh flex-row, bg: #f4f5f7)
├── aside.chat-left-sidebar (width: 240px, 可折叠)
├── .layout-resizer-sidebar (侧栏拖拽分隔条)
└── .app-workspace-container (flex: 1 1 0, height: 100vh, flex-col)
    ├── header.workspace-top-bar (height: 36px, position: absolute, pointer-events: none, z-index: 200)
    │   └── .workspace-top-bar__trail (margin-left: auto, pointer-events: auto, 三个窗口控制按钮 108px)
    └── main.workspace-content-body (flex: 1, padding: 0 8px 8px 0 / 折叠时 padding-left: 8px)
        └── #binaryTreeWorkspaceContainer
            └── .tree-workspace-root (flex: 1 1 0, width: 100%, height: 100%)
                └── .tree-branch / .tree-leaf-pane (二叉树分支或叶子)
                    │
                    ▼ 叶子面板 (.tree-leaf-pane)
                    ├── div.tree-pane-header (height: 36px, flex-shrink: 0, 独立标签栏)
                    │   ├── div.top-bar-tabs-container (flex: 1 1 auto, overflow-x: auto)
                    │   │   ├── div.top-bar-tabs-list (flex, gap: 4px)
                    │   │   │   ├── div.session-tab-item (active)
                    │   │   │   │   ├── span.tab-item-title ("重构 IPC 缓冲通道")
                    │   │   │   │   └── button.tab-item-close-btn (关闭按钮)
                    │   │   │   └── div.session-tab-item ...
                    │   │   └── button.top-bar-new-tab-btn.in-flow (流内新建按钮)
                    │   └── div.top-bar-fixed-cluster (flex: 0 0 auto)
                    │       └── button.top-bar-new-tab-btn.pinned (溢出时激活的右侧固定新建按钮)
                    │
                    ├── div.tree-pane-content (flex: 1, height: calc(100% - 36px), 白底圆角大卡片)
                    │   ├── div.chat-main-pane (左侧主对话流)
                    │   ├── div.layout-resizer-panel (右侧抽屉拖拽条)
                    │   └── div.chat-side-panel (右侧工具抽屉：产物/预览)
                    │
                    └── button.top-action-btn.top-side-panel-btn (右侧面板开关，绝对定位 top: 41px, right: 10px)
```

---

## 3. 标签栏（`.tree-pane-header`）几何结构剖析

### 3.1 容器几何与布局参数

源码对应位置：[`composer.css:1800-1833`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L1800-L1833)、[`popovers.js:2020-2113`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2020-L2113)。

```css
/* 引用自 reference/chat-composer-component/css/composer.css:1800-1817 */
.tree-pane-header {
  height: 36px;
  min-height: 36px;
  max-height: 36px;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 4px;
  border-bottom: none;
  user-select: none;
  flex-shrink: 0;
  box-sizing: border-box;
  position: relative;
  z-index: 5;
  overflow: hidden;
  transition: padding-left var(--dur-base) var(--ease-spring);
}
```

| 参数项 | Demo 规范值 | 说明 |
| :--- | :--- | :--- |
| **高度** | `36px`（锁死 `height` / `min-height` / `max-height`） | 保证与全局窗口控制三键（36px）垂直完美对齐 |
| **背景色** | `transparent` | 透出底层的灰底画布（`--bg-shell: #f4f5f7`），形成悬浮感 |
| **下边框** | `none` | 无分割线，与下方白底卡片形成自然的落差与层次 |
| **默认内边距** | `0 4px` | 内部留白，使标签项不贴紧边缘 |
| **Z-Index** | `5` | 高于普通内容，低于全局窗口控制浮层（`z-index: 200`） |

### 3.2 声明式系统通道避让（Channel Clearance）

为了让位于左上角的侧栏展开按钮（折叠时）和右上角的系统窗口三键（最小化/最大化/关闭），Demo 采用了**自适应位置标记与声明式 CSS 避让规则**：

```css
/* 引用自 reference/chat-composer-component/css/composer.css:1819-1832 */
.tree-leaf-pane.top-row.left-edge > .tree-pane-header {
  padding-left: 0;
}

/* 声明式系统通道避让：当左侧历史栏折叠收起时，最左上角 Pane Header 原生让出折叠/展开按钮区域 (44px) */
.chat-app-layout:not(.has-left-sidebar) .tree-leaf-pane.top-row.left-edge > .tree-pane-header,
.chat-left-sidebar.collapsed ~ .app-workspace-container .tree-leaf-pane.top-row.left-edge > .tree-pane-header {
  padding-left: 44px;
}

/* 声明式系统通道避让：最右上角 Pane Header 原生避让右上角系统窗口三键 (108px) */
.tree-leaf-pane.top-row.right-edge > .tree-pane-header {
  padding-right: 112px;
}
```

- **位置标记机制**（[`popovers.js:2013-2017`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2013-L2017)）：在遍历二叉树构建叶子时，根据节点在树中的几何方位，自动打上 `flags.topRow`、`flags.leftEdge`、`flags.rightEdge`，从而使处于顶行最左、最右的叶子自动激活避让。
- **左侧避让**：当侧栏折叠时，左上角 Header 动态扩展 `padding-left: 44px`，使标签自动向右推移，避开悬浮的侧栏开关。
- **右侧避让**：右上角 Header 预留 `padding-right: 112px`（36px * 3 = 108px + 4px 缓冲区），避免标签页或新建按钮被全局窗口控制三键遮挡。

---

## 4. 单个标签页（`.session-tab-item`）微观几何与状态机

### 4.1 几何与基础样式

源码对应位置：[`composer.css:176-221`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L176-L221)、[`popovers.js:2030-2073`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2030-L2073)。

```css
/* 引用自 reference/chat-composer-component/css/composer.css:176-221 */
.session-tab-item {
  height: 26px;
  max-width: 180px;
  min-width: 0;
  flex: 0 1 150px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0 4px 0 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary, #666666);
  cursor: pointer;
  white-space: nowrap;
  box-sizing: border-box;
  user-select: none;
  overflow: hidden;
  transition: background var(--dur-fast) var(--ease-default),
              color var(--dur-fast) var(--ease-default),
              border-color var(--dur-fast) var(--ease-default),
              box-shadow var(--dur-fast) var(--ease-default),
              max-width 220ms cubic-bezier(0.16, 1, 0.3, 1),
              flex-basis 220ms cubic-bezier(0.16, 1, 0.3, 1),
              padding 220ms cubic-bezier(0.16, 1, 0.3, 1),
              margin 220ms cubic-bezier(0.16, 1, 0.3, 1),
              opacity 180ms ease,
              transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.session-tab-item:hover {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-primary, #111111);
}

.session-tab-item.active {
  background: #ffffff;
  color: var(--text-primary, #111111);
  font-weight: 500;
  border-color: rgba(0, 0, 0, 0.08);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 1px rgba(0, 0, 0, 0.04);
}
```

### 4.2 微观要素对照表

| 视觉属性 | Demo 规范值 | 语义说明 |
| :--- | :--- | :--- |
| **高度（Height）** | `26px` | 相比 36px 顶栏留出上下各 5px 留白，形成精致内嵌胶囊感 |
| **弹性基准（Flex）** | `flex: 0 1 150px` / `max-width: 180px` | 默认基准宽 150px，最大限制 180px，支持挤压收缩 |
| **圆角（Radius）** | `6px` | 紧凑的内圆角，与外卡片 `10px` 形成内外同心递减 |
| **字号与字重** | `12px` / 默认 `400`，激活态 `500` | 紧凑小字号，避免标签文字过重喧宾夺主 |
| **内边距（Padding）** | `0 4px 0 8px` | 左侧文字起始留白 8px，右侧关闭按钮留白 4px |
| **默认态（Default）** | 背景透明，边框 `1px transparent`，文字 `#666666` | 融入灰底背景 |
| **悬停态（Hover）** | 背景 `rgba(0, 0, 0, 0.05)`，文字 `#111111` | 柔和浅灰底反馈 |
| **激活态（Active）** | 背景 `#ffffff`，边框 `rgba(0,0,0,0.08)`，双层微阴影 | **白底实体浮起**，与下方白色大卡片形成一体化连通质感 |

### 4.3 标签关闭按钮（`.tab-item-close-btn`）

源码对应位置：[`composer.css:445-464`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L445-L464)、[`popovers.js:2040-2062`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2040-L2062)。

```css
/* 引用自 reference/chat-composer-component/css/composer.css:445-464 */
.tab-item-close-btn {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary, #999999);
  padding: 0;
  flex-shrink: 0;
  transition: background var(--dur-fast) var(--ease-default), color var(--dur-fast) var(--ease-default);
}

.tab-item-close-btn:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--text-primary, #111111);
}
```

- **尺寸**：`16px * 16px` 正方形，内部 SVG 图标 `10px * 10px`（`stroke-width="2"`）。
- **圆角**：`3px`。
- **交互事件**：
  - 左键点击关闭按钮：`e.stopPropagation()` 后触发 `_handleCloseTab`，播放平滑离场动画。
  - 中键点击标签（`auxclick` 与 `e.button === 1`）：支持直接中键关闭标签页。

### 4.4 动画状态机（Entry & Exit Transitions）

源码对应位置：[`composer.css:223-261`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L223-L261)、[`popovers.js:1988-2006`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L1988-L2006)。

```css
/* 引用自 reference/chat-composer-component/css/composer.css:223-261 */
@keyframes tabSlideIn {
  from {
    opacity: 0;
    transform: scale(0.92) translateX(-6px);
    max-width: 0;
    flex-basis: 0px;
    padding-left: 0;
    padding-right: 0;
    margin-right: -4px;
  }
  to {
    opacity: 1;
    transform: scale(1) translateX(0);
    max-width: 180px;
    flex-basis: 150px;
    padding-left: 8px;
    padding-right: 4px;
    margin-right: 0;
  }
}

.session-tab-item.is-entering {
  animation: tabSlideIn 220ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.session-tab-item.is-leaving {
  max-width: 0 !important;
  min-width: 0 !important;
  flex-basis: 0px !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  margin-left: 0 !important;
  margin-right: -4px !important;
  opacity: 0 !important;
  transform: scale(0.88) translateX(-4px) !important;
  pointer-events: none !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
```

- **入场机制**：新创建标签页被打上 `.is-entering` 类，通过 `tabSlideIn` 动画在 220ms 内从宽度 0、缩放 0.92 弹性展开至 150px。
- **离场机制（零延迟无感切换）**：点击关闭激活标签时，立即计算相邻标签（`curIdx === 0 ? 1 : curIdx - 1`）并在视觉上先行激活；当前标签添加 `.is-leaving` 类，触发 220ms 弹性折叠并由 `setTimeout` 最终调用 Store 移除数据，杜绝 UI 闪烁。

---

## 5. 标签栏与卡片主体 1:1 几何对齐机制

### 5.1 物理结构对称与同宽机制

Demo 中标签栏与卡片主体的对齐并非依靠脆弱的 JavaScript 像素计算，而是基于优雅的 **Flexbox 几何包含关系（Structural Containment）**：

```text
┌────────────────────────────────────────────────────────┐
│ .tree-leaf-pane (width: W, height: H, flex: 1)         │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ .tree-pane-header (width: 100%, height: 36px)    │  │  ◄── 标签栏（头顶）
│  │  [Tab 1] [Tab 2] [+]                           │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │ .tree-pane-content (width: 100%, H - 36px)       │  │  ◄── 卡片主体（白底大卡）
│  │  border-radius: 10px; border: 1px solid #...;    │  │
│  │  box-shadow: 0 1px 3px ...;                      │  │
│  │                                                  │  │
│  │  ┌───────────────────────┐┌─┐┌────────────────┐  │  │
│  │  │ .chat-main-pane       ││ ││.chat-side-panel│  │  │
│  │  │                       ││ ││                │  │  │
│  │  └───────────────────────┘└─┘└────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

1. **同宿主同一列**：`.tree-pane-header` 与 `.tree-pane-content` 是 `.tree-leaf-pane` 容器内的两个纵向兄弟节点（`display: flex; flex-direction: column`）。
2. **严格左对齐**：二者的 `x` 坐标在 `.tree-leaf-pane` 内均从 `0` 开始。
3. **同宽伸缩**：二者的宽度均为父容器的 `100%`。无论分屏如何拖拽调整比例（`0.3 : 0.7` 或 `0.5 : 0.5`），标签栏始终与下方卡片同生共死、绝对同宽！
4. **分屏多卡片独立**：当二叉树拆分出多个 Leaf Pane 时，每个 Leaf Pane 都拥有自己独立的 `.tree-pane-header` 和 `.tree-pane-content`，不存在跨卡片共享顶栏导致的撕裂感。

### 5.2 卡片圆角与阴影体系（Card Island Tokens）

源码对应位置：[`design-tokens.css:36-39`](file:///c:/Software/conex/reference/chat-composer-component/css/design-tokens.css#L36-L39)、[`composer.css:1834-1847`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L1834-L1847)。

```css
/* 引用自 reference/chat-composer-component/css/design-tokens.css:36-39 */
--card-radius: 10px;
--card-shadow: 0 1px 3px rgba(0, 0, 0, 0.03), 0 4px 12px rgba(0, 0, 0, 0.02);

/* 引用自 reference/chat-composer-component/css/composer.css:1834-1847 */
.tree-pane-content {
  flex: 1 1 0;
  min-height: 0;
  height: calc(100% - 36px);
  display: flex;
  flex-direction: row;
  position: relative;
  overflow: hidden;
  background: var(--bg-page, #ffffff);
  border-radius: var(--card-radius, 10px);
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.08));
  box-shadow: var(--card-shadow, 0 1px 3px rgba(0, 0, 0, 0.03), 0 4px 12px rgba(0, 0, 0, 0.02));
  box-sizing: border-box;
}
```

- **圆角**：`10px`，呈现优雅的现代桌面岛屿质感。
- **双层微阴影**：第一层 `0 1px 3px rgba(0, 0, 0, 0.03)` 提供接地感，第二层 `0 4px 12px rgba(0, 0, 0, 0.02)` 提供悬浮层次感。
- **边框**：`1px solid rgba(0, 0, 0, 0.08)` 精细分割线。

### 5.3 右侧工具按钮绝对锚定（`.top-side-panel-btn`）

源码对应位置：[`composer.css:1939-1967`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L1939-L1967)、[`popovers.js:2144-2193`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2144-L2193)。

```css
/* 引用自 reference/chat-composer-component/css/composer.css:1939-1967 */
.tree-leaf-pane > .top-side-panel-btn {
  position: absolute;
  top: 41px;
  right: 10px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary, #666666);
  z-index: 110;
  padding: 0;
  transition: background var(--dur-fast) var(--ease-default), color var(--dur-fast) var(--ease-default);
}
```

- **位置**：`top: 41px; right: 10px;`（36px 顶栏高 + 5px 偏移 = 41px）。
- **几何宿主**：直接挂载在 `.tree-leaf-pane` 上，`z-index: 110` 浮在卡片内容上方右上角，精准作为打开/收起当前 Leaf 右侧抽屉（`SidePanel`）的独立常驻入口。

---

## 6. 横向滚轮与溢出智能固定（Smart Pinning）机制

### 6.1 横向滚轮原生劫持与重定向

当标签页过多导致超出容器宽度时，用户通常使用纵向滚轮滚动。Demo 在 Tab 条带容器上实现了平滑的纵向转横向滚轮事件重定向：

源码对应位置：[`popovers.js:2093-2099`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2093-L2099)。

```javascript
// 引用自 reference/chat-composer-component/js/popovers.js:2093-2099
strip.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });
```

- **逻辑**：当检测到用户的垂直滚动幅度（`|deltaY|`）大于水平滚动（`|deltaX|`）时，直接将 `deltaY` 累加到 `strip.scrollLeft`，并调用 `e.preventDefault()` 阻止外层页面滚动，实现极其丝滑的水平滚动体验。

### 6.2 双按钮拓扑与智能固定状态机（Smart Pinning）

为了解决「标签溢出滚出屏幕后，新建按钮也随之滚出不可见」的经典体验痛点，Demo 设计了**流内（in-flow）与悬停固定（pinned）双按钮协同机制**：

#### 1. DOM 结构（[`popovers.js:2076-2091`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2076-L2091)）：
```html
<div class="tree-pane-header">
  <!-- 可滚动的条带容器 -->
  <div class="top-bar-tabs-container">
    <div class="top-bar-tabs-list">
      <!-- 标签项集合 -->
    </div>
    <!-- 流内加号：紧随最后一个标签 -->
    <button class="top-bar-new-tab-btn in-flow">+</button>
  </div>
  <!-- 固定簇：位于 Header 最右侧，独立于滚动容器 -->
  <div class="top-bar-fixed-cluster">
    <!-- 固定加号：默认隐藏，溢出时激活 -->
    <button class="top-bar-new-tab-btn pinned">+</button>
  </div>
</div>
```

#### 2. CSS 切换规则（[`composer.css:368-426`](file:///c:/Software/conex/reference/chat-composer-component/css/composer.css#L368-L426)）：
```css
/* 引用自 reference/chat-composer-component/css/composer.css:396-426 */
/* 默认无溢出态：pinned 按钮完全隐藏并坍缩 */
.top-bar-new-tab-btn.pinned {
  opacity: 0;
  width: 0;
  min-width: 0;
  flex: 0 0 0px;
  transform: scale(0.85);
  pointer-events: none;
  overflow: hidden;
  margin: 0;
}

/* 发生溢出态（.tree-pane-header.has-overflow）：pinned 展开，in-flow 隐藏 */
.tree-pane-header.has-overflow .top-bar-new-tab-btn.pinned {
  opacity: 1;
  width: 26px;
  min-width: 26px;
  flex: 0 0 26px;
  transform: scale(1);
  pointer-events: auto;
  margin-right: 4px;
}

.tree-pane-header.has-overflow .top-bar-new-tab-btn.in-flow {
  opacity: 0;
  pointer-events: none;
  width: 0;
  min-width: 0;
  flex: 0 0 0px;
  margin: 0;
  overflow: hidden;
}
```

#### 3. ResizeObserver 溢出探测（[`popovers.js:2101-2110`](file:///c:/Software/conex/reference/chat-composer-component/js/popovers.js#L2101-L2110)）：
```javascript
// 引用自 reference/chat-composer-component/js/popovers.js:2101-2110
const checkHdrOverflow = () => {
  const isOverflow = strip.scrollWidth > strip.clientWidth + 2;
  hdr.classList.toggle('has-overflow', isOverflow);
};
if (window.ResizeObserver) {
  new ResizeObserver(checkHdrOverflow).observe(strip);
}
setTimeout(checkHdrOverflow, 30);
```

- **状态无缝互斥**：
  - **标签少（无溢出）**：`in-flow` 加号紧随在末尾标签后方，自然的贴靠呈现；`pinned` 加号零尺寸隐藏。
  - **标签多（发生溢出）**：`in-flow` 加号瞬间退场，`pinned` 加号在 Header 右端优雅淡入展开，保证用户无论滚动到何处，始终可以一键新建标签页！

---

## 7. Demo 架构 vs 当前桌面端实现全景对照

经过对 `apps/crish-desktop` 源码的深入对比，现将关键差异与根因整理如下：

| 对比维度 | 金标 Demo（`chat-composer-component`） | 当前桌面端（`apps/crish-desktop`） | 差异危害与视觉问题 |
| :--- | :--- | :--- | :--- |
| **整体架构范式** | **卡片岛屿体系（Card Island Architecture）**：每个 Leaf 独立拥有 Header + Content | **全局通栏 + 单大画布体系**：全窗口顶部单一 `AppTopBar`，下方一个大 `.canvas` | 导致标签栏脱离卡片主体，无法支持多分屏下各自卡片的独立会话标签展示 |
| **标签栏几何对齐** | 标签栏作为外卡片头顶，与卡片主体 **1:1 严格左对齐与几何同宽** | 标签栏塞在 `AppTopBar` 中间，左受侧栏开关推挤，右受窗口三键挤压 | 标签栏与下方内容在水平轴上没有任何几何对齐线，视觉显得涣散不规整 |
| **系统通道避让** | 声明式 CSS 避让（`.top-row.left-edge` 44px, `.top-row.right-edge` 112px） | `AppTopBar.tsx` 中硬编码 `railWidth = '106px' / '48px'` | 避让逻辑与侧栏/窗口状态紧耦合，分屏时无法针对右上方特定卡片进行局部避让 |
| **单个标签页样式** | 高度 **26px**、圆角 **6px**、激活态纯白 `#ffffff` + 微边框 + 双层微阴影 | 使用通用的 `ui/TabStrip`，背景色与边框样式退化，缺少高质感双层微阴影 | 标签页失去实体白底胶囊的凸起感，与下方白底卡片无法呼应 |
| **新建按钮架构** | `in-flow` + `pinned` 双模互斥，`ResizeObserver` 自动感知 | 仅在 `GlobalSessionTabBar.tsx` 中放一枚末尾 `Button`，无溢出固定能力 | 当打开标签过多发生水平滚动时，新建按钮直接滚出可视区域，用户无法新建 |
| **横向滚轮支持** | `strip.addEventListener('wheel', ...)` 将垂直滚轮重定向为水平滚动 | 未接入滚轮事件拦截，仅依赖原生 touch 或按住 Shift 滚轮 | 用户使用普通鼠标滚轮无法在标签栏上水平滚动，操作极其别扭 |
| **关闭标签动画** | 220ms 弹性宽度坍缩 + 相邻标签预激活，零闪烁 | 依靠 React 状态直接销毁 DOM，无宽度折叠过渡动画 | 关闭标签时发生生硬的几何跳变与文字闪烁 |

---

## 8. 重构实施建议与落地原则

基于上述排查结果，后续在规划实施 `docs/pane-tab-system/plans/` 架构重构时，应恪守以下原则：

1. **回归 Card Island 宿主架构**：
   - 彻底将 `TreeLeafPanel` 升级为具备独立的 `Header (36px)` + `Content (calc(100% - 36px))` 的卡片岛屿结构。
   - 使标签栏从全局顶栏中解耦，真正落位到每个 Leaf 卡片的正上方，与卡片主体达成结构级 1:1 左对齐与同宽。

2. **严格 1:1 复制 CSS 几何与 Tokens**：
   - 标签项高度锁定 `26px`、圆角锁定 `6px`、间距 `4px`。
   - 激活态严格采用 `#ffffff` + 浅色描边 + 双层微阴影（`0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 1px rgba(0, 0, 0, 0.04)`）。
   - 卡片主体圆角锁定 `10px`，阴影采用 `--card-shadow`。

3. **完整集成 Smart Pinning 与横向滚轮**：
   - 在 TabStrip 容器上装配 `wheel` 事件处理器，支持纵向转横向平滑滚动。
   - 引入 `in-flow` 与 `pinned` 双新建按钮，通过 `ResizeObserver` 监听 `strip.scrollWidth > strip.clientWidth` 自动切换 `.has-overflow` 状态类。

4. **无缝声明式系统通道避让**：
   - 由二叉树布局引擎向顶行最左、最右叶子注入 `topRow`、`leftEdge`、`rightEdge` 标记，配合全局侧栏展开/收起状态，通过纯 CSS 完成 44px（左侧）与 112px（右侧）的平滑避让。
