# Agent 1: 虚拟滚动彻底重构方案

## 1. 设计原则

### 原则 1：以 msg.id 为唯一键

VirtualScrollManager 的所有高度数据应完全以 `messageId` 为键：

```
heights: Map<messageId, HeightEntry>   // 永远按 id 存取
order: messageId[]                      // 当前窗口顺序
idToIndex: Map<messageId, index>        // index 是查询视图，仅在 order 更新时重建
```

**含义**：
- `getHeight(id)` 是主入口，不依赖 order
- `getHeightAt(index)` 是次入口，通过 `order[index]` 委托给 `getHeight(id)`
- `setEstimated(id, height)` / `setActual(id, height)` 都通过 id 直接操作 heights Map
- `markDirtyFrom(index)` 通过 `idToIndex` 将 id 映射到 index，再标记脏

### 原则 2：syncOrder 是唯一的「顺序同步」入口

`syncOrder` 是**唯一**的 order 更新通道：

- 每次 visibleMessages 变化时，`useEffect` 调用 `manager.syncOrder(ids)`
- syncOrder 内部进行前缀相等检测 + suffix rebuild
- 禁止任何路径直接修改 `this.order`

### 原则 3：禁止任何路径在窗口平移时清空 order

`clear()` 只能被 `clearHeights()` 调用，而 `clearHeights()` 只能在**会话切换**时调用：

```
合法路径：
  会话切换 → useLayoutEffect → prevSessionIdRef mismatch → clearHeights()
                                                              → manager.clear()

禁止路径：
  窗口平移（startIndex 变化） → 任何代码路径 → manager.clear()
  expand older → 任何代码路径 → manager.clear()
  新消息到达 → 任何代码路径 → manager.clear()
```

### 原则 4：只在会话切换时清空

会话切换的检测方式：
```
prevSessionIdForHeightsRef.current !== activeSessionId
```

**防御措施**：
- 清空前记录 `manager.order.length` 和 `heights.size`，发出告警日志
- 清空前用 `console.trace()` 记录调用栈
- 如果 order 已经为空（length === 0），跳过实际 clear 操作（但保留 setHeightTick）

## 2. 文件修改清单

### 2.1 VirtualScrollManager.ts 增强

#### 2.1.1 增加 debug 模式

在类构造时增加 debug 标志：

```typescript
export class VirtualScrollManager {
  private debug: boolean;

  constructor(fallbackHeight?: number, debug = false) {
    this.debug = debug;
    // ...
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[VSM]', ...args);
    }
  }
}
```

或者在全局设置环境变量控制：

```typescript
private debug = typeof process !== 'undefined' &&
  process.env?.NODE_ENV === 'development';
```

#### 2.1.2 增加保护：clear 前检查 order.length

```typescript
clear(): void {
    const prevOrderLen = this.order.length;
    const prevHeightsSize = this.heights.size;
    if (this.debug) {
      console.log('[VSM] clear() called', {
        prevOrderLen,
        prevHeightsSize,
        stack: new Error().stack?.split('\n').slice(2, 6).join('\n'),
      });
    }
    if (prevOrderLen === 0 && prevHeightsSize === 0) {
      // 已经为空，跳过清空
      return;
    }
    this.heights.clear();
    this.order = [];
    this.idToIndex.clear();
    this.offsetsCache = null;
    this.dirtyFrom = undefined;
}
```

#### 2.1.3 增强 syncOrder 的边界处理

当前 syncOrder 在 `ids` 为空数组时的行为：

```typescript
syncOrder(ids: string[]): void {
    const next = Array.isArray(ids) ? ids : [];
    // ...
    const same = firstDiff === next.length && next.length === this.order.length;
    if (same) return;

    this.order = next.slice();
    // ...
}
```

当 `ids = []` 且 `this.order` 也为 `[]` 时：`same = true` → return。正确。

当 `ids = []` 且 `this.order` 不为 `[]` 时：`order = []`，正确。

**增强建议**：在 syncOrder 开始时增加断言：

```typescript
syncOrder(ids: string[]): void {
    // 防御性断言：如果 order 长度为零但 ids 非空，
    // 可能是 clear() 被误调用了
    if (this.order.length === 0 && ids.length > 0) {
      if (this.debug) {
        console.warn('[VSM] syncOrder called with ids but order is empty',
          'possible premature clear()', { ids: ids.length });
      }
    }
    // ...
}
```

