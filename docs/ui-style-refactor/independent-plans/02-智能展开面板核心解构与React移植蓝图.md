# 智能展开面板核心架构深度解构与 React 化移植蓝图
> 独立架构设计报告 · Agent 2
> 资产解构对象：`reference/展开面板设计.html`、`reference/smart-expandable-panel/`
> 落地目标架构：`apps/crish-desktop/src/components/ui/SmartPanel/`

---

## 1. 架构总览与核心设计哲学

`SmartExpandablePanel` 是一款对标 **Raycast / Linear / Apple macOS** 业界顶级操作体验的通用上下文浮层与操作面板基座。在深度解构 `reference/展开面板设计.html` 与 `reference/smart-expandable-panel/` 完整代码实现、Token 体系与数学物理引擎后，我们提炼出其四大核心设计基石：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SmartExpandablePanel 核心架构体系                     │
├────────────────────────────────┬────────────────────────────────────────┤
│  1. 纯数据驱动 (Data-Driven)    │  JSON Schema 一元化契约，脱离手写 DOM 模板 │
├────────────────────────────────┼────────────────────────────────────────┤
│  2. 数学同心曲率 (Concentric)  │  R_inner = R_outer - Padding，发丝实体边框 │
├────────────────────────────────┼────────────────────────────────────────┤
│  3. 零抖动原地展开 (Zero-Jitter)│  CSS Grid 0fr->1fr + 锚点位移防抖补偿      │
├────────────────────────────────┼────────────────────────────────────────┤
│  4. Raycast 级交互引擎 (Engine)│  Safe-Aim 虚拟多边形碰撞 + ARIA 全键盘漫游 │
└────────────────────────────────┴────────────────────────────────────────┘
```

本蓝图详细解构其底层算法与几何模型，并提供完全契合 Conex / Crish 前端架构规范（严格 UI 原子层、React 19、CSS Modules、Design Tokens、LayerStack 拓扑）的生产级移植方案。

---

## 2. 核心架构与底层算法深度解构

### 2.1 几何与视觉曲率系统 (Concentric Curvature & Visual Hierarchy)

#### 2.1.1 数学同心圆角方程 (Concentric Curvature Equation)
传统 UI 组件常见内外圆角割裂（例如外框 12px、内部条目 4px，导致四角留白厚度不均，产生视觉“挤压感”）。本面板严格遵循**欧几里得几何同心圆角法则**与**感知幂律**：

$$R_{\text{inner}} = \max\left(R_{\text{outer}} - \text{Padding},\ 6\text{px}\right)$$

$$R(H) = \text{round}\left(k \cdot \sqrt{H}\right) \quad (k \approx 1.15)$$

在面板内部建立起 6 级严格嵌套的圆角阶梯：

| 层级 | 视觉实体 | Token / 计算公式 | 默认值 (标准档) | 几何/光学意义 |
| :--- | :--- | :--- | :--- | :--- |
| **L1** | Master Panel 外壳 | `--sep-radius-outer` | `14px` | 面板主外轮廓 |
| **L2** | Inset Padding 槽位 | `--sep-padding` | `6px` | 外壳与内容区间距 |
| **L3** | 条目行 / 内部容器 | `--sep-radius-inner` = $L_1 - L_2$ | `8px` | 100% 同心贴合外角 |
| **L4** | 操作按钮 (H: 22px) | `--sep-btn-radius` = $\text{round}(1.15 \cdot \sqrt{22})$ | `6px` | 搜索栏右侧内嵌按钮 |
| **L5** | 状态标签/徽章 (H: 16px)| `--sep-badge-radius` | `4px` | 辅助 Badge 胶囊 |
| **L6** | 状态 Pills | `--sep-pill-radius` | `9999px` | 绝对半圆圆弧胶囊 |

```
 ┌─────────────────────────────────────────────────────────────┐  ▲ R_outer = 14px
 │  Padding = 6px                                              │  │
 │   ┌─────────────────────────────────────────────────────┐   │  │
 │   │  Item Row                                           │   │  │
 │   │  R_inner = 14px - 6px = 8px                         │   │  ▼ R_inner = 8px
 │   └─────────────────────────────────────────────────────┘   │
 │   ┌─────────────────────────────────────────────────────┐   │
 │   │  Selectable Row                                     │   │
 │   └─────────────────────────────────────────────────────┘   │
 └─────────────────────────────────────────────────────────────┘
