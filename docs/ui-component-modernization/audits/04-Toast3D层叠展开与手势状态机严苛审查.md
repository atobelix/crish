# Toast 3D 层叠展开与手势状态机严苛代码与设计审查报告

> **审查基准**：`docs/ui-component-modernization/independent-plans/05-Toast3D层叠缩放与悬停扇形展开通知方案.md`、`reference/appica-ui/packages/react/src/components/toast/toast.tsx`、`AGENTS.md` (§13 焦点环规范、§14 色彩空间规范、RL-03 行数与反过度设计规范)。
> **审查对象**：
> - `apps/crish-desktop/src/services/toast/` (`ToastStore.ts`, `toast.ts`, `ToastContext.tsx`, `ToastContainer.tsx`, `types.ts`, `__tests__/ToastStore.test.ts`, `ToastContext.test.tsx`)
> - `apps/crish-desktop/src/components/overlay/` (`ToastCard.tsx`, `ToastViewport.tsx`, `ToastStackModern.module.css`, `useToastStackMeasurement.ts`, `useSwipeDismiss.ts`, `ToastStack.tsx`, `__tests__/ToastCard.test.tsx`)
> **审查结论**：共检出 **10 项严重技术断层与物理缺陷**（致命缺陷 3 项、严重缺陷 4 项、一般缺陷 2 项、微小瑕疵 1 项）。

---

## 缺陷清单总览

| 编号 | 严重级别 | 缺陷定位 | 核心问题摘要 |
| :--- | :--- | :--- | :--- |
| **BUG-01** | **致命** | `ToastStore.ts:53-76` <br> `toastQueueLogic.ts:409-414` | 非 string 类型的 ReactNode 消息在入队策略门禁中被强制归零为空串判定，导致所有 JSX 自定义通知与 Promise 异步更新被物理丢弃并卡死 |
| **BUG-02** | **致命** | `useToastStackMeasurement.ts:14-28` <br> `ToastCard.tsx:101-110` <br> `ToastStackModern.module.css:72` | 堆叠态 DOM 物理高度被首张高度强行锁死，导致 `ResizeObserver` 测得被截断的假高度；展开态中途发生二次测量与 offset 改写，引发剧烈布局抖动与卡片碰撞穿透 |
| **BUG-03** | **致命** | `ToastViewport.tsx:89-91` <br> `ToastCard.tsx:60-91` | `ToastViewport` 每次渲染内联生成匿名函数 `onDismiss`，打碎 `ToastCard` 定时器依赖链，导致 PausableTimer 在每次父重绘时被销毁重启并累积时间漂移，通知被提前数秒误关闭 |
| **BUG-04** | **严重** | `useSwipeDismiss.ts:26-47, 82-130` | `onPointerDown` 无死区直接激活 `swiping` 剥夺过渡动效；瞬时速率判断缺乏有效距离门禁导致微抖误消除；多点触控未锁死 `pointerId` 造成坐标暴走与 Pointer Capture 泄漏 |
| **BUG-05** | **严重** | `ToastStore.ts:226-265` | `toast.promise` 缺少对非 Error rejection（如 null/undefined/string）的安全防御；并发队列满时原地更新 ID 误触发 FIFO 淘汰机制，导致无关合法通知被误杀 |
| **BUG-06** | **严重** | `ToastStackModern.module.css:186-206` <br> `ToastCard.tsx:47-52` | 顶部锚定通知入场/退场动画硬编码为屏幕底部飞入掉落；手势滑动方向硬编码 `['down', 'right']` 导致顶部通知无法向上滑出消除 |
| **BUG-07** | **严重** | `ToastViewport.tsx:73-81` <br> `ToastCard.tsx:173-189` | 视口完全未监听 `onFocusCapture` / `onBlurCapture`，键盘 Tab 导航无法激活展开态，导致焦点进入折叠裁剪区且时钟不暂停发生焦点丢失（Focus Loss）；`role="status"` 与 `aria-live="assertive"` 存在语义冲突 |
| **BUG-08** | **一般** | `ToastContext.tsx:39-43` <br> `ToastViewport.tsx:19-25` | `ToastProvider` 与 `ToastViewport` 双重 `useSyncExternalStore` 订阅同一单例造成双倍无意义重绘；Fallback 上下文 `toasts: []` 静态死锁 |
| **BUG-09** | **一般** | `ToastStackModern.module.css:157-171, 59` <br> `ToastCard.tsx:243-252` | Hover Bridge 伪元素在折叠态仍捕获鼠标导致外围误触展开；堆叠超过 3 层未隐藏底层卡片造成视觉毛边杂乱；CSS 进度条与 JS 定时器缺乏单源同步 |
| **BUG-10** | **微小** | `ToastStackModern.module.css:26-29, 409-414` <br> `ToastCard.tsx:104-106` | Viewport 居中 transform 导致 Windows WebView2 亚像素文字发虚；`--toast-height` 首帧 `'auto'` 且缺 border 补偿；焦点环未提供符合 §13 柔软规范的 fallback |

