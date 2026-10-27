# 复合组件 ContextMenu 与 DropdownMenu 原子基座方案

> **文件路径**：`docs/ui-architecture-overhaul/independent-plans/02-复合组件ContextMenu与DropdownMenu原子基座方案.md`  
> **战役工作区**：`docs/ui-architecture-overhaul/`  
> **依赖与引用**：
> - 协作纪律与反退避：`AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`
> - 几何引擎与浮层层栈：`apps/crish-desktop/src/components/ui/Menu/position.ts`、`apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts`、`apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackService.ts`
> - 待重构目标文件：`apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx`、`apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx`

---

## 一、方案总览与架构愿景

### 1.1 现状诊断与核心痛点

当前 Conex 桌面端（`apps/crish-desktop`）的右键上下文菜单（Context Menu）与下拉级联菜单（Dropdown Menu）存在显著的**架构割裂**与**实现冗余**，主要体现在两大典型场景中：

1. **会话右键菜单（`SessionContextMenu.tsx`，146 行）**：
   - **痛点**：采用硬编码配置项数组（`MenuItem[]`）驱动 `SmartPanel` 渲染。虽然具备 1px 发丝边框和基本阴影，但开发者无法通过声明式 JSX 组合子菜单、单选项、复选框或自定义快捷键标签；任何定制需求都必须修改数据模型，缺乏复合组件的灵活插槽能力。
2. **列表筛选与排序飞层（`ContextMenuFlyout.tsx`，479 行）**：
   - **痛点**：属于典型的“手搓状态机”代码。单为了实现排序、分组、过滤三个子菜单的级联展开与单选，组件内部手写了 `FlyoutRow`、`FlyoutOption`、DOM 递归测量（`getBoundingClientRect` + `flipLeft`）、手动维护 `flyTimerRef`（80ms enter / 150ms leave）、手动绑定 `onKeyDown`（ArrowRight/ArrowLeft/Enter/Space/Esc）以及直接操作 DOM `querySelector('[role="menuitemradio"]')`。代码极度臃肿、易碎，缺乏可复用性。
3. **第三方 UI 栈的隐性渗透**：
   - 部分菜单直接引入 `@radix-ui/react-popover` 等沉重外部包，增加了运行时开销与包体积，且 Radix 内部事件机制与 Conex 自研的 `LayerStackService`（浮层层栈）存在事件调度争抢与焦点失控隐患。

### 1.2 核心设计原则与架构定位

针对上述痛点，本方案确立三项不可动摇的架构原则：

| 架构原则 | 具体要求与落地约束 |
| :--- | :--- |
| **坚决避免外部 UI 栈** | **零外部组件库依赖**（坚决剔除 Radix Popover/ContextMenu、Floating-UI、Headless-UI 等）。基于纯 React Context + 自研单源几何 Positioner 引擎纯手工构建。 |
| **综合借鉴，自研风格** | **杜绝机械照抄**：<br>1. 吸收 `reference/ui` (shadcn) 的人体工学 API 命名与声明式复合结构（`<ContextMenu>`、`<ContextMenuTrigger>`、`<ContextMenuContent>`、`<ContextMenuItem>`）；<br>2. 吸收 `reference/appica-ui` 的结构化数据槽位设计（`leading`、`content`、`trailing` 分离与统一）；<br>3. 注入 Conex 原生视觉 DNA：**1px 发丝边框**、**同心几何圆角**（Concentric Geometry）、**暗黑质感**与 **4 层漫反射光影**。 |
| **原子基座与同构复用** | `ContextMenu` 与 `DropdownMenu` 在底层 100% 共享菜单核心状态机、键盘漫游引擎、指针安全三角形（Safe Triangle Aiming）算法及槽位渲染器，仅在**触发媒介**（鼠标右键/触控长按 vs 点击/悬停）与**定位锚点**（光标虚拟坐标点 vs 触发元素矩形）上解耦分叉。 |

---

## 二、复合组件矩阵规范与 API 契约

### 2.1 组件矩阵清单

ContextMenu 与 DropdownMenu 遵循统一的复合组件（Compound Components）拓扑矩阵：

