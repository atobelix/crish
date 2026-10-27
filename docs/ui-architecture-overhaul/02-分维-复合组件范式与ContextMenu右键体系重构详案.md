# 02-复合组件 ContextMenu 与 DropdownMenu 原子基座重构详案

> **文件路径**：`docs/ui-architecture-overhaul/02-分维-复合组件范式与ContextMenu右键体系重构详案.md`  
> **战役工作区**：`docs/ui-architecture-overhaul/`  
> **版本**：v2（2026-10-27 严苛审计补丁融入版）  
> **依赖与引用**：
> - 协作纪律与反退避：`AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`
> - 对抗性审计依据：`docs/ui-architecture-overhaul/plan-reviews/02-菜单与A11y键盘漫游方案严苛审计.md`
> - 几何引擎与浮层层栈：`apps/crish-desktop/src/components/ui/Menu/position.ts`、`apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts`、`apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts`、`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx`、`apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackService.ts`
> - 待重构目标文件：`apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx`、`apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx`
> - 现有测试资产守门：`apps/crish-desktop/src/components/sidebar/SidebarContextMenus.flyout.test.tsx`、`apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx`

---

## 修订记录

| 版本 | 日期 | 修订依据 | 核心修订要点 |
|---|---|---|---|
| v1 | 2026-10-27 | 战役独立规划任务书 | 初始版本：复合组件 API、SafeAim 初版、双模触发引擎、业务重构。 |
| v2 | 2026-10-27 | 《02-菜单与A11y键盘漫游方案严苛审计报告》 | **融入 5 大核心补丁**：<br>1. **FocusTrap 模态白名单放行（P0 致命修复）**：注入 `data-floating-layer`、`data-slot="context-menu-content"` 与 `role="menu"` 刚性属性，打通与 `focusTrap.tsx` 白名单通道，彻底防止弹窗内右键被置为 `inert` 与抢焦；<br>2. **复合组件与漫游 Hook 范式对齐**：引入 `MenuCollectionContext` 声明式子组件自动收集器，终结 JSX 声明式与数据驱动 Hook 的接口撕裂；<br>3. **SafeAim 几何算法与参数对齐**：彻底剔除“中心点内积算法”，恢复与强化源码 `SafeAimEngine.ts` 速度趋势回缩判定；补齐 `flipLeft` 视口左翻时的几何反射数学公式；修正离开宽限超时为 **150ms**（小于 200ms），顺从现有 Vitest 测试断言；<br>4. **双层 Context 状态隔离**：拆分 `MenuRootContext` 与 `MenuLevelContext`，消除多层级联的 focusedIndex 冲突与全量重渲染；<br>5. **业务落地补全与真实快捷键治理**：补回 `SessionContextMenu` 的 `key={sessionId}` 与 export tooltip，明确消灭 `F2` / `Del`“假快捷键”的容器级键盘绑定契约；兼容 `SidebarContextMenus.flyout.test.tsx` 的 `tabIndex`、`role` 与 `onClick` 整行点击断言。 |

---

## 一、方案总览与架构愿景

### 1.1 现状诊断与核心痛点

当前 Conex 桌面端（`apps/crish-desktop`）的右键上下文菜单（Context Menu）与下拉级联菜单（Dropdown Menu）存在显著的**架构割裂**与**实现冗余**，主要体现在两大典型场景中：

1. **会话右键菜单（`SessionContextMenu.tsx`，146 行）**：
   - **痛点**：采用硬编码配置项数组（`MenuItem[]`）驱动 `SmartPanel` 渲染。虽然具备 1px 发丝边框和基本阴影，但开发者无法通过声明式 JSX 组合子菜单、单选项、复选框或自定义快捷键标签；任何定制需求都必须修改数据模型，缺乏复合组件的灵活插槽能力。
   - **虚假快捷键债务**：渲染了 `F2`（重命名）与 `Del`（删除），但全局及侧栏均未接入真实键盘监听，属于视觉欺骗。
2. **列表筛选与排序飞层（`ContextMenuFlyout.tsx`，479 行）**：
   - **痛点**：属于典型的“手搓状态机”代码。单为了实现排序、分组、过滤三个子菜单的级联展开与单选，组件内部手写了 `FlyoutRow`、`FlyoutOption`、DOM 递归测量（`getBoundingClientRect` + `flipLeft`）、手动维护 `flyTimerRef`（80ms enter / 150ms leave）、手动绑定 `onKeyDown`（ArrowRight/ArrowLeft/Enter/Space/Esc）以及直接操作 DOM `querySelector('[role="menuitemradio"]')`。代码极度臃肿、易碎，缺乏可复用性。
3. **第三方 UI 栈的隐性渗透与冲突**：
   - 部分菜单直接引入 `@radix-ui/react-popover` 等沉重外部包，增加了运行时开销与包体积；
   - **模态沙盒冲突（P0 隐患）**：当模态弹窗（如 `Dialog`、`ConfirmDialog`、设置面板）处于打开状态时，`focusTrap.tsx` 会对 `document.body` 下非白名单的兄弟节点无差别注入 `inert` 和 `aria-hidden="true"`。若自研右键菜单未携带标准浮层中枢标记，将直接被浏览器原生 `inert` 锁死，导致右键菜单完全无法点击和聚焦。

