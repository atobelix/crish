# Agent 1: 聊天消息重复 & 虚拟滚动分析

## 1. 问题复现路径

### 1.1 从 store 到渲染的完整链路

用户发送消息或 AI 产生回复时，数据流如下：

```
用户操作 / AI 回复
  → store.addMessage(wsId, sessionId, message)        // chat.ts:26
    → immer set: sess.messages.push(prepared)          // chat.ts:46
    → zustand 状态变更通知
  → ChatCard useSessionField (sessionStore.ts:71)
    → messages = sessionsById[activeSessionId]?.messages
  → displayMessages = useMemo(                            // ChatCard.tsx:365
      messages.filter(...) 或 messages 本身
    )
  → <ChatMessageList messages={displayMessages}>         // ChatCard.tsx:1195
  → messageWindow = windowMessages(messages, ...)         // ChatMessageList.tsx:251
    → startIndex = len - (recent + expanded)              // messageWindow.ts:134
    → visible = messages.slice(startIndex)                // messageWindow.ts:136
  → visibleIds = useMemo(                                 // ChatMessageList.tsx:553
      visibleMessages.map(m => m.id), [visibleMessages]
    )
  → useVirtualScroll({ itemCount, ids: visibleIds })      // ChatMessageList.tsx:556
    → useEffect: manager.syncOrder(ids)                   // useVirtualScroll.ts:62
    → computeVisibleRange(scrollTop, viewportHeight, ...)  // useVirtualScroll.ts:107
  → 渲染: visibleMessages.slice(startIndex, endIndex)      // ChatMessageList.tsx:902
```

### 1.2 clearHeights 触发条件

`clearHeights` 的定义在 `useVirtualScroll.ts:184`:
```typescript
const clearHeights = useCallback(() => {
    manager.clear();
    setHeightTick((t) => t + 1);
}, [manager]);
```

调用位置在 `ChatMessageList.tsx:577`:
```typescript
useLayoutEffect(() => {
    if (prevSessionIdForHeightsRef.current !== activeSessionId) {
      prevSessionIdForHeightsRef.current = activeSessionId;
      clearHeights();       // ← 此处的调用
      prevVisibleIdsRef.current = visibleIds;
      return;
    }
    // ... scroll compensation
}, [activeSessionId, visibleIds, clearHeights, containerRef, manager]);
```

触发条件：**仅当 `activeSessionId` 改变时**（会话切换）。

### 1.3 数据流追踪图

```
                   ┌──────────────────────┐
                   │   Zustand Store      │
                   │  sessionsById[id]    │
                   │    .messages[]       │
                   └──────────┬───────────┘
                              │ useSessionField selector
                              ▼
                   ┌──────────────────────┐
                   │   ChatCard           │
                   │  messages (完整列表) │
                   │  displayMessages     │
                   └──────────┬───────────┘
                              │ props
                              ▼
              ┌─────────────────────────────┐
              │ ChatMessageList             │
              │                             │
              │  messageWindow =            │
              │    windowMessages(messages) │
              │    → startIndex             │
              │    → visible (尾部切片)     │
              │                             │
              │  visibleIds =               │
              │    visible.map(m => m.id)   │
              │                             │
              │  useVirtualScroll({         │
              │    itemCount, ids,          │
              │    overscan, fallback       │
              │  })                         │
              │    → useEffect: syncOrder   │
              │    → visibleRange           │
              │        startIndex           │
              │        endIndex             │
              │        startOffset          │
              │        estimatedTotalHeight │
              │                             │
              │  useLayoutEffect:           │
              │    session switch → clear   │
              │    window pan → scroll cmp  │
              └──────────┬──────────────────┘
                         │ render
                         ▼
              ┌─────────────────────────────┐
              │ <div style=height:startOff> │ 顶部 spacer
              │ visible.slice(si, ei).map   │ 可视消息
              │ <div style=height:bottom>   │ 底部 spacer
              └─────────────────────────────┘
```

## 2. VirtualScrollManager 源码深度分析

### 2.1 heights Map：messageId → HeightEntry

文件 `VirtualScrollManager.ts:19-22`:
```typescript
interface HeightEntry {
  estimated: number;    // Pretext 预测量
  actual: number | null; // ResizeObserver 回写量
  version: number;      // 版本号，用于 setActual 的 callerVersion 比对
}
```

- **estimated**：来自 `setEstimated(id, height)`，由 ChatMessageList.tsx 的 Pretext 测量 useEffect 设置（L650-711）。每批最多处理 5 条（`CHUNK_SIZE = 5`），通过 rAF 离散执行。
- **actual**：来自 `setActual(id, height)`，由 ChatMessageList.tsx 的 ResizeObserver 回调设置（L717-752）。渲染后 DOM 实际高度回写。
- **version**：每次 entry 变更时递增。用于 `setActual` 的 `callerVersion` 参数做乐观锁，防止旧版 actual 覆盖新版（VirtualScrollManager.ts:169）。

heights Map 的 key 是 `messageId`（`msg.id`），这意味着当窗口平移时，只要 id 相同，高度记录就保留。这是「以 msg.id 为唯一键」的核心设计。

### 2.2 order 数组（id 排序）

`VirtualScrollManager.ts:31`:
```typescript
private order: string[] = [];
```

order 是**当前窗口/列表的 id 有序数组**。index = order 中的位置。

关键语义：
- `order.length` 不一定等于 `visibleMessages.length`（但通常应该相等）
- `idToIndex` 是 order 的倒排索引（`VirtualScrollManager.ts:32`）
- `getHeightAt(index)` 通过 `order[index]` 查 id，再用 `getHeight(id)` 取高度：
  ```typescript
  getHeightAt(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    const id = this.order[safeIndex];
    if (id == null) return this.fallbackHeight;
    return this.getHeight(id);
  }
  ```

### 2.3 offsets 缓存 + suffix rebuild 机制

`VirtualScrollManager.ts:40-45`:
```typescript
private offsetsCache: number[] | null = null;
private dirtyFrom: number | undefined = undefined;
```

- `offsetsCache[i]` = index i 之前（不含 i）的总高度
- `offsetsCache[0]` = 0 恒成立
- `offsetsCache[order.length]` = 总高度