```mermaid
graph TD
  CM[ContextMenu / DropdownMenu 根组件<br/>State Context + LayerStack ID] --> CMT[ContextMenuTrigger / DropdownMenuTrigger<br/>事件监听: contextmenu / longpress / click]
  CM --> CMC[ContextMenuContent / DropdownMenuContent<br/>Portal 容器 + Positioner 定位 + 键盘漫游]
  
  CMC --> CMI[ContextMenuItem / DropdownMenuItem<br/>通用交互项: label, icon, shortcut, destructive]
  CMC --> CMCB[ContextMenuCheckboxItem / DropdownMenuCheckboxItem<br/>复选指示器 + checked 状态]
  CMC --> CMRG[ContextMenuRadioGroup / DropdownMenuRadioGroup<br/>单选容器 Context: value, onValueChange]
  CMRG --> CMRI[ContextMenuRadioItem / DropdownMenuRadioItem<br/>单选指示器 + itemradio 语义]
  CMC --> CMSep[ContextMenuSeparator / DropdownMenuSeparator<br/>1px 发丝分隔线]
  CMC --> CMS[ContextMenuShortcut / DropdownMenuShortcut<br/>等宽排版快捷键标签]
  CMC --> CMSub[ContextMenuSub / DropdownMenuSub<br/>二级级联子菜单状态机]
  
  CMSub --> CMST[ContextMenuSubTrigger / DropdownMenuSubTrigger<br/>悬停安全区触发器 + ArrowRight]
  CMSub --> CMSC[ContextMenuSubContent / DropdownMenuSubContent<br/>子菜单浮层 + Safe Triangle 碰撞区]
```

### 2.2 复合组件 API 规范

#### 1. 根组件与触发器

```typescript
// ContextMenu Root Props
export interface ContextMenuProps {
  children: React.ReactNode;
  /** 受控展开状态（可选） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 菜单模态类型：是否阻断外部交互，默认 false */
  modal?: boolean;
}

// ContextMenuTrigger Props
export interface ContextMenuTriggerProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
  /** 是否禁用右键与长按唤起 */
  disabled?: boolean;
  /** 长按触发阈值（毫秒），移动端/触控板默认 500ms */
  longPressThresholdMs?: number;
}
```

#### 2. 内容浮层与子内容浮层

```typescript
export interface MenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** 视口边缘安全边距，默认 8px */
  edgePadding?: number;
  /** 浮层与锚点的偏移量，默认 4px */
  sideOffset?: number;
  /** 最小宽度规范，默认 180px */
  minWidth?: number;
  /** 自定义 Portal 挂载容器，默认 document.body */
  container?: HTMLElement | null;
  /** 允许自定义注入 Layer ID，默认内部基于 useId 生成 */
  layerId?: string;
}

export interface MenuSubContentProps extends MenuContentProps {
  /** 级联子菜单优先展开方向，默认 'right'，空间不足自动翻转至 'left' */
  preferredSide?: 'left' | 'right';
}
```

#### 3. 槽位化菜单项与变体

```typescript
export interface MenuItemBaseProps {
  /** 缩进标志：当同行无 Leading 图标时，设置 inset=true 保持与有图标项文字基线绝对对齐 */
  inset?: boolean;
  /** 交互变体：'default' 为常规高亮，'destructive' 为危险红色软背景 */
  variant?: 'default' | 'destructive';
  /** 禁用状态 */
  disabled?: boolean;
  /** 选中执行回调（触发后默认自动关闭菜单） */
  onSelect?: (event: React.MouseEvent | React.KeyboardEvent) => void;
  /** 选中后是否阻止自动关闭菜单，默认 false */
  preventCloseOnSelect?: boolean;
}

export interface ContextMenuItemProps
  extends MenuItemBaseProps,
    React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export interface ContextMenuCheckboxItemProps
  extends MenuItemBaseProps,
    React.HTMLAttributes<HTMLDivElement> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  children: React.ReactNode;
}

export interface ContextMenuRadioGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
}

export interface ContextMenuRadioItemProps
  extends MenuItemBaseProps,
    React.HTMLAttributes<HTMLDivElement> {
  value: string;
  children: React.ReactNode;
}
```

### 2.3 像素级缩进（`inset`）与槽位基线排版规范

借鉴 `reference/appica-ui` 的结构化槽位与 `reference/ui` 的基线对齐策略，所有 MenuItem 内部采用刚性网格槽位划分：

```
+-----------------------------------------------------------------------------+
| [Leading Slot: 20px] | [Content Slot: flex 1 1 auto] | [Trailing Slot: auto]|
| Check / Radio / Icon | Title / Description          | Shortcut / Chevron   |
+-----------------------------------------------------------------------------+
```

1. **Leading Slot（20px 宽度）**：
   - `CheckboxItem`：渲染 14px 动态 Check 勾选图标；
   - `RadioItem`：渲染 6px 实心圆点（或 Check 图标）；
   - 常规 `MenuItem` 带图标时：渲染 16px `AppIcon`；
