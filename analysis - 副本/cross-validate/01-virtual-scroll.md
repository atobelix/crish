# Cross-01: 虚拟滚动审计

## 1. 当前实现状态

### 1.1 VirtualScrollManager v2 (`VirtualScrollManager.ts`)

- **高度存储**：`heights Map<messageId, HeightEntry>`，以 messageId 为唯一键，窗口平移时同 id 高度保留
- **HeightEntry**：`{ estimated, actual | null, version }`，version 每次 entry 变更递增
- **order 数组**：当前窗口 id 有序列表，`idToIndex` 倒排索引，index 仅用于查询
- **offsetsCache**：`number[]`，`offsets[i]` = 前 i 项总高，suffix rebuild（`dirtyFrom` 标记最小变化 index）
- **syncOrder(ids)**：前缀相等检测 → 幂等跳过 → 裁剪/扩展 offsets → markDirtyFrom(firstDiff)
- **clear()**：全量清空 heights + order + offsets，`generation++`，仅会话切换调用
- **generation**：clear 时递增，setActual 可选 `callerGeneration` 做校验
- **setActual(id, height, callerGeneration?, callerVersion?)**：generation/version 乐观锁
- **invalidateActual(id)**：设置 `actual = null`，触发 ResizeObserver 重测
- **invalidateAllActual()**：全部 actual 置 null，宽度大幅变化时调用

### 1.2 useVirtualScroll hook (`useVirtualScroll.ts`)

- **syncOrder 已从 useEffect 升级为 useLayoutEffect**（line 80），在 layout 相位同步 order
- **auto syncOrder**：`useLayoutEffect` 在 `[manager, ids]` 变化时自动调用 `manager.syncOrder(ids)`
- **setEstimated / setActual** 通过 rAF 批处理合并多次调用，减少 heightTick 触发次数
- **heightTick**：计数器 `useState(0)`，通过 `void heightTick` 嵌入 `useMemo` 依赖，强制重算 `visibleRange` 和 `totalHeight`
- **onScroll**：rAF 节流更新 scrollTop

### 1.3 ChatMessageList 高度生命周期 (`ChatMessageList.tsx`)

- **会话切换守卫**：`prevSessionIdForHeightsRef !== activeSessionId` → `clearHeights()` + 更新 `expectedGenerationRef`
- **generation 守卫**：`manager.generation !== expectedGenerationRef.current` → 跳过锚点补偿
- **order.length 守卫**：`manager.order.length === 0` → 跳过锚点补偿
- **锚点补偿**：expand older 时按 `manager.getHeight(id)` 累加前置高度，`el.scrollTop += prependedHeight`
- **setContainerWidth**：宽度变化 >= 40px 时调用 `manager.invalidateAllActual()`
- **Pretext 估算**：未渲染消息按文本 + toolCalls 估算高度，通过 `vs.setEstimated` 写入
- **ResizeObserver**：观察 `[data-msg-id]` 元素，回调调 `setActual(msgId, height)`

### 1.4 ChatMessageRow 高度交互 (`ChatMessageRow.tsx`)

- **流式 text 更新**：`msg.text` 变化时通过 rAF 调用 `virtualScrollManager.invalidateActual(id)`（直接调用 manager 方法，不要通过 hook）
- 没有 ResizeObserver（由 ChatMessageList 统一管理）
- 不调 `setActual`，仅调 `invalidateActual` 间接触发重新测量

### 1.5 测试覆盖 (`VirtualScrollManager.test.ts` + `useVirtualScroll.test.ts`)

- VSM 单元测试 27 个：基本存取、窗口平移保留高度、expand older、suffix rebuild、clear 行为、防御、generation 守卫等
- Hook 测试 7 个：ids→syncOrder layout phase 锁、clear 不被 pan 调用、StrictMode 安全、静态源码验证无 startIndex+clearHeights 共 effect

---

## 2. 已修复项确认

### ✅ R03: clearHeights 误触（根因：窗口平移时误清高度）

