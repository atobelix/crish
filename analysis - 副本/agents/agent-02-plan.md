# Agent-02: 列宽拖拽卡顿重构方案

> 基于 agent-02-analysis.md 的根因分析
> 目标: 解决拖拽不跟手、iframe/webview 指针丢失、ResizeObserver 干扰问题

---

## 目录

1. 架构目标
2. Pointer Capture 加固方案
3. 冻结机制完善
4. Workspace.tsx 修改详细
5. layoutAnimationStore.ts 增强
6. shell-dragdrop.css 增强
7. shell-workspace.css 增强
8. 新增全局遮罩层
9. useSuspendedResizeObserver 优化
10. useResizeFreeze 优化
11. 测试策略
12. 验证清单

---

## 1. 架构目标

### 1.1 核心原则

1. **Pointer 不丢失**: 在任何场景下（iframe/webview/右键菜单/弹窗），pointermove 必须持续送达拖拽 handler。
2. **冻结必须彻底**: 拖拽期间所有非必要的布局计算（ResizeObserver、Pretext、fitAddon）必须完全挂起，零 CPU 消耗。
3. **解冻必须平滑**: 解冻后 catch-up 任务要分批执行，避免单帧卡顿。
4. **向后兼容**: 不破坏现有 sidebar 拖拽、tab dragging、panel split resizing 功能。

### 1.2 关键指标

| 指标 | 当前 | 目标 |
|------|------|------|
| iframe 内拖拽丢失率 | ~80% (快速拖拽) | 0% |
| 右键菜单导致拖拽中断 | ~50% | 0% |
| 解冻瞬间帧率 | < 30fps | > 55fps |
| ResizeObserver 回调执行 | 拖拽期间仍触发 | 完全不触发 |
| 新增代码行数 | - | < 300 行 |
| 删除冗余代码行数 | - | > 50 行 |

---

## 2. Pointer Capture 加固方案

### 2.1 Workspace.tsx 修改: 全局隐形遮罩层

**核心思路**: 借鉴 VS Code 的 iframe 显式屏蔽 + 创建全局 overlay div 来捕获所有指针事件，消除对 setPointerCapture 的依赖。

#### 修改 handleColResizerPointerDown

**当前代码** (Workspace.tsx:358-450):

```typescript
const handleColResizerPointerDown = (e, colIdx) => {
  // ... 前置逻辑
  try { splitterEl.setPointerCapture(pointerId); } catch {}
  // ... move/up 监听
};
```

**目标代码** (修改后):

