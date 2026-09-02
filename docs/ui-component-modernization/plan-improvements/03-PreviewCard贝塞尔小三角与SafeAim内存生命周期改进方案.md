# PreviewCard 贝塞尔小三角与 Safe-Aim 内存生命周期改进方案

> **文件路径**：`docs/ui-component-modernization/plan-improvements/03-PreviewCard贝塞尔小三角与SafeAim内存生命周期改进方案.md`  
> **审查基准**：`docs/ui-component-modernization/audits/03-PreviewCard贝塞尔小三角与SafeAim严苛审查.md`、`docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`、`AGENTS.md` §13/§14、RL-03 单文件行数门禁  
> **核心原则**：**100% 原生自研，零外部组件库依赖**；彻底解决全局事件泄漏、跨组件定时器竞态、小三角旋转错位与 12px 圆角穿模问题，全面落实 RL-03 单文件 ≤ 200 行物理解耦。

---

## 一、背景与审计缺陷总结

在近期开展的严苛专项审查中，`PreviewCard` 及其几何支撑模块被发现存在多项致命与严重缺陷，阻碍了生产环境的稳定性与视觉极致度：

| 缺陷编号 | 严重级别 | 缺陷分类 | 核心问题摘要 |
| :--- | :--- | :--- | :--- |
| **DEF-01** | **致命** | 内存与事件系统 | `window.mousemove` 监听器在 Grace Period 超时或鼠标静止时光标无主泄漏，状态机停滞 |
| **DEF-02** | **致命** | 状态机与竞态 | Trigger 与 Content 独立维护私有 `hideTimerRef`，鼠标移回 Trigger 时发生跨组件竞态闪退 |
| **DEF-03** | **致命** | RL-03 工程红线 | `PreviewCard.tsx` 单文件达 767 行（超标 53.4%），混杂数学算法、Context、Trigger、Content 与排版原子 |
| **DEF-04** | **严重** | 几何与渲染精度 | 小三角横向 90° 旋转中心偏移（`right: -13px` 产生 4px 悬空错位），高分屏下存在亚像素撕裂白缝 |
| **DEF-05** | **严重** | 几何穿模 | 小三角偏置裕量仅为 20px，侵入 12px 圆角弧度区域发生 Corner Clipping 悬空破角刺出 |
| **DEF-06** | **严重** | 包含块坐标系 | 自定义 Container 挂载时，`position: fixed` 未扣除容器相对偏移导致卡片上百像素严重漂移 |
| **DEF-07** | **一般** | 算法稳健性 | 2D 向量叉积无 $\epsilon$ 容差，在高 DPI 子像素浮点计算下导致三角形边缘判定提前失效 |
| **DEF-08** | **一般** | 无障碍合规 | `aria-haspopup="dialog"` 语义偏离，Content 缺失 `aria-labelledby` / `aria-describedby` 关联绑定 |
| **DEF-09** | **一般** | 交互体验 | 激进的 `window.blur` 监听导致富文本卡片内部文本选择、输入、上下文菜单唤起时意外销毁 |
| **DEF-10** | **微小** | Design Tokens | 样式表存在旧式 `rgba()` 与非标 HEX fallback，缺失 `:focus-visible` 微发丝焦点环 |

本方案针对上述缺陷提出彻底、严密的数学与架构级重构方案。

---

## 二、核心改进方案详解

### 2.1 内存与生命周期：Grace Timer 绝对计时器与 `window.mousemove` 强制解绑

#### 问题深度剖析
原实现中，鼠标离开 Trigger 时在全局 `window` 注册了 `mousemove` 监听器。当光标在安全锥区内停滞不动或移出 OS 窗口时，`mousemove` 事件不再触发。虽然内部 `SafeTriangleTracker` 的 300ms 计时器会重置内部状态，但**未通知外部清理挂载在 `window` 上的监听函数**，导致监听器在 `window` 上永久堆积；同时卡片停滞在开启状态，破坏了 300ms 超时收拢契约。

#### 极致重构方案
引入**双重受控绝对生命周期状态机**，将 Grace 定时器提升至组件顶层调度，确保任何异常分支均触发绝对解绑：

```
       [ Trigger MouseLeave ]
                 │
                 ├── 1. 构建 Safe-Aim 几何三角形
                 ├── 2. 启动 300ms 绝对 Grace 定时器 (graceTimerRef)
                 └── 3. 挂载 window.mousemove (mouseMoveListenerRef)
                             │
            ┌────────────────┴────────────────┬────────────────┐
            ▼                                 ▼                ▼
   [ 光标滑入 Content ]             [ 光标滑出锥区 ]       [ 300ms 超时 / 鼠标静止 ]
            │                                 │                │
            ▼                                 ▼                ▼
     cleanupSafeAim()                 cleanupSafeAim()    cleanupSafeAim()
   cancelPendingClose()             scheduleClose(150ms)   closeImmediate()
```

- **幂等清理函数 `cleanupSafeAim`**：
  ```ts
  const cleanupSafeAim = useCallback(() => {
    if (mouseMoveListenerRef.current) {
      window.removeEventListener('mousemove', mouseMoveListenerRef.current);
      mouseMoveListenerRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = undefined;
    }
    safeAimTrackerRef.current.reset();
  }, []);
  ```
- **超时与事件清理契约**：
  1. `graceTimerRef.current = setTimeout(() => { cleanupSafeAim(); closeImmediate(); }, 300);`
  2. `window.mousemove` 中若 `!safeAimTrackerRef.current.check(p)`：立即执行 `cleanupSafeAim()` 并调用统一的 `scheduleClose(delayHide)`；
  3. 组件 Unmount 或 Trigger 再次 `mouseenter` 时，强制执行 `cleanupSafeAim()`。

---

### 2.2 状态机收敛：Context 层集中管理定时器，消除跨组件竞态

#### 问题深度剖析
原 `PreviewCardTrigger` 与 `PreviewCardContent` 各自拥有独立的 `hideTimerRef`。当鼠标从 Content 快速划回 Trigger 时，Content 的 `handleMouseLeave` 启动了自身的 150ms 延迟关闭定时器；Trigger 的 `handleMouseEnter` 只能清理 Trigger 内部的定时器，无法感知并取消 Content 正在倒计时的定时器，导致 150ms 后卡片被突发强制关闭。

#### 极致重构方案
建立 **Single Source of Truth（单一调度源）**，所有定时器与状态流转收敛于 `PreviewCardContext`：