**dirtyFrom + suffix rebuild 的运作方式**：

当 index `i` 的高度发生变化时：
1. `offsets[0..=i]` 仍然有效（因为这些 offsets 不包含 index i 的高度）
2. 只需从 `offsets[i+1]` 起重算

```typescript
private markDirtyFrom(index: number): void {
    const safe = normalizeNonNegInt(index);
    if (this.dirtyFrom === undefined) {
      this.dirtyFrom = safe;
    } else {
      this.dirtyFrom = Math.min(this.dirtyFrom, safe);
    }
}

private rebuildOffsetsSuffix(changedIndex: number, len: number): void {
    // offsets[0..=changedIndex] 保持；从 changedIndex+1 起重算
    const start = Math.max(1, changedIndex + 1);
    if (start === 1) {
      this.offsetsCache[0] = 0;
    }
    for (let i = start; i < targetLen; i++) {
      const prev = this.offsetsCache[i - 1];
      const base = prev != null && Number.isFinite(prev) ? prev : 0;
      this.offsetsCache[i] = base + this.getHeightAt(i - 1);
    }
    this.dirtyFrom = undefined;
}
```

**关键**：注释中写明（L304-305）「**禁止** offsetsCache = null 全量丢弃（除非 clear / 首次）」。

### 2.4 syncOrder 核心逻辑

`VirtualScrollManager.ts:57-89`:

```typescript
syncOrder(ids: string[]): void {
    const next = Array.isArray(ids) ? ids : [];
    let firstDiff = 0;
    const minLen = Math.min(next.length, this.order.length);
    while (firstDiff < minLen && next[firstDiff] === this.order[firstDiff]) {
      firstDiff++;
    }
    const same =
      firstDiff === next.length && next.length === this.order.length;
    if (same) return;  // ← 完全相同则跳过

    this.order = next.slice();
    this.rebuildIdIndex();

    if (this.offsetsCache == null) {
      this.dirtyFrom = 0;
      return;
    }

    const needed = this.order.length + 1;
    if (this.offsetsCache.length > needed) {
      this.offsetsCache.length = needed;
    }
    this.markDirtyFrom(
      firstDiff >= this.order.length
        ? Math.max(0, this.order.length - 1)
        : firstDiff
    );
    // 纯尾部追加优化
    if (firstDiff > 0 && firstDiff === minLen && next.length > minLen) {
      this.dirtyFrom = firstDiff;
    }
}
```

**设计要点**：
1. **前缀相等检测**：从头遍历找到第一个不同的位置 `firstDiff`，避免不必要地重建整个 offsets。
2. **全等跳过**：如果 `next` 与 `this.order` 完全相同，直接 return（`same = true`）。
3. **裁剪过长的偏移缓存**：如果新 order 变短，直接 `offsetsCache.length = needed`。
4. **纯尾部追加优化**：如果仅追加（`firstDiff === oldLen`），dirtyFrom 设为 firstDiff（即追加起始位置），offsets[0..=oldLen] 仍然有效。

### 2.5 computeVisibleRange 计算

`VirtualScrollManager.ts:103-128`:

```typescript
computeVisibleRange(
    scrollTop: number,
    viewportHeight: number,
    itemCount: number,
    overscan: number,
): VisibleRange {
    // ...
    const startIndex = Math.max(0,
      this.findIndexAtOffset(safeScrollTop, count) - safeOverscan);
    const visibleEnd = this.findIndexAtOffset(
      safeScrollTop + safeViewportHeight, count);
    const endIndex = Math.min(count,
      visibleEnd + 1 + safeOverscan);

    return {
      startIndex,
      endIndex,
      startOffset: this.getOffset(startIndex),
      estimatedTotalHeight: this.getTotalHeight(count),
    };
}
```

`findIndexAtOffset` 使用二分查找（`offsetsCache` 上的 `while (lo < hi)`）：

```typescript
findIndexAtOffset(offset: number, itemCount?: number): number {
    // ...
    this.ensureOffsets(count);
    const offsets = this.offsetsCache!;
    let lo = 0;
    let hi = Math.min(count, offsets.length - 1);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid]! <= safeOffset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return Math.max(0, lo - 1);
}
```

### 2.6 getHeightAt / setEstimated / setActual

**getHeightAt**（L139-143）：通过 order[index] 取 id，再委托 getHeight(id)。

**setEstimated**（L147-161）：设置预测量。
- 如果该 id 已有 actual，不覆盖（`if (existing.actual != null) return;`）
- 如果 estimated 相同，不触发
- 变更后 `markDirtyFrom(index)` → suffix rebuild

**setActual**（L164-178）：设置实际高度。
- 如果 `callerVersion < existing.version`，说明有更新版本，跳过
- 如果 actual 相同，跳过
- 变更后 `markDirtyFrom(index)` → suffix rebuild

## 3. clearHeights 问题根源

### 3.1 为什么 startIndex 变化不应清空高度

`messageWindow.startIndex` 变化意味着消息窗口的起点发生了平移。**但这种平移发生在同一个会话内部**，可能是以下原因之一：

1. **新消息到达**：messages.length 增加 → startIndex 前移（窗口向尾部移动）
2. **expand older**：expandedOlder 增加 → startIndex 后移（窗口向头部扩展）
3. **showAll**：startIndex = 0（展开全部）
4. **mustInclude 抬升**：搜索命中/待审批消息导致窗口前移

这些场景下，消息的 id 绝大部分保持不变。如果清空高度（`clear()`），所有已有高度记录都会丢失，导致：
- `getHeightAt` 对所有 id 返回 `FALLBACK_HEIGHT`
- 偏移量从头计算，产生错误值
- 在 syncOrder 尚未到达的时间窗口内，渲染使用错误的偏移量

### 3.2 对比 vindex 时代 vs msg.id 时代的差异

**vindex（virtual index）时代**：
- 高度按「行号」索引：`heights[index]`
- 窗口平移时，同一行号的对应关系完全改变（index 0 现在是不同的消息）
- 清空高度是合理的，「旧行号的高度对新消息无意义」