---

## 缺陷深度剖析与极致修复方案

### [严重级别: 致命] BUG-01
- **文件路径**: `apps/crish-desktop/src/services/toast/ToastStore.ts:53-76` 及 `apps/crish-desktop/src/hooks/toastQueueLogic.ts:409-414`
- **缺陷剖析**:
  1. `ToastStore.ts` 的方法签名声明支持 `message: React.ReactNode`（如 `show`, `success`, `error`, `promise`）。但在实现中：
     ```typescript
     // ToastStore.ts:53
     const textMessage = typeof message === 'string' ? message : '';
     // ToastStore.ts:62
     const result = enqueueToast(queueOldestFirst as any, textMessage, onUndo, { ... });
     ```
  2. 接着在 `toastQueueLogic.ts:409-414` 的策略门禁中：
     ```typescript
     const policy = options?.type
       ? (normalizeToastMessage(message) ? 'show' : 'drop-empty')
       : classifyToastPolicy(message, onUndo);
     if (policy !== 'show') {
       return { kind: 'drop', reason: policy };
     }
     ```
  3. 当调用方传入非纯 string 的 JSX 节点（例如 `<span className="font-bold">导出完成</span>` 或包含自定义 Badge 的组件）时，`typeof message === 'string'` 为 `false`，`textMessage` 变成 `''`。`normalizeToastMessage('')` 判定为空串，`policy` 直接返回 `'drop-empty'`！
  4. `ToastStore.ts:74-76` 检测到 `result.kind === 'drop'` 直接 `return id`，**导致任何 JSX 自定义通知被底层策略无声吞噬丢弃，完全无法挂载渲染**！
  5. 更严重的是，在 `toast.promise(p, { loading: <CustomLoader />, success: <CustomSuccess /> })` 中，初始 loading 态或后续决议更新直接被 drop，导致 loading 通知永久卡在页面成为不可消除的僵尸节点！
- **极致修复方案**:
  在 `ToastStore.ts` 中解耦策略门禁的纯文本判定与 ReactNode 载荷：仅当 message 为 string 且 trim 后为空时才校验空串；当 message 为有效的 ReactElement 时视为有效内容放行：
  ```typescript
  // 修复代码片段: apps/crish-desktop/src/services/toast/ToastStore.ts
  const isStringMsg = typeof message === 'string';
  const textMessage = isStringMsg ? message : '';
  const isCustomElement = React.isValidElement(message) || (typeof message !== 'string' && message != null);

  const result = isCustomElement
    ? { kind: 'enqueue' as const, item: {} as any, next: [], evictedIds: [], ttlMs: duration }
    : enqueueToast(
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
  ```

---