```

#### 2.1.2 纯色实体发丝边框工程 (Solid Crisp Hairline Border)
去除了传统基于半透明多层投影模拟边框所带来的“发虚、边缘泥泞”问题，采用物理 1px 纯色实体边框，并在明暗主题中进行校准：
- **浅色模式 (Light Theme)**：`--sep-border-color: #e2dfd9`
  - 配方特征：严格校准 10% CMYK Yellow 暖调底色，0% Blue，消除了冷灰色在暖白底板上的突兀感。
- **深色模式 (Dark Theme)**：`--sep-border-color: #2b2926`
  - 配方特征：中性微暖炭黑墨阶，与深色底板 `--sep-bg-panel-solid: #181715` 形成 1.2:1 的极柔和物理微边界。
- **悬停与聚焦微动**：
  - Hover 态：`#c9c5bc` (Light) / `#3d3a35` (Dark)
  - Focus 态：`#b2ada2` (Light) / `#524e47` (Dark)

#### 2.1.3 多层柔和漫反射环境光影 (Diffuse Multi-Layer Ambient Depth)
采用 4 层复合投影系统，自远及近模拟物理环境光照与接触阴影，顶部嵌入 1px 镜面微高光（Specular Highlight）：

```css
/* Light Theme 投影系统 */
--sep-shadow:
  0 20px 48px -10px rgba(29, 28, 26, 0.09),  /* 远景大范围漫反射衰减 */
  0 6px 20px -3px rgba(29, 28, 26, 0.03),   /* 中景空间悬浮感 */
  0 2px 6px 0 rgba(29, 28, 26, 0.015),      /* 近景接触阴影（防止边缘漂浮） */
  inset 0 1px 0 rgba(255, 255, 255, 0.95);  /* 顶部 1px 物理倒角镜面高光 */

/* Dark Theme 投影系统 */
--sep-shadow:
  0 24px 54px -10px rgba(0, 0, 0, 0.70),    /* 深度遮蔽暗场 */
  0 8px 24px -4px rgba(0, 0, 0, 0.45),      /* 中景悬浮 */
  0 2px 8px 0 rgba(0, 0, 0, 0.30),          /* 近景轮廓 */
  inset 0 1px 0 rgba(255, 255, 255, 0.08);  /* 顶部微弱透光边缘 */
```

#### 2.1.4 磨砂玻璃材质渲染 (Backdrop Filter Material)
面板容器应用 `backdrop-filter: blur(28px) saturate(160%)`，使底板下方内容在毛玻璃模糊化的同时提升 60% 色彩饱和度，呈现 macOS Sequoia / iOS 级别的通透晶莹质感。在低功耗模式或性能降级场景（Eco Tier），自动降级为实体色底板 `--sep-bg-panel-solid`。

---

### 2.2 零抖动动画引擎与原地折叠算法 (Zero-Jitter Animation & Accordion Engine)

#### 2.2.1 CSS Grid 0fr -> 1fr 纯 CSS 自然高度平滑展开
传统折叠面板（Accordion）使用 `max-height: 0 -> 500px` 存在致命缺陷：动画时间根据写死的 `max-height` 均分，展开时有明显延迟感，收起时则出现跳帧。
本方案采用**现代 CSS Grid 动态轨道动画算法**：

```css
.sep-collapsible-content {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s cubic-bezier(0.22, 1.25, 0.36, 1);
  overflow: hidden;
  box-sizing: border-box;
}

.sep-collapsible-content.sep-expanded {
  grid-template-rows: 1fr;
}

.sep-collapsible-inner {
  min-height: 0; /* 关键：允许网格内容收缩到 0 */
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap);
  box-sizing: border-box;
}
```
**原理**：浏览器将 `0fr`（占据 0 比例）插值到 `1fr`（自然包裹内容高度），无需任何 JS 计算 DOM `scrollHeight`，彻底实现 GPU 加速的零抖动、零延迟物理展开。

#### 2.2.2 微动弹簧缓动曲线体系
全组件摒弃生硬的 `ease` / `linear`，采用经过物理校准的非对称阻尼弹簧曲线：

```css
/* 展开与入场：微过冲阻尼弹簧（Subtle Spring，产生轻微吸附质感） */
--sep-ease-spring: cubic-bezier(0.22, 1.25, 0.36, 1);

/* 收起与出场：快速收敛阻尼（Shrink Ease，快速干脆退出，杜绝拖泥带水） */
--sep-ease-shrink: cubic-bezier(0.4, 0, 1, 1);

--sep-duration-open: 0.22s;
--sep-duration-close: 0.15s;
```

