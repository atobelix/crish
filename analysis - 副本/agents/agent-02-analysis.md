# Agent-02: 列宽拖拽卡顿问题深入分析

> 分析日期: 2026-07-22
> 项目: Crish Desktop (apps/crish-desktop)
> 核心文件: Workspace.tsx, layoutAnimationStore.ts, layoutStore.ts, shell-dragdrop.css, useSuspendedResizeObserver.ts

---

## 目录

1. 列宽拖拽完整链路分析
2. Pointer Capture 问题分析
3. 布局冻结机制分析
4. ResizeObserver 在拖拽期间的问题
5. 列宽拖拽 vs 组高拖拽的对称分析
6. 参考项目对比
7. 根因结论

---

## 1. 列宽拖拽完整链路分析

### 1.1 handleColResizerPointerDown 完整流程

**入口**: Workspace.tsx:358-450

```
用户 onPointerDown
  └─ e.button !== 0 → return (仅左键)
  └─ e.preventDefault() (阻止文本选择/默认行为)
  └─ focusThisWorkspace() (切 activeWorkspaceIndex)
  └─ 获取 DOM 引用:
       - splitterEl = e.currentTarget (col-splitter div)
       - canvasEl = .workspace-canvas
       - colLeftEl / colRightEl = .workspace-column[colIdx] / [colIdx+1]
  └─ 快照拖拽起始值:
       - pointerId = e.pointerId
       - startX = e.clientX
       - containerWidth = canvasEl.clientWidth || 1
       - startLeft = splitter.getBoundingClientRect().left - canvas.getBoundingClientRect().left
       - colLeftRatio = ws.columns[colIdx].widthRatio (store 快照)
       - colRightRatio = ws.columns[colIdx+1].widthRatio (store 快照)
  └─ splitterEl.classList.add('active')
  └─ beginLayoutInteraction('workspace-resizing')  ← 冻结
  └─ document.body.style.cursor = 'col-resize'
  └─ try { splitterEl.setPointerCapture(pointerId) } catch {}  ← 有 try/catch 无 fallback
  └─ 注册 window 级监听:
       - window.addEventListener('pointermove', handlePointerMove)
       - window.addEventListener('pointerup', endResize)
       - window.addEventListener('pointercancel', endResize)
       - splitterEl.addEventListener('lostpointercapture', endResize)
```

**拖拽中** (handlePointerMove, Workspace.tsx:395-406):

```
moveEvent.clientX - startX → dx
ratioDelta = dx / containerWidth
ratioLeft = colLeftRatio + ratioDelta
ratioRight = colRightRatio - ratioDelta
if (ratioLeft > 0.1 && ratioRight > 0.1) → DOM 直写:
  colLeftEl.style.width = `${ratioLeft * 100}%`
  colRightEl.style.width = `${ratioRight * 100}%`
  splitterEl.style.left = `${startLeft + dx}px`
```

**拖拽结束** (endResize, Workspace.tsx:409-444):

```
ended 防重入
window.removeEventListener (pointermove, pointerup, pointercancel)
splitterEl.removeEventListener (lostpointercapture)
try { splitterEl.releasePointerCapture(pointerId) } catch {}
splitterEl.classList.remove('active')
dx = upEvent.clientX - startX
resizeColumns(ws.id, colIdx, dx, containerWidth)  ← 提交 store
清理 DOM 临时 Style (colLeft, colRight, splitter → '')
双重 rAF:
  rAF1 → rAF2 → endLayoutInteraction('workspace-resizing')
                → document.body.style.cursor = ''
```

### 1.2 handleGroupResizerPointerDown 完整流程

**入口**: Workspace.tsx:453-545

与列宽拖拽几乎完全对称，差异仅为:

| 维度 | 列宽 (col) | 组高 (group) |
|------|-----------|-------------|
| 方向 | 水平 (x) | 垂直 (y) |
| 光标 | col-resize | row-resize |
| 被操作元素 | .workspace-column | .workspace-card |
| store 方法 | resizeColumns | resizeGroups |
| 容器尺寸 | canvasEl.clientWidth | colEl.clientHeight |
| 拖拽元素引用 | colLeft/colRight | topCard/bottomCard |
| 样式属性 | width / left | height / top |

**关键差异**: 组高拖拽中 `splitterEl.parentElement` 作为 colEl，即 splitter 直接放在 column 内部，通过 `.workspace-card` 元素的高度百分比直写 DOM。

### 1.3 DOM style 直写分析

这是当前架构的核心性能设计，也是卡顿问题的关键:

**为什么直写 DOM 而非 setState:**
- 拖拽期间如果通过 React state + re-render，每帧都会触发组件树 diff → 虚拟 DOM 协调 → 重排 → 重绘
- 直写 DOM style 只需浏览器一次 Layout + Paint，跳过 React 调度
- 这是典型的 "sash 模式"：拖拽期间 DOM 优先，释放时 commit 到 store

**直写的样式属性:**

```
列宽拖拽:
  colLeftEl.style.width              → "${ratioLeft * 100}%"
  colRightEl.style.width             → "${ratioRight * 100}%"
  splitterEl.style.left              → "${startLeft + dx}px"

组高拖拽:
  topCardEl.style.height             → "${ratioTop * 100}%"
  bottomCardEl.style.height          → "${ratioBottom * 100}%"
  splitterEl.style.top               → "${startTop + dy}px"
```