```ts
export interface PreviewCardContextValue {
  isOpen: boolean;
  effectiveSide: PreviewCardSide;
  arrowOffset: number;
  triggerRect: DOMRect | null;
  triggerEl: HTMLElement | null;
  contentEl: HTMLElement | null;
  cardId: string;
  titleId: string;
  descriptionId: string;
  arrow: boolean;
  disabled: boolean;
  
  // 集中调度 API
  scheduleOpen: (el?: HTMLElement) => void;
  scheduleClose: (delay?: number) => void;
  cancelPendingClose: () => void;
  cancelPendingOpen: () => void;
  closeImmediate: () => void;
  setTriggerEl: (el: HTMLElement | null) => void;
  setContentEl: (el: HTMLElement | null) => void;
  setTriggerRect: (rect: DOMRect | null) => void;
  setEffectiveSide: (side: PreviewCardSide) => void;
  setArrowOffset: (offset: number) => void;
}
```

- Content 的 `handleMouseEnter` 仅需调用 `cancelPendingClose()`；
- Content 的 `handleMouseLeave` 仅需调用 `scheduleClose(delayHide)`；
- Trigger 的 `handleMouseEnter` 仅需调用 `cancelPendingClose()` 与 `scheduleOpen(delayShow)`；
- 彻底根除多定时器相互覆盖与背刺问题。

---

### 2.3 交互与焦点保全：非侵入式失焦判定

#### 问题深度剖析
原 `PreviewCardContent` 直接通过 `window.addEventListener('blur', handleDismiss)` 监听失焦。当浮层内包含搜索输入框、代码复制按钮、或者用户选中文本时，浏览器内部的焦点切换或临时 ContextMenu 会短暂冒泡失焦事件，导致富文本卡片瞬间销毁。

#### 极致重构方案
1. 移除全局激进的 `window.blur` 销毁监听；
2. 依赖 `LayerStackManager` 统一管理模态窗打开、全局右键菜单唤起时的层级收拢；
3. 在失焦与按键处理中，精确判定当前激活元素：
   ```ts
   // 仅当焦点真正离开卡片与触发器外部时才关闭
   const handleFocusOut = (e: React.FocusEvent<HTMLElement>) => {
     const nextTarget = e.relatedTarget as Node | null;
     if (
       popupRef.current?.contains(nextTarget) ||
       triggerEl?.contains(nextTarget)
     ) {
       return; // 焦点仍在组件内部，维持卡片展示
     }
     scheduleClose(delayHide);
   };
   ```
4. 支持按键盘 `Escape` 键优雅退出并将焦点还给 Trigger。

---

### 2.4 几何与小三角数学模型：90° 旋转中心补偿与亚像素深插抗锯齿

#### 数学模型与错位推导
- 双层贝塞尔小三角 SVG 固有尺寸为 $W_{\text{svg}} = 26\text{px}, H_{\text{svg}} = 18\text{px}$（其中尖端突出高度 $H_{\text{tip}} = 9\text{px}$，卡片内插深度 $D_{\text{insert}} = 9\text{px}$）。
- 当小三角处于 `side="top"` 或 `side="bottom"` 时：
  - SVG 无旋转或 180° 旋转，视觉宽度 26px，视觉高度 18px；
  - 容器中心水平偏置应为 `left: calc(50% + offset - 13px)`（$26 / 2 = 13\text{px}$）。
- 当小三角处于 `side="left"` 或 `side="right"` 时：
  - CSS 使用 `transform: rotate(90deg)` 或 `rotate(-90deg)`，旋转中心为 `(50%, 50%)`；
  - 旋转后，小三角的**视觉包围盒尺寸发生置换**：视觉宽度变为 18px，视觉高度变为 26px；
  - 原实现误写为 `right: -13px` / `left: -13px`，而实际突出高度仅为 9px，导致小三角尖端向外超前突出 $13 - 9 = 4\text{px}$，底座与卡片边缘脱空 4px；
  - 垂直方向居中偏置应基于视觉高度 26px 进行对称补偿：`top: calc(50% + offset - 13px)`。

#### 亚像素深插抗锯齿（Overlap Stitching）
在高分屏（125%、150%、200% DPI）下，CSS 旋转与 1px/2px 边框在抗锯齿光栅化时容易产生 0.5px 的半透明撕裂白缝。本方案采用 **0.5px 亚像素深插缝合**：

```css
/* apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.module.css */
.arrowContainer {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 18px;
  pointer-events: none;
  z-index: 2;
}

.arrowContainer[data-side='top'] {
  bottom: -8.5px; /* 0.5px 深入卡片消除亚像素接缝 */
  transform: rotate(180deg);
}

.arrowContainer[data-side='bottom'] {
  top: -8.5px;
  transform: rotate(0deg);
}

.arrowContainer[data-side='left'] {
  right: -8.5px; /* 修正 4px 旋转错位并施加 0.5px 缝合 */
  transform: rotate(90deg);
  transform-origin: center center;
}

.arrowContainer[data-side='right'] {
  left: -8.5px;
  transform: rotate(-90deg);
  transform-origin: center center;
}
```

在 `PreviewCardArrow.tsx` 中统一四向中心偏移公式：
```tsx
const posOffset = offset - 13;
const sign = posOffset >= 0 ? '+' : '-';
const absOffset = Math.abs(posOffset);

const positionStyle: React.CSSProperties = isHorizontal
  ? { top: `calc(50% ${sign} ${absOffset}px)`, ...style }
  : { left: `calc(50% ${sign} ${absOffset}px)`, ...style };
```

---

### 2.5 穿模消除：28px 安全裕量与 12px 圆角 Corner Clipping 彻底消除

#### 穿模几何证明
卡片圆角半径为 $R_{\text{card}} = 12\text{px}$（`var(--radius-xl)`），小三角总宽度 $W_{\text{arrow}} = 26\text{px}$（半宽 $w_{1/2} = 13\text{px}$）。
当小三角沿卡片边缘平移偏置（offset）时，若小三角的外翼触碰或侵入卡片的 $12\text{px} \times 12\text{px}$ 圆角过渡曲线区域，小三角平直的底座底色与 2px 描边将悬空暴露在卡片圆角切线之外，形成极不美观的破角刺角（Corner Clipping）。

```
           卡片顶部边缘平直段 (Straight Segment)
      ┌─────────────────────────────┐
     ╭│                             │╮  <-- 12px 圆角曲率区
    ╭ │     ▲ 贝塞尔小三角 (26px)   │ ╮
   ╭  │    / \                      │  ╮
  ╭   │   /   \                     │   ╮
 ╭────┴──┴─────┴────────────────────┴────╮
 │             卡片主体 (R=12px)         │
```