**msg.id 时代（当前设计）**：
- 高度按「消息 id」索引：`heights Map<messageId, HeightEntry>`
- 窗口平移时，消息 id 保持不变
- **清空高度是破坏性的**——丢失了已渲染消息的高度数据

VirtualScrollManager 的注释（L54-56）已经明确说明：
> 「窗口平移时应调用本方法（syncOrder），禁止 clear 全量高度」

### 3.3 clearHeights 后 order 为空 → 连锁影响

当 `clear()` 被调用时（L267-273）：
```typescript
clear(): void {
    this.heights.clear();
    this.order = [];
    this.idToIndex.clear();
    this.offsetsCache = null;
    this.dirtyFrom = undefined;
}
```

之后到 `syncOrder` 被调用前的时间窗口内：
1. **order = []**
2. **getHeightAt(index)**：`this.order[safeIndex]` → `undefined` → 返回 `FALLBACK_HEIGHT`
3. **computeVisibleRange**：依赖 `ensureOffsets` → `rebuildOffsetsSuffix` → 全部使用 fallback
4. **startOffset**：使用错误的 fallback 偏移量
5. **estimatedTotalHeight**：使用错误的 fallback 总高度

渲染时（ChatMessageList.tsx:902）：
- `visibleMessages.slice(startIndex, endIndex)` 使用 React 的 messages 数组（不受 clear 影响）
- 但 `startOffset`（顶部 spacer 高度）和 `estimatedTotalHeight`（底部 spacer）使用错误值
- 结果：消息渲染在错误的滚动位置

### 3.4 契约注释中已说明"禁止 clear"，但实际 effect 仍在执行

代码中 `ChatMessageList.tsx:564-568` 的注释：
```
/**
 * 高度生命周期（契约 01-contract §1）：
 * - 会话切换：clearHeights / manager.clear
 * - 窗口平移 / expand older：仅依赖 useVirtualScroll 的 syncOrder(ids)，禁止 clear
 * - expand older 导致 prepend 时做 scrollTop 锚点补偿，避免视口跳动
 */
```

**实际执行路径**（L573-613）：
```typescript
useLayoutEffect(() => {
    if (prevSessionIdForHeightsRef.current !== activeSessionId) {
      prevSessionIdForHeightsRef.current = activeSessionId;
      clearHeights();       // ← 仅在会话切换时执行
      prevVisibleIdsRef.current = visibleIds;
      return;
    }
    // ... scroll compensation
}, [activeSessionId, visibleIds, clearHeights, containerRef, manager]);
```

**静态分析结论**：当前代码中 `clearHeights()` 确实**只在会话切换时触发**（`prevSessionIdForHeightsRef.current !== activeSessionId`）。窗口平移时不会误触。

**潜在风险**：但如果 `activeSessionId` 的值在同一个会话过程中由于某种原因发生了`'' → id → ''`的切换，或者父组件传入了不稳定的 `activeSessionId`，就会导致意外的 clearHeights 调用。

## 4. useVirtualScroll Hook 分析

### 4.1 syncOrder 在 ids 引用未变时不会再次触发的条件

`useVirtualScroll.ts:62-67`:
```typescript
useEffect(() => {
    if (ids && Array.isArray(ids)) {
      manager.syncOrder(ids);
      setHeightTick((t) => t + 1);
    }
}, [manager, ids]);
```

- `ids` 依赖是**引用比较**（React useEffect 默认行为）
- 如果 `ids` 是同一个数组引用，这个 effect 不会触发
- 在 ChatMessageList.tsx:553，`visibleIds` 是 `useMemo(() => ..., [visibleMessages])`。只有当 `visibleMessages` 变化时 `visibleIds` 才产生新引用
- **如果 `visibleMessages` 引用未变，`syncOrder` 就不会被调用**

这意味着如果 `messageWindow.visible` 引用未变（即 `messages` + `expandedOlder` + `showAllMessages` + `mustIncludeIndices` 都未变），则 manager.order 不会更新。

### 4.2 heightTick 机制

`heightTick` 是一个计数器状态（`useState(0)`），用于强制重算 `visibleRange` 和 `totalHeight`：

```typescript
const [heightTick, setHeightTick] = useState(0);
```

触发 heightTick 变更的路径：
1. **syncOrder**（L65）：`setHeightTick((t) => t + 1)`
2. **setEstimated rAF 批量刷入**（L146）：`setHeightTick((t) => t + 1)`
3. **setActual rAF 批量刷入**（L169）：`setHeightTick((t) => t + 1)`
4. **clearHeights**（L186）：`setHeightTick((t) => t + 1)`

heightTick 通过 `useMemo` 的 `void heightTick;` 表达式关联到 `visibleRange` 和 `totalHeight`：

```typescript
const visibleRange = useMemo(() => {
    void heightTick;  // ← heightTick 变化时强制重算
    return manager.computeVisibleRange(scrollTop, viewportHeight, itemCount, overscanSafe);
}, [manager, scrollTop, viewportHeight, itemCount, overscanSafe, heightTick]);
```

### 4.3 startIndex/endIndex/totalHeight 计算

在 `useVirtualScroll.ts:107-116`:

```typescript
const visibleRange = useMemo(() => {
    void heightTick;
    return manager.computeVisibleRange(
      scrollTop, viewportHeight, itemCount, overscanSafe);
}, [manager, scrollTop, viewportHeight, itemCount, overscanSafe, heightTick]);

const totalHeight = useMemo(() => {
    void heightTick;
    return manager.getTotalHeight(itemCount);
}, [manager, itemCount, heightTick]);
```

- `itemCount` = `visibleMessages.length`（ChatMessageList.tsx:557）
- `scrollTop` 通过 rAF 节流更新（`useVirtualScroll.ts:121-129`）
- `viewportHeight` 通过 `ResizeObserver` 更新（L71-83）

**注意**：`visibleRange` 的 `startIndex/endIndex` 是**虚拟滚动**的可见范围（基于 scrollTop 和高度计算），与 `messageWindow.startIndex`（消息窗口的尾部裁切起点）是**两个独立的概念**。