**问题**: `style.width` 使用百分比值。百分比值依赖于父容器宽度。如果父容器（canvas）尺寸在拖拽期间发生变化（比如 ResizeObserver 触发了 re-render），百分比基准会漂移，导致视觉跳动。

### 1.4 拖拽结束后如何 commit store

**resizeColumns** (workspaceActions.ts:129-148):

```typescript
resizeColumns: (wsId, colIdx, dx, containerWidth) => set((state) => {
  const ws = findWorkspace(state, wsId);
  if (!ws || ws.columns.length < 2) return;
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return;
  if (colIdx < 0 || colIdx >= ws.columns.length - 1) return;
  const colLeft = ws.columns[colIdx];
  const colRight = ws.columns[colIdx + 1];
  if (!colLeft || !colRight) return;
  const ratioDelta = dx / containerWidth;
  const newLeft = colLeft.widthRatio + ratioDelta;
  const newRight = colRight.widthRatio - ratioDelta;
  if (newLeft > 0.12 && newRight > 0.12) {
    colLeft.widthRatio = newLeft;
    colRight.widthRatio = newRight;
  }
})
```

**resizeGroups** (workspaceActions.ts:150-171):

```typescript
resizeGroups: (wsId, colIdx, groupIdx, dy, containerHeight) => set((state) => {
  // ... 对称逻辑
  if (newTop > 0.1 && newBottom > 0.1) {
    groupTop.heightRatio = newTop;
    groupBottom.heightRatio = newBottom;
  }
})
```

**要点**:
- 使用 Immer 中间件，set() 内直接 mutate draft state
- 最小比例保护：列 12%，组 10%
- commit 后 React re-render，CSS class `.column` 的 `width: ${col.widthRatio * 100}%` 重新生效
- DOM 临时 style 在 commit 后被清空，React 重新接管

**问题**: commit 后到 React re-render 之间有帧间隙。双重 rAF 解冻就是为了等 re-render 完成，但如果 re-render 耗时超过两帧，解冻后其他组件（如 ChatMessageList 的 containerWidth）会读到错误的尺寸。

### 1.5 双重 rAF 解冻机制分析

```typescript
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    endLayoutInteraction('workspace-resizing');
    document.body.style.cursor = '';
  });
});
```

**为什么需要双重 rAF:**
1. 第一个 rAF: 等待浏览器布局计算完成。resizeColumns() 修改了 store → React 调度 re-render → 虚拟 DOM diff → DOM 更新。首帧 rAF 在 paint 前执行，此时 DOM 可能还未完全更新。
2. 第二个 rAF: 真正的 "after paint"。第一帧 rAF 内提交的 DOM 更改已经完成布局和绘制，第二帧 rAF 执行时 DOM 是最新状态。

**问题**: 双重 rAF 并不可靠：
- 如果 React 的 commit 阶段耗时超过一帧（16ms），第二帧 rAF 仍可能在批量更新完成前触发
- 没有使用 `flushSync` 确保 commit 立即生效
- 在低端设备上，两帧延迟（~32ms）后解冻，但其他组件可能还在响应上一次的 store 更新

---

## 2. Pointer Capture 问题分析

### 2.1 setPointerCapture 在拖拽时的作用

`Element.setPointerCapture(pointerId)` 是 Pointer Events API 的核心特性:

1. **锁定目标元素**: 无论指针移动到文档的任何位置，所有后续的 pointermove/pointerup/pointercancel 事件都会定向到调用 `setPointerCapture` 的元素。
2. **自动捕获**: 即使指针移出元素边界，事件仍然送达。
3. **隐式释放**: pointerup/pointercancel 时自动释放，或通过 `releasePointerCapture` 手动释放。

当前代码 (Workspace.tsx:389-393):

```typescript
try {
  splitterEl.setPointerCapture(pointerId);
} catch {
  /* capture 失败时仍依赖 window 监听 */
}
```

### 2.2 捕获丢失场景

**场景 1: 滑入 iframe/webview**
- iframe/webview 有独立的事件循环和文档上下文
- Pointer Capture 无法跨 document 边界
- 当指针滑入 iframe 区域，`pointermove` 事件不再发送给主文档
- 即使有 `window.addEventListener('pointermove', ...)` 也不能收到事件
- **症状**: 拖拽突然停止，splitter 卡在半路

**场景 2: 右键菜单弹出**
- 右键菜单弹出后，指针事件流被中断
- `pointerup` 可能永远不会触发
- 即使有 `pointercancel` 监听，某些浏览器不会在右键菜单时触发 cancel

**场景 3: alert/confirm/prompt 弹窗**
- 模态弹窗阻塞主线程事件循环
- 所有指针事件丢失
- 弹窗关闭后，drag 状态不一致（ended = true 但 window 监听已移除）

**场景 4: 浏览器失去焦点 (Alt+Tab)**
- `lostpointercapture` 事件可能触发，但如果在 iframe 内部失去焦点，则不会

### 2.3 lostpointercapture 事件处理

当前代码注册了 `lostpointercapture` 监听:

```typescript
splitterEl.addEventListener('lostpointercapture', endResize);
```

**问题**:
1. `lostpointercapture` 在 `pointerup` 之前也会触发。这意味着如果用户快速松开，可能触发两次 `endResize`（但 ended 防重入 guard 可以处理）。
2. `lostpointercapture` 不携带 `clientX/clientY`。`endResize` 函数用 `upEvent.clientX - startX` 计算最终 dx，但 `lostpointercapture` 事件的坐标可能不是最终位置。
3. 在 iframe 场景中，`lostpointercapture` 也不会触发（因为捕获未丢失，只是事件被 iframe 吞掉）。

### 2.4 VS Code 全局遮罩层 vs Pointer Capture 对比

**VS Code sash.ts 策略** (参考 reference/agent-02/vscode-sash.ts):

VS Code 没有使用 `setPointerCapture`。它的策略是:

1. **iframe pointer-events 禁用**: 在 drag 开始后，遍历 `document.getElementsByTagName('iframe')`，对所有 iframe 添加 `pointer-events-disabled` CSS class。
2. **全局 CSS 光标覆盖**: 创建一个 `<style>` 元素注入 `* { cursor: ${cursor} !important; }`。
3. **window 级事件**: 使用 `MouseEventFactory` 或 `GestureEventFactory`，监听 window 的 mousemove/mouseup。
4. **事件流管理**: 使用 `DisposableStore` 管理所有临时事件监听，drag 结束时统一 dispose。

**核心差异**:

| 特性 | VS Code sash.ts | 本项目 (Workspace.tsx) |
|------|----------------|----------------------|
| Pointer Capture | 不使用 | 使用 (有 try/catch) |
| iframe 屏蔽 | 显式 classList.add | CSS 规则 (body.is-layout-frozen iframe) |
| CSS 光标 | 动态 `<style>` 注入 | body.style.cursor |
| 事件工厂 | MouseEventFactory/GestureEventFactory | 原生 addEventListener |
| 生命周期 | DisposableStore | 手动 ended flag + removeEventListener |
| 全局遮罩 | 无（用 iframe class + * 光标代替） | 无 |

**VS Code 方案的优点**:
- iframe 屏蔽精确到 sash 级别，而非全局冻结
- 动态 style 注入比 body.style.cursor 更可靠（body 可能被覆盖）
- DisposableStore 模式更干净，不易产生内存泄漏

**本项目方案的优点**:
- 使用 setPointerCapture 更简单，不需要自己管理事件路由
- layoutAnimationStore 的冻结机制更全面（不止光标，还禁用 transition/animation）

---

## 3. 布局冻结机制分析

### 3.1 beginLayoutInteraction('workspace-resizing') 调用链

```
handleColResizerPointerDown
  └─ beginLayoutInteraction('workspace-resizing')
       └─ addExtraBodyClasses(undefined)  ← 无 extra classes
       └─ useLayoutAnimationStore.getState().startAnimation('workspace-resizing')
            └─ activeAnimations Set 新增 'workspace-resizing'
            └─ deriveFlags:
                 isWorkspaceResizing = true
                 isLayoutFrozen = true
                 phase = 'animating'
            └─ syncBodyFromActive:
                 document.body.setAttribute('data-layout-frozen', 'true')
                 document.body.classList.add('is-layout-frozen')
                 document.body.classList.add('resizing-active')
                 document.body.classList.add('is-resizing')
            └─ set({ ...deriveFlags, phase })
```

### 3.2 layoutAnimationStore 的 activeAnimations Set

activeAnimations 是一个 `Set<LayoutAnimationType>`:

```typescript
export type LayoutAnimationType =
  | 'sidebar-transition'
  | 'workspace-resizing'
  | 'tab-dragging'
  | 'panel-split-resizing'
  | 'modal-animating';
```

关键设计: 多个动画可以同时存在（例如 tab-dragging + sidebar-transition）。只要 Set size > 0，isLayoutFrozen = true。

去重保护 (layoutAnimationStore.ts:142-148):

```typescript
if (current.has(type)) {
  syncBodyFromActive(current);  // 强制同步，防止外部误清
  return;
}
```

### 3.3 isLayoutFrozen 派生

```typescript
isLayoutFrozen: active.size > 0
```

所有订阅 `useLayoutAnimationStore(s => s.isLayoutFrozen)` 的组件都会在冻结/解冻时重新渲染。这是一个 store-level 的 boolean 派生值，不依赖 React 的 Context。

### 3.4 body class 同步

TYPE_BODY_CLASSES 映射 (layoutAnimationStore.ts:23-30):

```typescript
const TYPE_BODY_CLASSES = {
  'sidebar-transition': [],
  'workspace-resizing': ['resizing-active', 'is-resizing'],
  'tab-dragging': ['dragging-card'],
  'panel-split-resizing': ['resizing-active', 'is-resizing'],
  'modal-animating': [],
};
```

STORE_MANAGED_BODY_CLASSES (layoutAnimationStore.ts:33-38):

```typescript
const STORE_MANAGED_BODY_CLASSES = [
  'is-layout-frozen',
  'resizing-active',
  'is-resizing',
  'dragging-card',
];
```

