# Toast 3D 层叠展开与手势状态机深度改进方案 (Modern Native Toast Center v2.0)

> **方案定位**：基于 `docs/ui-component-modernization/audits/04-Toast3D层叠展开与手势状态机严苛审查.md` 与 `docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md` 审查结论的专项整改与架构重构详案。  
> **基准规范**：`AGENTS.md` (§13 焦点环规范、§14 暖灰墨阶与色彩空间、RL-03 行数与反过度设计红线)、`reference/appica-ui/` 物理动效解构、纯原生 React 18+ 与 CSS Modules（100% 零外部 npm 组件库依赖）。  
> **实施目标仓**：`apps/crish-desktop/src/services/toast/` 与 `apps/crish-desktop/src/components/overlay/`  
> **编码格式**：UTF-8 无 BOM

---

## 目录
1. [执行摘要与问题矩阵](#1-执行摘要与问题矩阵)
2. [Store 与异步状态机重构方案](#2-store-与异步状态机重构方案)
   - 2.1 ReactNode 消息与复杂 JSX 解耦机制（修复 BUG-01）
   - 2.2 防御性 `toast.promise` 异步状态机（修复 BUG-05 异常崩溃）
   - 2.3 满队列原子原地更新与 FIFO 隔离（修复 BUG-05 误杀老通知）
   - 2.4 上下文与 Store 单一订阅链路治理（修复 BUG-08 双重订阅）
3. [3D 层叠与扇形展开物理测量引擎升级](#3-3d-层叠与扇形展开物理测量引擎升级)
   - 3.1 内部 Body 独立测量架构与防抖（修复 BUG-02 测量截断与卡片碰撞）
   - 3.2 固化 `onDismiss` 引用与 PausableTimer 单向时钟（修复 BUG-03 定时器漂移）
   - 3.3 折叠态 Hover Bridge 隔离与深层卡片裁切（修复 BUG-09）
   - 3.4 WebView2 居中亚像素文字抗锯齿与 2px 发丝边框补偿（修复 BUG-10）
4. [手势动力学与双向滑动消除状态机](#4-手势动力学与双向滑动消除状态机)
   - 4.1 10px 拖拽死区门禁与单一 `pointerId` 锁定（修复 BUG-04）
   - 4.2 顶部锚定通知的向上滑动消除与飞入退场对偶动效（修复 BUG-06）
   - 4.3 释放瞬时速率（Flick）与动量飞离判定方程
5. [全键盘无障碍与焦点保护体系 (A11y)](#5-全键盘无障碍与焦点保护体系-a11y)
   - 5.1 `ToastViewport` 焦点捕获驱动扇形展开与时钟冻结（修复 BUG-07）
   - 5.2 WAI-ARIA 语义角色与状态消歧（`role="alert"` vs `role="status"`）
   - 5.3 符合 AGENTS.md §13 的柔和焦点环系统
6. [Design Tokens 100% 纯净化与 Zero-Blue 规范](#6-design-tokens-100-纯净化与-zero-blue-规范)
   - 6.1 26 处硬编码 HEX 清零清洗清单
   - 6.2 JSX 内联样式清零与 CSS Modules 类名收敛
7. [核心模块重构源码详案](#7-核心模块重构源码详案)
   - 7.1 `types.ts`
   - 7.2 `ToastStore.ts`
   - 7.3 `ToastContext.tsx`
   - 7.4 `useToastStackMeasurement.ts`
   - 7.5 `useSwipeDismiss.ts`
   - 7.6 `ToastViewport.tsx`
   - 7.7 `ToastCard.tsx`
   - 7.8 `ToastStackModern.module.css`
8. [单元测试与验证用例矩阵](#8-单元测试与验证用例矩阵)
9. [实施演进与风险检查清单](#9-实施演进与风险检查清单)

---

## 1. 执行摘要与问题矩阵

在第一阶段的 3D 层叠 Toast 探索中，系统确立了基于 CSS 变量计算三维层叠的数学模型。但在严苛审查与集成测试中，暴露出 **10 项深层次的技术断层与物理缺陷**。本方案旨在逐项推导极致的数学与工程解法，产出可以直接指导重构的生产级设计。

### 缺陷与改进映射矩阵

| 审计缺陷编号 | 缺陷严重度 | 根因分类 | 改进方案核心策略 |
| :--- | :--- | :--- | :--- |
| **BUG-01** | **致命** | 消息载荷类型破坏 | 在 `ToastStore` 解耦纯文本策略门禁与 ReactNode 载荷，JSX 组件与 Promise 通知无条件放行渲染 |
| **BUG-02** | **致命** | 测量时机与 CSS 冲突 | 在卡片内部引入不受高度限制的 `[data-toast-body]` 测量容器，初始挂载即时计算自然高度，杜绝展开中途二次测量碰撞 |
| **BUG-03** | **致命** | 定时器与 Hook 依赖链 | 视口固化 `onDismiss` 引用；`ToastCard` 内部设立受控 PausableTimer 状态机，切断组件 Re-render 对毫秒时钟的污染 |
| **BUG-04** | **严重** | 手势无死区与多点触控漂移 | 引入 10px 拖拽死区门禁；绑定单一 `activePointerId` 锁，Pointer Capture 严格成对释放 |
| **BUG-05** | **严重** | 满队更新误淘汰与异常崩溃 | 原地更新 ID 时跳过 `trimToastQueue` 淘汰逻辑；在 `toast.promise` 注入统一的非 Error rejection 安全解构器 |
| **BUG-06** | **严重** | 顶部锚定物理脱节 | 依据 `position` 动态注入 `allowedAxes`（顶部通知允许 `['up', 'right', 'left']`）；CSS 补充 `@keyframes toastEnterTop` 与顶部退出动效 |
| **BUG-07** | **严重** | 键盘 Tab 无法展开与语义冲突 | `ToastViewport` 增加 `onFocusCapture`/`onBlurCapture`，Tab 进入自动展开并暂停时钟；区分 `role="alert"` 与 `role="status"` |
| **BUG-08** | **一般** | 双重订阅与静态 Fallback | 统一收口 Store 订阅至 `ToastViewport` 单一节点；`fallbackToastContext.toasts` 采用实时 getter 获取 |
| **BUG-09** | **一般** | Hover Bridge 溢出与深层毛边 | 折叠态完全禁用 Hover Bridge 伪元素捕获；折叠态将 `index >= 3` 的底层卡片 `opacity: 0` 裁切；进度条由 React 状态单源受控 |
| **BUG-10** | **微小** | 亚像素文字发虚与边框补偿 | 居中 Viewport 改用 `left: calc(50% - 190px); transform: none;`；测量补充 2px 边框补偿；焦点环补齐 §13 规范 Fallback |

---

## 2. Store 与异步状态机重构方案

### 2.1 ReactNode 消息与复杂 JSX 解耦机制（修复 BUG-01）

#### 根因解构
原有 `ToastStore.ts` 将所有 `message` 通过 `typeof message === 'string' ? message : ''` 降级为空字符串传入 `enqueueToast`。由于底层 `toastQueueLogic.ts` 具有严格的防空串门禁 `normalizeToastMessage('') -> '' -> 'drop-empty'`，导致所有传入自定义 JSX（如 `<div className="flex items-center">...</div>`）的通知均被误判为空并直接静默丢弃。

#### 改进设计
建立「纯文本策略拦截」与「富媒体 ReactNode 渲染」双轨机制：
1. **纯文本路径**：若 `typeof message === 'string'` 且未显式指定 `options.type` / `options.onUndo`，执行严格的 `toastQueueLogic` 成功文案防刷屏过滤与空串拦截；
2. **富媒体与显式指令路径**：若 `React.isValidElement(message)`、`typeof message === 'object'` 或显式指定了 `options.type`（如 `success`, `error`, `loading`），则直接放行入队，保留完整的 ReactNode 结构传递给 `ToastCard`。

```
[调用入口 toast.show(msg, opts)]
          │
          ├── isStringMsg ?
          │      ├── 是 ──> 校验空串 / 检查防刷屏规则 (toastQueueLogic) ──> 放行 / 丢弃
          │      └── 否 (JSX / Element / Function) ──> 判定为有效富媒体 ──> 直接放行入队
          │
          └── 生成 AppToast { id, message, type, ... } ──> 广播至 Viewport
```

---

### 2.2 防御性 `toast.promise` 异步状态机（修复 BUG-05 异常崩溃）

#### 根因解构
在 JavaScript/TypeScript 运行时中，`Promise.reject()` 允许抛出任意值（如 `Promise.reject(null)`、`Promise.reject('Network Timeout')`、`Promise.reject({ status: 502 })`）。当使用者提供错误格式化回调 `messages.error: (err) => `失败: ${err.message}`` 时，如果 `err` 不是标准 `Error` 实例，会直接抛出 `Uncaught TypeError: Cannot read properties of null (reading 'message')`，导致整个 Promise 链路崩溃且无法向用户展示错误 Toast。

#### 改进设计
引入健壮的异常消息提取工具函数 `safeResolveErrorMessage`：

```typescript
export function safeResolveErrorMessage(
  err: unknown,
  fallback: React.ReactNode | ((err: unknown) => React.ReactNode)
): React.ReactNode {
  // 1. 如果调用方传入的是函数，执行安全调用保护
  if (typeof fallback === 'function') {
    try {
      const result = fallback(err);
      if (result) return result;
    } catch {
      // 容错降级
    }
  } else if (fallback) {
    return fallback;
  }

  // 2. 自动从错误载荷中提取可读信息
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim().length > 0) {
    return err.trim();
  }
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message) return record.message;
    if (typeof record.error === 'string' && record.error) return record.error;
  }

  return '操作执行异常，请重试';
}
```

在 `ToastStore.promise` 中，状态流转包含：
1. **Pending 阶段**：发射 `type: 'loading'`, `duration: Infinity` 的通知，保留返回的稳定 `id`；
2. **Fulfilled 阶段**：捕获决议数据 `data`，调用 `safeResolveSuccessMessage(data, messages.success)`，原地原子更新该 `id`，重置 `duration: TOAST_TTL_MS` 并更新 `updateKey`；
3. **Rejected 阶段**：捕获异常 `err`，调用 `safeResolveErrorMessage(err, messages.error)`，原地原子更新该 `id` 为 `type: 'error'`，重置 `duration: TOAST_TTL_MS` 并更新 `updateKey`，最后再次 re-throw 保证调用链感知。

---

### 2.3 满队列原子原地更新与 FIFO 隔离（修复 BUG-05 误杀老通知）

#### 根因解构
当当前活跃通知数达到上限 `TOAST_MAX_QUEUE = 5` 时，调用 `toast.promise` 会将一条 loading 通知压入队首，最旧通知被正常挤出。当 Promise 决议并尝试使用相同的 `id` 更新通知内容时，旧版 `ToastStore.show` 重新调用了 `enqueueToast`，底层 `enqueueToast` 认为这是一条新消息，再次触发 `trimToastQueue` 挤掉了队列末尾的另一条无关合法通知，同时将更新项按新 ID 过滤，导致队列总数异常缩减至 4 条。

#### 改进设计
在 `ToastStore.show` 入口建立「更新 vs 入队」的严格分支：

```typescript
const isExistingToast = Boolean(options?.id && this.toasts.some((t) => t.id === options.id));

if (isExistingToast) {
  // 原地原子更新模式：完全绕过 trimToastQueue 与 FIFO 淘汰
  this.toasts = this.toasts.map((item) => {
    if (item.id !== options!.id) return item;
    return {
      ...item,
      ...newToastData,
      id: item.id, // 锁定原始 ID
      timestamp: Date.now(),
      updateKey: Date.now(), // 驱动进度条与倒计时重启
    };
  });
} else {
  // 新消息入队模式：遵循策略门禁与 FIFO 淘汰截断
  const maxQueue = options?.maxQueue ?? TOAST_MAX_QUEUE;
  this.toasts = [newToast, ...this.toasts.filter((t) => t.id !== id && !result.evictedIds.includes(t.id))].slice(0, maxQueue);
}
```

---

### 2.4 上下文与 Store 单一订阅链路治理（修复 BUG-08 双重订阅）

#### 根因解构
`ToastProvider` 与 `ToastViewport` 两处均声明了 `useSyncExternalStore(ToastStore.subscribe, ToastStore.getToasts)`。当 Store 数据变动时，React 树外层的 Provider 先触发调度，随后将其内部作为 prop 传递给 Viewport；但 Viewport 自身也订阅了同一个 Store，导致 React 内部发生双重重绘链路。同时 `fallbackToastContext` 的 `toasts: []` 是死数组，未包裹 Provider 时无法读取 Store。

#### 改进设计
1. **单一订阅收敛**：`ToastProvider` 不再通过 `useSyncExternalStore` 订阅 `toasts` 状态，只作为轻量的方法广播器；
2. **视口直接消费**：`ToastViewport` 作为唯一的 `useSyncExternalStore` 订阅端，若有传入 `propToasts` 则优先使用，否则直连 Store；
3. **Fallback 响应式 Getter**：在 `fallbackToastContext` 中，使用 ES6 Getter `get toasts() { return ToastStore.getToasts(); }`，确保在任何沙箱环境下均能实时拿到最新快照。

---

## 3. 3D 层叠与扇形展开物理测量引擎升级

### 3.1 内部 Body 独立测量架构与防抖（修复 BUG-02）

#### 根因物理剖析
在 3D 堆叠态下，第 1 张卡片（$i=0$）之后的卡片由于 CSS 声明了 `height: var(--height)`（其中 `--height: 56px`），其外层 DOM 的物理 `offsetHeight` 与 `getBoundingClientRect().height` 被强制裁剪为 56px。  
当使用 `ResizeObserver` 观察外层卡片时，采集到的是假高度 56px；当用户悬停展开时，CSS 高度释放，卡片向真实高度（如 128px）膨胀，`ResizeObserver` 在过渡动画中途（约 200ms）异步触发并更新 offset，造成剧烈的纵向跳变（Layout Thrashing）与卡片穿模。

#### 极致修复方案：内部 Body 隔离测量
```
┌────────────────────────────────────────────────────────┐
│ .toastCard (受 CSS 3D 变换控制, 堆叠态 height: 56px, 展开态 height: auto) │
│                                                        │
│   ┌──────────────────────────────────────────────────┐ │
│   │ .cardBody [data-toast-body="true"]               │ │
│   │ (自然流式布局，不受 height 约束，始终反映内容全高) │ │
│   │ -> ResizeObserver 严格只监听此内部元素            │ │
│   └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

1. 在 `ToastCard.tsx` 中，外层节点声明 `ref={setCardRef}`，内部容器声明 `<div className={styles.cardBody} data-toast-body="true" ref={setBodyRef}>`；
2. `useToastStackMeasurement` 的 `registerNode` 注册内部 body 节点：
   - 挂载第一帧同步读取：`const realHeight = Math.ceil(bodyEl.scrollHeight || bodyEl.offsetHeight) + 2;`（$+2\text{px}$ 补偿上/下各 1px 的发丝边框）；
   - 即刻同步更新内部 heights 字典并触发单次状态同步，确保首帧展开偏移量即为物理真实值；
3. `ResizeObserver` 仅监听 `data-toast-body="true"` 的子节点，当文字折行或动态 Action 出现时精确捕捉并更新。

---

### 3.2 固化 `onDismiss` 引用与 PausableTimer 单向时钟（修复 BUG-03）

#### 根因依赖链路打碎
旧实现中：
```
ToastViewport 每次 Render -> 生成匿名函数 onDismiss: () => handleDismiss(item.id)
  -> ToastCard 接收到新 onDismiss 引用
    -> handleDismissAnimation 重新生成
      -> 倒计时 useEffect 触发清理函数并重启定时器
        -> remainingTimeRef 被截断扣除
          -> 频繁微动导致 5000ms 倒计时在 1.5s 内归零误关闭！
```

#### 改进设计：斩断重绘链路的受控单向时钟
1. **稳定派发层**：`ToastViewport` 声明稳定的 `handleDismiss = useCallback((id: string) => { ToastStore.dismiss(id); }, [])`；
2. **引用固化层**：在 `ToastCard` 中，使用 `const onDismissRef = useRef(onDismiss); onDismissRef.current = onDismiss;`；
3. **PausableTimer 状态机**：
   - 维护 `remainingMsRef = useRef(toast.duration)`；
   - 维护 `startTimeRef = useRef<number | null>(null)`；
   - 仅当 `[toast.id, toast.duration, toast.updateKey, isExpandedActive]` 发生实质变动时才参与时钟判定：
     - 当 `isExpandedActive === true`（鼠标悬停或键盘聚焦）：
       - 若 `startTimeRef.current !== null`，计算已走过的流逝时间 $\Delta t = \text{now}() - \text{startTimeRef.current}$；
       - 扣减剩余时间：`remainingMsRef.current = Math.max(0, remainingMsRef.current - \Delta t)`；
       - 清除底层 `setTimeout` 并置空 `startTimeRef.current = null`；
     - 当 `isExpandedActive === false`（移出或失焦）：
       - 记录启动时刻 `startTimeRef.current = performance.now()`；
       - 启动 `setTimeout(triggerDismissAnimation, remainingMsRef.current)`；
4. **清理防泄露**：在组件卸载或 `triggerDismissAnimation` 触发时，执行 `clearTimeout`，并在 CSS 退出动效（260ms）结束后安全执行 `onDismissRef.current()`。

---

### 3.3 折叠态 Hover Bridge 隔离与深层卡片裁切（修复 BUG-09）

#### Hover Bridge 边界控制
`ToastCard::after` 伪元素的作用是在展开态填补卡片之间 12px 的 gap，防止光标在卡片间隙移动时丢失 hover。但是在折叠态（`data-expanded="false"`）下，最底部卡片下方的 14px 伪元素会溢出到正常内容区，导致误触展开。

**样式整改规则**：
```css
/* 仅在展开态或非首张卡片时激活 Hover Bridge */
.toastCard::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: calc(var(--gap, 12px) + 2px);
  pointer-events: none; /* 默认禁用 */
}

.viewport[data-expanded='true'] .toastCard::after {
  pointer-events: auto; /* 展开态启用 */
}
```

#### 深层卡片（Depth ≥ 3）物理隐藏
在堆叠态下，当并发通知达到 4 或 5 条时，第 4、5 条卡片缩放至 0.7、0.6，且露出发丝边框，造成视觉杂乱。
**样式整改规则**：
```css
/* 折叠态下隐藏第 4 张及更深的卡片 */
.viewport:not([data-expanded='true']) .toastCard[data-stack-depth='deep'] {
  opacity: 0 !important;
  pointer-events: none !important;
  transform: translateY(0) scale(0.7) !important;
}
```
在 `ToastCard.tsx` 中根据 `index >= 3` 标记 `data-stack-depth="deep"`。

---

### 3.4 WebView2 居中亚像素文字抗锯齿与 2px 发丝边框补偿（修复 BUG-10）

1. **居中计算消除 Transform**：
   原有 `.viewportBottomCenter` 使用 `left: 50%; transform: translateX(-50%)`，叠加卡片的 `transform: translateY(...) scale(...)` 后在 Windows WebView2 / 偶数分辨率屏上造成文本模糊。  
   **改进为**：
   ```css
   .viewportBottomCenter {
     bottom: 16px;
     left: calc(50% - 190px); /* 视口宽度 380px 的绝对居中 */
     transform: none;
   }
   .viewportTopCenter {
     top: 16px;
     left: calc(50% - 190px);
     transform: none;
   }
   ```
2. **2px 发丝边框补偿**：
   在计算 `--toast-height` 时：`const realHeight = (bodyEl.scrollHeight || 54) + 2;`，精准匹配 `box-sizing: border-box` 下的上 1px + 下 1px 边框。

---

## 4. 手势动力学与双向滑动消除状态机

### 4.1 10px 拖拽死区门禁与单一 `pointerId` 锁定（修复 BUG-04）

#### 状态机模型设计
```
[Pointer Down] ──> 记录 startPos(x, y, time, pointerId)
                         │ (处于 Idle 状态, swiping=false, 不捕获 Pointer)
                         ▼
[Pointer Move] ──> 计算 distance = Math.hypot(dx, dy)
                         │
                         ├── distance < 10px ──> [死区拦截, 保持原生 Click 交互]
                         │
                         └── distance >= 10px ──> [激活拖拽状态]
                                                     │- setSwiping(true)
                                                     │- setPointerCapture(pointerId)
                                                     └- 实时应用弹性阻尼位移
                         ▼
[Pointer Up / Cancel] ──> 校验 pointerId ──> 释放 PointerCapture
                                               │
                                               ├── 满足消除阈值 ──> 触发飞离动画 & onDismiss
                                               └── 未达阈值 ──> 弹性归位 (平滑恢复 transition)
```

#### 核心代码约束
1. **单一 Pointer 锁定**：使用 `activePointerIdRef = useRef<number | null>(null)`，当已有触点在交互时，后续触点直接忽略；
2. **交互元素穿透阻断**：若 `(e.target as HTMLElement).closest('button, a, input, textarea, select')`，不激活滑动；
3. **10px 物理死区**：只有总位移 $\sqrt{\Delta x^2 + \Delta y^2} \ge 10\text{px}$ 时，才将 `swiping` 置为 `true` 并调用 `setPointerCapture`。彻底避免鼠标普通点击时因 `transition: none` 导致的视觉顿挫，以及微小抖动误触发消除。

---

### 4.2 顶部锚定通知的向上滑动消除与飞入退场对偶动效（修复 BUG-06）

#### 几何与手势对偶性

| 属性 / 行为 | 底部锚定 (`position="bottom-*"`) | 顶部锚定 (`position="top-*"`) |
| :--- | :--- | :--- |
| **手势消除允许轴向** | `allowedAxes = ['down', 'right', 'left']` | `allowedAxes = ['up', 'right', 'left']` |
| **向上拖拽阻尼系数** | $0.2$ (阻尼抵抗) | $1.0$ (自由滑动消除) |
| **向下拖拽阻尼系数** | $1.0$ (自由滑动消除) | $0.2$ (阻尼抵抗) |
| **入场动画关键帧** | `@keyframes toastEnterBottom` (自下方 $+120\%$ 飞入) | `@keyframes toastEnterTop` (自上方 $-120\%$ 飞入) |
| **退场动画变换** | `transform: translateY(100%) scale(0.92)` | `transform: translateY(-100%) scale(0.92)` |
| **手势飞离终态** | `translateY(calc(var(--swipe-y) + 120px))` | `translateY(calc(var(--swipe-y) - 120px))` |

---

### 4.3 释放瞬时速率（Flick）与动量飞离判定方程

在 `onPointerUp` 触发时，结合绝对位移量与瞬时速度进行综合决议：

$$\text{isDismissed} = (\Delta_{\text{axis}} \ge \text{Threshold}) \lor (\Delta_{\text{axis}} \ge \text{MinDistance} \land v_{\text{axis}} \ge 0.45\text{px/ms})$$

其中：
- $\text{Threshold} = 60\text{px}$（标准拖拽消除距离）；
- $\text{MinDistance} = 25\text{px}$（防手抖最小滑动位移门槛）；
- $v = \frac{\Delta}{\Delta t}$（单位毫秒位移速率）；
- 方向必须严格匹配 `allowedAxes` 集合。

---

## 5. 全键盘无障碍与焦点保护体系 (A11y)

### 5.1 `ToastViewport` 焦点捕获驱动扇形展开与时钟冻结（修复 BUG-07）

#### WCAG 2.1 SC 2.2.1 (Timing Adjustable) 合规方案
当视障用户或键盘高频操作者使用 `Tab` 键漫游到 Toast 的「撤销」或「操作」按钮时：
1. **焦点展开联动**：`ToastViewport` 监听 `onFocusCapture` 与 `onBlurCapture`。一旦焦点进入任何卡片内部，立即将 `isFocused` 置为 `true`；
2. **视口状态同步**：`isExpandedActive = expanded || isFocused`。只要获得焦点，所有卡片立刻以 3D 扇形展开，解除高度裁剪与层叠遮挡；
3. **时钟绝对冻结**：所有卡片的倒计时定时器与进度条在焦点停留期间彻底暂停，**绝对防止通知在用户操作中途自动销毁导致焦点丢失（Focus Loss）**；
4. **安全失焦恢复**：当 `onBlurCapture` 检测到 `!e.currentTarget.contains(e.relatedTarget)` 时，`isFocused` 恢复为 `false`，若无鼠标悬停则恢复折叠与计时。

---

### 5.2 WAI-ARIA 语义角色与状态消歧

根据 W3C WAI-ARIA APG 规范：
- `role="status"`：隐含 `aria-live="polite"`，用于非侵入式提示（如 `info`, `success`, `warning`, `loading`）；
- `role="alert"`：必须配合 `aria-live="assertive"`，用于阻断性或严重错误提示（如 `error`）。

**代码整改**：
```tsx
const roleAttr = toast.type === 'error' ? 'alert' : 'status';
const liveAttr = toast.ariaLive ?? (toast.type === 'error' ? 'assertive' : 'polite');

<div
  role={roleAttr}
  aria-live={liveAttr}
  aria-atomic="true"
  ...
>
```

---

### 5.3 符合 AGENTS.md §13 的柔和焦点环系统

严禁使用浏览器的默认粗黑外边框。所有交互按钮（`undoButton`, `actionButton`, `closeButton`）的 `:focus-visible` 统一遵循以下半透明柔和灰色 / 品牌色规范：

```css
.closeButton:focus-visible,
.actionButton:focus-visible,
.undoButton:focus-visible {
  outline: none;
  box-shadow: var(
    --focus-ring,
    0 0 0 2px color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 35%, transparent)
  );
}
```

---

## 6. Design Tokens 100% 纯净化与 Zero-Blue 规范

### 6.1 26 处硬编码 HEX 清零清洗清单

依据 `docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`，对 `ToastStackModern.module.css` 中的所有 HEX 违规点执行 100% 清洗：

| 原代码位置 | 违规硬编码 HEX | 修复后标准 Design Token / 色彩空间 | 业务语义 |
| :--- | :--- | :--- | :--- |
| 行 76 | `#ffffff` | `var(--bg-card, hsl(0 0% 100%))` | 纯白卡底底板 |
| 行 77, 312, 318, 364, 375, 386, 405 | `#111111` | `var(--text-primary)` | 主文字暖灰墨阶 |
| 行 78 | `#e1e4e8` / `#35 8% 91%` | `var(--hairline, var(--border-subtle, hsl(35 8% 91%)))` | 极细发丝边框 |
| 行 86, 87, 123, 140, 141, 150 | `#000` | `var(--shadow-color, hsl(0 0% 0%))` | 投影基色 |
| 行 229 | `hsl(160 84% 31%)` | `var(--brand-deep, hsl(160 84% 31%))` | 进度条基准色 |
| 行 253, 257, 380 | `#dc2626` | `var(--text-danger)` / `var(--accent-red)` | 错误状态与危险按钮 |
| 行 262 | `#86efac` | `var(--accent-green-muted)` | 成功状态边框 |
| 行 266, 344 | `#059669` | `var(--text-success-strong)` | 成功状态文字与进度条 |
| 行 271, 275 | `#c2410c` | `var(--text-warning-strong)` | 警告状态文字与进度条 |
| 行 280 | `#10b981` | `var(--brand)` | 加载中高亮色 |
| 行 325 | `#555555` | `var(--text-secondary)` | 描述次级文字 |
| 行 365, 381 | `#ffffff` | `var(--bg-card, hsl(0 0% 100%))` | 按钮高亮文字底色 |
| 行 397 | `#696969` | `var(--text-tertiary)` | 关闭按钮常态颜色 |

---

### 6.2 JSX 内联样式清零与 CSS Modules 类名收敛

彻底移除 `ToastCard.tsx` 中 `Lucide` 图标上的内联 `style={{ color: '...' }}`，改由 CSS Modules 的 `.iconWrapper[data-type="..."]` 统一分发，保证样式与表现完全解耦。

---

## 7. 核心模块重构源码详案

### 7.1 `apps/crish-desktop/src/services/toast/types.ts`

```typescript
import type * as React from 'react';

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'recovery' | 'loading';
export type ToastPriority = 'polite' | 'assertive';

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
  ariaLive?: ToastPriority;
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
  ttlMs?: number;
  type?: ToastType;
  ariaLive?: ToastPriority;
  action?: ToastActionConfig;
  onUndo?: () => void;
  onDismiss?: () => void;
  position?: ToastPosition;
  maxQueue?: number;
}

export interface PromiseToastMessages<T = unknown> {
  loading: React.ReactNode;
  success: React.ReactNode | ((data: T) => React.ReactNode);
  error: React.ReactNode | ((err: unknown) => React.ReactNode);
}

export interface ToastContextValue {
  show: (
    message: React.ReactNode,
    arg2?: (() => void) | ShowToastOptions,
    arg3?: ShowToastOptions
  ) => string;
  showToast: (message: string, onUndo?: () => void, options?: ShowToastOptions) => void;
  success: (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ) => string;
  error: (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ) => string;
  warning: (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ) => string;
  info: (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ) => string;
  loading: (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>) => string;
  promise: <T>(
    promise: Promise<T>,
    messages: PromiseToastMessages<T>,
    options?: ShowToastOptions
  ) => Promise<T>;
  dismiss: (id?: string) => void;
  dismissToast: (id: string) => void;
  toasts: readonly AppToast[];
}
```

---

### 7.2 `apps/crish-desktop/src/services/toast/ToastStore.ts`

```typescript
import * as React from 'react';
import type {
  AppToast,
  ShowToastOptions,
  PromiseToastMessages,
  ToastType,
  ToastPriority,
} from './types';
import {
  enqueueToast,
  removeToastById,
  TOAST_TTL_MS,
  TOAST_MAX_QUEUE,
  createToastId,
} from '../../hooks/toastQueueLogic';

type Listener = () => void;

function extractErrorMessage(
  err: unknown,
  customError: React.ReactNode | ((err: unknown) => React.ReactNode) | undefined
): React.ReactNode {
  if (typeof customError === 'function') {
    try {
      const res = customError(err);
      if (res) return res;
    } catch {
      // safe fallback
    }
  } else if (customError) {
    return customError;
  }

  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim().length > 0) {
    return err.trim();
  }
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>;
    if (typeof rec.message === 'string' && rec.message) return rec.message;
    if (typeof rec.error === 'string' && rec.error) return rec.error;
  }

  return '操作执行遇到错误，请重试';
}

function extractSuccessMessage<T>(
  data: T,
  customSuccess: React.ReactNode | ((data: T) => React.ReactNode) | undefined
): React.ReactNode {
  if (typeof customSuccess === 'function') {
    try {
      const res = customSuccess(data);
      if (res) return res;
    } catch {
      // safe fallback
    }
  } else if (customSuccess) {
    return customSuccess;
  }
  return '操作已完成';
}

export class ToastStoreImpl {
  private toasts: AppToast[] = [];
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getToasts = (): readonly AppToast[] => {
    return this.toasts;
  };

  show = (
    message: React.ReactNode,
    arg2?: (() => void) | ShowToastOptions,
    arg3?: ShowToastOptions
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: ShowToastOptions | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    const isStringMsg = typeof message === 'string';
    const textMessage = isStringMsg ? (message as string) : '';
    const isCustomElement = React.isValidElement(message) || (!isStringMsg && message != null);

    const id = options?.id ?? createToastId();
    const duration =
      options?.duration ??
      options?.ttlMs ??
      (options?.type === 'loading' ? Infinity : TOAST_TTL_MS);

    // 检查是否为原地更新已有 ID（如 toast.promise 状态流转）
    const existingIndex = this.toasts.findIndex((t) => t.id === id);
    const isUpdate = existingIndex >= 0;

    const isErrorText = isStringMsg && /失败|错误|无法|拒绝/.test(textMessage);
    const resolvedType: ToastType =
      options?.type ??
      (onUndo ? 'info' : isErrorText ? 'error' : 'info');

    const resolvedAriaLive: ToastPriority =
      options?.ariaLive ?? (resolvedType === 'error' ? 'assertive' : 'polite');

    const newToast: AppToast = {
      id,
      type: resolvedType,
      title: options?.title,
      message,
      description: options?.description,
      icon: options?.icon,
      duration,
      ariaLive: resolvedAriaLive,
      action: options?.action,
      onUndo,
      onDismiss: options?.onDismiss,
      timestamp: Date.now(),
      updateKey: Date.now(),
    };

    if (isUpdate) {
      // 1. 原地更新已有 ID：原子替换，重置倒计时与 updateKey，绝不触发 FIFO 误杀
      this.toasts = this.toasts.map((t) =>
        t.id === id
          ? {
              ...t,
              ...newToast,
              id: t.id,
              onUndo: onUndo ?? t.onUndo,
              updateKey: Date.now(),
            }
          : t
      );
      this.notify();
      return id;
    }

    // 2. 非更新场景：若是自定义 React 节点或显式声明了 type/onUndo，直接放行入队
    if (isCustomElement || options?.type || onUndo) {
      const maxQueue = options?.maxQueue ?? TOAST_MAX_QUEUE;
      const filtered = this.toasts.filter((t) => t.id !== id);
      this.toasts = [newToast, ...filtered].slice(0, maxQueue);
      this.notify();
      return id;
    }

    // 3. 纯文本无显式类型：执行 toastQueueLogic 策略门禁
    const queueOldestFirst = this.toasts.slice().reverse();
    const result = enqueueToast(
      queueOldestFirst as any,
      textMessage,
      onUndo,
      {
        id,
        ttlMs: duration,
        maxQueue: options?.maxQueue,
        type: options?.type as any,
      }
    );

    if (result.kind === 'drop') {
      return id;
    }

    if (result.kind === 'dedupe') {
      this.toasts = this.toasts.map((t) =>
        t.id === result.existingId
          ? {
              ...t,
              ...newToast,
              id: t.id,
              onUndo: onUndo ?? t.onUndo,
              updateKey: Date.now(),
            }
          : t
      );
    } else {
      const maxQueue = options?.maxQueue ?? TOAST_MAX_QUEUE;
      const filtered = this.toasts.filter(
        (t) => t.id !== id && !result.evictedIds.includes(t.id)
      );
      this.toasts = [newToast, ...filtered].slice(0, maxQueue);
    }

    this.notify();
    return id;
  };

  success = (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    return this.show(message, onUndo, { ...options, type: 'success' });
  };

  error = (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    return this.show(message, onUndo, { ...options, type: 'error' });
  };

  warning = (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    return this.show(message, onUndo, { ...options, type: 'warning' });
  };

  info = (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    return this.show(message, onUndo, { ...options, type: 'info' });
  };

  loading = (
    message: React.ReactNode,
    options?: Omit<ShowToastOptions, 'type'>
  ): string => {
    return this.show(message, {
      ...options,
      type: 'loading',
      duration: Infinity,
    });
  };

  promise = async <T>(
    promise: Promise<T>,
    messages: PromiseToastMessages<T>,
    options?: ShowToastOptions
  ): Promise<T> => {
    const id = options?.id ?? createToastId();
    this.show(messages.loading, {
      ...options,
      id,
      type: 'loading',
      duration: Infinity,
    });

    try {
      const data = await promise;
      const successMsg = extractSuccessMessage(data, messages.success);
      this.show(successMsg, {
        ...options,
        id,
        type: 'success',
        duration: options?.duration ?? options?.ttlMs ?? TOAST_TTL_MS,
      });
      return data;
    } catch (err) {
      const errorMsg = extractErrorMessage(err, messages.error);
      this.show(errorMsg, {
        ...options,
        id,
        type: 'error',
        duration: options?.duration ?? options?.ttlMs ?? TOAST_TTL_MS,
      });
      throw err;
    }
  };

  dismiss = (id?: string): void => {
    if (!id) {
      for (const t of this.toasts) {
        t.onDismiss?.();
      }
      this.toasts = [];
    } else {
      const target = this.toasts.find((t) => t.id === id);
      if (target) {
        target.onDismiss?.();
      }
      this.toasts = removeToastById(this.toasts as any, id) as AppToast[];
    }
    this.notify();
  };

  clear = (): void => {
    this.dismiss();
  };

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[ToastStore] Listener error:', err);
      }
    }
  }
}

export const ToastStore = new ToastStoreImpl();
```

---

### 7.3 `apps/crish-desktop/src/services/toast/ToastContext.tsx`

```typescript
import React, { createContext, useContext, useMemo, useCallback } from 'react';
import type {
  AppToast,
  ShowToastOptions,
  ToastContextValue,
} from './types';
import { ToastStore } from './ToastStore';
import { toast } from './toast';
import { ToastContainer } from './ToastContainer';

export const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children: React.ReactNode;
  containerId?: string;
  position?:
    | 'bottom-right'
    | 'bottom-center'
    | 'bottom-left'
    | 'top-right'
    | 'top-center'
    | 'top-left';
}

export const ToastProvider: React.FC<ToastProviderProps> = ({
  children,
  containerId = 'toast-root',
  position = 'bottom-right',
}) => {
  const handleShowToast = useCallback(
    (message: string, onUndo?: () => void, options?: ShowToastOptions) => {
      ToastStore.show(message, onUndo, options);
    },
    []
  );

  const handleDismissToast = useCallback((id: string) => {
    ToastStore.dismiss(id);
  }, []);

  const contextValue = useMemo<ToastContextValue>(
    () => ({
      show: ToastStore.show as any,
      showToast: handleShowToast,
      success: ToastStore.success as any,
      error: ToastStore.error as any,
      warning: ToastStore.warning as any,
      info: ToastStore.info as any,
      loading: ToastStore.loading,
      promise: ToastStore.promise,
      dismiss: ToastStore.dismiss,
      dismissToast: handleDismissToast,
      get toasts() {
        return ToastStore.getToasts();
      },
    }),
    [handleShowToast, handleDismissToast]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer
        containerId={containerId}
        position={position}
        onDismiss={handleDismissToast}
      />
    </ToastContext.Provider>
  );
};

const fallbackToastContext: ToastContextValue = {
  show: ToastStore.show as any,
  showToast: (message, onUndo, options) => {
    ToastStore.show(message, onUndo, options);
  },
  success: ToastStore.success as any,
  error: ToastStore.error as any,
  warning: ToastStore.warning as any,
  info: ToastStore.info as any,
  loading: ToastStore.loading,
  promise: ToastStore.promise,
  dismiss: ToastStore.dismiss,
  dismissToast: (id) => {
    ToastStore.dismiss(id);
  },
  get toasts() {
    return ToastStore.getToasts();
  },
};

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    return fallbackToastContext;
  }
  return context;
}

export { toast };
export type { AppToast, ShowToastOptions, ToastContextValue };
```

---

### 7.4 `apps/crish-desktop/src/components/overlay/useToastStackMeasurement.ts`

```typescript
import { useState, useRef, useCallback, useEffect } from 'react';
import type { AppToast } from '../../services/toast/types';

export function useToastStackMeasurement(
  toasts: readonly AppToast[],
  _expanded: boolean
) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const heightsRef = useRef<Record<string, number>>({});
  heightsRef.current = heights;

  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());

  // 注册不受高度约束的内部 body 容器
  const registerNode = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      nodeRefs.current.set(id, el);
      // 采集未受裁剪的真实自然全高 (+2px 补偿上下发丝边框)
      const naturalHeight = Math.ceil(
        el.scrollHeight ||
        el.offsetHeight ||
        (typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect().height
          : 54)
      ) + 2;

      if (naturalHeight > 0 && heightsRef.current[id] !== naturalHeight) {
        heightsRef.current[id] = naturalHeight;
        setHeights((prev) =>
          prev[id] === naturalHeight ? prev : { ...prev, [id]: naturalHeight }
        );
      }
    } else {
      nodeRefs.current.delete(id);
    }
  }, []);

  // 监听内部 DOM 尺寸动态变动
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      let changed = false;
      const next = { ...heightsRef.current };

      for (const entry of entries) {
        const id = entry.target.getAttribute('data-toast-id');
        if (id) {
          const naturalHeight = Math.ceil(
            entry.borderBoxSize?.[0]?.blockSize ??
            entry.contentRect.height ??
            (entry.target as HTMLElement).offsetHeight ??
            54
          ) + 2;

          if (next[id] !== naturalHeight && naturalHeight > 0) {
            next[id] = naturalHeight;
            changed = true;
          }
        }
      }

      if (changed) {
        setHeights(next);
      }
    });

    nodeRefs.current.forEach((el) => {
      observer.observe(el);
    });

    return () => {
      observer.disconnect();
    };
  }, [toasts]);

  // 计算展开态下第 index 张卡片的累加纵向位移: sum(H_0..H_{i-1}) + index * gap
  const getOffsetY = useCallback(
    (index: number, gap: number = 12): number => {
      let acc = 0;
      for (let i = 0; i < index; i++) {
        const item = toasts[i];
        const h = item
          ? heights[item.id] ?? heightsRef.current[item.id] ?? 56
          : 56;
        acc += h + gap;
      }
      return acc;
    },
    [toasts, heights]
  );

  const frontmostHeight = toasts[0]
    ? heights[toasts[0].id] ?? heightsRef.current[toasts[0].id] ?? 56
    : 56;

  return {
    registerNode,
    getOffsetY,
    heights,
    frontmostHeight,
  };
}
```

---

### 7.5 `apps/crish-desktop/src/components/overlay/useSwipeDismiss.ts`

```typescript
import { useState, useRef, useCallback } from 'react';

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
  const [movement, setMovement] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [swiping, setSwiping] = useState(false);

  const activePointerIdRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const startPos = useRef<{
    x: number;
    y: number;
    time: number;
    pointerId: number;
  } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // 仅允许主鼠标键且单点触控锁定
    if (e.button !== 0 || activePointerIdRef.current !== null) return;

    // 忽略内部交互按钮点击
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) return;

    activePointerIdRef.current = e.pointerId;
    isDraggingRef.current = false;
    startPos.current = {
      x: e.clientX,
      y: e.clientY,
      time: performance.now(),
      pointerId: e.pointerId,
    };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!startPos.current || e.pointerId !== activePointerIdRef.current) return;

      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      const distance = Math.hypot(dx, dy);

      // 10px 物理拖拽死区拦截
      if (!isDraggingRef.current) {
        if (distance < 10) return;
        isDraggingRef.current = true;
        setSwiping(true);
        try {
          if (typeof e.currentTarget.setPointerCapture === 'function') {
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        } catch {}
      }

      // 弹性阻尼衰减 (非允许方向衰减至 20%)
      const applyDamping = (
        val: number,
        positiveAllowed: boolean,
        negativeAllowed: boolean
      ) => {
        if (val > 0 && !positiveAllowed) return val * 0.2;
        if (val < 0 && !negativeAllowed) return val * 0.2;
        return val;
      };

      const mx = applyDamping(
        dx,
        allowedAxes.includes('right'),
        allowedAxes.includes('left')
      );
      const my = applyDamping(
        dy,
        allowedAxes.includes('down'),
        allowedAxes.includes('up')
      );

      setMovement({ x: mx, y: my });
    },
    [allowedAxes]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!startPos.current || e.pointerId !== activePointerIdRef.current) return;

      const dt = Math.max(1, performance.now() - startPos.current.time);
      const { x, y } = movement;
      const vx = Math.abs(x) / dt;
      const vy = Math.abs(y) / dt;

      const pointerId = startPos.current.pointerId;
      startPos.current = null;
      activePointerIdRef.current = null;
      const wasDragging = isDraggingRef.current;
      isDraggingRef.current = false;
      setSwiping(false);

      try {
        if (
          typeof e.currentTarget.releasePointerCapture === 'function' &&
          e.currentTarget.hasPointerCapture?.(pointerId)
        ) {
          e.currentTarget.releasePointerCapture(pointerId);
        }
      } catch {}

      if (!wasDragging) {
        return;
      }

      // 消除判定：位移超过阈值，或满足最小位移且瞬时速率达标 (Flick)
      const minFlingDistance = Math.max(25, threshold / 2);
      const isDismissedX =
        (Math.abs(x) >= threshold ||
          (Math.abs(x) >= minFlingDistance && vx > 0.45)) &&
        (x > 0
          ? allowedAxes.includes('right')
          : allowedAxes.includes('left'));

      const isDismissedY =
        (Math.abs(y) >= threshold ||
          (Math.abs(y) >= minFlingDistance && vy > 0.45)) &&
        (y > 0
          ? allowedAxes.includes('down')
          : allowedAxes.includes('up'));

      const isDismissed = isDismissedX || isDismissedY;

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

### 7.6 `apps/crish-desktop/src/components/overlay/ToastViewport.tsx`

```typescript
import React, { useState, useCallback, useSyncExternalStore } from 'react';
import type { AppToast, ToastPosition } from '../../services/toast/types';
import { ToastStore } from '../../services/toast/ToastStore';
import { useToastStackMeasurement } from './useToastStackMeasurement';
import { ToastCard } from './ToastCard';
import styles from './ToastStackModern.module.css';

export interface ToastViewportProps {
  position?: ToastPosition;
  toasts?: readonly AppToast[];
  onDismiss?: (id: string) => void;
}

export const ToastViewport: React.FC<ToastViewportProps> = ({
  position = 'bottom-right',
  toasts: propToasts,
  onDismiss: propOnDismiss,
}) => {
  const storeToasts = useSyncExternalStore(
    ToastStore.subscribe,
    ToastStore.getToasts,
    ToastStore.getToasts
  );

  const toasts = propToasts ?? storeToasts;
  const [hovered, setHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const isExpanded = hovered || isFocused;

  const { registerNode, getOffsetY, frontmostHeight } =
    useToastStackMeasurement(toasts, isExpanded);

  const handleMouseEnter = useCallback(() => {
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
  }, []);

  const handleFocusCapture = useCallback(() => {
    setIsFocused(true);
  }, []);

  const handleBlurCapture = useCallback((e: React.FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsFocused(false);
    }
  }, []);

  const handleDismiss = useCallback(
    (id: string) => {
      if (propOnDismiss) {
        propOnDismiss(id);
      } else {
        ToastStore.dismiss(id);
      }
    },
    [propOnDismiss]
  );

  if (!toasts || toasts.length === 0) {
    return null;
  }

  const getPositionClass = () => {
    switch (position) {
      case 'bottom-center':
        return styles.viewportBottomCenter;
      case 'bottom-left':
        return styles.viewportBottomLeft;
      case 'top-right':
        return styles.viewportTopRight;
      case 'top-center':
        return styles.viewportTopCenter;
      case 'top-left':
        return styles.viewportTopLeft;
      case 'bottom-right':
      default:
        return styles.viewportBottomRight;
    }
  };

  return (
    <section
      role="region"
      aria-label="通知中心"
      data-position={position}
      data-expanded={isExpanded}
      className={`${styles.viewport} ${getPositionClass()}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      {toasts.map((item, index) => (
        <ToastCard
          key={item.id}
          toast={item}
          index={index}
          position={position}
          frontmostHeight={frontmostHeight}
          offsetY={getOffsetY(index)}
          onHeightMeasure={(el) => registerNode(item.id, el)}
          onDismiss={handleDismiss}
          isExpanded={isExpanded}
        />
      ))}
    </section>
  );
};
```

---

### 7.7 `apps/crish-desktop/src/components/overlay/ToastCard.tsx`

```typescript
import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as Lucide from 'lucide-react';
import type { AppToast, ToastPosition } from '../../services/toast/types';
import { useSwipeDismiss } from './useSwipeDismiss';
import styles from './ToastStackModern.module.css';

export interface ToastCardProps {
  toast: AppToast;
  index: number;
  position?: ToastPosition;
  frontmostHeight: number;
  offsetY: number;
  isExpanded: boolean;
  onHeightMeasure: (el: HTMLElement | null) => void;
  onDismiss: (id: string) => void;
}

export const ToastCard: React.FC<ToastCardProps> = ({
  toast,
  index,
  position = 'bottom-right',
  frontmostHeight,
  offsetY,
  isExpanded,
  onHeightMeasure,
  onDismiss,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const [swipedOut, setSwipedOut] = useState(false);

  // 固化 onDismiss 引用与 ID
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const toastIdRef = useRef(toast.id);
  toastIdRef.current = toast.id;

  const remainingTimeRef = useRef<number>(toast.duration ?? 5000);
  const startTimeRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isTopAnchored = position.startsWith('top');
  const allowedAxes: ('up' | 'down' | 'left' | 'right')[] = isTopAnchored
    ? ['up', 'right', 'left']
    : ['down', 'right', 'left'];

  const triggerDismissAnimation = useCallback(() => {
    if (exiting) return;
    setExiting(true);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      onDismissRef.current(toastIdRef.current);
    }, 260);
  }, [exiting]);

  const handleSwipeDismiss = useCallback(() => {
    setSwipedOut(true);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      onDismissRef.current(toastIdRef.current);
    }, 260);
  }, []);

  const { onPointerDown, onPointerMove, onPointerUp, movement, swiping } =
    useSwipeDismiss({
      onDismiss: handleSwipeDismiss,
      allowedAxes,
      threshold: 60,
    });

  // 当 duration 或 updateKey 发生实质更新时重置倒计时
  useEffect(() => {
    remainingTimeRef.current = toast.duration ?? 5000;
  }, [toast.duration, toast.updateKey]);

  // 受控 PausableTimer 毫秒级时钟
  useEffect(() => {
    if (!toast.duration || toast.duration === Infinity) return;

    if (isExpanded) {
      if (startTimeRef.current !== null) {
        const elapsed = performance.now() - startTimeRef.current;
        remainingTimeRef.current = Math.max(
          0,
          remainingTimeRef.current - elapsed
        );
        startTimeRef.current = null;
      }
      return;
    }

    startTimeRef.current = performance.now();
    const timer = setTimeout(() => {
      triggerDismissAnimation();
    }, remainingTimeRef.current);

    return () => {
      clearTimeout(timer);
      if (startTimeRef.current !== null) {
        const elapsed = performance.now() - startTimeRef.current;
        remainingTimeRef.current = Math.max(
          0,
          remainingTimeRef.current - elapsed
        );
        startTimeRef.current = null;
      }
    };
  }, [toast.id, toast.duration, toast.updateKey, isExpanded, triggerDismissAnimation]);

  const setBodyNodeRef = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el;
      onHeightMeasure(el);
    },
    [onHeightMeasure]
  );

  const styleVariables: React.CSSProperties = {
    ['--toast-index' as string]: index,
    ['--toast-frontmost-height' as string]: `${frontmostHeight}px`,
    ['--toast-height' as string]: bodyRef.current
      ? `${(bodyRef.current.scrollHeight || bodyRef.current.offsetHeight) + 2}px`
      : 'auto',
    ['--toast-offset-y' as string]: `${offsetY}px`,
    ['--toast-swipe-movement-x' as string]: `${movement.x}px`,
    ['--toast-swipe-movement-y' as string]: `${movement.y}px`,
  };

  const getIcon = () => {
    if (toast.icon) return toast.icon;
    switch (toast.type) {
      case 'success':
        return <Lucide.CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />;
      case 'error':
        return <Lucide.AlertCircle size={16} strokeWidth={2} aria-hidden="true" />;
      case 'warning':
        return <Lucide.AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />;
      case 'loading':
        return <Lucide.Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />;
      default:
        return <Lucide.Info size={16} strokeWidth={2} aria-hidden="true" />;
    }
  };

  const stateAttr = swipedOut
    ? 'swiping-dismiss'
    : exiting
    ? 'exiting'
    : swiping
    ? 'swiping'
    : 'idle';

  const roleAttr = toast.type === 'error' ? 'alert' : 'status';
  const liveAttr = toast.ariaLive ?? (toast.type === 'error' ? 'assertive' : 'polite');

  return (
    <div
      role={roleAttr}
      aria-live={liveAttr}
      aria-atomic="true"
      data-toast-id={toast.id}
      data-type={toast.type}
      data-toast-type={toast.type}
      data-state={stateAttr}
      data-stack-depth={index >= 3 ? 'deep' : 'visible'}
      style={styleVariables}
      className={styles.toastCard}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        ref={setBodyNodeRef}
        data-toast-id={toast.id}
        data-toast-body="true"
        className={styles.cardBody}
      >
        <span className={styles.iconWrapper} data-type={toast.type}>
          {getIcon()}
        </span>
        <div className={styles.contentWrapper}>
          {toast.title && <div className={styles.title}>{toast.title}</div>}
          <div className={styles.message}>{toast.message}</div>
          {toast.description && (
            <div className={styles.description}>{toast.description}</div>
          )}
        </div>

        <div className={styles.actionsRow}>
          {toast.onUndo && (
            <button
              type="button"
              className={styles.undoButton}
              onClick={(e) => {
                e.stopPropagation();
                toast.onUndo?.();
                triggerDismissAnimation();
              }}
            >
              撤销
            </button>
          )}

          {toast.action && (
            <button
              type="button"
              data-variant={toast.action.variant ?? 'primary'}
              className={styles.actionButton}
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
            aria-label="关闭通知"
            className={styles.closeButton}
            onClick={(e) => {
              e.stopPropagation();
              triggerDismissAnimation();
            }}
          >
            <Lucide.X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      {toast.duration && toast.duration !== Infinity && (
        <div className={styles.progressTrack}>
          <div
            key={toast.updateKey ?? toast.timestamp}
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

### 7.8 `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css`

```css
/* ==========================================================================
   Toast Viewport & 3D Stacking Notification Center (v2.0)
   100% Zero-Blue Design Tokens & Native Physics Engine
   ========================================================================== */

.viewport {
  position: fixed;
  z-index: var(--z-toast, 1000);
  width: 380px;
  max-width: calc(100vw - 32px);
  pointer-events: none;
  display: flex;
  flex-direction: column;
  outline: none;
  user-select: none;
  box-sizing: border-box;
}

/* 锚定位置类 (抗亚像素文字模糊) */
.viewportBottomRight {
  bottom: 16px;
  right: 16px;
}

.viewportBottomCenter {
  bottom: 16px;
  left: calc(50% - 190px);
  transform: none;
}

.viewportBottomLeft {
  bottom: 16px;
  left: 16px;
}

.viewportTopRight {
  top: 16px;
  right: 16px;
}

.viewportTopCenter {
  top: 16px;
  left: calc(50% - 190px);
  transform: none;
}

.viewportTopLeft {
  top: 16px;
  left: 16px;
}

/* ==========================================================================
   Toast Card Base & Physics Variables
   ========================================================================== */

.toastCard {
  --gap: 12px;
  --peek: 12px;
  --scale: calc(max(0, 1 - (var(--toast-index, 0) * 0.1)));
  --shrink: calc(1 - var(--scale));
  --height: var(--toast-frontmost-height, var(--toast-height, 56px));
  --swipe-x: var(--toast-swipe-movement-x, 0px);
  --swipe-y: var(--toast-swipe-movement-y, 0px);

  position: absolute;
  z-index: calc(1000 - var(--toast-index, 0));
  width: 100%;
  pointer-events: auto;
  box-sizing: border-box;

  /* 堆叠态高度锁定为首张高度，展开态释放为自适应高度 */
  height: var(--height);
  overflow: hidden;

  /* 背景与发丝边框适配 */
  background-color: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  border: 1px solid var(--hairline, var(--border-subtle, hsl(35 8% 91%)));
  border-radius: var(--radius-lg, 8px);
  padding: 10px 14px;
  font-size: var(--font-size-sm, 13px);
  line-height: var(--line-height-base, 1.4);
  font-family: var(--font-sans);

  /* 物理阴影 */
  box-shadow: 0 -4px 16px -2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 6%, transparent),
              0 2px 6px -1px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 4%, transparent);

  /* 核心物理缓动 */
  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1),
              opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
              height 0.18s cubic-bezier(0.22, 1, 0.36, 1),
              box-shadow 0.3s ease,
              border-color 0.2s ease;
  will-change: transform, opacity, height;
  touch-action: none;
}

/* ==========================================================================
   底部锚定 3D 堆叠与扇形展开
   ========================================================================== */

.viewport[data-position^='bottom'] .toastCard,
.viewport:not([data-position^='top']) .toastCard {
  bottom: 0;
  left: 0;
  right: 0;
  transform-origin: bottom center;

  transform: translateX(var(--swipe-x))
             translateY(calc(var(--swipe-y) - (var(--toast-index, 0) * var(--peek)) - (var(--shrink) * var(--height))))
             scale(var(--scale));
}

.viewport[data-position^='bottom'][data-expanded='true'] .toastCard,
.viewport:not([data-position^='top'])[data-expanded='true'] .toastCard {
  height: var(--toast-height, auto);
  transform: translateX(var(--swipe-x))
             translateY(calc(-1 * var(--toast-offset-y, 0px) + var(--swipe-y)))
             scale(1);
  box-shadow: var(--shadow-lg, 0 10px 25px -5px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 10%, transparent));
}

/* ==========================================================================
   顶部锚定 3D 堆叠与扇形展开
   ========================================================================== */

.viewport[data-position^='top'] .toastCard {
  top: 0;
  left: 0;
  right: 0;
  transform-origin: top center;

  transform: translateX(var(--swipe-x))
             translateY(calc(var(--swipe-y) + (var(--toast-index, 0) * var(--peek)) + (var(--shrink) * var(--height))))
             scale(var(--scale));
  box-shadow: 0 4px 16px -2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 6%, transparent),
              0 2px 6px -1px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 4%, transparent);
}

.viewport[data-position^='top'][data-expanded='true'] .toastCard {
  height: var(--toast-height, auto);
  transform: translateX(var(--swipe-x))
             translateY(calc(var(--toast-offset-y, 0px) + var(--swipe-y)))
             scale(1);
  box-shadow: var(--shadow-lg, 0 10px 25px -5px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 10%, transparent));
}

/* ==========================================================================
   折叠态深层卡片裁切与 Hover Bridge
   ========================================================================== */

.viewport:not([data-expanded='true']) .toastCard[data-stack-depth='deep'] {
  opacity: 0 !important;
  pointer-events: none !important;
}

.toastCard::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: calc(var(--gap, 12px) + 2px);
  pointer-events: none;
}

.viewport[data-expanded='true'] .toastCard::after {
  pointer-events: auto;
}

.viewport[data-position^='top'] .toastCard::after {
  top: auto;
  bottom: 100%;
}

/* ==========================================================================
   入场、退场与手势滑动
   ========================================================================== */

@keyframes toastEnterBottom {
  from {
    opacity: 0;
    transform: translateY(120%) scale(0.92);
  }
  to {
    opacity: 1;
  }
}

@keyframes toastEnterTop {
  from {
    opacity: 0;
    transform: translateY(-120%) scale(0.92);
  }
  to {
    opacity: 1;
  }
}

.viewport[data-position^='bottom'] .toastCard[data-state='entering'],
.viewport:not([data-position^='top']) .toastCard[data-state='entering'] {
  animation: toastEnterBottom 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.viewport[data-position^='top'] .toastCard[data-state='entering'] {
  animation: toastEnterTop 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.viewport[data-position^='bottom'] .toastCard[data-state='exiting'],
.viewport:not([data-position^='top']) .toastCard[data-state='exiting'] {
  opacity: 0 !important;
  transform: translateY(100%) scale(0.92) !important;
  pointer-events: none;
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease;
}

.viewport[data-position^='top'] .toastCard[data-state='exiting'] {
  opacity: 0 !important;
  transform: translateY(-100%) scale(0.92) !important;
  pointer-events: none;
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease;
}

.toastCard[data-state='swiping'] {
  transition: none !important;
}

.toastCard[data-state='swiping-dismiss'] {
  opacity: 0 !important;
  transform: translateX(calc(var(--swipe-x) * 1.8 + 120px)) translateY(var(--swipe-y)) !important;
  pointer-events: none;
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease;
}

/* ==========================================================================
   倒计时进度指示器
   ========================================================================== */

.progressTrack {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
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
  background: var(--brand-deep, hsl(160 84% 31%));
  animation: toastProgress linear forwards;
}

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
   类型主题色彩
   ========================================================================== */

.toastCard[data-type='error'],
.toastCard[data-toast-type='error'] {
  border-color: var(--color-error-border, color-mix(in srgb, var(--text-danger) 25%, transparent));
}
.toastCard[data-type='error'] .progressBar,
.toastCard[data-toast-type='error'] .progressBar {
  background: var(--text-danger);
}

.toastCard[data-type='success'],
.toastCard[data-toast-type='success'] {
  border-color: var(--color-success-border, var(--accent-green-muted));
}
.toastCard[data-type='success'] .progressBar,
.toastCard[data-toast-type='success'] .progressBar {
  background: var(--text-success-strong);
}

.toastCard[data-type='warning'],
.toastCard[data-toast-type='warning'] {
  border-color: var(--color-warning-border, color-mix(in srgb, var(--text-warning-strong) 25%, transparent));
}
.toastCard[data-type='warning'] .progressBar,
.toastCard[data-toast-type='warning'] .progressBar {
  background: var(--text-warning-strong);
}

.toastCard[data-type='loading'] .progressBar,
.toastCard[data-toast-type='loading'] .progressBar {
  background: var(--brand);
}

/* ==========================================================================
   卡片内部布局与组件元素
   ========================================================================== */

.cardBody {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
}

.iconWrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--text-secondary);
}

.iconWrapper[data-type='success'] {
  color: var(--text-success-strong);
}

.iconWrapper[data-type='error'] {
  color: var(--text-danger);
}

.iconWrapper[data-type='warning'] {
  color: var(--text-warning-strong);
}

.iconWrapper[data-type='loading'] {
  color: var(--brand);
}

.contentWrapper {
  flex: 1 1 auto;
  min-width: 0;
}

.title {
  font-weight: 600;
  font-size: var(--font-size-xs, 12px);
  line-height: 1.35;
  margin-bottom: 2px;
  color: var(--text-primary);
}

.message {
  font-size: var(--font-size-sm, 13px);
  line-height: 1.4;
  color: var(--text-primary);
  word-break: break-word;
}

.description {
  font-size: var(--font-size-xs, 12px);
  line-height: 1.4;
  color: var(--text-secondary);
  margin-top: 4px;
  word-break: break-word;
}

.actionsRow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: auto;
}

.undoButton {
  background: none;
  border: none;
  padding: 2px 6px;
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  color: var(--brand-deep, hsl(160 84% 31%));
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  border-radius: var(--radius-sm, 4px);
  transition: opacity 0.15s ease, background-color 0.15s ease;
}

.undoButton:hover {
  opacity: 0.85;
  background-color: var(--tint-hover);
}

.actionButton {
  border: none;
  padding: 3px 8px;
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  background-color: var(--text-primary);
  color: var(--bg-card, hsl(0 0% 100%));
  transition: opacity 0.15s ease;
}

.actionButton:hover {
  opacity: 0.88;
}

.actionButton[data-variant='secondary'] {
  background-color: var(--tint-hover);
  color: var(--text-primary);
  border: 1px solid var(--border-subtle);
}

.actionButton[data-variant='danger'] {
  background-color: var(--text-danger);
  color: var(--bg-card, hsl(0 0% 100%));
}

.actionButton[data-variant='ghost'] {
  background-color: transparent;
  color: var(--text-primary);
}

.closeButton {
  background: transparent;
  border: none;
  padding: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm, 4px);
  color: var(--text-tertiary);
  cursor: pointer;
  margin-top: -2px;
  margin-right: -4px;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.closeButton:hover {
  color: var(--text-primary);
  background-color: var(--tint-hover);
}

.closeButton:focus-visible,
.actionButton:focus-visible,
.undoButton:focus-visible {
  outline: none;
  box-shadow: var(
    --focus-ring,
    0 0 0 2px color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 35%, transparent)
  );
}