#### 2.2.3 锚点稳定化防抖补偿算法 (Anchor-Stabilized Repositioning)
当面板在屏幕下方或狭窄空间向上（Flip-Up）展开时，展开内部折叠项会导致整个面板顶部向上延伸。若鼠标保持静止，面板位置变动会导致当前点击的触发项被推离鼠标下方，产生严重的“鼠标漂移”跳动。

**解决方案**：在折叠项切换时执行几何锚点补偿：

```typescript
function handleAccordionToggle(triggerEl: HTMLElement, containerEl: HTMLElement) {
  // 1. 记录切换前触发项在屏幕上的绝对 Top 坐标
  const beforeRect = triggerEl.getBoundingClientRect();

  // 2. 执行状态切换与 DOM 变动
  // ... DOM update ...

  // 3. 计算位移差并逆向补偿容器 top
  requestAnimationFrame(() => {
    const afterRect = triggerEl.getBoundingClientRect();
    const deltaY = afterRect.top - beforeRect.top;
    if (Math.abs(deltaY) > 0.5) {
      const currentTop = parseFloat(containerEl.style.top) || 0;
      containerEl.style.top = `${currentTop - deltaY}px`;
    }
  });
}
```

#### 2.2.4 动态高度解算与 32px 滞后防抖 (Hysteresis & Pruned Natural Height)
在视口边缘，浮层常常因为“向下放不下 -> 翻转到上方 -> 上方高度变动 -> 又翻回下方”而产生 60Hz 剧烈抽搐（Flapping）。

**解法**：`PositionEngine` 引入 **32px 滞后量（Hysteresis Buffer）**：
```typescript
let preferredDirY = idealDirY;
if (this.currentDirY && this.currentDirY !== idealDirY) {
  const currentSpace = this.currentDirY === 'down' ? spaceBelow : spaceAbove;
  const idealSpace = idealDirY === 'down' ? spaceBelow : spaceAbove;

  // 仅当新方向提供的可用空间超出当前方向达 32px 阈值以上时，才允许方向翻转！
  if (idealSpace - currentSpace > this.HYSTERESIS_Y) {
    preferredDirY = idealDirY;
  } else {
    preferredDirY = this.currentDirY;
  }
}
this.currentDirY = preferredDirY;
```

---

### 2.3 极致交互引擎与上下文控制 (Interaction Engine & Context Control)

#### 2.3.1 极简紧凑搜索栏体系 (Minimalist Tactile Search Header)
- **规格**：严格 `28px` 高度（与菜单条目严格等高对齐），`0` 臃肿外边框，与面板背景融为一体。
- **左侧槽位**：`15px × 15px` 矢量搜索图标，淡灰柔和色彩，focus 时微亮。
- **中间槽位**：原生 Input，`font-size: 12.5px`，支持自动聚焦、实时过滤与拼音/关键词匹配。
- **右侧 Action 槽位**：
  1. `search-clear-btn`：有输入内容时淡入，支持一键清空并重获焦点。
  2. `search-filter-btn`：支持内嵌二级过滤菜单或弹层切换。

```
┌───────────────────────────────────────────────────────────┐
│ [🔍]  搜索模型或功能...                 [(X)] [⚙️ 过滤]   │  H: 28px
└───────────────────────────────────────────────────────────┘
```

#### 2.3.2 Raycast 级全键盘无障碍漫游 (WAI-ARIA Keyboard Navigation)
完全支持脱离鼠标的极速全键盘操作流，对标 Raycast / Linear：

```
       [ ↑ / ↓ ]           [ → / Enter ]            [ ← / Esc ]
   在同级条目间循环漫游  ───►  进入二级级联子菜单  ───►  返回上一级父菜单
 (跳过 divider/disabled)      或执行当前操作            或关闭面板
```

- `↑` / `↓`：在当前作用域（Main 或 Submenu）内的所有可见、非禁用条目间循环聚焦，自动调用 `scrollIntoView({ block: 'nearest' })` 确保焦点始终可见。
- `Enter` / `Space`：触发当前聚焦项（在搜索框中允许 Space 输入，在菜单项中执行选择）。
- `→`（Right Arrow）：若当前聚焦项具有子菜单（`hasCascade`），自动展开二级子菜单并将键盘焦点转移至子菜单第一项。
- `←`（Left Arrow）：若当前处于二级/多级子菜单中，关闭当前层级并将焦点无缝归还至父级触发条目。
- `Esc`：子菜单中按 Esc 仅退出当前子菜单；主菜单中按 Esc 关闭整个面板并归还焦点给宿主触发器。