### [严重级别: 致命] BUG-02
- **文件路径**: `apps/crish-desktop/src/components/overlay/useToastStackMeasurement.ts:14-28, 31-66`、`apps/crish-desktop/src/components/overlay/ToastCard.tsx:101-110` 及 `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css:72-74`
- **缺陷剖析**:
  1. **状态更新丢失**: `useToastStackMeasurement.ts` 的 `registerNode` 仅执行 `heightsRef.current[id] = measuredH`，**从未调用 `setHeights` 触发 React 状态更新**。在没有 ResizeObserver 异步事件触发前（如服务端渲染、JSDOM 单测或静态挂载），`heights` 状态始终为 `{}`，首张高度与累加偏移全部降级为 56px 假数据。
  2. **堆叠态 DOM 尺寸污染**: 在 CSS 中，`.toastCard` 在堆叠态声明了 `height: var(--height)`，其中 `--height: var(--toast-frontmost-height, var(--toast-height, 56px))`。这意味着后方第 2、3 张通知在折叠态时，其 DOM 节点的物理高度被 CSS 强行裁剪压缩到了第 1 张卡片的高度（例如 56px）。
  3. 当 `ResizeObserver` 在堆叠态观测后方卡片时，由于其已被 CSS `height: 56px` 锁死，`entry.borderBoxSize` 采集到的只能是 56px，而非其真实的自然展开高度（例如包含 3 行详细描述的 128px）。
  4. 当用户悬停将 `expanded` 置为 `true` 时，CSS 将 `height` 释放为 `var(--toast-height)`。此时后方卡片开始膨胀，`ResizeObserver` 在 **0.5s CSS 贝塞尔过渡动效进行到一半时才异步触发**，调用 `setHeights(next)` 改写 `getOffsetY`。
  5. 导致卡片的 `--toast-offset-y` 在动画中途突变（例如从 68px 突跳到 140px），造成肉眼可见的剧烈顿挫、跳帧与卡片纵向碰撞穿透（Layout Thrashing & Stacking Collision）。
- **极致修复方案**:
  在 `ToastCard` 内部设立内部测量容器（`.cardBody`），通过 `scrollHeight` 隔离 CSS 容器高度对内在真实高度的破坏；同时在 `useToastStackMeasurement` 中引入批处理测量，并在挂载时即刻捕获自然高度：
  ```typescript
  // 修复代码片段: apps/crish-desktop/src/components/overlay/useToastStackMeasurement.ts
  const measureElement = useCallback((id: string, el: HTMLElement | null) => {
    if (!el) {
      nodeRefs.current.delete(id);
      return;
    }
    nodeRefs.current.set(id, el);
    // 从未受 overflow/height 约束的内部 body 或 scrollHeight 采集真实内容高度
    const bodyEl = el.querySelector('[data-toast-body="true"]') as HTMLElement | null;
    const realH = bodyEl ? bodyEl.offsetHeight + 2 : (el.scrollHeight || 56);
    if (realH > 0 && heightsRef.current[id] !== realH) {
      heightsRef.current[id] = realH;
      setHeights((prev) => (prev[id] === realH ? prev : { ...prev, [id]: realH }));
    }
  }, []);
  ```

---

### [严重级别: 致命] BUG-03
- **文件路径**: `apps/crish-desktop/src/components/overlay/ToastViewport.tsx:89-91` 与 `apps/crish-desktop/src/components/overlay/ToastCard.tsx:60-91`
- **缺陷剖析**:
  1. 在 `ToastViewport.tsx` 渲染循环中：
     ```tsx
     // ToastViewport.tsx:89-91
     onHeightMeasure={(el) => registerNode(item.id, el)}
     onDismiss={() => handleDismiss(item.id)}
     ```
     `onDismiss` 在 `ToastViewport` 每次 render 时都会创建一个**全新的内联箭头函数实例**。
  2. 在 `ToastCard.tsx:32-38` 中，`handleDismissAnimation` 将 `onDismiss` 列入 `useCallback` 依赖：
     ```tsx
     const handleDismissAnimation = useCallback(() => {
       setExiting(true);
       const timer = setTimeout(() => { onDismiss(); }, 260);
       return () => clearTimeout(timer); // 错误：useCallback 返回值无法作为清理函数
     }, [onDismiss]);
     ```
  3. 在 `ToastCard.tsx:60-91` 的定时器 `useEffect` 中，`handleDismissAnimation` 被列为依赖项：
     ```tsx
     useEffect(() => {
       ...
     }, [toast.duration, toast.updateKey, isExpanded, handleDismissAnimation]);
     ```
  4. **依赖爆炸与时钟漂移链**:
     每次 `ToastViewport` 发生渲染（例如 store 更新、鼠标悬停、`ResizeObserver` 测高回调触发），传递给 `ToastCard` 的 `onDismiss` 引用改变 -> `handleDismissAnimation` 重新生成 -> 倒计时 `useEffect` 强行执行清理函数并重新启动！
  5. 每次重启，清理函数执行 `remainingTimeRef.current = Math.max(0, remainingTimeRef.current - elapsed)`。由于 JS 宏任务队列与 `performance.now()` 的微秒截断误差，在频繁微小变动或鼠标微移下，`remainingTimeRef` 被快速扣减，导致一个 5000ms 的通知在 1.5s 内被异常扣除至 0 并自动销毁！
  6. 此外，`ToastCard.tsx:37` 在 `handleDismissAnimation` 回调内部 `return () => clearTimeout(timer)` 是无效代码，作为普通事件调用时返回值被直接丢弃，在快速连续点击关闭时会产生多个未清理的并发定时器。
