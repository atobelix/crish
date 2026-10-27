# 分维详案：MotionTokens 物理弹簧与 CSS 原生拟合架构分析

> **战役工作区**：`docs/arc-library-animation-study/`  
> **专题维度**：MotionTokens 物理力学参数、CSS 原生 37 点 linear() 拟合弹簧、交错步长编排、无障碍与 SSR 水合防闪机制  
> **权威对标参考**：`reference/arc-library/registry/motion-tokens.ts`、`reference/arc-library/registry/foundation.css`  
> **项目对齐标的**：`apps/crish-desktop/src/utils/motionTokens.ts`、`apps/crish-desktop/src/styles/tokens-base.css`、`apps/crish-desktop/src/styles/tokens.css`、`apps/crish-desktop/src/components/binary-tree/__tests__/tabStripMotionContract.test.ts`

---

## 一、物理弹簧体系：visualDuration 与 bounce: 0 的设计哲学

### 1.1 临界阻尼（Critically Damped, bounce: 0）消灭 Jitter 的物理机理
在经典阻尼谐振子力学模型中：
$$m \ddot{x} + c \dot{x} + k x = 0$$
固有角频率 $\omega_0 = \sqrt{k/m}$，阻尼比 $\zeta = \frac{c}{2\sqrt{km}}$。
- **欠阻尼态（$\zeta < 1$，即 `bounce > 0`）**：在位移达到目标值后会反复冲过平衡位置（Overshoot / 反弹），产生高频抖动（Jitter）。在桌面生产力工具（如 Conex）中，连续点击或快速切换时的抖动会严重干扰用户的眼球焦点聚焦，降低操作确定感；
- **过阻尼态（$\zeta > 1$）**：系统返回平衡位置所需时间变长，界面响应迟钝发粘；
- **临界阻尼态（$\zeta = 1$，即 `bounce: 0`）**：
  $$x(t) = 1 - (1 + \omega_0 t)e^{-\omega_0 t}$$
  **物理学定理证明：临界阻尼是在保证严格单调、绝不发生任何超调（Zero Overshoot, No Jitter）的前提下，系统收敛到平衡位置所需时间最短的帕累托（Pareto）最优物理状态！**
  arc-library 全体系将 `bounce: 0` 设为物理铁律，使所有元素停稳干脆利落。

### 1.2 visualDuration 参数的革命性
传统物理弹簧要求配置 `stiffness`（刚度）和 `damping`（阻尼），存在重大缺陷：时长不可控、无法直观推断动画何时彻底静止。`visualDuration` 直观定义了**人眼视觉上可感知的运动完成时长**（达到目标值 99% 的时间）。结合 `bounce: 0`，既能精准掌控 UI 编排的时序节拍，又拥有物理世界真实的加速度。

### 1.3 物理动量连续性：中途打断连续速度重靶向
在 `reference/arc-library/registry/components/confirm-morph/confirm-morph.tsx:82-86` 中：
```typescript
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
```
将 `visualDuration` 与 `bounce` 映射为力学质量方程的 `stiffness` 与 `damping` 后，动画飞行中途遭到用户二次操作时，求解器会直接继承当前微元时刻的瞬时速度向量 $v_0 \neq 0$，实现真正的**速度连续性平滑重靶向**。

### 1.4 三级物理弹簧定位体系（`motion-tokens.ts:11-20`）
| 弹簧 Token | 核心参数配置 | 设计哲学与落地场景 | 典型组件引用 |
| :--- | :--- | :--- | :--- |
| **`snappy`** | `visualDuration: 0.26s`<br>`bounce: 0` | **极速响应、微交互专用**：极快收敛，杜绝任何抖动，呈现精密机械按键般的紧实触感。用于按钮按下、开关滑块滑动、箭头翻转。 | `switch.tsx:21`<br>`accordion.tsx:46` |
| **`smooth`** | `visualDuration: 0.40s`<br>`bounce: 0` | **平滑舒展、结构重排专用**：大尺寸几何变化的临界阻尼过渡。专为抽屉、面板高度变化、模态框滑入而设。 | `accordion.tsx:27-31`<br>`tabs.tsx:97` |
| **`morph`** | `visualDuration: 0.42s`<br>`bounce: 0` | **形状形变、共享布局流动专用**：用于尺寸随新内容动态形变、Tab 高亮块在不同项之间滑动。不反弹确保尺寸与原生 DOM flow 无缝对接。 | `tabs.tsx:90`<br>`text-morph.tsx:46` |