#### 2.3.3 Safe-Aim 零 Canvas 虚拟 SVG 碰撞多边形算法
**痛点**：当用户将鼠标从父菜单项**斜向划向**右侧打开的二级子菜单时，鼠标轨迹必然会经过下方其他菜单项。若没有保护区，鼠标划过邻近项会立刻触发该项的 hover，导致子菜单在半路突然消失，极大伤害操作流畅度。

```
           Parent Item (A)
         ┌──────────────────┐
         │ 选项 1            │
Cursor ─►│ 级联选项 2 ──────┼──────────────┐  Safe-Aim Triangle
 (P)     ├──────────────────┤ \            │  (鼠标斜向划入子菜单安全区)
         │ 选项 3 (邻近项)   │   \          │
         └──────────────────┘     \ ┌──────┴─────────────┐
                                    │ 子菜单选项 2-1     │
                                    │ 子菜单选项 2-2     │ (Submenu)
                                    └────────────────────┘
```

**算法实现**：
1. **零 Canvas 消耗**：在 `document.body` 挂载单例虚拟 SVG Overlay（`#sepSafeAimOverlay`），使用 `<polygon>` 元素，`pointer-events: none`。
2. **多边形构造**：记录鼠标前 4 帧历史位置 $P(x, y)$，取子菜单边界的两端顶点 $A(x_1, y_1)$ 与 $B(x_2, y_2)$，动态形成安全三角形 $\Delta PAB$。
3. **重心坐标判定 (Barycentric Coordinates)**：在 $O(1)$ 时间复杂度内计算鼠标是否落在保护三角形内：

$$\vec{v}_0 = C - A, \quad \vec{v}_1 = B - A, \quad \vec{v}_2 = P - A$$

$$u = \frac{(\vec{v}_1 \cdot \vec{v}_1)(\vec{v}_2 \cdot \vec{v}_0) - (\vec{v}_1 \cdot \vec{v}_0)(\vec{v}_2 \cdot \vec{v}_1)}{\text{denom}}, \quad v = \frac{(\vec{v}_0 \cdot \vec{v}_0)(\vec{v}_2 \cdot \vec{v}_1) - (\vec{v}_0 \cdot \vec{v}_1)(\vec{v}_2 \cdot \vec{v}_0)}{\text{denom}}$$

当 $u \ge 0, v \ge 0, u + v \le 1$ 时，判定鼠标处于保护区，忽略下方条目的 Hover 事件，确保斜向滑动手势 100% 丝滑。

#### 2.3.4 双层独立滚动与内嵌列表隔离 (Nested Scroll Containment)
- 内部多选列表（如模型列表）限制 `max-height: 160px`，具备独立发丝滚动条。
- 外层主面板设置 `overscroll-behavior: contain`。
- 在 JS 层精准拦截 `wheel` 事件，当内部列表滚动到顶部/底部边缘时，阻止事件链向宿主页面冒泡，杜绝页面连带滚动。

---

## 3. React + CSS Modules 移植落地蓝图

### 3.1 组件分层与目录结构规划

将参考组件完整重构并落位于 `apps/crish-desktop/src/components/ui/SmartPanel/`，严格遵守 UI 原子层禁令（**严禁依赖 store、hooks、api 或业务组件**）：

```
apps/crish-desktop/src/components/ui/SmartPanel/
├── SmartPanel.tsx                 # 核心 React 组件入口 (主面板与 Portal 挂载)
├── SmartPanel.module.css          # 面板核心 CSS Modules (同心圆角、光影、动画)
├── SmartPanelItem.tsx             # 单条目渲染 (普通项/多选项/折叠项/子菜单触发)
├── SmartPanelItem.module.css      # 条目槽位布局与高亮样式
├── SmartPanelGroup.tsx            # 分组容器与可选列表内嵌容器
├── SmartPanelSearch.tsx           # 嵌入式 28px 紧凑搜索栏
├── SmartPanelSearch.module.css    # 搜索栏独立样式
├── SmartPanelSubmenu.tsx          # 级联二级/多级浮层子菜单
├── types.ts                       # 严格 TypeScript 类型契约 (Schema 定义)
├── useSmartPanel.ts               # React Hook (触发器绑定、状态管理、坐标控制)
├── useSmartPanelPosition.ts       # 智能视口碰撞与边界解算 Hook
├── useSmartPanelKeyboard.ts       # ARIA 全键盘漫游管理 Hook
├── index.ts                       # 统一 Barrel 导出
└── __tests__/
    ├── SmartPanel.test.tsx        # 单元与快照测试
    ├── SafeAimEngine.test.ts      # 几何碰撞算法断言
    └── KeyboardNavigation.test.ts # 键盘漫游状态机测试
```

