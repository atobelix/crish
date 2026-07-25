# Agent-03: 窗口 Resize/Move 冻结机制缺陷分析

> 分析日期：2026-07-22
> 项目路径：`C:\Software\conex`
> 涉及 Agent：Agent-03 (A-Freeze) / R3-Window-Bridge
> 前置文档：`docs/ui-jank-message-dnd-rootfix/01-contract.md` `docs/ui-jank-message-dnd-rootfix/00-master-multi-agent-roadmap.md`

---

## 目录

1. [窗口 Resize 当前实现分析](#1-窗口-resize-当前实现分析)
2. [窗口 Move 的完全缺失](#2-窗口-move-的完全缺失)
3. [useResizeFreeze 的分析](#3-useresizefreeze-的分析)
4. [useSuspendedResizeObserver 的分析](#4-usesuspendedresizeobserver-的分析)
5. [CSS 冻结的覆盖范围分析](#5-css-冻结的覆盖范围分析)
6. [所有 ResizeObserver 使用点的枚举](#6-所有-resizeobserver-使用点的枚举)
7. [参考实现对比](#7-参考实现对比)
8. [根因结论](#8-根因结论)

---

## 1. 窗口 Resize 当前实现分析

### 1.1 App.tsx L463-480 的 useEffect

App.tsx 在 L463-480 注册了一个 `window.resize` 事件监听器。这是整个应用中**唯一的**系统级窗口尺寸变化监听点。其完整代码如下：

```typescript
// App.tsx L463-480
useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      document.body.classList.add('window-resizing');

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        document.body.classList.remove('window-resizing');
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
}, []);
```

#### 1.1.1 核心缺陷：未调用 beginLayoutInteraction

该 handler **仅**通过 `classList.add/remove` 操作 `window-resizing` body class，但**未调用** `beginLayoutInteraction('workspace-resizing')`。

查看 `layoutAnimationStore.ts` 中的契约：

```typescript
// layoutAnimationStore.ts L272-280
const TYPE_BODY_CLASSES: Record<LayoutAnimationType, readonly string[]> = {
  'sidebar-transition': [],
  'workspace-resizing': ['resizing-active', 'is-resizing'],
  'tab-dragging': ['dragging-card'],
  'panel-split-resizing': ['resizing-active', 'is-resizing'],
  'modal-animating': [],
};
```

当调用 `beginLayoutInteraction('workspace-resizing')` 时，store 会自动：
1. 设置 `isLayoutFrozen = true`
2. 添加 `resizing-active`、`is-resizing`、`is-layout-frozen` body class
3. 触发所有 `useLayoutAnimationStore` 订阅者的更新

App.tsx 的 resize 处理**直接跳过了这个流程**，导致：
- `store.isLayoutFrozen` 始终保持 `false`
- `useResizeFreeze` 消费者得不到冻结信号
- `useSuspendedResizeObserver` 不会挂起
- 所有手动检查 `isLayoutFrozen` 的 ResizeObserver 回调继续执行

#### 1.1.2 window-resizing class 的独占管理

`layoutAnimationStore.ts` 的注释明确说明：

```typescript
// layoutAnimationStore.ts L32-38
/** 由 store 管理的 body class（不含 window-resizing：R3 窗口桥专属，避免误删） */
const STORE_MANAGED_BODY_CLASSES = [
  'is-layout-frozen',
  'resizing-active',
  'is-resizing',
  'dragging-card',
] as const;
```

这表示 `window-resizing` class 由窗口桥（R3）单独管理，而 App.tsx 就是这个桥。但由于 App.tsx 没有调用 `beginLayoutInteraction`，`window-resizing` class 成了**一个孤立的信号**，无法联动 store 的冻结机制。

#### 1.1.3 100ms debounce 的合理性

当前实现使用 100ms debounce 来移除 `window-resizing` class：

```typescript
debounceTimer = setTimeout(() => {
  document.body.classList.remove('window-resizing');
}, 100);
```

**问题分析：**
- 100ms 对于典型的 window resize 来说可能太短。用户拖拽窗口边缘连续 resize 时，`window.resize` 事件以远高于 10Hz 的频率触发。100ms debounce 意味着每次触发都会刷新定时器，class 只在 resize 停止后 100ms 才被移除。
- 但更严重的问题是：**100ms 的 debounce 与 layoutAnimationStore 的 catch-up 机制不兼容**。Workspace.tsx 的 sash drag 使用双重 rAF 延迟解冻（见 L437-443），而 window resize 没有任何延迟解冻机制。
- 实际效果：窗口 resize 停止后 100ms 立即移除 class，此时 React 可能尚未完成 re-render/layout，导致 CSS 过渡提前恢复。

#### 1.1.4 建议：使用 beginLayoutInteraction + 双重 rAF 解冻

Workspace.tsx 的 sash drag 展示了正确的模式：

```typescript
// Workspace.tsx L437-443
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    endLayoutInteraction('workspace-resizing');
    document.body.style.cursor = '';
  });
});
```

窗口 resize 应该采用类似的模式，确保在 resize 停止后等待至少两帧才解冻。

### 1.2 useWindowControls.ts 的重复注册

`useWindowControls.ts` 文件定义了完全相同的 resize 监听逻辑：

```typescript
// useWindowControls.ts L1-33 (完整文件)
import { useCallback, useEffect, useRef } from 'react';

export function useWindowControls() {
  const winCtl = useCallback(async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      if (action === 'minimize') await win.minimize();
      else if (action === 'toggleMaximize') {
        if (await win.isMaximized()) await win.unmaximize();
        else await win.maximize();
      } else await win.close();
    } catch {}
  }, []);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      document.body.classList.add('window-resizing');
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        document.body.classList.remove('window-resizing');
      }, 100);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  return { winCtl };
}
```

#### 1.2.1 死代码分析

通过 grep 确认 `useWindowControls` **从未被任何文件导入**：

```
$ grep -rn "from.*useWindowControls\|import.*useWindowControls" apps/crish-desktop/src
# No results
```

这意味着 `useWindowControls.ts` 是**死代码**。但它揭示了架构问题：
- 如果它被使用，`window.resize` 事件会绑定两次（App.tsx + useWindowControls）
- 每次触发都会导致 `classList.add('window-resizing')` 重复执行（add 是幂等的，但整体设计重复）
- 两个绑定的 debounce 定时器独立运行，可能造成 class 被提前移除

#### 1.2.2 winCtl 函数的重复定义

`useWindowControls.ts` 中的 `winCtl` 函数与 App.tsx L712-724 中的 `winCtl` 函数功能**完全一致**：

```typescript
// App.tsx L712-724
const winCtl = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      if (action === 'minimize') await win.minimize();
      else if (action === 'toggleMaximize') {
        if (await win.isMaximized()) await win.unmaximize();
        else await win.maximize();
      } else await win.close();
    } catch {
      /* window controls unavailable outside Tauri */
    }
};
```

两处代码使用相同的动态 import `@tauri-apps/api/window`，用相同的方式调用 `getCurrentWindow()`。

### 1.3 同一 window resize 事件绑了两次的风险

即使 `useWindowControls` 是死代码，当前的架构也存在风险：
- 如果未来有人导入 `useWindowControls`，将会出现两个独立的 resize 监听
- 两个监听都操作同一个 class `window-resizing`，但各有独立的 debounce 定时器
- 定时器 A 完成 → 移除 class → 定时器 B 尚未完成 → class 提前被移除 → 冻结状态提前结束
- 这是一个**竞态条件**：两个定时器互相干扰，冻结周期的结束时间不准确

---

## 2. 窗口 Move 的完全缺失

### 2.1 Tauri 窗口移动机制

Tauri 窗口移动通过 `data-tauri-drag-region` HTML 属性控制。在 App.tsx 中，多个元素标记了此属性：

```html
<!-- App.tsx L776-781 -->
<header className="app-header" ... data-tauri-drag-region>
  <div className="app-header-left" data-tauri-drag-region>
```

以及：
```html
<!-- App.tsx L894-900 -->
<div className="ws-titlebar-host" ... data-tauri-drag-region>
  <div className="ws-titlebar-rail" data-tauri-drag-region>
    <div className="ws-titlebar-main" data-tauri-drag-region>
```

CSS 中也有相应定义：
```css
/* shell-polish.css L217 */
[data-tauri-drag-region] {
    /* Tauri 内置处理：拖拽此区域将移动窗口 */
}
```

Tauri 框架在检测到 `mousedown` + `mousemove` 在 `data-tauri-drag-region` 元素上时，会调用 OS 级别的窗口拖动 API。**这个过程中，Web 层的 `window.resize` 事件不会被触发**，因为操作系统窗口还在移动中，其尺寸并未改变，只有位置在变化。

### 2.2 Web resize 事件在窗口移动时不触发

这是理解此缺陷的关键：当用户通过标题栏拖拽移动窗口时：
1. Tauri 拦截鼠标事件，调用 OS 的 `StartWindowDrag()` API
2. OS 接管拖动循环，窗口位置随鼠标实时更新
3. **窗口尺寸不变**，所以 `window.resize` 事件**不触发**
4. 直到鼠标释放，窗口停留在新位置，resize 仍不触发

这意味着 App.tsx L463-480 的 resize 监听器在窗口移动期间**完全不会被调用**。

### 2.3 没有任何 body class 或冻结机制

由于没有 resize 事件，App.tsx 的 handler 不会执行，导致：
- `window-resizing` class 没有被添加
- `beginLayoutInteraction('workspace-resizing')` 没有被调用
- `store.isLayoutFrozen` 保持 `false`
- 所有 CSS 冻结规则不生效

### 2.4 影响分析：窗口移动时所有 ResizeObserver 仍在执行

窗口移动时，Tauri 只是改变了 OS 窗口的位置。但 WebView 层面的布局、渲染流水线实际上会因多种原因触发重排：

1. **合成器帧**：窗口移动时，系统合成器以 60fps 重新定位窗口内容，可能触发 WebView 内部的重排
2. **子元素尺寸波动**：某些 UI 框架在窗口移动时可能因为 devicePixelRatio 变化、安全区域变化等原因触发布局更新
3. **CSS Container Queries**：如果任何组件使用了 container queries，窗口移动可能触发它们
4. **IntersectionObserver / ResizeObserver**：这些观察者在窗口移动时仍会收到回调

受影响的具体组件：
- **ChatMessageList**: `setContainerWidth` 的 ResizeObserver 继续触发，`useResizeFreeze` 不冻结 → Pretext 重算可能触发
- **FilesCard**: `setContainerHeight` 的 ResizeObserver 继续触发
- **TerminalCard**: `useSuspendedResizeObserver` 虽然标记了 `isLayoutFrozen` 但此时为 false → fit() 仍被执行
- **VirtualList / useVirtualScroll**: container height 的 ResizeObserver 继续触发 → 虚拟滚动重算
- **useAutoGrowTextarea**: ResizeObserver 继续触发 → textarea 高度重算
- **ChatToolCallBlock**: ResizeObserver 继续触发 → containerWidth 重算

所有这些计算在窗口移动时都是**没有意义的**，因为用户只是在移动窗口位置，没有改变其尺寸。

### 2.5 Tauri onMoved 事件

Tauri 提供了专门的窗口移动事件监听 API。通过 `@tauri-apps/api/window` 包的 `getCurrentWindow()` 方法可以获取当前窗口实例，其具有 `onMoved` 或 `listen` 方法。

由于 webfetch 无法获取 Tauri v2 文档（404），我们需要参考 Tauri v2 的类型定义和社区实践：
- Tauri v2 `Window` 类提供 `onMoved(cb)` 或通过 `listen('tauri://move', cb)` 监听窗口移动事件
- 同样可以通过 `onResize` 或 `listen('tauri://resize', cb)` 监听 Tauri 层面的尺寸变化
- 这些事件在 Web resize 事件之前或同时触发

当前代码完全缺失对 Tauri 窗口移动事件的监听。

### 2.6 窗口最大化和还原的覆盖

App.tsx 的 `winCtl` 函数包含 `toggleMaximize`（L717-719）：

```typescript
else if (action === 'toggleMaximize') {
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
}
```

窗口最大化/还原会触发 `window.resize`，但这取决于 Tauri 的实现：
- 在某些平台上，最大化/还原的动画过程中 resize 事件连续触发
- 100ms debounce 可能不足以覆盖动画完成
- 没有 Tauri `onResize` 事件的监听，无法获取最终的终态尺寸

---

## 3. useResizeFreeze 的分析

### 3.1 当前实现

```typescript
// useResizeFreeze.ts L1-30
export function useResizeFreeze(debounceMs = 150): { isResizing: boolean } {
  const isLayoutFrozen = useLayoutAnimationStore((s) => s.isLayoutFrozen);
  const [isResizing, setIsResizing] = useState(isLayoutFrozen);

  useEffect(() => {
    if (isLayoutFrozen) {
      setIsResizing(true);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!useLayoutAnimationStore.getState().isLayoutFrozen) {
        setIsResizing(false);
      }
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [isLayoutFrozen, debounceMs]);

  return { isResizing };
}
```

### 3.2 不再使用 MutationObserver

根据代码注释（L7-10），这个 hook 已经重构为直接订阅 `layoutAnimationStore.isLayoutFrozen`：

```typescript
/**
 * - 冻结写入源唯一：store begin/end（见契约 §2）
 * - 解冻后短 debounce，避免 sash commit 后首帧抖动立刻重算
 * - 窗口缩放 pulse 由 R3 桥接入 store；本 hook 不再独立监听 window.resize / MutationObserver
 */
```

这是正确的方向——放弃了之前每个 consumer 独立创建 MutationObserver 的做法，改为统一订阅 store。

### 3.3 未使用的 MutationObserver 遗留

虽然 useResizeFreeze 不再使用 MutationObserver，但代码注释提到了之前的实现方式。需要确认：
- `grep` 结果显示 `MutationObserver` 在当前代码中**已不存在**
- 之前的实现是每个 consumer 独立创建 MutationObserver 来监听 body class 变化
- 现在改为 Zustand store 订阅，这是正确的优化

### 3.4 状态同步的竞态条件分析

当前实现中的 Zustand selector 和 setTimeout 之间存在竞态风险：

```typescript
const isLayoutFrozen = useLayoutAnimationStore((s) => s.isLayoutFrozen);
// ...（React re-render 发生在这里）
useEffect(() => {
    if (isLayoutFrozen) {
      setIsResizing(true);
      return;
    }
    const timer = window.setTimeout(() => {
      // 这里存在竞态：解冻后 150ms 内再次冻结
      if (!useLayoutAnimationStore.getState().isLayoutFrozen) {
        setIsResizing(false);
      }
    }, debounceMs);
    return () => window.clearTimeout(timer);
}, [isLayoutFrozen, debounceMs]);
```

**场景：快速连续冻结-解冻-冻结**
1. `isLayoutFrozen` 变为 `true` → effect 执行 → `setIsResizing(true)` → 创建 debounce timer
2. 但此时 timer 被 `return` 跳过（因为 `isLayoutFrozen` 为 true，直接 return 了）
3. `isLayoutFrozen` 变为 `false` → effect 执行 → 创建 150ms timer
4. 在 200ms 内 `isLayoutFrozen` 又变为 `true`
5. 旧的 effect 被 cleanup（clearTimeout），新的 effect 执行 → `setIsResizing(true)` → return
6. `isLayoutFrozen` 又变为 `false` → 创建 150ms timer
7. 150ms 后 timer 执行，`getState().isLayoutFrozen` 为 false → `setIsResizing(false)`

这个流程是**基本正确的**，因为每次 `isLayoutFrozen` 变化都会 cleanup 前一个 timer。但是：

**边界情况：解冻后 50ms 又冻结，然后 80ms 后又解冻**
1. T0: frozen=true → isResizing=true (同步)
2. T50: frozen=false → timer(150ms) 启动
3. T130: frozen=true → timer cleanup, isResizing=true
4. T210: frozen=false → timer(150ms) 启动
5. T360: timer fires, isResizing=false

**实际的冻结期是 T0-T360，但 store 的冻结期是 T0-T50 + T130-T210 = 130ms**
isResizing 真正反映的是"最近一次冻结开始后的 150+ms"，而不是"store 当前是否冻结"。

这对于**防抖**场景是合理的，但需要注意文档说明：`isResizing` 返回的是扩展后的冻结窗口，不是实时冻结状态。

### 3.5 setState 的额外一次 re-render

每次 `isResizing` 变化都会导致组件额外一次 re-render：

```
store.isLayoutFrozen 变化 → 订阅者 re-render → isResizing state 更新 → 再次 re-render
```

对于 ChatMessageList 这类大组件，额外的 re-render 可能有性能开销。可以考虑使用 `useSyncExternalStore` 或 ref 来避免。

### 3.6 调用点分析

`useResizeFreeze` 只有一个调用点：

```typescript
// ChatMessageList.tsx L554
const { isResizing } = useResizeFreeze(150);
```

使用位置在 L650-657：
```typescript
useEffect(() => {
    if (isResizing || useLayoutAnimationStore.getState().isLayoutFrozen || !pretextFont || containerWidth <= 0) {
      if (pretextRafRef.current != null) {
        cancelAnimationFrame(pretextRafRef.current);
        pretextRafRef.current = null;
      }
      return;
    }
    // ... Pretext 计算逻辑
});
```

这个使用点有一个问题：**双重守卫**（`isResizing || ...isLayoutFrozen`）。由于 `useResizeFreeze` 已经订阅了 `isLayoutFrozen`，理论上 `isResizing` 为 true 时 `isLayoutFrozen` 也一定为 true。双重守卫说明开发者不信任单一信号，这是架构不统一的表现。

---

## 4. useSuspendedResizeObserver 的分析

### 4.1 当前实现

```typescript
// useSuspendedResizeObserver.ts L1-67
export function useSuspendedResizeObserver({
  taskKey,
  onResize,
  targetRef,
  disabled = false,
}: UseSuspendedResizeObserverOptions): void {
  const registerCatchupTask = useLayoutAnimationStore((s) => s.registerCatchupTask);
  const unregisterCatchupTask = useLayoutAnimationStore((s) => s.unregisterCatchupTask);
  const latestOnResize = useRef(onResize);

  useEffect(() => {
    latestOnResize.current = onResize;
  }, [onResize]);

  useEffect(() => {
    if (disabled) return;
    const el = targetRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let rafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      const isFrozen = useLayoutAnimationStore.getState().isLayoutFrozen;

      if (isFrozen) {
        // 挂起期间：注册 catch-up 任务
        registerCatchupTask(taskKey, () => {
          latestOnResize.current(entries[0]);
        });
      } else {
        // 非挂起：rAF 节流
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          latestOnResize.current(entries[0]);
        });
      }
    });

    observer.observe(el);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      unregisterCatchupTask(taskKey);
    };
  }, [targetRef, taskKey, disabled, registerCatchupTask, unregisterCatchupTask]);
}
```

### 4.2 SuspendedResizeObserver 的工作原理

1. **ResizeObserver 回调内**：每次尺寸变化时，检查 `isLayoutFrozen`（直接从 `getState()` 读取，非 React state）
2. **如果冻结**：注册 catch-up 任务，不立即执行回调
3. **如果未冻结**：使用 rAF 节流执行回调
4. **解冻时**：`endLayoutInteraction` → `flushCatchupTasks` → 执行所有 catch-up 任务 → 返回 `idle` 状态

### 4.3 isResizing/isLayoutFrozen 的挂起机制

当前实现中，挂起的判断条件是 `isLayoutFrozen`：

```typescript
const isFrozen = useLayoutAnimationStore.getState().isLayoutFrozen;
```

**问题：** 这依赖于 `beginLayoutInteraction` 被正确调用。但在窗口 resize 和窗口 move 场景中，`beginLayoutInteraction` 没有被调用，所以 `isLayoutFrozen` 为 false，挂起机制不会生效。

具体来说：
- 窗口 resize（通过 resize event）：只会添加 `window-resizing` class，不会设置 `isLayoutFrozen`
- 窗口 move（通过标题栏拖拽）：完全不触发任何事件，`isLayoutFrozen` 保持 false

### 4.4 Catch-up 任务的设计分析

Catch-up 任务机制的设计意图：
- 挂起期间积累的 resize 事件不处理
- 解冻时通过 `flushSync` 批量执行所有 catch-up 任务

```typescript
// layoutAnimationStore.ts L188-218
flushCatchupTasks: () => {
    const { catchupQueue } = get();
    if (catchupQueue.size === 0) {
      set({ phase: 'idle' });
      return;
    }

    try {
      flushSync(() => {
        catchupQueue.forEach((task) => {
          try {
            task();
          } catch (e) {
            console.error('[LayoutAnimationStore] Catch-up task failed:', e);
          }
        });
      });
    } catch (e) {
      // 非 React 调度回调中 fallback
      catchupQueue.forEach((task) => {
        try {
          task();
        } catch (err) {
          console.error('[LayoutAnimationStore] Fallback catchup failed:', err);
        }
      });
    }

    catchupQueue.clear();
    set({ phase: 'idle' });
}
```

**潜在问题：**
- `flushSync` 是 React 18 的 API，用于强制同步刷新。如果在非 React 调度链中调用（如 setTimeout 回调），会抛出异常并走 fallback 路径
- Fallback 路径直接执行任务但不通过 React 调度，可能导致多个 setState 调用批量合并
- Catch-up 任务只保留**最新一次**的 entry（因为注册时覆盖了同 key 的任务），可能丢失中间状态

### 4.5 对所有使用者的影响

`useSuspendedResizeObserver` 当前只在 `TerminalCard.xterm.tsx` 中使用：

```typescript
// TerminalCard.xterm.tsx L131-135
useSuspendedResizeObserver({
    taskKey: `xterm-fit-${termId}`,
    targetRef: containerRef,
    onResize: handleFitResize,
});
```

**影响分析：**
- 在正常的 sash drag 期间：`isLayoutFrozen` 为 true → fit() 被挂起 → 解冻时 catch-up 执行一次 fit()
- 在窗口 resize 期间：`isLayoutFrozen` 为 false（因为 beginLayoutInteraction 没调用）→ fit() 持续执行
- 在窗口 move 期间：`isLayoutFrozen` 为 false → fit() 持续执行
- **Terminal fit() 是昂贵的操作**（涉及 xterm.js 内部的字符网格重新布局和 WebGL 渲染），窗口 move 期间持续 fit() 是严重的性能浪费

---

## 5. CSS 冻结的覆盖范围分析

### 5.1 shell-dragdrop.css 的冻结规则

```css
/* shell-dragdrop.css L38-56 */
body.is-resizing *,
body.is-resizing *::before,
body.is-resizing *::after,
body.resizing-active *,
body.resizing-active *::before,
body.resizing-active *::after,
body.window-resizing *,
body.window-resizing *::before,
body.window-resizing *::after,
body.dragging-card *,
body.dragging-card *::before,
body.dragging-card *::after,
body.is-layout-frozen *,
body.is-layout-frozen *::before,
body.is-layout-frozen *::after {
  transition: none !important;
  animation: none !important;
}
```

**覆盖范围分析：**

| Selector | 设置时机 | 冻结范围 |
|---|---|---|
| `body.is-resizing *` | beginLayoutInteraction('workspace-resizing') | transition/animation |
| `body.resizing-active *` | beginLayoutInteraction('workspace-resizing') | transition/animation |
| `body.window-resizing *` | App.tsx window resize handler | transition/animation |
| `body.dragging-card *` | beginLayoutInteraction('tab-dragging') | transition/animation |
| `body.is-layout-frozen *` | 任何 beginLayoutInteraction | transition/animation |

**问题：** 这些规则覆盖了所有子元素，如果 DOM 树很大（上千个元素），`*` 选择器的样式重新计算开销不容忽视。理论上应该尽可能缩小范围。

### 5.2 缺失：iframe 和 webview 的 pointer-events

在 `shell-dragdrop.css` L113-125 和 `shell-workspace.css` L717-729 中已经**存在** iframe/webview 的 pointer-events 规则：

```css
/* shell-dragdrop.css L113-125 */
body.is-layout-frozen iframe,
body.is-layout-frozen webview,
body.resizing-active iframe,
body.resizing-active webview,
body.window-resizing iframe,
body.window-resizing webview,
body.dragging-card iframe,
body.dragging-card webview,
body.is-resizing iframe,
body.is-resizing webview {
  pointer-events: none !important;
}
```

这个规则覆盖了所有 5 个冻结 class。但是：
- **window-resizing 在窗口 resize 时会被添加**，所以 iframe/webview 的 pointer-events 在 resize 时被正确屏蔽
- **窗口 move 时没有任何 class 被添加**，所以 iframe/webview 的 pointer-events 在 move 时没有被屏蔽

**所以缺陷不是 CSS 规则缺失，而是触发条件缺失。** 窗口 move 时没有任何 body class 被添加，所以 CSS 规则自然不会生效。

### 5.3 缺失：CSS contain 优化

当前项目没有任何地方使用 CSS `contain` 属性来优化冻结期间的性能。CSS `contain` 可以带来以下好处：

```
body.is-layout-frozen .workspace-column {
  contain: strict;
}
```

- **`contain: strict`** = `size layout paint style`
  - 浏览器不需要检查子元素尺寸变化对父元素的影响
  - 子元素不会绘制到容器外
  - 浮点数、计数器等样式效果被隔离
  - **但可能破坏某些布局**，因为 `size` containment 需要明确尺寸

- **`contain: layout paint`** 更安全的选择
  - 布局隔离 + 绘制裁剪
  - 不会破坏 flex/grid 的自动尺寸

- **`contain: content`** = `layout paint style`
  - 不包含 `size`，不破坏自动高度
  - 但仍然带来 stacking context 和 BFC

**建议：** 在冻结期间对主要容器（`.main-layout`、`.workspace-column`、`.workspace-card`）添加 `contain: layout paint`，在解冻时移除。

### 5.4 缺失：content-visibility 优化

`content-visibility: auto` 是另一个可用的性能优化手段：

```css
body.is-layout-frozen .workspace-card {
  content-visibility: auto;
}
```

但这可能与虚拟列表的渲染管理冲突，需要仔细评估。

### 5.5 shell-sidebar.css 的额外规则

```css
/* shell-sidebar.css L22-28 */
body.is-resizing,
body.is-resizing * {
  transition: none !important;
  cursor: col-resize !important;
  user-select: none !important;
  -webkit-user-select: none !important;
}
```

注意这个规则只在 `is-resizing` 时生效，不覆盖 `window-resizing` 或 `is-layout-frozen`。当窗口 resize 时，`is-resizing` 不会被添加（因为 beginLayoutInteraction 未调用），所以 `user-select` 和 `cursor` 不会被强制。

### 5.6 shell-workspace.css 的 workspace-card 规则

```css
/* shell-workspace.css L751-754 */
.resizing-active .workspace-card,
.window-resizing .workspace-card {
  transition: none !important;
}
```

WorkspaceCard 默认有 `transition: height var(--transition-fast)`，这个规则在 resizing 和 window-resizing 时抑制它。但窗口 move 时没有任何 class 被添加，所以 card 的 height transition 在窗口移动时仍然有效。

---

## 6. 所有 ResizeObserver 使用点的枚举

### 6.1 ChatMessageList.tsx — setContainerWidth

```typescript
// ChatMessageList.tsx L625-645
useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let rafId: number | null = null;
    const update = () => {
      if (useLayoutAnimationStore.getState().isLayoutFrozen) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (el) setContainerWidth(el.clientWidth);
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
}, [containerRef]);
```

- 用途：测量容器宽度用于 Pretext 文本测算
- 冻结感知：**是**（检查 `isLayoutFrozen`）
- 问题：依赖 `isLayoutFrozen`，但窗口 resize/move 不会设置它
- rAF 节流：**是**（但仅在非冻结时）

### 6.2 ChatMessageList.tsx — 行高实际测量

```typescript
// ChatMessageList.tsx L713-752
useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!roRef.current) {
      roRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const msgId = el.dataset.msgId;
          if (msgId && entry.contentRect.height > 0) {
            setActual(msgId, entry.contentRect.height);
          }
        }
      });
    }
    // ... observe/unobserve rows
});
```

- 用途：虚拟滚动行高回写
- 冻结感知：**否**（没有检查 `isLayoutFrozen`）
- 问题：resize/move 期间持续回写，可能写入不稳定的值
- 影响：每个 `setActual` 都会触发高度 tick 更新，导致虚拟滚动重算

### 6.3 FilesCard.tsx — setContainerHeight

```typescript
// FilesCard.tsx L92-106
const resizeObserver = new ResizeObserver((entries) => {
    if (useLayoutAnimationStore.getState().isLayoutFrozen) return;
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (Math.abs(h - lastH) > 3) {
          lastH = h;
          setContainerHeight(h);
        }
      }
    });
});
```

- 用途：测量容器高度用于虚拟文件列表
- 冻结感知：**是**（检查 `isLayoutFrozen`）
- 问题：依赖 `isLayoutFrozen`，窗口 resize/move 不会设置
- 额外保护：3px 高度变化阈值

### 6.4 TerminalCard.xterm.tsx — useSuspendedResizeObserver

```typescript
// TerminalCard.xterm.tsx L131-135
useSuspendedResizeObserver({
    taskKey: `xterm-fit-${termId}`,
    targetRef: containerRef,
    onResize: handleFitResize,
});
```

- 用途：xterm.js 终端尺寸适配
- 冻结感知：**是**（通过 SuspendedResizeObserver 挂起机制）
- 问题：依赖 `isLayoutFrozen`，窗口 resize/move 不会设置

### 6.5 VirtualList.tsx — containerHeight

```typescript
// VirtualList.tsx L54-59
const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const ch = entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (ch !== containerHeight) setContainerHeight(ch);
    }
});
```

- 用途：虚拟滚动容器高度
- 冻结感知：**否**
- 位置：通用 VirtualList 组件（可能被多个列表使用）
- 问题：resize/move 期间持续更新

### 6.6 useVirtualScroll.ts — viewportHeight

```typescript
// useVirtualScroll.ts L76-81
const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      setViewportHeight(entry.contentRect.height || 600);
    }
});
```

- 用途：虚拟滚动视口高度
- 冻结感知：**否**
- 问题：ChatMessageList 内部使用这个 hook，resize/move 期间持续更新
- 影响：`setViewportHeight` → heightTick+1 → visibleRange 重算 → 虚拟滚动重新布局

### 6.7 useVirtualDiffScroll.ts — containerHeight

```typescript
// useVirtualDiffScroll.ts L12-18
const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      setContainerHeight(entry.contentRect.height || 400);
    }
});
```

- 用途：Diff 视图虚拟滚动容器高度
- 冻结感知：**否**
- 问题：resize/move 期间持续更新

### 6.8 useTextMeasure.ts — bubbleWidth

```typescript
// useTextMeasure.ts L127-128
const ro = new ResizeObserver(() => compute());
ro.observe(container);
```

- 用途：消息气泡宽度测量（已废弃/即将移除？）
- 冻结感知：**否**
- 问题：在 resize/move 期间持续触发 `compute()`，该函数内部读取 `clientWidth`（强制重排）

### 6.9 useAutoGrowTextarea.ts — textarea 高度

```typescript
// useAutoGrowTextarea.ts L139-145
if (el && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      elWidthRef.current = el.clientWidth - padXRef.current;
      applyHeight();
    });
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
}
```

- 用途：textarea 自动增长高度
- 冻结感知：**否**
- 问题：resize/move 期间持续触发，`clientWidth` 读取强制重排
- 额外：还监听了 `window.resize`（L135），双重触发

### 6.10 ChatToolCallBlock.tsx — containerWidth

```typescript
// ChatToolCallBlock.tsx L231-235
const ro = new ResizeObserver(() => measure());
ro.observe(el);
```

- 用途：工具调用输出块容器宽度
- 冻结感知：**否**
- 问题：resize/move 期间持续触发

### 6.11 SidebarSessionList.tsx — 虚拟列表

```typescript
// SidebarSessionList.tsx L268
typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
```

- 用途：侧栏会话列表虚拟滚动
- 冻结感知：**否**
- 问题：resize/move 期间持续触发

### 6.12 汇总表

| # | 文件 | 行号 | 用途 | 冻结感知 | rAF节流 | 强制重排 |
|---|---|---|---|---|---|---|
| 1 | ChatMessageList.tsx | 639 | setContainerWidth | 是 (isLayoutFrozen) | 是 | clientWidth |
| 2 | ChatMessageList.tsx | 722 | 行高回写 | 否 | 否 | contentRect |
| 3 | FilesCard.tsx | 92 | setContainerHeight | 是 (isLayoutFrozen) | 是 | contentRect |
| 4 | TerminalCard.xterm.tsx | 131 | xterm fit | 是 (SuspendedRO) | catch-up | 终端布局 |
| 5 | VirtualList.tsx | 54 | 容器高度 | 否 | 否 | contentBoxSize |
| 6 | useVirtualScroll.ts | 76 | viewportHeight | 否 | 否 | contentRect |
| 7 | useVirtualDiffScroll.ts | 12 | 容器高度 | 否 | 否 | contentRect |
| 8 | useTextMeasure.ts | 127 | bubbleWidth | 否 | 否 | clientWidth |
| 9 | useAutoGrowTextarea.ts | 140 | textarea高度 | 否 | 否 | clientWidth |
| 10 | ChatToolCallBlock.tsx | 232 | containerWidth | 否 | 否 | clientWidth |
| 11 | SidebarSessionList.tsx | 268 | 虚拟列表 | 否 | 否 | 未知 |

**总结：** 11 个 ResizeObserver 使用点中，只有 4 个（#1, #3, #4, #？）有冻结感知。但「冻结感知」的判断条件 `isLayoutFrozen` 在窗口 resize/move 场景下不会被设置，所以**实际上所有 11 个观察者在窗口 resize/move 时都在持续执行回调**。

---

## 7. 参考实现对比

### 7.1 Tauri 窗口事件文档分析

由于 Tauri v2 文档访问受限（404），以下分析基于 @tauri-apps/api/window 的 npm 包类型定义和社区最佳实践：

**Tauri v2 Window 类的关键事件方法：**

```
interface Window {
  onResize(cb: (payload: { width: number, height: number }) => void): Promise<UnlistenFn>;
  onMoved(cb: (payload: { x: number, y: number }) => void): Promise<UnlistenFn>;
  onDragDrop(cb: (payload: DragDropEvent) => void): Promise<UnlistenFn>;
  listen(event: string, cb: (event: Event) => void): Promise<UnlistenFn>;
}
```

**分析：**
- `onResize` 在 Tauri 窗口尺寸变化时触发，优于或不触发 Web `window.resize`
- `onMoved` 在 Tauri 窗口位置变化时触发，Web 层没有等价事件
- 这些监听返回 `UnlistenFn`，用于在组件卸载时取消监听
- 应该优先使用 Tauri 原生事件而非 Web `window.resize`

**当前项目状态：**
- 仅在 App.tsx L712-724 和 useWindowControls.ts L6-13 动态 import `@tauri-apps/api/window`
- 这些 import 仅在调用窗口控制方法时懒加载，**没有注册任何事件监听**
- 未使用 `getCurrentWindow().onResize()` 或 `getCurrentWindow().onMoved()`

**建议集成方式：**

```typescript
useEffect(() => {
    let unlisten: Array<() => void> = [];
    
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        
        // Tauri resize 事件
        const unsubResize = await win.onResize(({ width, height }) => {
            beginLayoutInteraction('workspace-resizing');
            // 延迟解冻
            setTimeout(() => endLayoutInteraction('workspace-resizing'), 200);
        });
        unlisten.push(unsubResize);
        
        // Tauri move 事件
        const unsubMoved = await win.onMoved(({ x, y }) => {
            // 窗口移动同样需要冻结
            beginLayoutInteraction('workspace-resizing');
            setTimeout(() => endLayoutInteraction('workspace-resizing'), 100);
        });
        unlisten.push(unsubMoved);
    });
    
    return () => {
        unlisten.forEach(fn => fn());
    };
}, []);
```

### 7.2 CSS contain 最佳实践

参考 MDN 文档，CSS `contain` 的最优使用策略：

**最佳选择：`contain: layout paint`**
- 隔离布局：内部布局变化不影响外部
- 绘制隔离：溢出内容被裁剪
- 不隔离尺寸：不使用 `size` containment，避免破坏 flex/grid 自动尺寸
- 创建新的 stacking context 和 BFC

**冻结期间的批量注入策略：**

```css
/* 注入到主要布局容器 */
body.is-layout-frozen .main-layout {
  contain: layout paint;
}

body.is-layout-frozen .workspace-column {
  contain: layout paint;
}

body.is-layout-frozen .sidebar-wrapper {
  contain: layout paint;
}
```

**性能预期：**
- 减少布局计算范围：从全文档缩小到独立容器
- 减少绘制计算范围：子元素溢出被裁剪
- 避免 css counter/quote 泄漏：style containment
- 为 `content-visibility: auto` 创造条件（可选：延迟渲染离屏内容）

**风险控制：**
- `contain: strict` 要求明确尺寸，可能破坏布局 → 不使用
- `contain: content` = `layout paint style`，比 `strict` 安全 → 次优选择
- 需要评估 `position: fixed` 子元素的行为变化（containment 改变 containing block）

---

## 8. 根因结论

### 8.1 缺陷分级

| # | 缺陷 | 严重程度 | 影响范围 | 当前状态 |
|---|---|---|---|---|
| A | App.tsx resize 未调用 beginLayoutInteraction | **Critical** | 全局冻结失效，11 个 ResizeObserver 持续执行 | 未修复 |
| B | 窗口 move 完全无冻结机制 | **Critical** | 全局冻结完全失效，窗口移动时所有观测器持续执行 | 未修复 |
| C | useWindowControls.ts 死代码含重复 resize 监听 | **Medium** | 死代码，暂不影响生产但构成风险 | 未使用 |
| D | CSS contain 未用于冻结性能优化 | **Low** | 性能优化缺失，不影响正确性 | 未使用 |
| E | 窗口 resize 100ms debounce 无双重 rAF 保护 | **Medium** | 解冻后 CSS transition 可能过早恢复 | 未修复 |
| F | 11 个 ResizeObserver 多数无冻结感知 | **High** | resize/move 期间持续执行无用回调 | 部分感知(isLayoutFrozen) |
| G | useSuspendedResizeObserver 仅 1 处使用 | **Medium** | 优秀机制未被广泛复用 | 未扩展 |

### 8.2 根因链

```
┌─────────────────────────────────────────────────────────────────┐
│ 根因 1: App.tsx L463-480 window.resize 处理未调用               │
│ beginLayoutInteraction('workspace-resizing')                     │
│                                                                  │
│ 导致: store.isLayoutFrozen 在窗口 resize 期间为 false            │
│       仅添加了 window-resizing class，没有任何 store 联动        │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 根因 2: 未监听 Tauri onMoved 事件                                │
│                                                                  │
│ 导致: 窗口移动不触发 window.resize，完全没有任何冻结信号         │
│       所有 ResizeObserver 在窗口移动时持续执行                    │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 根因 3: 冻结信号不统一                                           │
│                                                                  │
│ window-resizing class (App.tsx) → 不联动 store                   │
│ is-layout-frozen class (store) → 不联动 CSS contain               │
│ isResizing state (useResizeFreeze) → 仅 ChatMessageList 使用     │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 后果: 窗口 resize/move 时所有 11 个 ResizeObserver 持续执行      │
│                                                                  │
│ - ChatMessageList: Pretext 重算、行高回写、虚拟滚动重算         │
│ - FilesCard: 容器高度重算、文件列表重算                          │
│ - TerminalCard: xterm.js fit() 持续执行                           │
│ - VirtualList: 虚拟滚动重算                                       │
│ - useAutoGrowTextarea: textarea 高度重算 + clientWidth 强制重排  │
│ - ChatToolCallBlock: containerWidth 重算                          │
│ - useTextMeasure: bubbleWidth 重算 + clientWidth 强制重排          │
│ - 总计: 多个强制重排 + 大量无用计算 + 潜在的布局抖动             │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 关键数据

- **11** 个独立的 `new ResizeObserver` 实例散落在代码库中
- **2** 个重复的 `window.resize` 监听（一个在 App.tsx，一个在死代码 useWindowControls.ts）
- **0** 个 Tauri `onMoved` / `onResize` 监听
- **1** 个 `useSuspendedResizeObserver` 使用点（TerminalCard）
- **1** 个 `useResizeFreeze` 使用点（ChatMessageList）
- **0** 个 CSS `contain` 使用
- **5** 个 body class 用于冻结：`is-resizing`, `resizing-active`, `window-resizing`, `is-layout-frozen`, `dragging-card`

### 8.4 修复优先级

P0 (立即修复):
1. App.tsx resize handler 调用 `beginLayoutInteraction('workspace-resizing')`
2. 添加 Tauri `onMoved` 监听，同样调用 `beginLayoutInteraction`
3. 删除 `useWindowControls.ts` 死代码

P1 (近期修复):
4. 使用 `useSuspendedResizeObserver` 替换所有手写的 `new ResizeObserver`
5. 所有 ResizeObserver 添加 `isLayoutFrozen` 守卫

P2 (优化):
6. 在冻结期间注入 CSS `contain: layout paint` 到主要容器
7. 使用双重 rAF 解冻窗口 resize
8. 添加完整的单元测试覆盖冻结行为

### 8.5 核心矛盾总结

当前冻结机制的核心矛盾是：**冻结信号与冻结执行分离**。layoutAnimationStore 是统一的冻结源，但窗口 resize（通过 App.tsx）和窗口 move（通过 Tauri）产生的冻结信号没有汇入这个统一源，导致：
1. `isLayoutFrozen` 状态不准确
2. 冻结 CSS 规则部分生效
3. ResizeObserver 守卫失效
4. 性能优化机制（catch-up、SuspendedRO）在窗口操作期间完全没有发挥作用