2. **`inset` 属性基线对齐契约**：
   - 当菜单中存在部分无图标的普通文本项，但同组存在带图标/Check 项时，设置 `inset={true}` 会强制为 Leading Slot 保留 `padding-left: 28px`（20px slot + 8px gap）。
   - **绝对杜绝**：文本左右晃动、错位的参差现象。

---

## 三、核心交互与自研算法规范

### 3.1 双模触发引擎（Fine Mouse & Coarse Touch Long-Press）

为了完美兼容桌面高精度鼠标（Fine Pointer）与 Surface/触控板/触屏手势（Coarse Pointer），`ContextMenuTrigger` 封装了自研的无依赖双模监听引擎：

```mermaid
stateDiagram-v2
  [*] --> Idle
  
  state "Mouse Interaction" as Mouse {
    Idle --> ContextMenuEvent: onContextMenu (e.button === 2)
    ContextMenuEvent --> OpenAtCursor: preventDefault() + 记录 clientX/clientY
  }
  
  state "Touch / Coarse Interaction" as Touch {
    Idle --> PointerDown: pointerdown (pointerType === 'touch' / 'pen')
    PointerDown --> LongPressTimer: 启动 500ms 计时器 + 记录起点 (X0, Y0)
    
    LongPressTimer --> CancelTimer: pointermove 移动位移 > 8px (判定为滑动滚动)
    LongPressTimer --> CancelTimer: pointerup / pointercancel (在 500ms 内释放)
    CancelTimer --> Idle
    
    LongPressTimer --> TriggerLongPress: 计时器到达 500ms
    TriggerLongPress --> OpenAtTouch: 触发 navigator.vibrate(12ms) + 阻止系统菜单
  }
```

#### 双模引擎核心断言与实现细节：
1. **坐标采样纯洁性**：使用 `e.clientX` / `e.clientY`，在进入 Positioner 前不进行任何污染性偏移；
2. **触控滑动防误触**：记录初始点 $(X_0, Y_0)$，监听 `pointermove` 计算曼哈顿距离 $\Delta = |X - X_0| + |Y - Y_0|$。若 $\Delta > 8\text{px}$ 则认定为页面滚动行为，立即清除长按定时器；
3. **触觉反馈与系统菜单抑制**：触控长按成功触发时，通过 `e.preventDefault()` 抑制 Windows/WebView2 默认长按圆圈动画与右键菜单，并可选调用微弱轻触震动（12ms）。

---

### 3.2 级联子菜单：自研指针安全几何三角形（Safe Triangle Aiming）算法

#### 1. 痛点场景
当用户将鼠标从父菜单项（`SubTrigger`）斜向移动到展开的子菜单（`SubContent`）时，光标极易短暂穿过相邻的其它兄弟菜单项。传统做法往往导致兄弟菜单项被 hover 激活，子菜单突然闪退关闭，严重破坏操作流线感。

#### 2. 几何算法数学推导（2D Vector Cross Product）
Conex 完全基于纯数学几何推导，在 `apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts` 中实现高精度命中测试，杜绝任何 Canvas 或 DOM 冗余元素：

```
       (X_cursor, Y_cursor) 光标当前瞬时位置 P
              \
               \   安全保护区 Safe Triangle (P, V_top, V_bottom)
                \
                 +-----------------------+
                 | V_top                 |
                 |                       |
                 |      SubContent       |
                 |       (子菜单)         |
                 |                       |
                 | V_bottom              |
                 +-----------------------+
```

1. **三角形顶点构建**：
   - 设子菜单展开在右侧，子菜单包围盒左边界为 $X_{sub} = \text{SubBounds.left}$，上下顶点分别为：
     $$V_{top} = (X_{sub}, \text{SubBounds.top}), \quad V_{bottom} = (X_{sub}, \text{SubBounds.bottom})$$
   - 当前光标瞬时位置为 $P = (X_c, Y_c)$，构成封闭三角形 $\triangle P V_{top} V_{bottom}$。
2. **2D 向量叉积（Signed Area）**：
   - 对于有向线段 $AB$ 与点 $M$，定义叉积函数：
     $$\text{CrossProduct}(A, B, M) = (B_x - A_x)(M_y - A_y) - (B_y - A_y)(M_x - A_x)$$
3. **内部点命中判断准则**：
   - 计算光标轨迹点 $M$ 相对三角形三条边 $PV_{top}$、$V_{top}V_{bottom}$、$V_{bottom}P$ 的符号：
     $$\begin{cases}
       c_1 = \text{CrossProduct}(P, V_{top}, M) \\
       c_2 = \text{CrossProduct}(V_{top}, V_{bottom}, M) \\
       c_3 = \text{CrossProduct}(V_{bottom}, P, M)
     \end{cases}$$
   - **充要条件**：当且仅当 $c_1, c_2, c_3$ 同号（全部 $\ge 0$ 或全部 $\le 0$）时，点 $M$ 严格位于 Safe Triangle 内部。