#### 安全边界方程
要保证小三角无论如何偏移，其 26px 的底座完全位于卡片的平直边段内，小三角中心点距离卡片端点的距离 $D_{\text{edge}}$ 必须严格满足：
$$D_{\text{edge}} \ge R_{\text{card}} + w_{1/2} + \Delta_{\text{buffer}} = 12\text{px} + 13\text{px} + 3\text{px} = 28\text{px}$$

因此，在 `PreviewCardPositioner.ts` 中将原先硬编码的 20px 升级为严格的几何常量：
```ts
export const ARROW_SAFE_PADDING = 28;

// 水平方向钳位（side = top / bottom）
const maxOffsetH = Math.max(0, cardWidth / 2 - ARROW_SAFE_PADDING);
arrowOffset = Math.max(-maxOffsetH, Math.min(rawOffset, maxOffsetH));

// 垂直方向钳位（side = left / right）
const maxOffsetV = Math.max(0, cardHeight / 2 - ARROW_SAFE_PADDING);
arrowOffset = Math.max(-maxOffsetV, Math.min(rawOffset, maxOffsetV));
```

---

### 2.6 容差与坐标归一化：$\epsilon = 10^{-5}$ 浮点容差与自定义 Container 坐标变换

#### 浮点容差升级（`SafeTriangle.ts`）
在高 DPI 屏幕（如 125%、150%、175% 缩放比例）下，光标坐标可能为非整数（例如 `102.375`）。2D 向量叉积在边缘点计算时可能出现 `1e-16` 与 `-1e-16` 的符号突变。
引入 $\epsilon = 10^{-5}$ 容差带：
```ts
export function isPointInTriangle(
  m: Point2D,
  a: Point2D,
  b: Point2D,
  c: Point2D,
  eps = 1e-5
): boolean {
  const cp1 = crossProduct(a, b, m);
  const cp2 = crossProduct(b, c, m);
  const cp3 = crossProduct(c, a, m);

  const hasNeg = cp1 < -eps || cp2 < -eps || cp3 < -eps;
  const hasPos = cp1 > eps || cp2 > eps || cp3 > eps;

  return !(hasNeg && hasPos);
}
```

#### 自定义 Container 包含块相对坐标消除
当 `PreviewCardContent` 指定了非 `document.body` 的 `container` DOM 节点（如在一个 Modal 或特定局部滚动容器中），浏览器的 CSS 定位上下文会被绑定至该包含块。必须将基于 Visual Viewport 的绝对视口坐标 $(x_{\text{vp}}, y_{\text{vp}})$ 转换为相对坐标：
```ts
let targetLeft = result.left;
let targetTop = result.top;

if (portalTarget && portalTarget !== document.body) {
  const containerRect = portalTarget.getBoundingClientRect();
  targetLeft = result.left - containerRect.left + portalTarget.scrollLeft;
  targetTop = result.top - containerRect.top + portalTarget.scrollTop;
}
```

---

## 三、架构重构与 RL-03 物理拆分方案

为了彻底解决 `PreviewCard.tsx` (767 行) 严重违背 RL-03 单文件行数红线的问题，本方案按职责边界将组件物理拆解为 8 个高内聚、低耦合的原子模块，确保**每一个物理文件代码行数严格控制在 200 行以内**：

```
apps/crish-desktop/src/components/ui/PreviewCard/
├── types.ts                    (~70 行)  核心 TypeScript 接口与类型定义
├── PreviewCardPositioner.ts    (~110 行) 视口碰撞翻折、边缘钳位与 28px 穿模安全算法
├── PreviewCardContext.tsx      (~120 行) 集中状态机、统一定时器调度、React Context
├── PreviewCardRoot.tsx         (~60 行)  复合组件根入口 (PreviewCard)
├── PreviewCardTrigger.tsx      (~130 行) 触发器劫持、Safe-Aim 120Hz 追踪、绝对 Grace 定时器
├── PreviewCardContent.tsx      (~180 行) Portal 挂载、LayerStack 集成、Container 坐标归一化
├── PreviewCardArrow.tsx        (~60 行)  双层贝塞尔平滑小三角渲染器与 0.5px 亚像素缝合
├── PreviewCardTypography.tsx   (~40 行)  PreviewCardTitle 与 PreviewCardDescription
├── PreviewCard.module.css      (~160 行) CSS Modules 样式与 Design Tokens 映射
└── index.ts                    (~30 行)  聚合导出契约
```

### 单文件行数预算表（严格门禁：≤ 200 行）

| 文件名 | 预估代码行数 | 核心职责 |
| :--- | :--- | :--- |
| `types.ts` | ~70 行 | 纯类型契约，包含方位、对齐、Context、Props 定义 |
| `PreviewCardPositioner.ts` | ~110 行 | 纯数学视口计算，零 React 状态，独立可测 |
| `PreviewCardContext.tsx` | ~120 行 | 集中管理 `showTimer` / `hideTimer`，消除跨组件竞态 |
| `PreviewCardRoot.tsx` | ~60 行 | 受控与非受控编排，Provider 挂载 |
| `PreviewCardTrigger.tsx` | ~130 行 | 子元素事件合并、A11y 属性注入、Grace Period 管理 |
| `PreviewCardContent.tsx` | ~180 行 | 物理浮层、Presence 入退场动画、视口离屏检测 |
| `PreviewCardArrow.tsx` | ~60 行 | 双层 SVG 贝塞尔曲线、四向旋转偏置 |
| `PreviewCardTypography.tsx` | ~40 行 | 标题与描述排版原子，ARIA 绑定关联 |
| `PreviewCard.module.css` | ~160 行 | 符合 Zero-Blue、HSL 变量与微焦点环规范 |
| `index.ts` | ~30 行 | 统一命名空间与子组件导出 |

---

## 四、完整代码实现蓝图