```typescript
const handleColResizerPointerDown = (e, colIdx) => {
  if (e.button !== 0) return;
  e.preventDefault();
  focusThisWorkspace();
  const splitterEl = e.currentTarget as HTMLElement;
  const canvasEl = containerRef.current?.querySelector('.workspace-canvas') as HTMLElement;
  if (!canvasEl) return;

  const cols = canvasEl.querySelectorAll('.workspace-column');
  const colLeftEl = cols[colIdx] as HTMLElement;
  const colRightEl = cols[colIdx + 1] as HTMLElement;
  if (!colLeftEl || !colRightEl) return;

  const pointerId = e.pointerId;
  const startX = e.clientX;
  const containerWidth = canvasEl.clientWidth || 1;
  const startLeft = splitterEl.getBoundingClientRect().left - canvasEl.getBoundingClientRect().left;

  const colLeftRatio = ws.columns[colIdx].widthRatio;
  const colRightRatio = ws.columns[colIdx + 1].widthRatio;

  splitterEl.classList.add('active');
  beginLayoutInteraction('workspace-resizing');
  document.body.style.cursor = 'col-resize';

  // ── 创建全局遮罩层 ──
  const overlay = createDragOverlay();
  document.body.appendChild(overlay);
  overlay.setPointerCapture(pointerId);
  // ── 屏蔽所有 iframe ──
  disableIframePointerEvents();

  const handlePointerMove = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX;
    const ratioDelta = dx / containerWidth;
    const ratioLeft = colLeftRatio + ratioDelta;
    const ratioRight = colRightRatio - ratioDelta;
    if (ratioLeft > 0.1 && ratioRight > 0.1) {
      colLeftEl.style.width = `${ratioLeft * 100}%`;
      colRightEl.style.width = `${ratioRight * 100}%`;
      splitterEl.style.left = `${startLeft + dx}px`;
    }
  };

  const handleKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === 'Escape') {
      // Escape 取消拖拽
      endResize(new PointerEvent('pointercancel'));
    }
  };

  let ended = false;
  const endResize = (upEvent: PointerEvent) => {
    if (ended) return;
    ended = true;

    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', endResize);
    window.removeEventListener('pointercancel', endResize);
    window.removeEventListener('keydown', handleKeyDown);
    overlay.removeEventListener('lostpointercapture', endResize);

    try {
      if (overlay.hasPointerCapture?.(pointerId)) {
        overlay.releasePointerCapture(pointerId);
      }
    } catch { /* ignore */ }

    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    // ── 恢复 iframe pointer-events ──
    enableIframePointerEvents();

    splitterEl.classList.remove('active');
    const dx = upEvent.clientX - startX;

    resizeColumns(ws.id, colIdx, dx, containerWidth);
    colLeftEl.style.width = '';
    colRightEl.style.width = '';
    splitterEl.style.left = '';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        endLayoutInteraction('workspace-resizing');
        document.body.style.cursor = '';
      });
    });
  };

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', endResize);
  window.addEventListener('pointercancel', endResize);
  window.addEventListener('keydown', handleKeyDown);
  overlay.addEventListener('lostpointercapture', endResize);
};
```

### 2.2 全局遮罩层具体实现

创建 `createDragOverlay` 辅助函数:

```typescript
/**
 * 创建全屏隐形遮罩层用于拖拽期间捕获所有指针事件。
 * 原理：遮罩层覆盖 iframe/webview，消除事件边界。
 * 使用 overlay div 而非 document 级监听，因为 iframe 会吞噬 window 事件。
 */
let dragOverlayEl: HTMLElement | null = null;

function createDragOverlay(): HTMLElement {
  if (dragOverlayEl && dragOverlayEl.parentNode) {
    dragOverlayEl.parentNode.removeChild(dragOverlayEl);
  }
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 99999;
    cursor: col-resize;
    touch-action: none;
  `;
  dragOverlayEl = el;
  return el;
}
```

**设计理由**:
1. `position: fixed` + `width/height: 100vw/100vh`: 覆盖整个视口，包括 iframe 区域
2. `z-index: 99999`: 确保在所有元素之上（包括 iframe shadow DOM）
3. `touch-action: none`: 阻止浏览器触摸手势干扰
4. 遮罩层本身是透明的，用户看不见
5. setPointerCapture 在遮罩层上调用，而非 splitter 本身

### 2.3 iframe/webview 显式屏蔽

```typescript
/** 临时 iframe pointer-events 状态快照 */
let iframePointerEventsSnapshot: Map<HTMLElement, string> | null = null;

function disableIframePointerEvents(): void {
  if (typeof document === 'undefined') return;
  iframePointerEventsSnapshot = new Map();
  const iframes = document.querySelectorAll<HTMLElement>('iframe, webview');
  for (const el of iframes) {
    iframePointerEventsSnapshot.set(el, el.style.pointerEvents || '');
    el.style.pointerEvents = 'none';
  }
}

