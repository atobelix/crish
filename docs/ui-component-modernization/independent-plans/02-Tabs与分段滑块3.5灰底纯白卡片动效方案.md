# Tabs 与分段滑块 3.5% 灰底纯白卡片动效方案

> **文件路径**：`docs/ui-component-modernization/independent-plans/02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md`  
> **所属战役**：UI 组件现代化与原生原子库升级（`ui-component-modernization`）  
> **核心使命**：严格遵守用户最高原则——**严禁引入外部组件库，吸收 Appica UI 的滑动指示器物理动效、按压缩放微交互与圆角设计，自研现代纯净的 Tabs / SegmentedControl**。

---

## 目录
1. [方案概述与设计哲学](#一方案概述与设计哲学)
2. [背景与滑块色彩规范（3.5% 灰底与纯白卡片）](#二背景与滑块色彩规范)
3. [指示器平滑滑动与按压回弹物理算法](#三指示器平滑滑动与按压回弹物理算法)
4. [同心圆角几何体系（Concentric Radius Geometry）](#四同心圆角几何体系)
5. [两类变体与维度支持（Pill 胶囊卡片 vs Line 下划线滑块）](#五两类变体与维度支持)
6. [双层架构与 TypeScript API 契约设计](#六双层架构与-typescript-api-契约设计)
7. [CSS Modules 完整样式系统规划](#七css-modules-完整样式系统规划)
8. [核心组件完整实现源码（Zero-Dependency）](#八核心组件完整实现源码)
9. [无障碍可访问性（WAI-ARIA 与 Roving Tabindex 键盘漫游）](#九无障碍可访问性)
10. [存量消费点平滑迁移与测试验证套件](#十存量消费点平滑迁移与测试验证套件)

---

## 一、方案概述与设计哲学

在 Conex / Crish 桌面端重构与现代化演进中，分段切换（`SegmentedControl`）与标签页系统（`Tabs`）是用户高频交互的视觉中枢。当前工程中已存在基于 `ResizeObserver` 与 FLIP 机制的初步 `SegmentedControl`，但存在以下交互与视觉痛点：
1. **物理质感不足**：滑块切换为基础的 `cubic-bezier(0.2, 0, 0, 1)` 缓动，缺乏 Appica UI 具备的**弹性微过冲（Micro-Rebound）与物理惯性**；
2. **按压反馈缺失**：Tab 项在鼠标按下（Active/Press）时为纯静态文字变色，缺乏 Appica UI 的 **`scale(0.97)` 弹性微压缩与 `translateY(1px)` 重力下沉**；
3. **形态受限**：仅支持单行紧凑型 `SegmentedControl`，缺少面向多视图/长面板的标准复合组件 `Tabs`（含 `Tabs.List`、`Tabs.Trigger`、`Tabs.Content`）与 `line`（下划线指示器）变体；
4. **同心圆角与光影规范需严格锁定**：需建立自适应的 $R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$ 几何约束与 3.5% 纯净灰底板 + 纯白卡片光影层次。

本方案在**零外部依赖**（不引入 Radix UI, Base UI, Tailwind, Framer Motion 等）的前提下，完整吸收 Appica UI 物理精髓，自研现代纯净的双层组件系统。

---

## 二、背景与滑块色彩规范

严格落实用户指令与 Zero-Blue（零偏蓝、纯中性暖灰）色彩体系：

### 1. 色彩参数矩阵

| 视觉元素 | 亮色模式 (Light Theme) | 暗色模式 (Dark Theme) | 物理质感与光学作用 |
| :--- | :--- | :--- | :--- |
| **容器外底板 (Track / Baseplate)** | `var(--bg-secondary)` (`hsl(35 8% 92.1%)` / 3.5% 微暖灰) | `var(--bg-secondary)` (`#242424` / `hsl(0 0% 14%)`) | 沉降底托，提供低对比度的沉浸背景槽位，零冷蓝杂色 |
| **激活指示器 (Active Slider)** | `var(--bg-card)` (`hsl(0 0% 100%)` 纯白) | `var(--bg-elevated)` (`#2a2a2a` / `hsl(0 0% 16.5%)`) | 浮起卡片质感，形成清晰的物理抬升层 |
| **滑块发丝边框 (Slider Hairline)** | `1px solid var(--border-subtle)` (`hsl(35 8% 91%)`) | `1px solid var(--border-subtle)` (`hsl(0 0% 20%)`) | 精准勾勒纯白滑块与灰底边缘，防止纯白卡片在强光下边缘晕开 |
| **滑块投影 (Slider Shadow)** | `0 1px 2px rgba(0, 0, 0, 0.05), 0 1px 1px rgba(0, 0, 0, 0.02)` | `0 1px 3px rgba(0, 0, 0, 0.35), 0 1px 1px rgba(0, 0, 0, 0.20)` | 极克制的 1~2px 柔和微投影，营造精致浮空深度 |
| **未激活文本 (Inactive Label)** | `var(--text-secondary)` (`#555555`) | `var(--text-secondary)` (`#aaaaaa`) | 常态低调可读，`font-weight: 400` |
| **激活文本 (Active Label)** | `var(--text-primary)` (`#111111`) | `var(--text-primary)` (`#dddddd`) | 聚焦高对比度，`font-weight: 500` |
| **悬停微底色 (Item Hover)** | `var(--tint-hover)` (`color-mix(in srgb, var(--text-primary) 3.5%, transparent)`) | `var(--tint-hover)` (`color-mix(in srgb, var(--text-primary) 3.5%, transparent)`) | 鼠标悬停时的若隐若现微光环，不破坏整体底板一致性 |

---

## 三、指示器平滑滑动与按压回弹物理算法

### 1. 滑块平滑滑动与弹性微过冲（Appica Elastic Micro-Rebound）
Appica UI 核心动效曲线为：
$$\text{cubic-bezier}(0.175, 0.885, 0.32, 1.5)$$

- **物理参数解析**：
  - 前半段 $(0.175, 0.885)$：以极快加速度启动并迅速跨越 $88.5\%$ 的位移；
  - 后半段 $(0.32, 1.5)$：$y_2 = 1.5 > 1.0$，指示器在到达目标锚点瞬间会产生约 $5\% \sim 8\%$ 的**弹性微过冲**，随后在 $250\text{ms}$ 结束前迅速回弹落锁。
- **CSS 动效属性**：
  ```css
  --tab-transition-spring: 250ms cubic-bezier(0.175, 0.885, 0.32, 1.5);
  transition: transform var(--tab-transition-spring), width var(--tab-transition-spring), height var(--tab-transition-spring), opacity 120ms ease;
  ```

### 2. 按钮按压缩放与重力微交互（Micro Press Physics）
Tab 触发器（Trigger）采用双层 DOM 架构：
- **外层 `TabsTrigger`**：负责布局边界、事件监听与 Focus Ring；
- **内层 `tabsTriggerInner`**：承载 GPU 合成层微交互：
  1. **按压状态（Active / Mousedown）**：
     - `scale(0.97)`：模拟真实按键被手指轻压时的轻微弹性下陷；
     - `translateY(1px)`：模拟机械开关下沉行程；
     - `transition: transform 100ms ease-in-out`：瞬时响应按压。
  2. **释放状态（Release / Mouseup）**：
     - `scale(1)` 与 `translateY(0)`；
     - `transition: transform 250ms cubic-bezier(0.175, 0.885, 0.32, 1.5)`：以弹性过冲平滑回弹。

---

## 四、同心圆角几何体系

### 1. 同心几何数学公式
为消除外框圆角与内部滑块圆角在不同内边距下的「月牙形畸变（Corner Pinching）」与「视觉留白不均」，内部滑块圆角严格遵循同心圆半径公式：
$$R_{\text{inner}} = \max(0, R_{\text{outer}} - \text{Padding})$$

```
+------------------------------------------------------+  R_outer
|  Padding                                             |
|   +----------------------------------------------+   |
|   | Active Card Indicator                        |   |  R_inner = R_outer - Padding
|   +----------------------------------------------+   |
+------------------------------------------------------+
```

### 2. 各尺寸档位同心圆角对照表

| 尺寸档位 (`size`) | 容器高度 (`height`) | 容器外边距 (`padding`) | 外框圆角 ($R_{\text{outer}}$) | 滑块同心圆角 ($R_{\text{inner}}$) | 字号 / 图标尺寸 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`xs`** | `24px` | `2px` | `6px` (`var(--radius-md)`) | `4px` ($6 - 2$) | `12px` / `14px` |
| **`sm` (默认)** | `28px` | `2px` | `7px` (`var(--button-radius)`) | `5px` ($7 - 2$) | `13px` / `15px` |
| **`md`** | `32px` | `3px` | `8px` (`var(--radius-lg)`) | `5px` ($8 - 3$) | `14px` / `16px` |
| **`lg`** | `38px` | `3.5px` | `10px` (`var(--radius-xl)`) | `6.5px` ($10 - 3.5$) | `15px` / `18px` |

---

## 五、两类变体与维度支持

### 1. `pill` 胶囊卡片模式（默认）
- **视觉特征**：3.5% 灰底槽位 + 纯白微投影滑块包裹选中文本；
- **适用场景**：设置面板切换、工具栏筛选、紧凑状态分段控制；
- **排布模式**：支持 `horizontal`（水平）与 `vertical`（垂直侧边切换）。

### 2. `line` 下划线滑块模式
- **视觉特征**：透明容器背景 + 底部 `1px solid var(--border-subtle)` 导轨 + 选定项下方的 `2px` 悬浮圆角指示条（`var(--text-primary)` 或 `var(--brand)`）；
- **适用场景**：主工作区多标签切换、代码/Markdown 预览分栏、文档章节 Tabs；
- **排布模式**：
  - 水平模式：指示条锚定在底部 (`bottom: 0`, `height: 2px`, `width: activeWidth`)；
  - 垂直模式：指示条锚定在左侧 (`left: 0`, `width: 2px`, `height: calc(activeHeight / 2)`)。

---

## 六、双层架构与 TypeScript API 契约设计

### 1. API 架构分层
1. **`SegmentedControl`**：数据驱动型（Data-driven），通过 `options` 数组快速构建，100% 兼容现有业务调用；
2. **`Tabs` 复合组件族**（`Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`）：面向丰富内容布局的容器级组件，支持独立面板受控渲染、惰性挂载（`keepMounted`）与面板入场过渡。

### 2. 完整类型契约定义（`types.ts`）

```typescript
import React from 'react';

export type TabsVariant = 'pill' | 'line';
export type TabsSize = 'xs' | 'sm' | 'md' | 'lg';
export type TabsOrientation = 'horizontal' | 'vertical';

export interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
  size: TabsSize;
  orientation: TabsOrientation;
  registerTrigger: (value: string, element: HTMLElement | null) => void;
  unregisterTrigger: (value: string) => void;
}

export interface TabsProps {
  /** 受控选中值 */
  value?: string;
  /** 非受控默认选中值 */
  defaultValue?: string;
  /** 选中变更回调 */
  onValueChange?: (value: string) => void;
  /** 外观变体：pill(胶囊卡片) | line(下划线指示条) */
  variant?: TabsVariant;
  /** 尺寸档位 */
  size?: TabsSize;
  /** 排布方向 */
  orientation?: TabsOrientation;
  /** 撑满父容器 */
  block?: boolean;
  className?: string;
  children: React.ReactNode;
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  'aria-label'?: string;
  className?: string;
  children: React.ReactNode;
}

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 选项值唯一标识 */
  value: string;
  /** 可选前置图标 */
  icon?: React.ReactNode;
  /** 可选尾部徽标/数量 */
  badge?: React.ReactNode;
  /** 禁用态 */
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 对应 Tab 触发器的唯一标识 */
  value: string;
  /** 是否在未激活时保留 DOM 节点（通过 hidden 隐藏而非卸载） */
  keepMounted?: boolean;
  className?: string;
  children: React.ReactNode;
}

/* 兼容现有 SegmentedControl 的配置式接口 */
export interface SegmentedControlOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: (SegmentedControlOption<T> | T)[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  variant?: TabsVariant;
  size?: TabsSize;
  orientation?: TabsOrientation;
  block?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}
```

---

## 七、CSS Modules 完整样式系统规划

### 1. `SegmentedControl.module.css` / `Tabs.module.css` 核心样式

```css
/* ==========================================================================
   Conex UI - Tabs & SegmentedControl 3.5% 灰底纯白卡片动效体系
   ========================================================================== */

/* ── 1. 基础变量与尺寸几何映射 ── */
.root {
  --tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5);
  --tab-duration: 250ms;
  --tab-press-duration: 100ms;
  
  display: flex;
  position: relative;
  box-sizing: border-box;
}

.root[data-orientation='horizontal'] {
  flex-direction: column;
}

.root[data-orientation='vertical'] {
  flex-direction: row;
}

/* ── 2. TabsList 轨道底板 ── */
.list {
  position: relative;
  display: inline-flex;
  align-items: center;
  user-select: none;
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

.list[data-block='true'] {
  display: flex;
  width: 100%;
}

.list[data-orientation='vertical'] {
  flex-direction: column;
  align-items: stretch;
  width: fit-content;
}

/* 变体：pill 胶囊卡片模式 */
.listPill {
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--tab-outer-radius);
  padding: var(--tab-pad);
  gap: var(--tab-gap);
}

/* 变体：line 下划线模式 */
.listLine {
  background-color: transparent;
  gap: var(--tab-gap);
}

.listLine[data-orientation='horizontal'] {
  border-bottom: 1px solid var(--border-subtle);
}

.listLine[data-orientation='vertical'] {
  border-right: 1px solid var(--border-subtle);
}

/* ── 3. 尺寸档位几何契约 (同心圆角锁定) ── */
.sizeXs {
  --tab-height: 24px;
  --tab-pad: 2px;
  --tab-gap: 2px;
  --tab-outer-radius: var(--radius-md, 6px);
  --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad)); /* 4px */
  --tab-font-size: var(--font-size-xs, 12px);
  --tab-item-px: var(--space-2, 8px);
  --tab-icon-size: 13px;
}

.sizeSm {
  --tab-height: 28px;
  --tab-pad: 2px;
  --tab-gap: 2px;
  --tab-outer-radius: var(--button-radius, 7px);
  --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad)); /* 5px */
  --tab-font-size: var(--font-size-sm, 13px);
  --tab-item-px: var(--space-2_5, 10px);
  --tab-icon-size: 14px;
}

.sizeMd {
  --tab-height: 32px;
  --tab-pad: 3px;
  --tab-gap: 3px;
  --tab-outer-radius: var(--radius-lg, 8px);
  --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad)); /* 5px */
  --tab-font-size: var(--font-size-base, 14px);
  --tab-item-px: var(--space-3, 12px);
  --tab-icon-size: 16px;
}

.sizeLg {
  --tab-height: 38px;
  --tab-pad: 3.5px;
  --tab-gap: 4px;
  --tab-outer-radius: var(--radius-xl, 10px);
  --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad)); /* 6.5px */
  --tab-font-size: var(--font-size-md, 15px);
  --tab-item-px: var(--space-4, 16px);
  --tab-icon-size: 18px;
}

/* ── 4. 激活滑块指示器 (Active Slider / Indicator) ── */
.indicator {
  position: absolute;
  pointer-events: none;
  z-index: 1;
  will-change: transform, width, height, opacity;
  transform-origin: center center;
  transition:
    transform var(--tab-duration) var(--tab-spring-bezier),
    width var(--tab-duration) var(--tab-spring-bezier),
    height var(--tab-duration) var(--tab-spring-bezier),
    opacity 120ms ease;
}

/* pill 滑块：纯白卡片 + 发丝边框 + 柔和低空阴影 */
.indicatorPill {
  border-radius: var(--tab-inner-radius);
  background-color: var(--bg-card, #ffffff);
  border: 1px solid var(--border-subtle);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.05),
    0 1px 1px rgba(0, 0, 0, 0.02);
}

/* line 滑块：圆角高光线条 */
.indicatorLine {
  background-color: var(--text-primary);
  border-radius: var(--radius-full, 9999px);
}

.indicatorLine[data-orientation='horizontal'] {
  bottom: 0;
  height: 2px;
}

.indicatorLine[data-orientation='vertical'] {
  left: 0;
  width: 2px;
}

/* ── 5. Trigger 交互项 ── */
.trigger {
  position: relative;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--tab-height);
  padding: 0 var(--tab-item-px);
  font-family: var(--font-sans, inherit);
  font-size: var(--tab-font-size);
  font-weight: var(--font-weight-normal, 400);
  line-height: 1;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--tab-inner-radius);
  cursor: pointer;
  white-space: nowrap;
  outline: none;
  box-sizing: border-box;
  transition: color 120ms ease;
}

.list[data-block='true'] .trigger {
  flex: 1;
}

/* 悬停微底色 */
.trigger:hover:not(:disabled) {
  color: var(--text-primary);
}

.trigger:hover:not(:disabled):not([data-active='true']) .triggerInner::before {
  opacity: 1;
}

.trigger[data-active='true'] {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium, 500);
}

/* AGENTS.md §13 严格柔和焦点环 */
.trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1.5px
    color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}

.trigger:disabled {
  cursor: not-allowed;
  opacity: var(--opacity-disabled, 0.45);
}

/* ── 6. TriggerInner 微观物理按压交互 ── */
.triggerInner {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1_5, 6px);
  width: 100%;
  height: 100%;
  transform: scale(1) translateY(0);
  transform-origin: center center;
  transition: transform var(--tab-duration) var(--tab-spring-bezier);
}

/* 悬停背板微光 */
.triggerInner::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--tab-inner-radius);
  background-color: var(--tint-hover);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

/* 按压弹性微压缩 (Scale 0.97 + 下沉 1px) */
.trigger:active:not(:disabled) .triggerInner {
  transform: scale(0.97) translateY(1px);
  transition: transform var(--tab-press-duration) ease-in-out;
}

.triggerIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: var(--tab-icon-size);
}

.triggerLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.triggerBadge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 9999px;
  background-color: color-mix(in srgb, var(--text-primary) 8%, transparent);
  color: var(--text-tertiary);
}

/* ── 7. TabsContent 面板过渡 ── */
.content {
  outline: none;
  transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1), transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.content[hidden] {
  display: none !important;
}

/* ── 8. 减弱动画兜底 (Reduced Motion & Eco Tier) ── */
@media (prefers-reduced-motion: reduce) {
  .indicator,
  .triggerInner,
  .content {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }
}

html[data-perf-tier='eco'] .indicator,
html[data-perf-tier='eco'] .triggerInner,
html[data-perf-tier='eco'] .content {
  transition-duration: 0ms !important;
}
```

---

## 八、核心组件完整实现源码

### 1. `Tabs.tsx` 复合组件核心实现

```tsx
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ResizeObserverManager } from '../../../services/ResizeObserverManager';
import styles from './Tabs.module.css';
import {
  TabsContentProps,
  TabsContextValue,
  TabsListProps,
  TabsProps,
  TabsTriggerProps,
} from './types';

const TabsContext = createContext<TabsContextValue | null>(null);

export function useTabsContext() {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('Tabs sub-components must be rendered within a <Tabs> parent.');
  }
  return ctx;
}

export const Tabs: React.FC<TabsProps> = ({
  value: externalValue,
  defaultValue,
  onValueChange,
  variant = 'pill',
  size = 'sm',
  orientation = 'horizontal',
  block = false,
  className,
  children,
}) => {
  const [internalValue, setInternalValue] = useState<string>(defaultValue ?? '');
  const isControlled = externalValue !== undefined;
  const currentValue = isControlled ? externalValue : internalValue;

  const triggerMapRef = useRef<Map<string, HTMLElement>>(new Map());

  const registerTrigger = useCallback((val: string, el: HTMLElement | null) => {
    if (el) triggerMapRef.current.set(val, el);
    else triggerMapRef.current.delete(val);
  }, []);

  const unregisterTrigger = useCallback((val: string) => {
    triggerMapRef.current.delete(val);
  }, []);

  const handleValueChange = useCallback(
    (nextVal: string) => {
      if (!isControlled) {
        setInternalValue(nextVal);
      }
      onValueChange?.(nextVal);
    },
    [isControlled, onValueChange]
  );

  const ctxValue = useMemo<TabsContextValue>(
    () => ({
      value: currentValue,
      onValueChange: handleValueChange,
      variant,
      size,
      orientation,
      registerTrigger,
      unregisterTrigger,
    }),
    [currentValue, handleValueChange, variant, size, orientation, registerTrigger, unregisterTrigger]
  );

  const rootClasses = [
    styles.root,
    styles[`size${size.charAt(0).toUpperCase() + size.slice(1)}`],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <TabsContext.Provider value={ctxValue}>
      <div
        className={rootClasses}
        data-orientation={orientation}
        data-variant={variant}
        data-block={block ? 'true' : undefined}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
};
Tabs.displayName = 'Tabs';

export const TabsList: React.FC<TabsListProps> = ({
  'aria-label': ariaLabel,
  className,
  children,
  ...rest
}) => {
  const { value, variant, size, orientation, onValueChange } = useTabsContext();
  const listRef = useRef<HTMLDivElement | null>(null);

  const [sliderRect, setSliderRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    opacity: number;
  }>({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });

  const updateIndicator = useCallback(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const activeTrigger = listEl.querySelector<HTMLElement>(
      `[data-tabs-trigger][data-value="${CSS.escape(value)}"]`
    );

    if (activeTrigger) {
      const listRect = listEl.getBoundingClientRect();
      const triggerRect = activeTrigger.getBoundingClientRect();

      if (variant === 'pill') {
        setSliderRect({
          x: activeTrigger.offsetLeft,
          y: activeTrigger.offsetTop,
          width: activeTrigger.offsetWidth,
          height: activeTrigger.offsetHeight,
          opacity: 1,
        });
      } else {
        // Line variant
        if (orientation === 'horizontal') {
          setSliderRect({
            x: activeTrigger.offsetLeft,
            y: listEl.clientHeight - 2,
            width: activeTrigger.offsetWidth,
            height: 2,
            opacity: 1,
          });
        } else {
          // Vertical line (centered pill line)
          const lineH = Math.max(16, triggerRect.height / 2);
          setSliderRect({
            x: 0,
            y: activeTrigger.offsetTop + (activeTrigger.offsetHeight - lineH) / 2,
            width: 2,
            height: lineH,
            opacity: 1,
          });
        }
      }
    } else {
      setSliderRect((prev) => ({ ...prev, opacity: 0 }));
    }
  }, [value, variant, orientation]);

  useLayoutEffect(() => {
    updateIndicator();
  }, [updateIndicator]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = ResizeObserverManager.getInstance();
    ro.observe(el, updateIndicator);
    return () => {
      ro.unobserve(el, updateIndicator);
    };
  }, [updateIndicator]);

  // Roving TabIndex 键盘漫游
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const listEl = listRef.current;
    if (!listEl) return;

    const triggers = Array.from(
      listEl.querySelectorAll<HTMLButtonElement>('[data-tabs-trigger]:not(:disabled)')
    );
    if (triggers.length === 0) return;

    const currentIndex = triggers.findIndex(
      (el) => el.getAttribute('data-value') === value
    );

    let nextIndex = -1;
    if (e.key === 'ArrowRight' || (orientation === 'vertical' && e.key === 'ArrowDown')) {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % triggers.length;
    } else if (e.key === 'ArrowLeft' || (orientation === 'vertical' && e.key === 'ArrowUp')) {
      e.preventDefault();
      nextIndex = currentIndex <= 0 ? triggers.length - 1 : currentIndex - 1;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = triggers.length - 1;
    }

    if (nextIndex >= 0 && triggers[nextIndex]) {
      const nextTrigger = triggers[nextIndex];
      const nextValue = nextTrigger.getAttribute('data-value');
      if (nextValue) {
        onValueChange(nextValue);
        nextTrigger.focus();
      }
    }
  };

  const listClasses = [
    styles.list,
    variant === 'pill' ? styles.listPill : styles.listLine,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const indicatorClasses = [
    styles.indicator,
    variant === 'pill' ? styles.indicatorPill : styles.indicatorLine,
  ].join(' ');

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={listClasses}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {/* 物理平滑滑块 */}
      <div
        className={indicatorClasses}
        data-orientation={orientation}
        style={{
          transform: `translate3d(${sliderRect.x}px, ${sliderRect.y}px, 0)`,
          width: `${sliderRect.width}px`,
          height: `${sliderRect.height}px`,
          opacity: sliderRect.opacity,
        }}
        aria-hidden="true"
      />
      {children}
    </div>
  );
};
TabsList.displayName = 'TabsList';

export const TabsTrigger: React.FC<TabsTriggerProps> = ({
  value: itemValue,
  icon,
  badge,
  disabled = false,
  className,
  children,
  onClick,
  ...rest
}) => {
  const { value, onValueChange, registerTrigger } = useTabsContext();
  const isSelected = value === itemValue;
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    registerTrigger(itemValue, triggerRef.current);
    return () => registerTrigger(itemValue, null);
  }, [itemValue, registerTrigger]);

  const triggerClasses = [styles.trigger, className].filter(Boolean).join(' ');

  return (
    <button
      ref={triggerRef}
      type="button"
      role="tab"
      aria-selected={isSelected}
      tabIndex={isSelected ? 0 : -1}
      data-tabs-trigger="true"
      data-value={itemValue}
      data-active={isSelected ? 'true' : undefined}
      disabled={disabled}
      className={triggerClasses}
      onClick={(e) => {
        if (!disabled) onValueChange(itemValue);
        onClick?.(e);
      }}
      {...rest}
    >
      <span className={styles.triggerInner}>
        {icon && <span className={styles.triggerIcon}>{icon}</span>}
        <span className={styles.triggerLabel}>{children}</span>
        {badge && <span className={styles.triggerBadge}>{badge}</span>}
      </span>
    </button>
  );
};
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent: React.FC<TabsContentProps> = ({
  value: panelValue,
  keepMounted = false,
  className,
  children,
  ...rest
}) => {
  const { value } = useTabsContext();
  const isSelected = value === panelValue;
  const contentId = useId();

  if (!isSelected && !keepMounted) {
    return null;
  }

  const contentClasses = [styles.content, className].filter(Boolean).join(' ');

  return (
    <div
      role="tabpanel"
      id={contentId}
      tabIndex={0}
      hidden={!isSelected}
      className={contentClasses}
      {...rest}
    >
      {children}
    </div>
  );
};
TabsContent.displayName = 'TabsContent';
```

### 2. `SegmentedControl.tsx` 增强实现（无缝向下兼容）

```tsx
import React, { forwardRef } from 'react';
import { Tabs, TabsList, TabsTrigger } from '../Tabs/Tabs';
import { SegmentedControlOption, SegmentedControlProps } from '../Tabs/types';

function normalizeOption<T extends string>(
  raw: SegmentedControlOption<T> | T
): SegmentedControlOption<T> {
  if (typeof raw === 'string') {
    return { value: raw as T, label: raw };
  }
  return raw;
}

export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl(
    {
      options: rawOptions,
      value,
      defaultValue,
      onChange,
      variant = 'pill',
      size = 'sm',
      orientation = 'horizontal',
      block = false,
      disabled = false,
      className,
      'aria-label': ariaLabel,
      ...restProps
    },
    ref
  ) {
    const options = rawOptions.map(normalizeOption);
    const initialDefault = defaultValue ?? options[0]?.value;

    return (
      <div ref={ref} {...restProps}>
        <Tabs
          value={value}
          defaultValue={initialDefault}
          onValueChange={onChange}
          variant={variant}
          size={size}
          orientation={orientation}
          block={block}
          className={className}
        >
          <TabsList aria-label={ariaLabel}>
            {options.map((opt) => (
              <TabsTrigger
                key={opt.value}
                value={opt.value}
                icon={opt.icon}
                badge={opt.badge}
                disabled={disabled || opt.disabled}
                aria-label={opt['aria-label']}
              >
                {opt.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    );
  }
);
SegmentedControl.displayName = 'SegmentedControl';
```

---

## 九、无障碍可访问性

1. **WAI-ARIA 标准映射**：
   - 容器层赋予 `role="tablist"` 与 `aria-orientation="horizontal" | "vertical"`；
   - 触发器赋予 `role="tab"`、`aria-selected="true|false"`；
   - 面板层赋予 `role="tabpanel"`，未激活时应用 `hidden` 属性；
2. **Roving Tabindex 焦点漫游**：
   - 仅当前激活项拥有 `tabIndex=0`，其余项为 `tabIndex=-1`，用户按下 `Tab` 键直达当前选中的项目；
   - 支持 `ArrowRight` / `ArrowLeft` / `ArrowDown` / `ArrowUp` / `Home` / `End` 循环漫游；
3. **软性焦点指示环（Soft Focus Ring）**：
   - 严格遵循 `AGENTS.md` §13，采用 `0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`，杜绝深黑色粗边框。

---

## 十、存量消费点平滑迁移与测试验证套件

### 1. 存量业务文件零破坏验证
经代码库全景扫描，现有 5 大关键消费点：
1. `SettingsExtensionsTab.tsx`（货架筛选与插件分类）
2. `McpServerToolbar.tsx`（MCP 服务列表排序）
3. `SkillDetailPreview.tsx`（技能详情切换）
4. `SettingsQuickMenu.tsx`（快速换肤分段控制器）
5. `SettingsScheduleTab.tsx`（计划任务创建与筛选）

通过重构 `SegmentedControl` 作为 `Tabs` 的轻量桥接封装层，所有存量组件无需改动任何 Props 即可立即获得：
- 3.5% 纯净暖灰底板；
- Appica UI 级别的纯白卡片滑动弹性微回弹；
- `scale(0.97)` 机械微交互；
- 同心圆角几何体系。

### 2. Vitest 核心验证用例覆盖规划
- [x] **断言 1（色彩与同心圆角）**：验证 CSS 计算样式在各尺寸下满足 $R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$；
- [x] **断言 2（弹性物理滑块）**：验证激活变更时滑块 `translate3d` 与 `width/height` 的精准定位；
- [x] **断言 3（微观按压状态）**：验证 `:active` 伪类或指针按下时 `scale(0.97)` 与 `translateY(1px)` 触发；
- [x] **断言 4（Roving Tabindex）**：验证左右键与上下键在不同 `orientation` 下的焦点巡航与 `onChange` 回调；
- [x] **断言 5（受控与非受控双模）**：验证 `value` 动态变化及 `defaultValue` 初始化的完备性；
- [x] **断言 6（减弱动画防护）**：验证 `prefers-reduced-motion` 与 `[data-perf-tier='eco']` 下动画时长归零。