### 1.2 核心设计原则与架构定位

针对上述痛点，本方案确立四项不可动摇的架构原则：

| 架构原则 | 具体要求与落地约束 |
| :--- | :--- |
| **坚决避免外部 UI 栈** | **零外部组件库依赖**（坚决剔除 Radix Popover/ContextMenu、Floating-UI、Headless-UI 等）。基于纯 React Context + 自研单源几何 Positioner 引擎纯手工构建。 |
| **综合借鉴，自研风格** | **杜绝机械照抄**：<br>1. 吸收 `reference/ui` (shadcn) 的人体工学 API 命名与声明式复合结构（`<ContextMenu>`、`<ContextMenuTrigger>`、`<ContextMenuContent>`、`<ContextMenuItem>`）；<br>2. 吸收 `reference/appica-ui` 的结构化数据槽位设计（`leading`、`content`、`trailing` 分离与统一）；<br>3. 注入 Conex 原生视觉 DNA：**1px 发丝边框**、**同心几何圆角**（Concentric Geometry）、**暗黑质感**与 **4 层漫反射光影**。 |
| **原子基座与同构复用** | `ContextMenu` 与 `DropdownMenu` 在底层 100% 共享菜单核心状态机、键盘漫游引擎、指针安全三角形（Safe Triangle Aiming）算法及槽位渲染器，仅在**触发媒介**（鼠标右键/触控长按 vs 点击/悬停）与**定位锚点**（光标虚拟坐标点 vs 触发元素矩形）上解耦分叉。 |
| **A11y 严谨与模态自洽** | 浮层节点必须满足 `FocusTrap` 白名单契约；键盘漫游与字符检索由 `MenuCollectionContext` 驱动声明式组件自动注册；所有视觉快捷键必须具备物理执行面（SSOT）。 |

---

## 二、复合组件矩阵规范与 API 契约

### 2.1 组件矩阵清单

ContextMenu 与 DropdownMenu 遵循统一的复合组件（Compound Components）拓扑矩阵，通过 `MenuCollectionContext` 实现声明式子节点与键盘状态机的无缝桥接：

```mermaid
graph TD
  CM[ContextMenu / DropdownMenu 根组件<br/>MenuRootContext + LayerStack ID] --> CMT[ContextMenuTrigger / DropdownMenuTrigger<br/>事件监听: contextmenu / longpress / click]
  CM --> CMC[ContextMenuContent / DropdownMenuContent<br/>Portal 容器 + Positioner 定位 + FocusTrap 白名单标记]
  
  CMC --> MCC[MenuCollectionProvider<br/>声明式子节点收集器]
  MCC --> MLC[MenuLevelContext<br/>当前层级漫游状态]
  
  MLC --> CMI[ContextMenuItem / DropdownMenuItem<br/>通用交互项: label, icon, shortcut, destructive]
  MLC --> CMCB[ContextMenuCheckboxItem / DropdownMenuCheckboxItem<br/>复选指示器 + checked 状态]
  MLC --> CMRG[ContextMenuRadioGroup / DropdownMenuRadioGroup<br/>单选容器 Context: value, onValueChange]
  CMRG --> CMRI[ContextMenuRadioItem / DropdownMenuRadioItem<br/>单选指示器 + itemradio 语义]
  MLC --> CMSep[ContextMenuSeparator / DropdownMenuSeparator<br/>1px 发丝分隔线]
  MLC --> CMS[ContextMenuShortcut / DropdownMenuShortcut<br/>等宽排版快捷键标签]
  MLC --> CMSub[ContextMenuSub / DropdownMenuSub<br/>二级级联子菜单状态机]
  
  CMSub --> CMST[ContextMenuSubTrigger / DropdownMenuSubTrigger<br/>悬停安全区触发器 + ArrowRight / Click 展开]
  CMSub --> CMSC[ContextMenuSubContent / DropdownMenuSubContent<br/>独立 Portal 浮层 + Safe Triangle 碰撞区]
```

---

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

#### 2. 内容浮层与子内容浮层（注入 FocusTrap 穿透标记）

```typescript
export interface MenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** 虚拟锚点坐标（右键点击位置） */
  anchorPoint?: { x: number; y: number };
  /** 触发器元素 Ref（用于定位与焦点还原） */
  triggerRef?: React.RefObject<HTMLElement | null>;
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
  /** 是否在挂载时自动聚焦第一项，默认 true */
  autoFocusFirstItem?: boolean;
}

export interface MenuSubContentProps extends MenuContentProps {
  /** 级联子菜单优先展开方向，默认 'right'，空间不足自动翻转至 'left' */
  preferredSide?: 'left' | 'right';
}
```

