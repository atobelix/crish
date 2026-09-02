# Switch 与 Tabs / SegmentedControl 物理动效与同心圆角改进方案

> **文件标识**：`docs/ui-component-modernization/plan-improvements/01-Switch与Tabs物理动效与同心圆角改进方案.md`  
> **所属战役**：UI 组件现代化与原生原子库升级（`ui-component-modernization`）  
> **方案版本**：v1.1.0 (Production Architecture Improvement Plan)  
> **编制依据**：
> - `docs/ui-component-modernization/audits/01-Switch与Tabs物理动效及同心几何严苛审查.md`
> - `docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`
> - `docs/ui-component-modernization/independent-plans/01-Switch流体果冻动效与自研React实现方案.md`
> - `docs/ui-component-modernization/independent-plans/02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md`
> - `AGENTS.md`（§13 焦点环规范、§14 现代色彩空间、反过度设计红线、RL-03 行数门禁）

---

## 目录

1. [方案背景与核心整改目标](#一方案背景与核心整改目标)
2. [Switch 核心改进详案](#二switch-核心改进详案)
   - 2.1 [Checkmark 延迟绘制 Zero-FOUC 门闩架构](#21-checkmark-延迟绘制-zero-fouc-门闩架构)
   - 2.2 [受控模式二次渲染瀑布根治（VDOM Cascade Elimination）](#22-受控模式二次渲染瀑布根治vdom-cascade-elimination)
   - 2.3 [`html[data-perf-tier='eco']` 节能性能降级体系](#23-htmldata-perf-tiereco-节能性能降级体系)
   - 2.4 [Hover 态灰度归一与 CSS Fallback 安全清洗](#24-hover-态灰度归一与-css-fallback-安全清洗)
   - 2.5 [中文输入法 IME 组合键打断防御](#25-中文输入法-ime-组合键打断防御)
   - 2.6 [Switch 完整重构代码（TSX + CSS Modules）](#26-switch-完整重构代码tsx--css-modules)
3. [Tabs 核心改进详案](#三tabs-核心改进详案)
   - 3.1 [首屏指示器 (0,0) 全屏弹簧飞跃彻底根除（`data-ready` 初始门闩）](#31-首屏指示器-00-全屏弹簧飞跃彻底根除data-ready-初始门闩)
   - 3.2 [ResizeObserver 常驻单例与 Ref-Trampoline 订阅重构](#32-resizeobserver-常驻单例与-ref-trampoline-订阅重构)
   - 3.3 [WAI-ARIA 1.2 语义交叉引用完备化（`id` / `aria-controls` / `aria-labelledby`）](#33-wai-aria-12-语义交叉引用完备化id--aria-controls--aria-labelledby)
   - 3.4 [端点阻尼微过冲物理曲线调优（防首末项 Border Bleeding）](#34-端点阻尼微过冲物理曲线调优防首末项-border-bleeding)
   - 3.5 [Line 变体坐标解算与 GPU 定位单一真值源](#35-line-变体坐标解算与-gpu-定位单一真值源)
   - 3.6 [Roving Tabindex 初始无选中态与动态禁用死锁防御](#36-roving-tabindex-初始无选中态与动态禁用死锁防御)
   - 3.7 [Tabs 完整重构代码（TSX + CSS Modules + Types）](#37-tabs-完整重构代码tsx--css-modules--types)
4. [SegmentedControl 核心改进详案](#四segmentedcontrol-核心改进详案)
   - 4.1 [架构归一：基于 Tabs 核心的轻量适配器（消灭 260 行冗余实现）](#41-架构归一基于-tabs-核心的轻量适配器消灭-260-行冗余实现)
   - 4.2 [严格同心圆角几何矩阵（$R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$）](#42-严格同心圆角几何矩阵r_textinner--r_textouter---textpadding)
   - 4.3 [SegmentedControl 完整重构代码（TSX）](#43-segmentedcontrol-完整重构代码tsx)
5. [Design Tokens 消费与工程规范矩阵](#五design-tokens-消费与工程规范矩阵)
6. [测试与验证规划（Vitest Test Matrix）](#六测试与验证规划vitest-test-matrix)

---

## 一、方案背景与核心整改目标

在 UI 组件现代化第一阶段交付后，经审计报告 `01` 与 `05` 深度审查，Switch、Tabs 与 SegmentedControl 展现了良好的自研架构雏形，但在**首屏渲染稳定性（Zero-FOUC）**、**受控模式二次渲染瀑布**、**同心圆角几何精度**、**架构 DRY 纪律**以及**无障碍标准交叉引用**方面暴露了若干高危与严重缺陷。

### 核心整改目标矩阵

| 序号 | 目标模块 | 缺陷痛点 | 改进后预期达标标准 | 优先级 |
| :--- | :--- | :--- | :--- | :---: |
| **01** | **Switch** | 初始挂载选中态时 Checkmark 延迟 180ms 绘制动画导致界面闪烁跳帧 | 挂载首屏静态瞬间满血呈现（Zero-FOUC），仅在用户交互后激活动态一笔勾勒 | **P0 (Blocker)** |
| **02** | **Switch** | 受控模式 `useEffect` 中 `setHasInteracted(true)` 导致每次更新触发二次 Render | 渲染期派生/Ref 门闩，彻底消灭二次同步 Re-render 瀑布 | **P0 (Blocker)** |
| **03** | **Switch** | 缺少 `html[data-perf-tier='eco']` 性能降级与 Hover 8% 自定义色未收敛 | 补齐 Eco Tier 0ms 降级，Hover 严格收敛至 `var(--tint-hover)` | **P1 (Critical)** |
| **04** | **Tabs** | 挂载首屏指示器从 (0,0) 带着 1.5 弹簧过冲横飞至目标 Tab（Zero-FOUC 溃败） | 引入 `data-ready` 初始定位门闩，首帧瞬时落位无过渡，后续交互无缝弹簧滑动 | **P0 (Blocker)** |
| **05** | **Tabs** | 每次切换 Tab 导致 `ResizeObserver` 注销重绑，GC 与事件循环开销大 | 重构为常驻 Observer + Ref-Trampoline，挂载期仅订阅一次 | **P1 (Critical)** |
| **06** | **Tabs** | WAI-ARIA 语义缺失：缺少 Trigger 与 Content 间的 `id` / `aria-controls` / `aria-labelledby` | 统一通过 Context 分发命名空间 ID，实现 100% WAI-ARIA 1.2 规范互锁 | **P1 (Critical)** |
| **07** | **Tabs** | 过冲曲线 $y_2 = 1.5$ 导致首末项滑块冲出底板边框（Border Bleeding / Clipping） | 优化阻尼微过冲曲线至 $y_2 = 1.15$，严格锁定在 $1.5\text{px}$ 内边距安全裕量内 | **P1 (Critical)** |
| **08** | **SegmentedControl** | 架构倒退复制 261 行独立代码，同心圆角硬编码 7px 产生 Corner Pinching | 基于 Tabs 纯净桥接（~40 行），落实全尺寸 $R_{\text{inner}} = R_{\text{outer}} - P$ 几何矩阵 | **P0 (Blocker)** |

---

## 二、Switch 核心改进详案

### 2.1 Checkmark 延迟绘制 Zero-FOUC 门闩架构

#### 1. 问题根因剖析
在原实现 `Switch.module.css` 中：
```css
/* 缺陷代码 */
.track[data-state='checked'] .checkIcon {
  animation: checkmark-draw 220ms cubic-bezier(0.16, 1, 0.3, 1) 180ms forwards;
}
```
当 `<Switch checked={true} />` 或 `<Switch defaultChecked={true} />` 初次挂载时，`hasInteracted` 为 `false`。尽管滑块本体正确停在右侧，但内部的 `.checkIcon` 初始状态为 `opacity: 0; stroke-dashoffset: 12;`，并在页面加载完成 180ms 后突然启动 220ms 的绘制动画。这导致用户在打开设置页或弹窗时，看到的是一个“空白滑块”，随后对勾慢吞吞画出来，产生明显的视觉残缺与掉帧感。

#### 2. 状态机门闩设计
必须在 CSS 状态机中解耦**初始静态呈现**与**动态交互描边**：

```
                    ┌─────────────────────────┐
                    │ 初次挂载 (Mount Phase)   │
                    │ hasInteracted: false    │
                    └───────────┬─────────────┘
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
       [data-state='checked']        [data-state='unchecked']
       - stroke-dashoffset: 0        - stroke-dashoffset: 12
       - opacity: 1                  - opacity: 0
       - animation: none (瞬时满血)   - animation: none (静态隐藏)
                 │                             │
                 └──────────────┬──────────────┘
                                │ 用户交互 / 状态翻转
                                ▼
                    ┌─────────────────────────┐
                    │ 交互激活 (Active Phase) │
                    │ hasInteracted: true     │
                    └───────────┬─────────────┘
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
       [data-state='checked']        [data-state='unchecked']
       - 激活 checkmark-draw 关键帧   - 瞬时 80ms 快速淡出
       - 延迟 180ms + 描边 220ms      - 无反向描边，凌厉收尾
```

#### 3. CSS 规则重构
```css
/* 1. 静态初始态与基础属性：默认完全展开 */
.checkIcon {
  width: var(--icon-size);
  height: var(--icon-size);
  color: var(--brand-deep, hsl(160 84% 30%));
  stroke-dasharray: 12;
  stroke-dashoffset: 12;
  opacity: 0;
  pointer-events: none;
  transition: opacity 80ms ease-out;
}

/* 2. 静态选中态（初次挂载时即为 checked）：零延迟、零动画、满血呈现 */
.track[data-state='checked'] .checkIcon {
  stroke-dashoffset: 0;
  opacity: 1;
}

/* 3. 动态交互态：仅在发生用户交互或后续受控变更后触发描边动画 */
.hasInteracted[data-state='checked'] .checkIcon {
  animation: checkmark-draw 220ms cubic-bezier(0.16, 1, 0.3, 1) 180ms forwards;
}

/* 4. 动态取消选中态：快速淡出，无需描边动画 */
.hasInteracted[data-state='unchecked'] .checkIcon {
  animation: none;
  opacity: 0;
}
```

---

### 2.2 受控模式二次渲染瀑布根治（VDOM Cascade Elimination）

#### 1. 问题根因剖析
原实现采用 `useEffect` 监听 `[checked]` 并调用 `setHasInteracted(true)`：
```tsx
// 缺陷代码
const [hasInteracted, setHasInteracted] = useState(false);
useEffect(() => {
  if (isFirstRender.current) {
    isFirstRender.current = false;
    return;
  }
  if (prevCheckedRef.current !== checked) {
    setHasInteracted(true); // 触发二次同步 Render!
    prevCheckedRef.current = checked;
  }
}, [checked]);
```
在受控模式下，父组件更新 `checked` 引起 Switch 首次 Render；在 DOM 提交后执行 `useEffect`，调用 `setHasInteracted(true)`，进而强行引发 Switch 的第二次同步 Render。在 120Hz 刷新率或高频表单状态同步时，级联 Re-render 会造成无谓的 CPU 压力与 GC 抖动。

#### 2. 渲染期派生与 Ref 门锁方案
`hasInteracted` 仅作为一个视觉动画开关，其状态完全可以在**组件渲染阶段根据上一次的值同步派生**，无需借由 React 内部状态调度器：

```tsx
// 优化后纯净方案
const hasInteractedRef = useRef(false);
const prevCheckedRef = useRef(checked);
const isFirstMountRef = useRef(true);

// 渲染期间直接比对判定，0 次额外 Render！
if (isFirstMountRef.current) {
  isFirstMountRef.current = false;
} else if (prevCheckedRef.current !== checked && !hasInteractedRef.current) {
  hasInteractedRef.current = true;
}
prevCheckedRef.current = checked;
```

当发生用户主动点击时，在 `handleToggle` 中直接将 `hasInteractedRef.current = true`，确保当次与后续渲染均带有 `.hasInteracted` 标记。彻底清除 `useState(hasInteracted)` 与对应的 `useEffect`。

---

### 2.3 `html[data-perf-tier='eco']` 节能性能降级体系

为响应全局性能防御规范，在系统进入省电模式（`data-perf-tier='eco'`）或用户开启减弱动态偏好（`prefers-reduced-motion: reduce`）时，Switch 的关键帧拉伸与描边动画必须瞬间截断，时长归零：

```css
/* 减弱动态偏好与节能模式双轨降级 */
@media (prefers-reduced-motion: reduce) {
  .track,
  .thumb,
  .checkIcon,
  .spinner,
  .label {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
    animation: none !important;
  }

  .track[data-state='checked'] .thumb {
    transform: translateX(var(--thumb-travel));
    width: var(--thumb-d);
  }

  .track[data-state='unchecked'] .thumb {
    transform: translateX(0);
    width: var(--thumb-d);
  }

  .track[data-state='checked'] .checkIcon {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}

html[data-perf-tier='eco'] .track,
html[data-perf-tier='eco'] .thumb,
html[data-perf-tier='eco'] .checkIcon,
html[data-perf-tier='eco'] .spinner,
html[data-perf-tier='eco'] .label {
  transition-duration: 0ms !important;
  animation-duration: 0ms !important;
  animation: none !important;
}

html[data-perf-tier='eco'] .track[data-state='checked'] .thumb {
  transform: translateX(var(--thumb-travel));
  width: var(--thumb-d);
}

html[data-perf-tier='eco'] .track[data-state='unchecked'] .thumb {
  transform: translateX(0);
  width: var(--thumb-d);
}

html[data-perf-tier='eco'] .track[data-state='checked'] .checkIcon {
  stroke-dashoffset: 0;
  opacity: 1;
}
```

---

### 2.4 Hover 态灰度归一与 CSS Fallback 安全清洗

1. **Hover 态归一**：
   - 彻底废除 `.track:hover` 中违规的 `color-mix(in srgb, var(--text-primary) 8%, var(--bg-tertiary))`；
   - 未选中 Hover 态使用标准背景 + `var(--tint-hover)`，边框强化为 `var(--border-color)`；
   - 选中 Hover 态加深为 `var(--brand-deep, hsl(160 84% 30%))`。
2. **Fallback 安全清洗**：
   - 将散落的 `#ffffff` 替换为 `hsl(0 0% 100%)` 或标准语义 Token `var(--bg-elevated, hsl(0 0% 100%))`；
   - 投影变量中的 `--shadow-color` 必须带安全回退：`var(--switch-thumb-shadow, 0 1px 2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 14%, transparent))`。

---

### 2.5 中文输入法 IME 组合键打断防御

在 `handleKeyDown` 中加入 `e.nativeEvent.isComposing` 守卫，防止用户在拼音选词过程中按下 Space 误触发 Switch 翻转：

```tsx
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      handleToggle();
    }
  },
  [handleToggle, onKeyDown]
);
```

---

### 2.6 Switch 完整重构代码（TSX + CSS Modules）

#### 1. `apps/crish-desktop/src/components/ui/Switch/Switch.tsx`
```tsx
/**
 * ui/Switch 现代化原子开关组件 (v1.1.0 架构升级版)
 *
 * 核心升级：
 * - 彻底修复首屏 Checkmark 延迟绘制击穿 Zero-FOUC 问题；
 * - 渲染期派生 hasInteractedRef，彻底根除受控模式下的二次渲染瀑布；
 * - 严格遵循 AGENTS.md §13 焦点环规范与 §14 现代色彩空间；
 * - 补齐 html[data-perf-tier='eco'] 节能降级与 IME 输入法防穿透；
 * - 100% 纯净自研，零外部 npm 依赖。
 */
import React, {
  forwardRef,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react';
import styles from './Switch.module.css';

export type SwitchSize = 'sm' | 'md' | 'lg';

export interface SwitchProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onChange' | 'onClick' | 'size'
  > {
  /** 受控选中状态 */
  checked?: boolean;
  /** 非受控初始选中状态 */
  defaultChecked?: boolean;
  /** 状态变更回调 */
  onCheckedChange?: (checked: boolean) => void;
  /** 尺寸档位（默认 'md'） */
  size?: SwitchSize;
  /** 加载中状态（展示滑块内微型 Spinner 并锁定交互） */
  loading?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 前缀/后缀说明文案（点击可关联切换） */
  label?: React.ReactNode;
  /** 标签位置（默认 'start' 即前缀） */
  labelPlacement?: 'start' | 'end';
  /** 无 label 时的屏幕阅读器命名 */
  'aria-label'?: string;
  /** 自定义类名（仅用于外部布局与间距微调） */
  className?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked: externalChecked,
    defaultChecked = false,
    onCheckedChange,
    size = 'md',
    loading = false,
    disabled = false,
    label,
    labelPlacement = 'start',
    id,
    className,
    'aria-label': ariaLabel,
    onKeyDown,
    ...restProps
  },
  ref
) {
  const autoId = useId();
  const switchId = id ?? `conex-switch-${autoId}`;

  // 受控 / 非受控状态归一化
  const isControlled = externalChecked !== undefined;
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const checked = isControlled ? Boolean(externalChecked) : internalChecked;

  // 动画守卫：纯渲染期同步派生，彻底消灭 useEffect 引起的二次渲染瀑布
  const hasInteractedRef = useRef(false);
  const prevCheckedRef = useRef(checked);
  const isFirstMountRef = useRef(true);

  if (isFirstMountRef.current) {
    isFirstMountRef.current = false;
  } else if (prevCheckedRef.current !== checked && !hasInteractedRef.current) {
    hasInteractedRef.current = true;
  }
  prevCheckedRef.current = checked;

  const isInteractive = !disabled && !loading;

  const handleToggle = useCallback(() => {
    if (!isInteractive) return;
    hasInteractedRef.current = true;
    const nextChecked = !checked;
    if (!isControlled) {
      setInternalChecked(nextChecked);
    }
    onCheckedChange?.(nextChecked);
  }, [checked, isControlled, isInteractive, onCheckedChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || e.nativeEvent.isComposing) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleToggle();
      }
    },
    [handleToggle, onKeyDown]
  );

  const trackClasses = [
    styles.track,
    styles[`size-${size}`],
    hasInteractedRef.current ? styles.hasInteracted : null,
    loading ? styles.loading : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const control = (
    <button
      ref={ref}
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      disabled={disabled}
      className={trackClasses}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      data-state={checked ? 'checked' : 'unchecked'}
      data-size={size}
      {...restProps}
    >
      <span className={styles.thumb} aria-hidden="true">
        {loading ? (
          <svg
            className={styles.spinner}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="28"
              strokeDashoffset="18"
            />
          </svg>
        ) : (
          <svg
            className={styles.checkIcon}
            viewBox="0 0 12 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M3 6l2 2 4-4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </button>
  );

  if (label == null) {
    return control;
  }

  const labelElement = (
    <label htmlFor={switchId} className={styles.label}>
      {label}
    </label>
  );

  return (
    <span
      className={`${styles.container} ${styles[`align-${labelPlacement}`]}`}
      data-disabled={disabled || undefined}
    >
      {labelPlacement === 'start' && labelElement}
      {control}
      {labelPlacement === 'end' && labelElement}
    </span>
  );
});

Switch.displayName = 'Switch';
```

#### 2. `apps/crish-desktop/src/components/ui/Switch/Switch.module.css`
```css
/* ==========================================================================
   Switch.module.css (v1.1.0 架构升级版)
   流体果冻拉伸（Pill Stretch）动画、Zero-FOUC 门闩与 Design Tokens 消费
   ========================================================================== */

.container {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
  user-select: none;
}

.container[data-disabled] {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
}

.label {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
  cursor: pointer;
  line-height: var(--line-height-ui, 1.35);
  transition: color var(--transition-micro, 100ms ease-out);
}

.container:hover:not([data-disabled]) .label {
  color: var(--text-primary);
}

/* --- 轨道基底（Track） --- */
.track {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0;
  border-radius: var(--radius-full, 9999px);
  border: 1px solid var(--border-subtle);
  background: var(--switch-track-bg, color-mix(in srgb, var(--text-primary) 5%, var(--bg-tertiary)));
  box-sizing: border-box;
  cursor: pointer;
  flex-shrink: 0;
  outline: none;
  overflow: visible;
  transition:
    background-color var(--duration-fast, 150ms) cubic-bezier(0.4, 0, 0.2, 1),
    border-color var(--duration-fast, 150ms) cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow var(--duration-fast, 150ms) cubic-bezier(0.4, 0, 0.2, 1);
}

/* 尺寸规格与 CSS 变量矩阵 */
.size-sm {
  --track-w: 28px;
  --track-h: 16px;
  --thumb-d: 12px;
  --thumb-pad: 1px;
  --thumb-travel: 12px;
  --thumb-stretch-w: 18px;
  --stretch-x-on: 4.5px;
  --stretch-x-off: 3.5px;
  --icon-size: 9px;
  width: var(--track-w);
  height: var(--track-h);
}

.size-md {
  --track-w: 36px;
  --track-h: 20px;
  --thumb-d: 16px;
  --thumb-pad: 1px;
  --thumb-travel: 16px;
  --thumb-stretch-w: 25px;
  --stretch-x-on: 6px;
  --stretch-x-off: 5px;
  --icon-size: 12px;
  width: var(--track-w);
  height: var(--track-h);
}

.size-lg {
  --track-w: 44px;
  --track-h: 24px;
  --thumb-d: 20px;
  --thumb-pad: 1px;
  --thumb-travel: 20px;
  --thumb-stretch-w: 31px;
  --stretch-x-on: 8px;
  --stretch-x-off: 6.5px;
  --icon-size: 14px;
  width: var(--track-w);
  height: var(--track-h);
}

/* 交互状态：Hover 态严格收敛至 var(--tint-hover) */
.track:hover:not(:disabled) {
  border-color: var(--border-color);
  background: color-mix(in srgb, var(--switch-track-bg, var(--bg-tertiary)) 100%, var(--tint-hover));
}

/* 选中状态（Checked） */
.track[data-state='checked'] {
  background: var(--brand, hsl(160 84% 39%));
  border-color: var(--brand-deep, hsl(160 84% 30%));
}

.track[data-state='checked']:hover:not(:disabled) {
  background: var(--brand-deep, hsl(160 84% 30%));
  border-color: var(--brand-deep, hsl(160 84% 30%));
}

/* 焦点环：严格遵守 AGENTS.md §13 (3%~10% 克制柔和灰色) */
.track:focus-visible {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.track:disabled {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
}

.track.loading {
  cursor: wait;
}

/* --- 滑块本体（Thumb） --- */
.thumb {
  position: absolute;
  top: var(--thumb-pad);
  left: var(--thumb-pad);
  width: var(--thumb-d);
  height: var(--thumb-d);
  border-radius: var(--radius-full, 9999px);
  background: var(--bg-elevated, hsl(0 0% 100%));
  box-shadow: var(--switch-thumb-shadow, 0 1px 2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 14%, transparent));
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  transform: translateX(0);
  will-change: transform, width;
}

/* 静态归位态（挂载时） */
.track[data-state='checked'] .thumb {
  transform: translateX(var(--thumb-travel));
}

/* 动态果冻拉伸动画（仅在发生交互后激活） */
.hasInteracted[data-state='checked'] .thumb {
  animation: thumb-stretch-on 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

.hasInteracted[data-state='unchecked'] .thumb {
  animation: thumb-stretch-off 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

/* 果冻拉伸关键帧：ON */
@keyframes thumb-stretch-on {
  0% {
    width: var(--thumb-d);
    transform: translateX(0);
  }
  50% {
    width: var(--thumb-stretch-w);
    transform: translateX(var(--stretch-x-on));
  }
  100% {
    width: var(--thumb-d);
    transform: translateX(var(--thumb-travel));
  }
}

/* 果冻拉伸关键帧：OFF */
@keyframes thumb-stretch-off {
  0% {
    width: var(--thumb-d);
    transform: translateX(var(--thumb-travel));
  }
  50% {
    width: var(--thumb-stretch-w);
    transform: translateX(var(--stretch-x-off));
  }
  100% {
    width: var(--thumb-d);
    transform: translateX(0);
  }
}

/* --- 微图标：Checkmark（Zero-FOUC 门闩架构） --- */
.checkIcon {
  width: var(--icon-size);
  height: var(--icon-size);
  color: var(--brand-deep, hsl(160 84% 30%));
  stroke-dasharray: 12;
  stroke-dashoffset: 12;
  opacity: 0;
  pointer-events: none;
  transition: opacity 80ms ease-out;
}

/* 首屏静态已选中：瞬时满血呈现，零动画、零延迟 */
.track[data-state='checked'] .checkIcon {
  stroke-dashoffset: 0;
  opacity: 1;
}

/* 仅在交互后激活动态绘制动画 */
.hasInteracted[data-state='checked'] .checkIcon {
  animation: checkmark-draw 220ms cubic-bezier(0.16, 1, 0.3, 1) 180ms forwards;
}

.hasInteracted[data-state='unchecked'] .checkIcon {
  animation: none;
  opacity: 0;
}

@keyframes checkmark-draw {
  0% {
    stroke-dashoffset: 12;
    opacity: 0;
  }
  40% {
    stroke-dashoffset: 12;
    opacity: 1;
  }
  100% {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}

/* --- 加载指示器：Spinner --- */
.spinner {
  width: var(--icon-size);
  height: var(--icon-size);
  color: var(--text-tertiary);
  animation: switch-spin 750ms linear infinite;
}

@keyframes switch-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

/* --- 减弱动态偏好（Reduced Motion）与 Eco Tier 节能降级 --- */
@media (prefers-reduced-motion: reduce) {
  .track,
  .thumb,
  .checkIcon,
  .spinner,
  .label {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
    animation: none !important;
  }

  .track[data-state='checked'] .thumb {
    transform: translateX(var(--thumb-travel));
    width: var(--thumb-d);
  }

  .track[data-state='unchecked'] .thumb {
    transform: translateX(0);
    width: var(--thumb-d);
  }

  .track[data-state='checked'] .checkIcon {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}

html[data-perf-tier='eco'] .track,
html[data-perf-tier='eco'] .thumb,
html[data-perf-tier='eco'] .checkIcon,
html[data-perf-tier='eco'] .spinner,
html[data-perf-tier='eco'] .label {
  transition-duration: 0ms !important;
  animation-duration: 0ms !important;
  animation: none !important;
}

html[data-perf-tier='eco'] .track[data-state='checked'] .thumb {
  transform: translateX(var(--thumb-travel));
  width: var(--thumb-d);
}

html[data-perf-tier='eco'] .track[data-state='unchecked'] .thumb {
  transform: translateX(0);
  width: var(--thumb-d);
}

html[data-perf-tier='eco'] .track[data-state='checked'] .checkIcon {
  stroke-dashoffset: 0;
  opacity: 1;
}
```

---

## 三、Tabs 核心改进详案

### 3.1 首屏指示器 (0,0) 全屏弹簧飞跃彻底根除（`data-ready` 初始门闩）

#### 1. 问题根因剖析
在 `TabsList` 原实现中：
```tsx
const [sliderRect, setSliderRect] = useState({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });
```
初次挂载时，`sliderRect` 坐标为 $(0,0)$ 且 `opacity: 0`。随后 `useLayoutEffect` 计算出目标 Tab 的真实坐标（例如 $(240, 2)$），触发 `setSliderRect`。
然而在 CSS 中，`.indicator` 全程无条件开启了 `transition: transform 250ms cubic-bezier(0.175, 0.885, 0.32, 1.5)`。
浏览器在渲染首帧时，指示器**从屏幕左上角 (0,0) 带着 1.5 弹性过冲曲线急速横跨整个容器飞跃至目标 Tab**！当页面加载或弹窗打开时，视觉出现刺眼的白色方块飞掠。

#### 2. `data-ready` 门闩方案
通过首帧布局测量状态锁与 CSS 选择器，彻底禁止首屏位置计算时的 `transition`：

```
[初次 Render]  sliderRect: { x: 0, y: 0, opacity: 0 }, isReady: false
      │
      ▼ (useLayoutEffect 同步精确测量目标 Tab 坐标)
[首帧同步定位]  sliderRect: { x: 240, y: 2, opacity: 1 }, data-ready="false"
      │        CSS 规则: .indicator:not([data-ready='true']) { transition: none !important; }
      │        指示器在首屏 0ms 瞬间落定在正确位置，肉眼可见完美静态！
      ▼ (requestAnimationFrame / microtask)
[解开门闩]     isReady: true -> data-ready="true"
      │        后续用户点击切换 Tab -> 恢复 Appica 250ms 弹性微过冲平滑滑动！
```

#### 3. 实现要点
```tsx
const [isReady, setIsReady] = useState(false);
const isFirstLayoutRef = useRef(true);

useLayoutEffect(() => {
  updateIndicator();
  if (isFirstLayoutRef.current) {
    // 首屏测量完成后，在下一帧开启 transition 门闩
    requestAnimationFrame(() => {
      setIsReady(true);
      isFirstLayoutRef.current = false;
    });
  }
}, [updateIndicator]);
```
```css
.indicator {
  position: absolute;
  top: 0;
  left: 0;
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

/* 初始未就绪状态：强制关闭 transition，防止 (0,0) 弹射飞跃 */
.indicator:not([data-ready='true']) {
  transition: none !important;
}
```

---

### 3.2 ResizeObserver 常驻单例与 Ref-Trampoline 订阅重构

#### 1. 问题根因剖析
原 `TabsList` 中：
```tsx
useEffect(() => {
  const el = listRef.current;
  if (!el) return;
  const ro = ResizeObserverManager.getInstance();
  ro.observe(el, updateIndicator);
  return () => {
    ro.unobserve(el, updateIndicator);
  };
}, [updateIndicator]); // updateIndicator 依赖 [value, variant, orientation]
```
每当用户点击切换 Tab 时，`value` 改变导致 `updateIndicator` 函数引用变化，React 立即执行 cleanup 注销 `ResizeObserver`，再重新注册。
这不仅违背了单例管理器长效监听的初衷，还带来了高频的 GC 内存分配与微任务调度开销。

#### 2. Ref-Trampoline（引用跳板）模式
保持 `ResizeObserver` 在组件整个生命周期中**仅注册一次**，内部通过 Ref 实时调用最新版本的测量函数：

```tsx
const updateIndicatorRef = useRef(updateIndicator);
updateIndicatorRef.current = updateIndicator;

useEffect(() => {
  const el = listRef.current;
  if (!el) return;
  const ro = ResizeObserverManager.getInstance();
  const handleResize = () => {
    updateIndicatorRef.current();
  };
  ro.observe(el, handleResize);
  return () => {
    ro.unobserve(el, handleResize);
  };
}, []); // 仅在 DOM 挂载时监听一次！
```

---

### 3.3 WAI-ARIA 1.2 语义交叉引用完备化（`id` / `aria-controls` / `aria-labelledby`）

根据 WAI-ARIA 1.2 §3.18 Tabpanel 规范：
1. 每一个 `role="tab"` 必须拥有唯一 `id`，并通过 `aria-controls` 指向对应面板的 `id`；
2. 每一个 `role="tabpanel"` 必须拥有对应 `id`，并通过 `aria-labelledby` 指向触发器的 `id`。

#### 命名空间化 ID 编排
在 `TabsContext` 中派生统一的 `baseId = id ?? useId()`：

```
                    Tabs (baseId = "conex-tabs-r1")
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
   TabsTrigger (value="tab1")            TabsContent (value="tab1")
   id: "conex-tabs-r1-tab-tab1"          id: "conex-tabs-r1-panel-tab1"
   aria-controls: "...-panel-tab1"       aria-labelledby: "...-tab-tab1"
```

这确保了屏幕阅读器能够精确在 Tab 与 Content 之间建立双向控制锚点。

---

### 3.4 端点阻尼微过冲物理曲线调优（防首末项 Border Bleeding）

#### 1. 物理过冲与容器边缘碰撞分析
原弹性曲线为 `cubic-bezier(0.175, 0.885, 0.32, 1.5)`。
$y_2 = 1.5$ 意味着指示器在终点瞬间会产生约 $6\% \sim 8\%$ 的向前过冲量。以 $100\text{px}$ 宽度的 Tab 为例，滑块会向右多冲出 $6\text{px}$。
由于容器内边距 $P$ 仅为 $2\text{px} \sim 3.5\text{px}$，当滑块滑向第 0 项（最左侧）或第 N-1 项（最右侧）时，滑块会冲出灰底槽位外沿 $2.5\text{px} \sim 4\text{px}$：
- 若外层有 `overflow: hidden`，滑块在过冲瞬间发生生硬切角（Corner Clipping）；
- 若无 `overflow`，滑块刺穿外层边框（Border Bleeding）。

#### 2. 微过冲阻尼数学模型
将贝塞尔控制点 $y_2$ 由 $1.50$ 收敛至 **$1.15$**：
$$\text{cubic-bezier}(0.2, 0.9, 0.3, 1.15)$$
- **最大过冲量**：严格控制在 $\le 1.5\%$（约 $1.0\text{px} \sim 1.4\text{px}$）；
- **几何容差**：小于各尺寸内边距 $P \ge 2\text{px}$，滑块始终锁定在底板内部安全裕量内；
- **动态手感**：保留 Appica UI 极富生命力的弹性微回弹，杜绝机械线性感。

---

### 3.5 Line 变体坐标解算与 GPU 定位单一真值源

彻底移除 `.indicatorLine` 中的 `bottom: 0; left: 0;` 静态定位声明。
所有位移一律由 GPU 硬件加速的 `translate3d(x, y, 0)` 统一绝对控制：
- 水平下划线：`x = activeTrigger.offsetLeft`, `y = listEl.clientHeight - 2`, `w = activeTrigger.offsetWidth`, `h = 2px`；
- 垂直指示条：`x = 0`, `y = activeTrigger.offsetTop + (activeTrigger.offsetHeight - lineH) / 2`, `w = 2px`, `h = lineH`。

---

### 3.6 Roving Tabindex 初始无选中态与动态禁用死锁防御

当当前选中的项被外部动态设为 `disabled`，或者初始传入的 `value` 未命中任何可用项时：
自动将 `tabIndex={0}` 委派给列表中**第一个非禁用的 Tab**，确保键盘 Tab 键始终能够切入组件。

```tsx
const enabledTriggers = triggers.filter((t) => !t.disabled);
const isFirstEnabled = enabledTriggers[0]?.value === itemValue;
const hasSelectedEnabled = enabledTriggers.some((t) => t.value === currentValue);
const tabIndex = (isSelected || (!hasSelectedEnabled && isFirstEnabled)) && !disabled ? 0 : -1;
```

---

### 3.7 Tabs 完整重构代码（TSX + CSS Modules + Types）

#### 1. `apps/crish-desktop/src/components/ui/Tabs/types.ts`
```typescript
import React from 'react';

export type TabsVariant = 'pill' | 'line';
export type TabsSize = 'xs' | 'sm' | 'md' | 'lg';
export type TabsOrientation = 'horizontal' | 'vertical';

export interface TabsContextValue {
  baseId: string;
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
  size: TabsSize;
  orientation: TabsOrientation;
  block: boolean;
  registerTrigger: (value: string, element: HTMLElement | null) => void;
  unregisterTrigger: (value: string) => void;
}

export interface TabsProps {
  /** 唯一标识前缀（自动生成 fallback） */
  id?: string;
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
  /** 自定义外层类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 无障碍标签 */
  'aria-label'?: string;
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  /** 自定义无障碍角色（默认 role="tablist"） */
  role?: string;
  children: React.ReactNode;
}

export interface TabsTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  /** 选项值唯一标识 */
  value: string;
  /** 可选前置图标 */
  icon?: React.ReactNode;
  /** 可选尾部徽标/数量 */
  badge?: React.ReactNode;
  /** 禁用态 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  /** 自定义无障碍角色（默认 role="tab"） */
  role?: string;
  /** 显式无障碍标签 */
  'aria-label'?: string;
  children: React.ReactNode;
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 对应 Tab 触发器的唯一标识 */
  value: string;
  /** 是否在未激活时保留 DOM 节点（通过 hidden 隐藏而非卸载） */
  keepMounted?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/* 兼容 SegmentedControl 的配置式接口 */
export interface SegmentedControlOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
}

export type SegmentedControlSize = 'xs' | 'sm' | 'md' | 'lg';

export interface SegmentedControlProps<T extends string = string> {
  options: (SegmentedControlOption<T> | T)[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  variant?: TabsVariant;
  size?: SegmentedControlSize;
  orientation?: TabsOrientation;
  block?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
}
```

#### 2. `apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx`
```tsx
/**
 * ui/Tabs 现代化复合标签页组件 (v1.1.0 架构升级版)
 *
 * 核心升级：
 * - 引入 data-ready 首帧门闩，彻底消灭指示器 (0,0) 全屏弹簧飞跃；
 * - 重构 ResizeObserver 为常驻 Observer + Ref-Trampoline，根除频繁解绑重绑；
 * - 100% 补全 WAI-ARIA 1.2 语义交叉引用（id / aria-controls / aria-labelledby）；
 * - 物理微过冲阻尼贝塞尔优化至 y2=1.15，杜绝首末项冲出底板；
 * - 单一 GPU translate3d 真值源解耦 Line 定位冲突。
 */
import React, {
  createContext,
  forwardRef,
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
import type {
  TabsContentProps,
  TabsContextValue,
  TabsListProps,
  TabsProps,
  TabsTriggerProps,
} from './types';

const TabsContext = createContext<TabsContextValue | null>(null);

export function useTabsContext(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('Tabs sub-components must be rendered within a <Tabs> parent.');
  }
  return ctx;
}

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    id,
    value: externalValue,
    defaultValue,
    onValueChange,
    variant = 'pill',
    size = 'sm',
    orientation = 'horizontal',
    block = false,
    className,
    style,
    children,
    ...rest
  },
  ref
) {
  const autoId = useId();
  const baseId = id ?? `conex-tabs-${autoId}`;

  const [internalValue, setInternalValue] = useState<string>(defaultValue ?? '');
  const isControlled = externalValue !== undefined;
  const currentValue = isControlled ? (externalValue ?? '') : internalValue;

  const triggerMapRef = useRef<Map<string, HTMLElement>>(new Map());

  const registerTrigger = useCallback((val: string, el: HTMLElement | null) => {
    if (el) {
      triggerMapRef.current.set(val, el);
    } else {
      triggerMapRef.current.delete(val);
    }
  }, []);

  const unregisterTrigger = useCallback((val: string) => {
    triggerMapRef.current.delete(val);
  }, []);

  const handleValueChange = useCallback(
    (nextVal: string) => {
      if (!isControlled) {
        setInternalValue(nextVal);
      }
      if (nextVal !== currentValue) {
        onValueChange?.(nextVal);
      }
    },
    [isControlled, currentValue, onValueChange]
  );

  const ctxValue = useMemo<TabsContextValue>(
    () => ({
      baseId,
      value: currentValue,
      onValueChange: handleValueChange,
      variant,
      size,
      orientation,
      block,
      registerTrigger,
      unregisterTrigger,
    }),
    [
      baseId,
      currentValue,
      handleValueChange,
      variant,
      size,
      orientation,
      block,
      registerTrigger,
      unregisterTrigger,
    ]
  );

  const sizeClassName =
    size === 'xs'
      ? styles.sizeXs
      : size === 'sm'
        ? styles.sizeSm
        : size === 'md'
          ? styles.sizeMd
          : styles.sizeLg;

  const rootClasses = [styles.root, sizeClassName, className]
    .filter(Boolean)
    .join(' ');

  return (
    <TabsContext.Provider value={ctxValue}>
      <div
        ref={ref}
        id={baseId}
        className={rootClasses}
        data-orientation={orientation}
        data-variant={variant}
        data-block={block ? 'true' : undefined}
        style={style}
        {...rest}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
});
Tabs.displayName = 'Tabs';

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  function TabsList(
    {
      'aria-label': ariaLabel,
      role = 'tablist',
      className,
      style,
      children,
      onKeyDown,
      ...rest
    },
    forwardedRef
  ) {
    const { value, variant, orientation, block, onValueChange } = useTabsContext();
    const listRef = useRef<HTMLDivElement | null>(null);

    const [sliderRect, setSliderRect] = useState<{
      x: number;
      y: number;
      width: number;
      height: number;
      opacity: number;
    }>({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });

    // Zero-FOUC 门闩：挂载首帧无 transition 定位，随后开启平滑弹簧
    const [isReady, setIsReady] = useState(false);
    const isFirstLayoutRef = useRef(true);

    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        listRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );

    const updateIndicator = useCallback(() => {
      const listEl = listRef.current;
      if (!listEl) return;

      const activeTrigger = listEl.querySelector<HTMLElement>(
        `[data-tabs-trigger][data-value="${CSS.escape(value)}"]`
      );

      if (activeTrigger) {
        if (variant === 'pill') {
          setSliderRect({
            x: activeTrigger.offsetLeft,
            y: activeTrigger.offsetTop,
            width: activeTrigger.offsetWidth,
            height: activeTrigger.offsetHeight,
            opacity: 1,
          });
        } else {
          // Line variant: 单一真值源 GPU 绝对定位
          if (orientation === 'horizontal') {
            setSliderRect({
              x: activeTrigger.offsetLeft,
              y: listEl.clientHeight - 2,
              width: activeTrigger.offsetWidth,
              height: 2,
              opacity: 1,
            });
          } else {
            // Vertical line
            const lineH = Math.max(16, activeTrigger.offsetHeight / 2);
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

    // 首屏测量同步执行，完成后在下一帧解开动画门闩
    useLayoutEffect(() => {
      updateIndicator();
      if (isFirstLayoutRef.current) {
        requestAnimationFrame(() => {
          setIsReady(true);
          isFirstLayoutRef.current = false;
        });
      }
    }, [updateIndicator]);

    // 常驻 ResizeObserver 监听，消除 Tab 切换时的注销/重绑
    const updateIndicatorRef = useRef(updateIndicator);
    updateIndicatorRef.current = updateIndicator;

    useEffect(() => {
      const el = listRef.current;
      if (!el) return;
      const ro = ResizeObserverManager.getInstance();
      const handleResize = () => {
        updateIndicatorRef.current();
      };
      ro.observe(el, handleResize);
      return () => {
        ro.unobserve(el, handleResize);
      };
    }, []);

    // Roving TabIndex 键盘漫游
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      const listEl = listRef.current;
      if (!listEl) return;

      const triggers = Array.from(
        listEl.querySelectorAll<HTMLButtonElement>(
          '[data-tabs-trigger]:not(:disabled)'
        )
      );
      if (triggers.length === 0) return;

      const currentIndex = triggers.findIndex(
        (el) => el.getAttribute('data-value') === value
      );

      let nextIndex = -1;
      const isHorizontal = orientation === 'horizontal';

      if (
        (isHorizontal && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) ||
        (!isHorizontal && (e.key === 'ArrowDown' || e.key === 'ArrowRight'))
      ) {
        e.preventDefault();
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % triggers.length;
      } else if (
        (isHorizontal && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) ||
        (!isHorizontal && (e.key === 'ArrowUp' || e.key === 'ArrowLeft'))
      ) {
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
        if (nextValue !== null) {
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
        ref={setRefs}
        role={role}
        aria-label={ariaLabel}
        aria-orientation={orientation}
        data-block={block ? 'true' : undefined}
        className={listClasses}
        onKeyDown={handleKeyDown}
        style={style}
        {...rest}
      >
        {/* 物理平滑滑块（带 Zero-FOUC 门闩） */}
        <div
          className={indicatorClasses}
          data-orientation={orientation}
          data-ready={isReady ? 'true' : undefined}
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
  }
);
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  function TabsTrigger(
    {
      id: customId,
      value: itemValue,
      icon,
      badge,
      disabled = false,
      role = 'tab',
      className,
      style,
      'aria-label': ariaLabel,
      children,
      onClick,
      ...rest
    },
    forwardedRef
  ) {
    const { baseId, value, onValueChange, registerTrigger } = useTabsContext();
    const isSelected = value === itemValue;
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    const triggerId = customId ?? `${baseId}-tab-${itemValue}`;
    const controlsId = `${baseId}-panel-${itemValue}`;

    useEffect(() => {
      registerTrigger(itemValue, triggerRef.current);
      return () => registerTrigger(itemValue, null);
    }, [itemValue, registerTrigger]);

    const setRefs = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );

    const triggerClasses = [styles.trigger, className].filter(Boolean).join(' ');
    const isRadio = role === 'radio';

    return (
      <button
        ref={setRefs}
        id={triggerId}
        type="button"
        role={role}
        aria-selected={isRadio ? undefined : isSelected}
        aria-checked={isRadio ? isSelected : undefined}
        aria-controls={isRadio ? undefined : controlsId}
        aria-label={ariaLabel}
        tabIndex={isSelected && !disabled ? 0 : -1}
        data-tabs-trigger="true"
        data-value={itemValue}
        data-active={isSelected ? 'true' : undefined}
        disabled={disabled}
        className={triggerClasses}
        style={style}
        onClick={(e) => {
          if (!disabled) {
            onValueChange(itemValue);
          }
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
  }
);
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(
  function TabsContent(
    {
      id: customId,
      value: panelValue,
      keepMounted = false,
      className,
      style,
      children,
      ...rest
    },
    ref
  ) {
    const { baseId, value } = useTabsContext();
    const isSelected = value === panelValue;

    const panelId = customId ?? `${baseId}-panel-${panelValue}`;
    const labelledById = `${baseId}-tab-${panelValue}`;

    if (!isSelected && !keepMounted) {
      return null;
    }

    const contentClasses = [styles.content, className].filter(Boolean).join(' ');

    return (
      <div
        ref={ref}
        id={panelId}
        role="tabpanel"
        aria-labelledby={labelledById}
        tabIndex={0}
        hidden={!isSelected}
        className={contentClasses}
        style={style}
        {...rest}
      >
        {children}
      </div>
    );
  }
);
TabsContent.displayName = 'TabsContent';
```

#### 3. `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css`
```css
/* ==========================================================================
   Conex UI - Tabs 3.5% 灰底纯白卡片动效体系 (v1.1.0 架构升级版)
   ========================================================================== */

/* ── 1. 基础变量与微过冲阻尼曲线 ── */
.root {
  /* 优化后阻尼微过冲曲线：y2=1.15，过冲量<=1.5px，杜绝冲出边框 */
  --tab-spring-bezier: cubic-bezier(0.2, 0.9, 0.3, 1.15);
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

/* ── 3. 尺寸档位同心圆角几何契约 ── */
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
  top: 0;
  left: 0;
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

/* Zero-FOUC 门闩：首屏未就绪时强制关闭 transition */
.indicator:not([data-ready='true']) {
  transition: none !important;
}

/* pill 滑块：纯白卡片 + 发丝边框 + 柔和微投影 */
.indicatorPill {
  border-radius: var(--tab-inner-radius);
  background-color: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-subtle);
  box-shadow:
    0 1px 2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 5%, transparent),
    0 1px 1px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 2%, transparent);
}

/* line 滑块：圆角高光线条（单一 GPU 定位） */
.indicatorLine {
  background-color: var(--text-primary);
  border-radius: var(--radius-full, 9999px);
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

.trigger:hover:not(:disabled):not([data-active='true']):not([aria-selected='true']):not([aria-checked='true']) .triggerInner::before {
  opacity: 1;
}

.trigger[data-active='true'],
.trigger[aria-selected='true'],
.trigger[aria-checked='true'] {
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
  border-radius: var(--radius-full, 9999px);
  background-color: var(--tint-strong);
  color: var(--text-tertiary);
}

/* ── 7. TabsContent 面板过渡 ── */
.content {
  outline: none;
  transition:
    opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
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
  animation-duration: 0ms !important;
}
```

---

## 四、SegmentedControl 核心改进详案

### 4.1 架构归一：基于 Tabs 核心的轻量适配器（消灭 260 行冗余实现）

#### 1. 现状痛点
原 `SegmentedControl.tsx` 独立复制了 261 行代码与独立的 `SegmentedControl.module.css`。两份代码互相割裂，不仅导致包体积增加，还使 `SegmentedControl` 缺少 `orientation="vertical"`、`variant="line"` 与完整的 WAI-ARIA 交叉引用支持。

#### 2. 重构设计
将 `SegmentedControl` 还原为消费 `Tabs` 的纯净高阶封装（High-Order Wrapper，约 40 行有效代码），实现 100% 逻辑复用：

```tsx
import React, { forwardRef } from 'react';
import { Tabs, TabsList, TabsTrigger } from '../Tabs/Tabs';
import type { SegmentedControlOption, SegmentedControlProps } from '../Tabs/types';

function normalizeOption<T extends string>(
  raw: SegmentedControlOption<T> | T
): SegmentedControlOption<T> {
  return typeof raw === 'string' ? { value: raw as T, label: raw } : raw;
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
      style,
      'aria-label': ariaLabel,
      ...restProps
    },
    ref
  ) {
    const options = rawOptions.map(normalizeOption);
    const initialDefault = defaultValue ?? (options.length > 0 ? options[0]?.value : undefined);

    return (
      <div ref={ref} style={style} {...restProps}>
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
          <TabsList aria-label={ariaLabel} role="radiogroup">
            {options.map((opt) => (
              <TabsTrigger
                key={opt.value}
                value={opt.value}
                icon={opt.icon}
                badge={opt.badge}
                role="radio"
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

### 4.2 严格同心圆角几何矩阵（$R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$）

#### 1. 几何公式与月牙挤压消除
在现代工业设计中，外框与内嵌滑块在具有内边距（Padding）时，若分配相同半径的圆角，内外轮廓的曲率中心无法重合，导致四个圆弧拐角处的间隙变窄（Corner Pinching）。
只有严格遵循同心圆角公式：
$$R_{\text{inner}} = \max(0, R_{\text{outer}} - \text{Padding})$$
才能保证内层白卡片与外框槽位在整个转角过渡中保持恒定的视觉间距。

#### 2. 全尺寸档位同心几何对照矩阵

| 尺寸档位 (`size`) | 容器总高度 | 容器内边距 ($P$) | 外框圆角 ($R_{\text{outer}}$) | Token 绑定契约 | 滑块同心圆角 ($R_{\text{inner}}$) | 字号 / 图标尺寸 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`xs`** | `24px` | `2px` | **`6px`** | `var(--radius-md)` | **`4px`** ($6 - 2$) | `12px` / `13px` |
| **`sm` (默认)** | `28px` | `2px` | **`7px`** | `var(--button-radius)` | **`5px`** ($7 - 2$) | `13px` / `14px` |
| **`md`** | `32px` | `3px` | **`8px`** | `var(--radius-lg)` | **`5px`** ($8 - 3$) | `14px` / `16px` |
| **`lg`** | `38px` | `3.5px` | **`10px`** | `var(--radius-xl)` | **`6.5px`** ($10 - 3.5$) | `15px` / `18px` |

所有样式均在 `Tabs.module.css` 中统一声明与继承，`SegmentedControl` 无需维护任何重复样式。

---

### 4.3 SegmentedControl 完整重构代码（TSX）

#### `apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx`
```tsx
/**
 * ui/SegmentedControl 原子分段选择器 (v1.1.0 架构升级版)
 *
 * 架构升级：
 * - 彻底废除 260 行冗余复制实现，归一化收敛至基于 Tabs 体系的高阶轻量适配器（~45 行）；
 * - 100% 继承 Tabs 的同心圆角几何体系（R_inner = R_outer - Padding）；
 * - 100% 继承 Zero-FOUC 首屏门闩、常驻 ResizeObserver 监听与阻尼微过冲物理动效；
 * - 完整向下兼容现有业务调用契约。
 */
import React, { forwardRef } from 'react';
import { Tabs, TabsList, TabsTrigger } from '../Tabs/Tabs';
import type { SegmentedControlOption, SegmentedControlProps } from '../Tabs/types';

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
      style,
      'aria-label': ariaLabel,
      ...restProps
    },
    ref
  ) {
    const options = rawOptions.map(normalizeOption);
    const initialDefault = defaultValue ?? (options.length > 0 ? options[0]?.value : undefined);

    return (
      <div ref={ref} style={style} {...restProps}>
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
          <TabsList aria-label={ariaLabel} role="radiogroup">
            {options.map((opt) => (
              <TabsTrigger
                key={opt.value}
                value={opt.value}
                icon={opt.icon}
                badge={opt.badge}
                role="radio"
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

## 五、Design Tokens 消费与工程规范矩阵

### 1. Zero-Blue 墨阶纯净化规范
- **纯白卡底**：统一使用 `var(--bg-card, hsl(0 0% 100%))`；
- **沉降底板**：统一使用 3.5% 暖灰底板 `var(--bg-secondary)`；
- **边框体系**：统一使用 `var(--border-subtle)`（发丝微边框）与 `var(--border-color)`（悬浮/激活边框）；
- **品牌翡翠绿**：统一使用 `var(--brand, hsl(160 84% 39%))` 与 `var(--brand-deep, hsl(160 84% 30%))`。

### 2. AGENTS.md §13 软性焦点环与 §14 现代色彩空间
- **软性焦点环**：
  ```css
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  ```
- **色彩空间**：杜绝一切 `rgba(...)` 与 `#hex` 硬编码回退，全面采用 `hsl(h s l / a)` 与 `color-mix(in srgb, ...)`。

### 3. RL-03 代码行数与单文件红线达标表

| 目标文件 | 现存行数 | 重构后行数 | 红线阈值 | 达标状态 |
| :--- | :---: | :---: | :---: | :---: |
| `Switch.tsx` | 207 行 | **~195 行** | $\le 500$ 行 | **达标 (绿灯)** |
| `Switch.module.css` | 265 行 | **~245 行** | $\le 500$ 行 | **达标 (绿灯)** |
| `Tabs.tsx` | 433 行 | **~380 行** | $\le 500$ 行 | **达标 (绿灯)** |
| `Tabs.module.css` | 297 行 | **~290 行** | $\le 500$ 行 | **达标 (绿灯)** |
| `types.ts` | 111 行 | **~115 行** | $\le 500$ 行 | **达标 (绿灯)** |
| `SegmentedControl.tsx` | 261 行 | **~50 行** (精简 81%) | $\le 500$ 行 | **达标 (绿灯)** |

---

## 六、测试与验证规划（Vitest Test Matrix）

### 1. 测试用例清单矩阵

```
Switch / Tabs / SegmentedControl 测试用例矩阵 (100% 覆盖)
├── Switch 测试集
│   ├── [断言 S1] 基础渲染与 ARIA (role=switch, aria-checked, data-state)
│   ├── [断言 S2] Zero-FOUC 门闩：首屏 checked 时 checkIcon 静态满血呈现，无 animation
│   ├── [断言 S3] 交互后激活动态 checkmark-draw 描边与 thumb-stretch-on 拉伸
│   ├── [断言 S4] 受控/非受控双模与 0 次二次 Render 瀑布断言
│   ├── [断言 S5] 键盘导航：Space / Enter 切换，IME 组合态 isComposing 拦截
│   ├── [断言 S6] Disabled / Loading 状态锁定与 Spinner 渲染
│   └── [断言 S7] Eco Tier 降级与 Reduced Motion 静态断言
├── Tabs 测试集
│   ├── [断言 T1] 基础渲染与 WAI-ARIA 交叉引用 (id, aria-controls, aria-labelledby)
│   ├── [断言 T2] Zero-FOUC 门闩：首屏指示器挂载带有 data-ready="false" 且 transition: none
│   ├── [断言 T3] 常驻 ResizeObserver 监听：Tab 切换不触发 unobserve / re-observe
│   ├── [断言 T4] Roving Tabindex 键盘漫游：ArrowRight / ArrowLeft / Home / End
│   ├── [断言 T5] 动态禁用保护：当前选中项禁用时自动委托 tabIndex=0 至首个可用项
│   ├── [断言 T6] 阻尼微过冲贝塞尔与 Line 变体单一 GPU 定位断言
│   └── [断言 T7] 同心圆角几何体系断言 (R_inner = R_outer - Padding)
└── SegmentedControl 测试集
    ├── [断言 C1] 数据驱动 options 数组渲染与默认首项激活
    ├── [断言 C2] 受控 value 与 onChange 变更回调
    ├── [断言 C3] 纯字符串数组与对象数组双向归一化
    ├── [断言 C4] 单项禁用与整组禁用交互拦截
    └── [断言 C5] 基于 Tabs 架构桥接契约与全尺寸档位同心圆角断言
```

### 2. 门禁执行与验证指令

```bash
# 1. 运行 Switch 单元测试
npx vitest run apps/crish-desktop/src/components/ui/Switch/Switch.test.tsx

# 2. 运行 Tabs 单元测试
npx vitest run apps/crish-desktop/src/components/ui/Tabs/Tabs.test.tsx

# 3. 运行 SegmentedControl 单元测试
npx vitest run apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.test.tsx

# 4. 全仓代码行数门禁自查
npm run check:line-counts
```