#### 2.1.4 增强 computeVisibleRange 的边界处理

当 `order.length < itemCount` 时，`computeVisibleRange` 使用 `count = itemCount` 没有问题。但 `ensureOffsets(count)` 内部的 `rebuildOffsetsSuffix` 会遍历到 `count-1`，其中一些 index 在 order 中没有对应的 id。

在 `getHeightAt` 中已经处理了这种情况（`id == null → fallbackHeight`）。

**增强建议**：在 `computeVisibleRange` 中增加边界日志：

```typescript
computeVisibleRange(...): VisibleRange {
    // ...
    if (this.order.length < count && this.debug) {
      console.warn('[VSM] computeVisibleRange: order.length < count',
        { orderLen: this.order.length, count });
    }
    // ...
}
```

#### 2.1.5 增加 recovery 路径

当 order 长度为零但 heights 非空时，自动恢复：

```typescript
// 在 computeVisibleRange 或 getHeightAt 中
if (this.order.length === 0 && this.heights.size > 0) {
    // 自动从 heights 恢复 order（按插入顺序？）
    // 但这样做的风险是可能丢失顺序信息
    // 更安全的做法：发出告警，但不自动恢复
}
```

### 2.2 useVirtualScroll.ts 增强

#### 2.2.1 确保 syncOrder 在必要时重新触发

当前 `useEffect` 依赖 `[manager, ids]`：

```typescript
useEffect(() => {
    if (ids && Array.isArray(ids)) {
      manager.syncOrder(ids);
      setHeightTick((t) => t + 1);
    }
}, [manager, ids]);
```

**问题**：如果 `ids` 引用未变但内容变化（理论上有 `useMemo` 包装不会发生），syncOrder 不会触发。

**增强建议**：使用 `useMemo` 的深层比较：

```typescript
import { useDeepCompareMemo } from '../utils/deepCompare';

const stableIds = useDeepCompareMemo(() => ids, [ids]);

useEffect(() => {
    if (stableIds && Array.isArray(stableIds)) {
      manager.syncOrder(stableIds);
      setHeightTick((t) => t + 1);
    }
}, [manager, stableIds]);
```

或者保留引用比较（因为 `visibleIds` 已经是 useMemo），增加二次校验：

```typescript
useEffect(() => {
    if (ids && Array.isArray(ids)) {
      // 即使 ids 引用未变，但内部通过 clear 被重置后仍需要 sync
      if (manager.getOrder().length !== ids.length) {
        manager.syncOrder(ids);
        setHeightTick((t) => t + 1);
      } else {
        // 正常路径：引用变了才同步
        manager.syncOrder(ids);
        setHeightTick((t) => t + 1);
      }
    }
}, [manager, ids]);
```

#### 2.2.2 增加 clearHeights 的守卫

```typescript
const clearHeights = useCallback(() => {
    const orderLen = manager.getOrder().length;
    const heightsSize = (manager as any).heights?.size ?? 0;
    if (orderLen > 0 || heightsSize > 0) {
      if (typeof console !== 'undefined') {
        console.log('[useVirtualScroll] clearHeights called',
          { orderLen, heightsSize });
      }
    }
    manager.clear();
    setHeightTick((t) => t + 1);
}, [manager]);
```

更强的守卫：挂载到 window 的 debug 函数：

```typescript
// 在开发环境中暴露 debug 工具
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).__VSM_DEBUG__ = manager;
}
```

#### 2.2.3 增加 useVirtualScroll 的严格模式校验

在开发环境下，如果 `clearHeights` 在非会话切换时被调用，发出告警：

但 `useVirtualScroll` 本身不知道当前是否为会话切换。这个逻辑应在 ChatMessageList 层实现。

### 2.3 VirtualScrollManager.test.ts 扩展

#### 2.3.1 新增测试：窗口平移时 clearHeights 然后 syncOrder 相同 ids

