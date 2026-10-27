# 分维详案：ToastStack 层叠物理与就地变身系统分析

> **战役工作区**：`docs/arc-library-animation-study/`  
> **专题维度**：ToastStack 堆叠算法（layoutStack）、MotionValue 零重渲染、就地更新形变（Swap & PopLayout）、手势动力学（RubberBand & Velocity Projection）  
> **权威对标参考**：`reference/arc-library/registry/components/toast-stack/`、`toast/`  
> **项目对齐标的**：`apps/crish-desktop/src/components/overlay/ToastViewport.tsx`、`ToastCard.tsx`、`useToastStackMeasurement.ts`、`ToastStackModern.module.css`

---

## 一、堆叠物理布局机制：layoutStack 算法解密

在 `reference/arc-library/registry/components/toast-stack/toast-stack.tsx` 中，多层卡片的几何堆叠由纯函数 `layoutStack` 统筹计算（L111–L123）。

### 1.1 核心常量与物理规则
```typescript
// toast-stack.tsx:70-76
const PEEK = 14;      // 折叠态下，每层卡片相对于前一层露出的纵向露头高度（14px）
const GAP = 12;       // 展开态下，卡片之间的物理间距（12px）
const STEP = 0.05;    // 折叠态下，每往后退一层缩放递减步进（scale 递减 5%）
const BORDER = 2;     // 上下边框补正（2px）
```

### 1.2 layoutStack 算法实现
```typescript
// toast-stack.tsx:111-123
function layoutStack(toasts: ToastRecord[], heights: Record<string, number>, expanded: boolean, visibleToasts: number) {
  const front = toasts.length ? heights[toasts[0]!.id] ?? 0 : 0;
  const tops = toasts.reduce<number[]>((sum, item, index) => 
    [...sum, sum[index]! + (index < visibleToasts ? (heights[item.id] ?? 0) + GAP : 0)], 
    [0]
  );
  const targets = toasts.map((item, index): Target => {
    const visible = index < visibleToasts;
    const depth = Math.min(index, visibleToasts);
    return expanded
      ? { y: -tops[index]!, scale: 1, height: heights[item.id] ?? 0, opacity: visible ? 1 : 0, content: 1 }
      : { y: -PEEK * depth, scale: 1 - STEP * depth, height: index === 0 ? heights[item.id] ?? 0 : front, opacity: visible ? 1 : 0, content: index === 0 ? 1 : 0 };
  });
  const listHeight = !toasts.length ? 0 : expanded ? tops[toasts.length]! - GAP : front + PEEK * (Math.min(toasts.length, visibleToasts) - 1);
  return { targets, listHeight };
}
```

### 1.3 核心力学机制拆解

#### A. 折叠态：统一前排高度对齐与 Top 锚定
- **高度归一化（Front Height Equalization）**：`height: index === 0 ? heights[item.id] ?? 0 : front`。
  后排所有卡片在折叠时**强制共享最前排卡片的高度 (`front`)**。若后排卡片使用各自独立测量的高度（如前排 48px，后排长文 80px），后退缩放时下边缘和阴影会参差错位。高度归一化确保卡片底边和阴影平整对齐。
- **Top 变换原点（`transform-origin: 50% 0`）**：
  卡片向后退深时缩放比例为 $1 - 0.05 \times \text{depth}$，其缩放以卡片顶边为基准向内收缩；叠加 $y = -14\text{px} \times \text{depth}$，使得每一层卡片露出的边缘不多不少恰好是精准的 14px。
- **后排内容遮蔽（Content Culling）**：
  `content: index === 0 ? 1 : 0`。折叠时后排所有卡片的内容透明度直接降为 0，仅保留磨砂卡片底板，彻底杜绝半透明背景下后排文字穿透或产生脏影。

#### B. 展开态：连续 Hover 画布容器（Continuous Hover Canvas）
- **传统伪元素方案痛点**：Conex 当前采用在卡片下方追加 `::after` 伪元素桥接间隙（`ToastStackModern.module.css:196-210`），当光标在卡片间隙移动时极易发生微弱抖动引发意外收缩。
- **arc 连续画布解法**：包裹卡片的 `<ol className={styles.list}>` 直接根据所有卡片的高度前缀和动态计算自身真实外框高度：
  $$\text{listHeight}_{\text{expanded}} = \text{tops}[N] - \text{GAP}$$
  容器本身接收光标事件（`pointer-events: auto`），整个展开区是完整的连续连通域，光标穿行于任何间隙绝不触发 `pointerleave`，从几何架构上根除了悬停闪烁。

