# Cross-03: ResizeObserver 与性能审计

> 交叉验证 Date: 2026-07-22
> Scope: ResizeObserverManager 单例、new ResizeObserver 残留、useBubbleShrinkWidth 强制重排、CSS contain 注入、isLayoutFrozen 守卫覆盖率、invalidateAllActual 接线

---

## 1. ResizeObserverManager 实现状态

**结论：已创建但零消费者，是一个死单例。**

文件路径：`apps/crish-desktop/src/services/ResizeObserverManager.ts` (88 行)

| 能力 | 状态 | 说明 |
|------|------|------|
| 单例模式 (`getInstance()`) | ✅ | `private static instance` + 惰性初始化 |
| `observe(el, cb)` | ✅ | 自动 `ro.observe(el)`，支持多回调 |
| `unobserve(el, cb)` | ✅ | 回调清空后自动 `ro.unobserve` + 清理 entries |
| `setSuspended(bool)` | ✅ | 挂起时推入 `pendingQueue`，解冻后 rAF 分批 flush (每批 5 个) |
| `destroy()` | ✅ | 清理所有 observer、回调、pending 队列 |
| `isLayoutFrozen` 集成 | ❌ | 只有 `isSuspended` 字段，未订阅 store |
| **被任何组件使用** | **❌** | `grep ResizeObserverManager src/` 结果只有文件自身 |

`setSuspended` 目前是独立机制，未与 `layoutAnimationStore.isLayoutFrozen` 关联。即使调用了 `setSuspended(true)`，也需要消费者手动触发，而消费者为零，所以该能力完全不可达。

**关键缺失：**
- 没有 `useManagedResizeObserver` hook 封装
- 没有任何组件引入或调用 `ResizeObserverManager.getInstance()`
- 规划文档 (`agent-08-plan.md`, `ULTIMATE-REFACTOR-PLAN.md`) 要求统一单例，但生产代码未执行

---

## 2. 其他 RO 使用点枚举

共 **11 个独立 `new ResizeObserver` 实例**（不含 manager 自身）。

| # | 文件 | 行号 | 用途 | 有 isLayoutFrozen 守卫？ |
|---|------|------|------|------------------------|
| 1 | `hooks/useAutoGrowTextarea.ts` | 140 | textarea 高度自适应 + `el.clientWidth` 读取 | ❌ |
| 2 | `hooks/useSuspendedResizeObserver.ts` | 41 | **通用挂起 RO hook** — 有 catch-up 集成 | ✅ 自带 isLayoutFrozen 检查 |
| 3 | `hooks/useVirtualScroll.ts` | 94 | viewport 高度跟踪 | ❌ |
| 4 | `hooks/useVirtualDiffScroll.ts` | 12 | diff 面板容器高度跟踪 | ❌ |
| 5 | `hooks/useTextMeasure.ts` | 127 | `useBubbleShrinkWidth` 内的 RO | ❌ |
| 6 | `components/ChatToolCallBlock.tsx` | 232 | tool call 输出容器宽度测量 | ❌ |
| 7 | `components/ChatMessageList.tsx` | 663 | 容器宽度跟踪 → `setContainerWidth` | ✅ (L655 检查 `isLayoutFrozen`) |
| 8 | `components/ChatMessageList.tsx` | 746 | 行实际高度 RO (setActual) | ❌ (无守卫) |
| 9 | `components/FilesCard.tsx` | 92 | 文件列表容器高度 | ✅ (L94 检查 `isLayoutFrozen`) |
| 10 | `components/sidebar/SidebarSessionList.tsx` | 268 | 虚拟滚动 range 更新 | ❌ |
| 11 | `components/VirtualList.tsx` | 54 | 容器高度跟踪 | ❌ |

### 守卫覆盖率分析

- **有守卫**：ChatMessageList (容宽 RO), FilesCard, useSuspendedResizeObserver → 3/11 (27%)
- **无守卫**：useAutoGrowTextarea, useVirtualScroll, useVirtualDiffScroll, useBubbleShrinkWidth, ChatToolCallBlock, ChatMessageList (行高 RO), SidebarSessionList, VirtualList → 8/11 (73%)