### 4.1 `types.ts`
```ts
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/types.ts
 * PreviewCard 核心类型契约
 */
import React from 'react';

export type PreviewCardSide = 'top' | 'bottom' | 'left' | 'right';
export type PreviewCardAlign = 'start' | 'center' | 'end';

export interface PreviewCardPositionResult {
  left: number;
  top: number;
  effectiveSide: PreviewCardSide;
  arrowOffset: number;
}

export interface PreviewCardContextValue {
  isOpen: boolean;
  effectiveSide: PreviewCardSide;
  arrowOffset: number;
  triggerRect: DOMRect | null;
  triggerEl: HTMLElement | null;
  contentEl: HTMLElement | null;
  cardId: string;
  titleId: string;
  descriptionId: string;
  arrow: boolean;
  disabled: boolean;
  side: PreviewCardSide;
  align: PreviewCardAlign;
  sideOffset: number;
  alignOffset: number;
  delayShow: number;
  delayHide: number;
  
  // 集中调度与状态派发
  scheduleOpen: (el?: HTMLElement) => void;
  scheduleClose: (delay?: number) => void;
  cancelPendingClose: () => void;
  cancelPendingOpen: () => void;
  closeImmediate: () => void;
  setTriggerEl: (el: HTMLElement | null) => void;
  setContentEl: (el: HTMLElement | null) => void;
  setTriggerRect: (rect: DOMRect | null) => void;
  setEffectiveSide: (side: PreviewCardSide) => void;
  setArrowOffset: (offset: number) => void;
}

export interface PreviewCardProps {
  children: React.ReactNode;
  side?: PreviewCardSide;
  align?: PreviewCardAlign;
  sideOffset?: number;
  alignOffset?: number;
  arrow?: boolean;
  delayShow?: number;
  delayHide?: number;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface PreviewCardTriggerProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactElement;
  asChild?: boolean;
}

export interface PreviewCardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  className?: string;
  style?: React.CSSProperties;
  container?: HTMLElement | null;
}

export interface PreviewCardArrowProps extends React.HTMLAttributes<HTMLDivElement> {
  side: PreviewCardSide;
  offset?: number;
  className?: string;
}

export interface PreviewCardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

export interface PreviewCardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {
  children: React.ReactNode;
}
```

---

### 4.2 `PreviewCardPositioner.ts`
```ts
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardPositioner.ts
 * 视口碰撞翻折、边缘钳位与 28px 防穿模几何计算引擎
 */
import type {
  PreviewCardSide,
  PreviewCardAlign,
  PreviewCardPositionResult,
} from './types';

export const PREVIEW_CARD_EDGE_PAD = 12;

/**
 * 防穿模安全裕量：BorderRadius(12px) + ArrowHalfWidth(13px) + Buffer(3px) = 28px
 */
export const ARROW_SAFE_PADDING = 28;

export function computePreviewCardPosition(
  side: PreviewCardSide,
  align: PreviewCardAlign = 'center',
  sideOffset = 10,
  alignOffset = 0,
  rect: DOMRect,
  cardWidth: number,
  cardHeight: number
): PreviewCardPositionResult {
  const vw =
    typeof window !== 'undefined'
      ? window.visualViewport?.width || window.innerWidth || 1280
      : 1280;
  const vh =
    typeof window !== 'undefined'
      ? window.visualViewport?.height || window.innerHeight || 800
      : 800;

  const spaceTop = rect.top - PREVIEW_CARD_EDGE_PAD;
  const spaceBottom = vh - PREVIEW_CARD_EDGE_PAD - rect.bottom;
  const spaceLeft = rect.left - PREVIEW_CARD_EDGE_PAD;
  const spaceRight = vw - PREVIEW_CARD_EDGE_PAD - rect.right;

  const requiredV = cardHeight + sideOffset;
  const requiredH = cardWidth + sideOffset;

  let effectiveSide: PreviewCardSide = side;

  // 视口四向碰撞智能翻折
  if (side === 'top' && spaceTop < requiredV && spaceBottom > spaceTop) {
    effectiveSide = 'bottom';
  } else if (
    side === 'bottom' &&
    spaceBottom < requiredV &&
    spaceTop > spaceBottom
  ) {
    effectiveSide = 'top';
  } else if (
    side === 'left' &&
    spaceLeft < requiredH &&
    spaceRight > spaceLeft
  ) {
    effectiveSide = 'right';
  } else if (
    side === 'right' &&
    spaceRight < requiredH &&
    spaceLeft > spaceRight
  ) {
    effectiveSide = 'left';
  }

  let left: number;
  let top: number;
  let arrowOffset = 0;

  if (effectiveSide === 'top' || effectiveSide === 'bottom') {
    top =
      effectiveSide === 'top'
        ? rect.top - sideOffset - cardHeight
        : rect.bottom + sideOffset;

    if (align === 'start') {
      left = rect.left + alignOffset;
    } else if (align === 'end') {
      left = rect.right - cardWidth + alignOffset;
    } else {
      left = rect.left + (rect.width - cardWidth) / 2 + alignOffset;
    }

    const clampW = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vw - cardWidth - PREVIEW_CARD_EDGE_PAD
    );
    const clampH = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vh - cardHeight - PREVIEW_CARD_EDGE_PAD
    );
    const clampedLeft = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, left), clampW);
    const clampedTop = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, top), clampH);

    // 小三角对齐与 28px 安全边界钳位
    const triggerCenterX = rect.left + rect.width / 2;
    const cardCenterX = clampedLeft + cardWidth / 2;
    const rawOffset = triggerCenterX - cardCenterX;
    const maxOffset = Math.max(0, cardWidth / 2 - ARROW_SAFE_PADDING);
    arrowOffset = Math.max(-maxOffset, Math.min(rawOffset, maxOffset));

    return { left: clampedLeft, top: clampedTop, effectiveSide, arrowOffset };
  } else {
    left =
      effectiveSide === 'left'
        ? rect.left - sideOffset - cardWidth
        : rect.right + sideOffset;

    if (align === 'start') {
      top = rect.top + alignOffset;
    } else if (align === 'end') {
      top = rect.bottom - cardHeight + alignOffset;
    } else {
      top = rect.top + (rect.height - cardHeight) / 2 + alignOffset;
    }

    const clampW = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vw - cardWidth - PREVIEW_CARD_EDGE_PAD
    );
    const clampH = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vh - cardHeight - PREVIEW_CARD_EDGE_PAD
    );
    const clampedLeft = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, left), clampW);
    const clampedTop = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, top), clampH);

    const triggerCenterY = rect.top + rect.height / 2;
    const cardCenterY = clampedTop + cardHeight / 2;
    const rawOffset = triggerCenterY - cardCenterY;
    const maxOffset = Math.max(0, cardHeight / 2 - ARROW_SAFE_PADDING);
    arrowOffset = Math.max(-maxOffset, Math.min(rawOffset, maxOffset));

    return { left: clampedLeft, top: clampedTop, effectiveSide, arrowOffset };
  }
}
```

---

### 4.3 `PreviewCardContext.tsx`
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardContext.tsx
 * PreviewCard 上下文与单一真实调度源
 */