function enableIframePointerEvents(): void {
  if (!iframePointerEventsSnapshot) return;
  for (const [el, original] of iframePointerEventsSnapshot) {
    el.style.pointerEvents = original || '';
  }
  iframePointerEventsSnapshot = null;
}
```

**设计理由**:
1. 快照恢复: 保存每个 iframe 原始的 pointer-events 值，而非简单设置为 `''`
2. 显式操作: 比 CSS 选择器更可靠——CSS 选择器无法控制动态插入的 iframe
3. 精确控制: 只操作拖拽创建时存在的 iframe，新创建的 in-drag iframe 不在此范围

### 2.4 Escape 取消支持

新增 `keydown` 监听 Escape 键取消拖拽:

```typescript
const handleKeyDown = (keyEvent: KeyboardEvent) => {
  if (keyEvent.key === 'Escape') {
    endResize(new PointerEvent('pointercancel'));
  }
};
window.addEventListener('keydown', handleKeyDown);
```

### 2.5 handleGroupResizerPointerDown 对称修改

组高拖拽同样需要上述修改，使用相同的 createDragOverlay，但 cursor 为 `row-resize`:

```typescript
// 组高拖拽的遮罩层
overlay.style.cursor = 'row-resize';
```

同一个 `dragOverlayEl` 变量被列宽和组高拖拽共用，避免了多个遮罩层冲突。后启动的拖拽会替换前一个。

---

## 3. 冻结机制完善

### 3.1 workspace-resizing 的完整生命周期

当前生命周期:

```
beginLayoutInteraction → ... 拖拽 ... → endLayoutInteraction (双重 rAF)
```

**问题**: 如果 endLayoutInteraction 从未被调用（例如组件 unmount、crash），isLayoutFrozen 会永久为 true。

**修改**: 添加超时保护 + unmount 时的自动清理。

在 Workspace.tsx 的 useEffect 返回 cleanup:

```typescript
useEffect(() => {
  return () => {
    // 组件卸载时自动结束所有正在进行的冻结
    if (useLayoutAnimationStore.getState().isWorkspaceResizing) {
      endLayoutInteraction('workspace-resizing');
    }
  };
}, []);
```

### 3.2 CSS contain 优化

在冻结期间对 `.workspace-canvas` 添加更激进的 containment:

**方案 A**: 拖拽开始时设置 `canvasEl.style.contain = 'strict'`，结束时恢复。

```typescript
const originalContain = canvasEl.style.contain || '';
canvasEl.style.contain = 'strict';

// 结束时
canvasEl.style.contain = originalContain;
```

**方案 B**: 在 CSS 中预定义规则:

```css
body.is-resizing .workspace-canvas {
  contain: strict !important;
}
```

推荐方案 B，避免 JS 操作 style。

### 3.3 iframe/webview pointer-events 屏蔽增强

当前 CSS 规则 (shell-dragdrop.css:113-125) 和 (shell-workspace.css:717-729) 重复。

**修改**: 统一到 shell-dragdrop.css，移除 shell-workspace.css 中的重复规则，并增加 `data-layout-frozen` 属性选择器：

```css
/* 冻结期屏蔽 iframe/webview 指针事件 */
body.is-layout-frozen iframe,
body.is-layout-frozen webview,
body[data-layout-frozen="true"] iframe,
body[data-layout-frozen="true"] webview,
body.resizing-active iframe,
body.resizing-active webview {
  pointer-events: none !important;
}
```

**注意**: 虽然我们显式 JS 操作了 iframe 的 pointer-events，但 CSS 规则作为双保险，防止 JS 执行延迟或异常导致 iframe 未被屏蔽。

---

## 4. Workspace.tsx 修改详细

### 4.1 修改概览

| 修改位置 | 修改内容 | 目的 |
|---------|---------|------|
| L358-450 | handleColResizerPointerDown | 增加遮罩层/iframe 屏蔽 |
| L453-545 | handleGroupResizerPointerDown | 对称修改 |
| 新增顶部 | createDragOverlay 辅助函数 | 全局遮罩层 |
| 新增顶部 | disableIframePointerEvents | iframe 屏蔽 |
| 新增顶部 | enableIframePointerEvents | iframe 恢复 |
| 新增 deps | useEffect cleanup | 卸载时解冻 |
| 新增 window | keydown Escape 监听 | 取消拖拽 |

### 4.2 逐行修改说明

#### 创建辅助函数 (新增，放在 handleColResizerPointerDown 之前)

```typescript
// 全局遮罩层创建
// 避免在 React 组件内部重复创建
const dragOverlayStyles: Record<string, string> = {
  position: 'fixed',
  top: '0', left: '0',
  width: '100vw', height: '100vh',
  'z-index': '99999',
  cursor: 'col-resize',
  'touch-action': 'none',
  background: 'transparent',
};

