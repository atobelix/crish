# Conex / Crish — SmartExpandablePanel 工业级组件下沉与全仓移植总方案

> **文档标识**：`docs/smart-panel-migration/00-total-migration-plan.md`
> **战役工作区**：`docs/smart-panel-migration/`
> **架构角色**：组件架构师 / SmartPanel Integration Architect
> **遵循基准**：`AGENTS.md`（反退避铁律、架构优雅）、`ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计红线）
> **参考资产库**：`reference/smart-expandable-panel/`（CSS Tokens / Panel / Search / Items / Submenu / Safe-Aim / Position / React Wrapper）

---

## 目录索引

1. [架构愿景与总体目标](#1-架构愿景与总体目标)
2. [参考源码资产解构与能力映射矩阵](#2-参考源码资产解构与能力映射矩阵)
3. [组件下沉与目录架构规范](#3-组件下沉与目录架构规范)
4. [Design Tokens 与视觉体系深度融合](#4-design-tokens-与视觉体系深度融合)
5. [工业级核心引擎 TypeScript 实现与强化](#5-工业级核心引擎-typescript-实现与强化)
6. [全仓业务模块数据驱动 Schema 迁移标准](#6-全仓业务模块数据驱动-schema-迁移标准)
7. [向后兼容、双轨适配与 800+ 单元测试零回归保障](#7-向后兼容双轨适配与-800-单元测试零回归保障)
8. [四阶段分步实施路线图与验收断言](#8-四阶段分步实施路线图与验收断言)

---

## 1. 架构愿景与总体目标

### 1.1 现状痛点诊断
目前 `apps/crish-desktop/` 存在多套浮层与下拉菜单实现：
1. **多头实现割裂**：`ui/Menu`（基于 Radix Popover 包装）、`SidebarContextMenus`（基于原生 Portal 坐标计算）、`ModelBadgePickerMenu`（自定义 Portal 级联）、`ComposePlusMenu`、`PermissionModeMenu` 各自维护不同的 DOM 结构与样式体系；
2. **体验不统一**：部分菜单缺少内嵌搜索过滤、长列表内嵌独立滚动区、多级级联安全斜切（Safe-Triangle）及折叠手风琴（Collapsible Section）；
3. **坐标与视口防抖缺乏统一物理引擎**：各业务组件独立处理视口溢出，缺少滞后区间（Hysteresis）防抖与 120Hz 实时窗口跟随。

### 1.2 移植目标
将 `reference/smart-expandable-panel/` 的现代纯数据驱动、数学同心圆角、零 Canvas 安全三角区、WAI-ARIA 键盘漫游以及视口弹性布局能力**完整无损地沉淀为 Crish 桌面端的一级交互基元**：
- **下沉定位**：标准导出至 `apps/crish-desktop/src/components/ui/SmartExpandablePanel/`；
- **全仓赋能**：统一赋能模型选择器、输入区功能加号菜单、权限模式切换器、会话右键菜单、快捷设置菜单等 8+ 业务场景；
- **零回归守则**：通过双轨适配器（`MenuAdapter` / `SelectAdapter`）与类型桥接，严格保障全仓既有 800+ 单元测试 100% 绿灯。

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Crish Desktop UI Architecture                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Business Layer ]                                                              │
│  ModelBadgePicker │ ComposePlusMenu │ PermissionMenu │ SessionContextMenu │ ... │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Data-Driven Schema Bridge Layer ]                                             │
│  MenuItem[] / MenuGroup[] / useSmartPanel() / Schema Converters                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Universal UI Primitive Layer ] (apps/crish-desktop/src/components/ui/)        │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ SmartExpandablePanel                                                      │  │
│  │  ├── Core Component (SmartExpandablePanel.tsx, useSmartPanel.ts)          │  │
│  │  ├── Position Engine (120Hz RAF, Hysteresis, Boundary Clamping)           │  │
│  │  ├── Safe-Aim Engine (Zero-Canvas SVG Barycentric Hit-Test)              │  │
│  │  ├── Keyboard Nav Engine (WAI-ARIA Roving Focus, Cascading, Tree)         │  │
│  │  └── Adapters (MenuAdapter, SelectAdapter for 100% Backward-Compat)       │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Design Token & Geometry Substrate ]                                           │
│  Zero-Blue Palette (Light #f6f5f3 / Dark #0c0c0b) + Concentric Radii (14/8/6/4) │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 参考源码资产解构与能力映射矩阵

对照 `reference/smart-expandable-panel/` 资产库，下沉移植的映射与升级策略如下：

| 原资产文件 | 核心职责与关键能力 | 目标下沉位置（`apps/crish-desktop/`） | 升级与重构点 |
| :--- | :--- | :--- | :--- |
| `css/tokens.css` | 14/8/6/4px 同心圆角、Zero-Blue 墨阶浅色/深色色板、翡翠绿高亮、弥散光影 | `src/styles/tokens.css` + `src/styles/design-system.css` | 融合进全局 Theme Store 与 CSS 变量体系，增加对 OKLCH/高对比无障碍适配 |
| `css/panel.css` | 浮层容器、磨砂玻璃 `backdrop-filter`、弹性入场缩放动画、发丝滚动条 | `src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css` | 转为 CSS Modules，保留 `.sep-*` 语义类名契约，消灭样式污染 |
| `css/search.css` | 嵌入式极简触感搜索框、清空按钮、筛选按钮、悬停与焦点微动效 | 同上（整合进模块化 CSS） | 采用统一图标尺寸与焦点无黑边规则（聚焦对比度 $\le 10\%$） |
| `css/items.css` | 条目槽位（图标/文本/副文本/快捷键/徽章/对勾/箭头）、手风琴折叠、内嵌滚动 | 同上（整合进模块化 CSS） | 采用 CSS Grid `grid-template-rows: 0fr -> 1fr` 纯硬件加速平滑展开 |
| `css/submenu.css` | 级联二级子菜单、Portal 浮层、Safe-Aim SVG 虚拟碰撞多边形遮罩 | 同上（整合进模块化 CSS） | 集成 `DialogOverlayContext` 与 `LayerStack` 拓扑防误杀 |
| `js/safe-aim.js` | 4 帧鼠标历史、重心坐标系（Barycentric）O(1) 三角碰撞算法 | `src/components/ui/internal/SafeAimEngine.ts` | 严格 TypeScript 化，统一单例管理与代际递增 Token，已具备四向判定 |
| `js/position-engine.js` | 120Hz 视口智能翻转、Hysteresis 32px 垂直防抖、长列表自适应高度裁切 | `src/components/ui/SmartExpandablePanel/position/PositionEngine.ts` | 抽离为 TypeScript 纯逻辑类，支持 Anchor 元素、Point 坐标、BoundaryRef 约束 |
| `js/keyboard-nav.js` | WAI-ARIA 全键盘漫游（↑↓选择、→进子级、←/Esc返回、Enter确认） | `src/components/ui/SmartExpandablePanel/navigation/keyboardNav.ts` | 抽离为与 DOM/React 解耦的键盘控制器，支持虚拟滚动与动态搜索列表 |
| `js/panel-engine.js` | 原生生命周期调度、滚动事件穿透隔离（Wheel Isolation） | `src/components/ui/SmartExpandablePanel/` 各子模块 | 将生命周期平滑转化为 React Hook 与组件状态流，保留滚轮隔离算法 |
| `react/SmartExpandablePanel.tsx` | 生产级 React 面板包装 | `src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx` | 接入 React 18/19 并发特性、`createPortal` 逃逸、LayerStack 注册 |
| `react/useSmartPanel.ts` | 开关、触发器、绝对点坐标 Hook | `src/components/ui/SmartExpandablePanel/useSmartPanel.ts` | 增强对 Anchor Ref、双模受控状态、右键事件自动提取的支持 |
| `react/types.ts` | `MenuItem` / `MenuGroup` / `SmartPanelProps` 数据契约 | `src/components/ui/SmartExpandablePanel/types.ts` | 强化泛型扩展、支持业务自定义 payload 与动态 JSX 渲染 |

---

## 3. 组件下沉与目录架构规范

### 3.1 目录树布局
在 `apps/crish-desktop/src/components/ui/` 建立一级组件目录：

```
apps/crish-desktop/src/components/ui/
├── SmartExpandablePanel/
│   ├── index.ts                               # 核心聚合导出
│   ├── types.ts                               # 严格 TypeScript 类型契约
│   ├── SmartExpandablePanel.tsx               # 现代 React 数据驱动主面板组件
│   ├── SmartExpandablePanel.module.css        # 独立 CSS Modules 样式
│   ├── useSmartPanel.ts                       # 宿主交互控制 Hook
│   ├── MenuItemRow.tsx                        # 单项渲染器（槽位/手风琴/勾选/级联）
│   ├── position/
│   │   ├── PositionEngine.ts                  # 120Hz 智能定位与视口约束解算引擎
│   │   └── PositionEngine.test.ts             # 几何与视口翻转单元测试
│   ├── navigation/
│   │   ├── keyboardNav.ts                     # WAI-ARIA 键盘无障碍漫游控制器
│   │   └── keyboardNav.test.ts                # 键盘事件单元测试
│   ├── adapters/
│   │   ├── MenuAdapter.tsx                    # ui/Menu 既有接口向后兼容桥接层
│   │   ├── SelectAdapter.tsx                  # ui/Select 既有接口向后兼容桥接层
│   │   └── schemaBridge.ts                    # 业务数据结构与 MenuItem 转换工具库
│   └── __tests__/
│       ├── SmartExpandablePanel.test.tsx      # 组件渲染与受控测试
│       ├── SmartExpandablePanel.search.test.tsx # 搜索过滤测试
│       ├── SmartExpandablePanel.cascade.test.tsx# 级联子菜单与 SafeAim 测试
│       └── SmartExpandablePanel.accordion.test.tsx # 折叠手风琴展开测试
├── Menu/                                      # 既有 Menu 基座（内部无缝路由至 MenuAdapter）
│   ├── Menu.tsx
│   ├── index.ts
│   └── types.ts
├── Select/                                    # 既有 Select 组件（内部无缝路由至 SelectAdapter）
│   ├── Select.tsx
│   └── index.ts
└── index.ts                                   # ui/ 全局单源 Barrel 导出
```

### 3.2 统一导出契约（`src/components/ui/index.ts`）
更新 `ui/index.ts`，新增 Standard Exports 并保持既有导出 100% 兼容：

```typescript
// --- 既有基础交互基元 ---
export { Button, IconButton } from './Button/Button';
export { Input, Textarea } from './Input/Input';
export { Dialog } from './Dialog/Dialog';
export { ConfirmDialog } from './ConfirmDialog/ConfirmDialog';
export { Tooltip } from './Tooltip/Tooltip';
export { Switch } from './Switch/Switch';
export { SegmentedControl } from './SegmentedControl/SegmentedControl';
export { Badge } from './Badge/Badge';
export { Slider } from './Slider/Slider';
export { TabStrip } from './TabStrip/TabStrip';