---

## 二、CSS 原生高性能弹簧：`foundation.css` 中 `--ease-spring: linear(...)` 拟合机理

### 2.1 37 个离散插值点的数学特征解剖
在 `reference/arc-library/registry/foundation.css:78-79` 中：
```css
/* Critically damped spring: fast start, smooth settle, never overshoots (no jitter). Pair with --duration-spring for transform transitions. */
--ease-spring: linear(0, 0.0213, 0.0739, 0.1443, 0.2235, 0.305, 0.3849, 0.4606, 0.5305, 0.594, 0.6508, 0.7011, 0.7452, 0.7836, 0.8168, 0.8454, 0.8699, 0.8907, 0.9084, 0.9234, 0.9361, 0.9467, 0.9557, 0.9632, 0.9694, 0.9747, 0.979, 0.9826, 0.9857, 0.9882, 0.9902, 0.992, 0.9934, 0.9946, 0.9955, 0.9963, 1);
--duration-spring: 580ms;
```
1. **严格单调性（Strict Monotonicity）**：
   $\forall i \in [1, 36], y_i > y_{i-1}$，且 $\max(y) = 1.0000$。曲线从未出现 $> 1.0$ 的过冲，完全符合临界阻尼无回弹特征；
2. **极速爆发起步（Explosive Acceleration）**：
   在 $t = 16.7\%$（第 6 步）处位移已达 38.5%；在 $t = 50\%$ 处位移已达 90.84%，体现了物理弹簧在初始拉伸力最大时的迅猛加速度，提供即时响应感；
3. **指数衰减长尾贴合（Exponential Decay Tail）**：
   后半程 50% 的时间专门用于消化最后 9% 的位移，以极微弱的斜率自然滑行至目标。

### 2.2 为什么 cubic-bezier 无法做到？
标准 `cubic-bezier` 仅有 2 个控制点，无法同时表达**极高的初始斜率**与**持续极长的临界阻尼渐近尾部**；若拉大控制点模拟初始爆发，中后段必然减速过猛产生“撞墙感”。CSS `linear(...)` 分段线性插值在 120Hz/144Hz 屏幕上被肉眼感知为极其圆润高质感的物理弹簧曲线。

### 2.3 零 JS 开销与 Compositor 线程加速
在 Conex 桌面端高负载场景（LLM 流式接收、Markdown AST 解析、代码 Diff 计算）下，主线程易出现微小阻塞。纯 CSS 弹簧指令直接交由浏览器 Compositor 线程在 GPU 内部计算执行。即使主线程暂时卡死，UI 的弹簧过渡依然能够保持满帧运行。

---

## 三、交错步长规范与无障碍防闪烁机制

### 3.1 四级交错步长与 0.4s 熔断上限（Stagger Hierarchy）
```typescript
stagger: { char: 0.016, word: 0.04, line: 0.08, item: 0.035 }
```
1. **`char: 16ms`**：对应 60Hz 的 1 个物理帧，专用于字符展开；
2. **`word: 40ms`**：专用于短语自然语言涌现，与眼球扫视跳跃（saccade）同频；
3. **`item: 35ms`**：专用于选项卡、菜单行、卡片列表入场；
4. **`line: 80ms`**：专用于多行段落升起；
5. **熔断上限原则（Max Stagger Cap Rule）**：
   ```typescript
   const MAX_STAGGER = motionTokens.duration.considered; // 0.48s
   const step = Math.min(motionTokens.stagger.word, MAX_STAGGER / Math.max(count, 1));
   ```
   **铁律**：严禁无上限线性递增！若有 30 个单词，算法自动动态压缩步长，保证整个交错入场总体耗时硬性锁定在 0.4s–0.48s 之内。

### 3.2 `useReducedFlag` 的 SSR 水合防闪机制
```typescript
const subscribe = () => () => {};
export function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}
```
1. **SSR 与客户端首帧**：`hydrated === false`，两端渲染结果 100% 字节级对齐，绝对杜绝 React Hydration Mismatch；
2. **水合后同步切入**：挂载完成后同步获取系统真实无障碍偏好，零延迟、零闪变。

---

## 四、兼顾 Conex 既有单源测试守卫契约的升级方案