---

### 3.2 严格 TypeScript 类型契约 Schema (`types.ts`)

```typescript
import type { ReactNode, MouseEvent, KeyboardEvent, CSSProperties, RefObject } from 'react';

/** 菜单条目类型枚举 */
export type SmartMenuItemType =
  | 'item'         // 标准可执行操作项
  | 'selectable'   // 带勾选框的多选项
  | 'group'        // 分组标头
  | 'sub-group'    // 次级分组标头
  | 'divider'      // 分割线
  | 'collapsible'  // 原地可折叠手风琴项
  | 'submenu'      // 级联子菜单
  | 'custom';      // 自定义渲染插槽

/** 单条菜单项数据契约 */
export interface SmartMenuItem {
  /** 唯一标识符 */
  id: string;
  /** 节点类型，缺省为 'item' */
  type?: SmartMenuItemType;
  /** 主标题文本 */
  label?: string;
  /** 次级说明文本 (浅灰辅助) */
  sublabel?: string;
  /** 左侧图标：支持 SVG ReactNode 或字符串 */
  icon?: ReactNode;
  /** 右侧快捷键提示 (如 "Ctrl+N", "⌘K") */
  shortcut?: string;
  /** 右侧徽章状态胶囊 (如 "推荐", "CDP 9222") */
  badge?: string;
  /** 悬停提示气泡文本 (Tooltip) */
  tooltip?: string;
  /** 危险警示操作 (红色高亮，如 "删除", "重置") */
  danger?: boolean;
  /** 是否禁用 (不可点击，键盘漫游自动跳过) */
  disabled?: boolean;
  /** 多选选中状态 (仅 type='selectable' 或定义了 selected 时生效) */
  selected?: boolean;
  /** 折叠展开状态 (仅 type='collapsible' 时生效) */
  expanded?: boolean;
  /** 搜索匹配增强关键词 (支持拼音、别名等) */
  searchKeywords?: string[];
  /** 级联子菜单或折叠子项列表 */
  children?: SmartMenuItem[];
  /** 点击选择回调 */
  onSelect?: (item: SmartMenuItem, event?: MouseEvent | KeyboardEvent) => void;
  /** 折叠状态切换回调 */
  onToggle?: (expanded: boolean, item: SmartMenuItem) => void;
  /** 自定义渲染钩子 */
  render?: (item: SmartMenuItem, isFocused: boolean) => ReactNode;
}

/** 分组契约 */
export interface SmartMenuGroup {
  id?: string;
  title?: string;
  /** 是否为内嵌独立滚动列表 (如 5-6 个模型的滚动区) */
  isSelectableList?: boolean;
  items: SmartMenuItem[];
}

/** 坐标点定义 */
export interface Point2D {
  x: number;
  y: number;
}

/** 智能面板组件 Props */
export interface SmartPanelProps {
  /** 菜单项列表：支持 MenuItem 与 MenuGroup 混合传入 */
  items: Array<SmartMenuItem | SmartMenuGroup>;
  /** 是否打开 (受控模式) */
  open?: boolean;
  /** 打开状态变动回调 */
  onOpenChange?: (open: boolean) => void;
  /** 触发器元素 Ref 锚点 (组件自动定位在此元素周边) */
  triggerRef?: RefObject<HTMLElement | null>;
  /** 绝对坐标锚点 (如右键菜单坐标) */
  point?: Point2D | null;
  /** 搜索框占位提示文本 */
  searchPlaceholder?: string;
  /** 是否启用嵌入式搜索栏，默认 true */
  enableSearch?: boolean;
  /** 是否启用分组分割线，默认 true */
  enableDivider?: boolean;
  /** 是否启用 Safe-Aim 防误触多边形保护，默认 true */
  enableTriangleAim?: boolean;
  /** 面板最大高度限制，默认 760px */
  maxPanelHeight?: number;
  /** 面板最小宽度，默认 250px */
  minWidth?: number;
  /** 面板最大宽度，默认 320px */
  maxWidth?: number;
  /** 是否启用指定容器边界约束 */
  useContainerBoundary?: boolean;
  /** 约束容器元素 Ref */
  containerBoundaryRef?: RefObject<HTMLElement | null>;
  /** 全局选中项回调 */
  onSelect?: (item: SmartMenuItem) => void;
  /** 打开回调 */
  onOpen?: () => void;
  /** 关闭回调 */
  onClose?: () => void;
  /** 自定义类名与样式 */
  className?: string;
  style?: CSSProperties;
  /** 搜索过滤自定义处理器 (可选) */
  customFilter?: (item: SmartMenuItem, query: string) => boolean;
  /** 右侧搜索 Action 按钮自定义渲染 */
  searchActions?: ReactNode;
}
```