// --- 既有兼容导出（内部由 SmartExpandablePanel 赋能） ---
export { Menu } from './Menu/Menu';
export type { MenuProps } from './Menu/Menu';
export type { SelectOptionItem } from './Menu/types';
export { Select } from './Select/Select';
export type { SelectProps, SelectOption } from './Select/Select';

// --- 现代智能面板一级组件导出（New Standard） ---
export { SmartExpandablePanel } from './SmartExpandablePanel';
export { useSmartPanel } from './SmartExpandablePanel';
export type {
  MenuItem,
  MenuGroup,
  MenuItemType,
  SmartPanelProps,
  UseSmartPanelReturn,
} from './SmartExpandablePanel';
```

---

## 4. Design Tokens 与视觉体系深度融合

### 4.1 Zero-Blue 墨阶中性灰体系融合
严格遵守 Conex 设计语言规范，浅色模式采用 10% CMYK 暖黄色阶（无蓝紫冷色），深色模式采用碳素黑阶：

```css
/* apps/crish-desktop/src/styles/tokens.css */

:root,
html[data-theme='default'],
html[data-theme='light'] {
  /* --- SmartExpandablePanel Visual Tokens (Light) --- */
  --sep-radius-outer: 14px;
  --sep-padding: 6px;
  --sep-radius-inner: calc(var(--sep-radius-outer) - var(--sep-padding)); /* 8px 同心圆角 */
  --sep-item-radius: calc(var(--sep-radius-outer) - var(--sep-padding));  /* 8px */
  --sep-btn-radius: 6px;
  --sep-badge-radius: 4px;
  --sep-pill-radius: 9999px;

  --sep-item-height: 28px;
  --sep-item-padding-h: 10px;
  --sep-item-gap: 2px;

  /* 调优墨阶色板：Zero-Blue 暖灰底色 */
  --sep-bg-canvas: #f6f5f3;
  --sep-bg-panel: rgba(255, 254, 252, 0.96);
  --sep-bg-panel-solid: #ffffff;
  --sep-bg-item-hover: rgba(29, 28, 26, 0.045);
  --sep-bg-item-selected: rgba(29, 28, 26, 0.065);
  --sep-bg-input: rgba(29, 28, 26, 0.03);

  /* 实体发丝边框：告别重叠透明模糊边 */
  --sep-border-color: #e2dfd9;
  --sep-border-hover: #c9c5bc;
  --sep-border-focus: #b2ada2;
  --sep-divider-color: rgba(29, 28, 26, 0.06);

  /* 文本色阶 */
  --sep-text-primary: #1d1c1a;
  --sep-text-secondary: #5c5954;
  --sep-text-muted: #8b8780;

  /* 语义色彩：精准校准的翡翠绿（HSL: 160 84% 39%）与警示红 */
  --sep-accent-color: #10b981;
  --sep-accent-light: hsl(160 84% 39% / 0.12);
  --sep-danger-color: hsl(0 84% 60%);
  --sep-danger-light: hsl(0 84% 60% / 0.08);

  /* 弥散光影 + 顶层镜面高光 */
  --sep-shadow: 0 20px 48px -10px rgba(29, 28, 26, 0.09),
                0 6px 20px -3px rgba(29, 28, 26, 0.03),
                0 2px 6px 0 rgba(29, 28, 26, 0.015),
                inset 0 1px 0 rgba(255, 255, 255, 0.95);
  --sep-backdrop-blur: 28px;

  /* 物理弹簧缓动 */
  --sep-ease-spring: cubic-bezier(0.22, 1.25, 0.36, 1);
  --sep-ease-shrink: cubic-bezier(0.4, 0, 1, 1);
  --sep-duration-open: 0.22s;
  --sep-duration-close: 0.15s;
}