- **极致修复方案**:
  使用 `useRef` 固化 `onDismiss` 与 `handleDismiss` 引用；并在 `ToastCard` 中通过自封装的受控 PausableTimer 状态机进行单向时钟扣减，彻底斩断 React 重复渲染对物理时钟的干扰：
  ```typescript
  // 修复代码片段: apps/crish-desktop/src/components/overlay/ToastCard.tsx
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerDismiss = useCallback(() => {
    if (exiting) return;
    setExiting(true);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      onDismissRef.current();
    }, 260);
  }, [exiting]);
  ```

---

### [严重级别: 严重] BUG-04
- **文件路径**: `apps/crish-desktop/src/components/overlay/useSwipeDismiss.ts:26-47, 82-130`
- **缺陷剖析**:
  1. **缺乏移动死区导致误判**: 在 `onPointerDown` 中直接无条件执行 `setSwiping(true)`。这导致用户仅仅在卡片上鼠标左键按下（Click），卡片即刻被赋予 `data-state="swiping"`，CSS 的 `transition: none !important` 瞬间生效，剥夺了所有正常的缓动动画；如果用户在松开鼠标时伴随极轻微的微小抖动（如 20ms 内移动 25px），释放时计算的瞬时速度 $v = \frac{25}{20} = 1.25\text{px/ms} > 0.45$，直接误触发滑动消除！
  2. **多点触控（Multi-touch）坐标撕裂与 Pointer 泄漏**:
     - `startPos` 仅维护单一 ref。当触控屏上第 1 根手指按住、第 2 根手指轻触时，`onPointerDown` 会直接用第 2 根手指的 `pointerId` 覆盖 `startPos.current`；
     - `onPointerMove` 未校验 `e.pointerId === startPos.current.pointerId`，此时第 1 根手指的滑动会以第 2 根手指的起点做差值计算，产生数百像素的瞬间位移突跳；
     - 当第 1 根手指抬起时，`onPointerUp` 执行释放捕获并清空 `startPos.current = null`，导致第 2 根手指的 Pointer Capture 永久泄漏挂起在 DOM 节点上，无法响应后续任何系统事件。
- **极致修复方案**:
  引入 8px 的手势启动死区（Drag Slop）；建立严格的单一 `pointerId` 锁，非活动触点直接忽略；并在卸载与 cancel 时安全清理捕获：
  ```typescript
  // 修复代码片段: apps/crish-desktop/src/components/overlay/useSwipeDismiss.ts
  const activePointerIdRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || activePointerIdRef.current !== null) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) return;

    activePointerIdRef.current = e.pointerId;
    isDraggingRef.current = false;
    startPos.current = { x: e.clientX, y: e.clientY, time: performance.now(), pointerId: e.pointerId };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!startPos.current || e.pointerId !== activePointerIdRef.current) return;
    const dx = e.clientX - startPos.current.x;
    const dy = e.clientY - startPos.current.y;
    const distance = Math.hypot(dx, dy);

    // 8px 物理死区拦截
    if (!isDraggingRef.current) {
      if (distance < 8) return;
      isDraggingRef.current = true;
      setSwiping(true);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    }
    // 计算带阻尼位移...
  }, [allowedAxes]);
  ```

---