/* ==========================================================================
   减弱动态偏好
   ========================================================================== */

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

---

## 8. 单元测试与验证用例矩阵

为保障本次改进的代码稳健性，规划与实施如下 Vitest 自动化单元测试套件：

### 8.1 Store 与状态机测试集 (`ToastStore.test.ts`)
1. **JSX 节点入队测试**：
   - 验证传入 `React.createElement('span', { className: 'font-bold' }, '构建成功')` 能正确入队且 `toasts.length === 1`；
2. **`toast.promise` 完整状态流转**：
   - 测试 Pending 态为 loading，决议后原地更新为 success，且倒计时从 5000ms 重启；
3. **`toast.promise` 非 Error rejection 防御**：
   - 测试 `Promise.reject(null)`、`Promise.reject('timeout string')` 与 `Promise.reject({ status: 500 })` 均能平滑提取错误并展示，不发生未捕获异常；
4. **满队列原地更新 FIFO 保护**：
   - 填满 5 条通知后调用 `toast.promise`，验证决议更新后队列仍保持合法数量，中间的活跃通知不被二次误杀。

### 8.2 视图与物理交互测试集 (`ToastCard.test.tsx` / `ToastStack.test.tsx`)
1. **内部 Body 测高与边框补偿**：
   - 挂载包含多行文本的卡片，验证 `scrollHeight + 2px` 能准确反映并在展开时赋予正确的 `--toast-height`；