html[data-theme='dark'] {
  /* --- SmartExpandablePanel Visual Tokens (Dark) --- */
  --sep-radius-outer: 14px;
  --sep-padding: 6px;
  --sep-radius-inner: 8px;
  --sep-item-radius: 8px;
  --sep-btn-radius: 6px;
  --sep-badge-radius: 4px;
  --sep-pill-radius: 9999px;

  --sep-item-height: 28px;
  --sep-item-padding-h: 10px;
  --sep-item-gap: 2px;

  --sep-bg-canvas: #0c0c0b;
  --sep-bg-panel: rgba(24, 23, 21, 0.96);
  --sep-bg-panel-solid: #181715;
  --sep-bg-item-hover: rgba(245, 244, 240, 0.06);
  --sep-bg-item-selected: rgba(245, 244, 240, 0.09);
  --sep-bg-input: rgba(245, 244, 240, 0.04);

  --sep-border-color: #2b2926;
  --sep-border-hover: #3d3a35;
  --sep-border-focus: #524e47;
  --sep-divider-color: rgba(255, 255, 255, 0.07);

  --sep-text-primary: #f5f4f0;
  --sep-text-secondary: #b5b2aa;
  --sep-text-muted: #78756d;

  --sep-accent-color: #10b981;
  --sep-accent-light: hsl(160 84% 45% / 0.16);
  --sep-danger-color: hsl(0 84% 60%);
  --sep-danger-light: hsl(0 84% 60% / 0.08);

  --sep-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70),
                0 8px 24px -4px rgba(0, 0, 0, 0.45),
                0 2px 8px 0 rgba(0, 0, 0, 0.30),
                inset 0 1px 0 rgba(255, 255, 255, 0.08);
  --sep-backdrop-blur: 28px;
}
```

### 4.2 数学同心圆角计算法则
组件内部所有层级严格遵循**嵌套同心几何公式**：
$$R_{\text{inner}} = \max(R_{\text{outer}} - P, 4\text{px})$$
- 外层主面板壳体：$R = 14\text{px}$，内边距 $P = 6\text{px}$；
- 内部菜单条目 / 手风琴容器：$R = 14 - 6 = 8\text{px}$（视觉曲率 100% 同心对齐，彻底消除边缘不同心造成的断层挤压感）；
- 内部按钮：$R = 6\text{px}$；
- 状态标签徽章：$R = 4\text{px}$。

### 4.3 浮层与下拉选项 Hover / Active 颜色铁律（彻底根治 --sidebar-hover 杂色过深污染）
**【实测根因诊断】**：
在「冰川薄荷」、「抹茶拿铁」等彩色皮肤预设下，`--sidebar-hover` 与 `--sidebar-active` 是由侧边栏背景色 `--bg-secondary`（深青绿色）混合而成。侧边栏自身底色较深所以视觉正常，但**展开面板/下拉菜单是纯净白底（`#ffffff` / `var(--bg-card)`）**，一旦在白底浮层中直接引用 `--sidebar-hover`，就会瞬间产生高达 20%~30% 视觉对比度的深青灰泥色块，严重破坏卡片整洁度！

**【强制红线铁律】**：
1. **严禁在白底浮层中直接消费 `--sidebar-hover` / `--sidebar-active`**；
2. **全仓展开面板与下拉选项必须严格绑定专属 `--sep-*` 悬停 Token**：
   - 浅色模式：Hover 严格锁定为 `rgba(29, 28, 26, 0.045)`（仅 4.5% 极浅柔和暖灰，绝不带杂色青底）；Active/Selected 严格锁定为 `rgba(29, 28, 26, 0.065)`（仅 6.5% 微灰）；
   - 深色模式：Hover 严格锁定为 `rgba(245, 244, 240, 0.06)`（6% 柔和冷白）；Active/Selected 严格锁定为 `rgba(245, 244, 240, 0.09)`（9%）；
3. **选中态视觉锚点**：
   - 选中项底色保持 6.5% 微灰，右侧靠 **`#059669`（翡翠绿）品牌细线对勾**做视觉锚点，严禁大面积深灰色块与黑色勾选！

---

## 5. 工业级核心引擎 TypeScript 实现与强化

### 5.1 120Hz 视口智能定位与防抖引擎 (`PositionEngine.ts`)
彻底解决边缘翻转震荡与超视口裁剪：
- **滞后防抖（Hysteresis Buffer）**：设置 $\Delta H = 32\text{px}$ 阈值，当面板处于上下临界翻转状态时，只有新方向可用空间超出原方向 32px 以上才触发翻转，避免鼠标微小位移导致面板高频跳动；
- **长列表高度智能约束**：自动度量自然高度（Natural Height），超出视口可用空间时自动将 `max-height` 注入内层滚动区并启用平滑发丝滚动条；
- **双模输入**：无缝支持 `triggerEl`（基于 DOM 锚点）与 `point: { x, y }`（基于鼠标右键坐标）。