冻结期间仍会触发的 RO 可能导致不必要的布局计算。

---

## 3. useBubbleShrinkWidth 残留

**结论：仍活跃，是代码库中唯一的强制同步重排源。**

- 定义：`apps/crish-desktop/src/hooks/useTextMeasure.ts:75-141`
- 内部 **`new ResizeObserver`** (L127)：每个气泡挂载一个独立 RO
- **`clientWidth` 读取** (L97)：`containerRef.current.clientWidth` → 强制同步重排
- **300ms debounce** (L116/L121)：仅限频，不消除重排

### 调用点（仍然 2 处）

| 组件 | 行号 | 用途 | horizontalPadding |
|------|------|------|-----------------|
| `ChatMessageRow.tsx:307` | `ChatUserMessageRowInner` | 用户气泡宽度 | 32px |
| `ChatMessageRow.tsx:569` | `ChatAssistantMessageRowInner` | 助手气泡宽度 | 0px |

### 危害

1. 每条消息行独立创建 RO → `O(n)` observer 实例
2. 每次回调读取 `clientWidth` → 强制同步布局
3. 计算结果写回 `setState` → 触发 React re-render → 可能再次触发 RO → **布局重排死循环**
4. 无 `isLayoutFrozen` 守卫 → 冻结期间仍持续触发

规划文档 (`01-CHAT-LIST-AND-PRETEXT-REFACTOR-GUIDE.md`) 要求 "彻底废除 `useBubbleShrinkWidth` 并转向 CSS 原生 `fit-content`"，但**从未执行**。

---

## 4. CSS contain 注入现状

### 4.1 冻结期间 contain 规则

文件：`apps/crish-desktop/src/styles/shell/shell-dragdrop.css:168-183`

```css
body.is-layout-frozen .workspace-canvas { contain: layout style; }
body.is-layout-frozen .workspace-column { contain: layout style; }
body.is-layout-frozen .workspace-card  { contain: layout style; }
body.is-layout-frozen .chat-message-list { contain: layout style; }
body.is-layout-frozen .sidebar-content { contain: layout; }
```

**正确的设计决策：**
- 使用 `contain: layout style`（非 `strict`），注释声明 `/* 使用 contain: layout style（不含 paint/strict）防止裁剪 tooltip */` ✅
- 仅冻结期间注入，不破坏常态渲染 ✅
- `.sidebar-content` 使用 `contain: layout`（无 style），因为 sidebar 不需要隔离 CSS 计数器等 ✅

### 4.2 固定浮层的 contain

```css
.global-drag-overlay   { contain: strict; }
.drop-indicator-layer  { contain: strict; }
```

对于 fixed 定位浮层使用 `contain: strict` 是合理的 ✅（它们不产生 tooltip 裁剪问题）

### 4.3 遗漏的容器

- **`.workspace-column` 常态 contain**：仅冻结期有 contain，常态无。这合理，因为 contain 会影响动态布局。
- **`.chat-message-list` 常态 contain**：同上，仅冻结期。
- **消息行级别的 contain**：未对单个 `.chat-message-row` 或 `.message-bubble` 设置 contain。如果能在常态为气泡设置 `contain: layout style`，可以限制行级重排传播。

### 4.4 注入机制有效性

CSS contain 完全依赖 `body.is-layout-frozen` class，而该 class 由 `layoutAnimationStore.syncBodyFromActive()` 管理。只要 store 正确工作，contain 就会生效。✅

---

## 5. isLayoutFrozen → ResizeObserver 守卫现状

### 5.1 已接入的守卫方式

| 方式 | 使用方 | 机制 |
|------|--------|------|
| `useLayoutAnimationStore.getState().isLayoutFrozen` 直接读取 | ChatMessageList (L655), FilesCard (L94) | 在 RO 回调中检查，frozen 时直接 return |
| `useSuspendedResizeObserver` | TerminalCard (规划中) | RO 回调中检查 isFrozen，冻结时注册 catch-up 任务，解冻后 flushSync 批量执行 |
| `useResizeFreeze` | ChatMessageList (L554) | 订阅 store.isLayoutFrozen，返回 isResizing；用于 setContainerWidth callback 守卫 |