---

### 3.3 核心组件与 CSS Modules 实现规范

#### 3.3.1 `SmartPanel.module.css` (高精度 CSS Modules)

```css
/* 容器挂载层 */
.panelContainer {
  position: fixed;
  z-index: var(--z-popover, 500);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: scale(0.92) translateY(-4px);
  transition:
    opacity var(--sep-duration-open, 0.22s) var(--sep-ease-spring, cubic-bezier(0.22, 1.25, 0.36, 1)),
    transform var(--sep-duration-open, 0.22s) var(--sep-ease-spring, cubic-bezier(0.22, 1.25, 0.36, 1)),
    visibility var(--sep-duration-open, 0.22s);
  overscroll-behavior: contain;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

.panelOpen {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: none;
}

.panelCollapsing {
  opacity: 0;
  visibility: visible;
  pointer-events: none;
  transform: scale(0.94) translateY(-3px);
  transition:
    opacity var(--sep-duration-close, 0.15s) var(--sep-ease-shrink, cubic-bezier(0.4, 0, 1, 1)),
    transform var(--sep-duration-close, 0.15s) var(--sep-ease-shrink, cubic-bezier(0.4, 0, 1, 1));
}

/* 主面板实体卡片 */
.panelCard {
  min-width: var(--panel-min-width, 250px);
  max-width: var(--panel-max-width, 320px);
  background: var(--sep-bg-panel, rgba(255, 254, 252, 0.96));
  backdrop-filter: blur(var(--sep-backdrop-blur, 28px)) saturate(160%);
  -webkit-backdrop-filter: blur(var(--sep-backdrop-blur, 28px)) saturate(160%);
  border: 1px solid var(--sep-border-color, #e2dfd9);
  border-radius: var(--sep-radius-outer, 14px);
  padding: var(--sep-padding, 6px);
  box-shadow: var(--sep-shadow);
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap, 2px);
  height: auto;
  box-sizing: border-box;
  font-family: var(--sep-font-sans, var(--font-sans));
  color: var(--sep-text-primary, var(--text-primary));
}

/* 可滚动列表 */
.listContainer {
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap, 2px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
}

/* 发丝滚动条 */
.listContainer::-webkit-scrollbar,
.selectableList::-webkit-scrollbar {
  width: 4px;
}
.listContainer::-webkit-scrollbar-track,
.selectableList::-webkit-scrollbar-track {
  background: transparent;
}
.listContainer::-webkit-scrollbar-thumb,
.selectableList::-webkit-scrollbar-thumb {
  background: var(--sep-border-color, #e2dfd9);
  border-radius: 4px;
}
.listContainer::-webkit-scrollbar-thumb:hover,
.selectableList::-webkit-scrollbar-thumb:hover {
  background: var(--sep-text-muted, #8b8780);
}

/* 硬件对齐 1px 发丝分割线 */
.divider {
  height: 0;
  min-height: 0;
  border: none;
  border-top: 1px solid var(--sep-divider-color, rgba(29, 28, 26, 0.06));
  margin: 3px var(--sep-padding, 6px);
  flex-shrink: 0;
}

.searchDivider {
  margin: 1px 0 2px 0;
}

/* 空搜索状态 */
.emptyState {
  padding: 18px 12px;
  text-align: center;
  font-size: var(--sep-font-size-base, 13px);
  color: var(--sep-text-muted, #8b8780);
}
```

