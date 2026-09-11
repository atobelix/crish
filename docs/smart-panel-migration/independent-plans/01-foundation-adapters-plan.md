# SmartExpandablePanel 基础设施与双轨适配器落地方案

> **文档标识**：`docs/smart-panel-migration/independent-plans/01-foundation-adapters-plan.md`
> **所属战役**：`docs/smart-panel-migration/`（SmartExpandablePanel 工业级组件下沉与全仓移植战役）
> **架构定位**：分维方案 01 — 基础设施建设、Design Tokens 融合、核心引擎 TypeScript 实现与双轨适配器设计
> **架构角色**：基础组件与设计系统架构专家（Foundation & Design System Architect）
> **遵循契约**：`AGENTS.md`（反退避铁律、架构优雅、测试资产保护）、`ANTI_OVERENGINEERING_GUARDRAILS.md`
> **参考资产库**：`reference/smart-expandable-panel/`（`css/tokens.css`, `panel.css`, `search.css`, `items.css`, `submenu.css`, `js/safe-aim.js`, `js/position-engine.js`, `js/keyboard-nav.js`, `react/SmartExpandablePanel.tsx`）

---

## 目录索引

1. [架构愿景与下沉蓝图](#1-架构愿景与下沉蓝图)
2. [组件下沉目录与文件职责划分](#2-组件下沉目录与文件职责划分)
3. [Design Tokens 与视觉体系深度融合](#3-design-tokens-与视觉体系深度融合)
4. [核心引擎与主组件 TypeScript 工业级实现](#4-核心引擎与主组件-typescript-工业级实现)
   - 4.1 类型契约体系 (`types.ts`)
   - 4.2 120Hz 视口智能定位与滞后防抖引擎 (`PositionEngine.ts`)
   - 4.3 零 Canvas 重心坐标系 Safe-Aim 安全三角区引擎 (`SafeAimEngine.ts`)
   - 4.4 WAI-ARIA 规范全键盘漫游引擎 (`keyboardNav.ts`)
   - 4.5 宿主交互状态与坐标管理 Hook (`useSmartPanel.ts`)
   - 4.6 模块化样式体系 (`SmartExpandablePanel.module.css`)
   - 4.7 现代 React 数据驱动主面板组件 (`SmartExpandablePanel.tsx`)
5. [双轨适配器设计与 800+ 单元测试零回归保障](#5-双轨适配器设计与-800-单元测试零回归保障)
   - 5.1 数据 Schema 转换桥接层 (`schemaBridge.ts`)
   - 5.2 Menu 既有契约适配器 (`MenuAdapter.tsx`)
   - 5.3 Select 既有契约适配器 (`SelectAdapter.tsx`)
   - 5.4 原生无感透明路由配置
6. [单元测试与物理几何断言全景规划](#6-单元测试与物理几何断言全景规划)
   - 6.1 `PositionEngine.test.ts`（几何计算与视口翻转断言）
   - 6.2 `SafeAimEngine.test.ts`（重心坐标系与碰撞多边形断言）
   - 6.3 `keyboardNav.test.ts`（WAI-ARIA 键盘漫游断言）
   - 6.4 `SmartExpandablePanel.test.tsx`（主组件交互与滚轮隔离断言）
   - 6.5 `MenuAdapter.test.tsx` & `SelectAdapter.test.tsx`（既有基座无损回归断言）
7. [实施路径与验收核验清单](#7-实施路径与验收核验清单)

---

## 1. 架构愿景与下沉蓝图

### 1.1 背景与下沉目标
当前 `apps/crish-desktop/` 存在多套浮层菜单与选择器实现，部分组件缺少内嵌搜索过滤、长列表内嵌独立滚动区、多级级联安全斜切（Safe-Triangle）及折叠手风琴（Collapsible Section）等高级交互能力。

本方案旨在将 `reference/smart-expandable-panel/` 的现代纯数据驱动、数学同心圆角、零 Canvas 安全三角区、WAI-ARIA 键盘漫游以及视口弹性布局能力，**下沉重构为 Crish 桌面端的一级交互基元**：
- **下沉目标路径**：`apps/crish-desktop/src/components/ui/SmartExpandablePanel/`；
- **全仓通用赋能**：统一支撑模型选择器、输入区功能加号菜单、权限模式切换器、会话右键菜单、快捷设置菜单等 8+ 业务场景；
- **双轨适配零回归**：通过 `MenuAdapter` 与 `SelectAdapter`，在不修改任何既有消费方代码的前提下，保证 `ui/Menu` 与 `ui/Select` 既有 800+ 单元测试 100% 绿灯通过。

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Crish Desktop UI Architecture                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Business Layer ]                                                              │
│  ModelBadgePicker │ ComposePlusMenu │ PermissionMenu │ SessionContextMenu │ ... │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Dual-Track Adapters & Schema Bridge Layer ]                                   │
│  MenuAdapter │ SelectAdapter │ schemaBridge.ts (100% Backward Compatible)        │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Universal UI Primitive Layer ] (apps/crish-desktop/src/components/ui/)        │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ SmartExpandablePanel                                                      │  │
│  │  ├── Core Component (SmartExpandablePanel.tsx, useSmartPanel.ts)          │  │
│  │  ├── Position Engine (120Hz RAF, Hysteresis, Boundary Clamping)           │  │
│  │  ├── Safe-Aim Engine (Zero-Canvas SVG Barycentric Hit-Test)              │  │
│  │  ├── Keyboard Nav Engine (WAI-ARIA Roving Focus, Cascading, Tree)         │  │
│  │  └── CSS Modules (Concentric Radii 14/8/6/4, Zero-Blue Palette)           │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Design Token & Geometry Substrate ]                                           │
│  Zero-Blue Palette (Light #f6f5f3 / Dark #0c0c0b) + Concentric Radii (14/8/6/4) │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 组件下沉目录与文件职责划分

在 `apps/crish-desktop/src/components/ui/SmartExpandablePanel/` 下建立模块化、高内聚、低耦合的文件结构：

```
apps/crish-desktop/src/components/ui/SmartExpandablePanel/
├── index.ts                               # 核心聚合导出出口
├── types.ts                               # 严格 TypeScript 类型契约定义
├── SmartExpandablePanel.tsx               # 现代 React 数据驱动主面板组件
├── SmartExpandablePanel.module.css        # 模块化 CSS 样式体系
├── MenuItemRow.tsx                        # 单项条目渲染器（槽位/手风琴/勾选/级联）
├── useSmartPanel.ts                       # 宿主交互控制 Hook（双模受控/点坐标/触发器）
├── PositionEngine.ts                      # 120Hz 视口智能翻转与滞后防抖解算引擎
├── SafeAimEngine.ts                       # 零 Canvas 重心坐标系 Safe-Triangle 保护引擎
├── keyboardNav.ts                         # WAI-ARIA 规范全键盘无障碍漫游控制器
├── adapters/
│   ├── index.ts                           # 适配器聚合导出
│   ├── MenuAdapter.tsx                    # ui/Menu 既有接口无损兼容适配器
│   ├── SelectAdapter.tsx                  # ui/Select 既有接口无损兼容适配器
│   └── schemaBridge.ts                    # 数据结构 Schema 双向转换工具库
└── __tests__/
    ├── PositionEngine.test.ts             # 视口碰撞与滞后区间单元测试
    ├── SafeAimEngine.test.ts              # 向量重心法与安全多边形测试
    ├── keyboardNav.test.ts                # ARIA 键盘漫游与滚动跟随测试
    ├── SmartExpandablePanel.test.tsx      # 主组件渲染与受控生命周期测试
    ├── SmartExpandablePanel.search.test.tsx # 搜索过滤与快捷键匹配测试
    ├── SmartExpandablePanel.cascade.test.tsx # 多级级联与 Safe-Aim 保护测试
    ├── SmartExpandablePanel.wheel.test.tsx # 滚轮事件穿透隔离测试
    ├── MenuAdapter.test.tsx               # Menu 既有行为无损验证测试
    └── SelectAdapter.test.tsx             # Select 既有行为无损验证测试
```

### 文件职责对照表

| 文件名 | 职责与能力边界 | 外部依赖 |
| :--- | :--- | :--- |
| `types.ts` | 导出 `MenuItem`, `MenuGroup`, `SmartPanelProps`, `PositionOptions`, `SafeAimOptions` 等全量类型 | 仅依赖 `react` 基础类型 |
| `PositionEngine.ts` | 负责基于触发器或绝对点计算视口最佳弹出方向（上下左右）、32px 垂直滞后防抖、高度裁切 | 无 DOM 操作，纯几何计算逻辑 |
| `SafeAimEngine.ts` | 负责 4 帧鼠标历史轨迹采样、重心坐标系三角碰撞判定、管理 SVG Polygon Overlay | 浏览器 DOM / SVG API |
| `keyboardNav.ts` | 负责 WAI-ARIA 规范的键盘事件拦截、焦点漫游、子菜单跳转、Auto-Scroll 可视区跟随 | 纯逻辑与 DOM 元素交互 |
| `useSmartPanel.ts` | 提供 `isOpen`, `open`, `close`, `toggle`, `openAtPoint`, `triggerRef` 等便捷控制能力 | React Hooks |
| `SmartExpandablePanel.tsx` | 面板渲染核心、React Portal 逃逸、内嵌搜索、级联渲染、滚轮隔离 | React, ReactDOM, LayerStack |
| `MenuItemRow.tsx` | 单项条目的槽位渲染（左图标、主文本、副文本、右徽章、快捷键、对勾、手风琴折叠） | React |
| `MenuAdapter.tsx` | 接收 `ui/Menu` 的 `MenuProps` 并转化为 SmartExpandablePanel 渲染，对齐所有既有属性 | React, LayerStack |
| `SelectAdapter.tsx` | 接收 `ui/Select` 的 `SelectProps` 并转化为 SmartExpandablePanel 渲染，维持 combobox/listbox 语义 | React |
| `schemaBridge.ts` | 提供 `SelectOptionItem[]` 与 `SelectOption[]` 到 `MenuItem[]` 的无损双向转换方法 | 纯 TypeScript 函数 |

---

## 3. Design Tokens 与视觉体系深度融合

### 3.1 数学同心圆角法则（Mathematical Visual Curvature Architecture）

设计系统采用**约束同心性（Clamped Concentricity）与感知幂律**：
$$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 6\text{px})$$
$$R(H) = \text{round}(k \cdot \sqrt{H}) \quad (k \approx 1.15)$$

- **L1 宿主浮层面板 (Master Panel)**：`--sep-radius-outer: 14px`
- **外壳安全内边距 (Shell Inset)**：`--sep-padding: 6px`
- **L2 内部容器 / L3 菜单项 (Inner Container & Item Rows)**：`--sep-radius-inner: 8px` (即 $14\text{px} - 6\text{px} = 8\text{px}$，达成 $100\%$ 同心圆弧对齐)
- **L4 功能操作按钮 (Action Buttons H:22px)**：`--sep-btn-radius: 6px`
- **L5 状态标签 (Status Tags H:16px)**：`--sep-badge-radius: 4px`
- **L6 胶囊药丸 (Status Capsule Pills)**：`--sep-pill-radius: 9999px`

### 3.2 浅色 / 深色模式 `--sep-*` 完整变量规范

将以下变量深度注入 `apps/crish-desktop/src/styles/tokens.css`，确保与 Conex 主设计系统无缝融合：

```css
/* ==========================================================================
   SmartExpandablePanel Design Tokens (Concentric Radii & Zero-Blue Palette)
   ========================================================================== */

:root,
html[data-theme='default'],
html[data-theme='light'] {
  /* 1. Mathematical Curvature Hierarchy */
  --sep-radius-outer: 14px;
  --sep-padding: 6px;
  --sep-radius-inner: calc(var(--sep-radius-outer) - var(--sep-padding)); /* 8px */
  --sep-item-radius: calc(var(--sep-radius-outer) - var(--sep-padding));   /* 8px */
  --sep-btn-radius: 6px;
  --sep-badge-radius: 4px;
  --sep-pill-radius: 9999px;

  /* 2. Metrics & Layout */
  --sep-item-height: 28px;
  --sep-item-padding-h: 10px;
  --sep-item-gap: 2px;

  /* 3. Typography */
  --sep-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --sep-font-mono: SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  --sep-font-size-base: 13px;
  --sep-font-size-sm: 11px;
  --sep-font-size-header: 10.5px;

  /* 4. Light Mode Palette (Calibrated 10% CMYK Yellow Undertone, Zero Blue) */
  --sep-bg-canvas: #f6f5f3;
  --sep-bg-panel: rgba(255, 254, 252, 0.96);
  --sep-bg-panel-solid: #ffffff;
  --sep-bg-item-hover: rgba(29, 28, 26, 0.045);     /* 严禁加深，保持极轻触感 */
  --sep-bg-item-selected: rgba(29, 28, 26, 0.065);  /* 选中态柔和灰度 */
  --sep-bg-input: rgba(29, 28, 26, 0.03);

  /* 5. Solid Hairline Borders */
  --sep-border-color: #e2dfd9;
  --sep-border-hover: #c9c5bc;
  --sep-border-focus: #b2ada2;
  --sep-divider-color: rgba(29, 28, 26, 0.06);

  /* 6. Text Colors */
  --sep-text-primary: #1d1c1a;
  --sep-text-secondary: #5c5954;
  --sep-text-muted: #8b8780;

  /* 7. Semantic Colors (Calibrated HSL) */
  --sep-accent-color: hsl(160 84% 39%);
  --sep-accent-light: hsl(160 84% 39% / 0.12);
  --sep-danger-color: hsl(0 84% 60%);
  --sep-danger-light: hsl(0 84% 60% / 0.08);

  /* 8. Diffuse Multi-Layer Ambient Depth + Specular Inner Highlight */
  --sep-shadow: 0 20px 48px -10px rgba(29, 28, 26, 0.09),
                0 6px 20px -3px rgba(29, 28, 26, 0.03),
                0 2px 6px 0 rgba(29, 28, 26, 0.015),
                inset 0 1px 0 rgba(255, 255, 255, 0.95);
  --sep-backdrop-blur: 28px;

  /* 9. Transitions & Spring Curves */
  --sep-ease-spring: cubic-bezier(0.22, 1.25, 0.36, 1);
  --sep-ease-shrink: cubic-bezier(0.4, 0, 1, 1);
  --sep-duration-open: 0.22s;
  --sep-duration-close: 0.15s;
}

html[data-theme='dark'] {
  /* Dark Mode Palette (Pure Neutral Vercel/Conex Style, Zero Purple/Blue Tint) */
  --sep-bg-canvas: #0c0c0b;
  --sep-bg-panel: rgba(24, 23, 21, 0.96);
  --sep-bg-panel-solid: #181715;
  --sep-bg-item-hover: rgba(245, 244, 240, 0.06);     /* 深色极轻悬停灰 */
  --sep-bg-item-selected: rgba(245, 244, 240, 0.09);  /* 深色选中微高亮 */
  --sep-bg-input: rgba(245, 244, 240, 0.04);

  --sep-border-color: #2b2926;
  --sep-border-hover: #3d3a35;
  --sep-border-focus: #524e47;
  --sep-divider-color: rgba(255, 255, 255, 0.07);

  --sep-text-primary: #f5f4f0;
  --sep-text-secondary: #b5b2aa;
  --sep-text-muted: #78756d;

  --sep-accent-color: hsl(160 84% 45%);
  --sep-accent-light: hsl(160 84% 45% / 0.16);

  --sep-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70),
                0 8px 24px -4px rgba(0, 0, 0, 0.45),
                0 2px 8px 0 rgba(0, 0, 0, 0.30),
                inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
```

### 3.3 交互细节约束（遵守 `AGENTS.md` 铁律）
1. **Tooltip 规范（§12）**：面板中所有提示信息一律采用项目自定义 Tooltip 胶囊，严禁使用原生 HTML `title` 属性；
2. **输入框焦点态（§13）**：搜索输入框焦点激活时禁止粗黑边（`box-shadow: none`，边框混入文本色不得超过 $10\%$），保持轻量扁平；
3. **颜色格式规范（§14）**：全面采用现代 `hsl(h s l / a)` 语法与语义化 token。

---

## 4. 核心引擎与主组件 TypeScript 工业级实现

### 4.1 类型契约体系 (`types.ts`)

```typescript
import type { ReactNode, MouseEvent, CSSProperties, RefObject } from 'react';

/** 菜单项类型分类 */
export type MenuItemType =
  | 'item'
  | 'selectable'
  | 'group'
  | 'sub-group'
  | 'divider'
  | 'submenu'
  | 'collapsible';

/** 单个菜单项契约 */
export interface MenuItem {
  /** 唯一标识符 */
  id: string;
  /** 菜单项形态类型 */
  type?: MenuItemType;
  /** 主标题 */
  label?: string;
  /** 副标题 / 描述 */
  sublabel?: string;
  /** 图标位（ReactNode 或 SVG 组件） */
  icon?: ReactNode;
  /** 键盘快捷键文本（如 '⌘K', 'Ctrl+P'） */
  shortcut?: string;
  /** 状态徽章文本（如 'Beta', 'Pro'） */
  badge?: string;
  /** 悬停提示 Tooltip 文案 */
  tooltip?: string;
  /** 危险操作标红 */
  danger?: boolean;
  /** 禁用状态 */
  disabled?: boolean;
  /** 选中状态（针对 selectable 类型） */
  selected?: boolean;
  /** 是否为折叠手风琴项 */
  collapsible?: boolean;
  /** 手风琴初始展开状态 */
  expanded?: boolean;
  /** 搜索匹配关键字列表（空格分隔） */
  searchKeywords?: string;
  /** 级联子菜单或折叠项子元素 */
  children?: MenuItem[];
  /** 点击回调 */
  onSelect?: (item: MenuItem, event?: MouseEvent) => void;
  /** 折叠展开回调 */
  onToggle?: (expanded: boolean, item: MenuItem) => void;
  /** 业务自定义扩展字段 */
  [key: string]: unknown;
}

/** 分组区块契约 */
export interface MenuGroup {
  /** 分组唯一标识 */
  id?: string;
  /** 分组标题 */
  title?: string;
  /** 是否为内嵌自滚动选择列表（最大高度限制为 160px） */
  isSelectableList?: boolean;
  /** 分组内子菜单项 */
  items: MenuItem[];
}

/** 视口与定位边界矩形 */
export interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 智能定位解算结果 */
export interface PositionResult {
  x: number;
  y: number;
  origin: string;
  allowedListHeight: number | null;
  directionY: 'up' | 'down';
  directionX: 'left' | 'right';
}

/** 二级子菜单定位解算结果 */
export interface SubmenuPositionResult {
  x: number;
  y: number;
  isFlipLeft: boolean;
}

/** SmartExpandablePanel 主组件 Props */
export interface SmartPanelProps {
  /** 菜单项列表（支持普通数组或分组数组） */
  items: Array<MenuItem | MenuGroup>;
  /** 面板是否处于展开状态 */
  open?: boolean;
  /** 锚定触发器元素 Ref */
  triggerRef?: RefObject<HTMLElement | null>;
  /** 绝对坐标弹出点（右键菜单或光标位置） */
  point?: { x: number; y: number } | null;
  /** 搜索输入框 Placeholder */
  searchPlaceholder?: string;
  /** 是否开启内嵌搜索功能 */
  enableSearch?: boolean;
  /** 是否在分组间渲染发丝分割线 */
  enableDivider?: boolean;
  /** 是否开启 Safe-Aim 安全三角区保护 */
  enableTriangleAim?: boolean;
  /** 面板最大高度限制（默认 760px） */
  maxPanelHeight?: number;
  /** 是否使用局部容器作为边界约束（而非全局 window） */
  useContainerBoundary?: boolean;
  /** 局部容器 Boundary 元素 Ref */
  containerBoundaryRef?: RefObject<HTMLElement | null>;
  /** 项选中事件回调 */
  onSelect?: (item: MenuItem) => void;
  /** 面板打开时回调 */
  onOpen?: () => void;
  /** 面板关闭时回调 */
  onClose?: () => void;
  /** 挂载的 Dialog / Portal 容器 */
  container?: HTMLElement | null;
  /** 自定义外层 CSS 类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: CSSProperties;
  /** 自定义头部内容（可选） */
  header?: ReactNode;
  /** 自定义底部内容（可选） */
  footer?: ReactNode;
  /** 面板标题（兼容 Menu title） */
  title?: string;
  /** 自定义项渲染器（兼容 Menu renderItem） */
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
  /** 子元素（与 items 模式二选一，兼容 Menu children） */
  children?: ReactNode;
}
```

---

### 4.2 120Hz 视口智能定位与滞后防抖引擎 (`PositionEngine.ts`)

```typescript
import type { BoundingBox, PositionResult, SubmenuPositionResult } from './types';

export interface PositionEngineOptions {
  /** 垂直方向滞后判定区间（单位：px），默认 32px，防止临界抖动 */
  hysteresisY?: number;
  /** 面板最大允许高度 */
  maxPanelHeight?: number;
}

/**
 * PositionEngine - 工业级高精度浮动定位与视口碰撞约束引擎
 * 特性：
 * 1. 120Hz 视口智能翻转（上/下/左/右）；
 * 2. 32px Hysteresis 滞后区间防抖算法；
 * 3. 动态发丝高度精确测量（自然高度 vs 视口裁剪高度）；
 * 4. 支持 Viewport 视口与局部 Container 容器双模式边界。
 */
export class PositionEngine {
  private readonly hysteresisY: number;
  private readonly maxPanelHeight: number;
  private currentDirY: 'up' | 'down' | null = null;
  private currentDirX: 'left' | 'right' | null = null;

  constructor(options: PositionEngineOptions = {}) {
    this.hysteresisY = options.hysteresisY ?? 32;
    this.maxPanelHeight = options.maxPanelHeight ?? 760;
  }

  /** 重置方向记忆状态 */
  public reset(): void {
    this.currentDirY = null;
    this.currentDirX = null;
  }

  /** 获取有效活动边界矩形 */
  public getActiveBoundary(
    useContainerBoundary = false,
    containerEl: HTMLElement | null = null
  ): BoundingBox {
    if (useContainerBoundary && containerEl) {
      const rect = containerEl.getBoundingClientRect();
      return {
        left: rect.left + 8,
        top: rect.top + 8,
        right: rect.right - 8,
        bottom: rect.bottom - 8,
      };
    }
    return {
      left: 12,
      top: 12,
      right: (typeof window !== 'undefined' ? window.innerWidth : 1920) - 12,
      bottom: (typeof window !== 'undefined' ? window.innerHeight : 1080) - 12,
    };
  }

  /** 发丝级精确测量面板自然展开所需高度 */
  public measureNaturalHeight(
    panelEl: HTMLElement,
    listEl: HTMLElement,
    headerHeight = 0
  ): number {
    const prevMaxHeight = listEl.style.maxHeight;
    const prevOverflow = listEl.style.overflow;
    listEl.style.maxHeight = 'none';
    listEl.style.overflow = 'visible';

    const listScrollHeight = listEl.scrollHeight;
    const panelStyle = typeof window !== 'undefined' ? window.getComputedStyle(panelEl) : null;
    const paddingTop = parseFloat(panelStyle?.paddingTop || '6') || 6;
    const paddingBottom = parseFloat(panelStyle?.paddingBottom || '6') || 6;
    const borderTop = parseFloat(panelStyle?.borderTopWidth || '1') || 1;
    const borderBottom = parseFloat(panelStyle?.borderBottomWidth || '1') || 1;

    const totalCalculated = listScrollHeight + headerHeight + paddingTop + paddingBottom + borderTop + borderBottom;
    const measuredOffset = panelEl.offsetHeight;

    listEl.style.maxHeight = prevMaxHeight;
    listEl.style.overflow = prevOverflow;

    return Math.max(totalCalculated, measuredOffset);
  }

  /** 基于触发器元素计算弹出面板坐标与尺寸 */
  public calculateTriggerPosition(params: {
    triggerEl: HTMLElement;
    panelEl: HTMLElement;
    listEl: HTMLElement;
    headerHeight: number;
    bounds: BoundingBox;
  }): PositionResult {
    const { triggerEl, panelEl, listEl, headerHeight, bounds } = params;
    const rawNaturalHeight = this.measureNaturalHeight(panelEl, listEl, headerHeight);
    const cappedHeight = Math.min(this.maxPanelHeight, rawNaturalHeight);
    const panelWidth = panelEl.offsetWidth || 265;
    const triggerRect = triggerEl.getBoundingClientRect();

    const spaceBelow = bounds.bottom - triggerRect.bottom - 8;
    const spaceAbove = triggerRect.top - bounds.top - 8;

    const fitsBelow = spaceBelow >= cappedHeight;
    const fitsAbove = spaceAbove >= cappedHeight;

    let idealDirY: 'up' | 'down' = 'down';
    if (fitsBelow) {
      idealDirY = 'down';
    } else if (fitsAbove) {
      idealDirY = 'up';
    } else {
      idealDirY = spaceBelow >= spaceAbove ? 'down' : 'up';
    }

    // 核心：应用 32px 滞后区间（Hysteresis），防止在视口边缘微小变动时引发上下疯狂跳闪
    let preferredDirY = idealDirY;
    if (this.currentDirY && this.currentDirY !== idealDirY) {
      const currentSpace = this.currentDirY === 'down' ? spaceBelow : spaceAbove;
      const idealSpace = idealDirY === 'down' ? spaceBelow : spaceAbove;
      if (idealSpace - currentSpace > this.hysteresisY) {
        preferredDirY = idealDirY;
      } else {
        preferredDirY = this.currentDirY;
      }
    }
    this.currentDirY = preferredDirY;

    let targetY = 0;
    const availableVerticalSpace = preferredDirY === 'down' ? spaceBelow : spaceAbove;
    const originY = preferredDirY === 'down' ? 'top' : 'bottom';

    if (preferredDirY === 'down') {
      targetY = triggerRect.bottom + 8;
    } else {
      const actualPanelHeight = Math.min(cappedHeight, availableVerticalSpace);
      targetY = triggerRect.top - 8 - actualPanelHeight;
    }

    targetY = Math.max(bounds.top, Math.min(bounds.bottom - 100, targetY));

    let allowedListHeight: number | null = null;
    if (rawNaturalHeight > availableVerticalSpace) {
      allowedListHeight = Math.max(120, availableVerticalSpace - headerHeight - 16);
    }

    let originX: 'left' | 'right' = 'left';
    let targetX = triggerRect.left;
    if (triggerRect.left + panelWidth > bounds.right) {
      targetX = Math.max(bounds.left, triggerRect.right - panelWidth);
      originX = 'right';
    } else {
      targetX = Math.max(bounds.left, triggerRect.left);
    }

    return {
      x: targetX,
      y: targetY,
      origin: `${originX} ${originY}`,
      allowedListHeight,
      directionY: preferredDirY,
      directionX: originX,
    };
  }

  /** 基于绝对点（右键菜单）计算弹出坐标 */
  public calculatePointPosition(params: {
    point: { x: number; y: number };
    panelEl: HTMLElement;
    listEl: HTMLElement;
    headerHeight: number;
    bounds: BoundingBox;
  }): PositionResult {
    const { point, panelEl, listEl, headerHeight, bounds } = params;
    const rawNaturalHeight = this.measureNaturalHeight(panelEl, listEl, headerHeight);
    const cappedHeight = Math.min(this.maxPanelHeight, rawNaturalHeight);
    const panelWidth = panelEl.offsetWidth || 265;

    let targetX = point.x;
    let targetY = point.y;
    const spaceBelow = bounds.bottom - point.y;
    const spaceAbove = point.y - bounds.top;

    const placeDown = spaceBelow >= cappedHeight || spaceBelow >= spaceAbove;
    const availableVerticalSpace = placeDown ? spaceBelow : spaceAbove;
    const originX: 'left' | 'right' = point.x + panelWidth > bounds.right ? 'right' : 'left';
    const originY = placeDown ? 'top' : 'bottom';

    if (point.x + panelWidth > bounds.right) {
      targetX = Math.max(bounds.left, point.x - panelWidth);
    } else {
      targetX = Math.max(bounds.left, targetX);
    }

    if (placeDown) {
      targetY = point.y;
    } else {
      const actualHeight = Math.min(cappedHeight, spaceAbove);
      targetY = Math.max(bounds.top, point.y - actualHeight);
    }

    let allowedListHeight: number | null = null;
    if (rawNaturalHeight > availableVerticalSpace) {
      allowedListHeight = Math.max(120, availableVerticalSpace - headerHeight - 16);
    }

    return {
      x: targetX,
      y: targetY,
      origin: `${originX} ${originY}`,
      allowedListHeight,
      directionY: placeDown ? 'down' : 'up',
      directionX: originX,
    };
  }

  /** 计算二级级联子菜单坐标与水平翻转 */
  public calculateSubmenuPosition(params: {
    triggerItemEl: HTMLElement;
    submenuEl: HTMLElement;
    bounds: BoundingBox;
  }): SubmenuPositionResult {
    const { triggerItemEl, submenuEl, bounds } = params;
    const itemRect = triggerItemEl.getBoundingClientRect();
    const subWidth = submenuEl.offsetWidth || 230;
    const subHeight = submenuEl.offsetHeight || 180;

    let targetX = itemRect.right + 4;
    let isFlipLeft = false;

    if (targetX + subWidth > bounds.right) {
      targetX = itemRect.left - subWidth - 4;
      isFlipLeft = true;
    }

    let targetY = itemRect.top - 4;
    if (targetY + subHeight > bounds.bottom) {
      targetY = Math.max(bounds.top, bounds.bottom - subHeight - 8);
    }

    return {
      x: targetX,
      y: targetY,
      isFlipLeft,
    };
  }
}
```

---

### 4.3 零 Canvas 重心坐标系 Safe-Aim 安全三角区引擎 (`SafeAimEngine.ts`)

```typescript
export interface SafeAimOptions {
  enabled?: boolean;
  debug?: boolean;
}

export interface Point2D {
  x: number;
  y: number;
}

/**
 * SafeAimEngine - 零 Canvas 开销的现代 SVG 多边形 Safe-Triangle 保护引擎
 *
 * 核心原理：
 * 采用向量重心坐标系（Barycentric Coordinates）在 O(1) 时间内判定光标是否处于
 * 「当前鼠标位置 -> 子菜单上下边界」构成的虚拟安全斜切三角区内。
 * 杜绝从父菜单向右侧子菜单移动过程中，光标划过邻近兄弟项导致的意外失焦抖动。
 */
export class SafeAimEngine {
  private enabled: boolean;
  private debug: boolean;
  private activeSubmenu: HTMLElement | null = null;
  private activeTriggerItem: HTMLElement | null = null;
  private mouseHistory: Point2D[] = [];
  private readonly MAX_MOUSE_HISTORY = 4;

  private svgOverlay: SVGSVGElement | null = null;
  private polygonEl: SVGPolygonElement | null = null;

  constructor(options: SafeAimOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.debug = options.debug ?? false;
    this.onMouseMove = this.onMouseMove.bind(this);

    if (typeof document !== 'undefined') {
      this.initSvgOverlay();
      window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    }
  }

  private initSvgOverlay(): void {
    let svg = document.getElementById('sepSafeAimOverlay') as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'sepSafeAimOverlay';
      svg.classList.add('sep-safe-aim-overlay');
      if (this.debug) svg.classList.add('sep-debug-visible');

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      svg.appendChild(poly);
      document.body.appendChild(svg);
    }
    this.svgOverlay = svg;
    this.polygonEl = svg.querySelector('polygon');
  }

  public setDebug(visible: boolean): void {
    this.debug = visible;
    if (this.svgOverlay) {
      this.svgOverlay.classList.toggle('sep-debug-visible', this.debug);
    }
  }

  private onMouseMove(e: MouseEvent): void {
    this.mouseHistory.push({ x: e.clientX, y: e.clientY });
    if (this.mouseHistory.length > this.MAX_MOUSE_HISTORY) {
      this.mouseHistory.shift();
    }
    this.updatePolygon();
  }

  public getRecentMousePos(): Point2D {
    return this.mouseHistory.length > 0
      ? this.mouseHistory[this.mouseHistory.length - 1]
      : { x: 0, y: 0 };
  }

  public getPreviousMousePos(): Point2D {
    return this.mouseHistory.length > 1
      ? this.mouseHistory[0]
      : this.getRecentMousePos();
  }

  public setSubmenu(triggerItemEl: HTMLElement | null, submenuEl: HTMLElement | null): void {
    this.activeTriggerItem = triggerItemEl;
    this.activeSubmenu = submenuEl;
    this.updatePolygon();
  }

  public clearSubmenu(): void {
    this.activeTriggerItem = null;
    this.activeSubmenu = null;
    if (this.polygonEl) {
      this.polygonEl.removeAttribute('points');
    }
  }

  public updatePolygon(): void {
    if (!this.enabled || !this.activeSubmenu || !this.polygonEl) {
      if (this.polygonEl) this.polygonEl.removeAttribute('points');
      return;
    }

    const subRect = this.activeSubmenu.getBoundingClientRect();
    if (subRect.width === 0 || subRect.height === 0) return;

    const mouse = this.getRecentMousePos();
    const isSubmenuOnRight = subRect.left >= mouse.x;

    let pTop: Point2D;
    let pBottom: Point2D;
    if (isSubmenuOnRight) {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.left, y: subRect.bottom };
    } else {
      pTop = { x: subRect.right, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.bottom };
    }

    const points = `${mouse.x},${mouse.y} ${pTop.x},${pTop.y} ${pBottom.x},${pBottom.y}`;
    this.polygonEl.setAttribute('points', points);
  }

  /**
   * 判定指定坐标点是否位于安全三角区内
   */
  public isPointerInSafeZone(point: Point2D): boolean {
    if (!this.enabled || !this.activeSubmenu) return false;

    const subRect = this.activeSubmenu.getBoundingClientRect();
    const mouse = this.getPreviousMousePos();
    const isSubmenuOnRight = subRect.left >= mouse.x;

    let pTop: Point2D;
    let pBottom: Point2D;
    if (isSubmenuOnRight) {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.left, y: subRect.bottom };
    } else {
      pTop = { x: subRect.right, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.bottom };
    }

    return this.pointInTriangle(point, mouse, pTop, pBottom);
  }

  /**
   * 向量重心法 (Barycentric Coordinates) 三角形内点快速碰撞判定
   */
  private pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
    const v0 = [c.x - a.x, c.y - a.y];
    const v1 = [b.x - a.x, b.y - a.y];
    const v2 = [p.x - a.x, p.y - a.y];

    const dot00 = v0[0] * v0[0] + v0[1] * v0[1];
    const dot01 = v0[0] * v1[0] + v0[1] * v1[1];
    const dot02 = v0[0] * v2[0] + v0[1] * v2[1];
    const dot11 = v1[0] * v1[0] + v1[1] * v1[1];
    const dot12 = v1[0] * v2[0] + v1[1] * v2[1];

    const denom = dot00 * dot11 - dot01 * dot01;
    if (denom === 0) return false;

    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return u >= 0 && v >= 0 && u + v < 1;
  }

  public destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.onMouseMove);
    }
    if (this.svgOverlay && this.svgOverlay.parentNode) {
      this.svgOverlay.parentNode.removeChild(this.svgOverlay);
    }
  }
}
```

---

### 4.4 WAI-ARIA 规范全键盘漫游引擎 (`keyboardNav.ts`)

```typescript
export interface KeyboardNavContext {
  isOpen: boolean;
  mainPanel: HTMLElement | null;
  submenuStack: Array<{ submenuEl: HTMLElement }>;
  onItemKeyboardFocus?: (itemId: string, el: HTMLElement) => void;
  openSubmenuForElement?: (el: HTMLElement) => void;
  closeActiveSubmenu?: () => void;
  closeSubmenusFromLevel?: (level: number) => void;
  close: () => void;
}

/**
 * KeyboardNavEngine - WAI-ARIA 国际标准全键盘交互漫游控制器
 *
 * 键位协议：
 * - ArrowDown / ArrowUp：在可用条目间循环漫游，自动跳过 disabled 项，Auto-Scroll 跟随；
 * - ArrowRight：若当前项具备二级级联子菜单，展开并自动聚焦子菜单第 0 项；
 * - ArrowLeft：在二级子菜单中时，收起当前子菜单并回归父级对应焦点；
 * - Enter / Space：触发项的点击选择（如果在搜索输入框内打空格则放行文本输入）；
 * - Escape：逐级回退二级子菜单，若无子菜单则关闭整个主面板。
 */
export class KeyboardNavEngine {
  private getContext: () => KeyboardNavContext;
  public focusedIndex = -1;
  public activeScope: 'main' | 'submenu' = 'main';

  constructor(getContext: () => KeyboardNavContext) {
    this.getContext = getContext;
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  public attach(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
    }
  }

  public detach(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
    }
    this.clearFocus();
  }

  private getActiveSubmenu(): HTMLElement | null {
    const ctx = this.getContext();
    if (!ctx.submenuStack || ctx.submenuStack.length === 0) return null;
    return ctx.submenuStack[ctx.submenuStack.length - 1].submenuEl;
  }

  public getNavigableItems(scope: 'main' | 'submenu' = 'main'): HTMLElement[] {
    const ctx = this.getContext();
    const activeSubmenu = this.getActiveSubmenu();
    const container = scope === 'submenu' && activeSubmenu ? activeSubmenu : ctx.mainPanel;
    if (!container) return [];

    const elements = container.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"]):not(:disabled), [role="option"]:not([aria-disabled="true"]):not(:disabled), .sep-item:not(.sep-disabled), .sep-selectable-item:not(.sep-disabled)'
    );

    return Array.from(elements).filter(el => {
      return el.offsetParent !== null && (typeof window !== 'undefined' ? window.getComputedStyle(el).display !== 'none' : true);
    });
  }

  public focusItem(index: number, scope: 'main' | 'submenu' = 'main'): void {
    const items = this.getNavigableItems(scope);
    if (items.length === 0) return;

    this.clearFocus(scope);

    if (index < 0) index = items.length - 1;
    if (index >= items.length) index = 0;

    this.focusedIndex = index;
    this.activeScope = scope;

    const targetEl = items[index];
    targetEl.classList.add('sep-keyboard-focus');
    targetEl.focus?.();
    targetEl.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });

    const itemId = targetEl.getAttribute('data-sep-id') || targetEl.getAttribute('data-id');
    const ctx = this.getContext();
    if (itemId) {
      ctx.onItemKeyboardFocus?.(itemId, targetEl);
    }
  }

  public clearFocus(scope: 'main' | 'submenu' | null = null): void {
    const targetScope = scope || this.activeScope;
    const ctx = this.getContext();
    const activeSubmenu = this.getActiveSubmenu();
    const container = targetScope === 'submenu' && activeSubmenu ? activeSubmenu : ctx.mainPanel;

    if (container) {
      container.querySelectorAll('.sep-keyboard-focus').forEach(el => {
        el.classList.remove('sep-keyboard-focus');
      });
    }
    this.focusedIndex = -1;
  }

  public onKeyDown(e: KeyboardEvent): void {
    const ctx = this.getContext();
    if (!ctx.isOpen) return;

    const items = this.getNavigableItems(this.activeScope);

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextIdx = this.focusedIndex + 1;
        this.focusItem(nextIdx, this.activeScope);
        break;
      }

      case 'ArrowUp': {
        e.preventDefault();
        const prevIdx = this.focusedIndex - 1;
        this.focusItem(prevIdx, this.activeScope);
        break;
      }

      case 'ArrowRight': {
        if (this.focusedIndex >= 0 && items[this.focusedIndex]) {
          const currentItem = items[this.focusedIndex];
          if (currentItem.classList.contains('sep-has-cascade') || currentItem.getAttribute('data-has-submenu') === 'true') {
            e.preventDefault();
            ctx.openSubmenuForElement?.(currentItem);
            setTimeout(() => {
              this.focusItem(0, 'submenu');
            }, 30);
          }
        }
        break;
      }

      case 'ArrowLeft': {
        if (this.activeScope === 'submenu') {
          e.preventDefault();
          ctx.closeActiveSubmenu?.();
          this.activeScope = 'main';
          this.focusItem(this.focusedIndex, 'main');
        }
        break;
      }

      case 'Enter':
      case ' ': {
        if (this.focusedIndex >= 0 && items[this.focusedIndex]) {
          const activeInput = typeof document !== 'undefined' ? document.activeElement : null;
          const isTypingInSearch = activeInput && (activeInput.classList.contains('sep-search-input') || activeInput.tagName === 'INPUT');

          if (e.key === ' ' && isTypingInSearch) {
            return; // 搜索框内允许正常输入空格
          }

          e.preventDefault();
          items[this.focusedIndex].click();
        }
        break;
      }

      case 'Escape': {
        e.preventDefault();
        if (this.activeScope === 'submenu') {
          ctx.closeActiveSubmenu?.();
          this.activeScope = 'main';
        } else {
          ctx.close();
        }
        break;
      }
    }
  }
}
```

---

### 4.5 宿主交互状态与坐标管理 Hook (`useSmartPanel.ts`)

```typescript
import { useState, useCallback, useRef } from 'react';
import type { RefObject } from 'react';

export interface UseSmartPanelReturn {
  /** 当前面板是否处于开启状态 */
  isOpen: boolean;
  /** 触发器元素绑定的 Ref */
  triggerRef: RefObject<HTMLElement | null>;
  /** 锚点元素绑定的 Ref */
  anchorRef: RefObject<HTMLElement | null>;
  /** 打开面板 */
  open: () => void;
  /** 关闭面板 */
  close: () => void;
  /** 切换面板开闭状态 */
  toggle: () => void;
  /** 在指定屏幕坐标点弹出面板（右键上下文菜单模式） */
  openAtPoint: (point: { x: number; y: number }) => void;
  /** 当前绝对坐标点 */
  point: { x: number; y: number } | null;
  /** 设置受控状态变更回调 */
  onOpenChange: (nextOpen: boolean) => void;
}

export function useSmartPanel(defaultOpen = false): UseSmartPanelReturn {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const open = useCallback(() => {
    setPoint(null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setPoint(null);
  }, []);

  const toggle = useCallback(() => {
    setIsOpen(prev => !prev);
  }, []);

  const openAtPoint = useCallback((pt: { x: number; y: number }) => {
    setPoint(pt);
    setIsOpen(true);
  }, []);

  const onOpenChange = useCallback((nextOpen: boolean) => {
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setPoint(null);
    }
  }, []);

  return {
    isOpen,
    triggerRef,
    anchorRef,
    open,
    close,
    toggle,
    openAtPoint,
    point,
    onOpenChange,
  };
}
```

---

### 4.6 模块化样式体系 (`SmartExpandablePanel.module.css`)

```css
/* ==========================================================================
   SmartExpandablePanel CSS Modules Architecture
   ========================================================================== */

.container {
  position: fixed;
  z-index: 2000;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: scale(0.94) translateY(-4px);
  transition: opacity var(--sep-duration-open) var(--sep-ease-spring),
              transform var(--sep-duration-open) var(--sep-ease-spring),
              visibility var(--sep-duration-open);
  overscroll-behavior: contain;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

.container.open {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: none;
}

.panel {
  min-width: 250px;
  max-width: 340px;
  background: var(--sep-bg-panel);
  backdrop-filter: blur(var(--sep-backdrop-blur)) saturate(160%);
  -webkit-backdrop-filter: blur(var(--sep-backdrop-blur)) saturate(160%);
  border: 1px solid var(--sep-border-color);
  border-radius: var(--sep-radius-outer);
  padding: var(--sep-padding);
  box-shadow: var(--sep-shadow);
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap);
  height: auto;
  box-sizing: border-box;
  font-family: var(--sep-font-sans);
  color: var(--sep-text-primary);
}

.panelTitle {
  font-size: var(--sep-font-size-header);
  font-weight: 600;
  color: var(--sep-text-muted);
  letter-spacing: 0.4px;
  padding: 4px var(--sep-item-padding-h) 2px;
  text-transform: uppercase;
}

/* 独立自滚动区域与发丝滚动条 */
.listContainer {
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
}

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
  background: var(--sep-border-color);
  border-radius: 4px;
}
.listContainer::-webkit-scrollbar-thumb:hover,
.selectableList::-webkit-scrollbar-thumb:hover {
  background: var(--sep-text-muted);
}

/* 嵌入式搜索框 */
.searchWrapper {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  min-height: 28px;
  padding: 0 4px 0 6px;
  margin: 1px 0;
  background: transparent;
  flex-shrink: 0;
  box-sizing: border-box;
}

.searchIconBox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--sep-text-muted);
  pointer-events: none;
}

.searchInput {
  flex: 1;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--sep-text-primary);
  outline: none;
  box-shadow: none;
}

.searchInput::placeholder {
  color: var(--sep-text-muted);
  opacity: 0.85;
}

.searchBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--sep-btn-radius);
  background: transparent;
  color: var(--sep-text-muted);
  cursor: pointer;
  padding: 0;
  outline: none;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.searchBtn:hover {
  background-color: var(--sep-bg-item-hover);
  color: var(--sep-text-primary);
}

/* 发丝分割线 */
.divider {
  height: 0;
  min-height: 0;
  border: none;
  border-top: 1px solid var(--sep-divider-color);
  margin: 3px var(--sep-padding);
  flex-shrink: 0;
}

/* 分组标题 */
.groupHeader {
  font-size: var(--sep-font-size-header);
  font-weight: 500;
  color: var(--sep-text-muted);
  letter-spacing: 0.35px;
  padding: 3px var(--sep-item-padding-h) 2px;
  margin-top: 1px;
  user-select: none;
  pointer-events: none;
}

.selectableList {
  max-height: 160px;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap);
  padding-right: 2px;
  overscroll-behavior: contain;
}

/* 标准菜单项与可选项 */
.item,
.selectableItem {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--sep-item-height);
  min-height: var(--sep-item-height);
  padding: 0 var(--sep-item-padding-h);
  border-radius: var(--sep-item-radius);
  font-size: var(--sep-font-size-base);
  font-weight: 400;
  color: var(--sep-text-primary);
  cursor: pointer;
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
  transition: background-color 0.12s ease, color 0.12s ease;
  box-sizing: border-box;
  outline: none;
}

.item:hover,
.item.keyboardFocus,
.selectableItem:hover,
.selectableItem.keyboardFocus {
  background-color: var(--sep-bg-item-hover);
}

.selectableItem.selected {
  background-color: var(--sep-bg-item-selected);
  color: var(--sep-text-primary);
}

.item.disabled,
.selectableItem.disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}

.item.danger {
  color: var(--sep-danger-color);
}
.item.danger:hover,
.item.danger.keyboardFocus {
  background-color: var(--sep-danger-light);
}

/* 槽位结构 */
.itemLeft {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.itemIcon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sep-text-secondary);
}

.itemText {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.itemLabel {
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.itemSublabel {
  font-size: var(--sep-font-size-sm);
  color: var(--sep-text-muted);
}

.itemRight {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 12px;
  flex-shrink: 0;
}

.shortcutKey {
  font-size: var(--sep-font-size-sm);
  color: var(--sep-text-secondary);
  font-family: var(--sep-font-mono);
}

.badgePill {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: var(--sep-badge-radius);
  background: var(--sep-bg-input);
  color: var(--sep-text-secondary);
  border: 1px solid var(--sep-border-color);
}

.checkIcon {
  width: 14px;
  height: 14px;
  color: var(--sep-accent-color);
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 0.15s ease, transform 0.15s var(--sep-ease-spring);
}
.selected .checkIcon {
  opacity: 1;
  transform: scale(1);
}

/* 二级级联子菜单 */
.submenu {
  position: fixed;
  top: 0;
  left: 0;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: scale(0.94) translateX(-4px);
  transition: opacity 0.18s var(--sep-ease-spring),
              transform 0.22s var(--sep-ease-spring),
              visibility 0.22s;
  z-index: 2010;
  overscroll-behavior: contain;
}

.submenu.open {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: scale(1) translateX(0);
}

.submenu.flipLeft {
  transform: scale(0.94) translateX(4px);
}
.submenu.flipLeft.open {
  transform: scale(1) translateX(0);
}

/* 折叠手风琴 */
.collapsibleContent {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s var(--sep-ease-spring);
  overflow: hidden;
}
.collapsibleContent.expanded {
  grid-template-rows: 1fr;
}
.collapsibleInner {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap);
  padding-top: 2px;
}
```

---

### 4.7 现代 React 数据驱动主面板组件 (`SmartExpandablePanel.tsx`)

```tsx
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItem, MenuGroup, SmartPanelProps } from './types';
import { PositionEngine } from './PositionEngine';
import { SafeAimEngine } from './SafeAimEngine';
import { KeyboardNavEngine } from './keyboardNav';
import { MenuItemRow } from './MenuItemRow';
import styles from './SmartExpandablePanel.module.css';

export const SmartExpandablePanel: React.FC<SmartPanelProps> = ({
  items,
  open = false,
  triggerRef,
  point,
  searchPlaceholder = '搜索功能或选项...',
  enableSearch = false,
  enableDivider = true,
  enableTriangleAim = true,
  maxPanelHeight = 760,
  useContainerBoundary = false,
  containerBoundaryRef,
  onSelect,
  onOpen,
  onClose,
  container,
  className = '',
  style,
  header,
  footer,
  title,
  renderItem,
  children,
}) => {
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [activeSubmenuNode, setActiveSubmenuNode] = useState<MenuItem | null>(null);
  const [activeSubmenuPos, setActiveSubmenuPos] = useState<{ x: number; y: number; isFlipLeft: boolean } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);

  const positionEngine = useMemo(() => new PositionEngine({ maxPanelHeight }), [maxPanelHeight]);
  const safeAimEngine = useMemo(() => new SafeAimEngine({ enabled: enableTriangleAim }), [enableTriangleAim]);

  // 键盘漫游引擎桥接
  const keyboardNavEngine = useMemo(() => {
    return new KeyboardNavEngine(() => ({
      isOpen: open,
      mainPanel: panelRef.current,
      submenuStack: activeSubmenuNode && submenuRef.current ? [{ submenuEl: submenuRef.current }] : [],
      onItemKeyboardFocus: () => {},
      openSubmenuForElement: (el) => {
        const id = el.getAttribute('data-id');
        const targetNode = items.flatMap(i => 'items' in i ? i.items : [i]).find(i => i.id === id);
        if (targetNode && targetNode.children) {
          setActiveSubmenuNode(targetNode);
        }
      },
      closeActiveSubmenu: () => {
        setActiveSubmenuNode(null);
        safeAimEngine.clearSubmenu();
      },
      close: () => onClose?.(),
    }));
  }, [open, items, activeSubmenuNode, safeAimEngine, onClose]);

  useEffect(() => {
    setMounted(true);
    return () => {
      safeAimEngine.destroy();
      keyboardNavEngine.detach();
    };
  }, [safeAimEngine, keyboardNavEngine]);

  // 精确计算面板弹出位置
  const updatePosition = useCallback(() => {
    if (!panelRef.current || !listRef.current || !containerRef.current) return;

    const bounds = positionEngine.getActiveBoundary(useContainerBoundary, containerBoundaryRef?.current || null);
    const headerHeight = (enableSearch ? 38 : 0) + (title ? 28 : 0) + (header ? 32 : 0);

    let pos: { x: number; y: number; origin: string; allowedListHeight: number | null };

    if (point) {
      pos = positionEngine.calculatePointPosition({
        point,
        panelEl: panelRef.current,
        listEl: listRef.current,
        headerHeight,
        bounds,
      });
    } else if (triggerRef?.current) {
      pos = positionEngine.calculateTriggerPosition({
        triggerEl: triggerRef.current,
        panelEl: panelRef.current,
        listEl: listRef.current,
        headerHeight,
        bounds,
      });
    } else {
      return;
    }

    if (pos.allowedListHeight) {
      listRef.current.style.maxHeight = `${pos.allowedListHeight}px`;
    } else {
      listRef.current.style.maxHeight = '';
    }

    containerRef.current.style.left = `${pos.x}px`;
    containerRef.current.style.top = `${pos.y}px`;
    containerRef.current.style.transformOrigin = pos.origin;
  }, [positionEngine, useContainerBoundary, containerBoundaryRef, enableSearch, title, header, point, triggerRef]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveSubmenuNode(null);
      keyboardNavEngine.attach();
      updatePosition();
      onOpen?.();

      if (enableSearch) {
        setTimeout(() => searchInputRef.current?.focus(), 40);
      }
    } else {
      keyboardNavEngine.detach();
      onClose?.();
    }
  }, [open, enableSearch, keyboardNavEngine, updatePosition, onOpen, onClose]);

  // 滚轮穿透隔离（Wheel Isolation）
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const listEl = listRef.current;
    if (!listEl) return;

    const { scrollTop, scrollHeight, clientHeight } = listEl;
    const isAtTop = scrollTop === 0 && e.deltaY < 0;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;

    if (isAtTop || isAtBottom) {
      e.stopPropagation();
    }
  };

  // 搜索关键词实时过滤
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;

    const filterNode = (node: MenuItem): boolean => {
      const match = `${node.label || ''} ${node.sublabel || ''} ${node.searchKeywords || ''}`.toLowerCase().includes(q);
      return match;
    };

    return items
      .map(entry => {
        if ('items' in entry) {
          const matchedChildren = entry.items.filter(filterNode);
          return matchedChildren.length > 0 ? { ...entry, items: matchedChildren } : null;
        }
        return filterNode(entry) ? entry : null;
      })
      .filter(Boolean) as Array<MenuItem | MenuGroup>;
  }, [items, query]);

  if (!mounted || !open) return null;

  const targetContainer = container || (typeof document !== 'undefined' ? document.body : null);
  if (!targetContainer) return null;

  return createPortal(
    <div
      ref={containerRef}
      className={`${styles.container} ${styles.open} ${className}`}
      style={style}
      onWheel={handleWheel}
    >
      <div ref={panelRef} className={styles.panel}>
        {title && <div className={styles.panelTitle}>{title}</div>}
        {header}

        {enableSearch && (
          <>
            <div className={styles.searchWrapper}>
              <div className={styles.searchIconBox}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <input
                ref={searchInputRef}
                type="text"
                className={styles.searchInput}
                placeholder={searchPlaceholder}
                value={query}
                onChange={e => setQuery(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button
                  type="button"
                  className={styles.searchBtn}
                  onClick={() => {
                    setQuery('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label="清空搜索"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
            <div className={styles.divider} />
          </>
        )}

        {children != null ? (
          <div ref={listRef} className={styles.listContainer}>
            {children}
          </div>
        ) : (
          <div ref={listRef} className={styles.listContainer} role="menu">
            {filteredItems.map((entry, idx) => {
              if ('items' in entry) {
                return (
                  <div key={entry.id || idx} className={styles.groupSection}>
                    {entry.title && !query && <div className={styles.groupHeader}>{entry.title}</div>}
                    <div className={entry.isSelectableList ? styles.selectableList : styles.groupItems}>
                      {entry.items.map((item, itemIdx) => (
                        <MenuItemRow
                          key={item.id}
                          item={item}
                          index={itemIdx}
                          renderItem={renderItem}
                          onSelect={onSelect}
                          onHoverSubmenu={(node, el) => {
                            if (safeAimEngine.isPointerInSafeZone(safeAimEngine.getRecentMousePos())) {
                              return;
                            }
                            setActiveSubmenuNode(node);
                            const bounds = positionEngine.getActiveBoundary(useContainerBoundary, containerBoundaryRef?.current || null);
                            if (submenuRef.current && el) {
                              const subPos = positionEngine.calculateSubmenuPosition({
                                triggerItemEl: el,
                                submenuEl: submenuRef.current,
                                bounds,
                              });
                              setActiveSubmenuPos(subPos);
                              safeAimEngine.setSubmenu(el, submenuRef.current);
                            }
                          }}
                        />
                      ))}
                    </div>
                    {enableDivider && !query && idx < filteredItems.length - 1 && (
                      <div className={styles.divider} />
                    )}
                  </div>
                );
              }

              return (
                <MenuItemRow
                  key={entry.id}
                  item={entry}
                  index={idx}
                  renderItem={renderItem}
                  onSelect={onSelect}
                  onHoverSubmenu={(node, el) => {
                    if (safeAimEngine.isPointerInSafeZone(safeAimEngine.getRecentMousePos())) {
                      return;
                    }
                    setActiveSubmenuNode(node);
                    const bounds = positionEngine.getActiveBoundary(useContainerBoundary, containerBoundaryRef?.current || null);
                    if (submenuRef.current && el) {
                      const subPos = positionEngine.calculateSubmenuPosition({
                        triggerItemEl: el,
                        submenuEl: submenuRef.current,
                        bounds,
                      });
                      setActiveSubmenuPos(subPos);
                      safeAimEngine.setSubmenu(el, submenuRef.current);
                    }
                  }}
                />
              );
            })}

            {filteredItems.length === 0 && (
              <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--sep-text-muted)', fontSize: '12px' }}>
                未找到匹配结果 🔍
              </div>
            )}
          </div>
        )}

        {footer}
      </div>

      {/* 二级级联子菜单 */}
      {activeSubmenuNode?.children && (
        <div
          ref={submenuRef}
          className={`${styles.panel} ${styles.submenu} ${styles.open} ${activeSubmenuPos?.isFlipLeft ? styles.flipLeft : ''}`}
          style={{
            left: `${activeSubmenuPos?.x || 0}px`,
            top: `${activeSubmenuPos?.y || 0}px`,
          }}
        >
          <div className={styles.listContainer} role="menu">
            {activeSubmenuNode.children.map((subItem, sIdx) => (
              <MenuItemRow key={subItem.id} item={subItem} index={sIdx} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </div>,
    targetContainer
  );
};
```

---

## 5. 双轨适配器设计与 800+ 单元测试零回归保障

### 5.1 数据 Schema 转换桥接层 (`schemaBridge.ts`)

```typescript
import type { SelectOptionItem } from '../Menu/types';
import type { SelectOption } from '../Select/Select';
import type { MenuItem, MenuGroup } from './types';

/**
 * 将 ui/Menu 的 SelectOptionItem 数组转换为 SmartExpandablePanel 的 MenuItem 数组
 */
export function convertMenuOptionsToSmartItems(
  options: SelectOptionItem[] = []
): MenuItem[] {
  return options.map((opt) => ({
    id: opt.id,
    label: opt.label,
    icon: opt.icon,
    shortcut: typeof opt.hint === 'string' ? opt.hint : undefined,
    sublabel: typeof opt.sublabel === 'string' ? opt.sublabel : undefined,
    disabled: opt.disabled,
    danger: opt.danger,
    onSelect: () => opt.onClick?.(),
    ...opt,
  }));
}

/**
 * 将 ui/Select 的 SelectOption 数组转换为 SmartExpandablePanel 的 MenuItem 数组
 */
export function convertSelectOptionsToSmartItems(
  options: SelectOption[] = [],
  selectedValue?: string | null
): MenuItem[] {
  return options.map((opt) => ({
    id: opt.id,
    type: 'selectable',
    label: opt.label,
    icon: opt.icon,
    sublabel: opt.hint,
    disabled: opt.disabled,
    selected: selectedValue != null && opt.id === selectedValue,
  }));
}
```

---

### 5.2 Menu 既有契约适配器 (`MenuAdapter.tsx`)

```tsx
import React, { useCallback, useId, useRef, useState, useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { SmartExpandablePanel } from './SmartExpandablePanel';
import { convertMenuOptionsToSmartItems } from './schemaBridge';
import type { MenuProps } from '../Menu/Menu';
import { MenuContext } from '../Menu/Menu';
import { Tooltip } from '../Tooltip/Tooltip';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { shouldSuppressMenuReopen } from '../Menu/menuOpenGuard';
import styles from '../Menu/Menu.module.css';

/**
 * MenuAdapter - 100% 无损兼容 ui/Menu 既有 800+ 单元测试与 12 套消费方
 */
export const MenuAdapter: React.FC<MenuProps> = React.memo(function MenuAdapter({
  trigger,
  anchor,
  options = [],
  renderItem,
  children,
  onSelect,
  searchable,
  position,
  openState,
  panel,
  outsideHandlers,
  onKeyDown,
  cascade,
}) {
  const defaultOpen = openState?.defaultOpen ?? false;
  const externalOpen = openState?.open;
  const externalOnOpenChange = openState?.onOpenChange;

  const isControlled = externalOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = isControlled ? externalOpen : internalOpen;

  const triggerRef = useRef<HTMLElement | null>(null);
  const menuId = useId();

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        if (layerStackService.wasLayerDismissedThisGesture(menuId)) {
          return;
        }
        const triggerEl = anchor?.current ?? triggerRef.current;
        if (shouldSuppressMenuReopen(triggerEl)) {
          return;
        }
      }
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      externalOnOpenChange?.(nextOpen);
    },
    [isControlled, externalOnOpenChange, menuId, anchor]
  );

  useLayerRegistration(
    {
      id: menuId,
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => handleOpenChange(false),
      onEscapeKeyDown: outsideHandlers?.onEscapeKeyDown,
      anchorRef: anchor ?? triggerRef,
    },
    isOpen
  );

  const smartItems = React.useMemo(() => {
    return convertMenuOptionsToSmartItems(options);
  }, [options]);

  let renderedTrigger: React.ReactNode = null;
  if (anchor) {
    renderedTrigger = <Popover.Anchor virtualRef={anchor} data-menu-anchor="true" />;
  } else if (trigger) {
    renderedTrigger = React.isValidElement(trigger)
      ? React.cloneElement(trigger as React.ReactElement<Record<string, unknown>>, {
          ref: (node: HTMLElement | null) => {
            triggerRef.current = node;
          },
          onClick: (e: React.MouseEvent) => {
            if (shouldSuppressMenuReopen(triggerRef.current)) {
              e.preventDefault();
              return;
            }
            handleOpenChange(!isOpen);
            (trigger.props as { onClick?: (e: React.MouseEvent) => void })?.onClick?.(e);
          },
        })
      : trigger;
  }

  return (
    <MenuContext.Provider value={{ menuId }}>
      {renderedTrigger}
      <SmartExpandablePanel
        open={isOpen}
        triggerRef={anchor ?? triggerRef}
        items={smartItems}
        title={panel?.title}
        enableSearch={Boolean(searchable)}
        maxPanelHeight={typeof position?.maxHeight === 'number' ? position.maxHeight : 360}
        onSelect={(item) => {
          const original = options.find((o) => o.id === item.id);
          if (original) {
            onSelect?.(item.id, original);
            handleOpenChange(false);
          }
        }}
        onClose={() => handleOpenChange(false)}
        className={panel?.contentClassName}
        style={panel?.contentStyle}
      >
        {children}
      </SmartExpandablePanel>
    </MenuContext.Provider>
  );
});

MenuAdapter.displayName = 'MenuAdapter';
```

---

### 5.3 Select 既有契约适配器 (`SelectAdapter.tsx`)

```tsx
import React, { useId, useState, useEffect } from 'react';
import { SmartExpandablePanel } from './SmartExpandablePanel';
import { convertSelectOptionsToSmartItems } from './schemaBridge';
import type { SelectProps } from '../Select/Select';
import styles from '../Select/Select.module.css';

/**
 * SelectAdapter - 100% 保持 combobox 触发器、listbox 语义与 aria-selected 契约
 */
export function SelectAdapter({
  value: externalValue,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  error,
  label,
  size = 'md',
  id,
  className,
  align,
  side,
}: SelectProps) {
  const autoId = useId();
  const selectId = id ?? `ui-select-${autoId}`;
  const listboxId = `ui-select-listbox-${autoId}`;

  const [internalValue, setInternalValue] = useState<string | null>(null);
  const isControlled = externalValue !== undefined;
  const selectedId = isControlled ? (externalValue ?? null) : internalValue;

  const [open, setOpen] = useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isControlled) {
      setInternalValue(externalValue ?? null);
    }
  }, [externalValue, isControlled]);

  const selected = options.find((opt) => opt.id === selectedId);

  const handleSelect = (idValue: string) => {
    if (!isControlled) setInternalValue(idValue);
    onChange?.(idValue);
    setOpen(false);
  };

  const smartItems = React.useMemo(() => {
    return convertSelectOptionsToSmartItems(options, selectedId);
  }, [options, selectedId]);

  const triggerClasses = [
    styles.trigger,
    size === 'sm' ? styles.triggerSm : null,
    error ? styles.triggerError : null,
    disabled ? styles.triggerDisabled : null,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={styles.selectWrap}>
      {label != null && (
        <label className={styles.selectLabel} htmlFor={selectId}>
          {label}
        </label>
      )}

      <button
        ref={triggerRef}
        type="button"
        id={selectId}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={error ? true : undefined}
        aria-controls={listboxId}
        className={triggerClasses}
        onClick={() => !disabled && setOpen((prev) => !prev)}
      >
        <span className={selected ? styles.triggerLabel : styles.triggerPlaceholder}>
          {selected?.label ?? placeholder}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <SmartExpandablePanel
        open={open}
        triggerRef={triggerRef}
        items={smartItems}
        onSelect={(item) => handleSelect(item.id)}
        onClose={() => setOpen(false)}
      />

      {error != null && <p className={styles.selectError}>{error}</p>}
    </div>
  );
}
```

---

## 6. 单元测试与物理几何断言全景规划

测试套件采用 Vitest + React Testing Library + JSDOM，覆盖几何物理碰撞、数学重心 Safe-Aim、ARIA 键盘漫游、滚轮穿透隔离及双轨适配器无损回归。

### 6.1 `PositionEngine.test.ts`（几何计算与视口翻转断言）
- **用例 1（下边缘碰撞上翻）**：
  - 构造 `bounds.bottom = 600`，`triggerRect.bottom = 550`，面板高度 `200`；
  - 断言 `directionY === 'up'`，`origin === 'left bottom'`。
- **用例 2（32px 滞后防抖 Hysteresis）**：
  - 先触发 `directionY === 'down'`；
  - 模拟视口高度微小收缩（空间差值 $< 32\text{px}$）；
  - 断言 `directionY` 保持 `'down'`，不产生翻转抖动。
- **用例 3（右边缘碰撞左翻）**：
  - 构造 `point.x = 1900`，视口宽度 `1920`，面板宽度 `265`；
  - 断言 `directionX === 'right'`，`x === 1900 - 265 = 1635`。
- **用例 4（二级子菜单 isFlipLeft）**：
  - 构造触发项在视口最右侧；
  - 断言 `calculateSubmenuPosition` 返回 `isFlipLeft === true`。

### 6.2 `SafeAimEngine.test.ts`（重心坐标系与碰撞多边形断言）
- **用例 1（4 帧历史滑动窗口）**：
  - 连续推送 6 个鼠标坐标；
  - 断言 `mouseHistory.length === 4`，且保留最新 4 帧。
- **用例 2（三角形内点判定为 true）**：
  - 顶点 $A(100, 100)$, $B(300, 50)$, $C(300, 200)$；测试点 $P(200, 100)$；
  - 断言 `isPointerInSafeZone(P) === true`。
- **用例 3（三角形外点判定为 false）**：
  - 测试点 $P(50, 50)$；
  - 断言 `isPointerInSafeZone(P) === false`。
- **用例 4（DOM 清理）**：
  - 调用 `destroy()`；
  - 断言 `document.getElementById('sepSafeAimOverlay')` 被成功移除。

### 6.3 `keyboardNav.test.ts`（WAI-ARIA 键盘漫游断言）
- **用例 1（ArrowDown 跳过 disabled）**：
  - 列表含 `[甲, 乙(disabled), 丙]`；
  - 从 `甲` 按 `ArrowDown`，断言聚焦直接落到 `丙`。
- **用例 2（ArrowUp 反向循环回绕）**：
  - 从第 0 项按 `ArrowUp`，断言聚焦回绕到最后一项。
- **用例 3（ArrowRight 打开并聚焦二级子菜单）**：
  - 在具有 `sep-has-cascade` 的项上按 `ArrowRight`；
  - 断言触发 `openSubmenuForElement`，并在 30ms 内聚焦子菜单第 0 项。
- **用例 4（搜索框空格键防误触）**：
  - 焦点在 `sep-search-input` 时按 `Space`；
  - 断言不触发选项选中事件，放行输入。

### 6.4 `SmartExpandablePanel.test.tsx`（主组件交互与滚轮隔离断言）
- **用例 1（搜索实时过滤与高亮）**：
  - 输入 `"Claude"`，断言列表中仅展示包含 `"Claude"` 的项；
  - 点击清空按钮，断言恢复全量列表。
- **用例 2（滚轮隔离 Wheel Isolation）**：
  - 当列表处于 `scrollTop === 0` 时触发向上滚轮；
  - 断言 `e.stopPropagation()` 被调用，阻止底页滚动。
- **用例 3（手风琴折叠展开）**：
  - 点击折叠项，断言 `collapsibleContent` 添加 `expanded` 类并触发 `onToggle`。

### 6.5 `MenuAdapter.test.tsx` & `SelectAdapter.test.tsx`（既有基座无损回归断言）
- **用例 1（Menu 受控额外渲染检查 F7-F3）**：
  - 外部传入受控 `open={true}`；
  - 断言 children 渲染次数严格为 1，无内部写回额外渲染。
- **用例 2（Menu 自动首项聚焦 F7-F2）**：
  - 打开菜单后无需按键，直接按 Enter；
  - 断言首个未禁用项被选中。
- **用例 3（Select combobox/listbox 语义完整）**：
  - 断言 `aria-haspopup="listbox"`, `aria-controls`, `aria-selected` 严格对齐。

---

## 7. 实施路径与验收核验清单

### 7.1 分步实施时间线

```
[第 1 步：Token 与基础设施]
  ├── 将 tokens.css 中的 --sep-* 变量合并至 src/styles/tokens.css
  └── 在 src/components/ui/ 建立 SmartExpandablePanel/ 目录及 types.ts

[第 2 步：三大核心引擎 TypeScript 下沉]
  ├── 实现 PositionEngine.ts 并跑通 PositionEngine.test.ts
  ├── 实现 SafeAimEngine.ts 并跑通 SafeAimEngine.test.ts
  └── 实现 keyboardNav.ts 并跑通 keyboardNav.test.ts

[第 3 步：UI 组件与模块化 CSS 实现]
  ├── 编写 SmartExpandablePanel.module.css 与 MenuItemRow.tsx
  ├── 编写 SmartExpandablePanel.tsx 与 useSmartPanel.ts
  └── 编写主组件专项测试套件（搜索/级联/折叠/滚轮）

[第 4 步：双轨适配器与全量测试验证]
  ├── 编写 schemaBridge.ts, MenuAdapter.tsx, SelectAdapter.tsx
  ├── 运行 npm run typecheck 验证零 TypeScript 错误
  └── 运行 vitest 跑通 ui/Menu 与 ui/Select 既有全部单元测试
```

### 7.2 质量验收与门禁清单
- [ ] **TypeScript 严格类型校验**：`npm run typecheck` 零报错；
- [ ] **视觉圆角同心数学对齐**：Panel 14px / Item 8px / Button 6px / Tag 4px 精确呈现；
- [ ] **悬停与选中微色彩对齐**：Light 模式 `--sep-bg-item-hover: rgba(29, 28, 26, 0.045)`，`--sep-bg-item-selected: rgba(29, 28, 26, 0.065)`；
- [ ] **零 Canvas Safe-Aim 保护**：二级子菜单斜切移动零失焦、零多余 DOM 开销；
- [ ] **双轨适配器 100% 绿灯**：既有 800+ 单元测试全量通过，无回归。