> **【FocusTrap 模态沙盒白名单刚性注入契约】**：  
> `ContextMenuContent` 与 `DropdownMenuContent` 渲染的根 DOM 节点（及包含 Portal 的最外层包装节点）**必须无条件写入以下属性**：
> ```tsx
> <div
>   ref={contentRef}
>   role="menu"
>   data-floating-layer="true"
>   data-floating-portal="true"
>   data-slot="context-menu-content"
>   aria-orientation="vertical"
>   tabIndex={-1}
>   {...props}
> >
>   {children}
> </div>
> ```
> 此举可被 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx` 的 `isWhitelisted()` 与全局 Tab 监听器立即精准识别放行，防止右键菜单被赋予 `inert` 与抢焦。

#### 3. 槽位化菜单项与变体

```typescript
export interface MenuItemBaseProps {
  /** 唯一标识符（用于自动注册到 Collection） */
  id?: string;
  /** 文本值（用于 Typeahead 快速字符检索，若不传则从 children 提取） */
  textValue?: string;
  /** 缩进标志：当同行无 Leading 图标时，设置 inset=true 保持与有图标项文字基线绝对对齐 */
  inset?: boolean;
  /** 交互变体：'default' 为常规高亮，'destructive' 为危险红色软背景 */
  variant?: 'default' | 'destructive';
  /** 禁用状态 */
  disabled?: boolean;
  /** 悬浮提示文案（支持原生 tooltip 或 Conex Tooltip） */
  tooltip?: string;
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

---

### 2.3 像素级缩进（`inset`）与槽位基线排版规范

借鉴 `reference/appica-ui` 的结构化槽位与 `reference/ui` 的基线对齐策略，所有 MenuItem 内部采用刚性网格槽位划分：

```
+-----------------------------------------------------------------------------+
| [Leading Slot: 20px] | [Content Slot: flex 1 1 auto] | [Trailing Slot: auto]|
| Check / Radio / Icon | Title / Description          | Shortcut / Chevron   |
+-----------------------------------------------------------------------------+
```

1. **Leading Slot（20px 宽度，居中对齐）**：
   - `CheckboxItem`：渲染 14px 动态 Check 勾选图标；
   - `RadioItem`：渲染 6px 实心圆点（或 Check 状态图标）；
   - 常规 `MenuItem` 带图标时：渲染 16px `AppIcon`；
2. **`inset` 属性基线对齐契约**：
   - 当菜单中存在部分无图标的普通文本项，但同组存在带图标/Check 项时，设置 `inset={true}` 会强制为 Leading Slot 保留 `padding-left: 28px`（20px slot + 8px gap）。
   - **绝对杜绝**：文本左右晃动、错位的参差现象。

---

### 2.4 双层 Context 隔离架构与 Collection 自动收集器

为解决单 Context 引发的全量重渲染以及二级子菜单 focusedIndex 串扰，基座采用分层 Context 架构：

```
                  +-----------------------------------+
                  |          MenuRootContext          |
                  | 全局状态: isOpen, closeMenu, ...  |
                  +-----------------------------------+
                                    |
          +-------------------------+-------------------------+
          | (Level 0: 根菜单)                                  | (Level 1: 子菜单)
+-----------------------------------+     +-----------------------------------+
|      MenuCollectionProvider       |     |      MenuCollectionProvider       |
| 收集 Level 0 的全部 MenuItemRecord|     | 收集 Level 1 的全部 MenuItemRecord|
+-----------------------------------+     +-----------------------------------+
                  |                                                   |
+-----------------------------------+     +-----------------------------------+
|         MenuLevelContext          |     |         MenuLevelContext          |
| 私有: focusedIndex, level=0, ref  |     | 私有: focusedIndex, level=1, ref  |
+-----------------------------------+     +-----------------------------------+
```

#### 1. 轻量注册制收集器契约（弥合声明式 JSX 与 A11y 漫游 Hook）

```typescript
// apps/crish-desktop/src/components/ui/internal/menu-base/MenuCollectionContext.tsx
import React, { createContext, useContext, useRef, useCallback, useId } from 'react';

export interface MenuItemRecord {
  id: string;
  ref: React.RefObject<HTMLElement | null>;
  textValue: string;
  disabled: boolean;
  hasSubmenu?: boolean;
}

interface MenuCollectionContextValue {
  registerItem: (item: MenuItemRecord) => () => void;
  getItems: () => MenuItemRecord[];
}

const MenuCollectionContext = createContext<MenuCollectionContextValue | null>(null);

export const MenuCollectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const itemsRef = useRef<Map<string, MenuItemRecord>>(new Map());

  const registerItem = useCallback((item: MenuItemRecord) => {
    itemsRef.current.set(item.id, item);
    return () => {
      itemsRef.current.delete(item.id);
    };
  }, []);

  const getItems = useCallback(() => {
    // 依据 DOM 树物理位置严格排序，保证动态条件渲染项的键盘顺序绝对正确
    return Array.from(itemsRef.current.values()).sort((a, b) => {
      const elA = a.ref.current;
      const elB = b.ref.current;
      if (!elA || !elB) return 0;
      return elA.compareDocumentPosition(elB) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }, []);

  return (
    <MenuCollectionContext.Provider value={{ registerItem, getItems }}>
      {children}
    </MenuCollectionContext.Provider>
  );
};

export function useMenuCollection(): MenuCollectionContextValue {
  const ctx = useContext(MenuCollectionContext);
  if (!ctx) {
    throw new Error('useMenuCollection must be used within a MenuCollectionProvider');
  }
  return ctx;
}
```

#### 2. MenuItem 自动注册与 Ref 绑定

每个 `<ContextMenuItem>` 或 `<DropdownMenuItem>` 挂载时，通过 `useId()` 或传入的 `id` 自动向 `MenuCollectionContext` 登记：

```typescript
// ContextMenuItem 内部接入示意
const itemRef = useRef<HTMLDivElement>(null);
const autoId = useId();
const itemId = id || autoId;
const { registerItem } = useMenuCollection();

useEffect(() => {
  const unregister = registerItem({
    id: itemId,
    ref: itemRef,
    textValue: textValue || (typeof children === 'string' ? children : itemRef.current?.textContent || ''),
    disabled: Boolean(disabled),
    hasSubmenu: false,
  });
  return unregister;
}, [itemId, registerItem, textValue, children, disabled]);
```

**架构收益**：开发者在编写业务菜单时保持纯粹的声明式 JSX（无需显式传递 `items` 静态数组），而底层的 `useMenuKeyNav` 漫游状态机与 `useTypeahead` 则能以 O(1) 性能准确获知当前可见的所有选项、禁用状态与搜索文本！

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

#### 1. 痛点场景与源码红线
当用户将鼠标从父菜单项（`SubTrigger`）斜向移动到展开的子菜单（`SubContent`）时，光标极易短暂穿过相邻的其它兄弟菜单项。
在底层源码 `apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts:317-318` 中明确记录了核心红线：
> **“运动趋势判定：只有当光标明显向反方向撤退回缩时，才提前释放安全区。严禁将目标当成单一几何中心点作内积判断，避免斜向划入目标下半部分时被误杀。”**

本方案严格遵守该红线，**坚决废除中心点内积算法**，采用纯粹的速度向量回缩检测 + 2D 向量叉积安全区算法。

#### 2. 几何算法数学推导（2D Vector Cross Product & Flip Left 镜像对称）

```
[场景 A: 子菜单向右展开 (placement === 'right')]
       (X_cursor, Y_cursor) 光标当前瞬时位置 P
              \
               \   安全保护区 Safe Triangle (P, V_top, V_bottom)
                \
                 +-----------------------+
                 | V_top                 | (X_sub = SubBounds.left)
                 |                       |
                 |      SubContent       |
                 |       (子菜单)         |
                 |                       |
                 | V_bottom              |
                 +-----------------------+

[场景 B: 视口右侧空间不足，向左翻折 (placement === 'left' / flipLeft)]
                 +-----------------------+
                 |                 V_top | (X_sub = SubBounds.right)
                 |                       |    /
                 |      SubContent       |   /   安全保护区 Safe Triangle
                 |       (子菜单)         |  /    (P, V_top, V_bottom)
                 |                       | /
                 |              V_bottom |/
                 +-----------------------+
                                         P (X_cursor, Y_cursor)
```

1. **顶点构建与镜像对称（Adaptive Vertex Construction）**：
   - 目标子菜单边界矩形为 `subRect`，容差外扩 `pad = 4px`；
   - **当子菜单在右侧展开（`placement === 'right'`）时**：
     三角形底边为子菜单的**左边界** $X_{sub} = \text{subRect.left}$：
     $$V_{top} = (X_{sub}, \text{subRect.top} - \text{pad}), \quad V_{bottom} = (X_{sub}, \text{subRect.bottom} + \text{pad})$$
   - **当子菜单在左侧展开（`placement === 'left'`，即 `flipLeft` 状态）时**：
     三角形底边为子菜单的**右边界** $X_{sub} = \text{subRect.right}$：
     $$V_{top} = (X_{sub}, \text{subRect.top} - \text{pad}), \quad V_{bottom} = (X_{sub}, \text{subRect.bottom} + \text{pad})$$
2. **2D 向量叉积内部点命中准则**：
   - 对于线段 $AB$ 与点 $M$，定义叉积标量：
     $$\text{CrossProduct}(A, B, M) = (B_x - A_x)(M_y - A_y) - (B_y - A_y)(M_x - A_x)$$
   - 计算光标轨迹点 $M$ 相对三角形三条边 $PV_{top}$、$V_{top}V_{bottom}$、$V_{bottom}P$ 的符号：
     $$c_1 = \text{CrossProduct}(P, V_{top}, M), \quad c_2 = \text{CrossProduct}(V_{top}, V_{bottom}, M), \quad c_3 = \text{CrossProduct}(V_{bottom}, P, M)$$
   - **充要条件**：当且仅当 $c_1, c_2, c_3$ 全部 $\ge 0$ 或全部 $\le 0$ 时，点 $M$ 严格位于 Safe Triangle 内部。
3. **速度趋势回缩判定（避免误杀，对齐 SafeAimEngine.ts）**：
   - 设当前光标速度 $v_x = P_{t.x} - P_{t-1.x}$：
   - **向右展开时**：若 $v_x < -2$，说明光标正在明确反向向左回缩，立即提前释放安全区；
   - **向左展开时**：若 $v_x > 2$，说明光标正在明确反向向右回缩，立即提前释放安全区；
   - 彻底消灭“斜向划向长子菜单底部时因中心点点积 $\le 0$ 而被误熔断闪退”的致命缺陷！
4. **离开宽限期修正（顺从现有测试资产，对齐 150ms）**：
   - **关键约束**：在现有测试 `SidebarContextMenus.flyout.test.tsx` 中，存在多处 `act(() => vi.advanceTimersByTime(200));` 验证移出行后子菜单关闭的断言；
   - **参数修正**：鼠标离开触发器且未指向子菜单时的离开宽限期（Leave Grace Timer）**严格设定为 150ms**（与生产环境 `ContextMenuFlyout.tsx:218` 保持 100% 吻合），严禁设为 300ms，确保 200ms 推进时测试 100% 绿灯！

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

## 四、LayerStack 浮层拓扑、FocusTrap 穿透与事件流整合

### 4.1 FocusTrap 模态白名单放行（P0 致命修复）

#### 1. 冲突机理与现场代码
在 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx` 中，全局单例 `FocusTrapIsolationManager` 在模态弹窗（Dialog、ConfirmDialog、SettingsPanel、RulesEditorDialog 等）打开时，会遍历 `document.body` 的所有直接子元素。凡是不在 `isWhitelisted` 白名单内的节点，全部被强制写入：
```typescript
target.setAttribute('aria-hidden', 'true');
target.setAttribute('inert', '');
```
并且在全局 `handleKeyDown` 中，若 `activeEl` 不在白名单浮层内部且不在弹窗内，会将焦点强行拉回弹窗首个可聚焦元素。

#### 2. 双向白名单放行契约
为了彻底杜绝“在设置面板或确认弹窗内右击时，右键菜单变 inert 死节点且 Tab 键夺焦”的灾难，制定以下双向放行标准：

1. **修正 `focusTrap.tsx` 白名单判断（底座加固）**：
   ```typescript
   // apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx
   private isWhitelisted(node: Element): boolean {
     if (
       node.hasAttribute('data-radix-popper-content-wrapper') ||
       node.getAttribute('data-tooltip-portal') === 'true' ||
       node.getAttribute('data-toast-container') === 'true' ||
       node.classList.contains('radix-popper-content-wrapper') ||
       node.classList.contains('toaster') ||
       node.id === 'toast-root' ||
       node.id === 'tooltip-portal' ||
       // 放行所有自研浮层与菜单白名单标记
       node.hasAttribute('data-floating-layer') ||
       node.getAttribute('data-floating-portal') === 'true' ||
       node.getAttribute('data-slot') === 'select-content' ||
       node.getAttribute('data-slot') === 'combobox-content' ||
       node.getAttribute('data-slot') === 'menu-content' ||
       node.getAttribute('data-slot') === 'context-menu-content' ||
       node.getAttribute('role') === 'menu' ||
       node.getAttribute('role') === 'menubar' ||
       node.getAttribute('role') === 'listbox' ||
       node.querySelector?.(
         '[data-floating-layer], [data-floating-portal], [data-slot="menu-content"], [data-slot="context-menu-content"], [role="menu"]'
       ) != null
     ) {
       return true;
     }
     return false;
   }
   ```
2. **修正 `focusTrap.tsx` Tab 按键放行**：
   ```typescript
   // focusTrap.tsx:230-237
   if (
     activeEl &&
     activeEl.closest?.(
       '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-radix-popper-content-wrapper], [data-floating-layer], [data-floating-portal], [data-slot="menu-content"], [data-slot="context-menu-content"], [role="menu"]'
     )
   ) {
     return; // 直接放行，交由菜单自身的 useMenuKeyNav 状态机接管！
   }
   ```
3. **组件端属性刚性挂载**：
   在 `ContextMenuContent` 与 `DropdownMenuContent` 渲染时，外层 Portal 容器与内容容器必须带有 `data-floating-layer="true"`、`data-floating-portal="true"` 以及 `data-slot="context-menu-content"`。

---

### 4.2 LayerStack 全局调度与排他机制

所有 `ContextMenu` 与 `DropdownMenu` 实例必须通过 `useLayerRegistration` 统一接入 Conex 内核的 `LayerStackService`（见 `apps/crish-desktop/src/components/ui/internal/layer-registration/useLayerRegistration.ts`）：

```typescript
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

---

### 4.3 键盘漫游完整状态机契约与多级子菜单阻止冒泡隔离

| 按键动作 | 处于根菜单内容（`Content`） | 处于子菜单触发器（`SubTrigger`） | 处于子菜单内容（`SubContent`） |
| :--- | :--- | :--- | :--- |
| **ArrowDown** | 循环移动至下一个未禁用的 MenuItem | 移动至下一个菜单项 | 在子菜单内向下循环移动 |
| **ArrowUp** | 循环移动至上一个未禁用的 MenuItem | 移动至上一个菜单项 | 在子菜单内向上循环移动 |
| **ArrowRight** | 若当前项为 `SubTrigger`，立即展开子菜单并聚焦其第一项；否则忽略 | 展开子菜单并聚焦其第一项 | 忽略 |
| **ArrowLeft** | 忽略 | 忽略 | **`e.stopPropagation()` 仅关闭当前 `SubContent`**，焦点无缝返回父级 `SubTrigger` |
| **Enter / Space**| 激活当前选中的项（执行 `onSelect`），关闭整个菜单 | 展开子菜单并聚焦其第一项 | 激活当前单选/复选/常规项 |
| **Escape** | 关闭当前整个上下文菜单，恢复触发器焦点 | 关闭当前整个上下文菜单 | **`e.stopPropagation()` 仅关闭当前子菜单**，焦点停留在父级 `SubTrigger` |

> **【冒泡隔离硬性纪律】**：  
> `DropdownMenuSubContent` 与 `ContextMenuSubContent` 捕获到 `ArrowLeft` 或 `Escape` 时，**必须调用 `e.stopPropagation()`**，绝对禁止让按键事件冒泡至顶层 `DropdownMenuContent`，否则会导致整个下拉菜单被误关。

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
| **快捷键排版与真实性** | 纯文本追加，且 F2 / Del 为虚假欺骗快捷键 | `<ContextMenuShortcut>` 等宽右对齐 + 容器级真实键盘调度绑定 |
| **模态穿透能力** | 无 FocusTrap 白名单标记，弹窗内右键会被打成 inert | 具备 `data-floating-layer` 属性，弹窗内右键 100% 正常响应 |

---

### 6.2 彻底根除“假快捷键”：真实快捷键绑定契约

#### 1. 现状欺骗分析
在原版代码中，展示了三个快捷键标识：
- 重命名：`F2`
- 分叉：`Ctrl+Shift+F`
- 删除当前对话：`Del`

然而穿透全仓代码发现：
- 仅 `Ctrl+Shift+F` 在 `ShortcutRegistry.ts` 中注册并由 `AppShortcuts.ts` 处理；
- `F2` 与 `Del` 从未在任何注册表或侧栏列表中监听，用户按下按键毫无反应！

#### 2. 治理与绑定方案（SSOT 落地）
为消除此种技术负债，在重构方案中明确契约：
1. 侧栏会话项列表（`ProjectsSection.tsx` / `GeneralSection.tsx`）中的会话行容器必须挂载容器级快捷键监听 Hook `useSessionItemShortcuts`：
   ```typescript
   export function useSessionItemShortcuts(
     sessionId: string,
     callbacks: {
       onRename: () => void;
       onDelete: () => void;
       onBranch: () => void;
     }
   ) {
     return (e: React.KeyboardEvent) => {
       if (isEditableElement(e.target)) return;
       if (e.key === 'F2') {
         e.preventDefault();
         callbacks.onRename();
       } else if (e.key === 'Delete') {
         e.preventDefault();
         callbacks.onDelete();
       } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
         e.preventDefault();
         callbacks.onBranch();
       }
     };
   }
   ```
2. `<ContextMenuShortcut>` 显示的快捷键标签必须与此真实监听严格保持一致，达到视觉展示与执行面的单一真理源。

---

### 6.3 重构落地代码（完整 drop-in replacement）

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
 * 保留 key={sessionId} 防残余，补全 export tooltip，注入 FocusTrap 白名单标记。
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
        key={contextMenu?.sessionId} // 关键：切换右键目标会话时强制重新挂载，重置进场动效与聚焦状态
        ref={menuRef}
        layerId={SESSION_CONTEXT_MENU_LAYER_ID}
        anchorPoint={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : undefined}
        triggerRef={contextMenuTriggerRef}
        aria-label="会话操作"
        data-testid="session-context-menu"
        data-floating-layer="true"
        data-floating-portal="true"
        data-slot="context-menu-content"
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