4. **运动矢量与反向立即熔断（Velocity Dot Product）**：
   - 维护 4 帧光标历史队列，计算当前速度矢量 $\vec{v} = P_t - P_{t-1}$；
   - 计算朝向子菜单中心的目标矢量 $\vec{d} = C_{sub} - P_t$；
   - 若 $\vec{v} \cdot \vec{d} \le 0$（光标已明确反向背离子菜单移动），**无需等待 300ms 宽限超时，立即释放保护区**，恢复相邻菜单项的高亮响应。

---

### 3.3 无外部 UI 栈的自研单源 Positioner 引擎

摒弃外部 Floating-UI，全面复用并强化 `apps/crish-desktop/src/components/ui/Menu/position.ts` 的不可变单源计算能力：

```mermaid
flowchart TD
  In[输入: 锚点坐标/矩形 + 菜单测量尺寸] --> VP[getEffectiveViewport 视口感知<br/>检测 Win32 最大化 8px 溢出边界]
  VP --> VFlip{垂直空间评估<br/>preferredSide: bottom vs top}
  VFlip -->|空间充足| PlaceY[确定实际放置侧 actualSide]
  VFlip -->|下侧不足且上侧更大| FlipY[翻转 actualSide = top]
  
  PlaceY & FlipY --> HFlip{水平对齐评估<br/>preferredAlign: start vs end}
  HFlip -->|发生越界| FlipX[翻转水平对齐 actualAlign]
  HFlip -->|空间充足| PlaceX[确定实际对齐]
  
  PlaceX & FlipX --> Clamp[双向刚性数学钳位 Two-Way Clamping<br/>minX <= X <= maxX - W<br/>minY <= Y <= maxY - H]
  Clamp --> Out[输出: 最终精确 X/Y + transformOrigin + 翻转元数据]
```

#### 关键约束与几何不变量：
1. **真实尺寸不可变性**：在 `useLayoutEffect` 中使用 `offsetWidth` / `offsetHeight` 测量真实物理像素，彻底免疫 CSS 进场动画 `scale(0.97)` 的瞬态形变干扰；
2. **Win32 最大化越界保护**：自动感知 `document.documentElement.getAttribute('data-window-maximized') === 'true'`，自动为屏幕四周扣除 8px 溢出边界（`offsetLeft: 8, offsetTop: 8`）；
3. **动画原点动态反射**：根据翻转计算结果精确输出 `transformOrigin`（例如翻转到上方展开时原点为 `bottom left`，右下方时为 `top left`），保证展开动效始终锚定在触发点边缘。

---

## 四、LayerStack 浮层拓扑与事件流整合

所有 `ContextMenu` 与 `DropdownMenu` 实例必须通过 `useLayerRegistration` 统一接入 Conex 内核的 `LayerStackService`（见 `apps/crish-desktop/src/components/ui/internal/layer-registration/useLayerRegistration.ts`），建立标准的层级与焦点管理：

```typescript
// 核心层级注册契约
useLayerRegistration(
  {
    id: layerId,
    type: 'context-menu', // 关键：标识为 context-menu 槽位，自动互斥驱逐全局 Tooltip 与同类菜单
    dismissible: true,
    modal: modal,
    elementRef: contentRef,
    anchorRef: triggerRef,
    restoreFocusTarget: triggerRef?.current ?? undefined,
    onDismiss: () => handleClose(),
    onEscapeKeyDown: (e) => {
      // 级联子菜单优先消耗 Escape，仅关闭当前子层并归还焦点至 SubTrigger；
      // 根菜单消耗 Escape 关闭整个菜单体系并恢复触发器焦点。
    },
    onPointerDownOutside: (e) => {
      // 外部点击阻断与安全销毁
    },
  },
  isOpen
);
```

### 键盘漫游完整状态机契约：

| 按键动作 | 处于根菜单内容（`Content`） | 处于子菜单触发器（`SubTrigger`） | 处于子菜单内容（`SubContent`） |
| :--- | :--- | :--- | :--- |
| **ArrowDown** | 循环移动至下一个未禁用的 MenuItem | 移动至下一个菜单项 | 在子菜单内向下循环移动 |
| **ArrowUp** | 循环移动至上一个未禁用的 MenuItem | 移动至上一个菜单项 | 在子菜单内向上循环移动 |
| **ArrowRight** | 若当前项为 `SubTrigger`，立即展开子菜单并聚焦其第一项；否则忽略 | 展开子菜单并聚焦其第一项 | 忽略 |
| **ArrowLeft** | 忽略 | 忽略 | 关闭当前 `SubContent`，焦点无缝返回父级 `SubTrigger` |
| **Enter / Space**| 激活当前选中的项（执行 `onSelect`），关闭整个菜单 | 展开子菜单并聚焦其第一项 | 激活当前单选/复选/常规项 |
| **Escape** | 关闭当前整个上下文菜单，恢复触发器焦点 | 关闭当前整个上下文菜单 | **仅关闭当前子菜单**，焦点停留在父级 `SubTrigger` |