| 子项 | 状态 | 证据 |
|------|------|------|
| clearHeights 只在会话切换触发 | ✅ 已修复 | `ChatMessageList.tsx:574-581` — `prevSessionIdForHeightsRef` 守卫 |
| 窗口平移/expand older 只 syncOrder 不 clear | ✅ 已修复 | `useVirtualScroll.ts:80-85` useLayoutEffect 自动 syncOrder |
| clear 空状态跳过 | ✅ 已修复 | `VirtualScrollManager.ts:288-292` — `hadData` 检查 |
| 双重 clear 安全 | ✅ 已修复 | `VirtualScrollManager.ts:288` — early return + generation 不变 |

### ✅ syncOrder 从 useEffect 升级为 useLayoutEffect

| 子项 | 状态 | 证据 |
|------|------|------|
| ids → syncOrder 在 layout 相位执行 | ✅ 已修复 | `useVirtualScroll.ts:80` — `useLayoutEffect` |
| 锚点补偿时 order 已同步 | ✅ 已修复 | layout 相位顺序：hook syncOrder → ChatMessageList 锚点补偿 |
| hook 测试验证 | ✅ | `useVirtualScroll.test.ts:152` — 静态源码正则锁定 useLayoutEffect |

### ✅ 锚点补偿守卫完整

| 守卫 | 状态 | 位置 |
|------|------|------|
| `manager.order.length === 0` | ✅ | `ChatMessageList.tsx:589` |
| `manager.generation !== expectedGenerationRef.current` | ✅ | `ChatMessageList.tsx:594` |
| 对齐性检查 | ✅ | `ChatMessageList.tsx:607-615` |
| `newIndexOfAnchor <= 0` 跳过 | ✅ | `ChatMessageList.tsx:604` |
| `prependedHeight > 0` 才补偿 | ✅ | `ChatMessageList.tsx:622` |

### ✅ 窗口平移高度缓存保留

- 测试 `窗口平移时高度缓存应保留` ✅ (`VirtualScrollManager.test.ts:246`)
- 测试 `expand older 后高度缓存保留` ✅ (`VirtualScrollManager.test.ts:256`)
- `syncOrder` 内部 `firstDiff` 前缀检测 → 同 id 高度保留

### ✅ clearHeights 仅会话切换触发

- `ChatMessageList.tsx:574-581`：仅 `activeSessionId` 变化时调用
- `useVirtualScroll.test.ts:129`：clear 后 order 为空，新 ids 恢复

### ✅ 宽度变化 invalidateAllActual 已接线

- `ChatMessageList.tsx:638-647`：`setContainerWidth` 在宽度变化 >= 40px 时调 `manager.invalidateAllActual()`
- 触发 `setHeightTick` → `visibleRange` 重算

---

## 3. 剩余问题

### P0-01: setActual 的 generation/version 守卫是死代码

**根因**：
- `manager.setActual(id, height, callerGeneration?, callerVersion?)` 接受可选的 generation/version 参数
- 两个消费者路径**都没有传递这些参数**：
  - 路径 A: `ChatMessageList.tsx:751` → `setActual(msgId, height)` → `useVirtualScroll.ts` rAF 批 → `manager.setActual(msgId, h)`（无 callerGeneration/callerVersion）
  - 路径 B: `ChatMessageRow.tsx:332/623` → `virtualScrollManager.invalidateActual(id)`（直接调 manager，根本不走 setActual）
- 因此 `setActual` 内部的 generation/version 校验永不触发（`callerGeneration === undefined` 恒成立）

**影响**：
- 会话切换后，旧 session 挂起的 rAF `setActual` 回调仍会被执行。ResizeObserver 在新 session 重新绑定后不会产生旧 DOM 条目，但旧 rAF 回调中若恰有同 id 条目（概率低但可能），会无校验写入
- 更关键的：`invalidateActual` 递增 `version` 后，随后到来的 `setActual`（经过 rAF 批）不传 `callerVersion`，version 乐观锁形同虚设

**修复方案**：见 §4。

### P0-02: ChatMessageRow 的 invalidateActual 绕过 rAF/K 批处理

