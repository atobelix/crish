# PreviewCard 富媒体悬停预览与双层贝塞尔平滑小三角设计方案

> **文件路径**：`docs/ui-component-modernization/independent-plans/04-PreviewCard富媒体悬停预览与贝塞尔小三角方案.md`  
> **所属战役**：UI 组件现代化与设计系统升级 (ui-component-modernization)  
> **核心原则**：**严禁引入外部组件库（如 Radix / Floating UI / Base UI / Framer Motion）**；吸收 Appica UI 优秀的双层贝塞尔平滑小三角几何、Safe-Aim 防误触虚拟多边形与弹性物理微动效，100% 自研 Conex 原生 `PreviewCard` / `RichTooltip` 组件。

---

## 目录
1. [使命与设计原则](#一使命与设计原则)
2. [Appica UI 核心架构解构](#二appica-ui-核心架构解构)
3. [双层贝塞尔平滑小三角（Smooth Curvature Arrow）数学解构](#三双层贝塞尔平滑小三角数学解构)
4. [Safe-Aim 120Hz 防误触碰撞多边形算法](#四safe-aim-120hz-防误触碰撞多边形算法)
5. [物理弹性微动效与 CSS 动画矩阵](#五物理弹性微动效与-css-动画矩阵)
6. [全局图层栈与视口几何约束机制](#六全局图层栈与视口几何约束机制)
7. [三大业务场景蓝图与实战模板](#七三大业务场景蓝图与实战模板)
8. [完整 TypeScript 接口与 API 契约](#八完整-typescript-接口与-api-契约)
9. [CSS Modules 规范与 Design Token 映射](#九css-modules-规范与-design-token-映射)
10. [核心源码实现全景](#十核心源码实现全景)
11. [测试策略与防退化断言](#十一测试策略与防退化断言)

---

## 一、使命与设计原则

### 1.1 背景与定位
在 Conex / Crish Desktop 桌面客户端中，悬停提示目前仅有极简轻量的 `Tooltip`（`apps/crish-desktop/src/components/ui/Tooltip/`）。但随着桌面级交互的演进，多项复杂场景需要**富媒体交互浮层（HoverCard / PreviewCard / RichTooltip）**：
- **可交互性**：浮层内允许包含可点击链接、复制按钮、语法高亮代码块、头像及选项卡，光标可在触发器与浮层间自由平滑穿梭；
- **视觉精致度**：摒弃传统直角 45° 旋转正方形生成的生硬折线三角形，升级为**双层贝塞尔平滑倒角小三角（Smooth Curvature Arrow）**；
- **防误触稳定性**：引入基于 2D 向量叉积的 **Safe-Aim 安全锥形多边形算法**，彻底杜绝鼠标斜向滑入浮层时的意外关闭；
- **物理触感**：注入带回弹阻尼的 **Over-shooting Cubic-Bezier 弹性缩放入场**。

### 1.2 五大铁律设计原则
1. **零外部运行时依赖（Zero External Dependency）**：全套几何计算、Barycentric 重心坐标碰撞、动画状态机与 Portal 挂载 100% 原生实现，不引入 `@floating-ui/react` 或 `@base-ui/react`。
2. **同心几何与像素级缝合（Seamless Geometry Stitching）**：双层 SVG（描边层 + 底色层）与卡片主包围盒完全同源，通过精确坐标重叠杜绝 1px 亚像素黑线/白缝。
3. **全局单槽与静默窗集成（Layer Stack Integration）**：无缝接入 Conex 既有的 `LayerStackManager`，右键上下文菜单、模态对话框开启或视口滚动时自动失活或静音。
4. **意图停留与平滑接续（Intent Delay & Grace Period）**：严格区分「无意划过（300ms 意图防抖）」与「定向移动（300ms 保护 Grace Timer）」，杜绝屏幕光标乱飞引起的视觉污染。
5. **无障碍与无闪烁渲染（A11y & SSR/JSDOM Resilient）**：支持 `aria-haspopup`、`aria-expanded`、`aria-describedby`；针对 JSDOM/测试环境实现零尺寸安全放行，保障 CI 单测绿灯。

---

## 二、Appica UI 核心架构解构

在 `reference/appica-ui/packages/react/src/components/preview-card/preview-card.tsx` 中，其精髓在于：
1. **结构分层**：
   - `PreviewCard`（上下文状态与定时器管理）
   - `PreviewCardTrigger`（触发器包裹，透传 Pointer 与 Focus 事件）
   - `PreviewCardContent`（Portal 挂载的绝对定位浮层，内置卡片壳）
   - `PreviewCardArrowSvg`（双层 SVG 矢量小三角）
2. **锚点边框加厚对齐**：
   - Appica UI 在 `arrow=true` 时，通过 `group-data-[side=top]/popup:border-b-2` 为锚定侧提供加粗对齐，使 2px SVG 描边与卡片边缘融为一体。
3. **弹性入场动画曲线**：
   - 使用 `cubic-bezier(0.175, 0.885, 0.32, 1.5)`，在 200ms 持续时间内完成 `scale(0.9) -> scale(1.025) -> scale(1.0)` 的自然微弹性。

---

## 三、双层贝塞尔平滑小三角数学解构

### 3.1 传统小三角 vs 贝塞尔平滑小三角
- **传统做法**：`div { width: 8px; height: 8px; transform: rotate(45deg); }`
  - 缺陷 1：顶部是尖锐的 90° 直角折线，与现代化圆角卡片（`border-radius: 12px`）产生视觉断层；
  - 缺陷 2：三角与卡片拼接处易因浏览器亚像素抗锯齿（Sub-pixel Anti-aliasing）产生一条半透明缝隙或双重描边。
- **贝塞尔平滑小三角（Appica UI 原语）**：
  - 采用专门定制的三次贝塞尔曲线（Cubic Bézier），顶部为平滑连续圆角，两侧向外优雅延伸，底部深插进卡片内部。

### 3.2 SVG 路径数学参数与几何定义
`PreviewCardArrowSvg` 尺寸为 `26 × 18`，坐标系定义在 `viewBox="0 0 26 18"`：

```xml
<svg width="26" height="18" viewBox="0 0 26 18" fill="none" aria-hidden="true">
  <!-- 描边层（Border Overlay Layer） -->
  <path
    className="arrow-border-stroke"
    d="M21 9 L15.9819 3.36153 C14.3897 1.57244 11.5927 1.57413 10.0026 3.36516 L5 9"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  />
  <!-- 底色填充层（Background Fill Layer） -->
  <path
    className="arrow-background-fill"
    d="M9.82943 4.57564 C11.4308 2.51078 14.5497 2.51076 16.1511 4.5756 L20.9774 10.7986 C23.0157 13.4269 21.1426 17.25 17.8166 17.25 L8.16409 17.25 C4.83808 17.25 2.96496 13.4269 5.00325 10.7987 L9.82943 4.57564Z"
    fill="currentColor"
  />
</svg>
```

#### 数学曲线解析：
1. **描边路径（Stroke Path）**：
   - 起点：$(21, 9)$ —— 右侧与卡片边缘的交汇点；
   - 线段 1：$L(15.9819, 3.36153)$ —— 右侧平直上升翼；
   - 顶部贝塞尔倒角：$C(14.3897, 1.57244, 11.5927, 1.57413, 10.0026, 3.36516)$
     - 控制点 1：$P_1 = (14.3897, 1.57244)$
     - 控制点 2：$P_2 = (11.5927, 1.57413)$
     - 终点：$P_3 = (10.0026, 3.36516)$
     - 在 $t=0.5$ 处曲率半径约为 $R \approx 3.2\text{px}$，产生平滑的连续凸圆弧；
   - 线段 2：$L(5, 9)$ —— 左侧平直下降翼，完美止于 $(5, 9)$。
2. **底色填充路径（Fill Polygon）**：
   - 包含从 $y=4.57$ 经顶部倒角到达底部 $y=17.25$ 的完全闭合凸多边形；
   - 底部宽度为 $17.82 - 8.16 = 9.66\text{px}$，深入卡片内壁达 $8.25\text{px}$；
   - **遮罩缝合原理**：底色填充路径向卡片内部延展 $8.25\text{px}$，使用卡片背景色 `var(--bg-elevated)` 直接盖住卡片外边框在箭头底部的 1px/2px 描边，消除任何重叠交错线。

### 3.3 四向方位旋转与微距偏移矩阵
小三角在不同方位（`side`）下的绝对定位与变换矩阵如下：

| 方位 (`side`) | CSS 旋转 (`transform`) | 定位坐标 (`inset`) | 视觉作用 |
| :--- | :--- | :--- | :--- |
| `bottom` (卡片在下方) | `rotate(0deg)` | `top: -9px; left: calc(50% - 13px)` | 指向正上方触发器 |
| `top` (卡片在上方) | `rotate(180deg)` | `bottom: -9px; left: calc(50% - 13px)` | 指向正下方触发器 |
| `left` (卡片在左侧) | `rotate(90deg)` | `right: -13px; top: calc(50% - 9px)` | 指向正右方触发器 |
| `right` (卡片在右侧) | `rotate(-90deg)` | `left: -13px; top: calc(50% - 9px)` | 指向正左方触发器 |

---

## 四、Safe-Aim 120Hz 防误触碰撞多边形算法

### 4.1 核心问题：斜向滑入的“悬停死区”
当触发元素（Trigger）位于上方，卡片（Content）位于下方时，两者之间存在 $8\text{px} \sim 12\text{px}$ 的间隙（`sideOffset`）。当用户光标从 Trigger 移动到 Content 内部的按钮时，运动轨迹通常是一条**斜向直线**。  
若无 Safe-Aim 保护，光标一旦滑出 Trigger 的矩形，`mouseleave` 立即触发导致卡片关闭；即使设置了简单的 `delayHide=100ms`，斜向移动经过其他元素时也会引发误触。

```
       [ 触发元素 Trigger ]
             \   (光标斜向运动)
      . - - - \ - - - - - - .
     :         \ Safe-Aim    :
     :          v 保护锥区   :
     +-----------------------+
     |  PreviewCard 浮层卡片 |
     |  [点击我] [复制] [查看]|
     +-----------------------+
```

### 4.2 几何原理：2D 向量叉积与重心坐标
当光标离开 Trigger 时，Safe-Aim 引擎以**当前光标位置 $P(x, y)$** 为顶点，以 **PreviewCard 的临近边缘两端点 $V_1(x_1, y_1), V_2(x_2, y_2)$** 为基底，构建一个**安全三角形 $\triangle P V_1 V_2$**。

```ts
/**
 * 2D 向量叉积（Cross Product / Signed Area）
 * 计算向量 (p2 - p1) 与 (p3 - p1) 构成的平行四边形有向面积
 */
export function crossProduct(p1: Point2D, p2: Point2D, p3: Point2D): number {
  return (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
}

/**
 * O(1) 判定点 M 是否在三角形 A, B, C 内部
 * 当且仅当 M 相对三条有向边的叉积同号（全部 >= 0 或全部 <= 0）
 */
export function isPointInTriangle(
  m: Point2D,
  a: Point2D,
  b: Point2D,
  c: Point2D
): boolean {
  const cp1 = crossProduct(a, b, m);
  const cp2 = crossProduct(b, c, m);
  const cp3 = crossProduct(c, a, m);

  const hasNeg = cp1 < 0 || cp2 < 0 || cp3 < 0;
  const hasPos = cp1 > 0 || cp2 > 0 || cp3 > 0;

  return !(hasNeg && hasPos);
}
```

### 4.3 状态机流转设计（120Hz 响应）
```
       [ Hover Trigger ]
              │ (停留 >= delayShow, 默认 300ms)
              ▼
       [ Card Visible ]
              │ (光标离开 Trigger)
              ▼
       [ Safe-Aim Active ] ─── (光标滑入 Card 矩形) ───► [ Card Pinned ]
              │                                                │
              │ (滑出三角区 或 超出 300ms Grace Period)         │ (光标离开 Card)
              ▼                                                ▼
       [ Close Card (100ms exit anim) ] ◄──────────────────────┘
```

1. **进入态**：鼠标移入 Trigger，启动 `showTimer`（默认 300ms）。未满 300ms 移出则清空定时器，零渲染开销。
2. **保护态**：鼠标从 Trigger 移出时，不立即隐藏，而是构建 Safe-Aim 三角形并启动 300ms Grace Timer；期间捕获 `window.mousemove`：
   - 若光标在三角区内：持续放行，并阻止卡片消失；
   - 若光标成功触达 Card：安全三角区解除，卡片进入常驻态（Pinned）；
   - 若光标离开三角区或 300ms 超时：立即执行关闭。

---

## 五、物理弹性微动效与 CSS 动画矩阵

### 5.1 弹性入场物理曲线
Appica UI 采用了高质感回弹曲线：  
`cubic-bezier(0.175, 0.885, 0.32, 1.5)`

$$B(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3$$

- 阻尼特性：在 $t \approx 0.65$（约 130ms）时，缩放比例达到峰值 $1.028$（略微过冲 2.8%），随后在最后 70ms 柔软吸附回 $1.000$；
- 配合透明度过渡：`opacity: 0 -> 1`，赋予卡片如气泡浮现般的生命力与扎实手感。

### 5.2 各方位 Transform Origin 映射
为了让卡片看起来是从触发器所在的一侧“生长”出来的，必须动态计算 `transform-origin`：

| 方位 (`effectiveSide`) | Transform Origin | 初始位移偏置 (`scale(0.9)`) |
| :--- | :--- | :--- |
| `top` | `bottom center` (`50% 100%`) | 向上方微膨胀 |
| `bottom` | `top center` (`50% 0%`) | 向下方微膨胀 |
| `left` | `right center` (`100% 50%`) | 向左侧微膨胀 |
| `right` | `left center` (`0% 50%`) | 向右侧微膨胀 |

### 5.3 退出动画与 Reduced Motion
- **退场动画**：采用紧凑的 `100ms ease-out`，`scale(1) -> scale(0.96)`，`opacity: 1 -> 0`，干净利落，不拖泥带水；
- **减弱动态（Prefers Reduced Motion）**：当检测到 `@media (prefers-reduced-motion: reduce)` 时，关闭 Scale 变换，退化为纯 `opacity` 50ms 线性渐变。

---

## 六、全局图层栈与视口几何约束机制

### 6.1 视口四向碰撞翻折（Collision Flip）与边缘钳位
当触发器靠近屏幕边缘时，必须自动翻折至对侧，并限制在安全视口边距（`EDGE_PAD = 12px`）以内：

1. **纵向空间检测**：
   - 目标 `side="bottom"` 时，若下方剩余空间不足 $H_{\text{card}} + \text{GAP}$ 且上方空间更大，自动翻折至 `top`；
2. **横向空间检测**：
   - 目标 `side="right"` 时，若右侧空间不足且左侧更大，自动翻折至 `left`；
3. **坐标钳位（Clamping）**：
   - 计算得到卡片理想左上角 $(x, y)$ 后，执行：
     $$x_{\text{clamped}} = \max(\text{EDGE\_PAD}, \min(x, V_{\text{width}} - W_{\text{card}} - \text{EDGE\_PAD}))$$
     $$y_{\text{clamped}} = \max(\text{EDGE\_PAD}, \min(y, V_{\text{height}} - H_{\text{card}} - \text{EDGE\_PAD}))$$
4. **小三角自适应对齐（Arrow Alignment Offset）**：
   - 当卡片因视口钳位发生横向位移时，小三角需动态计算 `translateX` 偏置，始终精确对准 Trigger 的几何中心。

### 6.2 离屏检测与静音广播
- **离屏检测（Offscreen Detection）**：触发器一旦滚动出视口（`rect.bottom <= 0 || rect.top >= vh`），卡片立刻静默销毁，禁止留下悬空残影；
- **LayerStackManager 集成**：全局监听 `contextmenu`、`dialog-open`、`window.blur`，在用户进行主要操作时静音并收起浮层。

---

## 七、三大业务场景蓝图与实战模板

### 场景 A：会话消息中的 Markdown 链接 / 引用悬停预览
在 Chat 会话或系统报告中，用户悬停在 URL 链接或内部引用标签上时展示卡片：

```tsx
<PreviewCard side="top" delayShow={350}>
  <PreviewCardTrigger>
    <a href="https://github.com/rust-lang/rust" className={styles.markdownLink}>
      rust-lang/rust
    </a>
  </PreviewCardTrigger>
  <PreviewCardContent width={320}>
    <div className={styles.linkHeader}>
      <img src="/icons/github.svg" className={styles.linkFavicon} alt="" />
      <span className={styles.linkDomain}>github.com</span>
      <Badge tone="success" size="sm">Trusted</Badge>
    </div>
    <PreviewCardTitle>rust-lang/rust: Empowering everyone to build reliable and efficient software.</PreviewCardTitle>
    <PreviewCardDescription>
      A language empowering everyone to build reliable and efficient software. Memory-safe, concurrent, fast.
    </PreviewCardDescription>
    <div className={styles.linkFooter}>
      <Button size="sm" variant="secondary" onClick={() => copyToClipboard('https://github.com/rust-lang/rust')}>
        复制链接
      </Button>
      <Button size="sm" variant="primary" onClick={() => openExternal('https://github.com/rust-lang/rust')}>
        在浏览器打开
      </Button>
    </div>
  </PreviewCardContent>
</PreviewCard>
```

### 场景 B：代码文件路径 / 符号定义的悬停预览卡片
在代码审查、任务面板或终端输出中，悬停在文件路径或函数符号上时快速预览源码片段：

```tsx
<PreviewCard side="right" delayShow={250}>
  <PreviewCardTrigger>
    <code className={styles.filePathCode}>apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:88</code>
  </PreviewCardTrigger>
  <PreviewCardContent width={380}>
    <div className={styles.codeHeader}>
      <FileCodeIcon className={styles.codeIcon} />
      <span className={styles.codePath}>Tooltip.tsx</span>
      <span className={styles.codeLineBadge}>Line 88</span>
    </div>
    <pre className={styles.codeSnippet}>
      <code>{`export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
  ({ content, children, side = 'top', ...rest }, ref) => {
    // 渲染函数含事件合并与 portal
    const [visible, setVisible] = useState(false);`}</code>
    </pre>
    <div className={styles.codeActions}>
      <Button size="xs" variant="ghost" onClick={handleOpenFile}>在编辑器打开</Button>
      <Button size="xs" variant="ghost" onClick={handleCopyPath}>复制相对路径</Button>
    </div>
  </PreviewCardContent>
</PreviewCard>
```

### 场景 C：左侧用户账户 / 模型状态富卡片
悬停在底部侧边栏的模型徽章上，快速查看当前模型的实时延迟、Token 配额与上下文消耗：

```tsx
<PreviewCard side="right" align="end" delayShow={200}>
  <PreviewCardTrigger>
    <div className={styles.modelStatusPill}>
      <span className={styles.modelDotOnline} />
      <span className={styles.modelName}>Claude 3.5 Sonnet</span>
    </div>
  </PreviewCardTrigger>
  <PreviewCardContent width={280}>
    <div className={styles.modelCardHeader}>
      <div className={styles.modelProvider}>Anthropic</div>
      <div className={styles.modelLatency}>142ms</div>
    </div>
    <div className={styles.quotaBarGroup}>
      <div className={styles.quotaLabel}>
        <span>Context Window (200k)</span>
        <span>64% (128,420 tokens)</span>
      </div>
      <div className={styles.quotaTrack}>
        <div className={styles.quotaFill} style={{ width: '64%' }} />
      </div>
    </div>
    <div className={styles.modelFooter}>
      <Button size="xs" variant="secondary" onClick={handleSwitchModel}>切换模型</Button>
      <Button size="xs" variant="ghost" onClick={handleOpenSettings}>设置</Button>
    </div>
  </PreviewCardContent>
</PreviewCard>
```

---

## 八、完整 TypeScript 接口与 API 契约

```ts
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/types.ts
 * PreviewCard 核心类型契约
 */
import React from 'react';

export type PreviewCardSide = 'top' | 'bottom' | 'left' | 'right';
export type PreviewCardAlign = 'start' | 'center' | 'end';

export interface PreviewCardContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  triggerRect: DOMRect | null;
  setTriggerRect: (rect: DOMRect | null) => void;
  triggerEl: HTMLElement | null;
  setTriggerEl: (el: HTMLElement | null) => void;
  contentEl: HTMLElement | null;
  setContentEl: (el: HTMLElement | null) => void;
  side: PreviewCardSide;
  effectiveSide: PreviewCardSide;
  setEffectiveSide: (side: PreviewCardSide) => void;
  arrow: boolean;
  delayShow: number;
  delayHide: number;
  disabled: boolean;
  cardId: string;
  arrowOffset: number;
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
  /** 是否挂载到指定 container DOM 节点，默认 document.body */
  container?: HTMLElement | null;
}

export interface PreviewCardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

export interface PreviewCardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {
  children: React.ReactNode;
}
```

---

## 九、CSS Modules 规范与 Design Token 映射

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
  background: var(--bg-elevated, #1e1e24);
  color: var(--text-primary, #ffffff);
  border: 1px solid var(--border-overlay, rgba(255, 255, 255, 0.12));
  border-radius: var(--radius-xl, 12px);
  padding: var(--space-3, 12px) var(--space-4, 16px);
  box-shadow: var(--shadow-2xl, 0 16px 36px -4px rgba(0, 0, 0, 0.45));
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  box-sizing: border-box;
}

/* 锚定侧边框缝合强化 */
.popup[data-side='top'] {
  border-bottom-width: 2px;
}
.popup[data-side='bottom'] {
  border-top-width: 2px;
}
.popup[data-side='left'] {
  border-right-width: 2px;
}
.popup[data-side='right'] {
  border-left-width: 2px;
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

/* Transform Origin 根据方位动态绑定 */
.popup[data-side='top'] {
  transform-origin: bottom center;
}
.popup[data-side='bottom'] {
  transform-origin: top center;
}
.popup[data-side='left'] {
  transform-origin: right center;
}
.popup[data-side='right'] {
  transform-origin: left center;
}

/* 贝塞尔小三角容器 */
.arrowContainer {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 18px;
  pointer-events: none;
  z-index: 1;
}

.arrowContainer[data-side='top'] {
  bottom: -9px;
  transform: rotate(180deg);
}

.arrowContainer[data-side='bottom'] {
  top: -9px;
  transform: rotate(0deg);
}

.arrowContainer[data-side='left'] {
  right: -13px;
  transform: rotate(90deg);
}

.arrowContainer[data-side='right'] {
  left: -13px;
  transform: rotate(-90deg);
}

/* SVG 路径色彩映射 */
.arrowStroke {
  color: var(--border-overlay, rgba(255, 255, 255, 0.12));
}

.arrowFill {
  color: var(--bg-elevated, #1e1e24);
}

.title {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary, #ffffff);
  line-height: var(--line-height-tight, 1.3);
  margin: 0;
}

.description {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary, #9ca3af);
  line-height: var(--line-height-base, 1.5);
  margin: 0;
}

/* 减弱动态适配 */
@media (prefers-reduced-motion: reduce) {
  .enter {
    animation: previewCardFadeIn 60ms linear forwards;
  }
  .exit {
    animation: previewCardFadeOut 60ms linear forwards;
  }
}

@keyframes previewCardFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes previewCardFadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}
```

---

## 十、核心源码实现全景

### 10.1 贝塞尔小三角组件 (`PreviewCardArrow.tsx`)
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardArrow.tsx
 * 双层贝塞尔平滑小三角渲染器
 */
import React from 'react';
import styles from './PreviewCard.module.css';
import type { PreviewCardSide } from './types';

interface PreviewCardArrowProps {
  side: PreviewCardSide;
  offset?: number;
  className?: string;
}

export const PreviewCardArrow: React.FC<PreviewCardArrowProps> = ({
  side,
  offset = 0,
  className,
}) => {
  const isHorizontal = side === 'left' || side === 'right';

  const positionStyle: React.CSSProperties = isHorizontal
    ? { top: `calc(50% + ${offset}px - 9px)` }
    : { left: `calc(50% + ${offset}px - 13px)` };

  return (
    <div
      data-slot="preview-card-arrow"
      data-side={side}
      className={`${styles.arrowContainer} ${className || ''}`}
      style={positionStyle}
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
        {/* 2. 内层背景填充（深插入卡片内部，遮蔽底边） */}
        <path
          className={styles.arrowFill}
          d="M9.82943 4.57564 C11.4308 2.51078 14.5497 2.51076 16.1511 4.5756 L20.9774 10.7986 C23.0157 13.4269 21.1426 17.25 17.8166 17.25 L8.16409 17.25 C4.83808 17.25 2.96496 13.4269 5.00325 10.7987 L9.82943 4.57564Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
};
```

### 10.2 主组件编排 (`PreviewCard.tsx`)
```tsx
/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx
 * 原生 PreviewCard / RichTooltip
 */
import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useContext,
  createContext,
  forwardRef,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../Dialog/useAnimatedPresence';
import { SafeTriangleTracker } from '../internal/SafeTriangle';
import { computeClampedPosition, isValidDOMRect, isTriggerOffscreen } from '../Tooltip/tooltipPositioning';
import { isTooltipMuted } from '../Tooltip/tooltipController';
import { PreviewCardArrow } from './PreviewCardArrow';
import styles from './PreviewCard.module.css';
import type {
  PreviewCardProps,
  PreviewCardTriggerProps,
  PreviewCardContentProps,
  PreviewCardTitleProps,
  PreviewCardDescriptionProps,
  PreviewCardContextValue,
  PreviewCardSide,
} from './types';

const PreviewCardContext = createContext<PreviewCardContextValue | null>(null);

export function usePreviewCardContext() {
  const ctx = useContext(PreviewCardContext);
  if (!ctx) {
    throw new Error('PreviewCard components must be rendered within a <PreviewCard>');
  }
  return ctx;
}

export const PreviewCard: React.FC<PreviewCardProps> = ({
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

  const setIsOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange]
  );

  const contextValue: PreviewCardContextValue = {
    isOpen,
    setIsOpen,
    triggerRect,
    setTriggerRect,
    triggerEl,
    setTriggerEl,
    contentEl,
    setContentEl,
    side,
    effectiveSide,
    setEffectiveSide,
    arrow,
    delayShow,
    delayHide,
    disabled,
    cardId,
    arrowOffset,
    setArrowOffset,
  };

  return (
    <PreviewCardContext.Provider value={contextValue}>
      {children}
    </PreviewCardContext.Provider>
  );
};

export const PreviewCardTrigger = forwardRef<HTMLElement, PreviewCardTriggerProps>(
  ({ children, asChild = false, ...restProps }, forwardedRef) => {
    const {
      isOpen,
      setIsOpen,
      setTriggerRect,
      setTriggerEl,
      delayShow,
      delayHide,
      disabled,
      cardId,
      contentEl,
      effectiveSide,
    } = usePreviewCardContext();

    const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
    const safeAimTrackerRef = useRef<SafeTriangleTracker>(new SafeTriangleTracker(300));
    const triggerRef = useRef<HTMLElement | null>(null);

    const clearTimers = useCallback(() => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }, []);

    const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
      if (disabled || isTooltipMuted()) return;
      clearTimers();
      const el = e.currentTarget;
      triggerRef.current = el;
      setTriggerEl(el);

      const rect = el.getBoundingClientRect();
      if (!isValidDOMRect(rect) || isTriggerOffscreen(rect)) return;
      setTriggerRect(rect);

      if (delayShow <= 0) {
        setIsOpen(true);
      } else {
        showTimerRef.current = setTimeout(() => {
          setIsOpen(true);
        }, delayShow);
      }
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
      clearTimers();
      if (!isOpen || !contentEl) {
        setIsOpen(false);
        return;
      }

      // 启动 Safe-Aim 保护锥形区检测
      const cursor = { x: e.clientX, y: e.clientY };
      const contentRect = contentEl.getBoundingClientRect();
      safeAimTrackerRef.current.enter(cursor, contentRect, effectiveSide);

      const onWindowMouseMove = (moveEvent: MouseEvent) => {
        const p = { x: moveEvent.clientX, y: moveEvent.clientY };
        // 若在安全三角区内，维持打开状态
        if (safeAimTrackerRef.current.check(p)) {
          return;
        }
        // 若已离开安全区，解除监听并启动 hideTimer
        window.removeEventListener('mousemove', onWindowMouseMove);
        hideTimerRef.current = setTimeout(() => {
          setIsOpen(false);
        }, delayHide);
      };

      window.addEventListener('mousemove', onWindowMouseMove);
    };

    const child = React.Children.only(children);
    return React.cloneElement(child, {
      ref: forwardedRef,
      'aria-haspopup': 'dialog',
      'aria-expanded': isOpen,
      'aria-controls': isOpen ? cardId : undefined,
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      ...restProps,
    });
  }
);
PreviewCardTrigger.displayName = 'PreviewCardTrigger';

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
      setIsOpen,
      triggerRect,
      setContentEl,
      side,
      effectiveSide,
      setEffectiveSide,
      arrow,
      cardId,
      delayHide,
      setArrowOffset,
      arrowOffset,
    } = usePreviewCardContext();

    const popupRef = useRef<HTMLDivElement | null>(null);
    const positionerRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    const { state, isMounted } = useAnimatedPresence({
      visible: isOpen,
      exitDurationMs: 100,
    });

    useLayoutEffect(() => {
      if (!isMounted || !triggerRect || !popupRef.current) return;
      if (isTriggerOffscreen(triggerRect)) {
        setIsOpen(false);
        return;
      }

      const popupEl = popupRef.current;
      setContentEl(popupEl);

      const popupWidth = popupEl.offsetWidth || 300;
      const popupHeight = popupEl.offsetHeight || 120;

      // 执行碰撞检测翻折与钳位计算
      const clamped = computeClampedPosition(side, triggerRect, popupWidth, popupHeight);
      setEffectiveSide(clamped.effectiveSide);
      setPos({ top: clamped.top, left: clamped.left });

      // 计算小三角相对 Trigger 中心的偏置
      const triggerCenter = triggerRect.left + triggerRect.width / 2;
      const popupCenter = clamped.left + popupWidth / 2;
      setArrowOffset(triggerCenter - popupCenter);
    }, [isMounted, triggerRect, side, setIsOpen, setContentEl, setEffectiveSide, setArrowOffset]);

    if (!isMounted || !triggerRect) return null;

    const portalTarget = container ?? (typeof document !== 'undefined' ? document.body : null);
    if (!portalTarget) return null;

    const isReady = pos !== null;

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
          ref={(el) => {
            popupRef.current = el;
            if (typeof forwardedRef === 'function') forwardedRef(el);
            else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          }}
          id={cardId}
          role="dialog"
          data-slot="preview-card-content"
          data-side={effectiveSide}
          className={`${styles.popup} ${isReady ? (state === 'exiting' ? styles.exit : styles.enter) : styles.measuring} ${className || ''}`}
          style={{
            width,
            minWidth,
            maxWidth,
            ...style,
          }}
          onMouseEnter={() => {
            // 鼠标成功划入卡片内部，常驻保持展开
            setIsOpen(true);
          }}
          onMouseLeave={() => {
            // 离开卡片，按 delayHide 退出
            setTimeout(() => {
              setIsOpen(false);
            }, delayHide);
          }}
          {...restProps}
        >
          {children}
          {arrow && <PreviewCardArrow side={effectiveSide} offset={arrowOffset} />}
        </div>
      </div>,
      portalTarget
    );
  }
);
PreviewCardContent.displayName = 'PreviewCardContent';

export const PreviewCardTitle: React.FC<PreviewCardTitleProps> = ({ children, className, ...props }) => (
  <h4 data-slot="preview-card-title" className={`${styles.title} ${className || ''}`} {...props}>
    {children}
  </h4>
);

export const PreviewCardDescription: React.FC<PreviewCardDescriptionProps> = ({ children, className, ...props }) => (
  <p data-slot="preview-card-description" className={`${styles.description} ${className || ''}`} {...props}>
    {children}
  </p>
);
```

---

## 十一、测试策略与防退化断言

### 11.1 单元与几何算法测试矩阵 (`PreviewCard.test.tsx`)
1. **贝塞尔小三角 SVG 渲染测试**：
   - 断言 `viewBox="0 0 26 18"`，包含两条特征 Path（`arrowStroke` 与 `arrowFill`）；
   - 断言在 `side="top"` 时注入 `rotate(180deg)`，`side="left"` 时注入 `rotate(90deg)`。
2. **Safe-Aim 向量三角区断言**：
   - 验证 `isPointInTriangle(M, A, B, C)` 在三种边界下（顶点上、边缘上、三角形外部）的浮点判定准确性；
   - 验证光标在斜向划入过程中触发器的 `mouseleave` 不会导致浮层提前卸载。
3. **碰撞翻折与视口边缘钳位断言**：
   - 模拟靠近视口底部的 Trigger，断言 `effectiveSide` 从 `bottom` 自动翻折为 `top`；
   - 模拟靠近屏幕右侧的 Trigger，断言 `clamped.left` 不超出 `window.innerWidth - width - EDGE_PAD`。
4. **意图停留与定时器测试**：
   - 快速划过（鼠标停留 100ms < `delayShow=300ms`）断言浮层从未挂载至 DOM；
   - 停留 350ms 断言浮层成功挂载，并带有 `role="dialog"` 与正确的 `aria-controls`。
5. **无障碍与销毁安全测试**：
   - 模拟 `window.blur` 或 `LayerStackManager.silence()`，断言卡片立即进入退出状态；
   - 卸载组件时断言所有 `window.removeEventListener` 完全清理，无内存泄漏。