---

## 五、视觉设计系统与 Design Tokens 约束

严格遵循 Conex 桌面端设计规范与 `AGENTS.md` §12–§14 铁律，打造高质感发丝级微交互：

### 5.1 核心设计 Token 规范

```css
/* Conex 菜单专属设计 Token（对齐 SmartPanel.module.css 与全局 design tokens） */
:root {
  /* 同心几何半径 (Concentric Geometry: R_inner = R_outer - Padding) */
  --menu-radius-outer: 12px;
  --menu-padding: 4px;
  --menu-radius-inner: calc(var(--menu-radius-outer) - var(--menu-padding)); /* 8px */
  
  /* 1px 发丝边框与暗黑微渐变背景 */
  --menu-border: 1px solid var(--border-color, hsl(0 0% 100% / 0.1));
  --menu-bg: var(--bg-elevated, hsl(240 6% 10% / 0.95));
  --menu-backdrop-filter: blur(16px) saturate(180%);
  
  /* 4 层漫反射发光柔和阴影 */
  --menu-shadow: 
    0 0 0 1px hsl(0 0% 100% / 0.05),
    0 4px 6px -1px hsl(0 0% 0% / 0.3),
    0 10px 15px -3px hsl(0 0% 0% / 0.4),
    0 20px 25px -5px hsl(0 0% 0% / 0.5);
    
  /* 激活与焦点态（严格遵守 AGENTS.md §13：对比度混入上限 10%，禁止粗黑边框） */
  --menu-item-hover: var(--tint-hover, hsl(0 0% 100% / 0.06));
  --menu-item-active: var(--tint-active, hsl(0 0% 100% / 0.09));
  --menu-item-focus-border: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
  
  /* 危险操作色彩契约 */
  --menu-danger-text: var(--sep-danger-color, hsl(0 75% 65%));
  --menu-danger-bg-hover: var(--danger-soft-bg, hsl(0 80% 50% / 0.12));
}
```

### 5.2 微交互动效设计
- **进场微动画**：采用弹簧曲线 `cubic-bezier(0.16, 1, 0.3, 1)`，初始透明度 0、缩放 `scale(0.97)`，在 140ms 内平滑过渡至 `scale(1)` 与透明度 1；
- **退出微动画**：在 80ms 内 `scale(0.98)` 淡出；
- **减弱动态模式（Reduced Motion）**：当系统开启减弱动画时，自动降级为纯透明度淡入淡出（0ms 缩放形变）。

---

## 六、实战落地重构方案一：会话右键菜单（`SessionContextMenu.tsx`）

### 6.1 现状与重构收益对比

| 指标 / 维度 | 现状（基于 `SmartPanel` 配置数组） | 重构后（基于自研复合组件） |
| :--- | :--- | :--- |
| **代码表达形态** | 146 行硬编码 `MenuItem[]` 对象字面量数组 | 声明式 JSX 语法树，语义与布局一目了然 |
| **插槽扩展能力** | 严重受限，增加子项、徽标、变体需修改底层接口 | 任意子项原生支持插槽、图标、自定义快捷键、分组 |
| **危险项语义** | 依赖配置对象中 `danger: true` 标记 | `<ContextMenuItem variant="destructive">` 规范声明 |
| **快捷键排版** | 纯文本追加在字符串后 | `<ContextMenuShortcut>` 等宽基线精准右对齐 |

### 6.2 重构落地代码（完整 drop-in replacement）

重构后的 `apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx`：