同步逻辑 (syncBodyFromActive, layoutAnimationStore.ts:97-119):
- 取 activeAnimations → deriveBodyClasses (遍历所有 type 收集 class)
- 设置 document.body.attributes['data-layout-frozen'] = 'true'
- 对比 STORE_MANAGED_BODY_CLASSES，需要则 add，不需要则 remove

**重要**: body class 的增删完全由 store 控制，业务代码禁止直接操作 classList。

### 3.5 shell-dragdrop.css 中的 transition/animation 禁用

```css
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

**注意**: 这里选择了 `body.is-resizing *` 全局通配符。在大型 DOM 树中，这种选择器性能很差——浏览器需要遍历所有元素检查是否匹配。但在拖拽场景中，禁用 transition/animation 防止了样式动画干扰拖拽响应。

**潜在问题**: 通配符 `*` 会匹配所有元素包括已 detached 的节点，但不会影响 iframe/webview 内部（它们有独立文档）。

### 3.6 现有方案的缺陷

**缺陷 1: iframe/webview pointer-events 覆盖不全**

CSS 规则在 shell-dragdrop.css 第 113-125 行：

```css
body.is-layout-frozen iframe,
body.is-layout-frozen webview,
body.resizing-active iframe,
body.resizing-active webview,
// ... 重复
{
  pointer-events: none !important;
}
```

同样规则在 shell-workspace.css 第 717-729 行重复了一次。

**问题**: 这条规则在 iframe pointer-events 屏蔽上是正确的，但有两个边界情况：
1. 如果 iframe 在 `data-layout-frozen` 设置之前已经获得了焦点，内部鼠标事件仍可能被 iframe 的合成事件处理
2. 某些 HTML 渲染引擎（如 Electron 的 webview）不继承父元素的 CSS pointer-events

**缺陷 2: 缺少 CSS contain 优化**

在冻结期间，没有使用 `contain: strict` 或 `contain: paint` 来限制浏览器的重排范围。Workspace.module.css 第 96 行:

```css
.column {
  contain: layout style;
}
```

这已经包含了 layout 和 style containment，但在拖拽期间，如果子节点触发了布局变化（如 ResizeObserver 回调），contain 仍然无法阻止（因为 ResizeObserver 本身是异步的）。

**缺陷 3: 缺少全局遮罩层**

与 VS Code 对比，本项目没有创建全局透明的 overlay div 来捕获所有指针事件。这意味着:
- 如果 setPointerCapture 失败（已在 try/catch 中处理），但 window 级事件监听也可能丢失
- 拖拽过程中如果指针移出浏览器窗口，mouseleave/mouseout 不会触发

---

### 3.7 侧栏拖拽的冻结机制对比

Sidebar.tsx 中的 `handleSidebarResizeStart` (Line 654-730) 使用了与 Workspace.tsx 相同的冻结策略：

```typescript
beginLayoutInteraction('workspace-resizing');
try { target.setPointerCapture(pointerId); } catch {}
// ... move/up ...
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    endLayoutInteraction('workspace-resizing');
  });
});
```

**关键差异**:
1. Sidebar 使用 `frameScheduler.modify()` 节流（Line 678），而 Workspace 直接每帧计算
2. Sidebar 在拖拽到 < 80px 时会自动折叠（collapse store），Workspace 没有自动折叠逻辑
3. Sidebar 在 up 时调用 `applySidebarWidth` 持久化到 ConfigService + localStorage，Workspace 只 commit 到 store
4. Sidebar 没有 `lostpointercapture` 之外的额外事件监听清理

**问题**: Sidebar 的 frameScheduler.modify() 机制可能引入额外的帧延迟，因为 modify 可能排队到下一帧执行。

### 3.8 Keyboard Nudge 路径的冻结分析

Workspace.tsx 中的键盘微调路径（`nudgeColumnByKey` / `nudgeGroupByKey`，Line 92-124）不经过布局冻结：

```typescript
const nudgeColumnByKey = (leftColIdx, dir) => {
  const containerWidth = canvasEl.clientWidth || 1;
  const dx = dir * Math.max(8, Math.round(containerWidth * 0.02));
  resizeColumns(id, leftColIdx, dx, containerWidth);
};
```

**问题**: 键盘微调直接调用 `resizeColumns` 而不经过 `beginLayoutInteraction`。这意味着：
- 不会有 `is-layout-frozen` body class
- 不会禁用 transition/animation
- ResizeObserver 不会被挂起
- iframe pointer-events 不会被屏蔽

**影响**: 低频使用时没问题，但如果用户连续快速按方向键（ArrowLeft/ArrowRight hold），每帧都会触发 resizeColumns re-render，可能造成卡顿。

**改进建议**: 键盘微调也应该包装在 `beginLayoutInteraction/endLayoutInteraction` 中：

```typescript
const nudgeColumnByKey = (leftColIdx, dir) => {
  // ... 计算 dx ...
  beginLayoutInteraction('workspace-resizing');
  resizeColumns(id, leftColIdx, dx, containerWidth);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      endLayoutInteraction('workspace-resizing');
    });
  });
};
```

### 3.9 body cursor 管理问题

Workspace.tsx 中 body cursor 的设置/清理模式：

```typescript
// handleColResizerPointerDown:
document.body.style.cursor = 'col-resize';