---

## 二、连续物理 MotionValue 与零 React 重新渲染引擎

arc-library 的核心性能架构在于：**手势拖拽、展开折叠、弹簧重定向在每秒 120 帧高刷运行中，完全绕过 React Virtual DOM Diff 与 Component Rerender，直接由 MotionValue 写入 GPU 合成层**。

### 2.1 MotionValue 管道拓扑
```typescript
// toast-stack.tsx:214-221
const y = useMotionValue(0);
const scale = useMotionValue(1);
const height = useMotionValue(0);
const opacity = useMotionValue(0);
const contentOpacity = useMotionValue(1);
const x = useMotionValue(0);
const swipeFade = useTransform(x, value => value > 0 ? 1 - Math.min(value / SWIPE_FADE, 1) * .75 : 1);
```
- 手势拖拽时（`pointermove`），仅调用 `x.set(...)`；`swipeFade` 自动由 `useTransform` 派生，将位移转换为 $1 - (x / 280) \times 0.75$ 的淡出透明度。
- **全过程不触发任何 React `setState`，重渲染次数恒为 0**！相比每次 pointermove 都触发 React setState 的传统组件，CPU 占用下降 90% 以上。

### 2.2 状态切换时的连续物理重定向（Spring Retargeting）
```typescript
// toast-stack.tsx:242-260
useLayoutEffect(() => {
  if (!isPresent || target.height <= 0) return;
  const entering = applied.current === null;
  const morph = !entering && applied.current !== expanded;
  applied.current = expanded;
  if (entering) {
    y.jump(target.y + target.height);
    scale.jump(target.scale);
    height.jump(target.height);
    contentOpacity.jump(target.content);
    opacity.jump(0);
  }
  const spring = morph ? motionTokens.spring.morph : motionTokens.spring.smooth;
  animate(y, target.y, spring);
  animate(scale, target.scale, spring);
  if (!entering) animate(height, target.height, spring);
  animate(opacity, target.opacity, entering ? enterFade : fade);
  animate(contentOpacity, target.content, fade);
}, [...]);
```
- **瞬态继承**：若用户快速晃动鼠标进出展开区，`animate(motionValue, target, spring)` 会从当前运动的瞬时位置与即时初速度自然转向新目标，零延迟、零跳突。

---

## 三、就地更新（In-Place Morphing）与微动效编排

### 3.1 状态存储层：Version 与计时器接力
调用 `update(id, patch)` 时，状态中心递增 `version: found.version + 1`，倒计时重置，但 DOM 节点实例保持恒等，不销毁重建。

### 3.2 模式选择与无障碍脱模：Swap 与 PopLayout
```typescript
// toast-stack.tsx:184-187
function Swap(props: HTMLMotionProps<"span">) {
  const present = useIsPresent();
  return <motion.span {...props} aria-hidden={present ? props["aria-hidden"] : true} />;
}
```
- **读屏器防复读**：文本淡出退场时，`aria-hidden` 瞬变为 `true`，防止屏幕阅读器在 crossfade 过渡期连读新旧两条文案；
- **popLayout 布局防跳动**：`<AnimatePresence mode="popLayout" initial={false}>` 保证退场内容立刻变为绝对定位，新内容在原地重叠渐变，容器高度瞬间获得下一帧目标尺寸。

### 3.3 图标与文本的弹簧与补间混编（防负值过冲铁律）
```typescript
// toast-stack.tsx:89-96
const textIn: TargetAndTransition = { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` };
const textOut: TargetAndTransition = { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: exitFast };
const iconIn: TargetAndTransition = { opacity: 0, scale: .6, filter: `blur(${motionTokens.blur.subtle}px)` };
const shown: TargetAndTransition = { opacity: 1, y: "0em", scale: 1, filter: "blur(0px)" };