#### 3.3.2 `SmartPanelItem.module.css` (条目与折叠手风琴)

```css
/* 标准条目行 */
.itemRow {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--sep-item-height, 28px);
  min-height: var(--sep-item-height, 28px);
  padding: 0 var(--sep-item-padding-h, 10px);
  border-radius: var(--sep-item-radius, 8px);
  font-size: var(--sep-font-size-base, 13px);
  font-weight: 400;
  color: var(--sep-text-primary, var(--text-primary));
  cursor: pointer;
  background: transparent;
  transition: background-color 0.12s ease, color 0.12s ease;
  flex-shrink: 0;
  box-sizing: border-box;
  outline: none;
}

.itemRow:hover,
.itemParentActive,
.itemKeyboardFocus {
  background-color: var(--sep-bg-item-hover, rgba(29, 28, 26, 0.045));
}

.itemDisabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}

.itemDanger {
  color: var(--sep-danger-color, #ef4444);
}

.itemDanger:hover,
.itemDanger.itemKeyboardFocus {
  background-color: var(--sep-danger-light, rgba(239, 68, 68, 0.08));
}

/* 多选项 */
.selectableSelected {
  background-color: var(--sep-bg-item-selected, rgba(29, 28, 26, 0.065));
}

/* 勾选图标 */
.checkIcon {
  width: 14px;
  height: 14px;
  stroke: var(--sep-accent-color, #10b981);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 0.15s ease, transform 0.15s var(--sep-ease-spring);
  flex-shrink: 0;
}

.selectableSelected .checkIcon {
  opacity: 1;
  transform: scale(1);
}

/* 折叠手风琴网格 */
.collapsibleContent {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s var(--sep-ease-spring);
  overflow: hidden;
  box-sizing: border-box;
}

.collapsibleExpanded {
  grid-template-rows: 1fr;
}

.collapsibleInner {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap, 2px);
  padding-top: 2px;
  box-sizing: border-box;
}

.chevronIcon {
  width: 13px;
  height: 13px;
  stroke: var(--sep-text-secondary, #5c5954);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
  transition: transform 0.2s var(--sep-ease-spring), stroke 0.15s ease;
  transform: rotate(0deg);
  flex-shrink: 0;
}

.chevronExpanded {
  transform: rotate(90deg);
}
```

---

### 3.4 与现有 Design Token (`tokens.css`) 的无缝融合

在 `apps/crish-desktop/src/styles/tokens.css` 中，已经预置了 `--sep-*` 系列 Token。本次移植将其与项目的明暗主题以及高性能分级（Performance Tier）全面打通：

```css
/* ==========================================================================
   Design Token 映射契约 (Light / Dark SSOT)
   ========================================================================== */

/* 1. 浅色模式 (Light Theme) */
html[data-theme='light'],
html[data-theme='default'] {
  --sep-bg-canvas: var(--bg-canvas, #f6f5f3);
  --sep-bg-panel: var(--bg-panel, rgba(255, 254, 252, 0.96));
  --sep-bg-panel-solid: var(--bg-card, #ffffff);
  --sep-bg-item-hover: color-mix(in srgb, var(--text-primary) 4.5%, transparent);
  --sep-bg-item-selected: color-mix(in srgb, var(--text-primary) 6.5%, transparent);
  --sep-bg-input: color-mix(in srgb, var(--text-primary) 3%, transparent);

  --sep-border-color: #e2dfd9;
  --sep-border-hover: #c9c5bc;
  --sep-border-focus: #b2ada2;
  --sep-divider-color: color-mix(in srgb, var(--text-primary) 6%, transparent);

  --sep-text-primary: #1d1c1a;
  --sep-text-secondary: #5c5954;
  --sep-text-muted: #8b8780;

  --sep-accent-color: var(--brand, hsl(160 84% 39%));
  --sep-danger-color: var(--color-error, hsl(0 84% 60%));
}

/* 2. 深色模式 (Dark Theme) */
html[data-theme='dark'] {
  --sep-bg-canvas: #0c0c0b;
  --sep-bg-panel: rgba(24, 23, 21, 0.96);
  --sep-bg-panel-solid: #181715;
  --sep-bg-item-hover: color-mix(in srgb, var(--text-primary) 6%, transparent);
  --sep-bg-item-selected: color-mix(in srgb, var(--text-primary) 9%, transparent);
  --sep-bg-input: color-mix(in srgb, var(--text-primary) 4%, transparent);

  --sep-border-color: #2b2926;
  --sep-border-hover: #3d3a35;
  --sep-border-focus: #524e47;
  --sep-divider-color: rgba(255, 255, 255, 0.07);

  --sep-text-primary: #f5f4f0;
  --sep-text-secondary: #b5b2aa;
  --sep-text-muted: #78756d;

  --sep-accent-color: var(--brand, hsl(160 84% 45%));
}

/* 3. 性能分级降级适配 (Eco Performance Tier) */
html[data-perf-tier='eco'] {
  --sep-backdrop-blur: 0px;
  --sep-bg-panel: var(--sep-bg-panel-solid);
  --sep-duration-open: 0ms;
  --sep-duration-close: 0ms;
}
```

