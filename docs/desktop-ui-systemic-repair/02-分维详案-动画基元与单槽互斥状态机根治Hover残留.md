# 02-分维详案-动画基元与单槽互斥状态机根治 Hover 残留

> **归属战役**：`docs/desktop-ui-systemic-repair/`  
> **上级总方案**：[`00-总方案-顶栏单轨同层收敛与Hover提示系统性治理.md`](./00-总方案-顶栏单轨同层收敛与Hover提示系统性治理.md)

---

## 一、维度目标与状态机缺陷穿透

彻底根治 Hover 提示残留（幽灵 Tooltip），杜绝鼠标快速划过、快速离开、连续点击、窗口失焦或滚动后，界面上遗留任何未消退的悬浮气泡。

### 核心并发竞态穿透
```text
[用户行为] 鼠标极快划过元素 A (进入 10ms 后离开)
  │
  ├─ 1. scheduleShow 触发 -> commitShow 执行:
  │      setVisible(true) -> useAnimatedPresence(visible=true)
  │      setState('entering') -> 发起两个嵌套 requestAnimationFrame (打算在第 2 帧转 'open')
  │
  ├─ 2. 10ms 后鼠标移开 -> handleHide 执行:
  │      setVisible(false) -> useAnimatedPresence(visible=false)
  │      触发 useEffect: 由于 exitDurationMs=0 -> 执行 setState('closed')
  │      【致命缺陷】先前排队的嵌套 requestAnimationFrame 未被记录，也从未 cancelAnimationFrame!
  │
  ├─ 3. 下一帧到来 -> 挂起的第二级 requestAnimationFrame 回调强制触发:
  │      无条件执行 setState('open')!
  │      导致内部 state 被颠倒成 'open'，从而 isMounted = (state !== 'closed') = true!
  │
  ├─ 4. Tooltip.tsx 重新渲染:
  │      门控判定: shouldShowTooltip && isMounted && rect ...
  │      【致命缺陷】只判断了 isMounted (true)，未判断 visible!
  │      createPortal 强行在 document.body 挂载 Tooltip DOM!
  │
  ├─ 5. 存活巡检与全局事件守卫:
  │      useEffect([visible]) 第一行就是 if (!visible) return;
  │      【致命缺陷】因为 visible 早已是 false，所有 pointermove 监听和 rAF 自毁循环完全不挂载!
  │
  └─ 6. 全局互斥中枢 claimTooltipSlot:
         其他 Tooltip 激活时调用本幽灵的 entry.hide() -> setVisible(false)
         由于 state.visible 本就是 false，React 判定无变动直接 Bailout!
         【结果】该 Tooltip 成为永久卡死在屏幕上的死锁幽灵，永远无法消失!
```

---

## 二、纯逻辑执行步骤与任务单元

### 任务单元 2.1：`useAnimatedPresence` 动画帧句柄严格追踪与双向取消
- **文件域**：`apps/crish-desktop/src/components/ui/Dialog/useAnimatedPresence.ts`
- **逻辑内容**：
  - 引入 `rafHandlesRef = useRef<number[]>` 记录所有发起的 `requestAnimationFrame` 句柄；
  - 封装统一的 `cancelAllRafs()` 清除函数；
  - 在 `useEffect` 的 cleanup 函数以及当 `visible` 变为 `false` 时，**无条件同步取消所有正在等待的 rAF 句柄**；
  - 在 rAF 回调执行体内增加闭包守卫：验证当前 `visible` 是否依然为 `true`，若已被关闭，绝对禁止调用 `setState('open')`；
  - 当 `exitDurationMs <= 0` 且 `!visible` 时，状态必须立即同步收敛为 `'closed'`。

### 任务单元 2.2：`Tooltip.tsx` Portal 挂载门控强校验与双重保险
- **文件域**：`apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx`
- **逻辑内容**：
  - 重构 Portal 渲染条件（Line 540）：
    ```tsx
    const isVisibleOrExiting = visible || state === 'exiting';
    const canRenderPortal =
      shouldShowTooltip &&
      isVisibleOrExiting &&
      isMounted &&
      rect &&
      isValidDOMRect(rect) &&
      !isTriggerOffscreen(rect);
    ```
    严禁在 `!visible && state !== 'exiting'` 的任何脱水状态下挂载 Portal；
  - 在 `hideImmediate()` 被调用时，不仅执行 `setVisible(false)`，如果处于脱水异常态（`state !== 'closed'`），强制重置内部状态机；
  - 移除在 `handleHide()` 中过早将 `triggerModeRef.current = null` 的行为，确保退出期间的真实性巡检依然能准确读取 `:hover` 伪类状态。

### 任务单元 2.3：`tooltipController.ts` 全局单槽互斥中枢物理净化
- **文件域**：`apps/crish-desktop/src/components/ui/Tooltip/tooltipController.ts`
- **逻辑内容**：
  - 增强 `claimTooltipSlot(id)` 与 `hideAllTooltips()`：
    - 在遍历通知各注册项 `entry.hide()` 的同时，执行全局 DOM 级自愈检查；
    - 若在 `#tooltip-root` 或 `document.body` 中发现 `data-tooltip-portal="true"` 且其对应实例非当前 `activeId`，强制从 DOM 树中物理清理；
  - 确保全局可见 Tooltip 数量严格满足不变式：$\text{visibleCount} \le 1$。

---

## 三、负向红线与验收断言

1. **负向断言（零容忍）**：
   - 严禁任何孤儿 `requestAnimationFrame` 在组件 unmount 或 `visible=false` 后继续回调；
   - 严禁界面上同时出现 2 个或以上带有 `data-tooltip-portal="true"` 的 DOM 节点；
   - 严禁在光标移开后，DOM 树残留任何计算样式为 `display: none` 或 `opacity: 0` 的废弃 Tooltip 容器。
2. **正向验收断言**：
   - 经由测试脚本在 100ms 内对 10 个按钮进行高频连续的 `mouseEnter -> mouseLeave` 扫射，最终留在 DOM 树中的 Tooltip 数量必须严格为 0；
   - 正常停留满 350ms 的 Tooltip 在光标移出时，必须在 $\le 16\text{ms}$ 内从 DOM 树中彻底剥离。