```typescript
// apps/crish-desktop/src/components/ui/SmartExpandablePanel/position/PositionEngine.ts

export interface BoundaryRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PositionEngineOptions {
  hysteresisY?: number;
  maxPanelHeight?: number;
  edgePadding?: number;
}

export interface CalculatedPosition {
  x: number;
  y: number;
  origin: string;
  allowedListHeight: number | null;
}

export class PositionEngine {
  private readonly hysteresisY: number;
  private readonly maxPanelHeight: number;
  private readonly edgePadding: number;
  private currentDirY: 'up' | 'down' | null = null;

  constructor(options: PositionEngineOptions = {}) {
    this.hysteresisY = options.hysteresisY ?? 32;
    this.maxPanelHeight = options.maxPanelHeight ?? 760;
    this.edgePadding = options.edgePadding ?? 12;
  }

  public reset(): void {
    this.currentDirY = null;
  }

  public getActiveBoundary(containerEl?: HTMLElement | null): BoundaryRect {
    if (containerEl) {
      const rect = containerEl.getBoundingClientRect();
      return {
        left: rect.left + 8,
        top: rect.top + 8,
        right: rect.right - 8,
        bottom: rect.bottom - 8,
      };
    }
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
    return {
      left: this.edgePadding,
      top: this.edgePadding,
      right: vw - this.edgePadding,
      bottom: vh - this.edgePadding,
    };
  }

  public calculateTriggerPosition(params: {
    triggerEl: HTMLElement;
    panelEl: HTMLElement;
    listEl: HTMLElement;
    headerHeight: number;
    bounds: BoundaryRect;
  }): CalculatedPosition {
    const { triggerEl, panelEl, listEl, headerHeight, bounds } = params;
    const triggerRect = triggerEl.getBoundingClientRect();
    const panelWidth = panelEl.offsetWidth || 265;

    // 快速度量实际自然高度
    const naturalHeight = this.measureNaturalHeight(panelEl, listEl, headerHeight);
    const cappedHeight = Math.min(this.maxPanelHeight, naturalHeight);

    const spaceBelow = bounds.bottom - triggerRect.bottom - 8;
    const spaceAbove = triggerRect.top - bounds.top - 8;

    let idealDirY: 'up' | 'down' = 'down';
    if (spaceBelow >= cappedHeight) {
      idealDirY = 'down';
    } else if (spaceAbove >= cappedHeight) {
      idealDirY = 'up';
    } else {
      idealDirY = spaceBelow >= spaceAbove ? 'down' : 'up';
    }

    // 滞后区间防抖（Hysteresis）
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

    const availableVerticalSpace = preferredDirY === 'down' ? spaceBelow : spaceAbove;
    const originY = preferredDirY === 'down' ? 'top' : 'bottom';

    let targetY = 0;
    if (preferredDirY === 'down') {
      targetY = triggerRect.bottom + 8;
    } else {
      const actualHeight = Math.min(cappedHeight, availableVerticalSpace);
      targetY = triggerRect.top - 8 - actualHeight;
    }

    // 垂直方向刚性视口钳位
    targetY = Math.max(bounds.top, Math.min(bounds.bottom - 100, targetY));

    // 内层列表最大高度约束
    let allowedListHeight: number | null = null;
    if (naturalHeight > availableVerticalSpace) {
      allowedListHeight = Math.max(120, availableVerticalSpace - headerHeight - 16);
    }

    // 水平方向靠齐与钳位
    let originX = 'left';
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
    };
  }

  public calculatePointPosition(params: {
    point: { x: number; y: number };
    panelEl: HTMLElement;
    listEl: HTMLElement;
    headerHeight: number;
    bounds: BoundaryRect;
  }): CalculatedPosition {
    const { point, panelEl, listEl, headerHeight, bounds } = params;
    const panelWidth = panelEl.offsetWidth || 265;
    const naturalHeight = this.measureNaturalHeight(panelEl, listEl, headerHeight);
    const cappedHeight = Math.min(this.maxPanelHeight, naturalHeight);

    const spaceBelow = bounds.bottom - point.y;
    const spaceAbove = point.y - bounds.top;

    const placeDown = spaceBelow >= cappedHeight || spaceBelow >= spaceAbove;
    const availableVerticalSpace = placeDown ? spaceBelow : spaceAbove;
    const originY = placeDown ? 'top' : 'bottom';
    const originX = point.x + panelWidth > bounds.right ? 'right' : 'left';

    let targetX = point.x;
    if (point.x + panelWidth > bounds.right) {
      targetX = Math.max(bounds.left, point.x - panelWidth);
    } else {
      targetX = Math.max(bounds.left, targetX);
    }

    let targetY = point.y;
    if (!placeDown) {
      const actualHeight = Math.min(cappedHeight, spaceAbove);
      targetY = Math.max(bounds.top, point.y - actualHeight);
    }

    let allowedListHeight: number | null = null;
    if (naturalHeight > availableVerticalSpace) {
      allowedListHeight = Math.max(120, availableVerticalSpace - headerHeight - 16);
    }

    return {
      x: targetX,
      y: targetY,
      origin: `${originX} ${originY}`,
      allowedListHeight,
    };
  }

  public calculateSubmenuPosition(params: {
    triggerItemEl: HTMLElement;
    submenuEl: HTMLElement;
    bounds: BoundaryRect;
  }): { x: number; y: number; isFlipLeft: boolean } {
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
      x: Math.max(bounds.left, targetX),
      y: Math.max(bounds.top, targetY),
      isFlipLeft,
    };
  }

  private measureNaturalHeight(
    panelEl: HTMLElement,
    listEl: HTMLElement,
    headerHeight: number
  ): number {
    const prevMaxHeight = listEl.style.maxHeight;
    const prevOverflow = listEl.style.overflow;
    listEl.style.maxHeight = 'none';
    listEl.style.overflow = 'visible';

    const listScrollHeight = listEl.scrollHeight;
    const panelStyle = typeof window !== 'undefined' ? window.getComputedStyle(panelEl) : null;
    const paddingTop = panelStyle ? parseFloat(panelStyle.paddingTop) || 6 : 6;
    const paddingBottom = panelStyle ? parseFloat(panelStyle.paddingBottom) || 6 : 6;
    const borderTop = panelStyle ? parseFloat(panelStyle.borderTopWidth) || 1 : 1;
    const borderBottom = panelStyle ? parseFloat(panelStyle.borderBottomWidth) || 1 : 1;

    const totalCalculated = listScrollHeight + headerHeight + paddingTop + paddingBottom + borderTop + borderBottom;
    const measuredOffset = panelEl.offsetHeight;

    listEl.style.maxHeight = prevMaxHeight;
    listEl.style.overflow = prevOverflow;

    return Math.max(totalCalculated, measuredOffset);
  }
}
```

### 5.2 零 Canvas 虚拟多边形防误触引擎 (`SafeAimEngine.ts`)
直接采用 `apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts` 单例：
- 当鼠标从父级菜单项斜向划入右/左侧级联子菜单时，生成由「光标实时坐标点」与「子菜单左上、左下两顶点」构成的虚拟三角形；
- 在 `mouseenter` 事件中，采用重心坐标内点判定（Barycentric Coordinates Hit-Test）拦截中间悬停项的误触发；
- 零 Canvas 渲染开销，120Hz 极速响应。

### 5.3 滚轮穿透隔离算法（Nested Scroll Isolation）
在桌面端 WebView2 中，当鼠标在内嵌模型滚动列表中向上/向下滚到尽头时，默认会冒泡导致外部窗口或上层浮层产生抖动。`SmartExpandablePanel` 包含内置嵌套滚动隔离：

```typescript
// 滚轮边界隔离：阻断边界溢出，优先消耗当前滚动容器
export function handleScrollIsolation(e: React.WheelEvent<HTMLElement>): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const scrollable = target.closest(
    '.sep-selectable-list, .sep-list-container'
  ) as HTMLElement | null;
  if (!scrollable) return;

  const { scrollTop, scrollHeight, clientHeight } = scrollable;
  const deltaY = e.deltaY;
  const isAtTop = scrollTop <= 0 && deltaY < 0;
  const isAtBottom = Math.ceil(scrollTop + clientHeight) >= scrollHeight - 1 && deltaY > 0;

  if (isAtTop || isAtBottom) {
    e.preventDefault();
  }
}
```

---