```
messageWindow:    [隐藏历史] [可见消息窗口]                    session
                  startIndex         ↑
                                     尾部（最新消息）
                  ──────────────────────────────────
virtual scroll:   [spacer] [渲染的消息行] [spacer]            scroll container
                  startIndex endIndex
                  ↑                  ↑
                  基于 scrollTop     基于 scrollTop + viewportHeight
```

## 4.2 heightTick 与 visibleRange 的重新计算时机

heightTick 是一个 `useState<number>(0)`，它作为一个**强制重算的触发器**。

在 `useVirtualScroll.ts:107-116` 中：

```typescript
const visibleRange = useMemo(() => {
    void heightTick;  // ← 消费 heightTick 但不使用其值
    return manager.computeVisibleRange(
      scrollTop, viewportHeight, itemCount, overscanSafe);
}, [manager, scrollTop, viewportHeight, itemCount, overscanSafe, heightTick]);

const totalHeight = useMemo(() => {
    void heightTick;
    return manager.getTotalHeight(itemCount);
}, [manager, itemCount, heightTick]);
```

**触发路径**：

| 操作 | 触发函数 | heightTick 增量 | 最终效果 |
|------|---------|----------------|---------|
| visibleIds 变化 | syncOrder | +1 | visibleRange 使用更新后的 order |
| Pretext 估算高度 | setEstimated (rAF batch) | +1 | visibleRange 使用 updated estimated |
| DOM 渲染后高度 | setActual (rAF batch) | +1 | visibleRange 使用 updated actual |
| 会话切换 | clearHeights | +1 | visibleRange 重建 |

**问题**：heightTick 是一个计数器，可能导致过度重算。例如：
1. syncOrder 触发 heightTick+1 → visibleRange 重算
2. 下一个微任务中 setEstimated 的 rAF 批处理触发 heightTick+1 → visibleRange 再次重算
3. 再下一个微任务中 setActual 的 rAF 批处理触发 heightTick+1 → visibleRange 第三次重算

这意味着一次消息发送可能引起 3 次 visibleRange 重算。但由于 React 的批量更新（React 18 自动批处理），在事件处理函数中的多次 setState 会被合并。但 rAF 回调中的 setState 不会被合并（它们在事件循环的不同 tick 中）。

**改进建议**：合并 heightTick 和 syncOrder 触发，减少不必要的重算：

```typescript
useEffect(() => {
    if (ids && Array.isArray(ids)) {
      const changed = manager.syncOrder(ids);
      if (changed) {
        setHeightTick((t) => t + 1);
      }
    }
}, [manager, ids]);
```

并且 `syncOrder` 返回是否真正发生了变化：

```typescript
syncOrder(ids: string[]): boolean {
    // ...
    if (same) return false;  // 未变化，不需要触发重算
    // ... 更新 order
    return true;
}
```

## 4.3 useVirtualScroll 的注入方式

`useVirtualScroll` 在 ChatMessageList 中以普通 hook 调用（非条件调用）：

```typescript
const vs = useVirtualScroll({
    itemCount: visibleMessages.length,
    ids: visibleIds,
    overscan: 6,
    fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
});
```

这意味着每次 ChatMessageList 渲染时，`useVirtualScroll` 都会被调用。但是：
- `itemCount` 变化 → useVirtualScroll 内部 useMemo 重算
- `ids` 变化 → useEffect(syncOrder) 触发
- `overscan` 固定 6 → 不变
- `fallbackHeight` 固定 MESSAGE_ESTIMATED_ROW_HEIGHT=120 → 不变

**内部 ref 稳定性**：`managerRef` 是 useRef 创建，在 hook 的整个生命周期内稳定。这意味着即使 ChatMessageList 多次 re-render，VirtualScrollManager 实例始终保持。

## 5. ChatMessageList.tsx 分析

### 5.1 组件整体结构

ChatMessageListInner 是一个 React.FC，接收 `messages: SessionMessage[]` 作为 props。其内部关键状态和 ref：

```typescript
// 窗口化状态
const [expandedOlder, setExpandedOlder] = useState(0);
// 按会话隔离的 UI 展开态
const [expandedToolsBySession, setExpandedToolsBySession] = useState({});
const [expandedUserMsgsBySession, setExpandedUserMsgsBySession] = useState({});
// 固定消息
const [pinsOpen, setPinsOpen] = useState(true);
// 跟进建议关闭记录
const [dismissedFollowUps, setDismissedFollowUps] = useState({});
// 容器宽度
const [containerWidth, setContainerWidth] = useState(680);
// 虚拟滚动
const vs = useVirtualScroll({...});
```

### 5.2 会话切换 vs 窗口平移 vs expand older 场景

**会话切换**：
- `activeSessionId` 改变 → ChatMessageList 重新挂载（因 `key={activeSessionId}` 或父组件逻辑，实际 ChatMessageList 未设 key，但 props 改变）
- 事实上 ChatMessageList 的 `React.memo` 会阻止不必要的重渲染，但当 `messages` 完全改变时仍会重新渲染
- `useLayoutEffect` 检测 `activeSessionId` 变化 → `clearHeights()` → 正确

**窗口平移（新消息到达）**：
- messages.length 增加 → messageWindow.startIndex 前移 → visibleMessages 改变
- `useEffect` 触发 `syncOrder(newIds)` → order 更新
- `useLayoutEffect` 触发：非会话切换 → 锚点补偿逻辑执行
  - 锚点（prevIds[0]）在 newIds 中查不到（被窗口裁掉了） → `newIndexOfAnchor = -1` → 跳过补偿
  - **此时无 clearHeights**

**expand older**：
- expandedOlder 增加 → messageWindow.startIndex 后移 → visibleMessages 变大（prepend 旧消息）
- `useEffect` 触发 `syncOrder(newIds)` → order 更新（prepend 新 id）
- `useLayoutEffect` 触发：锚点（prevIds[0]）在 newIds 中查到（位置后移） → `newIndexOfAnchor > 0` → scrollTop 补偿
  - 计算 prepended 行的高度 → `el.scrollTop += prependedHeight`

### 5.2 clearHeights 的 useLayoutEffect 逻辑