function createDragOverlay(): HTMLElement {
  const existing = document.getElementById('crish-drag-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'crish-drag-overlay';
  Object.assign(el.style, dragOverlayStyles);
  return el;
}
```

**设计理由**:
- 使用固定 id 'crish-drag-overlay' 避免重复创建
- 背景透明，不影响视觉
- z-index 99999 确保覆盖一切

#### handleColResizerPointerDown 修改 (Workspace.tsx L358-450)

**删除点**:
- L389-393: `try { splitterEl.setPointerCapture(pointerId); } catch {}`
  → 替换为遮罩层 setPointerCapture

**新增点**:
- 创建遮罩层，调用 `createDragOverlay()`
- `document.body.appendChild(overlay)`
- `overlay.setPointerCapture(pointerId)`
- `disableIframePointerEvents()`
- keydown Escape 监听

**替换点**:
- `splitterEl.addEventListener('lostpointercapture', endResize)`
  → `overlay.addEventListener('lostpointercapture', endResize)`
- `splitterEl.hasPointerCapture?.(pointerId)`
  → `overlay.hasPointerCapture?.(pointerId)`
- `splitterEl.releasePointerCapture(pointerId)`
  → `overlay.releasePointerCapture(pointerId)`

**保留点**:
- ended guard
- DOM 直写逻辑 (colLeftEl.style.width 等)
- store commit (resizeColumns)
- 双重 rAF 解冻
- beginLayoutInteraction / endLayoutInteraction

### 4.3 组件卸载保护

```typescript
// 在 Workspace 组件函数内部，所有 hooks 声明之后
useEffect(() => {
  return () => {
    if (useLayoutAnimationStore.getState().isLayoutFrozen) {
      endLayoutInteraction('workspace-resizing');
      document.body.style.cursor = '';
      // 清理遮罩层
      const overlay = document.getElementById('crish-drag-overlay');
      if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
      // 恢复 iframe
      enableIframePointerEvents();
    }
  };
}, []);
```

---

## 5. layoutAnimationStore.ts 增强

### 5.1 超时保护

如果 `endLayoutInteraction` 在 10 秒内未被调用，自动解冻:

```typescript
// layoutAnimationStore.ts 新增
const FROZEN_TIMEOUT_MS = 10000;
const frozenTimers = new Map<LayoutAnimationType, ReturnType<typeof setTimeout>>();

function scheduleFrozenTimeout(type: LayoutAnimationType): void {
  clearFrozenTimeout(type);
  const timer = setTimeout(() => {
    console.warn(`[LayoutAnimation] ${type} frozen for ${FROZEN_TIMEOUT_MS}ms — auto-releasing`);
    endLayoutInteraction(type);
  }, FROZEN_TIMEOUT_MS);
  frozenTimers.set(type, timer);
}

function clearFrozenTimeout(type: LayoutAnimationType): void {
  const timer = frozenTimers.get(type);
  if (timer) {
    clearTimeout(timer);
    frozenTimers.delete(type);
  }
}
```

在 `startAnimation` 中调用 `scheduleFrozenTimeout(type)`，在 `endAnimation` 中调用 `clearFrozenTimeout(type)`。

### 5.2 Catch-up 队列分批执行

当前 `flushCatchupTasks` 使用 `flushSync` 同步执行所有任务：

```typescript
flushSync(() => {
  catchupQueue.forEach((task) => { task(); });
});
```

修改为分批执行，使用 requestAnimationFrame 分散到多帧：

```typescript
flushCatchupTasks: () => {
  const { catchupQueue } = get();
  if (catchupQueue.size === 0) {
    set({ phase: 'idle' });
    return;
  }

  const tasks = Array.from(catchupQueue.entries());
  const BATCH_SIZE = 3; // 每帧最多执行 3 个任务

  let idx = 0;
  const processNextBatch = () => {
    const limit = Math.min(idx + BATCH_SIZE, tasks.length);
    while (idx < limit) {
      const [key, task] = tasks[idx++];
      try { task(); }
      catch (e) { console.error(`[LayoutAnimation] Catch-up task ${key} failed:`, e); }
    }
    if (idx < tasks.length) {
      requestAnimationFrame(processNextBatch);
    } else {
      // 所有任务完成
      catchupQueue.clear();
      set({ phase: 'idle' });
    }
  };

  processNextBatch();
};
```

### 5.3 新增 isAnyResizing 便捷派生

```typescript
// 新增便捷派生
get isAnyResizing(): boolean {
  return this.isWorkspaceResizing || this.isPanelSplitResizing;
}
```

### 5.4 类型增强

```typescript
export type LayoutAnimationType =
  | 'sidebar-transition'
  | 'workspace-resizing'
  | 'tab-dragging'
  | 'panel-split-resizing'
  | 'modal-animating';
// 保持不变，将来可以新增 'column-dragging' | 'group-dragging' 细化粒度
```

---

## 6. shell-dragdrop.css 增强

### 6.1 遮罩层样式

```css
/* 拖拽全局遮罩层 */
#crish-drag-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 99999;
  touch-action: none;
  background: transparent;
  /* 禁止选中防止文本选择干扰 */
  user-select: none !important;
  -webkit-user-select: none !important;
}
```

### 6.2 transition/animation 禁用增强

当前已经是通配符。保持不变，但添加性能提示注释：

```css
/* ── 布局冻结：禁用所有 transition/animation ──
 * 注意：此选择器使用通配符 * 来确保所有元素被覆盖。
 * 性能：在冻结期间 DOM 变化极少，通配符开销可接受。
 * 如果未来发现有性能问题，可以考虑细分到特定选择器。
 */