### 5.2 缺失守卫的 RO（风险列表）

1. **useBubbleShrinkWidth** (useTextMeasure.ts:127) — 最严重，无守卫 + 强制重排
2. **useAutoGrowTextarea** (useAutoGrowTextarea.ts:140) — 无守卫，还读取 `clientWidth`
3. **useVirtualScroll** (useVirtualScroll.ts:94) — 无守卫
4. **useVirtualDiffScroll** (useVirtualDiffScroll.ts:12) — 无守卫
5. **ChatToolCallBlock** (ChatToolCallBlock.tsx:232) — 无守卫，读取 `clientWidth`
6. **ChatMessageList 行高 RO** (ChatMessageList.tsx:746) — 无守卫
7. **SidebarSessionList** (SidebarSessionList.tsx:268) — 无守卫
8. **VirtualList** (VirtualList.tsx:54) — 无守卫

严重程度分级：
- **P0**: useBubbleShrinkWidth（+clientWidth 强排）
- **P1**: useAutoGrowTextarea（+clientWidth）, ChatToolCallBlock（+clientWidth）
- **P2**: 其余 5 个纯高度跟踪 RO

### 5.3 Catch-up 队列机制验证

`layoutAnimationStore.ts` 的 catch-up 机制：
- `registerCatchupTask(key, task)` → 存入 `catchupQueue: Map<string, CatchupTask>`
- `flushCatchupTasks()` → `flushSync(() => { queue.forEach(task => task()); })` → 清空 → phase='idle'
- `endAnimation()` → 当 `!isStillFrozen` 时自动 `flushCatchupTasks()`

✅ 机制完整。但仅有 `useSuspendedResizeObserver` 使用该机制。

---

## 6. ChatMessageList 宽度剧变 → invalidateAllActual 接线

**结论：已正确接线。**

代码位置：`apps/crish-desktop/src/components/ChatMessageList.tsx:638-647`

```typescript
const setContainerWidth = useCallback((width: number) => {
    if (isResizing) return;
    setContainerWidthState(width);
    const prev = prevWidthRef.current;
    prevWidthRef.current = width;
    if (prev > 0 && Math.abs(width - prev) >= 40) {
      manager.invalidateAllActual();  // ← 宽度变化 ≥ 40px 时触发
      setHeightTick(t => t + 1);
    }
}, [isResizing, manager, setHeightTick]);
```

`VirtualScrollManager.invalidateAllActual()` (`apps/crish-desktop/src/api/VirtualScrollManager.ts:217-223`) 将所有 `entry.actual = null`，标记 `dirtyFrom = 0`，使全部消息行进入重估状态。

**审查结论：**
- ✅ 40px 阈值合理（过滤微小 resize 抖动）
- ✅ 设 `dirtyFrom = 0` 完整失效
- ✅ 配合 `setHeightTick` 触发重渲染
- ⚠️ `isResizing` 守卫来自 `useResizeFreeze`，有 150ms debounce → 解冻后可能错过第一次宽度更新（但 pretext 估算是 catch-up 安全网）

---

## 7. 剩余问题清单

| ID | 问题 | 文件 | 严重度 | 类型 |
|----|------|------|--------|------|
| R1 | ResizeObserverManager 是死单例，零消费者 | `services/ResizeObserverManager.ts` | P0 | 未完成 |
| R2 | useBubbleShrinkWidth 仍活跃（+clientWidth 强排） | `hooks/useTextMeasure.ts:75-141` | P0 | 强制重排 |
| R3 | useBubbleShrinkWidth 在 ChatMessageRow 被调用 2 处 | `components/ChatMessageRow.tsx:307,569` | P0 | 强制重排 |
| R4 | useAutoGrowTextarea RO 无冻结守卫 | `hooks/useAutoGrowTextarea.ts:140` | P1 | 缺守卫 |
| R5 | ChatToolCallBlock RO 无冻结守卫 + clientWidth | `components/ChatToolCallBlock.tsx:232` | P1 | 缺守卫 |
| R6 | ChatMessageList 行高 RO 无冻结守卫 | `components/ChatMessageList.tsx:746` | P2 | 缺守卫 |
| R7 | useVirtualScroll RO 无冻结守卫 | `hooks/useVirtualScroll.ts:94` | P2 | 缺守卫 |
| R8 | useVirtualDiffScroll RO 无冻结守卫 | `hooks/useVirtualDiffScroll.ts:12` | P2 | 缺守卫 |
| R9 | SidebarSessionList RO 无冻结守卫 | `components/sidebar/SidebarSessionList.tsx:268` | P2 | 缺守卫 |
| R10 | VirtualList RO 无冻结守卫 | `components/VirtualList.tsx:54` | P2 | 缺守卫 |
| R11 | ResizeObserverManager 未订阅 isLayoutFrozen | `services/ResizeObserverManager.ts` | P1 | 架构缺陷 |
| R12 | 缺少 `useManagedResizeObserver` hook（规划产物） | — | P1 | 缺失工具 |
| R13 | contain 未覆盖消息行级别（常态裁剪缺失） | — | P3 | 优化 |