`ChatMessageList.tsx:573-613`:

```typescript
useLayoutEffect(() => {
    // 第一部分：会话切换检测
    if (prevSessionIdForHeightsRef.current !== activeSessionId) {
      prevSessionIdForHeightsRef.current = activeSessionId;
      clearHeights();
      prevVisibleIdsRef.current = visibleIds;
      return;
    }

    // 第二部分：窗口平移的 scrollTop 补偿
    const prevIds = prevVisibleIdsRef.current;
    const nextIds = visibleIds;
    prevVisibleIdsRef.current = nextIds;

    const el = containerRef.current;
    if (!el || prevIds.length === 0 || nextIds.length === 0) return;
    const anchorId = prevIds[0];
    if (!anchorId) return;
    const newIndexOfAnchor = nextIds.indexOf(anchorId);
    if (newIndexOfAnchor <= 0) return;

    // 对齐性检查
    let aligned = true;
    const compareLen = Math.min(prevIds.length, nextIds.length - newIndexOfAnchor);
    for (let i = 0; i < compareLen; i++) {
      if (prevIds[i] !== nextIds[newIndexOfAnchor + i]) {
        aligned = false;
        break;
      }
    }
    if (!aligned) return;

    // 计算前置项高度并补偿
    let prependedHeight = 0;
    for (let i = 0; i < newIndexOfAnchor; i++) {
      const id = nextIds[i];
      if (id) prependedHeight += manager.getHeight(id);
    }
    if (prependedHeight > 0) {
      el.scrollTop += prependedHeight;
    }
}, [activeSessionId, visibleIds, clearHeights, containerRef, manager]);
```

### 5.3 prevSessionIdForHeightsRef 和 prevVisibleIdsRef 的使用

`prevSessionIdForHeightsRef`（L570）：
- **用途**：跟踪上一次的 `activeSessionId`
- **更新时机**：仅当会话切换时在 effect 内部更新（L576）
- **初始值**：首次渲染时等于 `activeSessionId`

`prevVisibleIdsRef`（L571）：
- **用途**：跟踪上一次的 `visibleIds` 用于锚点比对
- **更新时机**：每次 `useLayoutEffect` 执行时更新（L584）
- **初始化**：首次渲染时等于初始 `visibleIds`

**关键行为**：`prevVisibleIdsRef.current = nextIds` 在每次 effect 执行时都会更新（L584），即使锚点比对失败或提前 return 之后。这是因为 `useLayoutEffect` 的依赖是 `visibleIds`，每当 `visibleIds` 变化时 effect 执行，ref 都会被更新到最新的 `visibleIds`。

### 5.4 Pretext 估算高度的 useEffect

`ChatMessageList.tsx:650-711` 中的 `useEffect` 负责为**未测量过**的消息行估算高度。

**关键路径**：
```typescript
const pending = visibleMessages.filter(
  (msg) => msg && !manager.hasHeight(msg.id)
);
if (pending.length === 0) return;

// 分块处理，每帧 5 条
const CHUNK_SIZE = 5;
```

使用 Pretext 库对消息文本进行排版估算，然后调用 `vs.setEstimated(msg.id, h)`。setEstimated 内部通过 rAF 批处理合并后调用 `manager.setEstimated`。

**潜在问题**：
- `manager.hasHeight(id)` 检查 manager 中是否已有该 id 的高度（estimated 或 actual）
- 如果会话切换后 `clear()` 清空了 heights，所有消息都是「未测量的」
- 这意味着会话切换后所有消息都需要 Pretext 重新估算，可能导致首次渲染时高度不精确

### 5.5 ResizeObserver 获取实际高度的 useEffect

`ChatMessageList.tsx:717-752` 中的 `useEffect` 负责在 DOM 渲染后获取实际行高。

**逻辑**：
```typescript
const current = new Set<Element>(
  Array.from(container.querySelectorAll('[data-msg-id]'))
);

for (const row of current) {
  if (!observed.has(row)) {
    ro.observe(row);   // 为新行注册 Observer
    observed.add(row);
  }
}
for (const row of observed) {
  if (!current.has(row)) {
    ro.unobserve(row); // 卸载已移除行的 Observer
    observed.delete(row);
  }
}
```

**依赖**：`[visibleMessages, containerRef, setActual]`。每次 `visibleMessages` 变化时重新绑定。

**回调**：
```typescript
const el = entry.target as HTMLElement;
const msgId = el.dataset.msgId;
if (msgId && entry.contentRect.height > 0) {
  setActual(msgId, entry.contentRect.height);
}
```

`setActual` 通过 `useVirtualScroll` 的 rAF 批处理路径调用 `manager.setActual(msgId, height)`。

**问题**：每次 visibleMessages 变化都会重新运行此 effect，导致：
1. 计算 `current = new Set(Array.from(container.querySelectorAll('[data-msg-id]')))`
2. 对比 observed 和 current，增删 ResizeObserver 目标

对于大量消息行，querySelectorAll 可能产生性能开销。但由于虚拟滚动只渲染 `startIndex..endIndex` 区间（通常 10-20 条），实际开销可控。

### 5.6 渲染路径的完整性分析

`ChatMessageList.tsx:898-980`：

```tsx
{/* 顶部 spacer：已被滚出视口的消息占位 */}
<div style={{ height: startOffset, flexShrink: 0 }} aria-hidden />

{/* 可视范围内的消息 */}
{visibleMessages.slice(startIndex, endIndex).map((msg, i) => {
  const virtualIndex = startIndex + i;
  // ...
  return (
    <div data-msg-id={msg.id} data-vindex={virtualIndex}>
      <ChatUserMessageRow ... />  {/* 或 ChatAssistantMessageRow */}
    </div>
  );
})}

{/* 底部 spacer：可视范围之后的剩余消息占位 */}
<div style={{ height: Math.max(0, estimatedTotalHeight - endOffset) }} aria-hidden />
```

