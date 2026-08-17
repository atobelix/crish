# AFFiNE 极致流畅的拖拽重排与动效系统 (DND & Animations) 深度赏析

> **报告标识**：AFFINE-DND-ANIMATION-DEEP-DIVE  
> **研究对象**：`reference/markdown_compare/AFFiNE/` 源码库中的 DND 拖拽交互、Tab/Panel 重排、FLIP 物理边界计算、指示线形态变换与动效冻结机制  
> **工程视角**：前端交互工程美学、微动效物理学、高刷新率手势渲染、跨框架状态协同  
> **覆盖源码范围**：`packages/frontend/component/src/ui/dnd/`、`packages/frontend/core/src/modules/app-tabs-header/`、`packages/frontend/core/src/modules/workbench/view/split-view/`、`packages/frontend/component/src/components/resize-panel/`、`blocksuite/affine/data-view/src/core/utils/wc-dnd/`、`blocksuite/affine/widgets/drag-handle/`、`blocksuite/affine/components/src/drop-indicator/` 等核心模块。

---

## 目录 (Table of Contents)

1. [导言：AFFiNE 交互重力场与数字物性的工程美学](#一导言affine-交互重力场与数字物性的工程美学)
   - 1.1 界面交互中的“数字物性”（Digital Materiality）
   - 1.2 拖拽重排系统的双轨架构全景
2. [微动效与形态变换：2px 极细蓝色指示线与 DropZone 的形态演化](#二微动效与形态变换2px-极细蓝色指示线与-dropzone-的形态演化)
   - 2.1 极简主义空间指引：`DropIndicator` 的几何数学与语义状态
   - 2.2 树状层级穿透：`reorder-above`、`reorder-below`、`make-child` 与 `reparent`
   - 2.3 SplitView 分屏指示器的延时形态演变（Keyframe Morphing）
   - 2.4 Tab 标签页与看板卡片的微倾斜与发光微动效
3. [FLIP 物理位移与空间重排：跨容器/跨列表的自然边界过渡](#三flip-物理位移与空间重排跨容器跨列表的自然边界过渡)
   - 3.1 FLIP 核心原理与 Preact Signals 响应式驱动
   - 3.2 列表排序策略与几何缝隙动态补偿算法（Gap Compensation）
   - 3.3 空间几何碰撞裁判：`closestCenter` 欧几里得距离与 `linearMove` 轴向投影
   - 3.4 树形导航节点悬停 1000ms 自动展开与自拖拽排他机制
4. [16~32ms 拖影阻断：拖拽与缩放期间的动效冻结机制 (Transition Freezing)](#四1632ms-拖影阻断拖拽与缩放期间的动效冻结机制-transition-freezing)
   - 4.1 核心痛点：CSS Transition 与 60fps 实时光标跟踪的天然冲突
   - 4.2 动效冻结的三维落地实践（Header / SplitView / ResizePanel）
   - 4.3 零开销订阅：懒加载 Getter 属性劫持与 React 渲染隔离
5. [虚拟克隆与轻量级快照：BlockSuite 拖拽预览沙箱](#五虚拟克隆与轻量级快照blocksuite-拖拽预览沙箱)
   - 5.1 复杂富文本与画布节点的拖拽重绘挑战
   - 5.2 `PreviewHelper` 的 Query 隔离沙箱与占位符降级
   - 5.3 跨文档与白板画布的数据映射流转
6. [架构总览与设计美学沉思](#六架构总览与设计美学沉思)
   - 6.1 模块依赖关系与数据流架构图
   - 6.2 “无感”（Imperceptible）的流畅哲学与工程启示

---

## 一、导言：AFFiNE 交互重力场与数字物性的工程美学

### 1.1 界面交互中的“数字物性”（Digital Materiality）

在桌面协同与知识操作系统中，拖拽（Drag & Drop）从来不只是一项简单的“数据移动”操作，而是用户与数字内容之间发生物理感官交流的最直接通道。当用户用鼠标按下某一篇文档、一个 Tab 标签、一块分屏面板或是一张看板卡片时，屏幕上的像素不应仅仅是机械地跟随光标坐标刷新，而应当呈现出**质量、惯性、粘滞力、空间占位预测与边界张力**。

AFFiNE 在其前端架构中，将拖拽重排与微动效提升到了“工业级艺术品”的高度。在 AFFiNE 的界面中：

- 拖起元素的一瞬间，伴随着微妙的透明度衰减与微小角度（`-3deg`）的物理倾斜，给用户以“卡片被手指捏起脱离纸面”的离地悬浮感；
- 悬停在插入边缘时，呈现一条 **2px 极细的品牌色指示线（Electric Cyan / Primary Blue）**，并在边缘顶端点缀 6px/8px 的圆环 Terminal 锚点，精准勾勒出重排后的绝对落点；
- 跨分屏拖拽时，指示线在悬停 1 秒后如同水滴融入水面般，平滑膨胀变形（Morphing）为整面半透明的落点容器；
- 其他卡片与容器在感知到入侵者时，采用 **FLIP（First-Last-Invert-Play）** 硬件加速动画优雅平移避让，产生流畅的弹性空间重排；
- 在窗口缩放与拖拽期间，全局或局部的 CSS 动画被精准**冻结（Transition Freezing）**，彻底抹除 16~32ms 的渲染迟滞与橡皮筋回弹拖影。

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        AFFiNE DND & Animation Gravity Field                      │
│                                                                                 │
│   [Pick Up] ──>  Tilt (-3deg) + Opacity (0.5~0.7) + BoxShadow Floating Glow     │
│       │                                                                         │
│       ▼                                                                         │
│   [Hovering] ──> 2px Laser Indicator (Terminal Cap) ──> Morphing DropZone (1s) │
│       │                                                                         │
│       ▼                                                                         │
│   [FLIP Flow] ─> Preact Signal Transform3d + Gap Compensation (Zero Reflow)    │
│       │                                                                         │
│       ▼                                                                         │
│   [Resizing] ──> Transition Freezing (transition: none) ──> Zero Motion Blur    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 拖拽重排系统的双轨架构全景

AFFiNE 的拖拽体系采用了精妙的**双轨协同架构**：

1. **React 桌面工作区与外壳层（Shell & Workbench Layer）**：
   - 基于 `@atlaskit/pragmatic-drag-and-drop` 与 `@vanilla-extract/css`，构建了强类型的 React Hooks 封装（`useDraggable` / `useDropTarget` / `useDndMonitor`）；
   - 管理应用顶栏 Tab 拖拽（`app-tabs-header`）、分屏重排与缩放（`split-view`）、侧边栏树节点层级重组（`navigation-panel/tree`）以及折叠面板缩放（`resize-panel`）。

2. **BlockSuite 积木画布与数据视图层（BlockSuite Canvas & Data-View Layer）**：
   - 基于 **Preact Signals**（`@preact/signals-core`）与 **Lit Web Components** 自研了高性能无依赖的 **WC-DND** 引擎；
   - 支持毫秒级信号响应、自动边界滚动（Auto Scroll）、最近中心碰撞检测（`closestCenter`）、线性轴向投影（`linearMove`）以及基于 FLIP 的列表矩阵重排（`horizontalListSortingStrategy` / `verticalListSortingStrategy`）。

---

## 二、微动效与形态变换：2px 极细蓝色指示线与 DropZone 的形态演化

### 2.1 极简主义空间指引：`DropIndicator` 的几何数学与语义状态

在传统 Web 应用中，拖拽指示器常采用厚重的虚线框或突兀的占位色块，破坏了界面的结构美感。AFFiNE 在 `packages/frontend/component/src/ui/dnd/drop-indicator.tsx` 与 `drop-indicator.css.ts` 中设计了一套基于 **2px 极细基线** 与 **Terminal 终端圆点** 的高精度指示器系统。

#### 源码剖析：Vanilla-Extract 驱动的几何排版

在 `drop-indicator.css.ts` 中，AFFiNE 通过 CSS 变量与伪元素精确构建了指示线的双层几何模型：

```typescript
// 引用自: packages/frontend/component/src/ui/dnd/drop-indicator.css.ts:8-58
export const treeLine = style({
  vars: {
    [terminalSize]: '8px',
  },
  position: 'absolute',
  top: 0,
  right: 0,
  left: horizontalIndent,
  bottom: 0,
  pointerEvents: 'none', // 严防指示线自身捕获鼠标事件触发死循环 dragenter

  // Terminal 圆环端点
  '::before': {
    display: 'block',
    content: '""',
    position: 'absolute',
    zIndex: 2,
    boxSizing: 'border-box',
    width: terminalSize,
    height: terminalSize,
    left: 0,
    background: 'transparent',
    borderColor: indicatorColor,
    borderWidth: 2,
    borderRadius: '50%',
    borderStyle: 'solid',
  },

  // 2px 极细导轨线
  '::after': {
    display: 'block',
    content: '""',
    position: 'absolute',
    zIndex: 1,
    background: indicatorColor,
    left: `calc(${terminalSize} / 2)`, // 线条起点精确咬合在 Terminal 圆心
    height: 2,
    right: 0,
  },

  selectors: {
    ['&[data-no-terminal="true"]::before']: {
      display: 'none',
    },
  },
});
```

#### 边缘偏移量计算公式

在四方边缘（Top, Bottom, Left, Right）检测中，指示线的位置由间隙（Gap）与厚度（2px）联合计算得出：

$$\text{lineOffset} = -0.5 \times (\text{gap} + 2\text{px})$$

```typescript
// 引用自: packages/frontend/component/src/ui/dnd/drop-indicator.tsx:98-114
function getEdgeElement(edge: Edge, gap: number = 0, noTerminal?: boolean) {
  const lineOffset = `calc(-0.5 * (${gap}px + 2px))`;
  const orientation = edgeToOrientationMap[edge];

  return (
    <div
      data-no-terminal={noTerminal}
      className={clsx([
        styles.edgeLine,
        orientationStyles[orientation],
        edgeStyles[edge],
      ])}
      style={assignInlineVars({ [styles.localLineOffset]: lineOffset })}
    />
  );
}
```

```
       [Terminal Cap: 8px Ring]
            ╭───╮
            │ O │──────────────────────────────────────────────── [2px Indicator Line]
            ╰───╯ ◀── Center Anchor at (calc(-0.5 * terminalSize))
```

这种设计的视觉心理学价值在于：

1. **零界面位移干扰**：指示线绝对定位且 `pointer-events: none`，不会导致下方 DOM 节点重排晃动；
2. **像素级落点锁定**：8px 圆环引导视觉焦点快速落入目标层级的缩进原点，2px 延伸线贯穿右侧，明确指示重组边界。

---

### 2.2 树状层级穿透：`reorder-above`、`reorder-below`、`make-child` 与 `reparent`

在侧边栏树形导航（`navigation-panel/tree/node.tsx`）中，拖拽可能代表 4 种截然不同的语义动作。AFFiNE 通过 `Instruction` 状态机将指示器形态进行无缝切换：

```typescript
// 引用自: packages/frontend/component/src/ui/dnd/drop-indicator.tsx:25-75
function getTreeElement({
  instruction,
  isBlocked,
  noTerminal,
}: {
  instruction: Exclude<Instruction, { type: 'instruction-blocked' }>;
  isBlocked: boolean;
  noTerminal?: boolean;
}): ReactElement | null {
  const style = {
    [styles.horizontalIndent]: `${instruction.currentLevel * instruction.indentPerLevel}px`,
    [styles.indicatorColor]: !isBlocked
      ? cssVar('--affine-primary-color')   // 正常操作：品牌明蓝
      : cssVar('--affine-warning-color'),   // 非法/受阻：警示亮黄
  };

  if (instruction.type === 'reorder-above') {
    return (
      <div
        className={clsx(styles.treeLine, styles.lineAboveStyles)}
        style={assignInlineVars(style)}
        data-no-terminal={noTerminal}
      />
    );
  }
  if (instruction.type === 'reorder-below') {
    return (
      <div
        className={clsx(styles.treeLine, styles.lineBelowStyles)}
        style={assignInlineVars(style)}
        data-no-terminal={noTerminal}
      />
    );
  }
  if (instruction.type === 'make-child') {
    // 状态蜕变：指示线变更为 2px 全包裹外边框（Outline Box）
    return (
      <div
        className={clsx(styles.outlineStyles)}
        style={assignInlineVars(style)}
        data-no-terminal={noTerminal}
      />
    );
  }
  if (instruction.type === 'reparent') {
    // 动态跨级回退缩进
    style[styles.horizontalIndent] = `${
      instruction.desiredLevel * instruction.indentPerLevel
    }px`;
    return (
      <div
        className={clsx(styles.treeLine, styles.lineBelowStyles)}
        style={assignInlineVars(style)}
        data-no-terminal={noTerminal}
      />
    );
  }
  return null;
}
```

#### 指示器形态演化对照表

| 拖拽意图 (Instruction) | 视觉形态 (Visual Geometry)                      | 缩进位置 (`horizontalIndent`)        | 语义反馈                             |
| :--------------------- | :---------------------------------------------- | :----------------------------------- | :----------------------------------- |
| `reorder-above`        | 顶部 2px 水平线 + 8px 左端锚点                  | `currentLevel * 20px`                | 插入至当前项上方作为同级节点         |
| `reorder-below`        | 底部 2px 水平线 + 8px 左端锚点                  | `currentLevel * 20px`                | 插入至当前项下方作为同级节点         |
| `make-child`           | **2px 全封闭圆角矩形边框 (`outlineStyles`)**    | `currentLevel * 20px`                | 成为目标项的子节点（容器高亮）       |
| `reparent`             | 底部 2px 水平线 + 8px 左端锚点                  | **`desiredLevel * 20px` (向左回缩)** | 跨越父级，回退至上一级或根级作用域   |
| `instruction-blocked`  | 原形态不变，颜色切换为 `--affine-warning-color` | 继承目标层级                         | 禁止拖拽落入（如权限不足或循环包含） |

---

### 2.3 SplitView 分屏指示器的延时形态演变（Keyframe Morphing）

在多栏分屏工作区（`split-view`）中，AFFiNE 实现了一种令人惊叹的**渐进式形态演变（Morphing Animation）**。

当用户将文档拖拽至两栏之间的调整把手（`ResizeHandle`）附近时：

1. **第 0 秒~第 1 秒（快速掠过阶段）**：把手仅显示为 50px 宽的感应区，中间呈现一条 3px 宽的亮蓝色指示线，避免用户快速滑过时产生视觉晃眼；
2. **停留超过 1 秒（确认分屏阶段）**：CSS Keyframe 动画 `expandDropIndicator` 被激活，指示线在 0.5 秒内平滑膨胀，从一条 3px 宽的窄线，**横向扩散为宽度 300px / 100% 容器尺寸、透明度 0.15 的巨大发光 DropZone 投影面**！

```typescript
// 引用自: packages/frontend/core/src/modules/workbench/view/split-view/split-view.css.ts:13-30
const expandDropIndicator = keyframes({
  from: {
    vars: {
      [resizeHandleWidth]: '50px',
      [dropIndicatorWidth]: '3px',
      [dropIndicatorOpacity]: '1',
      [dropIndicatorRadius]: '10px',
    },
  },
  to: {
    vars: {
      [resizeHandleWidth]: '300px',
      [dropIndicatorWidth]: '100%',
      [dropIndicatorOpacity]: '0.15',
      [dropIndicatorRadius]: '4px',
    },
  },
});
```

```css
/* 引用自: packages/frontend/core/src/modules/workbench/view/split-view/split-view.css.ts:149-158 */
'&[data-state="drop-indicator"][data-dragging-over="true"]': {
  animationName: expandDropIndicator,
  animationDuration: '0.5s',
  animationDelay: '1s',          /* 核心：1秒思考期防抖动 */
  animationFillMode: 'forwards',
  vars: {
    [dropIndicatorOpacity]: '1',
    [dropIndicatorWidth]: '3px',
  },
}
```

```
[0.0s - 1.0s]             [1.0s - 1.5s Morphing Transition]
   │                           ╭───────────────────────────────────────╮
   │                           │                                       │
   │ 3px Laser Line            │   100% Expanded Translucent DropZone  │
   │ (Opacity: 1.0)            │   (Opacity: 0.15, Radius: 4px)        │
   │                           │                                       │
   │                           ╰───────────────────────────────────────╯
```

这种设计的工程哲学在于**兼顾操作灵敏度与意图确定性**：

- 快速路过的拖拽操作不会触发大面积 UI 重绘与光影跳跃；
- 明确驻留的意图则得到沉浸式的空间预览反馈，告知用户“松开鼠标即可在此生成全新的分屏视窗”。

---

### 2.4 Tab 标签页与看板卡片的微倾斜与发光微动效

#### 1. 顶栏 Tab 拖拽指示线与亚像素补偿

在顶栏 `app-tabs-header` 中，Tab 之间的重排指示器拥有独特的亚像素微调逻辑：

```typescript
// 引用自: packages/frontend/core/src/modules/app-tabs-header/views/styles.css.ts:251-270
export const dropIndicator = style({
  position: 'absolute',
  height: 32,
  top: 10,
  width: 2,
  borderRadius: 2,
  opacity: 0,
  background: cssVar('primaryColor'),
  selectors: {
    '&[data-edge="left"]': {
      opacity: 1,
      transform: 'translateX(-5px)', // 补偿左侧 Tab 间隙与外边距
    },
    '&[data-edge="right"]': {
      right: 0,
      opacity: 1,
      transform: 'translateX(-9px)', // 补偿右侧关闭按钮与分隔线空间
    },
  },
});
```

#### 2. 看板卡片拾取时的物理姿态与激光发光投影

在 `blocksuite/affine/data-view/src/view-presets/kanban/pc/controller/drag.ts` 中，卡片被拖起时并不是平淡的半透明复制，而是注入了重力与光影物理学：

```typescript
// 引用自: blocksuite/affine/data-view/src/view-presets/kanban/pc/controller/drag.ts:180-209
const createDragPreview = (card: KanbanCard, x: number, y: number) => {
  const preOpacity = card.style.opacity;
  card.style.opacity = '0.5'; // 原卡片半透明留底
  const div = document.createElement('div');
  const kanbanCard = new KanbanCard();
  kanbanCard.cardId = card.cardId;
  kanbanCard.kanbanViewLogic = card.kanbanViewLogic;
  kanbanCard.isFocus$.value = true;
  kanbanCard.style.backgroundColor = 'var(--affine-background-primary-color)';
  div.append(kanbanCard);
  div.className = 'with-data-view-css-variable';
  div.style.width = `${card.getBoundingClientRect().width}px`;
  div.style.position = 'fixed';
  div.style.pointerEvents = 'none';
  div.style.transform = 'rotate(-3deg)'; // 关键微动效：-3度微小倾斜模拟单手提起
  div.style.left = `${x}px`;
  div.style.top = `${y}px`;
  div.style.zIndex = '9999';
  document.body.append(div);
  // ...
};
```

而在卡片穿梭的目标组内，落点预览线不仅具备圆角，更附加了 **35% 不透明度的电光蓝激光光晕（Ethereal Blue Laser Glow）**：

```typescript
// 引用自: blocksuite/affine/data-view/src/view-presets/kanban/pc/controller/drag.ts:210-220
const createDropPreview = () => {
  const div = document.createElement('div');
  div.dataset.isDropPreview = 'true';
  div.style.pointerEvents = 'none';
  div.style.position = 'fixed';
  div.style.zIndex = '9999';
  div.style.height = '3px';
  div.style.borderRadius = '2px';
  div.style.backgroundColor = 'var(--affine-primary-color)';
  // 核心微动效：8px 高斯扩散的柔和发光投影
  div.style.boxShadow = '0px 0px 8px 0px rgba(30, 150, 235, 0.35)';
  // ...
};
```

---

## 三、FLIP 物理位移与空间重排：跨容器/跨列表的自然边界过渡

### 3.1 FLIP 核心原理与 Preact Signals 响应式驱动

在传统的 DOM 重排方案中，直接通过修改 DOM 节点的父级或位置会导致频繁的浏览器 **Layout Reflow**，不仅帧率断崖下跌至 20~30fps，还会引发视觉上的剧烈跳变。

AFFiNE 在 `blocksuite/affine/data-view/src/core/utils/wc-dnd/sort/sort-context.ts` 中基于 **FLIP（First-Last-Invert-Play）** 技术构建了纯 CSS Transform 位移引擎。其核心数学模型如下：

1. **First（初始测量）**：在重排前，记录列表中所有元素在视口中的初始绝对几何边界矩阵 $[R_0, R_1, \dots, R_n]$；
2. **Last（推导目标态）**：计算拖拽元素悬停在 `overIndex` 时，受影响元素在最终重排后的目标位置；
3. **Invert（逆向偏移量计算）**：
   $$\Delta x = X_{\text{target}} - X_{\text{initial}}, \quad \Delta y = Y_{\text{target}} - Y_{\text{initial}}$$
4. **Play（硬件加速播放）**：直接通过 `style.transform = translate3d(Δx, Δy, 0)` 将所有受波及的节点平移，配合 `transition: transform 0.2s` 产生平滑避让动画。

```typescript
// 引用自: blocksuite/affine/data-view/src/core/utils/wc-dnd/sort/sort-context.ts:61-84
constructor(override config: SortContextConfig) {
  super(config);
  effect(() => {
    const list = this.dragSourceList$.value;
    if (list) {
      // 1. 执行排序策略计算出所有节点的 Transform 矩阵
      const transforms = this.strategy({
        rects: list.map(v => v.rect),
        activeNodeRect: this.collisionRect$.value,
        activeIndex: list.findIndex(v => v.id === this.active$.value?.id),
        overIndex: list.findIndex(v => v.id === this.overId$.value),
      });

      // 2. 硬件加速赋值，四舍五入消除亚像素抖动
      transforms.forEach((transform, i) => {
        const node = list[i]?.node;
        if (!node) return;
        if (transform != null) {
          node.style.transform = `translate3d(${Math.round(transform.x)}px,${Math.round(transform.y)}px,0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`;
        } else {
          node.style.transform = '';
        }
      });
    }
  });
}
```

```
[Initial List]      [Active Item Picked]           [FLIP Transform Inversion]
 ┌──────────┐                                       ┌──────────┐
 │  Card A  │ ───> Active Item (Dragging)           │  Card A  │ ──> (Floating Overlay)
 ├──────────┤                                       ├──────────┤
 │  Card B  │ ───> Over Target                      │  Card B  │ ──> translate3d(0, -CardA.h, 0) ↑
 ├──────────┤                                       ├──────────┤
 │  Card C  │                                       │  Card C  │ ──> translate3d(0, -CardA.h, 0) ↑
 └──────────┘                                       └──────────┘
```

---

### 3.2 列表排序策略与几何缝隙动态补偿算法（Gap Compensation）

列表元素之间往往存在动态的 `gap` 或外边距。如果仅平移卡片自身的宽高，在连续拖拽时会导致累积误差。AFFiNE 在 `horizontalListSortingStrategy.ts` 与 `verticalListSortingStrategy.ts` 中设计了精确的 **`getItemGap` 缝隙补偿算法**。

#### 垂直列表排序策略源码赏析

```typescript
// 引用自: blocksuite/affine/data-view/src/core/utils/wc-dnd/sort/strategies/vertical-list-sorting.ts:8-61
export const verticalListSortingStrategy: SortingStrategy = ({
  activeIndex,
  activeNodeRect: fallbackActiveRect,
  rects,
  overIndex,
}) => {
  const activeNodeRect = rects[activeIndex] ?? fallbackActiveRect;
  if (!activeNodeRect) return [];

  const strategy = (index: number) => {
    // 1. 被拖拽元素自身的跨越位移
    if (index === activeIndex) {
      const overIndexRect = rects[overIndex];
      if (!overIndexRect) return undefined;

      return {
        x: 0,
        y:
          activeIndex < overIndex
            ? overIndexRect.top +
              overIndexRect.height -
              (activeNodeRect.top + activeNodeRect.height)
            : overIndexRect.top - activeNodeRect.top,
        ...defaultScale,
      };
    }

    const itemGap = getItemGap(rects, index, activeIndex);

    // 2. 向下拖拽：中间受影响的元素整体向上平移避让（高度 + Gap）
    if (index > activeIndex && index <= overIndex) {
      return {
        x: 0,
        y: -activeNodeRect.height - itemGap,
        ...defaultScale,
      };
    }

    // 3. 向上拖拽：中间受影响的元素整体向下平移避让（高度 + Gap）
    if (index < activeIndex && index >= overIndex) {
      return {
        x: 0,
        y: activeNodeRect.height + itemGap,
        ...defaultScale,
      };
    }

    // 其余无关元素位移保持为 0
    return { x: 0, y: 0, ...defaultScale };
  };

  return rects.map((_, index) => strategy(index));
};
```

#### 动态间隙计算（Gap Calculation）

```typescript
// 引用自: blocksuite/affine/data-view/src/core/utils/wc-dnd/sort/strategies/vertical-list-sorting.ts:63-89
function getItemGap(
  clientRects: DndClientRect[],
  index: number,
  activeIndex: number
) {
  const currentRect: DndClientRect | undefined = clientRects[index];
  const previousRect: DndClientRect | undefined = clientRects[index - 1];
  const nextRect: DndClientRect | undefined = clientRects[index + 1];

  if (!currentRect) return 0;

  if (activeIndex < index) {
    return previousRect
      ? currentRect.top - (previousRect.top + previousRect.height)
      : nextRect
        ? nextRect.top - (currentRect.top + currentRect.height)
        : 0;
  }

  return nextRect
    ? nextRect.top - (currentRect.top + currentRect.height)
    : previousRect
      ? currentRect.top - (previousRect.top + previousRect.height)
      : 0;
}
```

---

### 3.3 空间几何碰撞裁判：`closestCenter` 欧几里得距离与 `linearMove` 轴向投影

在拖拽交互中，如何判定“当前元素正在与哪一个卡片发生碰撞”决定了手势的灵敏度。AFFiNE 提供了两种互补的碰撞裁判算法：

#### 1. 欧几里得中心距离算法 (`closestCenter`)

计算当前碰撞盒中心点与所有可放置容器中心点之间的直线欧氏距离，选取极小值：

$$D = \sqrt{(X_{\text{active}} - X_{\text{target}})^2 + (Y_{\text{active}} - Y_{\text{target}})^2}$$

```typescript
// 引用自: blocksuite/affine/data-view/src/core/utils/wc-dnd/utils/closest-center.ts:24-44
export const closestCenter: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
}) => {
  let closest: { id: string; value: number } | undefined;
  const centerRect = centerOfRectangle(collisionRect);

  for (const droppableContainer of droppableContainers) {
    const { id } = droppableContainer;
    const rect = droppableRects.get(id);

    if (rect) {
      const distBetween = distanceBetween(centerOfRectangle(rect), centerRect);
      if (!closest || distBetween < closest.value) {
        closest = { id, value: distBetween };
      }
    }
  }
  return closest ? [closest] : [];
};
```

#### 2. 单轴线性投影算法 (`linearMove`)

在表格列头重排或看板横向列排序等单维度流式布局中，欧几里得距离容易受到垂直方向偏移的干扰。AFFiNE 设计了 `linearMove(horizontal)` 算法，直接在主运动轴上投影求交：

```typescript
// 引用自: blocksuite/affine/data-view/src/core/utils/wc-dnd/utils/linear-move.ts:19-60
export const linearMove =
  (horizontal: boolean): CollisionDetection =>
  ({ active, collisionRect, droppableRects, droppableContainers }) => {
    let target: Target | undefined;
    const activeCenter = centerOfRectangle(active.rect);
    for (const droppableContainer of droppableContainers) {
      const { id } = droppableContainer;
      const rect = droppableRects.get(id);
      const center = rect && centerOfRectangle(rect);
      if (!center || id === active?.id) continue;

      if (horizontal) {
        // 向左移动碰撞：当前碰撞盒左边缘跨过目标中心
        if (center.x < activeCenter.x && collisionRect.left < center.x) {
          const diff = center.x - collisionRect.left;
          if (!target || diff < target.value) target = { id, value: diff };
        }
        // 向右移动碰撞：当前碰撞盒右边缘跨过目标中心
        if (center.x > activeCenter.x && collisionRect.right > center.x) {
          const diff = collisionRect.right - center.x;
          if (!target || diff < target.value) target = { id, value: diff };
        }
      } else {
        // 垂直方向同理检测 top / bottom 边界穿透
        // ...
      }
    }
    return target ? [target] : [];
  };
```

---

### 3.4 树形导航节点悬停 1000ms 自动展开与自拖拽排他机制

在侧边栏文件夹或树形文档树（`NavigationPanelTreeNode`）中，AFFiNE 实现了一种人性化的“悬停自动展开”与“自拖拽防递归”机制：

```typescript
// 引用自: packages/frontend/core/src/desktop/components/navigation-panel/tree/node.tsx:302-322
useEffect(() => {
  if (
    draggedOver &&
    treeInstruction?.type === 'make-child' &&
    !isSelfDraggedOver
  ) {
    if (!collapsible) return;
    // 悬停 1000ms 自动展开折叠文件夹，允许用户深入子树投放
    const timeout = setTimeout(() => {
      setCollapsed(false);
    }, 1000);
    return () => clearTimeout(timeout);
  }
  return;
}, [
  collapsible,
  draggedOver,
  isSelfDraggedOver,
  setCollapsed,
  treeInstruction?.type,
]);
```

同时，通过 `cid` 标记和 `isSelfDraggedOver`，严格禁止父节点落入自身或自身子孙节点中，并在落入自身时自动隐藏指示线，避免非法递归死循环与界面错乱。

---

## 四、16~32ms 拖影阻断：拖拽与缩放期间的动效冻结机制 (Transition Freezing)

### 4.1 核心痛点：CSS Transition 与 60fps 实时光标跟踪的天然冲突

现代前端最常见的交互硬伤之一，是在开启了 CSS 平滑过度（如 `transition: all 0.3s cubic-bezier(...)`）的面板上进行**鼠标拖拽或实时尺寸缩放**。

当用户以 60Hz/120Hz 高刷新率快速拖拽光标时：

1. 鼠标坐标在每帧（约 8.3ms~16.6ms）都会触发事件并更新 DOM 宽度/位置；
2. 如果此时 DOM 节点上依然挂载着 `0.3s` 的 Transition，浏览器将强制对每一帧的新坐标开启一段长达 300ms 的缓动补间动画；
3. **结果**：DOM 尺寸永远滞后于光标实际位置 16~32ms 以上，产生严重的**视觉迟滞（Lagging）、橡皮筋回弹拖影（Rubber-banding）与指针脱轨**。

AFFiNE 在工程层面贯彻了极其严格的 **Transition Freezing（动效冻结）铁律**：**一旦进入拖拽（Dragging）或调整尺寸（Resizing）状态，所有关联容器的 CSS Transition 必须在 0 毫秒内瞬间剥离归零！**

---

### 4.2 动效冻结的三维落地实践

#### 1. 顶栏 AppTabsHeader 的动效冻结

在 `app-tabs-header.tsx` 中，左侧侧边栏折叠/展开本应具备 `transition: 'all 0.3s'` 的柔和过渡，但在侧边栏处于拖拽调宽期间，Transition 被动态切断为 `'none'`：

```typescript
// 引用自: packages/frontend/core/src/modules/app-tabs-header/views/app-tabs-header.tsx:503-510
<div
  style={{
    transition: sidebarResizing ? 'none' : undefined, // 核心冻结：调宽期间杜绝一切补间延迟
    paddingLeft: 12 + trafficLightOffset,
    width: sidebarOpen ? sidebarWidth : 120 + trafficLightOffset,
    marginRight: sidebarOpen ? -16 : 0,
  }}
  className={styles.headerLeft}
>
```

#### 2. 分屏面板 SplitViewPanel 的动效冻结

在分屏布局 `split-view.css.ts` 中，面板宽度默认具备平滑过渡，但在 `data-is-resizing="true"` 时强制 `transition: none`：

```css
/* 引用自: packages/frontend/core/src/modules/workbench/view/split-view/split-view.css.ts:40-42 */
selectors: {
  '[data-is-resizing="true"]&': {
    transition: 'none', /* 彻底冻结！实现 1:1 光标像素级贴合 */
  },
  '[data-is-reordering="true"]&': {
    flexGrow: 1,
  },
}
```

#### 3. 折叠面板 ResizePanel 的布尔控制通道

在 `resize-panel.tsx` 中，AFFiNE 将动画启用状态与 Resizing 状态直接取反关联：

```typescript
// 引用自: packages/frontend/component/src/components/resize-panel/resize-panel.tsx:221
data-enable-animation={enableAnimation && !resizing}
```

```css
/* 引用自: packages/frontend/component/src/components/resize-panel/resize-panel.css.ts:39-41 */
'&[data-enable-animation="true"]': {
  transition: `margin-left ${animationTimeout}, margin-right ${animationTimeout}, transform ${animationTimeout}, background ${animationTimeout}`,
}
/* 当 data-enable-animation 变为 false 时，无任何 transition 属性，实现瞬间冻结 */
```

---

### 4.3 零开销订阅：懒加载 Getter 属性劫持与 React 渲染隔离

在 React 中实现 DND 时，最容易导致掉帧的原因是：拖拽过程中每一次 `onDrag` 事件触发 `setDraggingPosition`，都会导致包裹了该 Hook 的所有组件全部以 60fps 的频率全量 Re-render。

AFFiNE 在 `packages/frontend/component/src/ui/dnd/draggable.ts` 中创造性地运用了 **JavaScript Getter 属性劫持与懒订阅机制（Lazy Getters）**：

```typescript
// 引用自: packages/frontend/component/src/ui/dnd/draggable.ts:67-71
const enableCustomDragPreview = useRef(false);
const enableDraggingPosition = useRef(false);
const enableDropTarget = useRef(false);
const enableDragging = useRef(false);
```

```typescript
// 引用自: packages/frontend/component/src/ui/dnd/draggable.ts:167-182
onDrag: args => {
  // 核心：仅当调用者显式读取过 draggingPosition 时，才触发 React setState
  if (enableDraggingPosition.current) {
    setDraggingPosition(prev => ({
      offsetX: args.location.current.input.clientX - args.location.initial.input.clientX,
      offsetY: args.location.current.input.clientY - args.location.initial.input.clientY,
      clientX: args.location.current.input.clientX,
      clientY: args.location.current.input.clientY,
      outWindow: prev.outWindow,
    }));
  }
  options.onDrag?.(args);
},
```

```typescript
// 引用自: packages/frontend/component/src/ui/dnd/draggable.ts:270-289
return {
  get dragging() {
    enableDragging.current = true; // 动态激活订阅
    return dragging;
  },
  get draggingPosition() {
    enableDraggingPosition.current = true; // 动态激活订阅
    return draggingPosition;
  },
  get CustomDragPreview() {
    enableCustomDragPreview.current = true;
    return customDragPreviewPortal;
  },
  get dropTarget() {
    enableDropTarget.current = true;
    return dropTarget;
  },
  dragRef,
  dragHandleRef,
};
```

这种设计的精妙之处在于：**对于 90% 仅需要挂载拖拽引用而不需要实时追踪像素坐标的普通卡片组件，拖拽过程中的所有鼠标移动事件都不会触发任何一次 React 组件重渲染！** 整个 React 渲染树在拖拽期间保持绝对静默，所有动画与位移均下沉到浏览器原生图层与 Web Component Signals 中执行。

---

## 五、虚拟克隆与轻量级快照：BlockSuite 拖拽预览沙箱

### 5.1 复杂富文本与画布节点的拖拽重绘挑战

在富文本编辑器与白板画布中，一个正在被拖拽的 Block 节点可能包含海量子节点、富文本格式、嵌套数据库（Database Table）或高分辨率图片。如果直接使用浏览器的原生 `setDragImage(node)`，会因为克隆整个深层 DOM 树而引发严重的垃圾回收（GC）暂停与首帧掉帧。

AFFiNE 在 `blocksuite/affine/widgets/drag-handle/src/helpers/preview-helper.ts` 中构建了一套独立的**轻量级虚拟预览沙箱（Preview Sandbox）**。

---

### 5.2 `PreviewHelper` 的 Query 隔离沙箱与占位符降级

`PreviewHelper` 通过在内存中创建隔离的 `BlockStdScope`，并利用 `@blocksuite/store` 的 **Query Filter** 与 **Extension DI Override** 实现了极致的虚拟克隆：

1. **祖先穿透（Bypass Ancestors）**：被拖拽节点的各级祖先仅作为虚拟容器存在，标记为 `bypass`，不渲染复杂装饰外框；
2. **重型组件占位符降级**：
   - 复杂数据库表格（`affine:database`）自动降级替换为极简骨架预览 `<affine-dnd-preview-database>`；
   - 图片与画板素材（`affine:image`）自动降级替换为占位图 `<affine-placeholder-preview-image>`；
3. **冻结后台更新**：设置 `edgelessDisableScheduleUpdate: true`，彻底阻断白板画布在拖拽期间的后台调度开销。

```typescript
// 引用自: blocksuite/affine/widgets/drag-handle/src/helpers/preview-helper.ts:63-128
getPreviewStd = (blockIds: string[]) => {
  const widget = this.widget;
  const std = widget.std;
  blockIds = blockIds.slice();

  const query = this._calculateQuery(blockIds);
  const store = widget.store.doc.getStore({ query });
  let previewSpec = widget.std
    .get(ViewExtensionManagerIdentifier)
    .get('preview-page');
  const settingSignal = signal({ ...editorSetting.setting$.peek() });

  // 依赖注入重写：将重型组件替换为轻量占位符
  const extensions = [
    DocModeExtension(docModeService),
    EditorSettingExtension({ setting$: settingSignal }),
    {
      setup(di) {
        di.override(
          BlockViewIdentifier('affine:database'),
          () => literal`affine-dnd-preview-database`
        );
        di.override(
          BlockViewIdentifier('affine:image'),
          () => (model: BlockModel) => literal`affine-placeholder-preview-image`
        );
      },
    } as ExtensionType,
  ];

  previewSpec = previewSpec.concat(extensions);
  settingSignal.value = {
    ...settingSignal.value,
    edgelessDisableScheduleUpdate: true, // 冻结后台调度
  };

  const previewStd = new BlockStdScope({
    store,
    extensions: previewSpec,
  });

  return { previewStd, width, height };
};
```

---

### 5.3 跨文档与白板画布的数据映射流转

在 `drag-event-watcher.ts` 中，BlockSuite 支持了极具想象力的跨形态拖拽流转：

- **从页面到白板（Page to Edgeless）**：富文本段落拖入白板时，自动计算模型坐标空间（`viewport.toModelCoordFromClientCoord`），并自动包裹在独立的便签卡片（`affine:note`）中；
- **从白板到页面（Edgeless to Page）**：白板图形元素拖入页面时，自动转换为内联画板引用块（`affine:surface-ref`）或关联文档卡片（`affine:embed-linked-doc`）；
- **拖拽期间原节点透明度衰减**：通过 `_setOpacityOfDraggedBlocks` 将原节点透明度调整为 `0.7`，并在拖拽完成或取消后通过统一清理队列执行无损还原。

---

## 六、架构总览与设计美学沉思

### 6.1 模块依赖关系与数据流架构图

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                AFFiNE DND & Animation Architecture                          │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  [ React Workbench Layer ]                                                                  │
│    ├── useDraggable()  ─────────► Lazy Subscriptions (enableDraggingPosition Ref Guard)      │
│    ├── useDropTarget() ─────────► Tree Instruction State Machine & ClosestEdge Detection    │
│    ├── AppTabsHeader   ─────────► 2px Indicator Line (Subpixel -5px/-9px Alignment)         │
│    ├── SplitView       ─────────► 1s Delayed Keyframe Morphing (3px Line -> 100% DropZone)  │
│    └── ResizePanel     ─────────► Transition Freezing (!resizing -> transition: none)       │
│                                                                                             │
│  ─────────────────────────────────────── IPC / DOM ───────────────────────────────────────  │
│                                                                                             │
│  [ BlockSuite Data-View & Canvas Layer ]                                                    │
│    ├── DndContext      ─────────► Preact Signals Reactive Graph + AutoScroll Engine         │
│    ├── SortContext     ─────────► FLIP Displacement (translate3d + Math.round Subpixel Fix) │
│    ├── SortingStrategy ─────────► Horizontal/Vertical Gap Compensation (getItemGap)         │
│    ├── Collision       ─────────► Euclidean ClosestCenter + 1D LinearMove Projection         │
│    ├── KanbanView      ─────────► Card Pick Tilt (-3deg) + 3px Cyan Laser Glow Preview       │
│    └── PreviewHelper   ─────────► Isolated Sub-Store Query Sandbox + Lightweight Mock DIs   │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.2 “无感”（Imperceptible）的流畅哲学与工程启示

通过对 AFFiNE 拖拽重排与动效系统源码的深入解构，我们可以提炼出以下四条超越常规前端项目的顶级工程美学准则：

#### 1. 动效的本质是“功能性预期”，而非“视觉炫技”

AFFiNE 的 2px 指示线、8px 端点圆环与 1 秒延时 Morphing DropZone，没有一处是多余的装饰。每一处微动效都在精确传递界面的拓扑结构变更信息（层级、父子、前后、分屏）。

#### 2. 流畅感源于对浏览器渲染管线的绝对掌控

- **FLIP 与 Translate3d**：绕过主线程布局回流（Reflow），完全在 Compositor 合成图层中完成矩阵平移；
- **Transition Freezing**：在实时交互开始的瞬间无情斩断 CSS 补间，彻底消除 16~32ms 的动作延迟；
- **Lazy Getters**：通过属性劫持，让无需关心像素坐标的 React 组件在拖拽全程保持 0 次重渲染。

#### 3. 跨框架与跨生态的有机融合

在同一个应用中，外层的 React + Vanilla-Extract 与内层的 Lit Web Components + Preact Signals 各展所长，通过明确的 DOM dataset 协议（`data-wc-dnd-draggable-id`、`data-affine-draggable`）与事件委托机制无缝咬合，证明了现代前端大型架构可以打破框架壁垒，实现性能与可维护性的统一。

#### 4. 对细节的极致像素强迫症

从 `-3deg` 的卡片提拉倾角，到 `0px 0px 8px rgba(30,150,235,0.35)` 的发光投影，再到 `Math.round()` 对亚像素抖动的消除，AFFiNE 用一行行严谨优雅的源码，向现代协同软件界树立了关于“何为真正极致流畅的用户体验”的教科书级标杆。