body.is-layout-frozen *,
body.is-layout-frozen *::before,
body.is-layout-frozen *::after {
  transition: none !important;
  animation: none !important;
}
```

### 6.3 iframe pointer-events 单文件统一

删除 shell-workspace.css 中的重复规则，在 shell-dragdrop.css 中统一维护：

```css
/* ── 冻结期屏蔽 iframe/webview 指针事件 ──
 * 双保险：JS 显式操作 + CSS 选择器
 * 覆盖所有冻结相关 body class
 */
body.is-layout-frozen iframe,
body.is-layout-frozen webview,
body[data-layout-frozen="true"] iframe,
body[data-layout-frozen="true"] webview,
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

### 6.4 CSS contain 规则

```css
/* 拖拽/冻结期间限制布局重排范围 */
body.is-resizing .workspace-canvas,
body.resizing-active .workspace-canvas {
  contain: strict !important;
}
```

---

## 7. shell-workspace.css 修改

### 7.1 删除重复的 iframe 规则

删除 shell-workspace.css 第 717-729 行（与 shell-dragdrop.css 重复）：

```css
/* 删除以下重复规则 */
body.is-layout-frozen iframe,
body.is-layout-frozen webview,
...
```

### 7.2 保持 is-layout-frozen 相关样式

保留 `data-shell-chrome` 相关的容器布局样式不变。

---

## 8. 新增全局遮罩层组件

### 8.1 方案选择

**方案 A**: inline helper 函数（推荐）
- 简单直接，无额外组件
- 使用全局 id 管理单个遮罩层实例
- 生命周期完全由拖拽 handler 控制

**方案 B**: React Portal 组件
- 更 React 风格
- 但引入了额外的组件挂载/卸载开销
- 与当前 drag handler 的事件管理风格不匹配

**结论**: 选择方案 A，keep it simple。

### 8.2 遮罩层行为规范