import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
} from 'react';
import { isTooltipMuted } from '../Tooltip/tooltipController';
import { isValidDOMRect, isTriggerOffscreen } from '../Tooltip/tooltipPositioning';
import type {
  PreviewCardContextValue,
  PreviewCardProps,
  PreviewCardSide,
} from './types';

const PreviewCardContext = createContext<PreviewCardContextValue | null>(null);

export function usePreviewCardContext() {
  const ctx = useContext(PreviewCardContext);
  if (!ctx) {
    throw new Error(
      'PreviewCard subcomponents must be rendered within a <PreviewCard>'
    );
  }
  return ctx;
}

export const PreviewCardProvider: React.FC<PreviewCardProps> = ({
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 10,
  alignOffset = 0,
  arrow = true,
  delayShow = 300,
  delayHide = 150,
  disabled = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const [effectiveSide, setEffectiveSide] = useState<PreviewCardSide>(side);
  const [arrowOffset, setArrowOffset] = useState<number>(0);

  const cardId = useId();
  const titleId = `${cardId}-title`;
  const descriptionId = `${cardId}-desc`;

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();

  const setIsOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange]
  );

  const cancelPendingOpen = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = undefined;
    }
  }, []);

  const cancelPendingClose = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  }, []);

  const closeImmediate = useCallback(() => {
    cancelPendingOpen();
    cancelPendingClose();
    setIsOpen(false);
  }, [cancelPendingOpen, cancelPendingClose, setIsOpen]);

  const scheduleOpen = useCallback(
    (el?: HTMLElement) => {
      if (disabled || isTooltipMuted()) return;
      cancelPendingClose();
      cancelPendingOpen();

      const targetEl = el || triggerEl;
      if (targetEl) {
        setTriggerEl(targetEl);
        const rect = targetEl.getBoundingClientRect();
        if (!isValidDOMRect(rect) || isTriggerOffscreen(rect)) return;
        setTriggerRect(rect);
      }

      if (delayShow <= 0) {
        setIsOpen(true);
      } else {
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = undefined;
          setIsOpen(true);
        }, delayShow);
      }
    },
    [disabled, triggerEl, delayShow, cancelPendingClose, cancelPendingOpen, setIsOpen]
  );

  const scheduleClose = useCallback(
    (delay = delayHide) => {
      cancelPendingOpen();
      cancelPendingClose();
      if (delay <= 0) {
        setIsOpen(false);
      } else {
        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = undefined;
          setIsOpen(false);
        }, delay);
      }
    },
    [delayHide, cancelPendingOpen, cancelPendingClose, setIsOpen]
  );

  useEffect(() => {
    if (disabled && isOpen) {
      closeImmediate();
    }
  }, [disabled, isOpen, closeImmediate]);

  useEffect(() => {
    return () => {
      cancelPendingOpen();
      cancelPendingClose();
    };
  }, [cancelPendingOpen, cancelPendingClose]);

  const contextValue: PreviewCardContextValue = {
    isOpen,
    effectiveSide,
    arrowOffset,
    triggerRect,
    triggerEl,
    contentEl,
    cardId,
    titleId,
    descriptionId,
    arrow,
    disabled,
    side,
    align,
    sideOffset,
    alignOffset,
    delayShow,
    delayHide,
    scheduleOpen,
    scheduleClose,
    cancelPendingClose,
    cancelPendingOpen,
    closeImmediate,
    setTriggerEl,
    setContentEl,
    setTriggerRect,
    setEffectiveSide,
    setArrowOffset,
  };

  return (
    <PreviewCardContext.Provider value={contextValue}>
      {children}
    </PreviewCardContext.Provider>
  );
};
```

---

### 4.4 `PreviewCardRoot.tsx`
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardRoot.tsx
 * PreviewCard 复合组件根容器
 */
import React from 'react';
import { PreviewCardProvider } from './PreviewCardContext';
import type { PreviewCardProps } from './types';

export const PreviewCard: React.FC<PreviewCardProps> = (props) => {
  return <PreviewCardProvider {...props} />;
};
PreviewCard.displayName = 'PreviewCard';
```

---

### 4.5 `PreviewCardTrigger.tsx`
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardTrigger.tsx
 * 触发器包装器：Safe-Aim 120Hz 几何防护与绝对 Grace 计时器
 */
import React, { useRef, useCallback, useEffect, useLayoutEffect, forwardRef } from 'react';
import { SafeTriangleTracker } from '../internal/SafeTriangle';
import { isValidDOMRect } from '../Tooltip/tooltipPositioning';
import { usePreviewCardContext } from './PreviewCardContext';
import type { PreviewCardTriggerProps } from './types';