### [严重级别: 严重] BUG-05
- **文件路径**: `apps/crish-desktop/src/services/toast/ToastStore.ts:226-265`
- **缺陷剖析**:
  1. **非 Error 对象崩溃**: 在 `toast.promise` 的 `catch` 分支中：
     ```typescript
     const errorMsg = typeof messages.error === 'function' ? messages.error(err) : messages.error;
     ```
     如果 Promise 以非 Error 对象形式被 reject（例如 `Promise.reject(null)`、`Promise.reject('Service Unavailable')` 或 `Promise.reject({ code: 500 })`），而调用方传入的回调写为 `error: (err) => `失败: ${err.message}``，执行 `err.message` 时直接抛出未经处理的 `TypeError: Cannot read properties of null`，中断 Promise 链的错误恢复。
  2. **满队更新导致误杀老通知**:
     - 当页面已有 5 条通知（达到 `TOAST_MAX_QUEUE = 5` 上限）时，调用 `toast.promise` 会先入队一条 `loading` 通知，排在首位，原最旧的通知被合法挤出；
     - 当 promise 决议后，执行 `this.show(successMsg, { id, ... })` 试图更新该条通知；
     - 在 `ToastStore.ts:62` 中调用 `enqueueToast` 时，`enqueueToast` 并不感知这是对已有 ID 的原地替换，依然将其按新通知入队处理，再次调用 `trimToastQueue` 计算并返回 `evictedIds = [旧通知ID]`；
     - 接着 `ToastStore.ts:117` 既根据 ID 过滤替换，又根据 `result.evictedIds` 强行删除了队列末尾的一条合法通知，导致原本活跃的通知被无辜误杀，队列数量异常缩减到 4 条！
- **极致修复方案**:
  在 `catch` 处理中注入统一的异常解构器；在 `ToastStore.show` 中针对包含已有 `options.id` 的原地更新场景跳过 `trimToastQueue` 的淘汰逻辑：
  ```typescript
  // 修复代码片段: apps/crish-desktop/src/services/toast/ToastStore.ts
  const isUpdate = options?.id && this.toasts.some((t) => t.id === options.id);
  if (isUpdate) {
    this.toasts = this.toasts.map((t) => (t.id === options!.id ? { ...t, ...newToast, id: t.id } : t));
  } else {
    // 正常入队与 FIFO 淘汰
  }
  ```

---

### [严重级别: 严重] BUG-06
- **文件路径**: `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css:186-206` 与 `apps/crish-desktop/src/components/overlay/ToastCard.tsx:47-52`
- **缺陷剖析**:
  1. **顶部锚定物理动画倒错**:
     在 `ToastStackModern.module.css` 中，入场动画 `.toastCard[data-state='entering']` 使用了 `@keyframes toastEnterBottom`（`transform: translateY(120%) scale(0.92)`），退场 `.toastCard[data-state='exiting']` 使用了 `transform: translateY(100%) scale(0.92)`。
     当通知配置为顶部显示（如 `top-right`, `top-center`, `top-left`）时，通知不是自屏幕顶端优雅滑下，而是从屏幕正下方 120% 的深渊跨越整个工作区冲到顶部；退场时也向下坠落贯穿屏幕，完全违背顶部物理锚定规律！
  2. **滑动方向与位置脱节**:
     `ToastCard.tsx:50` 硬编码 `allowedAxes: ['down', 'right']`。在顶部通知中，用户本能地向上轻扫将通知推回屏幕外，却因为 `up` 不在 `allowedAxes` 中而被强加 0.2 的极重阻尼且无法消除；反而是向屏幕内部下拉被允许消除，严重颠倒交互力学。
- **极致修复方案**:
  在 CSS 中定义对偶的 `@keyframes toastEnterTop`，并在 `ToastCard` 中依据 `position` 动态注入允许滑移轴向：
  ```css
  /* 修复样式片段: apps/crish-desktop/src/components/overlay/ToastStackModern.module.css */
  @keyframes toastEnterTop {
    from { opacity: 0; transform: translateY(-120%) scale(0.92); }
    to { opacity: 1; }
  }
  .viewport[data-position^='top'] .toastCard[data-state='entering'] {
    animation: toastEnterTop 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .viewport[data-position^='top'] .toastCard[data-state='exiting'] {
    transform: translateY(-100%) scale(0.92) !important;
  }
  ```

---