```
拖拽开始:
  1. createDragOverlay() → 创建 <div id="crish-drag-overlay">
  2. document.body.appendChild(overlay)
  3. overlay.setPointerCapture(pointerId)
  4. disableIframePointerEvents()

拖拽中:
  - 所有 pointermove 通过 overlay 捕获
  - 如果 overlay 失去捕获 (lostpointercapture)，立即 endResize

拖拽结束:
  1. overlay.releasePointerCapture()
  2. overlay.remove()
  3. enableIframePointerEvents()
  4. commit store + 双重 rAF 解冻

异常结束 (Escape):
  1. 触发 pointercancel 事件
  2. 同样走 endResize 流程
  3. 不 commit store（视觉回滚到拖拽前）
```

### 8.3 验证遮罩层生效

- 在 DevTools Elements 面板中检查是否出现 `#crish-drag-overlay`
- 拖拽时 pointermove 事件来自 overlay 而非 splitter
- iframe 的 style 出现 `pointer-events: none`
- 拖拽结束后 overlay 消失，iframe pointer-events 恢复

---

## 9. useSuspendedResizeObserver 优化

### 9.1 当前问题

```typescript
if (isFrozen) {
  registerCatchupTask(taskKey, () => {
    latestOnResize.current(entries[0]);  // 注册 catch-up 任务
  });
} else {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => { ... });
}
```

**问题**: 冻结时每次 ResizeObserver 回调都会重新注册同一个 key 的 catch-up 任务，覆盖上一次注册的闭包。虽然 `registerCatchupTask` 用 Map 去重，但每次回调都会更新 task 函数，意味着只保留最后一次的 measurement。

**优化**: 在冻结期间完全断开 observer：

```typescript
useEffect(() => {
  if (disabled) return;
  const el = targetRef.current;
  if (!el || typeof ResizeObserver === 'undefined') return;

  let rafId: number | null = null;
  let observer: ResizeObserver | null = null;
  let isFrozenRef = false;

  // 订阅冻结状态
  const unsubFrozen = useLayoutAnimationStore.subscribe(
    (state) => {
      const frozen = state.isLayoutFrozen;
      if (frozen === isFrozenRef) return;
      isFrozenRef = frozen;

      if (frozen) {
        // 冻结时断开 observer 连接
        if (observer) {
          observer.disconnect();
        }
        // 注册 catch-up 重连任务
        registerCatchupTask(taskKey, () => {
          if (observer && el) {
            observer.observe(el);
            // 重连后立即测量一次
            const rect = el.getBoundingClientRect();
            latestOnResize.current({
              contentRect: rect,
              target: el,
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            } as unknown as ResizeObserverEntry);
          }
        });
      } else {
        // 解冻时重新连接 observer
        if (observer && el && !observer.takeRecords) {
          observer.observe(el);
        }
      }
    }
  );

  observer = new ResizeObserver((entries) => {
    if (isFrozenRef) return; // 安全守卫（理论上不应触发）
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      latestOnResize.current(entries[0]);
    });
  });

  observer.observe(el);

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (observer) observer.disconnect();
    unregisterCatchupTask(taskKey);
    unsubFrozen();
  };
}, [targetRef, taskKey, disabled, registerCatchupTask, unregisterCatchupTask]);
```

**优化效果**:
1. 冻结时完全断开 observer → 零 CPU 消耗
2. 解冻时通过 catch-up 重连 → 单次测量
3. 冻结/解冻状态订阅 → 即时响应，无需轮询

### 9.2 兼容性保留

对于无法使用 `useSuspendedResizeObserver` 的情况（如 FilesCard 内联 observer），保留简单守卫模式：

```typescript
if (useLayoutAnimationStore.getState().isLayoutFrozen) return;
```

但推荐迁移到 `useSuspendedResizeObserver` 以获得更好的性能。

---

## 10. useResizeFreeze 优化

### 10.1 解冻 debounce 优化

当前代码 (useResizeFreeze.ts)：

```typescript
const timer = window.setTimeout(() => {
  if (!useLayoutAnimationStore.getState().isLayoutFrozen) {
    setIsResizing(false);
  }
}, debounceMs);
```