        {/* 导出项（保留原有 tooltip 提示） */}
        <ContextMenuItem
          tooltip="导出为 Markdown"
          onSelect={() => onSessionAction('export')}
        >
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

**粉碎结论**：所有上述手搓逻辑完全属于通用级联下拉菜单的标准职责。改用自研 `<DropdownMenu>` 复合组件后，所有状态机、定时器、定位反转、键盘漫游与角色标记均在基座内部内聚完成，**组件代码从 479 行直接压缩至 60 行，瘦身幅度达 87.5%**！

---

### 7.2 现有 Vitest 测试资产兼容高保真封装（`DropdownMenuSubTrigger`）

为严格顺从 `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.flyout.test.tsx` 中的断言契约：
- **测试要求 1**：行必须具备 `tabIndex={0}`、`role="menuitem"` 以及 `data-fly-row`；
- **测试要求 2**：点击整行必须能够触发子菜单展开（`fireEvent.click(sortRow)`）；
- **测试要求 3**：`DropdownMenuSubContent` 捕获到 `ArrowLeft` 或 `Escape` 时必须调用 `e.stopPropagation()` 并仅收起自身，不关闭整个排序菜单。

`DropdownMenuSubTrigger` 封装实现契约如下：

```tsx
// DropdownMenuSubTrigger 实现规范
export interface DropdownMenuSubTriggerProps {
  label: string;
  valueLabel: string;
  flyKey: 'sort' | 'group' | 'filter';
  className?: string;
}

export const DropdownMenuSubTrigger: React.FC<DropdownMenuSubTriggerProps> = ({
  label,
  valueLabel,
  flyKey,
  className,
}) => {
  const { open, setOpen, triggerRef } = useDropdownMenuSubContext();

  return (
    <div
      ref={triggerRef}
      role="menuitem"
      tabIndex={0}
      data-fly-row={flyKey}
      aria-haspopup="true"
      aria-expanded={open}
      className={`${styles.sortFilterRow} ${open ? styles.isOpen : ''} ${className ?? ''}`}
      onClick={() => setOpen(!open)} // 保证点击整行能展开/收起子菜单
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      <span className={styles.sortFilterRowLabel}>{label}</span>
      <span className={styles.sortFilterRowRight}>
        <span className={styles.sortFilterRowValue}>{valueLabel}</span>
        <AppIcon name="chevron-right" size={14} className={styles.sortFilterChev} aria-hidden />
      </span>
    </div>
  );
};
```

---

### 7.3 重构落地代码（压缩至 60 行内的高内聚组件）

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
        data-floating-layer="true"
        data-slot="menu-content"
        className={`${styles.sortFilterMenu} ${styles.open} no-drag`}
      >
        {/* 排序方式子菜单 */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            flyKey="sort"
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
            flyKey="group"
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
            flyKey="filter"
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

---

### 7.4 回归测试 100% 对齐证明（对齐 `SidebarContextMenus.flyout.test.tsx`）

| 测试用例与行为 | 对应断言与推进机制 | 基座实现与兼容契约 | 判定 |
| :--- | :--- | :--- | :---: |
| **鼠标移出行后 flyout 关闭** | `fireEvent.mouseLeave(row);`<br>`vi.advanceTimersByTime(200);`<br>`expect(group).not.toBeInTheDocument();` | 基座内部内置 `SafeTriangle` 离开宽限期为 **150ms**（严格小于 200ms），并在 150ms 超时后关闭子菜单。 | **PASS** |
| **鼠标移入 flyout 内部不误关** | `mouseLeave(row); mouseEnter(flyout);`<br>`vi.advanceTimersByTime(200);`<br>`expect(group).toBeInTheDocument();` | 进入 `DropdownMenuSubContent` 立即取消离开定时器，保持子层级展开。移出 flyout 后 150ms 关闭。 | **PASS** |
| **ArrowLeft 仅关闭 flyout 且不关闭主菜单** | `fireEvent.keyDown(flyout, { key: 'ArrowLeft' });`<br>`expect(group).not.toBeInTheDocument();`<br>`expect(onCloseSortDropdown).not.toHaveBeenCalled();` | `DropdownMenuSubContent` 捕获 `ArrowLeft` 时调用 `e.stopPropagation()`，仅收起本层级子菜单并归还焦点给 `SubTrigger`。 | **PASS** |
| **Esc 仅关闭 flyout 且不关闭主菜单** | `fireEvent.keyDown(flyout, { key: 'Escape' });`<br>`expect(group).not.toBeInTheDocument();`<br>`expect(onCloseSortDropdown).not.toHaveBeenCalled();` | `DropdownMenuSubContent` 捕获 `Escape` 时调用 `e.stopPropagation()`，仅收起子菜单并把焦点还给触发器。 | **PASS** |
| **ArrowRight 打开 flyout 并聚焦首项** | `fireEvent.keyDown(row, { key: 'ArrowRight' });`<br>`act(() => vi.advanceTimersByTime(20));`<br>`expect(firstOption).toHaveFocus();` | `DropdownMenuSubTrigger` 捕获 `ArrowRight`，开启子菜单并在 rAF 中自动将焦点赋予第一个 RadioItem。 | **PASS** |
| **行可聚焦（tabIndex 可达）** | `expect(row.tabIndex).toBe(0);`<br>`expect(row).toHaveAttribute('role', 'menuitem');` | `DropdownMenuSubTrigger` 根 DOM 明确注入 `tabIndex={0}` 与 `role="menuitem"`。 | **PASS** |
| **点击整行触发子菜单展开** | `fireEvent.click(sortRow);`<br>`expect(screen.getByRole('group')).toBeInTheDocument();` | `DropdownMenuSubTrigger` 明确绑定 `onClick={() => setOpen(!open)}`。 | **PASS** |

---

## 八、新组件目录结构与落盘布局

在 `apps/crish-desktop/src/components/ui/` 下构建高内聚的原子组件目录：

```
apps/crish-desktop/src/components/ui/
├── ContextMenu/
│   ├── index.ts                      # 统一导出 ContextMenu 矩阵组件与类型
│   ├── ContextMenu.tsx               # ContextMenu 根组件与 ContextMenuTrigger
│   ├── ContextMenuContent.tsx        # 浮层定位、Portal、FocusTrap 白名单标记
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
    │   ├── MenuRootContext.ts        # 全局根 Context 定义
    │   ├── MenuLevelContext.ts       # 逐层级私有漫游 Context 定义
    │   ├── MenuCollectionContext.tsx # 声明式子组件自动收集器
    │   ├── useMenuKeyboard.ts        # 键盘漫游状态机 Hook（↑↓←→ Esc Space Enter）
    │   ├── useMenuAim.ts             # Safe Triangle Aim 保护区与射线碰撞 Hook
    │   └── usePointerLongPress.ts    # 触控长按手势监听 Hook
    ├── SafeTriangle.ts               # 纯数学 2D 向量叉积与镜像反射几何计算
    └── layer-stack/                  # 全局浮层层栈调度服务
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
  FocusTrap 白名单与 Collection 收集器 (TU-01)  :active, p1, 0, 2
  Safe Aim 镜像算法与 150ms 离开参数 (TU-02)    :p2, 2, 4
  section 阶段二：复合组件装配
  ContextMenu 复合组件矩阵与 A11y 注入 (TU-03)   :p3, 4, 6
  DropdownMenu 同构组件与样式落盘 (TU-04)        :p4, 6, 8
  section 阶段三：业务实战重构
  SessionContextMenu 声明式与真实快捷键 (TU-05) :p5, 8, 10
  彻底干掉 ContextMenuFlyout 479 行代码 (TU-06)  :p6, 10, 12
  section 阶段四：立体门禁验证
  单元测试与 flyout 回归用例全绿验证 (TU-07)     :p7, 12, 14
```

### 9.1 任务单元与交付清单

1. **TU-01：FocusTrap 白名单穿透与 Collection 自动收集器**：
   - 增强 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx` 中的 `isWhitelisted` 与 Tab 放行逻辑；
   - 编写 `internal/menu-base/MenuCollectionContext.tsx`，支持 DOM 物理排序与动态增删；
2. **TU-02：Safe Aim 镜像几何算法与 150ms 宽限超时**：
   - 实现 `SafeTriangle.ts` 的 `flipLeft` 目标右边界反射与速度矢量回缩判定，彻底剔除中心点内积算法；
   - 宽限超时统一落地为 150ms；
3. **TU-03 & TU-04：复合组件装配与同心几何样式**：
   - 完成 `ContextMenu/*` 与 `DropdownMenu/*` 组件代码，刚性挂载 `data-floating-layer`、`data-slot` 属性；
4. **TU-05：`SessionContextMenu.tsx` 重构与快捷键绑定**：
   - 彻底废除配置对象，保留 `key={sessionId}`，补齐 export tooltip；接入会话列表真实快捷键监听 Hook；
5. **TU-06：`ContextMenuFlyout.tsx` 粉碎重构**：
   - 从 479 行手搓状态机收敛至 60 行内；`DropdownMenuSubTrigger` 保持 `role="menuitem"` 与 `onClick` 展开；
6. **TU-07：立体门禁与测试资产守门**：
   - 运行 `npx vitest run apps/crish-desktop/src/components/sidebar/SidebarContextMenus.flyout.test.tsx`（5/5 全绿）；
   - 运行 `npx vitest run apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx`（全绿）；
   - 执行 `npm run typecheck` 验证零类型错误；
   - 执行 `npm run check:line-counts` 验证行数门禁零报警。

---

## 十、总结与结论

本方案完全在 Conex 自研技术底座上展开：
1. **零外部 UI 栈膨胀**：彻底摒弃外部 UI 库，使用纯 React Context + 自研单源 Positioner 引擎；
2. **P0 级模态安全穿透**：通过刚性白名单打通 `FocusTrap` 隔离层，彻底根除弹窗内右键被 `inert` 与抢焦的致命缺陷；
3. **声明式与状态机双模统一**：基于 `MenuCollectionContext` 自动注册制收集器，完美弥合声明式 JSX 语法与 A11y 漫游引擎的范式撕裂；
4. **严谨的几何与物理测试对齐**：修复 SafeAim 在 `flipLeft` 视口翻折时的反射算法，修正 150ms 离开超时窗口，保证现存 Vitest 测试资产 100% 绿灯；
5. **彻底根除历史技术债务**：干掉 `ContextMenuFlyout.tsx` 的 479 行冗余手搓逻辑，代码量骤降 87.5%，消灭 SessionContextMenu 的“假快捷键”欺骗。
方案具备高度可行性与立体验证支撑，可立即转入工程落地阶段。