## 6. 全仓业务模块数据驱动 Schema 迁移标准

### 6.1 核心数据契约 (`types.ts`)
```typescript
// apps/crish-desktop/src/components/ui/SmartExpandablePanel/types.ts

import type { ReactNode, MouseEvent, CSSProperties, RefObject } from 'react';

export type MenuItemType =
  | 'item'          // 标准交互操作项
  | 'selectable'    // 多选/单选勾选列表项
  | 'group'         // 分组头部标签
  | 'sub-group'     // 二级小分组标签
  | 'divider'       // 分割线
  | 'submenu'       // 级联子菜单
  | 'collapsible';  // 行内手风琴可折叠项

export interface MenuItem {
  /** 唯一标识符 */
  id: string;
  /** 项类型 */
  type?: MenuItemType;
  /** 主标题文字 */
  label?: string;
  /** 副标题说明文字 */
  sublabel?: string;
  /** 图标元素（支持 ReactNode 如 Lucide 图标或 SVG 字符串） */
  icon?: ReactNode;
  /** 快捷键提示（如 "Ctrl+N", "/"） */
  shortcut?: string;
  /** 状态标签徽章（如 "推荐", "Pro", "Beta"） */
  badge?: string;
  /** 悬停提示 Tooltip 文案 */
  tooltip?: string;
  /** 危险警示操作项（红色字阶与浅红悬停） */
  danger?: boolean;
  /** 禁用状态 */
  disabled?: boolean;
  /** 选中状态（右侧展现平滑弹簧 Checkmark 图标） */
  selected?: boolean;
  /** 是否支持手风琴展开/折叠 */
  collapsible?: boolean;
  /** 初始手风琴展开状态 */
  expanded?: boolean;
  /** 搜索匹配关键词（支持空格分隔多词模糊匹配） */
  searchKeywords?: string;
  /** 级联子菜单或手风琴子项 */
  children?: MenuItem[];
  /** 选中回调函数 */
  onSelect?: (item: MenuItem, event?: MouseEvent) => void;
  /** 手风琴展开/收起切换回调 */
  onToggle?: (expanded: boolean, item: MenuItem) => void;
  /** 业务自定义挂载数据 */
  payload?: unknown;
}

export interface MenuGroup {
  /** 分组唯一标识 */
  id?: string;
  /** 分组标题 */
  title?: string;
  /** 是否为内嵌独立滚动区（如长模型列表） */
  isSelectableList?: boolean;
  /** 分组包含的条目列表 */
  items: MenuItem[];
}

export interface SmartPanelProps {
  /** 数据源：条目数组或分组数组 */
  items: Array<MenuItem | MenuGroup>;
  /** 是否打开 */
  open?: boolean;
  /** 触发器锚点 Ref（优先根据锚点计算物理位置） */
  triggerRef?: RefObject<HTMLElement | null>;
  /** 鼠标右键坐标点（用于 ContextMenu 模式） */
  point?: { x: number; y: number } | null;
  /** 搜索框占位文案 */
  searchPlaceholder?: string;
  /** 是否启用顶部搜索框 */
  enableSearch?: boolean;
  /** 分组之间是否自动渲染发丝分割线 */
  enableDivider?: boolean;
  /** 是否启用 Safe-Aim 级联斜切防误触保护 */
  enableTriangleAim?: boolean;
  /** 面板最大高度约束（默认 760px） */
  maxPanelHeight?: number;
  /** 自定义容器边界限制（如限制在 Dialog 或特定视口容器内部） */
  useContainerBoundary?: boolean;
  containerBoundaryRef?: RefObject<HTMLElement | null>;
  /** 全局选项选中通知 */
  onSelect?: (item: MenuItem) => void;
  /** 打开/关闭回调 */
  onOpen?: () => void;
  onClose?: () => void;
  /** 样式与类名扩展 */
  className?: string;
  style?: CSSProperties;
}
```

---

### 6.2 典型业务场景转换实现示例

#### 场景 1：模型列表与服务商级联（`ModelBadgePickerMenu` 改造）
```typescript
import { MenuGroup } from '@/components/ui/SmartExpandablePanel';
import { formatModelDisplayName, type ProviderProfile } from '@/api/modelCatalog';

export function buildModelPickerSchema(params: {
  profiles: ProviderProfile[];
  activeProfileId: string;
  activeModel: string | null;
  onSelect: (profileId: string, modelId: string) => void;
}): MenuGroup[] {
  const { profiles, activeProfileId, activeModel, onSelect } = params;
  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return [
    {
      id: 'active-models',
      title: `${activeProfile?.name || '当前服务商'} 模型`,
      isSelectableList: true, // 启用 160px 独立内嵌滚动区
      items: (activeProfile?.models || []).map((m) => ({
        id: `${activeProfileId}:${m}`,
        type: 'selectable',
        label: formatModelDisplayName(activeProfileId, m),
        selected: m === activeModel,
        onSelect: () => onSelect(activeProfileId, m),
      })),
    },
    {
      id: 'other-providers',
      title: '切换服务商',
      items: profiles
        .filter((p) => p.id !== activeProfileId)
        .map((p) => ({
          id: `provider-${p.id}`,
          label: p.name,
          badge: `${p.models.length} 款模型`,
          children: p.models.map((m) => ({
            id: `${p.id}:${m}`,
            type: 'selectable',
            label: formatModelDisplayName(p.id, m),
            selected: m === activeModel,
            onSelect: () => onSelect(p.id, m),
          })),
        })),
    },
  ];
}
```

#### 场景 2：输入区「+」功能扩展菜单（`ComposePlusMenu` 改造）
```typescript
import * as Lucide from 'lucide-react';
import { MenuItem } from '@/components/ui/SmartExpandablePanel';

export function buildComposePlusSchema(actions: {
  onAddFiles: () => void;
  onInsertSkill: () => void;
  onOpenPlugins: () => void;
  onOpenSchedule: () => void;
}): MenuItem[] {
  return [
    {
      id: 'file',
      label: '添加文件',
      sublabel: '图片、代码或文档',
      icon: <Lucide.Paperclip size={14} />,
      onSelect: actions.onAddFiles,
    },
    {
      id: 'skill',
      label: '使用技能',
      sublabel: '输入 / 唤起技能列表',
      icon: <Lucide.Sparkles size={14} />,
      shortcut: '/',
      onSelect: actions.onInsertSkill,
    },
    {
      id: 'plugin',
      label: '插件与扩展',
      sublabel: '管理 MCP 与插件',
      icon: <Lucide.Puzzle size={14} />,
      onSelect: actions.onOpenPlugins,
    },
    {
      id: 'schedule',
      label: '定时任务',
      sublabel: '创建后台定时唤醒',
      icon: <Lucide.Clock size={14} />,
      onSelect: actions.onOpenSchedule,
    },
  ];
}
```