```typescript
it('window pan with clear then syncOrder: heights are lost but order restored', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['m2', 'm3', 'm4']);
    vsm.setActual('m2', 200);
    vsm.setActual('m3', 300);
    vsm.setActual('m4', 400);

    // 模拟误调用 clear（会话切换误触或 bug）
    vsm.clear();

    // 窗口平移后 syncOrder
    vsm.syncOrder(['m0', 'm1', 'm2', 'm3', 'm4']);

    // heights 已被清空，所有 id 应返回 fallback
    expect(vsm.hasHeight('m2')).toBe(false);
    expect(vsm.hasHeight('m3')).toBe(false);
    expect(vsm.hasHeight('m4')).toBe(false);

    // order 已恢复
    expect(vsm.getOrder()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);

    // 偏移量基于 fallback
    expect(vsm.getHeightAt(0)).toBe(100);
    expect(vsm.getOffset(2)).toBe(200);
    expect(vsm.getTotalHeight(5)).toBe(500);
});
```

#### 2.3.2 新增测试：expand older 场景

```typescript
it('multiple expand older steps without clear', () => {
    const vsm = new VirtualScrollManager(100);
    // 模拟尾部窗口：m60..m99
    const base = Array.from({ length: 40 }, (_, i) => `m${i + 60}`);
    vsm.syncOrder(base);
    for (const id of base) vsm.setActual(id, 120);

    // expand older step 1: 向前扩 20 条
    const step1 = Array.from({ length: 60 }, (_, i) => `m${i + 40}`);
    vsm.syncOrder(step1);

    // 原始 40 条的高度保留
    for (const id of base) {
      expect(vsm.getHeight(id)).toBe(120);
    }
    // 新 20 条为 fallback
    for (let i = 0; i < 20; i++) {
      expect(vsm.getHeightAt(i)).toBe(100);
    }

    // expand older step 2: 再扩 20 条
    const step2 = Array.from({ length: 80 }, (_, i) => `m${i + 20}`);
    vsm.syncOrder(step2);

    // 原始 40 条高度仍保留
    for (const id of base) {
      expect(vsm.getHeight(id)).toBe(120);
    }

    // 总高度正确
    expect(vsm.getTotalHeight(80))
      .toBe(20 * 100 + 20 * 100 + 40 * 120);
    // 前 40 条 fallback，后 40 条 actual=120
});
```

#### 2.3.3 新增测试：快速连续发送消息

```typescript
it('rapid consecutive message appends', () => {
    const vsm = new VirtualScrollManager(100);
    // 初始窗口
    vsm.syncOrder(['m0', 'm1', 'm2']);
    vsm.setActual('m0', 80);
    vsm.setActual('m1', 90);
    vsm.setActual('m2', 100);
    const offsetBefore = vsm.getTotalHeight(3);
    expect(offsetBefore).toBe(270);

    // 连续追加 3 条
    vsm.syncOrder(['m0', 'm1', 'm2', 'm3']);
    vsm.syncOrder(['m0', 'm1', 'm2', 'm3', 'm4']);
    vsm.syncOrder(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);

    // 前 3 条高度保留
    expect(vsm.getHeight('m0')).toBe(80);
    expect(vsm.getHeight('m1')).toBe(90);
    expect(vsm.getHeight('m2')).toBe(100);

    // 新 3 条为 fallback
    expect(vsm.getHeightAt(3)).toBe(100);
    expect(vsm.getHeightAt(4)).toBe(100);
    expect(vsm.getHeightAt(5)).toBe(100);

    // 总高度正确
    expect(vsm.getTotalHeight(6)).toBe(80 + 90 + 100 + 100 * 3);

    // 偏移量正确
    expect(vsm.getOffset(3)).toBe(270);
    expect(vsm.getOffset(6)).toBe(570);
});
```

#### 2.3.4 新增测试：会话切换后立即发送消息

```typescript
it('session switch then immediately send message', () => {
    const vsm = new VirtualScrollManager(100);
    // 会话 A
    vsm.syncOrder(['a1', 'a2']);
    vsm.setActual('a1', 150);
    vsm.setActual('a2', 200);

    // 切到会话 B（clear）
    vsm.clear();
    expect(vsm.getOrder()).toEqual([]);
    expect(vsm.hasHeight('a1')).toBe(false);

    // 会话 B 添加第一条消息
    vsm.syncOrder(['b1']);
    vsm.setActual('b1', 180);

    expect(vsm.getOrder()).toEqual(['b1']);
    expect(vsm.getHeight('b1')).toBe(180);
    expect(vsm.hasHeight('a1')).toBe(false); // 会话 A 数据已清
    expect(vsm.getTotalHeight(1)).toBe(180);
});
```