**关键点**：
1. `visibleMessages.slice(startIndex, endIndex)` 是 React 数组切片，**完全独立于** VirtualScrollManager 的 order
2. `startOffset = vs.visibleRange.startOffset` 来自 `manager.getOffset(startIndex)`，基于 manager 的高度数据
3. `estimatedTotalHeight` 来自 `manager.getTotalHeight(itemCount)`
4. 每个消息行使用 `key={msg.id}`，React 据此进行 DOM 复用/移动

**消息重复的根本原因排除**：
- **不可能因为 order 错误导致渲染重复**：渲染的是 React 数组切片，不是 manager.order
- **可能的根源**：startOffset 异常导致消息出现在错误位置；或者 `visibleMessages` 本身重复
- **scrollTop 异常**：由于补偿逻辑错误导致滚动位置重复再现同一段消息

### 5.7 滚动锚点补偿逻辑

**目的**：当 expand older 导致顶部新插入消息时，保持锚点（旧的第一条消息）在视口中的位置不变，避免「跳跃」感。

**实现**（L586-612）：

1. 取旧 `prevIds[0]` 作为锚点
2. 查找锚点在新列表中的位置 `newIndexOfAnchor`（旧的第一条现在在列表中的 index）
3. 如果 `newIndexOfAnchor <= 0`（锚点不在新列表中，或位置没变）→ 跳过
4. 对齐性检查：从锚点位置起的后续 ids 必须与旧列表顺序一致
5. 计算新插入行的总高度 → `scrollTop += prependedHeight`

**潜在问题**：
- 当 `manager.order` 在 `useEffect` 中尚未更新时，`manager.getHeight(id)` 使用的是旧 order 映射。如果顺序不匹配，`getHeightAt` 通过 `idToIndex` 查找，`getHeight` 直接 `heights.get(id)`，所以不受 order 影响。这是安全的。
- 但如果新插入的 id 在 heights 中不存在（从未渲染过），`getHeight` 返回 `FALLBACK_HEIGHT`，可能导致补偿不精确。

## 6. 参考项目对比分析

### 6.1 react-window 的动态高度处理

react-window 的 `VariableSizeList`（已保存至 `reference/agent-01/react-window-VariableSizeList.js`）使用以下方案：

1. **itemMetadataMap**：`{ [index: number]: { offset, size } }`
   - 按**索引**（index）存储元数据，非按 id
   - `lastMeasuredIndex` 跟踪测量进度
2. **懒测量**：只在需要时计算（`getItemMetadata` 中按需扩张）
3. **resetAfterIndex**：当某个 index 的高度变化时，重置 `lastMeasuredIndex = min(last, index - 1)`，使后续行重新测量
4. **estimatedItemSize**：未测量项的 fallback

**差异**：
- react-window 使用**索引键**，本项目使用 **messageId 键**
- react-window 没有「窗口平移」概念（列表索引始终从 0 开始）
- react-window 的 `resetAfterIndex` 相当于本项目的 `markDirtyFrom`

### 6.2 react-virtuoso 的架构

react-virtuoso（https://virtuoso.dev）采用：

1. **可变高度行**：通过 `itemContent` 回调渲染，内部使用 ResizeObserver 测量
2. **总高度追踪**：`totalListHeight` 为所有行高度的累加，未知行用 `defaultItemHeight` 估计
3. **组/头/尾**：支持分组、固定头部、固定尾部
4. **滚动状态**：`scrollTop` 驱动的 `useState` 效果

**差异**：
- react-virtuoso 不对外开放高度管理器，内部封装
- 本项目自行实现 Manager 模式，可测试、可移植
- 本项目增加了「会话切换清空」语义（react-virtuoso 没有此场景）

### 6.3 本项目 vs 参考项目的差异

| 特性 | react-window | react-virtuoso | 本项目 |
|------|-------------|---------------|--------|
| 高度键 | index | 内部 index | messageId |
| 窗口平移 | 不支持 | 不支持 | 核心场景 |
| 会话切换 | 无此语义 | 无此语义 | 需清空高度 |
| 高度存储 | itemMetadataMap | 内部 Map | heights Map |
| fallback | estimatedItemSize | defaultItemHeight | FALLBACK_HEIGHT=120 |
| Suffix rebuild | resetAfterIndex | 内部 | dirtyFrom + suffix |
| overscan | 自定义 | 内置 | 6 条 |

## 6.2 react-window 的 createListComponent 抽象

react-window 的 `createListComponent`（VariableSizeList 的基座）提供了以下核心方法：

```
getItemOffset(props, index, instanceProps) → offset of item at index
getItemSize(props, index, instanceProps) → size of item at index
getEstimatedTotalSize(props, instanceProps) → total estimated size
getStartIndexForOffset(props, offset, instanceProps) → first visible index
getStopIndexForStartIndex(props, startIndex, scrollOffset, instanceProps) → last visible index
```

**关键差异**：react-window 的 `instanceProps.itemMetadataMap` 是「append-only」的——一旦某个 index 被测量，就不会被清除。`resetAfterIndex` 只回退 `lastMeasuredIndex`，保留已测量的元数据。

本项目的 VirtualScrollManager 的 `heights Map` 也是 append-only（除非 clear），但 `order` 数组会随着窗口平移而完全变化。

## 6.3 本项目 vs react-window 的详细对比

| 维度 | react-window | 本项目 |
|------|-------------|--------|
| 键策略 | `index`（数组下标） | `messageId`（消息唯一 ID） |
| 高度缓存 | `itemMetadataMap[index] = {offset, size}` | `heights Map<id> = {estimated, actual, version}` |
| 顺序管理 | 列表索引天然有序（0..n-1） | `order[]` 维护当前窗口 id 顺序 |
| 窗口平移 | 不支持（列表始终从头展示） | 核心特性（尾部窗口 + expand older） |
| 高度变化处理 | `resetAfterIndex(index)` → lastMeasuredIndex 回退 | `markDirtyFrom(index)` → suffix rebuild |
| 会话切换 | Stateless（父组件卸载/重建） | `clear()` 清空全部高度 |
| Fallback | `estimatedItemSize`（全局常量） | `FALLBACK_HEIGHT=120`（可配置） |
| 二分查找 | exponential → binary search | 直接在 offsetsCache 上二分 |
| Overscan | 内置 | 调用方传入（固定 6） |
| ResizeObserver | 用户自行实现 | ChatMessageList 内置 |