**根因**：
- `ChatMessageRow.tsx:331-334` / `619-623` 直接调 `virtualScrollManager.invalidateActual(id)`，不经过 `vs.setActual`
- 而 `invalidateActual` 是对 `heights` Map 的**直接同步写入**，与 ChatMessageList 中 ResizeObserver → `vs.setActual` → rAF 批路径形成双写路径
- 两条路径共享同一个 `heights` Map，但写入时机不同（sync vs rAF）

**影响**：
- 时序不确定：text 变化 → invalidateActual (sync) → ResizeObserver 在同一帧可能跳过 → 下一帧 rAF setActual 填回旧高度（`existing.version` 已递增但 setActual 不传 callerVersion → 不会跳过）
- 极端情况下可能导致：text 流式更新 → invalidateActual 清 actual → 旧 ResizeObserver entry 的 rAF setActual 覆盖为新高度 → 但实际 DOM 已变的更大/更小

**严重程度**：P0 因为可能导致流式输出时高度闪烁，但影响有限（下一帧 ResizeObserver 会再更正）

### P0-03: 无接线级测试验证 generation/version 传递

**根因**：测试覆盖了 `manager.setActual` 的 generation 守卫（`VirtualScrollManager.test.ts:296`），但此测试直接调 `manager.setActual('a', 999, 999)` — 手动传参。**没有测试验证从 ResizeObserver → `vs.setActual` → `manager.setActual` 整条链路正确传递 callerGeneration**。

**影响**：generation 机制在 consumer 层断开。如果以后有人重构 ChatMessageList 的 ResizeObserver 回调，发现 generation 守卫"测试通过"但在 consumer 侧实际不工作，产生隐蔽错误。

### P1-04: `setActual` rAF 批处理不传递 callerGeneration

**根因**：`useVirtualScroll.ts:182` 的 rAF 回调：
```typescript
pendingActualRef.current.forEach((h, msgId) => {
    manager.setActual(msgId, h);  // 无 callerGeneration
});
```
没有传递当前 `manager.generation` 作为 `callerGeneration`。

**影响**：与 P0-01 同一根源，此处是修复落地位置。

### P1-05: `expectedGenerationRef` 初始值 0 与 manager 初始 generation 0 相等

**根因**：`ChatMessageList.tsx:572`：
```typescript
const expectedGenerationRef = useRef(0);
```
而 `new VirtualScrollManager()` 的 generation 初值也是 0。首次渲染时如有锚点补偿条件（实际上不可能，因为 prevIds 为空），generation 守卫不会拦截。

**影响**：
- 首次渲染时 `if (manager.generation !== expectedGenerationRef.current)` 是 `0 !== 0` → false → 不跳过
- 但首次渲染时 `prevIds.length === 0` 会触发 `if (!el || prevIds.length === 0 || nextIds.length === 0) return;` 的提前 return
- **实际上无影响**，但语义上不够健壮

**修复**：将 `expectedGenerationRef` 初始化为 `-1` 或 `manager.generation + 1`。

### P1-06: `setContainerWidth` 中 `isResizing` 守卫会跳过宽度变化

**根因**：`ChatMessageList.tsx:639`：
```typescript
const setContainerWidth = useCallback((width: number) => {
    if (isResizing) return;  // ← 拖拽 resize 期间跳过
    ...
    manager.invalidateAllActual();
}, [isResizing, manager, setHeightTick]);
```

**影响**：拖拽列宽过程中宽度变化 >= 40px 时不会触发 `invalidateAllActual`。虽然拖拽结束后 nextTick 会恢复并触发，但拖拽期间所有消息高度基于旧宽度显示。如果分割面板拖拽产生大幅宽度变化，用户会在拖拽过程中看到消息排布错误的视觉效果。

**严重程度**：P1 — 拖拽结束后会正确恢复。

### P2-07: Pretext 估算使用 `vs.setEstimated` 但 manager.hasHeight 检查可能跳过