#### 2.3.5 新增测试：clear 后不 syncOrder 直接 computeVisibleRange

```typescript
it('computeVisibleRange after clear without syncOrder', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['m0', 'm1', 'm2']);
    vsm.setActual('m0', 50);
    vsm.setActual('m1', 60);

    // 误 clear
    vsm.clear();

    // computeVisibleRange 使用 itemCount=3 但 order.length=0
    const range = vsm.computeVisibleRange(0, 600, 3, 1);
    // 应正确 fallback，不崩溃
    expect(range.startIndex).toBe(0);
    expect(range.endIndex).toBeGreaterThan(0);
    expect(range.estimatedTotalHeight).toBe(3 * 100);
    expect(Number.isFinite(range.startOffset)).toBe(true);
});
```

### 2.4 ChatMessageList.tsx 修改

#### 2.4.1 增加防御性断言确保 clearHeights 只在会话切换时调用

在 `useLayoutEffect` 中增加断言：

```typescript
useLayoutEffect(() => {
    if (prevSessionIdForHeightsRef.current !== activeSessionId) {
      prevSessionIdForHeightsRef.current = activeSessionId;
      clearHeights();  // 会话切换，预期行为
      prevVisibleIdsRef.current = visibleIds;
      return;
    }

    // 以下是非会话切换路径，断言 clearHeights 未被执行
    // （防御性：如果这里调用了 clearHeights，说明有 bug）
    // ——断言点——

    const prevIds = prevVisibleIdsRef.current;
    const nextIds = visibleIds;
    prevVisibleIdsRef.current = nextIds;
    // ...
}, [activeSessionId, visibleIds, clearHeights, containerRef, manager]);
```

#### 2.4.2 检查 prevVisibleIdsRef 对比逻辑是否正确

当前逻辑（L582-612）：

```typescript
const prevIds = prevVisibleIdsRef.current;
const nextIds = visibleIds;
prevVisibleIdsRef.current = nextIds;
```

**问题**：`prevVisibleIdsRef.current = nextIds` 在 effect 开头就更新了，即使后续的锚点比对可能失败或 return。这意味着：
- 如果锚点比对失败导致提前 return，下次 effect 触发时 `prevVisibleIdsRef.current` 已经是本次的 `nextIds`。
- 这会导致下次的 `prevIds` 等于本次的 `nextIds`，锚点比对将 `newIndexOfAnchor = 0` 并跳过补偿。
- 这是合理的：因为本次已经处理了窗口平移，下次 startIndex 变化时应用新的锚点。

**建议**：将 `prevVisibleIdsRef.current = nextIds` 移到 effect 末尾，确保所有逻辑都执行完毕后才更新：

```typescript
useLayoutEffect(() => {
    if (prevSessionIdForHeightsRef.current !== activeSessionId) {
      prevSessionIdForHeightsRef.current = activeSessionId;
      clearHeights();
      prevVisibleIdsRef.current = visibleIds;
      return;
    }

    const prevIds = prevVisibleIdsRef.current;
    const nextIds = visibleIds;

    const el = containerRef.current;
    if (el && prevIds.length > 0 && nextIds.length > 0) {
      const anchorId = prevIds[0];
      if (anchorId) {
        const newIndexOfAnchor = nextIds.indexOf(anchorId);
        if (newIndexOfAnchor > 0) {
          // 对齐性检查
          let aligned = true;
          const compareLen = Math.min(prevIds.length,
            nextIds.length - newIndexOfAnchor);
          for (let i = 0; i < compareLen; i++) {
            if (prevIds[i] !== nextIds[newIndexOfAnchor + i]) {
              aligned = false;
              break;
            }
          }
          if (aligned) {
            let prependedHeight = 0;
            for (let i = 0; i < newIndexOfAnchor; i++) {
              const id = nextIds[i];
              if (id) prependedHeight += manager.getHeight(id);
            }
            if (prependedHeight > 0) {
              el.scrollTop += prependedHeight;
            }
          }
        }
      }
    }

    // 所有逻辑执行完毕后再更新 ref
    prevVisibleIdsRef.current = nextIds;
}, [activeSessionId, visibleIds, clearHeights, containerRef, manager]);
```

## 3. 消息发送全链路保障

### 3.1 store.addMessage → visibleMessages 计算 → visibleIds → syncOrder