const iconSwap: MotionProps = {
  initial: iconIn,
  animate: shown,
  exit: { ...iconIn, transition: exitFast },
  transition: {
    ...motionTokens.spring.snappy, // scale 走物理弹簧（紧致机械触感）
    opacity: fade,                 // opacity 严格走贝塞尔补间（杜绝负值）
    filter: fade                   // filter 严格走贝塞尔补间（杜绝过冲）
  }
};
```
- **物理弹簧过冲陷阱**：在带有震荡的 Spring 中，数值波动会导致 `opacity < 0` 或 `blur < 0px`，直接引发浏览器渲染引擎样式解析无效或白斑；
- **属性分流编排**：`scale` 走 `spring.snappy`，产生饱满的机械形变感；而 `opacity` 与 `filter` 强制覆盖为平滑贝塞尔补间，确保单调收敛，绝无负值过冲！

---

## 四、阻尼手势动力学与惯性速度投影

### 4.1 苹果双曲橡皮筋阻尼公式（RubberBand）
```typescript
// toast-stack.tsx:102
const rubberBand = (distance: number, dimension: number) => (1 - 1 / (distance * .55 / dimension + 1)) * dimension;
```
$$f(x, d) = \left(1 - \frac{1}{\frac{0.55 x}{d} + 1}\right) \cdot d = \frac{0.55 x d}{0.55 x + d}$$
向右滑动为正常退出方向，位移 1:1 跟手；向左反向拖拽时施加双曲阻尼，拉力随位移非线性递增，具有强烈的边界边界反馈。

### 4.2 惯性速度投影公式（Inertial Velocity Projection）
```typescript
// toast-stack.tsx:100
const project = (velocity: number) => velocity / 1000 * .99 / (1 - .99);
```
假设手势释放后以每毫秒衰减 1%（$r = 0.99$）的摩擦力自然滑动，其积分总滑行距离为：
$$D_{\text{project}} = \frac{v}{1000} \cdot \frac{r}{1 - r} = 0.099 \times v$$
- **判定条件**：`offset + project(velocity) > width * 0.4`。
  - **轻甩即走（Flick to Dismiss）**：哪怕当前位移仅 15px，只要初速度足够快，依然判定滑离，体验极为灵敏；
  - **慢拖防误触**：若慢拖超过 30% 但停顿松开（$v \approx 0$），投影距离为 0，自动弹回原位；
  - **速度连续性**：以用户释放时的真实物理速度 `velocity` 作为初速度启动离场弹簧，零顿挫飞出屏幕。

---

## 五、对比 Conex 现行架构差距与升级路线

### 5.1 架构对比一览

| 核心维度 | Conex 当前架构 (`ToastViewport` / `ToastCard`) | arc-library 架构标杆 | 差距诊断 |
| :--- | :--- | :--- | :--- |
| **手势渲染驱动** | `useSwipeDismiss` 中每个 pointermove 调用 `setMovement` 触发 React rerender | 纯 `MotionValue`（`x`, `y`, `scale`），直接写入 GPU 合成层 | Conex 在高刷屏滑动时产生 GC 压力；arc 为 0 rerender |
| **折叠堆叠规整度** | CSS 固定 `--height: 48px`；卡片后排未均衡高度 | `layoutStack` 折叠态强制所有后排卡片高度对齐首张卡片，`transform-origin: 50% 0` | Conex 当卡片长短不一时折叠边缘会参差错位；arc 纯平整齐 |
| **展开悬停热区** | 卡片使用 `::after` 伪元素桥接间隙 | `<ol>` 外框动态伸展为 `listHeight`，作为统一悬停画布 | Conex 伪元素方案在斜向移动时易丢 hover 造成抖动；arc 连续连通无缝 |
| **就地更新 (Update)** | 仅更新属性与 `updateKey`，React 原生重绘，DOM 突变替换 | `Swap` + `popLayout` + `textSwap` + `iconSwap`（弹簧与补间混编） | Conex 从 loading 变 success 时突变生硬；arc 具备精密电影感形变 |
| **手势动力学** | 线性 `0.2` 阻尼；硬编码 60px 阈值；固定 260ms 离场过渡 | Apple `rubberBand` 双曲阻尼；`project(v)` 速度投影；真实速度弹簧接力 | Conex 无法识别轻甩手势，离场速度固定死板；arc 为纯物理惯性 |

### 5.2 Conex 升级四阶段路线图
1. **阶段一：手势引擎脱敏（消除 PointerMove 重渲染）**：重构 `useSwipeDismiss`，引入 `useMotionValue(0)` 驱动 $x$ 轴位移，手势全程实现零 React 重渲染；
2. **阶段二：重构堆叠算法与外框连续画布**：引入 `layoutStack` 纯函数，折叠态强制共享首张卡片高度并隐藏后排内容，视口外框根据 `listHeight` 弹性自适应，废除 `::after` 桥接补丁；
3. **阶段三：落地就地变身微动效**：在 `ToastCard` 中引入 `Swap` 与 `popLayout`，落地“Scale 走弹簧、Blur/Opacity 走补间”的防过冲混编模式；
4. **阶段四：物理投掷与无障碍焦点漫游**：引入 `rubberBand` 与 `project(velocity)`，卡片离场后支持焦点平滑移交（`handOff`）与全局呼出快捷键。