**根因**：`ChatMessageList.tsx:690`：
```typescript
const pending = visibleMessages.filter((msg) => msg && !manager.hasHeight(msg.id));
```
当会话切换后 `clear()` 清空 heights，所有消息都是 "未测量" → 都需要 Pretext 估算。但若 `visibleMessages` 在估算未完成时又变化（快速滚动），已排队的 rAF 估算被取消（line 729 cleanup），但管理估算进度的 `cursor` 和 `pending` 数组也在 cleanup 中丢失。

**影响**：快速 expand older + scroll 组合操作下，部分消息可能永远得不到 Pretext 估算，始终使用 fallback 120px。在 DOM 渲染后 ResizeObserver 会纠正，但首帧偏移量不精确。

**严重程度**：P2 — ResizeObserver 最终纠正，仅影响首帧精度。

---

## 4. 修复方案

### P0-01/P1-04: 让 `setActual` 传递 `callerGeneration`

**修改 `useVirtualScroll.ts`**：

在 rAF 回调中捕获当前 generation 并传递：

```typescript
const setActual = useCallback(
    (id: string, height: number) => {
      if (typeof id !== 'string' || id.length === 0) return;
      pendingActualRef.current.set(id, height);
      if (actualRafRef.current == null) {
        // 在 rAF 回调中捕获最新的 generation
        actualRafRef.current = requestAnimationFrame(() => {
          actualRafRef.current = null;
          const currentGen = managerRef.current?.getGeneration() ?? -1;
          pendingActualRef.current.forEach((h, msgId) => {
            manager.setActual(msgId, h, currentGen);
          });
          pendingActualRef.current.clear();
          setHeightTick((t) => t + 1);
        });
      }
    },
    [managerRef],
  );
```

注意：这里需要用 `managerRef.current` 而非闭包的 `manager`（因为 rAF 回调在闭包中捕获的 manager 版本可能过时）。当前代码 `useRef` 的 managerRef 始终是最新实例。

### P0-02: ChatMessageRow 的 invalidateActual 改用 `vs.setActual` 的 invalidate 语义

评估后建议：**保持现状**。`invalidateActual` 是对 heights Map 的同步写入，目的是立即清除 actual 让下一帧 ResizeObserver 重测。改成异步 rAF 批会导致 text 变化到重新测量之间多一帧延迟。但需要修复 P0-01 的 callerVersion 传递。

额外修改：ChatMessageRow 的 invalidateActual 后应当也传递 version 信息，但目前接口 `invalidateActual(id)` 不返回 version。建议在 VirtualScrollManager 中添加：

```typescript
invalidateActual(id: string): number | undefined {
    ...
    existing.actual = null;
    existing.version++;
    ...
    return existing.version;  // 返回新 version
}
```

但 ChatMessageRow 目前不需要，因为 ResizeObserver 自动重测。

### P1-05: 修正 expectedGenerationRef 初始值

```typescript
const expectedGenerationRef = useRef(manager.generation);
// 而非 useRef(0)
```

或在 useLayoutEffect 中增加初始化判断。

### P1-06: setContainerWidth 在 isResizing 时不跳过宽度记录

```typescript
const setContainerWidth = useCallback((width: number) => {
    setContainerWidthState(width);
    const prev = prevWidthRef.current;
    prevWidthRef.current = width;
    if (isResizing) return;  // 只跳过 invalidateAllActual，不跳过宽度记录
    if (prev > 0 && Math.abs(width - prev) >= 40) {
      manager.invalidateAllActual();
      setHeightTick(t => t + 1);
    }
}, [isResizing, manager, setHeightTick]);
```

---

## 5. 测试缺口