## 6.4 本项目与 react-window 的设计差异对本 Bug 的影响

react-window 的 index 方案在一个关键方面更简单：**不存在「清空全部缓存」的操作**。`resetAfterIndex(index)` 只清空从 index 开始的缓存，不破坏之前的测量结果。

但 react-window 的方案不适合本项目的「尾部窗口」场景（每次新消息到达时，列表的「逻辑 0」位置变化了——老消息被裁掉，新消息在尾部追加）。如果使用 react-window，每次消息到达时需要 `resetAfterIndex(0)` 然后重新测量所有行，性能更差。

本项目的 messageId 方案在「窗口平移保留高度」方面更优，但引入了「clear 操作可能误触」的风险。这正是当前 Bug 的高层根因——**一个能力更强的设计也引入了更大的人为错误面**。

## 7. 根因结论

### 7.1 clearHeights 在窗口平移时是否误触

**静态分析结论：当前代码中 clearHeights 不在窗口平移时误触。**

`useLayoutEffect`（ChatMessageList.tsx:573-613）中的调用被严格限制在 `prevSessionIdForHeightsRef.current !== activeSessionId` 条件下。只要：
1. `activeSessionId` 在同一个对话过程中保持不变
2. `prevSessionIdForHeightsRef` 正确跟踪

clearHeights 就不会被误调用。

**潜在风险场景**：

**风险 1：React Strict Mode 双调用（仅开发环境）**
- 在 React 18 Strict Mode 下，useLayoutEffect 会执行 → 清理 → 再次执行
- 第一轮：检测到非会话切换 → 更新 prevVisibleIdsRef
- 第二轮：仍然是同一会话 → prevSessionIdForHeightsRef 已对齐 → 无 clearHeights
- **影响：无**

**风险 2：activeSessionId 的短暂波动**
- 如果父组件在某种边界条件下传入 `''` 或空字符串作为 activeSessionId（例如会话正在切换时的过渡状态）
- 第一轮：prevSessionIdForHeightsRef = 'id1'，activeSessionId = '' → clearHeights()
- 第二轮：prevSessionIdForHeightsRef = ''，activeSessionId = 'id1' → 再次 clearHeights()
- **影响：高度丢失**。需要检查 ChatCard 中 activeSessionId 的来源是否稳定

**风险 3：useLayoutEffect 在 useEffect(syncOrder) 之前执行**
- useLayoutEffect 在 React commit 阶段同步执行
- useEffect 在 paint 后异步执行
- 在 expand older 场景中，useLayoutEffect 的锚点补偿使用 `manager.getHeight(id)`。
  如果此时 order 仍为旧值，不影响 getHeight（它不依赖 order，直接查 heights Map）。
- **影响：无**

**风险 4：前置数据的 order 未被正确同步**
- 如果某个 render 中 visibleMessages 变化了，但 useEffect(syncOrder) 因为某些原因未触发
- 原因可能是 `ids` 依赖使用了同一个引用（参见 4.1）
- 或者 `messages` 变化了但 `visibleMessages` 的 useMemo 依赖未触发
- **影响：order 与 visibleMessages 不同步**

### 7.2 React 渲染周期对 clearHeights 的时序影响

在 React 的渲染周期中，effect 的执行顺序对数据流向有重要影响：

```
阶段 1: Render（渲染阶段，纯函数）
  → messageWindow 重新计算，visibleMessages 改变
  → visibleIds 新引用
  → useVirtualScroll 接收新 ids
  → 返回新的 visibleRange（但还未调用 syncOrder！）

阶段 2: Commit（DOM 更新）
  → React 更新 DOM

阶段 3: useLayoutEffect（同步执行，在 paint 前）
  → ChatMessageList 的 useLayoutEffect #1 (L573)
    → 检查 sessionId
    → 更新 prevVisibleIdsRef
    → 锚点补偿
  → useVirtualScroll 内部无 useLayoutEffect

阶段 4: Paint（浏览器绘制）

阶段 5: useEffect（异步执行，在 paint 后）
  → useVirtualScroll 的 useEffect #2 (L62)
    → manager.syncOrder(ids) ← 此时才真正同步 order！
    → setHeightTick(t + 1)

阶段 6: 第二轮渲染（由 setHeightTick 触发）
  → visibleRange 使用更新后的 order 重算
  → startOffset / endOffset 更新
  → 渲染
```

**关键发现**：在阶段 1 产生的 `visibleRange` 中，`startOffset` 和 `estimatedTotalHeight` 使用的是**上一轮的 order**，因为 `syncOrder` 在第 5 阶段才执行。这意味着：

- 在 expand older 后第一次渲染时，顶部 spacer 的高度基于旧 order 计算
- 这可能导致短暂的视觉偏差（抖动），但会被第 6 阶段修正
- **不会导致消息重复**，因为渲染内容（visibleMessages）来自 React 状态

### 7.3 是否有其他潜在路径导致消息重复
- `chat.ts:41-46`：addMessage 中检查 `existing = getMessageById(sess.messages, message.id)`
- 如果 existing：`Object.assign(existing, prepared)`（更新，不新增）
- 否则：`sess.messages.push(prepared)`（新增）
- **结论：无重复**

**路径 2：messageWindow 切片重复**
- `messageWindow.ts:136`：`messages.slice(startIndex)` 返回新的数组
- `startIndex = len - (recent + expanded)` 是整数，切片不会产生重叠
- **结论：无重复**

**路径 3：visibleMessages 与 syncOrder 状态不一致**
- 如果 `visibleMessages` 是 [m20, m21, ..., m99]，但 `manager.order` 是 [m21, ..., m99]（缺少 m20）
- `computeVisibleRange` 使用 `itemCount = visibleMessages.length = 80`
- `findIndexAtOffset` 使用 `ensureOffsets(80)` → `rebuildOffsetsSuffix` → `getHeightAt(0..79)`
- order 长度为 79 但需要 80 项 → `getHeightAt(79)` 返回 fallback（因为 `order[79]` 为 undefined）
- 渲染使用 `visibleMessages.slice(startIndex, endIndex)`，它基于 React 的 messages 数组
- **结果：startOffset/estimatedTotalHeight 可能错误，但不会导致 UI 层重复**