// endResize:
document.body.style.cursor = '';
```

**问题**:
1. 如果两个拖拽同时发生（极不可能但可能通过程序化触发），后者的 cursor 会覆盖前者的
2. `cursor = ''` 只是清除内联样式，但如果 CSS 规则设置了 cursor，不会回退到继承值
3. body cursor 在 iframe 内部无效（iframe 有独立 cursor 上下文）

**改进**: 使用 VS Code 的动态 style 注入模式，创建 `<style>` 标签设置 `* { cursor: ... !important; }`。

---

## 4. ResizeObserver 在拖拽期间的问题

### 4.1 ChatMessageList setContainerWidth 在拖拽期间仍执行

ChatMessageList.tsx:623-645:

```typescript
const [containerWidth, setContainerWidth] = useState(680);

useEffect(() => {
  const el = containerRef.current;
  if (!el) return;
  let rafId: number | null = null;
  const update = () => {
    if (useLayoutAnimationStore.getState().isLayoutFrozen) return;  // ← 守卫
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (el) setContainerWidth(el.clientWidth);
    });
  };
  update();
  const ro = new ResizeObserver(update);
  ro.observe(el);
  return () => { /* 清理 */ };
}, [containerRef]);
```

**问题**: 虽然有 isLayoutFrozen 守卫，但 ResizeObserver 的回调仍然会被调用（只是提前 return）。如果在拖拽过程中 column 宽度变化（通过直写 DOM style），ResizeObserver 会触发回调，虽然不会 setState，但仍会消耗 CPU 时间。

更严重的是: 如果冻结在解冻瞬间（双重 rAF 期间）出现间隙，ChatMessageList 可能在错误的时机读取到过渡态的 containerWidth，导致 Pretext 缓存计算出错。

### 4.2 FilesCard setContainerHeight 在拖拽期间仍执行

FilesCard.tsx:79-120:

```typescript
const [containerHeight, setContainerHeight] = useState(400);