---

## 4. 与 LayerStack 及现有生态的集成机制

### 4.1 全局浮层层级栈 (LayerStackManager) 拓扑集成
在 `crish-desktop` 中，浮层组件必须通过 `useLayerRegistration` 注册到 `LayerStackManager`，以确保全局多层弹窗、抽屉与下拉菜单能够按照正确的层级响应 `Escape` 键逐级关闭与外点击（Dismissal）：

```typescript
// SmartPanel.tsx 内部集成
const panelId = useId();

useLayerRegistration(
  {
    id: panelId,
    type: 'dropdown-menu',
    dismissible: true,
    onDismiss: () => handleClose(),
    onEscapeKeyDown: (event) => {
      // 优先让子菜单拦截处理，若无子菜单则正常销毁当前面板
      if (hasActiveSubmenu) {
        event.preventDefault();
        closeSubmenu();
      }
    },
    elementRef: panelRef,
    anchorRef: triggerRef,
  },
  isOpen
);
```

### 4.2 业务落地场景规划 (Target Business Scenarios)

| 业务场景 | 拟替换/升级目标 | SmartPanel 赋予的体验提升 |
| :--- | :--- | :--- |
| **模型选择面板 (ModelPicker)** | `components/chat/ModelPickerPopover` | 内嵌 28px 搜索 + 模型分类独立滚动 + 勾选状态 + 供应商图标 |
| **命令控制台 (CommandPalette)** | `components/command/CommandPalette` | Raycast 级全键盘无障碍 + 快捷键展示 + 极速拼音/多词倒排索引 |
| **工作区/会话右键菜单 (ContextMenu)** | 散落的原生 `contextmenu` | 支持 `openAtPoint(x, y)` 边界自适应 + 危险操作红色高亮 |
| **高级推理参数面板 (SettingsDrawer)** | 临时配置弹层 | 原地手风琴折叠（Temperature, Top-P, Max Tokens）无抖动展开 |

---

## 5. 实施演进路线图 (Migration Roadmap)

```
┌────────────────────────────────────────────────────────────────────────┐
│  Phase 1: 核心原子落地 (Day 1)                                          │
│  - 在 components/ui/SmartPanel/ 建立完整目录与 TypeScript 契约           │
│  - 移植 PositionEngine, SafeAimEngine 并封装为 useSmartPanel Hooks       │
│  - 编写 SmartPanel.module.css 并通过 npm run check:ui-layer 门禁        │
├────────────────────────────────────────────────────────────────────────┤
│  Phase 2: 单元测试与物理断言 (Day 2)                                      │
│  - 编写 100% 覆盖率的 Jest/Vitest 测试用例                               │
│  - 验证 Safe-Aim 重心坐标算法、同心圆角计算、边界翻转防抖                  │
│  - 验证 WAI-ARIA 全键盘无障碍漫游与 Escape 逐级退出状态机                  │
├────────────────────────────────────────────────────────────────────────┤
│  Phase 3: 业务场景融合与旧组件替换 (Day 3)                                │
│  - 在 ModelPicker 与 TopBar 会话菜单中接入 SmartPanel                   │
│  - 验证在 Light/Dark 与 Windows/macOS 平台下的无缝视觉体验                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 结论

`SmartExpandablePanel` 将极致的**几何数学美感（同心圆角、发丝边框、漫反射光影）**与**硬核交互引擎（CSS Grid 零抖动展开、Safe-Aim 虚拟多边形碰撞、Raycast 级键盘漫游）**融为一体。本方案规划的 React + CSS Modules 落地蓝图完全解耦于业务逻辑，契合 Conex 的现代 UI 原子架构标准，将为整个应用的交互品质带来质的飞跃。