```
store.addMessage()
  → immer state.sessionsById[sid].messages.push(msg)
  → zustand notify
  → ChatCard re-render
    → messages = useSessionField(s => s.sessionsById[sid]?.messages)
    → displayMessages = useMemo(...)  // 过滤或无过滤
  → ChatMessageList re-render
    → messageWindow = windowMessages(messages, { recentCount, expandedOlder })
      → startIndex = max(0, len - (recent + expanded))
      → visible = messages.slice(startIndex)
    → visibleMessages = messageWindow.visible
    → visibleIds = visibleMessages.map(m => m.id)
  → useVirtualScroll({ itemCount: visibleMessages.length, ids: visibleIds })
    → useEffect: manager.syncOrder(ids)
      → manager.order = ids（前缀保留）
      → markDirtyFrom → suffix rebuild
    → setHeightTick(t+1)
    → useMemo: visibleRange = computeVisibleRange(...)
  → 渲染：visibleMessages.slice(vsStartIndex, vsEndIndex)
```

**保证要点**：
1. `messages` 引用在 store 更新时变化 → `messageWindow` 重算
2. `visibleMessages` 变化 → `visibleIds` 新引用 → `useEffect(syncOrder)` 触发
3. `heightTick` 触发 → `visibleRange` 重算（使用最新高度）
4. 渲染使用最新的 `visibleMessages` 和 `visibleRange`

### 3.2 确保 messageWindow 计算正确

`windowMessages` 的输入输出：

```
输入：
  messages: T[]           → 完整消息列表
  options.recentCount     → 默认 80
  options.expandedOlder   → 额外展开的条数（默认 0）
  options.showAll         → 是否显示全部（搜索过滤时）
  options.mustIncludeIndices → 强制包含的下标

输出：
  visible: T[]            → 可见消息切片
  startIndex: number      → 切片起始下标（relative to messages）
  hiddenCount: number     → 隐藏条数
  effectiveExpanded       → 实际生效的 expandedOlder
```

**断言点**：
- `visible.length + startIndex === messages.length`（正常窗口时）
- `visible[0] === messages[startIndex]`（切片正确）
- 当 `showAll === true` 时，`startIndex === 0`，`hiddenCount === 0`

### 3.3 确保 messageSlice / visibleMessages 不产生重复

`messages.slice(startIndex)` 是 JS 数组的标准 slice 操作：

```javascript
// 原理：从数组的 startIndex 位置截取到末尾
// 示例：messages = [m0, m1, m2, m3, m4], startIndex = 2
//       visible = [m2, m3, m4]
```

**保证**：
- 数组切片不会产生重复元素
- 一个 id 在整个 `messages` 中只出现一次（store 的 addMessage 保证 upsert）
- `visibleMessages.map(m => m.id)` 不产生重复 id

## 4. 防御性编程

### 4.1 添加 invariant 断言

在关键路径添加运行时断言（仅在开发环境）：

```typescript
function invariant(condition: boolean, message: string): void {
  if (process.env.NODE_ENV === 'development' && !condition) {
    console.error('[VSM] Invariant failed:', message);
    if (typeof document !== 'undefined') {
      document.body.setAttribute('data-vsm-error', message);
    }
  }
}
```

使用位置：

```typescript
// VirtualScrollManager.clear()
clear(): void {
    invariant(this.order.length === 0 && this.heights.size === 0,
      'clear() called with non-empty order/heights — session switch expected');
    // ...
}

// syncOrder 中
syncOrder(ids: string[]): void {
    // 禁止在全量窗口平移时 length 剧烈波动（除非会话切换）
    invariant(Math.abs(ids.length - this.order.length) < 1000,
      'syncOrder: extreme length change — possible session switch desync');
    // ...
}
```

### 4.2 添加 recovery 路径：当 order 为零时自动恢复

当 `computeVisibleRange` 检测到 `order.length === 0` 但 `heights.size > 0` 时：

```typescript
computeVisibleRange(...): VisibleRange {
    // 自动恢复路径
    if (this.order.length === 0 && this.heights.size > 0) {
      if (this.debug) {
        console.warn('[VSM] computeVisibleRange: order is empty but heights',
          'size is', this.heights.size, '— possible clear() without syncOrder');
      }
      // 无法自动恢复 order（没有顺序信息）
      // 但可以继续使用 fallback 高度计算
    }
    // 正常计算
}
```