const resizeObserver = new ResizeObserver((entries) => {
  if (useLayoutAnimationStore.getState().isLayoutFrozen) return;  // ← 守卫
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

**问题**: FilesCard 没有使用 `useSuspendedResizeObserver` 自定义 hook，而是自己实现了类似的守卫逻辑。与 ChatMessageList 类似，ResizeObserver 回调在拖拽期间仍会触发，只是提前 return。

此外，`Math.abs(h - lastH) > 3` 阈值在拖拽快速变化时可能跳帧。

### 4.3 TerminalCard fitAddon.fit() 在拖拽期间仍执行

TerminalCard.xterm.tsx:121-135:

```typescript
const handleFitResize = useCallback(() => {
  const fitAddon = fitAddonRef.current;
  if (!fitAddon) return;
  try { fitAddon.fit(); } catch { /* ignore */ }
}, []);

useSuspendedResizeObserver({
  taskKey: `xterm-fit-${termId}`,
  targetRef: containerRef,
  onResize: handleFitResize,
});
```

**问题**: TerminalCard 正确使用了 `useSuspendedResizeObserver`。但 `fitAddon.fit()` 本身是昂贵的操作——它需要计算终端几何尺寸、重新渲染字符网格。虽然在冻结期间被挂起，但解冻后 catch-up 队列会批量执行，可能导致解冻瞬间的卡顿。

### 4.4 contain: strict / layout 优化缺失

Workspace.module.css 第 96 行:

```css
.column {
  contain: layout style;
}
```

**分析**:
- `contain: layout`: 内部布局变化不影响外部
- `contain: style`: 计数器和引号等样式作用域限制
- 未使用 `contain: paint`: 可能允许子节点溢出影响兄弟节点
- 未使用 `contain: strict` (= `layout style paint size`)

在拖拽期间，更激进的 containment 可以限制浏览器的重排范围。考虑 `contain: paint`:
- 创建新的层叠上下文
- 将元素剪裁到其边框盒
- 内部变化不会触发父级或兄弟级的重绘

**建议**: 在拖拽期间对 `.canvas` 应用 `contain: strict`，防止内部列宽变化影响外部布局。

### 4.5 VirtualList 的 ResizeObserver 问题

VirtualList.tsx:38-67 中同样存在内联 ResizeObserver:

```typescript
const [containerHeight, setContainerHeight] = useState(0);
// ...
const resizeObserver = new ResizeObserver((entries) => {
  const ch = entries[0]?.contentRect?.height || 0;
  if (ch !== containerHeight) setContainerHeight(ch);
});
```

**问题**: VirtualList 没有检查 `isLayoutFrozen` 守卫。拖拽期间如果 VirtualList 的容器尺寸变化（例如列宽直写导致父容器变窄），会触发不必要的 re-render。

**影响**: VirtualList 的 visible range 重新计算（computeVisibleRange），调用 setState 触发子组件（DiffCard/FilesCard）重渲染。

### 4.6 ChatToolCallBlock containerWidth 问题

ChatToolCallBlock.tsx:226-289 中:

```typescript
const [containerWidth, setContainerWidth] = useState(0);
const measure = () => setContainerWidth(el.clientWidth - 24);
```

**问题**: ChatToolCallBlock 的 `measure` 函数通过 ResizeObserver 在拖拽期间仍然会被调用。虽然 ChatToolCallBlock 通常作为子组件在 ChatMessageList 内部，但列宽变化时它也会收到 resize 通知。

### 4.7 汇总: 所有受影响的组件

| 组件 | 观察内容 | 守卫 | 拖拽期间 CPU 消耗 |
|------|---------|------|-----------------|
| ChatMessageList | containerWidth | isLayoutFrozen 检查 (提前 return) | ResizeObserver 回调仍触发 |
| FilesCard | containerHeight | isLayoutFrozen 检查 (提前 return) | ResizeObserver 回调仍触发 |
| TerminalCard | 容器尺寸变化 | useSuspendedResizeObserver (挂起) | 零消耗 ✓ |
| VirtualList | containerHeight | 无守卫 | 完整执行 ✗ |
| ChatToolCallBlock | containerWidth | 无守卫 | 完整执行 ✗ |

**结论**: 至少有 2 个组件完全未受冻结保护，2 个组件只有部分保护（回调仍触发）。使用 `useSuspendedResizeObserver` 的只有 TerminalCard。

---

## 5. 列宽拖拽 vs 组高拖拽的对称分析

### 5.1 代码结构对比

**完全相同之处**:
- 事件处理结构（pointerdown → pointermove → pointerup 三阶段）
- ended guard 模式
- setPointerCapture try/catch
- window + lostpointercapture 多事件监听
- 双重 rAF 解冻
- DOM 直写 + up 时 commit store
- beginLayoutInteraction / endLayoutInteraction 配对
- body cursor 设置/清理

**不同之处**:

| 方面 | 列宽 (col) | 组高 (group) |
|------|-----------|-------------|
| 方向判断 | moveEvent.clientX - startX | moveEvent.clientY - startY |
| 容器尺寸 | canvasEl.clientWidth | colEl.clientHeight |
| left/top 计算 | splitter.getBoundingClientRect().left - canvas.left | splitter.getBoundingClientRect().top - colEl.top |
| 源比率 | colLeftRatio / colRightRatio | groupTopRatio / groupBottomRatio |
| 最小保护 | 0.1 (10%) | 0.1 (10%) |
| DOM style | width (百分比) + left (px) | height (百分比) + top (px) |
| 被操作元素 | .workspace-column × 2 | .workspace-card × 2 |
| store 方法 | resizeColumns | resizeGroups |
| store 最小保护 | 0.12 (12%) | 0.1 (10%) |

### 5.2 冻结机制对比

两者都使用 `beginLayoutInteraction('workspace-resizing')`。这意味着：
- 相同的 body class 集合：`is-layout-frozen`, `resizing-active`, `is-resizing`
- 相同的 transition/animation 禁用
- 相同的 iframe/webview pointer-events 屏蔽

**问题**: 如果用户同时拖拽列宽和组高（理论上不可能，但边界情况），它们会共享同一个冻结类型。activeAnimations Set 是去重的，所以不会出现重复冻结的问题。

### 5.3 差异点和改进可能

**差异 1: 容器尺寸快照时机**

列宽拖拽使用 `canvasEl.clientWidth || 1` 作为拖拽开始时的快照。如果 canvas 的宽度在拖拽过程中发生变化（窗口 resize 或其他组件触发了布局变化），ratioDelta 的基准会漂移。

组高拖拽使用 `colEl.clientHeight || 1`，同样的问题。

**改进**: 将 containerWidth/containerHeight 作为 closure 中的常量快照，而不是每次 move 时重新读取。

**差异 2: 引用元素获取方式**

列宽拖拽通过 querySelectorAll `.workspace-column` 获取左右列：

```typescript
const cols = canvasEl.querySelectorAll('.workspace-column');
const colLeftEl = cols[colIdx] as HTMLElement;
const colRightEl = cols[colIdx + 1] as HTMLElement;
```

组高拖拽通过 parentElement + querySelectorAll `.workspace-card` 获取上下卡片：

```typescript
const colEl = splitterEl.parentElement as HTMLElement;
const cards = colEl.querySelectorAll('.workspace-card');
const topCardEl = cards[groupIdx] as HTMLElement;
const bottomCardEl = cards[groupIdx + 1] as HTMLElement;
```

**问题**: querySelectorAll 在拖拽开始时会冻结（live collection），但如果 DOM 结构变化（如 placeholder 的隐藏/显示），集合会失效。虽然 React re-render 通常不会在拖拽期间修改 DOM 结构（因为冻结），但 drag preview 可能会。

---

## 6. 参考项目对比

### 6.1 VS Code sash.ts 架构

**文件**: reference/agent-02/vscode-sash.ts

**架构特点**:

1. **事件抽象层**: `IPointerEventFactory` 接口解耦了鼠标事件、手势事件和正交事件。`MouseEventFactory`、`GestureEventFactory`、`OrthogonalPointerEventFactory` 三个实现。

2. **布局提供者模式**: `ISashLayoutProvider` 接口将 sash 的位置/尺寸计算从 sash 本身剥离。垂直/水平布局提供者分别提供 left/top/height/width。

3. **SashState 状态机**: Disabled / AtMinimum / AtMaximum / Enabled 四种状态，对应不同的光标样式。

4. **正交支持**: orthogonalStartSash / orthogonalEndSash 支持 2×2 的 corner sashes。

5. **iframe 屏蔽**: 显式遍历 `document.getElementsByTagName('iframe')`，逐个添加/移除 CSS class。

6. **全局光标覆盖**: 创建临时 `<style>` 元素，注入 `* { cursor: ... !important; }`。

7. **Disposable 模式**: 所有临时资源都通过 DisposableStore 管理，Drag 结束后统一清理。

8. **双倍点击重置**: 支持双击 sash 重置到默认大小。

### 6.2 VS Code vs 本项目对比

| 特性 | VS Code | 本项目 |
|------|---------|--------|
| iframe 屏蔽 | 显式遍历 + CSS class | CSS 选择器 |
| 光标管理 | 动态 style 注入 | body.style.cursor |
| 事件管理 | EventEmitter + Disposable | addEventListener + removeEventListener |
| 布局计算 | 布局提供者接口 | 直接 querySelectorAll |
| 正交支持 | 完整 | 无 |
| 状态管理 | SashState 枚举 | 无（直接快照 ratio） |
| 触摸支持 | GestureEventFactory | 依赖 Pointer Events |
| 冻结机制 | 无（只有光标/iframe） | layoutAnimationStore |

### 6.3 react-resizable-panels 架构

未能成功获取源代码（404），基于公开文档和已知架构:

1. **Context 驱动**: PanelGroup 创建上下文，PanelResizeHandle 通过上下文通信。
2. **CSS 变量**: 使用 CSS custom properties 存储面板尺寸。
3. **setPointerCapture**: 确定使用 Pointer Capture API。
4. **touch-action**: 处理柄添加 `touch-action: none`。
5. **React 状态管理**: 所有尺寸都通过 React state 管理，无 DOM 直写。
6. **方向抽象**: 水平/垂直通过 orientation prop 区分。

### 6.4 VS Code iframe 屏蔽策略详细分析

VS Code 的 `onPointerStart` 中处理 iframe 的逻辑 (sash.ts):

```typescript
const iframes = this.el.ownerDocument.getElementsByTagName('iframe');
for (const iframe of iframes) {
  iframe.classList.add(PointerEventsDisabledCssClass);
}
// ... drag ...
for (const iframe of iframes) {
  iframe.classList.remove(PointerEventsDisabledCssClass);
}
```

**为什么 VS Code 选择 classList 而非 style 直写**：
1. classList 操作可以配合 CSS `!important` 规则，不受内联样式干扰
2. 多个 sash 同时拖拽时不会相互覆盖 pointer-events 值
3. CSS class 可以组合其他规则（如 `pointer-events-disabled * { pointer-events: none !important; }`）
4. classList 的 toggle 操作在 `className` 字符串复杂度高时不安全，但 VS Code 只用单个 class

**静态 class 定义**:
```css
.pointer-events-disabled {
  pointer-events: none !important;
}
```

**本项目 vs VS Code iframe 策略对比**:

| 维度 | VS Code | 本项目 |
|------|---------|--------|
| 操作方式 | classList.add/remove | CSS 选择器 + 未来 JS style 直写 |
| 动态 iframe | 拖拽开始时的快照 | CSS 选择器自动覆盖 |
| 多个 sash 并发 | 各自维护自己的 iframe 集合 | 共享 body class |
| 性能 | getElementsByTagName 是 live collection（高效） | CSS 选择器在样式重新计算时才匹配 |
| 清理复杂度 | 每个 sash 清理自己的 iframe class | 统一 body class 清理 |

**结论**: VS Code 的方式更适合多 sash 并发场景，本项目的方式更适合单一拖拽场景。两者各有利弊，但 VS Code 的精确控制更可靠。

### 6.5 VS Code 光标管理详细分析

VS Code 的动态 style 注入:

```typescript
const style = createStyleSheet(this.el);
const updateStyle = () => {
  let cursor = '';
  if (this.orientation === Orientation.HORIZONTAL) {
    cursor = isMacintosh ? 'row-resize' : 'ns-resize';
  } else {
    cursor = isMacintosh ? 'col-resize' : 'ew-resize';
  }
  style.textContent = `* { cursor: ${cursor} !important; }`;
};
updateStyle();
// ...
// onPointerUp:
style.remove();
```

**关键优势**:
1. `* { cursor: ... !important; }` 覆盖所有元素，不受层叠影响
2. `<style>` 元素可以轻易 dispose
3. 光标在 iframe 内部也生效（因为 style 在 document.head，全局作用域）
4. 与 SashState 联动：AtMinimum → w-resize, AtMaximum → e-resize

**本项目的问题** (Workspace.tsx:388):
```typescript
document.body.style.cursor = 'col-resize';
```
1. 只在 body 上设置，子元素可能覆盖
2. iframe 内部不继承 body cursor
3. 清理时 `cursor = ''` 只是移除内联样式，如果 CSS 有 cursor 规则可能不正确

### 6.6 react-resizable-panels 架构推测

基于文档和社区经验，react-resizable-panels 的架构特点:

1. **无 DOM 直写**: 所有尺寸通过 React state 管理，拖拽过程中持续触发 re-render
   - 优点是状态一致性高
   - 缺点是大组件树时性能可能不如 DOM 直写

2. **setPointerCapture 为主**: 使用 Pointer Events 的 capture 机制，无额外 overlay

3. **CSS 变量布局**: 面板尺寸通过 CSS custom properties 传递
   - 适用于 CSS subgrid 和 container queries

4. **React 18 过渡**: 使用 startTransition 标记 resize 更新为非紧急更新

**对比**: 本项目的 DOM 直写方式理论上性能更优（跳过 React 协调），但在 iframe 场景和状态管理上不如 react-resizable-panels 的纯 React 方案健壮。

### 6.7 本项目的差距

1. **iframe/webview 屏蔽不够精确**: 全局 CSS 选择器 vs VS Code 的精确 classList 操作。CSS 选择器无法覆盖动态创建的 iframe（除非 mutation observer）。

2. **缺少正交 sash 支持**: 2×2 分割时需要 corner drag handle，当前架构不支持。

3. **事件管理不统一**: 每次拖拽创建新的闭包事件处理函数，没有统一的工厂模式。

4. **无 Disposable 模式**: 使用手动 ended flag + removeEventListener，容易遗漏清理路径。

5. **解冻时机不可靠**: 双重 rAF 缺乏 fallback。如果浏览器不支持 rAF（极罕见），解冻不会发生。

6. **光标覆写脆弱**: `body.style.cursor` 可能被子元素的内联样式覆盖。VS Code 的 style 注入 `* { cursor: ... !important; }` 更可靠。

---

## 7. 根因结论

### 7.1 卡顿根因：拖拽不跟手

**原因 1: Pointer Capture 丢失导致 pointermove 中断**

当用户快速拖拽时，鼠标指针可能滑入 iframe/webview 区域。由于 iframe 有独立文档上下文，`setPointerCapture` 无法跨边界传递事件。即使有 `window.addEventListener('pointermove', ...)` 作为 fallback，iframe 内部的事件也不会冒泡到主文档的 window。

**严重程度**: ★★★★★（频繁复现）
**影响**: 拖拽突然中断，splitter 卡在半路，用户需要再次拖拽

**原因 2: setPointerCapture 的 try/catch 没有 fallback**

如果 `setPointerCapture` 抛出异常（例如 pointerId 无效或元素已 detached），代码仅静默 catch，然后依赖 window 级事件监听。但 window 级监听在 iframe 场景中也会失效。

**严重程度**: ★★★★☆

**原因 3: ResizeObserver 在解冻后瞬间触发大量计算**

双重 rAF 解冻后，所有被挂起的 ResizeObserver 回调同时触发（catch-up 队列）。ChatMessageList 的 Pretext 计算、FilesCard 的容器高度、TerminalCard 的 fitAddon.fit() 都在同一帧内执行，造成明显的帧率下降。

**严重程度**: ★★★★☆

### 7.2 卡顿根因：布局抖动

**原因 4: 百分比基准漂移**

直写 DOM style 使用百分比值（`colLeftEl.style.width = "50%"`）。百分比的计算基准是父容器的宽度。如果拖拽过程中父容器尺寸变化（例如某个 ResizeObserver 触发了 re-render），百分比实际像素值会改变，导致视觉抖动。

**严重程度**: ★★★☆☆

**原因 5: 缺少 contain: paint**

`.column` 使用了 `contain: layout style` 但没有 `paint`。子节点的溢出可能会触发兄弟列的布局重新计算。

**严重程度**: ★★☆☆☆

**原因 6: 通配符选择器性能**

`body.is-layout-frozen * { transition: none !important; }` 通配符选择器需要浏览器遍历所有元素。在大型页面（数千个 DOM 节点）中，每次样式重新计算都会扫描所有元素。

**严重程度**: ★★☆☆☆

### 7.3 汇总优先级

| 问题 | 影响 | 修复难度 | 优先级 |
|------|------|---------|--------|
| Pointer Capture 在 iframe 失效 | 拖拽中断 | 中 | P0 |
| 缺少全局 pointermove 遮罩 | 拖拽中断 | 低 | P0 |
| ResizeObserver 解冻后集中触发 | 解冻卡顿 | 中 | P1 |
| 缺少 contain: paint | 轻微布局波动 | 低 | P2 |
| 通配符 CSS 选择器性能 | 微小开销 | 低 | P3 |
| 百分比基准漂移 | 视觉抖动 | 高 | P1 |

### 7.4 架构性结论

当前架构的核心设计是 "sash 模式" (DOM 直写 + up 时 commit store)。这个模式在简单场景（无 iframe/webview）下表现良好，但在复杂的 Electron 应用中存在根本性缺陷：

1. **事件边界**: Pointer Events 无法穿越 iframe/webview 边界，而 Electron 应用中这些组件无处不在。
2. **双轨状态**: DOM 直写和 React state 双轨运行，解冻时机需要精确协调，否则出现视觉撕裂。
3. **冻结依赖**: 冻结机制依赖 body class 和 CSS 选择器，但 CSS 无法完全阻止 iframe 内部的事件处理。

解决这些问题需要借鉴 VS Code 的 "iframes 显式屏蔽 + 全局 overlay" 策略，以及更可靠的冻结生命周期管理。