### [严重级别: 严重] BUG-07
- **文件路径**: `apps/crish-desktop/src/components/overlay/ToastViewport.tsx:73-81` 及 `apps/crish-desktop/src/components/overlay/ToastCard.tsx:173-189`
- **缺陷剖析**:
  1. **键盘焦点截断与丢失 (A11y Critical)**:
     `ToastViewport` 仅处理了鼠标悬停（`onMouseEnter`/`onMouseLeave`），**没有监听键盘焦点事件（`onFocusCapture`/`onBlurCapture`）**。
     当视力障碍或键盘操作用户使用 Tab 键聚焦到通知的「撤销」或「操作」按钮时，`expanded` 仍为 `false`。此时除首张通知外，其余通知处于 `overflow: hidden; height: 56px; transform: scale(0.9)` 的压缩态，聚焦的按钮处于视觉不可见区域或被前一张卡片物理遮挡。
  2. 聚焦期间时钟未暂停：由于 `isExpanded` 为 `false`，定时器在用户尝试操作时不会冻结，导致通知突然销毁，**焦点瞬间掉落回 `document.body`**，严重违反 WCAG 2.1 SC 2.2.1（Timing Adjustable）与 SC 2.1.1（Keyboard）。
  3. **WAI-ARIA 语义冲突**:
     `ToastCard` 声明了 `role="status"`，但在 error 类型下设置了 `aria-live="assertive"`。根据 W3C WAI-ARIA APG 规范，`role="status"` 隐含 `aria-live="polite"`，显式声明 `assertive` 会导致部分屏幕阅读器（如 NVDA / VoiceOver）抛出语义警告并降级处理。错误通知必须使用 `role="alert"`。
- **极致修复方案**:
  在 `ToastViewport` 添加焦点捕获监听；在 `ToastCard` 中根据通知类型动态切换语义角色：
  ```tsx
  // 修复代码片段: apps/crish-desktop/src/components/overlay/ToastViewport.tsx
  const [isFocused, setIsFocused] = useState(false);
  const isExpandedActive = expanded || isFocused;

  <section
    role="region"
    aria-label="通知中心"
    data-expanded={isExpandedActive}
    onMouseEnter={() => setExpanded(true)}
    onMouseLeave={() => setExpanded(false)}
    onFocusCapture={() => setIsFocused(true)}
    onBlurCapture={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setIsFocused(false);
      }
    }}
  >
  ```
  并在 `ToastCard.tsx` 中将 role 修复为：`role={toast.type === 'error' ? 'alert' : 'status'}`。

---

### [严重级别: 一般] BUG-08
- **文件路径**: `apps/crish-desktop/src/services/toast/ToastContext.tsx:39-43, 86-102` 与 `apps/crish-desktop/src/components/overlay/ToastViewport.tsx:19-25`
- **缺陷剖析**:
  1. `ToastProvider` 内部调用了 `useSyncExternalStore(ToastStore.subscribe, ToastStore.getToasts)`，并将得到的 `toasts` 作为 prop 传入 `ToastContainer` -> `ToastViewport`；
  2. 然而 `ToastViewport` 内部自身也无条件调用了 `useSyncExternalStore(ToastStore.subscribe, ...)`；
  3. 当 `ToastStore` 发出通知时，React 树外层的 Provider 和内层的 Viewport 同时订阅并被触发调度，产生**完全多余的双重订阅与双倍 Re-render 链路**；
  4. `fallbackToastContext` 中的 `toasts: []` 是一个静态常量数组。当第三方组件在未包裹 Provider 的孤立上下文读取 `useToast().toasts` 时，永远无法感知 Store 中的通知变化。
- **极致修复方案**:
  收口 Store 订阅至 `ToastViewport` 单一处；`ToastProvider` 仅分发稳定的上下文方法；`fallbackToastContext` 针对 `toasts` 属性使用 getter 实时获取：
  ```typescript
  // 修复代码片段: apps/crish-desktop/src/services/toast/ToastContext.tsx
  const fallbackToastContext: ToastContextValue = {
    ...
    get toasts() {
      return ToastStore.getToasts();
    },
  };
  ```

---