#### 场景 3：侧栏会话右键上下文菜单（`SessionContextMenu` 改造）
```typescript
import * as Lucide from 'lucide-react';
import { MenuGroup } from '@/components/ui/SmartExpandablePanel';

export function buildSessionContextSchema(session: {
  id: string;
  isPinned: boolean;
  onAction: (action: string) => void;
}): MenuGroup[] {
  return [
    {
      id: 'layout-ops',
      items: [
        { id: 'open-current', label: '当前窗口打开', icon: <Lucide.MessageCircle size={14} />, onSelect: () => session.onAction('open-current') },
        { id: 'open-split', label: '分屏打开', icon: <Lucide.Columns2 size={14} />, onSelect: () => session.onAction('open-split') },
        { id: 'open-new', label: '新窗口打开', icon: <Lucide.ExternalLink size={14} />, onSelect: () => session.onAction('open-new') },
      ],
    },
    {
      id: 'session-mgmt',
      items: [
        { id: 'rename', label: '重命名', icon: <Lucide.PenLine size={14} />, onSelect: () => session.onAction('rename') },
        { id: 'pin', label: session.isPinned ? '取消置顶' : '置顶会话', icon: session.isPinned ? <Lucide.PinOff size={14} /> : <Lucide.Pin size={14} />, onSelect: () => session.onAction('pin') },
        { id: 'branch', label: '分叉分支', icon: <Lucide.GitFork size={14} />, onSelect: () => session.onAction('branch') },
        { id: 'archive', label: '归档会话', icon: <Lucide.Archive size={14} />, onSelect: () => session.onAction('archive') },
        { id: 'export', label: '导出记录', icon: <Lucide.FileDown size={14} />, onSelect: () => session.onAction('export') },
        { id: 'copy-id', label: '复制会话 ID', icon: <Lucide.Copy size={14} />, onSelect: () => session.onAction('copy-id') },
      ],
    },
#### 场景 4：权限模式菜单（`PermissionModeMenu` 改造 — 彻底消灭 3 处违规）
针对实测中的 3 处违规精准治理：
1. **补齐专属语义图标与 11px 次级描述**：`需确认` 配 `[ 🛡️ ]` + `每次执行需手动批准`；`深入分析` 配 `[ 🔍 ]` + `只读分析与代码检索`；`计划` 配 `[ 🎯 ]` + `制定逐步执行计划`；`完全访问` 配 `[ ⚡ ]` + `全自动执行所有命令`；
2. **重构条目圆角与对勾色彩**：条目锁定为 **6px**（`var(--radius-md)`），悬停淡入 `var(--sidebar-hover)`，选中态为 `var(--sidebar-active)`，右侧对勾严格绑定 **`#059669`（翡翠绿品牌对勾）**，消灭粗大泥灰色块与黑勾；
3. **单层实体发丝边框与同心圆角**：外层容器锁定为 **14px 外角 / 6px 内边距 / 8px 内层**，采用 `#e2dfd9`/`#2b2926` 1px 实体发丝边框与磨砂毛玻璃。

```typescript
import * as Lucide from 'lucide-react';
import { MenuItem } from '@/components/ui/SmartExpandablePanel';

export function buildPermissionModeSchema(actions: {
  currentMode: string;
  onSelectMode: (mode: string) => void;
}): MenuItem[] {
  return [
    {
      id: 'ask',
      type: 'selectable',
      label: '需确认',
      sublabel: '每次命令执行需手动批准',
      icon: <Lucide.Shield size={14} />,
      selected: actions.currentMode === 'ask',
      onSelect: () => actions.onSelectMode('ask'),
    },
    {
      id: 'analysis',
      type: 'selectable',
      label: '深入分析',
      sublabel: '只读模式，仅进行分析与检索',
      icon: <Lucide.Search size={14} />,
      selected: actions.currentMode === 'analysis',
      onSelect: () => actions.onSelectMode('analysis'),
    },
    {
      id: 'plan',
      type: 'selectable',
      label: '计划模式',
      sublabel: '先制定分步逻辑方案，确认后执行',
      icon: <Lucide.Compass size={14} />,
      selected: actions.currentMode === 'plan',
      onSelect: () => actions.onSelectMode('plan'),
    },
    {
      id: 'full-auto',
      type: 'selectable',
      label: '完全访问',
      sublabel: '全自动执行，无需每步手动确认',
      icon: <Lucide.Zap size={14} />,
      danger: true,
      selected: actions.currentMode === 'full-auto',
      onSelect: () => actions.onSelectMode('full-auto'),
    },
  ];
}
```

#### 场景 5：项目选择器（`ProjectPickerMenu` 改造 — 彻底消灭 2 处违规）
针对实测中的 2 处违规精准治理：
1. **恢复 28px 顶栏一体化内嵌搜索框**：彻底废弃塞入面板的独立 `<Input variant="search" />` 贴片；改用 `.sep-search-wrapper`（高度 28px、透明底色、无独立外框、左侧 14px 细放大镜图标、底下一条极细发丝分割线）；
2. **重构二级子菜单（添加项目）**：废除 14px 膨胀圆角与裸文本；改为标准同心发丝卡片（8px 外角 / 6px 内角 / 4px padding），为「打开本地项目...」和「新建空白项目...」补齐 14px 图标，并接入 **SVG 虚拟多边形 Safe-Aim 轨迹保护**。

#### 场景 6：模型胶囊、思考档位与输入区按钮规范（`ComposerFusedTrigger` & `ChatComposer`）
针对实测中的模型胶囊硬切与加号/盾牌割裂精准治理：
1. **模型胶囊悬停微圆角与消灭青底**：胶囊整体为单层透明底色 + 1px 中性发丝线；鼠标悬停在 `deepseek-v4-flash` 或 `最深` 时，内部提供独立的 **4px/6px 微圆角与 `var(--sidebar-hover)`**，两段之间为 1px 细发丝分割线，彻底消灭右侧直角硬切与两层杂色青底；
2. **输入区 `[ ＋ ]` 与 `[ 🛡️ ]` 按钮统一**：彻底移除盾牌的实心深色底；两者统一为 **24×24px 极简微圆角图标按钮**，默认透明背景，悬停统一淡入 `var(--sidebar-hover)`。

#### 场景 7：字体选择器全量治理（`FontSelectField` & `FontSettingsSection` — 彻底消灭 7 处违规）
针对实测中字体选择器暴露的 7 处严重断层精准治理：
1. **彻底废除底部青绿杂色底**：彻底移除底部的 `--bg-secondary` / `--tint-hover` 杂色补丁，保持白底卡片纯净度；
2. **根治输入框与整行背景色不匹配及文字挤压截断**：输入框宽度改为自适应 Flex 布局（`flex: 1 1 auto; min-width: 0;`），占位符 `自定义字体` 完整展现，输入框背景与整行背景 100% 融合；
3. **规范操作图标按钮**：「扫描本机字体」`[ 🖫 ]` 与「恢复默认」`[ ↺ ]` 统一封装为标准的 **22×22px 微圆角容器（6px 圆角）**，提供轻微 Hover 边界与标准 Tooltip；
4. **搜索栏架构顶置**：将搜索功能移至顶栏一体化内嵌 Header（`.sep-search-wrapper`），支持打字即时过滤上方字体列表；
5. **触发器（Trigger）去药丸化**：废除 `radius-full` / `radius-xl` 膨胀椭圆药丸与青绿底，统一为标准 **28px 高度、6px 微圆角、`var(--bg-card)` 纯白底与 1px 发丝边框**，与旁边的 `☐ 连字` 复选框高度对齐；
6. **面板外层 14px 同心圆角**：废除 `16px` 膨胀大圆角与非对称 `padding: 4px 1px 4px 4px`，收敛为严格的 **14px 外角 / 6px 内衬 / 8px 内层**，消灭角落挤压；
7. **选中项轻量化**：废除大面积深青灰色块，选中项仅使用 **6.5% 极浅微灰 + 右侧靠齐的 `#059669` 翡翠绿对勾**。