Conex 的 `apps/crish-desktop/src/components/binary-tree/__tests__/tabStripMotionContract.test.ts` (L101–114) 严格锁定了测试断言：
```typescript
expect(tokensCss).toContain('--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)');
expect(tokensCss).toContain('--ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1)');
expect(tokensCss).toContain('--duration-micro: 100ms');
expect(tokensCss).toContain('--duration-fast: 150ms');
expect(motionTs).toContain("'cubic-bezier(0.4, 0, 0.2, 1)'");
expect(motionTs).toContain('DURATION_MICRO_MS = 100');
```
**铁律契约底线**：既有键值与字面量**绝对禁止删除或更名**！升级必须采用**超集追加（Additive Superset）**模式。

### 4.1 第一阶段：CSS 层扩展（`tokens-base.css`）
追加原生线性弹簧与交错规范：
```css
  /* ── 临界阻尼物理弹簧（零 JS 开销，Compositor 线程加速，无反弹抖动） ── */
  --ease-spring: linear(0, 0.0213, 0.0739, 0.1443, 0.2235, 0.305, 0.3849, 0.4606, 0.5305, 0.594, 0.6508, 0.7011, 0.7452, 0.7836, 0.8168, 0.8454, 0.8699, 0.8907, 0.9084, 0.9234, 0.9361, 0.9467, 0.9557, 0.9632, 0.9694, 0.9747, 0.979, 0.9826, 0.9857, 0.9882, 0.9902, 0.992, 0.9934, 0.9946, 0.9955, 0.9963, 1);
  --duration-spring-snappy: 260ms;
  --duration-spring-smooth: 400ms;
  --duration-spring-morph: 420ms;
  --duration-spring: 580ms;

  --transition-spring-snappy: var(--duration-spring-snappy) var(--ease-spring);
  --transition-spring-smooth: var(--duration-spring-smooth) var(--ease-spring);
  --transition-spring-morph: var(--duration-spring-morph) var(--ease-spring);
  --transition-spring: var(--duration-spring) var(--ease-spring);

  --stagger-char: 16ms;
  --stagger-item: 35ms;
  --stagger-word: 40ms;
  --stagger-line: 80ms;
  --stagger-max: 400ms;

  --blur-subtle: 2px;
  --blur-soft: 4px;
  --blur-text: 8px;
```

### 4.2 第二阶段：TS 镜像层扩展（`motionTokens.ts`）
```typescript
export const EASE_SPRING_LINEAR =
  'linear(0, 0.0213, 0.0739, 0.1443, 0.2235, 0.305, 0.3849, 0.4606, 0.5305, 0.594, 0.6508, 0.7011, 0.7452, 0.7836, 0.8168, 0.8454, 0.8699, 0.8907, 0.9084, 0.9234, 0.9361, 0.9467, 0.9557, 0.9632, 0.9694, 0.9747, 0.979, 0.9826, 0.9857, 0.9882, 0.9902, 0.992, 0.9934, 0.9946, 0.9955, 0.9963, 1)';

export const DURATION_SPRING_SNAPPY_MS = 260;
export const DURATION_SPRING_SMOOTH_MS = 400;
export const DURATION_SPRING_MORPH_MS = 420;
export const DURATION_SPRING_MS = 580;

export const MOTION_SPRING = {
  snappy: { type: 'spring', visualDuration: 0.26, bounce: 0 },
  smooth: { type: 'spring', visualDuration: 0.4, bounce: 0 },
  morph: { type: 'spring', visualDuration: 0.42, bounce: 0 },
  responsive: { type: 'spring', stiffness: 520, damping: 44 },
  gentle: { type: 'spring', stiffness: 340, damping: 34 },
} as const;

export const MOTION_STAGGER = {
  char: 0.016,
  item: 0.035,
  word: 0.04,
  line: 0.08,
  maxTotal: 0.4,
} as const;

export const MOTION_BLUR = {
  subtle: 2,
  soft: 4,
  text: 8,
} as const;
```

### 4.3 关键场景落地指引
1. **标签条指示器（TabStrip）**：使用 `MOTION_SPRING.morph`，使胶囊滑动严丝合缝；
2. **面板展开（Accordion）**：高度展开引入纯 CSS `--transition-spring-smooth`，消除硬刹车；
3. **按钮与开关（Switch & ActionButton）**：引入 `--transition-spring-snappy`，赋予紧致机械触感。