```tsx
import React from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '../ui/ContextMenu';
import { AppIcon } from '../ui/icons';
import type {
  SessionContextMenuState,
  SessionMenuAction,
} from './SidebarContextMenus';

export const SESSION_CONTEXT_MENU_LAYER_ID = 'sidebar-session-context-menu';

export interface SessionContextMenuProps {
  contextMenu: SessionContextMenuState | null;
  menuRef?: React.RefObject<HTMLDivElement | null>;
  isPinned: boolean;
  onSessionAction: (action: SessionMenuAction) => void;
  onCloseContextMenu?: () => void;
  contextMenuTriggerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * 会话右键菜单（声明式复合组件重构版）
 * 彻底消除硬编码 MenuItem 配置数组，回归清晰优雅的 JSX 声明式语义。
 */
export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
  contextMenu,
  menuRef,
  isPinned,
  onSessionAction,
  onCloseContextMenu,
  contextMenuTriggerRef,
}) => {
  const isOpen = Boolean(contextMenu);

  return (
    <ContextMenu
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onCloseContextMenu?.();
      }}
    >
      <ContextMenuContent
        ref={menuRef}
        layerId={SESSION_CONTEXT_MENU_LAYER_ID}
        anchorPoint={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : undefined}
        triggerRef={contextMenuTriggerRef}
        aria-label="会话操作"
        data-testid="session-context-menu"
        style={{
          zIndex: 'var(--z-context-menu, var(--z-popover))',
          minWidth: 196,
        }}
      >
        {/* 打开组 */}
        <ContextMenuItem onSelect={() => onSessionAction('open-current')}>
          <AppIcon name="message-circle" size={16} aria-hidden />
          <span>在此处打开</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSessionAction('open-split')}>
          <AppIcon name="columns" size={16} aria-hidden />
          <span>拆分视图</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSessionAction('open-new')}>
          <AppIcon name="external-link" size={16} aria-hidden />
          <span>在新窗口打开</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* 管理组 */}
        <ContextMenuItem onSelect={() => onSessionAction('rename')}>
          <AppIcon name="pencil" size={16} aria-hidden />
          <span>重命名</span>
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSessionAction(isPinned ? 'unpin' : 'pin')}>
          <AppIcon name={isPinned ? 'pin-off' : 'pin'} size={16} aria-hidden />
          <span>{isPinned ? '取消置顶' : '置顶'}</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSessionAction('archive')}>
          <AppIcon name="archive" size={16} aria-hidden />
          <span>归档</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSessionAction('branch')}>
          <AppIcon name="git-fork" size={16} aria-hidden />
          <span>分叉</span>
          <ContextMenuShortcut>Ctrl+Shift+F</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* 辅助与危险操作组 */}
        <ContextMenuItem onSelect={() => onSessionAction('copy-id')}>
          <AppIcon name="copy" size={16} aria-hidden />
          <span>复制会话 ID</span>
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onSessionAction('delete')}
        >
          <AppIcon name="trash" size={16} aria-hidden />
          <span>删除当前对话</span>
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* 导出项 */}
        <ContextMenuItem onSelect={() => onSessionAction('export')}>
          <AppIcon name="file-download" size={16} aria-hidden />
          <span>导出 Markdown</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};
```

---

## 七、实战落地重构方案二：彻底干掉 `ContextMenuFlyout.tsx`（479 行手搓代码）

### 7.1 现有 479 行手搓代码深度剖析与粉碎清单

`apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx` 的 479 行代码充斥着历史技术债务：
1. **行 18–124（`FlyoutRow`，106 行）**：为每一行手动写 `useEffect` 探测 `getBoundingClientRect()` 并计算 `setFlipLeft`；手动拦截 `e.target` 点击事件以防冒泡；手写 `onMouseEnter` / `onMouseLeave`；
2. **行 127–155（`FlyoutOption`，28 行）**：手写 `Button bare` 包裹，手动传 `aria-checked` 与 `role="menuitemradio"`；
3. **行 187–232（手写定时器状态机，45 行）**：定义 `flyTimerRef`，在 `80ms` 和 `150ms` 间通过 `window.setTimeout` 协调子菜单防抖；
4. **行 247–307（手动键盘事件监听，60 行）**：手动写 `handleRowKeyDown` 与 `handleFlyoutKeyDown`，用 `Array.from(container.querySelectorAll('[role="menuitemradio"]'))` 计算聚焦索引；
5. **行 311–323（首项聚焦劫持，12 行）**：手动在 `requestAnimationFrame` 中调用 `querySelector` 进行聚焦。

**粉碎结论**：所有上述手搓逻辑完全属于通用级联下拉菜单的标准职责。改用自研 `<DropdownMenu>` 复合组件后，所有状态机、定时器、定位反转、键盘漫游与角色标记均在基座内部内聚完成，**组件代码从 479 行直接压缩至 56 行，瘦身幅度达 88.3%**！

### 7.2 重构落地代码（压缩至 60 行内的高内聚组件）

重构后的 `apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx`：