**路径 4：ResizeObserver 回触发 setActual 导致重复渲染**
- ResizeObserver 回调调用 `setActual(msgId, height)` → 触发 heightTick+1 → 重算 visibleRange
- 重算可能产生不同的 `startIndex/endIndex`（如果高度变化影响了 `findIndexAtOffset`）
- 这可能导致新增/减少渲染的消息条数
- **但不会导致重复**，只是可能引起布局抖动

**路径 5：React.memo 阻止重渲染导致 stale data**
- `ChatMessageList` 使用 `React.memo(ChatMessageListInner)`
- 如果父组件传入的 props 引用未变（如 messages 引用相同），组件不会重渲染
- 但 Zustand 的 `useSessionField` 会返回新的 messages 引用（因为 immer produce 产生新对象）
- **结论：React.memo 不会阻止必要的重渲染**

**路径 6：store.addMessage 的 upsert 逻辑导致消息丢失而非重复**
- `addMessage` 检测 `existing = getMessageById(sess.messages, message.id)`
- 如果消息已存在：`Object.assign(existing, prepared)` → 更新现有引用
- 如果不存在：`messages.push(prepared)` → 新增
- 当 `MAX_MESSAGES_PER_SESSION` 达到时：`messages.shift()` → 移除最早消息
- **这个路径不会产生重复，但可能产生消息丢失**

**路径 7：窗口平移时 startIndex 变化导致可见集合变化，但 scrollTop 未更新**
- 当 startIndex 前移（新消息到达），visibleMessages 整体偏移
- 如果 scrollTop 未相应调整，同一组消息的虚拟滚动起始索引改变
- 例如：之前 visibleMessages[0] = m20，scrollTop 位于 m20 顶部
  新消息到达后 visibleMessages[0] = m21，但 scrollTop 仍指向旧位置（m20 顶部）
  由于 m20 现在在 visibleMessages 范围外，虚拟滚动计算出的 startIndex 会跳过 m20
  但 scrollTop 未变 → 渲染的内容向后偏移
- **可能产生视觉上的「跳跃」，但不产生重复**

## 8. 修复方案验证数据

### 8.1 代码修改前后对比

**修改前**（当前实现）：
- `useLayoutEffect` 在会话切换时调用 `clearHeights()`
- 窗口平移时通过 `useEffect(syncOrder)` 同步
- `clearHeights` 调用 `manager.clear()` → 清空 heights + order

**修改后**（建议）：
- 维持相同的 clearHeights 逻辑（仅在会话切换时触发）
- 增加防御性断言确保 `clearHeights` 被调用前 `activeSessionId` 确实改变
- 增加 debug 日志追踪 clearHeights 的调用栈

### 8.2 测试用例覆盖清单

| # | 测试用例 | 覆盖文件 | 优先级 |
|---|---------|---------|--------|
| 1 | 窗口平移时 clearHeights 然后 syncOrder 相同 ids | VirtualScrollManager.test.ts | P0 |
| 2 | expand older 场景 | VirtualScrollManager.test.ts | P0 |
| 3 | 快速连续发送消息 | VirtualScrollManager.test.ts | P1 |
| 4 | 会话切换后立即发送消息 | VirtualScrollManager.test.ts | P1 |
| 5 | clear() 后立即 syncOrder() 恢复 | VirtualScrollManager.test.ts | P0 |
| 6 | 空 ids 传入 syncOrder | VirtualScrollManager.test.ts | P1 |
| 7 | order 长度与 itemCount 不一致时 computeVisibleRange | VirtualScrollManager.test.ts | P2 |
| 8 | heights Map 在多次 syncOrder 中保留同 id 高度 | VirtualScrollManager.test.ts | P0 |
| 9 | dirtyFrom 在多个 setActual 连续调用后的合并行为 | VirtualScrollManager.test.ts | P1 |
| 10 | MESSAGE_ESTIMATED_ROW_HEIGHT 变化后的行为 | VirtualScrollManager.test.ts | P2 |

## 附录：关键文件行号索引

| 文件 | 行号 | 内容 |
|------|------|------|
| VirtualScrollManager.ts | 27-378 | 完整实现 |
| VirtualScrollManager.ts | 57-89 | syncOrder |
| VirtualScrollManager.ts | 103-128 | computeVisibleRange |
| VirtualScrollManager.ts | 131-143 | getHeight / getHeightAt |
| VirtualScrollManager.ts | 147-178 | setEstimated / setActual |
| VirtualScrollManager.ts | 267-273 | clear |
| VirtualScrollManager.ts | 306-313 | markDirtyFrom |
| VirtualScrollManager.ts | 341-369 | rebuildOffsetsSuffix |
| useVirtualScroll.ts | 45-202 | 完整 Hook |
| useVirtualScroll.ts | 62-67 | syncOrder useEffect |
| useVirtualScroll.ts | 107-116 | visibleRange / totalHeight |
| useVirtualScroll.ts | 135-151 | setEstimated rAF 批处理 |
| useVirtualScroll.ts | 157-174 | setActual rAF 批处理 |
| useVirtualScroll.ts | 176-187 | syncOrder / clearHeights |
| ChatMessageList.tsx | 552-613 | 虚拟滚动 + clearHeights useLayoutEffect |
| ChatMessageList.tsx | 553 | visibleIds useMemo |
| ChatMessageList.tsx | 556-561 | useVirtualScroll 调用 |
| ChatMessageList.tsx | 562 | clearHeights 解构 |
| ChatMessageList.tsx | 564-568 | 契约注释 |
| ChatMessageList.tsx | 570-571 | ref 声明 |
| ChatMessageList.tsx | 573-613 | useLayoutEffect（核心） |
| ChatMessageList.tsx | 898-980 | 渲染路径 |
| messageWindow.ts | 92-144 | windowMessages 实现 |
| messageWindow.ts | 133-136 | startIndex / visible 计算 |
| chat.ts | 26-50 | addMessage 实现 |