更好的 recovery：在 `getHeightAt` 中处理长度为 0 时的边界：

```typescript
getHeightAt(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    if (this.order.length === 0) {
      // order 为空：所有 index 都 fallback
      return this.fallbackHeight;
    }
    const id = this.order[safeIndex];
    if (id == null) return this.fallbackHeight;
    return this.getHeight(id);
}
```

### 4.3 日志追踪

在关键路径增加结构化日志：

| 事件 | 日志内容 | 级别 |
|------|---------|------|
| clear() 调用 | `{orderLen, heightsSize, stack}` | warn |
| syncOrder 空 order | `{ids.length, callStack}` | warn |
| syncOrder 大量 prepend | `{prependCount, oldLen, newLen}` | info |
| computeVisibleRange 异常 | `{orderLen, count, scrollTop}` | warn |
| 锚点补偿 | `{anchorId, newIndex, prependHeight}` | debug |

日志应在 Development 环境启用，Production 环境禁用或采样。

## 5. 测试策略

### 5.1 单元测试覆盖

| 测试组 | 文件 | 现有测试数 | 需新增 |
|--------|------|-----------|--------|
| 基本 id 高度存取 | VirtualScrollManager.test.ts | 1 | 0 |
| 窗口平移保留高度 | VirtualScrollManager.test.ts | 1 | 0 |
| expand older 多步 | VirtualScrollManager.test.ts | 1 | 0 |
| suffix rebuild | VirtualScrollManager.test.ts | 2 | 0 |
| clear 行为 | VirtualScrollManager.test.ts | 1 | 0 |
| 防御 NaN/负值 | VirtualScrollManager.test.ts | 1 | 0 |
| computeVisibleRange | VirtualScrollManager.test.ts | 1 | 0 |
| **clear→syncOrder 恢复** | VirtualScrollManager.test.ts | 0 | 1 |
| **连续快速追加** | VirtualScrollManager.test.ts | 0 | 1 |
| **会话切换→立即发消息** | VirtualScrollManager.test.ts | 0 | 1 |
| **clear 后无 syncOrder 的场景** | VirtualScrollManager.test.ts | 0 | 1 |
| **order 长度不足时的计算** | VirtualScrollManager.test.ts | 0 | 1 |

### 5.2 集成测试覆盖

| 测试场景 | 模拟方式 | 验证点 |
|---------|---------|--------|
| 发送一条消息，列表滚动到底部 | 调用 addMessage | visibleMessages 末尾新增，scrollTop 自动调整 |
| 快速连续发送 5 条消息 | 批量 addMessage | 无重复，高度正确 |
| expand older 两次 | 增加 expandedOlder | 前序消息高度保留，scrollTop 补偿 |
| 会话切换 | 改变 activeSessionId | clear 被调用，新会话数据加载 |
| 切换回来 | 改回原 activeSessionId | 重新 syncOrder，高度重建 |
| 搜索命中→窗口前移 | 设置 searchMatch | mustInclude 生效，startIndex 前移 |
| 审批 keep-alive | pending_approval 状态 | 窗口包含审批行，高度保留 |

### 5.3 手动验证清单

| # | 验证步骤 | 预期结果 | 备注 |
|---|---------|---------|------|
| 1 | 打开一个长历史会话（200+ 消息） | 只显示最近 80 条，无重复 | |
| 2 | 从底部发送消息 | 新消息出现在末尾，历史正常 | |
| 3 | 连续快速发送 10 条消息 | 无重复，无崩溃 | |
| 4 | 点击「显示更早的 40 条」 | 上方插入 40 条旧消息，视口不跳动 | |
| 5 | 再次点击「显示更早的 40 条」 | 再插 40 条，不跳动 | |
| 6 | 点击「全部展开」 | 全部消息可见，无重复 | |
| 7 | 切到另一个会话 | 高度清空，新会话数据加载 | |
| 8 | 切回原会话 | 高度重建，原顺序正确 | |
| 9 | 在搜索过滤中发送消息 | showAll 模式，新消息出现 | |
| 10 | 快速滚到顶部再回底部 | 无闪烁，无重复 | |
| 11 | 检查浏览器 console 的 VSM 日志 | 无异常告警 | Dev 环境 |
| 12 | 性能面板检查 layout/reflow | 无持续 layout thrashing | |

## 6. 回滚与监控