2. **PausableTimer 重绘不漂移测试**：
   - 在 JSDOM 下通过 fakeTimers 推进时间，模拟父组件触发 10 次无关 Re-render，验证定时器剩余时间精确扣减，绝无提前销毁；
3. **手势 10px 死区与多点触控测试**：
   - 模拟 PointerDown 后移动 5px 并 Up，验证未触发 `swiping` 且未调用 `onDismiss`；
   - 模拟 PointerDown 后移动 80px 并 Up，验证成功调用 `onDismiss`；
4. **全键盘焦点展开与 WAI-ARIA 属性**：
   - 测试键盘聚焦在 Undo 按钮上时，Viewport 激活 `data-expanded="true"`，错误通知输出 `role="alert"` 与 `aria-live="assertive"`。

---

## 9. 实施演进与风险检查清单

### 9.1 实施演进步骤
- **步骤 1**：按 `types.ts` 与 `ToastStore.ts` 实施状态机重构，验证 `toast.promise` 与 JSX 节点兼容性；
- **步骤 2**：重构 `useToastStackMeasurement.ts` 与 `useSwipeDismiss.ts`，固化 10px 死区与内部 Body 测高；
- **步骤 3**：重构 `ToastViewport.tsx` 与 `ToastCard.tsx`，接入焦点捕获与 PausableTimer 稳定时钟；
- **步骤 4**：重写 `ToastStackModern.module.css`，完成 26 处硬编码 HEX 清洗与对偶入场动效；
- **步骤 5**：执行 Vitest 单元测试集，确保 100% 绿灯通过。

### 9.2 风险与防范
1. **服务端渲染与 JSDOM 测高降级**：
   - 针对 `ResizeObserver` 或 `getBoundingClientRect` 不可用的环境，`useToastStackMeasurement` 保留了 56px 安全回退值；
2. **Pointer Capture 在测试沙箱中的兼容性**：
   - 在 `useSwipeDismiss` 中对 `setPointerCapture` / `releasePointerCapture` 进行了 `try-catch` 与 `typeof` 防护；
3. **设计系统 Zero-Blue 墨阶一致性**：
   - 所有类名与 Tokens 完全收敛至项目的 `tokens.css` 变量体系。