**问题**: debounce 延迟 150ms，在解冻后 ChatMessageList 等组件要等 150ms 才能恢复 Pretext 计算。这导致解冻后用户看到的内容更新延迟。

**优化**: 使用 rAF 替代 setTimeout，更快响应：

```typescript
useEffect(() => {
  if (isLayoutFrozen) {
    setIsResizing(true);
    return;
  }
  // 解冻后使用 rAF 而非 setTimeout
  const rafId = requestAnimationFrame(() => {
    if (!useLayoutAnimationStore.getState().isLayoutFrozen) {
      setIsResizing(false);
    }
  });
  return () => cancelAnimationFrame(rafId);
}, [isLayoutFrozen, debounceMs]);
```

如果仍需要 debounce 保护，组合使用：

```typescript
useEffect(() => {
  if (isLayoutFrozen) {
    setIsResizing(true);
    return;
  }
  const timer = window.setTimeout(() => {
    if (!useLayoutAnimationStore.getState().isLayoutFrozen) {
      setIsResizing(false);
    }
  }, 50); // 缩短 debounce 到 50ms
  return () => window.clearTimeout(timer);
}, [isLayoutFrozen, debounceMs]);
```

### 10.2 性能优化

将 debounceMs 的默认值从 150 改为 50：

```typescript
export function useResizeFreeze(debounceMs = 50): { isResizing: boolean } {
```

在 ChatMessageList 中的调用点也相应更新：

```typescript
const { isResizing } = useResizeFreeze(50); // 从 150 改为 50
```

---

## 11. 测试策略

### 11.1 单元测试

| 测试用例 | 覆盖组件 | 断言 |
|---------|---------|------|
| createDragOverlay 创建遮罩层 | Workspace.tsx | overlay div 存在，样式正确 |
| disableIframePointerEvents 屏蔽 iframe | Workspace.tsx | iframe style.pointerEvents === 'none' |
| enableIframePointerEvents 恢复 iframe | Workspace.tsx | iframe style.pointerEvents 恢复原始值 |
| Escape 取消拖拽 | Workspace.tsx | DOM style 回滚，store 未 commit |
| overlay lostpointercapture 处理 | Workspace.tsx | endResize 被调用，ended guard 生效 |
| unmount 自动解冻 | Workspace.tsx | isLayoutFrozen === false |

### 11.2 集成测试

| 测试场景 | 步骤 | 预期 |
|---------|------|------|
| 拖拽列宽不进入 iframe | 拖拽 splitter → 释放 | splitter 跟随指针，列宽正确 |
| 拖拽列宽滑入 iframe | 拖拽 → 快速滑入 PreviewCard iframe | 拖拽不中断，splitter 继续跟随 |
| 拖拽中右键菜单 | 拖拽 → 右键 | 拖拽立即结束，DOM 恢复 |
| 拖拽中 Escape | 拖拽 → 按 Escape | 拖拽取消，宽度回滚 |
| 组件卸载时正在拖拽 | 拖拽中移除 Workspace | 无 JS error，冻结自动清除 |
| 双重 rAF 解冻 | 释放 splitter → 等待 2 帧 | isLayoutFrozen === false |
| catch-up 分批执行 | 解冻后有多个注册任务 | 每帧最多 3 个任务 |

### 11.3 性能测试

| 指标 | 测试方法 | 目标 |
|------|---------|------|
| 拖拽帧率 | Chrome DevTools Performance 录制 | > 55fps |
| iframe 内拖拽事件延迟 | console.time 前后 | < 16ms |
| 解冻后首个完整帧时间 | Performance.now() | < 32ms |
| 冻结时 ResizeObserver 调用次数 | console.count | 0 |
| catch-up 任务总耗时 | 批量执行计时 | < 48ms (3 帧) |

### 11.4 跨浏览器回归

| 浏览器 | 关注点 |
|--------|--------|
| Chrome 116+ | Pointer Events, setPointerCapture |
| Edge 116+ | Electron webview |
| Firefox 118+ | Pointer Events 兼容性 |
| Safari 17+ | touch-action, CSS contain |

---