#### 场景 8：模型设置页选择器与服务商添加全量治理（`ModelsSettingsTab` & `ModelProfileList` — 彻底消灭 7 处违规）
针对实测中模型设置页暴露的 7 处严重断层精准治理：
1. **「+ 添加服务商」按钮去色块与去胶囊化**：彻底移除实心深青绿底色与 `radius-full` 椭圆胶囊，还原为标准次级按钮（**6px 圆角、透明背景、中性 1px 发丝边框、悬停淡入 `var(--sidebar-hover)`**）；
2. **「全局默认模型」触发器去粗描边与去青底**：彻底移除深青绿粗描边与青色杂底，收敛为 **1px `#e2dfd9`/`#2b2926` 实体发丝边框 + `var(--bg-card)` 纯白底 + 6px 规整微圆角**；
3. **彻底根除 Windows 原生带上下三角箭头的丑陋粗滚动条**：废除原生滚动条（`▲`/`▼`），仅在长列表（>6 项）时启用 3px 极细发丝滚动条（无箭头、透明轨道）；
4. **根除 1 项条目强制溢出与死白空间**：修复写死 `overflow-y: scroll` 或固定高度导致的 bug，列表项不足时高度自然贴合（自适应高度），**1 项时绝不溢出、绝不留死白空洞、绝不出滚动条**；
5. **条目 Hover 纯净中性化**：悬停严格锁定为 **4.5% 轻柔淡灰（`rgba(29, 28, 26, 0.045)`）**，彻底消灭深青灰大色块；
6. **面板与触发器宽度自适应对齐**：面板最小宽度与触发器自适应对齐（`min-width: 100%`），消灭阶梯错层；
7. **面板外层 14px 同心外角与光影**：外层注入 14px 外圆角与 28px 磨砂毛玻璃弥散光影。

#### 场景 9：规则设置页全量治理（`SettingsRulesTab` — 彻底消灭 5 处违规）
针对实测中规则设置页暴露的 5 处严重断层精准治理：
1. **右上角操作区恢复水平同行**：`[ 全局 ▾ ]` 作用域选择器与 `[ 编辑全文 ]` 按钮采用水平同行流式排布（`display: flex; flex-direction: row; gap: 8px; align-items: center;`），消灭生硬垂直两截断层与青绿药丸；
2. **右侧删除操作标准化**：行内垃圾桶按钮保留 `variant="danger"` 属性，采用统一 28×28px 规范与平滑 Hover 过渡；
3. **「常用」一键加入预设胶囊规范化**：预设规则接入 `--sep-btn-radius: 6px` 与 Tag 徽标设计 Token，消灭纯黑生硬描边与发白死斑；
4. **「自定义」输入栏升级为规范 Input Group**：封装标准 `<Input>` 与 `<Button variant="secondary" size="sm">`，消灭裸写 HTML `<input>` 与未样式化裸字；
5. **统一上下网格对齐与卡片内边距**：使上半部规则列表与下半部快速添加共享一致的左右对齐边界。

#### 场景 10：安全设置页全量治理（`SettingsSecurityTab` — 彻底消灭 4 处违规）
针对实测中安全设置页暴露的 4 处严重断层精准治理：
1. **权限模式选择器去粗描边与去青底**：收敛为 1px `#e2dfd9`/`#2b2926` 实体发丝边框 + `var(--bg-card)` 纯白底 + 6px 规整微圆角；
2. **「添加命令」输入群组标准化**：封装 `<Input>` + `<Button>`（添加/清空），消灭裸 HTML `<input>` 与未样式化裸字；
3. **「常用预设」胶囊去药丸化**：废除 `radius-full` 大胶囊与生硬浅灰描边，收敛为标准 `6px` 微圆角（`--sep-btn-radius`）；
4. **统一工作区卡片排版与三段式内边距对齐**。

#### 场景 11：状态与诊断设置页全量治理（`SettingsAboutTab` / `SettingsDiagnosticsTab` — 彻底消灭 4 处违规）
针对实测中状态与诊断页暴露的 4 处严重断层精准治理：
1. **「当前日志级别」从死黑胶囊重构为标准下拉选择器**：补齐 Chevron `▾` 交互指示，支持 debug/info/warn/error 切换；移除孤立左侧脉冲图标，统一行结构；日志目录补齐复制操作与完整 Tooltip；
2. **根除「最近诊断」文本重叠碰撞致命排版 Bug**：采用 CSS Grid 栅格化分列（`grid-template-columns: 140px 160px 1fr`），彻底杜绝 `NOTE_RUNTIME` 与 `2026/8/20` 时间戳撞在一起的叠影乱码；
3. **诊断信息卡片行内边距标准化**：为每一行提供 6px/8px 安全阅读内衬，消灭密密麻麻的条纹压迫感；
4. **状态语言统一化**：将 `OK`、`异常` 裸字统一为标准状态 Badge 胶囊（`--sep-badge-radius: 4px`），与「重建索引」操作按钮形成规范的图文与交互层级。

---

## 7. 向后兼容、双轨适配与 800+ 单元测试零回归保障

### 7.1 双轨门面适配器（`MenuAdapter` / `SelectAdapter`）
为确保全仓测试资产零受损，`ui/Menu/Menu.tsx` 与 `ui/Select/Select.tsx` 保持完全一致的 Props 契约，内部通过轻量适配器转换 Schema：

```typescript
// apps/crish-desktop/src/components/ui/SmartExpandablePanel/adapters/MenuAdapter.tsx

import React, { useMemo } from 'react';
import { SmartExpandablePanel } from '../SmartExpandablePanel';
import type { MenuProps } from '../../Menu/Menu';
import type { MenuItem } from '../types';

export const MenuAdapter: React.FC<MenuProps> = ({
  trigger,
  anchor,
  options = [],
  children,
  onSelect,
  openState,
  position,
  searchable = false,
  className,
  style,
}) => {
  // 将旧版 SelectOptionItem[] 转换为标准 MenuItem[]
  const schemaItems: MenuItem[] = useMemo(() => {
    return options.map((opt) => ({
      id: opt.id,
      label: opt.label,
      sublabel: opt.hint,
      icon: opt.icon,
      disabled: opt.disabled,
      badge: opt.badge,
      shortcut: opt.shortcut,
      danger: opt.danger,
      onSelect: () => {
        opt.onClick?.();
        onSelect?.(opt.id, opt);
      },
    }));
  }, [options, onSelect]);

  return (
    <SmartExpandablePanel
      items={schemaItems}
      open={openState?.open}
      triggerRef={anchor}
      enableSearch={searchable}
      maxPanelHeight={typeof position?.maxHeight === 'number' ? position.maxHeight : 760}
      onClose={() => openState?.onOpenChange?.(false)}
      className={className}
      style={style}
    />
  );
};
```