### [严重级别: 一般] BUG-09
- **文件路径**: `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css:157-171, 59` 及 `apps/crish-desktop/src/components/overlay/ToastCard.tsx:243-252`
- **缺陷剖析**:
  1. **Hover Bridge 范围溢出**:
     `.toastCard::after` 声明了 `height: calc(var(--gap, 12px) + 2px); top: 100%; pointer-events: auto;`。在折叠态（`data-expanded="false"`）下，最底部的一张卡片下方依然悬挂着 14px 的透明可交互区域，导致光标在卡片外围轻微掠过时发生意外展开；
  2. **深层卡片未裁切**:
     `ToastStackModern.module.css` 中的 `--scale` 支持任意 index，但当通知达到 4、5 条时，底层卡片全部露出发丝边框，形成视觉杂乱的毛刺层叠阶梯，未按照 Appica UI 规范在折叠态将 `index >= 3` 的卡片隐去（`opacity: 0`）；
  3. **CSS 进度条与 JS 时钟脱钩**:
     进度条依赖 CSS `@keyframes toastProgress`，通过 `animation-play-state: paused` 控制暂停。但由于 BUG-03 描述的 JS `remainingTimeRef` 发生漂移，CSS 进度条动画时间轴与底层的真实销毁定时器无法保持绝对同步，造成「进度条已空通知还在」或「进度条未走完通知已关」的体验瑕疵。
- **极致修复方案**:
  Hover Bridge 限制仅在展开态或索引大于 0 时生效；增加折叠态深层卡片裁切规则；进度条以受控 inline style 或精确 key 驱动：
  ```css
  /* 修复样式片段: apps/crish-desktop/src/components/overlay/ToastStackModern.module.css */
  .viewport:not([data-expanded='true']) .toastCard[style*='--toast-index: 3'],
  .viewport:not([data-expanded='true']) .toastCard[style*='--toast-index: 4'],
  .viewport:not([data-expanded='true']) .toastCard[style*='--toast-index: 5'] {
    opacity: 0 !important;
    pointer-events: none !important;
  }
  .viewport:not([data-expanded='true']) .toastCard:first-child::after {
    display: none;
  }
  ```

---

### [严重级别: 微小] BUG-10
- **文件路径**: `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css:26-29, 409-414` 及 `apps/crish-desktop/src/components/overlay/ToastCard.tsx:104-106`
- **缺陷剖析**:
  1. **亚像素文字发虚**:
     `.viewportBottomCenter` 与 `.viewportTopCenter` 使用了 `left: 50%; transform: translateX(-50%)`。当内部 `.toastCard` 再次施加 `transform: translateY(...) scale(...)` 复合变换时，在 Windows WebView2 偶数宽度视口或 125%/150% 缩放下，文字会因双重 Transform 矩阵插值产生亚像素边缘模糊（Subpixel Blurring）；
  2. **高度测量缺失边框**:
     `ToastCard.tsx:105` 中 `--toast-height` 使用了 `scrollHeight`，在 `box-sizing: border-box` 下丢失了上下各 1px（共 2px）的发丝边框尺寸，展开到位瞬间偶发 2px 抖动；
  3. **焦点环 Fallback 缺失**:
     `.closeButton:focus-visible` 直接引用 `box-shadow: var(--focus-ring)`，若上层 token 缺失则完全无焦点指示，违反 AGENTS.md §13 规范。
- **极致修复方案**:
  居中类改为 `left: calc(50% - 190px); transform: none;`；测量时补充 2px 边框补偿；焦点环补齐 3%~6% 柔软半透明 fallback：
  ```css
  /* 修复样式片段 */
  .viewportBottomCenter {
    bottom: 16px;
    left: calc(50% - 190px);
    transform: none;
  }
  .closeButton:focus-visible,
  .actionButton:focus-visible,
  .undoButton:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring, 0 0 0 2px color-mix(in srgb, var(--brand, #10b981) 35%, transparent));
  }
  ```

---

## 审查总结与改进落地指引

经对 `ToastStore`、`ToastViewport`、`ToastCard`、手势 Hooks 及样式系统的全量代码审查，现存代码在 3D 堆叠数学模型设计上具备良好的工程基础，但在**非纯字符串 JSX 消息兼容性**、**DOM 高度测量时机与防抖**、**React Hook 依赖项与定时器生命周期**、**手势状态机死区控制**及**全键盘 WAI-ARIA 无障碍**等维度存在致命性架构断层。

请依照上述 10 项缺陷剖析与极致修复代码逐一实施修复与补丁测试，重点保证 `toast.promise`、JSX 复杂组件通知、多点触控滑动以及全键盘 Tab 导航的稳健性。