### 6.1 如何确认修复生效

**监控指标**（通过 console.log 或 metrics 上报）：

```
1. clear() 调用次数 / 会话切换次数     → 理想值接近 1:1
2. manager.order.length 在非会话切换时为 0 的次数 → 理想值 0
3. syncOrder 被调用的次数 / visibleIds 变化次数 → 理想值 1:1
4. computeVisibleRange 时 order.length < count → 理想值 0
```

**验证方式**：

```typescript
// 在 ChatMessageList 的 useLayoutEffect 中
const clearCountRef = useRef(0);
const sessionSwitchCountRef = useRef(0);

useLayoutEffect(() => {
    if (prevSessionIdForHeightsRef.current !== activeSessionId) {
      sessionSwitchCountRef.current++;
      clearHeights();
      clearCountRef.current++;
      // ratio 应接近 1
      if (clearCountRef.current !== sessionSwitchCountRef.current) {
        console.warn('clearHeights called without session switch',
          { clearCount: clearCountRef.current,
            switchCount: sessionSwitchCountRef.current });
      }
      // ...
    }
    // ...
});
```

### 6.2 回滚步骤

如果修复引入新问题，回滚步骤：

1. **Git 回滚**：
```bash
git log --oneline -5
git revert HEAD  # 或指定 commit SHA
```

2. **文件级回滚**（如果只想回滚特定文件）：
```bash
git checkout HEAD~1 -- apps/crish-desktop/src/api/VirtualScrollManager.ts
git checkout HEAD~1 -- apps/crish-desktop/src/hooks/useVirtualScroll.ts
git checkout HEAD~1 -- apps/crish-desktop/src/components/ChatMessageList.tsx
```

3. **验证回滚后行为**：
- 运行测试：`npx vitest run apps/crish-desktop/src/api/VirtualScrollManager.test.ts`
- 手动验证：检查消息列表是否正常

### 6.3 持续监控指标

**Production 环境**：

| 指标 | 阈值 | 告警方式 |
|------|------|---------|
| clear() 调用/会话切换比 | > 1.1 | 告警 |
| computeVisibleRange 的 order.length < count 次数 | > 0 | 告警 |
| syncOrder 接收到空 ids 且 order 非空 | > 0 | 日志 |
| 用户反馈「消息重复」 | 任何 | 紧急 |

**Development 环境**：

| 检查点 | 自动化 |
|--------|-------|
| `console.warn('[VSM]'` 的出现次数 | CI 日志分析 |
| React Strict Mode 下的双调用行为 | 无需处理（已知 safe） |
| `manager.getOrder().length` 在非会话切换时的突变 | 运行中监控 |

## 附录：修改清单总表

| 文件 | 修改类型 | 修改内容 | 优先级 |
|------|---------|---------|--------|
| VirtualScrollManager.ts | 增强 | 增加 debug 模式和日志 | P1 |
| VirtualScrollManager.ts | 防御 | clear() 增加空状态跳过 | P0 |
| VirtualScrollManager.ts | 防御 | syncOrder 增加空 order 告警 | P1 |
| VirtualScrollManager.ts | 防御 | getHeightAt 增加 order 为空保护 | P0 |
| VirtualScrollManager.ts | 边界 | computeVisibleRange 增加日志 | P2 |
| useVirtualScroll.ts | 增强 | syncOrder useEffect 增加 order 长度二次校验 | P0 |
| useVirtualScroll.ts | 防御 | clearHeights 增加日志 | P1 |
| useVirtualScroll.ts | 可选 | 暴露 manager 到 window debug | P3 |
| ChatMessageList.tsx | 重构 | prevVisibleIdsRef 更新时机移到 effect 末尾 | P1 |
| ChatMessageList.tsx | 防御 | 非会话切换路径增加 clearHeights 守卫断言 | P0 |
| VirtualScrollManager.test.ts | 新增 | clear→syncOrder 恢复测试 | P0 |
| VirtualScrollManager.test.ts | 新增 | 连续快速追加测试 | P0 |
| VirtualScrollManager.test.ts | 新增 | 会话切换→立即发消息测试 | P0 |
| VirtualScrollManager.test.ts | 新增 | clear 后无 syncOrder 的计算测试 | P1 |
| VirtualScrollManager.test.ts | 新增 | order 长度不足时的边界测试 | P2 |