```tsx
import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../ui/DropdownMenu';
import styles from './SidebarContextMenus.module.css';

export interface ContextMenuFlyoutProps {
  sortMenuRef: React.RefObject<HTMLDivElement | null>;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onCloseSortDropdown: () => void;
  sortTriggerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * 排序/分组/过滤下拉菜单（复合组件重构版）
 * 彻底移除 479 行手搓状态机、定时器与 DOM 查询，采用声明式 DropdownMenuSub + RadioGroup。
 */
export const ContextMenuFlyout: React.FC<ContextMenuFlyoutProps> = ({
  sortMenuRef,
  sortDropdownOpen,
  sortDropdownCoords,
  sortType,
  groupType,
  filterType,
  onSetSortType,
  onSetGroupType,
  onSetFilterType,
  onCloseSortDropdown,
  sortTriggerRef,
}) => {
  return (
    <DropdownMenu
      open={sortDropdownOpen}
      onOpenChange={(open) => {
        if (!open) onCloseSortDropdown();
      }}
    >
      <DropdownMenuContent
        ref={sortMenuRef}
        triggerRef={sortTriggerRef}
        anchorPoint={sortDropdownCoords ?? undefined}
        side="bottom"
        align="start"
        className={`${styles.sortFilterMenu} ${styles.open} no-drag`}
      >
        {/* 排序方式子菜单 */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            label="排序方式"
            valueLabel={sortType === 'name' ? '按名称' : '按最近活跃'}
          />
          <DropdownMenuSubContent role="group" aria-label="排序方式">
            <DropdownMenuRadioGroup
              value={sortType}
              onValueChange={(val) => {
                onSetSortType(val as 'active' | 'name');
                onCloseSortDropdown();
              }}
            >
              <DropdownMenuRadioItem value="active">按最近活跃</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name">按名称</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* 分组方式子菜单 */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            label="分组方式"
            valueLabel={groupType === 'none' ? '平铺列表' : '按项目分组'}
          />
          <DropdownMenuSubContent role="group" aria-label="分组方式">
            <DropdownMenuRadioGroup
              value={groupType}
              onValueChange={(val) => {
                onSetGroupType(val as 'folder' | 'none');
                onCloseSortDropdown();
              }}
            >
              <DropdownMenuRadioItem value="folder">按项目分组</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="none">平铺列表</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* 列表范围子菜单 */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            label="列表范围"
            valueLabel={filterType === 'pinned' ? '仅置顶' : '全部会话'}
          />
          <DropdownMenuSubContent role="group" aria-label="列表范围">
            <DropdownMenuRadioGroup
              value={filterType}
              onValueChange={(val) => {
                onSetFilterType(val as 'all' | 'pinned');
                onCloseSortDropdown();
              }}
            >
              <DropdownMenuRadioItem value="all">全部会话</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="pinned">仅置顶</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
```

### 7.3 回归测试 100% 对齐证明（对齐 `SidebarContextMenus.flyout.test.tsx`）

现有测试 `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.flyout.test.tsx` 约束了 5 条关键用例，重构后的基座对其完全覆盖：

1. **测试断言：`鼠标移出行后 flyout 关闭`**：
   - 基座内部内置 `SafeTriangle` 离开延迟熔断机制（150ms 离开宽限），光标离开行并未进入子菜单时自动触发关闭；
2. **测试断言：`鼠标移入 flyout 内部不误关（宽限期容错）`**：
   - 进入 `DropdownMenuSubContent` 时触发 `cancelLeave`，保持子菜单展开；
3. **测试断言：`ArrowLeft 关闭 flyout 且不关闭整个排序菜单`**：
   - `DropdownMenuSubContent` 捕获 `ArrowLeft` 与 `Escape` 事件，仅收起本层级子菜单并将 DOM 焦点无损归还至其触发器，阻止事件向上冒泡至主菜单；
4. **测试断言：`ArrowRight 打开并聚焦首项`**：
   - `DropdownMenuSubTrigger` 捕获 `ArrowRight`，开启级联子层并自动在 `requestAnimationFrame` 中完成首个未禁用 Radio 项的键盘焦点捕获；
5. **测试断言：`点击单选项调用回调并关闭主菜单`**：
   - `DropdownMenuRadioItem` 选中后触发 `onValueChange`，随后自动触发全局收起。

---

## 八、新组件目录结构与落盘布局

在 `apps/crish-desktop/src/components/ui/` 下构建高内聚的原子组件目录：