## 12. 验证清单

### 12.1 功能验证

- [ ] 列宽拖拽: 正常拖拽、释放后列宽正确更新
- [ ] 列宽拖拽: 鼠标滑入 iframe (PreviewCard) → 拖拽继续
- [ ] 列宽拖拽: 鼠标滑入 Terminal webview → 拖拽继续
- [ ] 列宽拖拽: 快速拖拽后释放 → 无延迟感
- [ ] 列宽拖拽: 拖拽到最小宽度 (10%) → clamp 生效
- [ ] 组高拖拽: 正常拖拽、释放后组高正确更新
- [ ] 组高拖拽: 拖拽到最小高度 (10%) → clamp 生效
- [ ] 组高拖拽: 鼠标滑入 iframe → 拖拽继续
- [ ] Sidebar 拖拽: 正常功能不受影响
- [ ] Tab 拖拽: 正常功能不受影响
- [ ] 右键菜单: 拖拽时弹出 → 拖拽取消
- [ ] Escape: 拖拽时按 Escape → 拖拽取消，宽度回滚
- [ ] 组件卸载: 拖拽时卸载 Workspace → 无错误

### 12.2 冻结验证

- [ ] 拖拽时 `document.body.classList` 包含 `is-layout-frozen`
- [ ] 拖拽时 `document.body.classList` 包含 `resizing-active`
- [ ] 拖拽时 `document.body.classList` 包含 `is-resizing`
- [ ] 拖拽时 `document.body.dataset.layoutFrozen === 'true'`
- [ ] 拖拽时所有 iframe/webview `style.pointerEvents === 'none'`
- [ ] 拖拽时 overlay `<div id="crish-drag-overlay">` 存在于 body
- [ ] 释放后 2 帧内 body class 和 overlay 被清理
- [ ] 溢出保护: 10s 超时自动解冻

### 12.3 性能验证

- [ ] DevTools Performance: 拖拽期间无 Layout Reflow (紫色 bar)
- [ ] DevTools Performance: 拖拽期间无 React Commit
- [ ] DevTools Performance: 解冻后 catch-up 任务分散在 3+ 帧中
- [ ] Console: 无 LayoutAnimationStore catch-up 错误
- [ ] Console: 无 unused JS timer 或 event listener leak

### 12.4 代码质量

- [ ] 无新增 any 类型
- [ ] 无 `!important` 滥用（CSS 中已有的是兼容性必须）
- [ ] 所有新增辅助函数有类型注解
- [ ] removeEventListener 参数与 addEventListener 完全匹配（函数引用一致性）
- [ ] 新增代码通过现有 lint 规则

---

## 附录 A: 文件修改清单

| 文件 | 修改类型 | 行数估计 |
|------|---------|---------|
| apps/crish-desktop/src/components/Workspace.tsx | 修改 | ~80 行 |
| apps/crish-desktop/src/store/layoutAnimationStore.ts | 增强 | ~50 行 |
| apps/crish-desktop/src/styles/shell/shell-dragdrop.css | 增强 | ~30 行 |
| apps/crish-desktop/src/styles/shell/shell-workspace.css | 删除重复 | -12 行 |
| apps/crish-desktop/src/hooks/useSuspendedResizeObserver.ts | 优化 | ~40 行 |
| apps/crish-desktop/src/hooks/useResizeFreeze.ts | 优化 | ~10 行 |
| **合计** | | **~198 行** |

## 附录 B: 风险与回退

| 风险 | 概率 | 影响 | 回退方案 |
|------|------|------|---------|
| overlay 影响拖拽之外的功能 | 低 | 中 | 移除 overlay，回退到原有 setPointerCapture + 窗口级监听 |
| iframe 显式屏蔽漏了某些元素 | 中 | 中 | 扩展 querySelector 范围 |
| catch-up 分批导致 Pretext 延迟显示 | 低 | 低 | 调整 BATCH_SIZE |
| 超时保护误触发 | 极低 | 高 | 延长 FROZEN_TIMEOUT_MS 至 30s |
