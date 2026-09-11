# Toast 3D 层叠缩放与悬停扇形展开通知方案 (Native Appica-Inspired Toast Center)

> **版本**：1.0.0
> **状态**：独立方案审定稿
> **设计基准**：吸收 `reference/appica-ui/packages/react/src/components/toast/toast.tsx` 核心物理与动效算法，纯原生零依赖（Zero External Dependency）实现。
> **目标工程**：`apps/crish-desktop`

---

## 目录
1. [执行摘要与设计愿景](#1-执行摘要与设计愿景)
2. [Appica UI 3D 层叠与扇形展开物理算法深度解构](#2-appica-ui-3d-层叠与扇形展开物理算法深度解构)
   - 2.1 堆叠坐标系与空间缩放公式推导 (Scale, Peek, Shrink)
   - 2.2 底部与顶部锚定变换矩阵对比与几何对齐推导
   - 2.3 悬停扇形展开（Hover Fan-Out）与多卡片动态高度累加算法
   - 2.4 手势拖拽滑离（Swipe-to-Dismiss）阻尼动力学与飞离判定
   - 2.5 倒计时时钟与 Hover 暂停同步机制
3. [现有 Conex/Crish Toast 架构诊断与差距分析](#3-现有-conexcrish-toast-架构诊断与差距分析)
4. [原生零依赖 3D 层叠通知系统架构设计](#4-原生零依赖-3d-层叠通知系统架构设计)
   - 4.1 核心分层与数据流
   - 4.2 视口测量引擎（ResizeObserver + 动态高度累计）
   - 4.3 手势交互引擎（Pointer Events + 阻尼回弹 + 动量滑离）
   - 4.4 倒计时时钟与生命周期引擎
   - 4.5 Promise 异步状态机设计 (`toast.promise`)
5. [完整 TypeScript 接口契约与 API 设计](#5-完整-typescript-接口契约与-api-设计)
6. [CSS Modules 核心动效与视觉样式系统实现](#6-css-modules-核心动效与视觉样式系统实现)
   - 6.1 3D 层叠与展开 CSS 变量架构
   - 6.2 贝塞尔物理缓动曲线与硬件加速优化
   - 6.3 纯白卡底、发丝边框与明暗主题 Token 深度适配
   - 6.4 防闪烁 Hover 桥接伪元素（Hover Bridge）
7. [核心组件原生源码实现详案](#7-核心组件原生源码实现详案)
   - 7.1 `ToastStore` & `toast` 命令式门面
   - 7.2 `ToastViewport`（视口容器与展开状态管理）
   - 7.3 `ToastCard`（卡片渲染、3D 变换与手势绑定）
   - 7.4 `ToastProgress`（倒计时进度条）
8. [无障碍（A11y）、极端边界与降级防御](#8-无障碍a11y极端边界与降级防御)
9. [落地演进路线与实施检查清单](#9-落地演进路线与实施检查清单)

---

## 1. 执行摘要与设计愿景

现代桌面与 Web 应用（如 macOS 通知中心、Raycast、Linear、Vercel）的通知体验正在经历从「机械式列表堆砌」向「物理空间感知层叠」的演进。传统的纵向列表弹出容易遮挡关键工作区（特别是 Chat Composer 或侧边面板），且大量并发通知会导致界面混乱。

本项目通知系统致力于实现：
1. **视觉优雅的 3D 空间层叠**：默认多条通知以物理卡片的形式逐层缩放堆叠（首张 1.0，次张 0.9，第三张 0.8...），向上露出发丝阶梯边缘（`--peek: 12px`），仅占用单张通知的屏幕高度，视觉极致克制。
2. **悬停扇形展开交互**：当用户将光标移至通知区时，堆叠卡片平滑扇形/竖向展开为独立高度自适应列表，且倒计时时钟智能暂停，方便用户完整阅读与操作；鼠标移出后优雅折叠回归。
3. **触控与手势滑离（Swipe to Dismiss）**：支持流畅的鼠标拖拽/触摸滑动手势，配合弹性阻尼（Rubber-band）与速度阈值飞离。
4. **轻量零依赖与高扩展性**：彻底摆脱对外部组件库的依赖，完全适配项目现有 `toastQueueLogic.ts` 错误/撤销策略，补充 `toast.promise()` 异步编排能力，完美融入项目原生明暗主题、纯白底色与发丝边框系统。

---

## 2. Appica UI 3D 层叠与扇形展开物理算法深度解构

在深入设计前，我们对 `reference/appica-ui/packages/react/src/components/toast/toast.tsx` 的数学公式与几何模型进行了详尽逆向推导与解构。

### 2.1 堆叠坐标系与空间缩放公式推导

Appica UI 创新性地利用 CSS 自定义属性与 3D Transform 实现了纯 CSS 驱动的卡片层叠：

```
                    ┌─────────────────────────┐  <-- Index 2 (scale: 0.8, z-index: 998)
                ┌───┴─────────────────────────┴───┐  <-- Index 1 (scale: 0.9, z-index: 999)
            ┌───┴─────────────────────────────────┴───┐  <-- Index 0 (scale: 1.0, z-index: 1000)
            │  Frontmost Active Toast                 │
            │  Title: Task Completed                  │
            │  Message: Successfully indexed files.   │
            └─────────────────────────────────────────┘
```

#### 关键数学变量：
1. **索引分层 `--toast-index`**：
   - 设最新/最前端卡片索引 $i = 0$，次新卡片 $i = 1$，第三张 $i = 2$；
   - 空间层级：`z-index = calc(1000 - var(--toast-index))`。
2. **缩放因子 `--scale` 与收缩量 `--shrink`**：
   $$\text{scale}(i) = \max(0, 1 - 0.1 \times i)$$
   $$\text{shrink}(i) = 1 - \text{scale}(i) = 0.1 \times i$$
   - $i=0: \text{scale}=1.0, \text{shrink}=0$
   - $i=1: \text{scale}=0.9, \text{shrink}=0.1$
   - $i=2: \text{scale}=0.8, \text{shrink}=0.2$
3. **阶梯露出偏移 `--peek`**：
   - 默认 `--peek: 0.75rem` ($12\text{px}$)。
4. **高度基准 `--height`**：
   - `--height: var(--toast-frontmost-height, var(--toast-height))`。

#### 底部锚定（Bottom Anchored）的几何补偿推导：
当卡片采用 `transform-origin: bottom` 时，以底部为原点缩放 $\text{scale}$ 会导致卡片顶部边缘向下坍塌 $\text{shrink} \times \text{height}$。为了让第 $i$ 张卡片露出第 $i-1$ 张卡片上方 $\text{peek}$ 的距离，必须在 Y 轴上进行反向位移补偿：

$$\Delta Y_{\text{stacked}}(i) = - (i \times \text{peek}) - (\text{shrink}(i) \times \text{height})$$

**数值代入示例**（设卡片高度 $H = 60\text{px}$，$\text{peek} = 12\text{px}$）：
- $i=0$：$\Delta Y = 0$，缩放 $1.0$，顶边缘在 $-60\text{px}$。
- $i=1$：缩放 $0.9$ 后卡片物理高度为 $54\text{px}$（顶边缘在 $-54\text{px}$）；
  位移补偿 $\Delta Y = -(1 \times 12) - (0.1 \times 60) = -12 - 6 = -18\text{px}$；
  实际顶边缘位置 $= -54\text{px} + (-18\text{px}) = -72\text{px}$；
  与前卡片（$-60\text{px}$）的可见露出差值正好为 **$12\text{px}$**！
- $i=2$：缩放 $0.8$ 后物理高度为 $48\text{px}$；
  位移补偿 $\Delta Y = -(2 \times 12) - (0.2 \times 60) = -24 - 12 = -36\text{px}$；
  实际顶边缘位置 $= -48\text{px} + (-36\text{px}) = -84\text{px}$；
  与次卡片（$-72\text{px}$）的可见露出差值也精确为 **$12\text{px}$**！

几何数学严丝合缝，彻底消除了视觉魔术数字！

---

### 2.2 底部与顶部锚定变换矩阵对比

| 维度 | 底部锚定 (`bottom-right`, `bottom-center`, `bottom-left`) | 顶部锚定 (`top-right`, `top-center`, `top-left`) |
| :--- | :--- | :--- |
| **变换原点 (`transform-origin`)** | `bottom` | `top` |
| **堆叠态位移公式** | `translateY(calc(var(--swipe-y) - (index * peek) - (shrink * height)))` | `translateY(calc(var(--swipe-y) + (index * peek) + (shrink * height)))` |
| **展开态位移公式** | `translateY(calc(-1 * var(--offset-y) + var(--swipe-y)))` | `translateY(calc(var(--offset-y) + var(--swipe-y)))` |
| **入场初始态** | `translateY(150%)` (自屏幕下方飞入) | `translateY(-150%)` (自屏幕上方飞入) |
| **退场默认态** | `translateY(150%)` (向下方飞出) | `translateY(-150%)` (向上方飞出) |
| **投影层级** | `shadow-[0_-8px_16px_-4px_var(--shadow-color)]` (向上弥散) | `shadow-[0_8px_16px_-4px_var(--shadow-color)]` (向下弥散) |

---

### 2.3 悬停扇形展开（Hover Fan-Out）与多卡片动态高度累加算法

当用户将鼠标悬停在 Toast 视口容器上时，容器激活 `data-expanded="true"`。此时所有通知从 3D 层叠态展开为自适应垂直列表：

```
                    ┌─────────────────────────┐  <-- Index 2 (scale: 1.0)
                    │  Third Toast (Custom H) │
                    └─────────────────────────┘
                                 ▲ gap (12px)
                    ┌─────────────────────────┐  <-- Index 1 (scale: 1.0)
                    │  Second Toast (Multi-line
                    │  Description text...)   │
                    └─────────────────────────┘
                                 ▲ gap (12px)
                    ┌─────────────────────────┐  <-- Index 0 (scale: 1.0)
                    │  First Toast            │
                    └─────────────────────────┘
```

#### 动态累加算法（Offset Accumulator）：
由于每条 Toast 允许包含不同的标题、描述或操作按钮，各卡片高度 $H_k$ 并不一致。
展开态下第 $i$ 张卡片的累加偏移量 $\text{offsetY}(i)$ 计算公式为：

$$\text{offsetY}(i) = \sum_{k=0}^{i-1} H_k + i \times \text{gap}$$

- $i=0$：$\text{offsetY}(0) = 0$
- $i=1$：$\text{offsetY}(1) = H_0 + 1 \times \text{gap}$
- $i=2$：$\text{offsetY}(2) = H_0 + H_1 + 2 \times \text{gap}$

通过原生 `ResizeObserver` 实时监听各卡片 DOM 高度，并将计算得到的 `--toast-offset-y` 注入各卡片节点 style 中，实现从堆叠态到展开态 **$0.5\text{s}$ 苹果级缓动曲线平滑过渡**。

---

### 2.4 手势拖拽滑离（Swipe-to-Dismiss）阻尼动力学

为了提供原生触感，通知支持 Pointer Events 手势滑动：
1. **拖拽跟踪**：
   - 监听 `onPointerDown`、`onPointerMove`、`onPointerUp`、`onPointerCancel`；
   - 记录初始坐标 $(x_0, y_0)$ 与时间戳 $t_0$，实时计算 $\Delta x, \Delta y$；
   - 将位移量实时更新至 CSS 变量 `--toast-swipe-movement-x` 与 `--toast-swipe-movement-y`。
2. **弹性阻尼（Rubber Banding）**：
   - 当滑动方向与允许消除方向一致时，位移比为 $1.0$；
   - 当向反方向拖拽时，应用阻尼衰减系数 $\alpha = 0.2$：
     $$\text{movement} = \Delta \times 0.2$$
3. **飞离阈值与动量释放**：
   - 释放时计算瞬时速率 $v = \frac{\sqrt{\Delta x^2 + \Delta y^2}}{\Delta t}$；
   - **触发消除条件**：$|\Delta x| > 60\text{px}$ 或 $\Delta y > 60\text{px}$ 或 $v > 0.5\text{px/ms}$；
   - 命中消除条件时，卡片注入 `data-swipe-direction` 与 `data-ending-style`，沿手势矢量加速飞出屏幕；
   - 未达阈值时，释放后依据缓动曲线弹性归位。

---

### 2.5 倒计时时钟与 Hover 暂停同步机制

1. **CSS 动画倒计时条**：
   - 底部指示器应用 `@keyframes toast-progress`，在 `timeout` 时间内从 `scaleX(1)` 线性缩小至 `scaleX(0)`；
   - 当展开态激活时（`data-expanded="true"`），CSS 触发 `animation-play-state: paused`，动画精准冻结。
2. **JavaScript 定时器时钟同步**：
   - 采用「剩余时间计时器（PausableTimer）」模型：
     - 悬停（Hover 进入）：计算 $t_{\text{elapsed}} = \text{now}() - t_{\text{start}}$，更新 $t_{\text{remaining}} = \max(0, t_{\text{remaining}} - t_{\text{elapsed}})$，清除底层 `setTimeout`；
     - 移出（Hover 离开）：以当前 $t_{\text{remaining}}$ 重新启动 `setTimeout`，并重置 $t_{\text{start}} = \text{now}()$；
   - 彻底避免了「鼠标悬停阅读长文本时通知却突然消失」的不良体验。

---

## 3. 现有 Conex/Crish Toast 架构诊断与差距分析

### 3.1 现有系统全景梳理
- **纯逻辑层**：`apps/crish-desktop/src/hooks/toastQueueLogic.ts`
  - 具备优秀的成功类文案防刷屏门禁（`FORBIDDEN_SUCCESS_TOAST_PATTERNS`）、去重刷新 TTL、撤销操作放行（`onUndo`）、错误优先机制。
- **状态层**：`apps/crish-desktop/src/hooks/useToastQueue.ts`
  - 维护内存数组与 `timersRef`。
- **容器与表现层**：`ToastContainer.tsx` + `ToastStack.tsx` + `ToastStack.module.css`
  - 采用简单的 `flex-direction: column-reverse` 居中堆积在底栏 `bottom: 16px; left: 50%`；
  - 仅支持简单的 `opacity + translateY` 进出场。

### 3.2 核心差距对比矩阵

| 特性维度 | 当前现有实现 (`ToastStack`) | Appica UI 标准 | 本方案原生自研现代化通知中心 |
| :--- | :--- | :--- | :--- |
| **空间占用** | 纵向全量堆叠，每条占用垂直空间，遮挡聊天底栏 | 3D 层叠缩放（仅占单张高度） | **3D 层叠缩放（首张 1.0，次张 0.9，第三张 0.8），阶梯露出 12px** |
| **展开交互** | 无悬停展开，始终保持列表状态 | 悬停扇形平滑展开，高度独立自适应 | **悬停展开自适应列表 + Hover Bridge 防闪烁桥接** |
| **手势操作** | 无手势交互，仅能点击微小关闭按钮 | 完整 Swipe-to-Dismiss 手势 | **Pointer Events 多向滑动消除 + 弹性阻尼动力学** |
| **倒计时反馈** | 仅纯定时器静默消失，无视觉倒计时 | 支持底栏进度条与悬停暂停 | **类型强调色倒计时条 + CSS/JS 毫秒级双向暂停同步** |
| **异步交互** | 无 Promise 异步状态机 | 无原生 Promise 门面 | **原生支持 `toast.promise()`（Loading -> Success / Error 状态无缝流转）** |
| **外部依赖** | 零依赖（但表现单一） | 强依赖 `@base-ui/react` 实验包 | **100% 纯自研零外部依赖，极速轻量** |
| **设计语言** | 基础 token 混色 | Tailwind 原生类 | **深度融合 `--bg-elevated`、发丝边框与明暗模式** |

---

## 4. 原生零依赖 3D 层叠通知系统架构设计

### 4.1 核心分层架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Toast Imperative API                           │
│   toast.show() | toast.success() | toast.error() | toast.promise()     │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Dispatch Action
┌────────────────────────────────────▼────────────────────────────────────┐
│                  ToastStore / useToastQueue (State Engine)               │
│  - 纯策略门禁 (toastQueueLogic)                                          │
│  - PausableTimerManager (悬停毫秒级冻结与恢复)                             │
│  - Promise 状态流转机 (pending -> fulfilled/rejected)                    │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ State Subscription
┌────────────────────────────────────▼────────────────────────────────────┐
│                    <ToastProvider> & <ToastViewport>                    │
│  - 视口定位与锚定 (Bottom-Right / Bottom-Center / Top-Right)             │
│  - Hover 检测与 data-expanded 状态广播                                  │
│  - ResizeObserver 多卡片高度精确测量与累加偏移计算                        │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Distribute CSS Variables
┌────────────────────────────────────▼────────────────────────────────────┐
│                              <ToastCard>                                │
│  - 3D CSS 变量计算 (--scale, --peek, --shrink, --offset-y)              │
│  - Pointer Events 滑动消除引擎 (--toast-swipe-movement-x/y)             │
│  - 类型图标、标题、描述、操作区 (撤销 / Action)、关闭发丝按钮            │
│  - <ToastProgress> 倒计时进度条                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 4.2 视口测量引擎（`useToastStackMeasurement`）

为了在纯 React 环境下实现零依赖的动态高度累加，设计视口测量 Hook：

```typescript
export function useToastStackMeasurement(toasts: readonly AppToast[], expanded: boolean) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());

  const registerNode = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      nodeRefs.current.set(id, el);
      const h = el.getBoundingClientRect().height;
      setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
    } else {
      nodeRefs.current.delete(id);
    }
  }, []);

  // 监听尺寸变化
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      const next = { ...heights };
      for (const entry of entries) {
        const id = entry.target.getAttribute('data-toast-id');
        if (id) {
          const newH = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (next[id] !== newH) {
            next[id] = newH;
            changed = true;
          }
        }
      }
      if (changed) setHeights(next);
    });

    nodeRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [toasts]);

  // 计算累加偏移量
  const getOffsetY = useCallback(
    (index: number, gap: number = 12) => {
      let acc = 0;
      for (let i = 0; i < index; i++) {
        const item = toasts[i];
        const h = item ? (heights[item.id] ?? 56) : 56;
        acc += h + gap;
      }
      return acc;
    },
    [toasts, heights]
  );

  const frontmostHeight = toasts[0] ? (heights[toasts[0].id] ?? 56) : 56;

  return { registerNode, getOffsetY, heights, frontmostHeight };
}
```

---

### 4.3 手势交互引擎（`useSwipeDismiss`）

```typescript
export interface SwipeOptions {
  onDismiss: () => void;
  allowedAxes?: ('up' | 'down' | 'left' | 'right')[];
  threshold?: number;
}

export function useSwipeDismiss({
  onDismiss,
  allowedAxes = ['down', 'right'],
  threshold = 60,
}: SwipeOptions) {
  const [movement, setMovement] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [swiping, setSwiping] = useState(false);
  const startPos = useRef<{ x: number; y: number; time: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return; // 仅限左键
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startPos.current = { x: e.clientX, y: e.clientY, time: performance.now() };
    setSwiping(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!startPos.current) return;
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;

      // 阻尼计算
      const applyDamping = (val: number, positiveAllowed: boolean, negativeAllowed: boolean) => {
        if (val > 0 && !positiveAllowed) return val * 0.2;
        if (val < 0 && !negativeAllowed) return val * 0.2;
        return val;
      };

      const mx = applyDamping(dx, allowedAxes.includes('right'), allowedAxes.includes('left'));
      const my = applyDamping(dy, allowedAxes.includes('down'), allowedAxes.includes('up'));

      setMovement({ x: mx, y: my });
    },
    [allowedAxes]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!startPos.current) return;
      const dt = Math.max(1, performance.now() - startPos.current.time);
      const { x, y } = movement;
      const vx = Math.abs(x) / dt;
      const vy = Math.abs(y) / dt;

      startPos.current = null;
      setSwiping(false);

      const isDismissed =
        (Math.abs(x) > threshold || vx > 0.45) && (x > 0 ? allowedAxes.includes('right') : allowedAxes.includes('left')) ||
        (Math.abs(y) > threshold || vy > 0.45) && (y > 0 ? allowedAxes.includes('down') : allowedAxes.includes('up'));

      if (isDismissed) {
        onDismiss();
      } else {
        setMovement({ x: 0, y: 0 });
      }
    },
    [movement, threshold, allowedAxes, onDismiss]
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    movement,
    swiping,
  };
}
```

---

### 4.4 Promise 异步状态机设计 (`toast.promise`)

支持在异步加载任务（如分支创建、会话导出、模型加载）期间展示 Loading 态，并根据 Promise 决议结果自动无缝过渡为成功或错误通知：

```typescript
toast.promise(
  exportWorkspaceArchive(id),
  {
    loading: '正在导出工作区配置与会话数据...',
    success: (data) => `已成功导出至 ${data.fileName}`,
    error: (err) => `导出失败: ${err.message}`,
  },
  { id: 'workspace-export' }
);
```

**状态流转内部机制**：
1. 发射一条 `type: 'loading'` 的 Toast，`duration: Infinity`（不自动消失）；
2. 当 Promise 成功解决时，原地更新该 ID 的 Toast：`type: 'success'`, 文案更新，重置倒计时为 $5000\text{ms}$，进度条从满格重新启动；
3. 当 Promise 异常拒绝时，原地更新为 `type: 'error'`, `ariaLive: 'assertive'`，进度条重启并伴随轻微警示物理晃动。

---

## 5. 完整 TypeScript 接口契约与 API 设计

```typescript
import * as React from 'react';

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'recovery' | 'loading';
export type ToastPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface ToastActionConfig {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}

export interface AppToast {
  id: string;
  type: ToastType;
  title?: React.ReactNode;
  message: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  duration?: number;
  ariaLive?: 'polite' | 'assertive';
  action?: ToastActionConfig;
  onUndo?: () => void;
  onDismiss?: () => void;
  timestamp: number;
  updateKey?: number;
}

export interface ShowToastOptions {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  duration?: number;
  type?: ToastType;
  action?: ToastActionConfig;
  onUndo?: () => void;
  onDismiss?: () => void;
  position?: ToastPosition;
  progress?: boolean;
}

export interface PromiseToastMessages<T = unknown> {
  loading: React.ReactNode;
  success: React.ReactNode | ((data: T) => React.ReactNode);
  error: React.ReactNode | ((err: unknown) => React.ReactNode);
}

export interface ToastContextValue {
  show: (message: React.ReactNode, options?: ShowToastOptions) => string;
  success: (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>) => string;
  error: (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>) => string;
  warning: (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>) => string;
  info: (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>) => string;
  loading: (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>) => string;
  promise: <T>(promise: Promise<T>, messages: PromiseToastMessages<T>, options?: ShowToastOptions) => Promise<T>;
  dismiss: (id?: string) => void;
  toasts: readonly AppToast[];
}
```

---

## 6. CSS Modules 核心动效与视觉样式系统实现

### 6.1 `ToastStackModern.module.css` 核心样式定义

```css
/* ==========================================================================
   Toast Viewport & 3D Stacking Layer
   ========================================================================== */

.viewport {
  position: fixed;
  z-index: var(--z-toast, 1000);
  width: 360px;
  max-width: calc(100vw - 32px);
  pointer-events: none;
  display: flex;
  flex-direction: column;
  outline: none;
  user-select: none;
  box-sizing: border-box;
}

/* 锚定位置类 */
.viewportBottomRight {
  bottom: 16px;
  right: 16px;
}

.viewportBottomCenter {
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
}

.viewportTopRight {
  top: 16px;
  right: 16px;
}

/* ==========================================================================
   Toast Card Base & Physics Variables
   ========================================================================== */

.toastCard {
  --gap: 12px;
  --peek: 12px;
  --scale: calc(max(0, 1 - (var(--toast-index) * 0.1)));
  --shrink: calc(1 - var(--scale));
  --height: var(--toast-frontmost-height, var(--toast-height, 56px));
  --swipe-x: var(--toast-swipe-movement-x, 0px);
  --swipe-y: var(--toast-swipe-movement-y, 0px);

  position: absolute;
  z-index: calc(1000 - var(--toast-index));
  width: 100%;
  pointer-events: auto;
  box-sizing: border-box;

  /* 堆叠态高度锁定为首张高度，展开态释放为自适应高度 */
  height: var(--height);
  overflow: hidden;

  /* 背景与发丝边框适配 */
  background-color: var(--bg-elevated, #ffffff);
  color: var(--text-primary, #1f2328);
  border: 1px solid var(--hairline, color-mix(in srgb, var(--border-subtle, #e1e4e8) 80%, transparent));
  border-radius: var(--radius-lg, 12px);
  padding: 12px 14px;
  font-size: var(--font-size-sm, 13px);
  line-height: 1.4;

  /* 物理阴影：底部锚定向上发散，顶部锚定向下发散 */
  box-shadow: 0 -4px 16px -2px color-mix(in srgb, var(--shadow-color, #000) 6%, transparent),
              0 2px 6px -1px color-mix(in srgb, var(--shadow-color, #000) 4%, transparent);

  /* 核心物理曲线：展开/折叠 0.5s，高度自适应 0.15s */
  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1),
              opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
              height 0.18s cubic-bezier(0.22, 1, 0.36, 1),
              box-shadow 0.3s ease;
  will-change: transform, opacity, height;
}

/* ==========================================================================
   底部锚定 3D 堆叠与展开 Transform 计算
   ========================================================================== */

.viewport[data-position^='bottom'] .toastCard {
  bottom: 0;
  left: 0;
  right: 0;
  transform-origin: bottom center;

  /* 堆叠态 Transform */
  transform: translateX(var(--swipe-x))
             translateY(calc(var(--swipe-y) - (var(--toast-index) * var(--peek)) - (var(--shrink) * var(--height))))
             scale(var(--scale));
}

/* 悬停扇形展开态 (Hover Expanded) */
.viewport[data-position^='bottom'][data-expanded='true'] .toastCard {
  height: var(--toast-height);
  transform: translateX(var(--swipe-x))
             translateY(calc(-1 * var(--toast-offset-y, 0px) + var(--swipe-y)))
             scale(1);
  box-shadow: var(--shadow-lg, 0 10px 25px -5px color-mix(in srgb, var(--shadow-color, #000) 10%, transparent));
}

/* ==========================================================================
   防闪烁 Hover 桥接伪元素 (Hover Bridge)
   ========================================================================== */

.toastCard::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: calc(var(--gap) + 2px);
  pointer-events: auto;
}

/* ==========================================================================
   入场、退场与手势滑离动画
   ========================================================================== */

@keyframes toastEnterBottom {
  from {
    opacity: 0;
    transform: translateY(120%) scale(0.9);
  }
  to {
    opacity: 1;
  }
}

.toastCard[data-state='entering'] {
  animation: toastEnterBottom 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.toastCard[data-state='exiting'] {
  opacity: 0 !important;
  transform: translateY(120%) scale(0.9) !important;
  pointer-events: none;
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease;
}

.toastCard[data-state='swiping-dismiss'] {
  opacity: 0 !important;
  transform: translateX(calc(var(--swipe-x) * 1.8 + 100px)) translateY(var(--swipe-y)) !important;
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease;
}

/* ==========================================================================
   倒计时进度指示器 (Progress Indicator)
   ========================================================================== */

.progressTrack {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: transparent;
  overflow: hidden;
  border-bottom-left-radius: inherit;
  border-bottom-right-radius: inherit;
  pointer-events: none;
}

.progressBar {
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: var(--color-primary, #0969da);
  animation: toastProgress linear forwards;
}

/* 展开悬停时冻结进度条 */
.viewport[data-expanded='true'] .progressBar {
  animation-play-state: paused !important;
}

@keyframes toastProgress {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

/* ==========================================================================
   类型主题色彩微调 (Type Variants)
   ========================================================================== */

.toastCard[data-type='error'] {
  border-color: var(--color-error-border, #fca5a5);
}
.toastCard[data-type='error'] .progressBar {
  background: var(--text-danger, #cf222e);
}

.toastCard[data-type='success'] {
  border-color: var(--color-success-border, #86efac);
}
.toastCard[data-type='success'] .progressBar {
  background: var(--text-success, #1a7f37);
}

.toastCard[data-type='warning'] {
  border-color: var(--color-warning-border, #fde047);
}
.toastCard[data-type='warning'] .progressBar {
  background: var(--text-warning-strong, #9a6700);
}
```

---

## 7. 核心组件原生源码实现详案

### 7.1 `ToastStore` & `toast` 命令式门面

```typescript
// apps/crish-desktop/src/services/toast/ToastStore.ts
import { AppToast, ShowToastOptions, PromiseToastMessages, ToastType } from './types';
import { enqueueToast, removeToastById, TOAST_TTL_MS } from '../../hooks/toastQueueLogic';

type Listener = () => void;

class ToastStoreImpl {
  private toasts: AppToast[] = [];
  private listeners = new Set<Listener>();

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getToasts(): readonly AppToast[] {
    return this.toasts;
  }

  show(message: React.ReactNode, options?: ShowToastOptions): string {
    const textMessage = typeof message === 'string' ? message : '';
    const id = options?.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const result = enqueueToast(
      this.toasts,
      textMessage,
      options?.onUndo,
      { id, ttlMs: options?.duration, type: options?.type }
    );

    if (result.kind === 'drop') {
      return id;
    }

    const newToast: AppToast = {
      id,
      type: options?.type ?? 'info',
      title: options?.title,
      message,
      description: options?.description,
      icon: options?.icon,
      duration: options?.duration ?? TOAST_TTL_MS,
      action: options?.action,
      onUndo: options?.onUndo,
      onDismiss: options?.onDismiss,
      timestamp: Date.now(),
      updateKey: Date.now(),
    };

    if (result.kind === 'dedupe') {
      this.toasts = this.toasts.map((t) => (t.id === result.existingId ? { ...t, ...newToast, id: t.id } : t));
    } else {
      this.toasts = [newToast, ...this.toasts.filter((t) => !result.evictedIds.includes(t.id))];
    }

    this.notify();
    return id;
  }

  success(message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string {
    return this.show(message, { ...options, type: 'success' });
  }

  error(message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string {
    return this.show(message, { ...options, type: 'error' });
  }

  warning(message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string {
    return this.show(message, { ...options, type: 'warning' });
  }

  info(message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string {
    return this.show(message, { ...options, type: 'info' });
  }

  loading(message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string {
    return this.show(message, { ...options, type: 'loading', duration: Infinity });
  }

  async promise<T>(
    promise: Promise<T>,
    messages: PromiseToastMessages<T>,
    options?: ShowToastOptions
  ): Promise<T> {
    const id = options?.id ?? `toast-p-${Date.now()}`;
    this.show(messages.loading, { ...options, id, type: 'loading', duration: Infinity });

    try {
      const data = await promise;
      const successMsg = typeof messages.success === 'function' ? messages.success(data) : messages.success;
      this.show(successMsg, { ...options, id, type: 'success', duration: options?.duration ?? TOAST_TTL_MS });
      return data;
    } catch (err) {
      const errorMsg = typeof messages.error === 'function' ? messages.error(err) : messages.error;
      this.show(errorMsg, { ...options, id, type: 'error', duration: options?.duration ?? TOAST_TTL_MS });
      throw err;
    }
  }

  dismiss(id?: string) {
    if (!id) {
      this.toasts = [];
    } else {
      this.toasts = removeToastById(this.toasts, id);
    }
    this.notify();
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }
}

export const ToastStore = new ToastStoreImpl();
export const toast = {
  show: ToastStore.show.bind(ToastStore),
  success: ToastStore.success.bind(ToastStore),
  error: ToastStore.error.bind(ToastStore),
  warning: ToastStore.warning.bind(ToastStore),
  info: ToastStore.info.bind(ToastStore),
  loading: ToastStore.loading.bind(ToastStore),
  promise: ToastStore.promise.bind(ToastStore),
  dismiss: ToastStore.dismiss.bind(ToastStore),
};
```

---

### 7.2 `ToastViewport` & `ToastCard` 原生组件

```tsx
// apps/crish-desktop/src/components/overlay/ToastViewport.tsx
import React, { useState, useCallback, useSyncExternalStore } from 'react';
import { ToastStore } from '../../services/toast/ToastStore';
import { useToastStackMeasurement } from './useToastStackMeasurement';
import { ToastCard } from './ToastCard';
import styles from './ToastStackModern.module.css';

export const ToastViewport: React.FC<{ position?: 'bottom-right' | 'bottom-center' | 'top-right' }> = ({
  position = 'bottom-right',
}) => {
  const toasts = useSyncExternalStore(
    ToastStore.subscribe.bind(ToastStore),
    ToastStore.getToasts.bind(ToastStore)
  );

  const [expanded, setExpanded] = useState(false);
  const { registerNode, getOffsetY, heights, frontmostHeight } = useToastStackMeasurement(toasts, expanded);

  const handleMouseEnter = useCallback(() => setExpanded(true), []);
  const handleMouseLeave = useCallback(() => setExpanded(false), []);

  if (toasts.length === 0) return null;

  const positionClass =
    position === 'bottom-center'
      ? styles.viewportBottomCenter
      : position === 'top-right'
      ? styles.viewportTopRight
      : styles.viewportBottomRight;

  return (
    <section
      role="region"
      aria-label="通知中心"
      data-position={position}
      data-expanded={expanded}
      className={`${styles.viewport} ${positionClass}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {toasts.map((item, index) => (
        <ToastCard
          key={item.id}
          toast={item}
          index={index}
          frontmostHeight={frontmostHeight}
          offsetY={getOffsetY(index)}
          onHeightMeasure={(el) => registerNode(item.id, el)}
          onDismiss={() => ToastStore.dismiss(item.id)}
          isExpanded={expanded}
        />
      ))}
    </section>
  );
};
```

```tsx
// apps/crish-desktop/src/components/overlay/ToastCard.tsx
import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as Lucide from 'lucide-react';
import { AppToast } from '../../services/toast/types';
import { useSwipeDismiss } from './useSwipeDismiss';
import styles from './ToastStackModern.module.css';

interface ToastCardProps {
  toast: AppToast;
  index: number;
  frontmostHeight: number;
  offsetY: number;
  isExpanded: boolean;
  onHeightMeasure: (el: HTMLElement | null) => void;
  onDismiss: () => void;
}

export const ToastCard: React.FC<ToastCardProps> = ({
  toast,
  index,
  frontmostHeight,
  offsetY,
  isExpanded,
  onHeightMeasure,
  onDismiss,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);

  const handleDismissAnimation = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      onDismiss();
    }, 280);
  }, [onDismiss]);

  const { onPointerDown, onPointerMove, onPointerUp, movement, swiping } = useSwipeDismiss({
    onDismiss: handleDismissAnimation,
    allowedAxes: ['down', 'right'],
  });

  // 自动倒计时定时器（支持悬停暂停）
  useEffect(() => {
    if (!toast.duration || toast.duration === Infinity) return;
    if (isExpanded) return; // 展开时暂停时钟

    const timer = setTimeout(() => {
      handleDismissAnimation();
    }, toast.duration);

    return () => clearTimeout(timer);
  }, [toast.duration, toast.updateKey, isExpanded, handleDismissAnimation]);

  const setNodeRef = useCallback(
    (el: HTMLDivElement | null) => {
      cardRef.current = el;
      onHeightMeasure(el);
    },
    [onHeightMeasure]
  );

  const styleVariables: React.CSSProperties = {
    ['--toast-index' as string]: index,
    ['--toast-frontmost-height' as string]: `${frontmostHeight}px`,
    ['--toast-height' as string]: cardRef.current ? `${cardRef.current.scrollHeight}px` : 'auto',
    ['--toast-offset-y' as string]: `${offsetY}px`,
    ['--toast-swipe-movement-x' as string]: `${movement.x}px`,
    ['--toast-swipe-movement-y' as string]: `${movement.y}px`,
  };

  const getIcon = () => {
    if (toast.icon) return toast.icon;
    switch (toast.type) {
      case 'success':
        return <Lucide.CheckCircle2 size={16} className="text-success shrink-0" />;
      case 'error':
        return <Lucide.AlertCircle size={16} className="text-danger shrink-0" />;
      case 'warning':
        return <Lucide.AlertTriangle size={16} className="text-warning shrink-0" />;
      case 'loading':
        return <Lucide.Loader2 size={16} className="animate-spin text-primary shrink-0" />;
      default:
        return <Lucide.Info size={16} className="text-primary shrink-0" />;
    }
  };

  return (
    <div
      ref={setNodeRef}
      role="status"
      data-toast-id={toast.id}
      data-type={toast.type}
      data-state={exiting ? 'exiting' : swiping ? 'swiping' : 'idle'}
      aria-live={toast.ariaLive ?? (toast.type === 'error' ? 'assertive' : 'polite')}
      style={styleVariables}
      className={styles.toastCard}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">{getIcon()}</span>
        <div className="flex-1 min-w-0">
          {toast.title && <div className="font-semibold text-xs mb-0.5">{toast.title}</div>}
          <div className="text-xs break-words">{toast.message}</div>
          {toast.description && <div className="text-xs text-muted mt-1">{toast.description}</div>}
        </div>

        {toast.onUndo && (
          <button
            type="button"
            className="text-xs font-medium underline underline-offset-2 ml-2 hover:opacity-80 transition-opacity shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              toast.onUndo?.();
              handleDismissAnimation();
            }}
          >
            撤销
          </button>
        )}

        {toast.action && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-primary text-white ml-2 hover:opacity-90 transition-opacity shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              toast.action?.onClick(e);
            }}
          >
            {toast.action.label}
          </button>
        )}

        <button
          type="button"
          aria-label="关闭"
          className="text-muted hover:text-primary p-0.5 -mr-1 -mt-1 rounded transition-colors shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            handleDismissAnimation();
          }}
        >
          <Lucide.X size={13} strokeWidth={2} />
        </button>
      </div>

      {toast.duration && toast.duration !== Infinity && (
        <div className={styles.progressTrack}>
          <div
            key={toast.updateKey}
            className={styles.progressBar}
            style={{ animationDuration: `${toast.duration}ms` }}
          />
        </div>
      )}
    </div>
  );
};
```

---

## 8. 无障碍（A11y）、极端边界与降级防御

### 8.1 屏幕阅读器与 A11y 契约
- 视口声明 `role="region"` 与 `aria-label="通知中心"`；
- 错误类型通知自动标记 `aria-live="assertive"`，普通信息与成功标记 `aria-live="polite"`；
- 操作按钮与关闭按钮必须带有明确的 `aria-label`；
- 所有交互元素均支持标准键盘 Tab 聚焦与 Enter/Space 激活。

### 8.2 减少动态效果（`prefers-reduced-motion`）
针对偏好减弱动画的用户，在 CSS 中一键降级：
```css
@media (prefers-reduced-motion: reduce) {
  .toastCard {
    transition: none !important;
    animation: none !important;
  }
  .progressBar {
    animation: none !important;
    display: none !important;
  }
}
```

### 8.3 极端边界防御清单
1. **并发超量通知（Burst Flooding）**：`toastQueueLogic` 自动维护最大上限（`maxQueue: 5`），新通知将最旧通知无缝淘汰挤出，防止卡片无限叠加造成内存泄漏或视觉失控。
2. **长文本折叠与自适应**：单行文本紧凑显示，多行描述在展开态通过 `ResizeObserver` 动态拓展容器高度，避免文字截断。
3. **高频 Hover 抖动防护**：通过 `::after` 伪元素（Hover Bridge）填充卡片间 $12\text{px}$ 物理间距，彻底根除鼠标在缝隙间穿梭导致的悬停状态频繁震荡。

---

## 9. 落地演进路线与实施检查清单

- [ ] **Phase 1: 契约与样式基建**
  - [x] 解构 Appica UI 3D 物理与数学模型，完成方案论证；
  - [ ] 在 `apps/crish-desktop/src/services/toast/` 定义增强型 `types.ts`；
  - [ ] 编写 `ToastStackModern.module.css`，完成明暗模式与发丝边框适配；
- [ ] **Phase 2: 状态机与核心 Hooks 自研**
  - [ ] 实现 `ToastStore` 与单例门面，无缝对接既有 `toastQueueLogic.ts`；
  - [ ] 实现 `useToastStackMeasurement` 动态高度计算；
  - [ ] 实现 `useSwipeDismiss` 手势滑离动力学引擎；
- [ ] **Phase 3: 组件装配与视觉验证**
  - [ ] 实现 `ToastViewport` 与 `ToastCard`；
  - [ ] 在桌面端（4000 Tauri MCP）验证 3D 层叠缩放、悬停展开、手势滑动与 Promise 异步流转；
- [ ] **Phase 4: 单元测试与无障碍验收**
  - [ ] 编写 `ToastStore.test.ts` 与 `ToastCard.test.tsx` 单元测试；
  - [ ] 运行全量 `npm run typecheck` 与 `vitest` 门禁。