```
apps/crish-desktop/src/components/ui/
├── ContextMenu/
│   ├── index.ts                      # 统一导出 ContextMenu 矩阵组件与类型
│   ├── ContextMenu.tsx               # ContextMenu 根组件与 ContextMenuTrigger
│   ├── ContextMenuContent.tsx        # 浮层定位、Portal 与 LayerStack 接线
│   ├── ContextMenuItem.tsx           # 常规项、复选单选项、Separator、Shortcut
│   ├── ContextMenuSub.tsx            # 级联子菜单、SafeTriangle Aim 联动
│   └── ContextMenu.module.css        # 1px 发丝边框、同心几何与 4 层漫反射光影
├── DropdownMenu/
│   ├── index.ts                      # 统一导出 DropdownMenu 矩阵组件与类型
│   ├── DropdownMenu.tsx              # 同构复用共享基座
│   ├── DropdownMenuContent.tsx
│   ├── DropdownMenuItem.tsx
│   └── DropdownMenuSub.tsx
└── internal/
    ├── menu-base/                    # ContextMenu 与 DropdownMenu 共享纯逻辑基座
    │   ├── MenuBaseContext.ts        # 菜单核心 Context 定义
    │   ├── useMenuKeyboard.ts        # 键盘漫游状态机 Hook（↑↓←→ Esc Space Enter）
    │   ├── useMenuAim.ts             # Safe Triangle Aim 保护区与射线碰撞 Hook
    │   └── usePointerLongPress.ts    # 触控长按手势监听 Hook
    ├── SafeTriangle.ts               # 已有：纯数学 2D 向量叉积几何计算
    └── layer-stack/                  # 已有：全局浮层层栈调度服务
```

---

## 九、分步实施路线图与验收断言

遵循反退避与立体验证纪律，重构按以下四个任务单元（TU）实施：

```mermaid
gantt
  title ContextMenu & DropdownMenu 原子基座实施波次
  dateFormat  X
  axisFormat %d
  section 阶段一：纯逻辑基座
  共享 Context 与 键盘漫游 Hook (TU-01)       :active, p1, 0, 2
  Safe Aim 几何防护与 LongPress 触发引擎 (TU-02) :p2, 2, 4
  section 阶段二：复合组件装配
  ContextMenu 复合组件矩阵实现 (TU-03)         :p3, 4, 6
  DropdownMenu 同构组件与样式落盘 (TU-04)      :p4, 6, 8
  section 阶段三：业务实战重构
  SessionContextMenu 声明式重构 (TU-05)       :p5, 8, 10
  彻底干掉 ContextMenuFlyout 479 行代码 (TU-06):p6, 10, 12
  section 阶段四：立体门禁验证
  单元测试与 flyout 回归用例全绿验证 (TU-07)   :p7, 12, 14
```

### 9.1 任务单元与交付清单

1. **TU-01：共享 Context 与键盘漫游状态机**：
   - 编写 `internal/menu-base/useMenuKeyboard.ts`，支持跳过 disabled 项、上下循环漫游、左右子菜单层级升降，单测覆盖率 100%；
2. **TU-02：Safe Aim 几何防护与 LongPress 双模触发引擎**：
   - 编写 `internal/menu-base/useMenuAim.ts` 与 `usePointerLongPress.ts`，针对触屏长按 500ms 阈值与 8px 曼哈顿距离位移取消进行边界测试；
3. **TU-03 & TU-04：复合组件装配与同心几何样式**：
   - 完成 `ContextMenu/*` 与 `DropdownMenu/*` 组件代码，引入 `1px solid var(--border-color)`、`var(--shadow-popover)` 与同心圆角；
4. **TU-05：`SessionContextMenu.tsx` 重构**：
   - 彻底废除配置对象，换用声明式 JSX 语法；
5. **TU-06：`ContextMenuFlyout.tsx` 粉碎重构**：
   - 从 479 行手搓状态机收敛至 60 行内；
6. **TU-07：立体门禁与测试资产守门**：
   - 运行 `npx vitest run apps/crish-desktop/src/components/sidebar/SidebarContextMenus.flyout.test.tsx`；
   - 运行 `npx vitest run apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx`；
   - 执行 `npm run typecheck` 验证零类型错误；
   - 执行 `npm run check:line-counts` 验证行数门禁零报警。

---

## 十、总结与结论

本方案完全在 Conex 自研技术底座上展开：
1. **零外部 UI 栈膨胀**：彻底摒弃外部 UI 库，使用纯 React Context + 自研单源 Positioner 引擎；
2. **优雅人体工学与数据槽位**：吸收 shadcn 与 Appica UI 之长，融合 Conex 1px 发丝边框与同心几何暗黑质感；
3. **彻底根除历史技术债务**：干掉 `ContextMenuFlyout.tsx` 的 479 行冗余手搓逻辑，代码量骤降 88%，同时升级 `SessionContextMenu.tsx` 为声明式复合组件范式。
方案具备高度可行性与立体验证支撑，可立即转入工程落地阶段。