---

## 8. 修复方案

### 8.1 P0 — 立即执行

#### F1: 移除 useBubbleShrinkWidth
```
操作: 删除 useTextMeasure.ts 中 useBubbleShrinkWidth 函数 (L75-141)
     删除 ChatMessageRow.tsx 中 import 和 2 处调用 (L307, L569)
     气泡宽度改用 CSS fit-content + max-width: 100%
影响: 消除 ~1573 次强制同步重排，消除每条消息的独立 RO
风险: 低 — 回归到 CSS 原生行为，设计文档已确认
```

#### F2: 激活 ResizeObserverManager 单例或确认废弃
```
方案 A（推荐）: 
  1. 创建 `useManagedResizeObserver` hook，内部调用 RO Manager
  2. Manager 追加 `setSuspended` 与 `isLayoutFrozen` 联动
  3. 逐步替换各组件直接 new ResizeObserver

方案 B: 
  如果 useSuspendedResizeObserver 已满足需求，正式废弃 RO Manager，
  更新文档并删除该文件
```

### 8.2 P1 — 高优先级

#### F3: useAutoGrowTextarea 追加冻结守卫
```typescript
// useAutoGrowTextarea.ts RO 回调内
if (useLayoutAnimationStore.getState().isLayoutFrozen) return;
```

#### F4: ChatToolCallBlock 追加冻结守卫
```typescript
// ChatToolCallBlock.tsx RO 回调内
if (useLayoutAnimationStore.getState().isLayoutFrozen) {
  ro.disconnect(); // 或 return
}
```

#### F5: ResizeObserverManager 对接 isLayoutFrozen
```
Manager.setSuspended(isLayoutFrozen) 改为自动订阅 store。
使用 useSyncExternalStore 或 useEffect + subscribe。
```

### 8.3 P2 — 中等优先级

#### F6: 其余 5 个 RO 追加守卫
ChatMessageList 行高 RO (L746)、useVirtualScroll、useVirtualDiffScroll、SidebarSessionList、VirtualList 全部追加 `isLayoutFrozen` 检查。

### 8.4 P3 — 低优先级优化

#### F7: 消息行级别 CSS contain
```
.chat-message-row { contain: layout style; }
```
常态启用，限制单行重排传播到整列。

---

## 9. 优先级总结

| 优先级 | 任务数 | 关键动作 | 预期收益 |
|--------|--------|----------|----------|
| P0 | 2 | 移除 useBubbleShrinkWidth + 处理死单例 | 消除 ~1573 次强制重排，RO 实例减 2 |
| P1 | 3 | 追加 2 个 clientWidth RO 守卫 + Manager 对接 frozen | 消除冻结期额外 3 个 RO 触发 |
| P2 | 5 | 追加 5 个纯高度 RO 守卫 | 消除冻结期额外 5 个 RO 触发 |
| P3 | 1 | 消息行常态 contain | 减少行级重排传播 |

**当前实现状态评分：C−（严重不完整）**
- ResizeObserverManager 已创建但完全未使用
- useBubbleShrinkWidth 强制重排仍在生产环境运行
- 仅 27% 的独立 RO 实例有冻结守卫
- CSS contain 注入正确但范围有限
- invalidateAllActual 接线正确