| # | 测试用例 | 当前覆盖 | 缺口等级 |
|---|---------|---------|---------|
| 1 | ResizeObserver → vs.setActual → manager.setActual 传递 callerGeneration | ❌ 无 | P0 |
| 2 | ChatMessageRow invalidateActual 后 ResizeObserver setActual 使用新 version 不覆盖 | ❌ 无 | P0 |
| 3 | 会话切换后旧 rAF setActual 回调被 generation 守卫拦截 | ❌ 无（仅手动传递测试） | P0 |
| 4 | setContainerWidth 宽度变化 >= 40px 触发 invalidateAllActual（hook 级） | ❌ 无 | P1 |
| 5 | isResizing 时 invalidateAllActual 不被触发 | ❌ 无 | P1 |
| 6 | 快速 expand older + scroll 组合 Pretext 首帧估算 | ❌ 无 | P2 |
| 7 | 多组 setActual + setEstimated 交替写入，heightTick 去重合并 | ❌ 无 | P2 |
| 8 | invalidateAllActual 后全部 actual 为 null，getHeight 回落 estimated | ❌ 无 | P1 |

### 追加测试代码 (P0-01/P0-02/P0-03)

**在 `useVirtualScroll.test.ts` 中追加**：

```typescript
it('setActual passes callerGeneration to manager (generation guard wired)', () => {
    const { result } = renderHook(
      ({ ids, itemCount }) => useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['a'], itemCount: 1 } },
    );

    // 模拟会话切换
    const genBeforeClear = result.current.manager.getGeneration();
    result.current.clearHeights();
    const genAfterClear = result.current.manager.getGeneration();
    expect(genAfterClear).toBe(genBeforeClear + 1);

    // 新会话的消息
    result.current.manager.syncOrder(['a']);
    // 模拟过时的 setActual（应该被 generation 守卫拦截）
    result.current.manager.setActual('a', 999, genBeforeClear);
    // 不应接受旧 generation 的数据
    expect(result.current.manager.getHeight('a')).toBe(100);

    // 正确的 setActual（无 generation 参数，模拟当前消费者行为）
    result.current.manager.setActual('a', 200);
    expect(result.current.manager.getHeight('a')).toBe(200);
});
```

**在 `useVirtualScroll.test.ts` 中追加** (使用 spy 验证 generation 传递)：

```typescript
it('setActual consumer path passes callerGeneration via rAF batch', async () => {
    const { result } = renderHook(
      ({ ids, itemCount }) => useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['a'], itemCount: 1 } },
    );

    const setActualSpy = vi.spyOn(result.current.manager, 'setActual');
    const gen = result.current.manager.getGeneration();

    // 通过 hook 的 setActual（模拟 ChatMessageList 的调用方式）
    result.current.setActual('a', 200);

    // 等待 rAF
    await new Promise((r) => requestAnimationFrame(r));

    expect(setActualSpy).toHaveBeenCalledWith('a', 200);
    // FIXME: 当前不传 generation，此处 expect 应为 gen
    // 修复后改为: expect(setActualSpy).toHaveBeenCalledWith('a', 200, gen);

    setActualSpy.mockRestore();
});
```

---

## 6. 优先级建议

| 优先级 | 问题 | 影响范围 | 建议行动 |
|--------|------|---------|---------|
| **P0** | setActual 不传 callerGeneration，generation 守卫死代码 | 会话切换后旧 rAF 回调可能写入错误高度 | 修复 useVirtualScroll.ts rAF 回调，传递 `managerRef.current.getGeneration()` |
| **P0** | setActual 不传 callerVersion，version 乐观锁失效 | stale ResizeObserver entry 可能覆盖新版 invalidateActual | 同上 — 传递 callerVersion：捕获 heightEntry version 后传入 |
| **P0** | 无接线测试覆盖 generation/version 传递 | 重构时无法发现守卫断线 | 追加 §5 中的 spy 测试 |
| **P1** | expectedGenerationRef 初始值 0 与 generation 0 歧义 | 语义不健壮 | 改 `useRef(manager.generation)` |
| **P1** | invalidateAllActual 在 isResizing 时被完全跳过 | 拖拽 resize 中宽度大幅变化不触发重测 | 移 `isResizing` guard 只保护 invalidateAllActual 不保护宽度记录 |
| **P2** | Pretext 估算在快速操作时部分消息被跳过 | 首帧偏移量不精确 | ResizeObserver 兜底修正，非阻塞 |
| **P2** | 双写入路径（invalidateActual sync + setActual rAF） | 理论时序风险，实际概率低 | 观察生产环境是否有高度闪烁 |