function setRef<T>(
  ref: React.ForwardedRef<T> | React.Ref<T> | undefined,
  value: T | null
) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref && 'current' in ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function useMergeRefs<T>(
  ...refs: Array<React.ForwardedRef<T> | React.Ref<T> | undefined>
) {
  return useCallback(
    (value: T | null) => {
      refs.forEach((ref) => setRef(ref, value));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    refs
  );
}

export const PreviewCardTrigger = forwardRef<HTMLElement, PreviewCardTriggerProps>(
  ({ children, asChild = false, ...restProps }, forwardedRef) => {
    const {
      isOpen,
      scheduleOpen,
      scheduleClose,
      cancelPendingOpen,
      closeImmediate,
      setTriggerEl,
      setTriggerRect,
      cardId,
      contentEl,
      effectiveSide,
      delayHide,
    } = usePreviewCardContext();

    const triggerRef = useRef<HTMLElement | null>(null);
    const safeAimTrackerRef = useRef<SafeTriangleTracker>(new SafeTriangleTracker(300));
    const mouseMoveListenerRef = useRef<((e: MouseEvent) => void) | null>(null);
    const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useLayoutEffect(() => {
      if (triggerRef.current) {
        setTriggerEl(triggerRef.current);
        const rect = triggerRef.current.getBoundingClientRect();
        if (isValidDOMRect(rect)) {
          setTriggerRect(rect);
        }
      }
    }, [setTriggerEl, setTriggerRect]);

    const cleanupSafeAim = useCallback(() => {
      if (mouseMoveListenerRef.current) {
        window.removeEventListener('mousemove', mouseMoveListenerRef.current);
        mouseMoveListenerRef.current = null;
      }
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = undefined;
      }
      safeAimTrackerRef.current.reset();
    }, []);

    useEffect(() => {
      return () => {
        cleanupSafeAim();
      };
    }, [cleanupSafeAim]);

    const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
      cleanupSafeAim();
      scheduleOpen(e.currentTarget);
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
      cancelPendingOpen();
      if (!isOpen || !contentEl) {
        scheduleClose(delayHide);
        return;
      }

      cleanupSafeAim();

      // 构建 Safe-Aim 几何三角形
      const cursor = { x: e.clientX, y: e.clientY };
      const contentRect = contentEl.getBoundingClientRect();
      safeAimTrackerRef.current.enter(cursor, contentRect, effectiveSide);

      // 启动严格受控的 300ms Grace Period 绝对计时器，防止无主泄漏
      graceTimerRef.current = setTimeout(() => {
        cleanupSafeAim();
        closeImmediate();
      }, 300);

      const onWindowMouseMove = (moveEvent: MouseEvent) => {
        const p = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (safeAimTrackerRef.current.check(p)) {
          return;
        }
        // 光标离开安全区：立即清理并启动 hideTimer
        cleanupSafeAim();
        scheduleClose(delayHide);
      };

      mouseMoveListenerRef.current = onWindowMouseMove;
      window.addEventListener('mousemove', onWindowMouseMove, { passive: true });
    };

    const handleFocus = (e: React.FocusEvent<HTMLElement>) => {
      cleanupSafeAim();
      scheduleOpen(e.currentTarget);
    };

    const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
      cleanupSafeAim();
      const nextTarget = e.relatedTarget as Node | null;
      if (contentEl?.contains(nextTarget)) return;
      scheduleClose(delayHide);
    };

    if (!React.isValidElement(children)) {
      return <>{children}</>;
    }

    const child = children as React.ReactElement<Record<string, unknown>>;
    const childRef =
      (child.props as { ref?: React.Ref<HTMLElement> })?.ref ??
      (child as { ref?: React.Ref<HTMLElement> })?.ref;
    const mergedRef = useMergeRefs(forwardedRef, childRef, triggerRef);
    const childProps = child.props as Record<string, unknown>;

    return React.cloneElement(child, {
      ref: mergedRef,
      'aria-haspopup': 'dialog',
      'aria-expanded': isOpen,
      'aria-controls': isOpen ? cardId : undefined,
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
        (childProps.onMouseEnter as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(e);
        (restProps.onMouseEnter as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(e);
        handleMouseEnter(e);
      },
      onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
        (childProps.onMouseLeave as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(e);
        (restProps.onMouseLeave as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(e);
        handleMouseLeave(e);
      },
      onFocus: (e: React.FocusEvent<HTMLElement>) => {
        (childProps.onFocus as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(e);
        (restProps.onFocus as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(e);
        handleFocus(e);
      },
      onBlur: (e: React.FocusEvent<HTMLElement>) => {
        (childProps.onBlur as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(e);
        (restProps.onBlur as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(e);
        handleBlur(e);
      },
      ...restProps,
    });
  }
);
PreviewCardTrigger.displayName = 'PreviewCardTrigger';
```

---

### 4.6 `PreviewCardContent.tsx`
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardContent.tsx
 * 物理浮层渲染器：Portal 挂载、LayerStack 集成与相对坐标归一化
 */
import React, { useRef, useState, useEffect, useLayoutEffect, forwardRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../Dialog/useAnimatedPresence';
import { isTriggerOffscreen } from '../Tooltip/tooltipPositioning';
import { layerStackManager } from '../internal/layer-stack/LayerStackManager';
import { computePreviewCardPosition } from './PreviewCardPositioner';
import { usePreviewCardContext } from './PreviewCardContext';
import { PreviewCardArrow } from './PreviewCardArrow';
import styles from './PreviewCard.module.css';
import type { PreviewCardContentProps } from './types';

function setRef<T>(
  ref: React.ForwardedRef<T> | React.Ref<T> | undefined,
  value: T | null
) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref && 'current' in ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function useMergeRefs<T>(
  ...refs: Array<React.ForwardedRef<T> | React.Ref<T> | undefined>
) {
  return useCallback(
    (value: T | null) => {
      refs.forEach((ref) => setRef(ref, value));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    refs
  );
}

export const PreviewCardContent = forwardRef<HTMLDivElement, PreviewCardContentProps>(
  (
    {
      children,
      width = 300,
      minWidth,
      maxWidth,
      className,
      style,
      container,
      ...restProps
    },
    forwardedRef
  ) => {
    const {
      isOpen,
      scheduleClose,
      cancelPendingClose,
      closeImmediate,
      triggerRect,
      triggerEl,
      setContentEl,
      side,
      effectiveSide,
      setEffectiveSide,
      align,
      sideOffset,
      alignOffset,
      arrow,
      cardId,
      titleId,
      descriptionId,
      delayHide,
      setArrowOffset,
      arrowOffset,
    } = usePreviewCardContext();

    const popupRef = useRef<HTMLDivElement | null>(null);
    const positionerRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    const mergedRef = useMergeRefs(forwardedRef, popupRef);

    const { state, isMounted } = useAnimatedPresence({
      visible: isOpen,
      exitDurationMs: 100,
    });

    // LayerStackManager 全局图层栈注册
    useEffect(() => {
      if (!isMounted || !isOpen) return;
      const unregister = layerStackManager.register({
        id: cardId,
        type: 'popover',
        dismissible: true,
        elementRef: popupRef,
        anchorRef: triggerEl,
        onDismiss: () => {
          closeImmediate();
        },
      });
      return () => {
        unregister();
      };
    }, [isMounted, isOpen, cardId, triggerEl, closeImmediate]);

    // 视口滚动与尺寸变化处理（过滤内部元素失焦）
    useEffect(() => {
      if (!isOpen) return;
      const handleDismiss = () => closeImmediate();
      window.addEventListener('scroll', handleDismiss, true);
      window.addEventListener('resize', handleDismiss);
      return () => {
        window.removeEventListener('scroll', handleDismiss, true);
        window.removeEventListener('resize', handleDismiss);
      };
    }, [isOpen, closeImmediate]);

    const effectiveRect =
      triggerRect ||
      (triggerEl ? triggerEl.getBoundingClientRect() : null) ||
      (typeof window !== 'undefined'
        ? ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => {} } as DOMRect)
        : null);

    const portalTarget =
      container ?? (typeof document !== 'undefined' ? document.body : null);

    useLayoutEffect(() => {
      if (!isMounted || !popupRef.current) return;
      if (effectiveRect && isTriggerOffscreen(effectiveRect)) {
        closeImmediate();
        return;
      }

      const popupEl = popupRef.current;
      setContentEl(popupEl);

      const popupBounding = popupEl.getBoundingClientRect();
      const popupWidth =
        popupBounding.width > 0
          ? popupBounding.width
          : popupEl.offsetWidth || (typeof width === 'number' ? width : 300);
      const popupHeight =
        popupBounding.height > 0
          ? popupBounding.height
          : popupEl.offsetHeight || 120;

      const currentRect =
        effectiveRect ||
        ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => {} } as DOMRect);

      const result = computePreviewCardPosition(
        side,
        align,
        sideOffset,
        alignOffset,
        currentRect,
        popupWidth,
        popupHeight
      );

      // 自定义 Container 相对坐标归一化
      let targetLeft = result.left;
      let targetTop = result.top;
      if (portalTarget && portalTarget !== document.body) {
        const containerRect = portalTarget.getBoundingClientRect();
        targetLeft = result.left - containerRect.left + portalTarget.scrollLeft;
        targetTop = result.top - containerRect.top + portalTarget.scrollTop;
      }

      setEffectiveSide(result.effectiveSide);
      setPos({ top: targetTop, left: targetLeft });
      setArrowOffset(result.arrowOffset);
    }, [
      isMounted,
      effectiveRect,
      side,
      align,
      sideOffset,
      alignOffset,
      width,
      portalTarget,
      closeImmediate,
      setContentEl,
      setEffectiveSide,
      setArrowOffset,
    ]);

    if (!isMounted || !portalTarget) return null;

    const isReady = pos !== null;

    const handleMouseEnter = () => {
      cancelPendingClose();
    };

    const handleMouseLeave = () => {
      scheduleClose(delayHide);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeImmediate();
        triggerEl?.focus();
      }
    };

    return createPortal(
      <div
        ref={positionerRef}
        className={styles.positioner}
        style={{
          transform: isReady ? `translate3d(${pos.left}px, ${pos.top}px, 0)` : undefined,
          visibility: isReady ? 'visible' : 'hidden',
        }}
      >
        <div
          ref={mergedRef}
          id={cardId}
          role="region"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-slot="preview-card-content"
          data-side={effectiveSide}
          tabIndex={-1}
          className={`${styles.popup} ${
            isReady
              ? state === 'exiting'
                ? styles.exit
                : styles.enter
              : styles.measuring
          } ${className || ''}`}
          style={{
            width,
            minWidth,
            maxWidth,
            ...style,
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onKeyDown={handleKeyDown}
          {...restProps}
        >
          {children}
          {arrow && (
            <PreviewCardArrow side={effectiveSide} offset={arrowOffset} />
          )}
        </div>
      </div>,
      portalTarget
    );
  }
);
PreviewCardContent.displayName = 'PreviewCardContent';
```

---

### 4.7 `PreviewCardArrow.tsx`
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardArrow.tsx
 * 双层贝塞尔平滑小三角渲染器与 0.5px 亚像素缝合
 */
import React from 'react';
import styles from './PreviewCard.module.css';
import type { PreviewCardArrowProps } from './types';

export const PreviewCardArrow: React.FC<PreviewCardArrowProps> = ({
  side,
  offset = 0,
  className,
  style,
  ...restProps
}) => {
  const isHorizontal = side === 'left' || side === 'right';
  // 消除 90° 旋转后的 4px 错位，并以 13px 为基底居中
  const posOffset = offset - 13;
  const sign = posOffset >= 0 ? '+' : '-';
  const absOffset = Math.abs(posOffset);

  const positionStyle: React.CSSProperties = isHorizontal
    ? { top: `calc(50% ${sign} ${absOffset}px)`, ...style }
    : { left: `calc(50% ${sign} ${absOffset}px)`, ...style };

  return (
    <div
      data-slot="preview-card-arrow"
      data-side={side}
      className={`${styles.arrowContainer} ${className || ''}`}
      style={positionStyle}
      {...restProps}
    >
      <svg
        width="26"
        height="18"
        viewBox="0 0 26 18"
        fill="none"
        aria-hidden="true"
      >
        {/* 1. 外层边框描边（2px 圆角连续三次贝塞尔） */}
        <path
          className={styles.arrowStroke}
          d="M21 9 L15.9819 3.36153 C14.3897 1.57244 11.5927 1.57413 10.0026 3.36516 L5 9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* 2. 内层背景填充（深插入卡片内部 8.25px，遮蔽底边） */}
        <path
          className={styles.arrowFill}
          d="M9.82943 4.57564 C11.4308 2.51078 14.5497 2.51076 16.1511 4.5756 L20.9774 10.7986 C23.0157 13.4269 21.1426 17.25 17.8166 17.25 L8.16409 17.25 C4.83808 17.25 2.96496 13.4269 5.00325 10.7987 L9.82943 4.57564Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
};
PreviewCardArrow.displayName = 'PreviewCardArrow';
```

---

### 4.8 `PreviewCardTypography.tsx`
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardTypography.tsx
 * PreviewCard 标题与描述排版原子
 */
import React from 'react';
import { usePreviewCardContext } from './PreviewCardContext';
import styles from './PreviewCard.module.css';
import type { PreviewCardTitleProps, PreviewCardDescriptionProps } from './types';

export const PreviewCardTitle: React.FC<PreviewCardTitleProps> = ({
  children,
  className,
  id,
  ...props
}) => {
  const { titleId } = usePreviewCardContext();
  return (
    <h4
      id={id ?? titleId}
      data-slot="preview-card-title"
      className={`${styles.title} ${className || ''}`}
      {...props}
    >
      {children}
    </h4>
  );
};
PreviewCardTitle.displayName = 'PreviewCardTitle';

export const PreviewCardDescription: React.FC<PreviewCardDescriptionProps> = ({
  children,
  className,
  id,
  ...props
}) => {
  const { descriptionId } = usePreviewCardContext();
  return (
    <p
      id={id ?? descriptionId}
      data-slot="preview-card-description"
      className={`${styles.description} ${className || ''}`}
      {...props}
    >
      {children}
    </p>
  );
};
PreviewCardDescription.displayName = 'PreviewCardDescription';
```

---

### 4.9 `PreviewCard.module.css` (Design Tokens 严格清洗)
```css
/* apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.module.css */

.positioner {
  position: fixed;
  z-index: var(--z-popover, 8000);
  pointer-events: none;
  top: 0;
  left: 0;
  will-change: transform, opacity;
}

.popup {
  position: relative;
  pointer-events: auto;
  outline: none;
  background: var(--bg-elevated, hsl(0 0% 100%));
  color: var(--text-primary);
  border: 1px solid var(--border-overlay, hsl(0 0% 0% / 0.08));
  border-radius: var(--radius-xl, 12px);
  padding: var(--space-3, 12px) var(--space-4, 16px);
  box-shadow: var(
    --shadow-2xl,
    0 16px 36px -4px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 16%, transparent)
  );
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  box-sizing: border-box;
}

.popup:focus-visible {
  outline: 2px solid var(--focus-ring, hsl(0 0% 0% / 0.08));
  outline-offset: 2px;
}

/* 锚定侧边框缝合强化 */
.popup[data-side='top'] {
  border-bottom-width: 2px;
  transform-origin: bottom center;
}
.popup[data-side='bottom'] {
  border-top-width: 2px;
  transform-origin: top center;
}
.popup[data-side='left'] {
  border-right-width: 2px;
  transform-origin: right center;
}
.popup[data-side='right'] {
  border-left-width: 2px;
  transform-origin: left center;
}

/* 物理弹性微动效 */
.enter {
  animation: previewCardEnter 200ms cubic-bezier(0.175, 0.885, 0.32, 1.5) forwards;
}

.exit {
  animation: previewCardExit 100ms ease-out forwards;
}

.measuring {
  visibility: hidden;
  animation: none;
}

@keyframes previewCardEnter {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes previewCardExit {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.96);
  }
}

/* 贝塞尔小三角容器与 0.5px 亚像素深插抗锯齿 */
.arrowContainer {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 18px;
  pointer-events: none;
  z-index: 2;
}

.arrowContainer[data-side='top'] {
  bottom: -8.5px;
  transform: rotate(180deg);
}

.arrowContainer[data-side='bottom'] {
  top: -8.5px;
  transform: rotate(0deg);
}

.arrowContainer[data-side='left'] {
  right: -8.5px;
  transform: rotate(90deg);
  transform-origin: center center;
}

.arrowContainer[data-side='right'] {
  left: -8.5px;
  transform: rotate(-90deg);
  transform-origin: center center;
}

/* SVG 路径色彩映射 */
.arrowStroke {
  color: var(--border-overlay, hsl(0 0% 0% / 0.08));
}

.arrowFill {
  color: var(--bg-elevated, hsl(0 0% 100%));
}

.title {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
  line-height: var(--line-height-tight, 1.3);
  margin: 0;
}

.description {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
  line-height: var(--line-height-base, 1.5);
  margin: 0;
}

/* 减弱动态偏好 */
@media (prefers-reduced-motion: reduce) {
  .enter {
    animation: previewCardFadeIn 60ms linear forwards;
  }
  .exit {
    animation: previewCardFadeOut 60ms linear forwards;
  }
}

@keyframes previewCardFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes previewCardFadeOut {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
```

---

### 4.10 `index.ts`
```ts
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/index.ts
 * 统一聚合导出
 */
export { PreviewCard } from './PreviewCardRoot';
export { PreviewCardTrigger } from './PreviewCardTrigger';
export { PreviewCardContent } from './PreviewCardContent';
export { PreviewCardArrow } from './PreviewCardArrow';
export { PreviewCardTitle, PreviewCardDescription } from './PreviewCardTypography';
export { usePreviewCardContext } from './PreviewCardContext';
export {
  computePreviewCardPosition,
  PREVIEW_CARD_EDGE_PAD,
  ARROW_SAFE_PADDING,
} from './PreviewCardPositioner';
export type {
  PreviewCardProps,
  PreviewCardTriggerProps,
  PreviewCardContentProps,
  PreviewCardArrowProps,
  PreviewCardTitleProps,
  PreviewCardDescriptionProps,
  PreviewCardSide,
  PreviewCardAlign,
  PreviewCardPositionResult,
  PreviewCardContextValue,
} from './types';
```

---

## 五、单元测试与防退化断言矩阵

针对重构后的核心架构与几何算法，更新 `PreviewCard.test.tsx` 并补充以下关键断言用例：

### 5.1 内存与生命周期防护测试
1. **Grace Period 300ms 绝对超时注销 `window.mousemove`**：
   - 模拟鼠标移出 Trigger，断言 `window` 挂载 `mousemove`；
   - 推进时间 300ms，断言 `mousemove` 监听器被注销移除，`window.listeners('mousemove')` 数量归零；
   - 断言卡片在超时后自动关闭。
2. **跨组件定时器竞态消除**：
   - 鼠标进入 Trigger -> 展开卡片 -> 移入 Content -> 移出 Content（触发 150ms 倒计时）；
   - 在 80ms 时迅速移回 Trigger，推进时间至 200ms；
   - 断言卡片保持 `isOpen = true`，未发生突发闪退。

### 5.2 几何与防穿模测试
1. **28px 穿模安全裕量断言**：
   - 当卡片宽度为 300px 时，`maxOffset = 300 / 2 - 28 = 122px`；
   - 传入极端偏置 `rawOffset = 200px`，断言 `arrowOffset` 被严格钳位为 `122px`；
   - 验证小三角边缘距卡片端点距离不小于 28px，杜绝 12px 圆角破角。
2. **横向 90° 旋转对齐样式**：
   - 渲染 `side="left"` 与 `side="right"`，断言 `PreviewCardArrow` 的 `top` 计算使用 `offset - 13px`，视觉中心与触发器绝对重合。
3. **自定义 Container 坐标测试**：
   - 模拟挂载到局部 Modal 容器（`containerRect = { top: 200, left: 150 }`），断言计算得出的 `translate3d` 坐标正确减除了容器 offset。

---

## 六、验收与门禁清单

| 检查项 | 验证标准 | 目标结果 |
| :--- | :--- | :--- |
| **RL-03 单文件行数** | 运行 `npm run check:line-counts` | 拆分后 8 个文件全部 ≤ 200 行，100% 达标 |
| **内存与事件泄漏** | 运行 Vitest 单元测试集 | Grace Period 超时自动解绑 `window.mousemove` 绿灯通过 |
| **定时器竞态** | Content -> Trigger 快速折返测试 | 零闪退，状态机 100% 稳定 |
| **Design Tokens** | 全文检索 HEX / 旧式 rgba | 零硬编码 HEX，全部收敛至 `tokens.css` 语义变量 |
| **穿模与旋转几何** | 28px 安全边界与 90° 旋转断言 | 视觉无破角，无亚像素撕裂白缝 |
| **单元测试全覆盖** | `npm run test -- PreviewCard` | 全量测试用例 100% PASS |