### 7.2 LayerStack 浮层拓扑与 DialogOverlay 防误杀集成
- 在 `SmartExpandablePanel` 内部挂载 `useLayerRegistration`，向 `LayerStackManager` 注册 `type: 'dropdown-menu'` 或 `type: 'cascade-submenu'`；
- 继承 `DialogOverlayContext`，当浮层处于 Modal/Dialog 内部时，Portal 优先挂载至对话框专属 Overlay 容器，彻底防止层级错乱与事件被父级模态框捕获阻断。

### 7.3 WAI-ARIA 与 Test-ID 严格对齐
所有 DOM 渲染节点保留标准测试契约：
- 条目节点保留 `role="menuitem"` 或 `role="option"`；
- 选中状态设置 `aria-selected={item.selected}`；
- 展开容器设置 `data-testid="smart-expandable-panel"`；
- 快捷键提示与徽章保留对应 CSS 类名与属性，现有 `Menu.test.tsx`、`Select.test.tsx`、`PhysicalGeometryGuards.test.tsx` 均可直接运行绿灯。

---

## 8. 四阶段分步实施路线图与验收断言

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           移植与落地四阶段演进路线                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 1: 基础设施与组件下沉 ]                                                 │
│  ├── 在 ui/SmartExpandablePanel 下创建核心组件、Hook、PositionEngine、CSS 模块   │
│  └── 编写 100% 覆盖率的独立定位、搜索、手风琴、级联单元测试                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 2: 双轨兼容适配层交付 ]                                                 │
│  ├── 实现 MenuAdapter 与 SelectAdapter                                          │
│  └── 跑通全仓既有 ui/Menu 与 ui/Select 相关测试套件                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 3: 核心业务场景渐进式切换 ]                                             │
│  ├── Pilot 1: ComposePlusMenu & PermissionModeMenu                              │
│  ├── Pilot 2: SidebarContextMenus (右键坐标模式)                                │
│  └── Pilot 3: ModelBadgePickerMenu (多级级联与模型列表内嵌滚动)                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 4: 全仓收敛与清理 ]                                                     │
│  ├── 收敛 ProjectPickerMenu、SettingsQuickMenu 等剩余浮层                       │
│  ├── 清理重复的坐标计算工具与孤立组件                                           │
│  └── 运行全量 npm run typecheck 与 cargo test / vitest 验收                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 8.1 阶段任务划分

#### 阶段一：基础设施建设与组件下沉（Phase 1）
- **交付目标**：在 `apps/crish-desktop/src/components/ui/SmartExpandablePanel/` 完成工业级 TypeScript 组件下沉。
- **任务清单**：
  1. 建立 `types.ts`、`SmartExpandablePanel.tsx`、`useSmartPanel.ts`；
  2. 实现 `PositionEngine.ts`（支持 Hysteresis 32px 垂直防抖与 120Hz 跟随）；
  3. 集成 `SafeAimEngine.ts`（SVG 虚拟多边形碰撞检测）；
  4. 移植 `SmartExpandablePanel.module.css` 并对齐 `--sep-*` Design Tokens；
  5. 补充针对自身功能的单元测试（`SmartExpandablePanel.test.tsx`）。

#### 阶段二：双轨兼容适配层交付（Phase 2）
- **交付目标**：实现 `MenuAdapter` 与 `SelectAdapter`，确保无缝接入。
- **任务清单**：
  1. 实现 `adapters/schemaBridge.ts` 转换函数；
  2. 实现 `adapters/MenuAdapter.tsx` 与 `adapters/SelectAdapter.tsx`；
  3. 在 `ui/index.ts` 注册新标准导出；
  4. 运行 `npm test -- Menu` 和 `npm test -- Select` 验证完全绿灯。

#### 阶段三：核心业务场景渐进式切换（Phase 3）
- **交付目标**：对关键高频业务场景完成基于 `MenuItem` / `MenuGroup` 的重构。
- **任务清单**：
  1. **试点 1（扁平操作菜单）**：重构 `ComposePlusMenu` 与 `PermissionModeMenu`；
  2. **试点 2（右键坐标浮层）**：重构 `SidebarContextMenus` 与 `SessionContextMenu`，使用 `openAtPoint`；
  3. **试点 3（复杂级联面板）**：重构 `ModelBadgePickerMenu`，使用 `isSelectableList: true` 与 `children` 级联子菜单。

#### 阶段四：全仓收敛、冗余清理与最终验收（Phase 4）
- **交付目标**：完成其余选择器收敛，清理重复孤立代码。
- **任务清单**：
  1. 收敛 `ProjectPickerMenu`、`SettingsQuickMenu`、`SkillsMoreMenu`；
  2. 废弃并清理旧版重复的坐标计算纯函数（如分散在各业务模块的独立 clamp 函数）；
  3. 运行全量质量检查：`npm run typecheck` + `npm test`（确保 800+ 单元测试 0 失败）。

---

### 8.2 验收断言清单（Acceptance Assertions）

1. **[断言 1 - 视觉与 Token 对齐]**：
   - 浅色模式下，面板背景使用 `rgba(255, 254, 252, 0.96)`，发丝边框使用 `#e2dfd9`，高亮勾选为翡翠绿 `#10b981`，无任何蓝紫色调渗入（Zero-Blue）；
   - 外层圆角 $14\text{px}$、内边距 $6\text{px}$、条目圆角 $8\text{px}$ 严格呈现同心圆弧。
2. **[断言 2 - 几何与交互防抖]**：
   - 在视口底部触发时，面板向上展开；在临界高度抖动时，Hysteresis 32px 锁定展开方向，杜绝跳动闪烁；
   - 级联子菜单在屏幕右边缘时自动向左翻转（`sep-flip-left`），绝对不产生负坐标或穿出视口。
3. **[断言 3 - Safe-Aim 保护区]**：
   - 鼠标从父菜单斜向滑入子菜单时，SVG 虚拟碰撞多边形生效，不会因划过邻近条目而导致子菜单闪退。
4. **[断言 4 - 全键盘无障碍]**：
   - ↑ / ↓ 在非禁用项间无缝切换，Enter 触发选择，→ 展开二级子菜单，← / Esc 平滑返回上一级或关闭。
5. **[断言 5 - 测试资产零回归]**：
   - 全仓运行 `npm test`，包含 `Menu.test.tsx`、`Select.test.tsx`、`PhysicalGeometryGuards.test.tsx` 在内的全部测试套件 100% 绿灯通过，无任何破坏性断言。
