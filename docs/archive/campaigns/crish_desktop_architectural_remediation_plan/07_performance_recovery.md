# 子计划 07：Layer G — 性能恢复与优化 (Performance Recovery)

> **层级编号**：Layer G（Round 6，在 Layer A-F 结构性重构完成后启动）
> **建议 Agent 数量**：6-8 个
> **涉及维度**：D4（并发/内存安全）、D7（资源泄漏）、D8（渲染性能）
> **包路径**：跨层（`apps/crish-desktop/`、`packages/agent-runtime/`、`apps/agent-workbench/src-tauri/`）
> **前提条件**：Layer A-F 的文件拆分已完成并通过验收
>
> **本层与其它层的交叉引用**：G-1（SSE 渲染节流）操作 `useChatStream.ts` 的渲染逻辑区，该文件的结构拆分在总览 F-7 中完成。Layer I（CI/CD）的 I-15（基准测试持久化）需要本层建立的性能基线。Layer J（J-17 Stress 测试可重现重构）与本层的 Worker 优化协同——Stress 测试验证 WorkerPool 的稳定性。

---

## 一、现有架构准确评估

> [!IMPORTANT]
> 本节纠正旧版 07 文档中的多处事实性错误。实际代码中已有多个高质量的性能基础设施，07 层的任务是**修补已有架构的边缘缺陷**，而非从零构建。

### 1.1 已有基础设施（代码已实现，无需重建）

| 基础设施 | 文件 | 行数 | 实际状态 | 旧文档错误描述 |
|---------|------|------|---------|--------------|
| **O(log N) 二分查找** | [VirtualScrollManager.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.ts) L271-296 | 453 | ✅ 已实现 `findIndexAtOffset()` 二分查找 + suffix rebuild 偏移缓存 | ❌ 旧文档声称"线性扫描 O(N)" |
| **rAF 自适应帧预算** | [StreamRenderBuffer.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/StreamRenderBuffer.ts) L38-313 | 314 | ✅ 已实现 EMA 帧预算（35%-75% rAF interval） + `maxBytesPerFrame` 自适应缩放 | ❌ 旧文档声称"未做 rAF 节流" |
| **Worker 池化** | [worker-pool.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/worker-pool.ts) L40-393 | 393 | ✅ 已实现 4 类型池（render/compute/io/network） + 优先级队列 + 去重缓存 + 崩溃恢复 + 空闲回收 + Phase 2 扩容 | ❌ 旧文档声称"每次创建新 Worker" |
| **Markdown LRU 缓存** | [markdownRenderAsync.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts) L5-26 | 51 | ✅ 已实现 `markdownCache` + `pendingRenders` 去重 | ❌ 旧文档声称"无池化复用" |
| **流式批合并** | [streamTextBatcher.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/streamTextBatcher.ts) L46-368 | 368 | ✅ leading-edge interval + re-entrant 保护 + maxBufferedSize 强制 flush | — |
| **背压协议** | [StreamRecovery.ts](file:///c:/Software/conex/apps/crish-desktop/src/services/StreamRecovery.ts) L229-699 | 699 | ✅ 64KB 高水位 / 16KB 低水位 / 256KB 有界队列 + sequence-based replay | — |
| **Pretext 文本估算** | [ChatMessageList.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/ChatMessageList.tsx) L729-792 | — | ✅ `@chenglou/pretext` + 全局缓存 + rAF 分帧 | — |
| **页面卸载保护** | [beforeunloadFlush.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/beforeunloadFlush.ts) L88-102 | 103 | ✅ beforeunload + pagehide 同步 flush 所有 batcher + localStorage 持久化 | — |
| **流式 Markdown Worker** | [streaming-renderer.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/streaming-renderer.ts) L14-106 | 107 | ✅ rAF 调度 + WorkerPool 异步渲染 + isFinal 路径 | — |

### 1.2 真实性能问题清单（基于代码分析）

| 任务 ID | 问题 | 严重度 | 根因 |
|---------|------|--------|------|
| G-1 | FilesCard 内联重复 `useVirtualScroll` | 中 | 等高简化版未复用全局 VirtualScrollManager |
| G-2 | `StreamRenderBuffer.onFrame` sid 闭包竞态 | **高** | `useChatStream` 中 `onFrame` 回调捕获过期 `sid` |
| G-3 | WorkerPool `taskQueue.sort()` O(N log N) | 中 | 每次 enqueue 全量排序，应改为优先级堆 |
| G-4 | Pretext 估算未 Worker 卸载 | 中 | 大量消息的 `prepare() + layout()` 在主线程 rAF 中执行 |
| G-5 | `markdownRender.ts` 主线程同步备选路径 | **高** | 961 行同步解析器作为 Worker 失败的 fallback，阻塞主线程 |
| G-6 | React.memo 覆盖不完整 | 中 | `FilesCard`, `SettingsPanel`, `App` 等缺少 memo |
| G-7 | Zustand selector 精细化不足 | 中 | `layoutStore` 组件侧未使用 `useShallow`（仅 sessionStore/workspaceStore 使用） |
| G-8 | 内存泄漏系统性审计 | 中 | EventListener/Timer/AbortController 配对率未验证 |

---

## 二、任务 G-1：FilesCard 重复虚拟滚动消除

### 2.1 问题定位

[FilesCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/FilesCard.tsx) L67-126 定义了一个内联 `useVirtualScroll` 函数，与全局 [hooks/useVirtualScroll.ts](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts) **完全独立**：

```typescript
// FilesCard.tsx L67-126 — 内联简化版
function useVirtualScroll({ itemCount, itemHeight, containerRef, overscan = 10 }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  // 线性计算：startIndex = floor(scrollTop / itemHeight) - overscan
  // 无 VirtualScrollManager，无 suffix rebuild，无 rAF 节流
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(itemCount - 1, Math.floor((scrollTop + containerHeight) / itemHeight) + overscan);
}
```

对比全局版本：

```typescript
// hooks/useVirtualScroll.ts — 全局版
// O(log N) 二分 + estimated/actual 双层高度 + rAF 批量滚动 + syncOrder 窗口保持
export function useVirtualScroll(options: UseVirtualScrollOptions): UseVirtualScrollResult {
  const manager = new VirtualScrollManager(fallbackHeight);
  // manager.computeVisibleRange() → findIndexAtOffset() O(log N)
}
```

### 2.2 修复方案

**替换策略**：FilesCard 的文件列表是等高行（固定 `itemHeight`），可使用全局 `useVirtualScroll` 的 `fallbackHeight` 模式：

```typescript
// 修复后：删除内联版，迁移到全局 hook
const fileIds = useMemo(() => flattenedEntries.map(e => e.path), [flattenedEntries]);
const vs = useVirtualScroll({
  itemCount: flattenedEntries.length,
  ids: fileIds,
  fallbackHeight: FILE_ROW_HEIGHT, // 固定行高，全部 id 使用 fallback
  overscan: 10,
});
```

**注意**：全局版的 `setEstimated` / `setActual` 不需要为等高行调用，VirtualScrollManager 会使用 `fallbackHeight` 作为默认值。

### 2.3 性能收益

| 指标 | 内联版 | 迁移后 |
|------|--------|--------|
| 可视窗口计算 | O(1) 线性（简单等高） | O(log N)（overkill 但统一） |
| 代码重复 | 60 行冗余代码 | 0 |
| ResizeObserver | 手动管理 | 统一 `ResizeObserverManager` |
| 滚动事件 | 直接 setState（每帧触发） | rAF 节流 |

---

## 三、任务 G-2：StreamRenderBuffer.onFrame 竞态修复

### 3.1 问题定位

[useChatStream.ts](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useChatStream.ts) 中 `StreamRenderBuffer` 的 `onFrame` 回调捕获了外层闭包中的 `sid`（session ID）：

```
问题链路：
━━━━━━━━━
1. runStreamingAssistant(sid) 启动流式
2. renderBuffer.onFrame = (frame) => {
     // 此处的 sid 是闭包捕获的，指向启动时的 session
     // 如果用户在流式过程中切换 session，sid 仍指向旧 session
     // 导致 frame 写入错误 session 的 store
   }
3. 用户切换 session → activeSessionId 变化
4. 新的 onFrame 回调未被挂载（因为流仍在运行）
5. 结果：流式文本写入错误 session
```

### 3.2 修复方案

**方案 A：`assertLive()` 守卫扩展到 onFrame**

```typescript
// 在 onFrame 回调内部增加 session 有效性检查
renderBuffer.onFrame = (frame: RenderFrame) => {
  // 守卫：当前活跃 session 必须与流启动时的 session 匹配
  const currentSid = useLayoutStore.getState().activeSessionId
    ?? getSessionStoreState().activeSessionId;
  if (currentSid !== sid) {
    // 非活跃 session 的帧：静默丢弃（流仍在后台运行，但不更新 UI）
    return;
  }
  // ... 正常处理
};
```

**方案 B：Ref 追踪当前 sid（推荐）**

```typescript
const activeSidRef = useRef(activeSessionId);
activeSidRef.current = activeSessionId;

renderBuffer.onFrame = (frame: RenderFrame) => {
  if (activeSidRef.current !== sid) return;
  // ... 正常处理
};
```

### 3.3 测试用例

```typescript
test('session switch during streaming discards stale frames', () => {
  const buffer = new StreamRenderBuffer();
  let lastFrame: RenderFrame | null = null;

  // 启动 session-1 的流
  const sid = 'session-1';
  buffer.onFrame = (frame) => {
    if (activeSidRef.current !== sid) return;
    lastFrame = frame;
  };

  buffer.push('hello');
  buffer.flush(true);
  expect(lastFrame?.full).toBe('hello');

  // 切换到 session-2
  activeSidRef.current = 'session-2';
  buffer.push(' world');
  buffer.flush(true);
  // 帧应被丢弃
  expect(lastFrame?.full).toBe('hello');
});
```

---

## 四、任务 G-3：WorkerPool 优先级队列优化

### 4.1 问题定位

[worker-pool.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/worker-pool.ts) L205-211 中，每次 `enqueueTask` 都对整个 `taskQueue` 进行全量排序：

```typescript
// L205-211 — 当前实现
private enqueueTask(task: Task<any>): void {
  const canDispatch = this.tryDispatchDirect(task);
  if (!canDispatch) {
    this.taskQueue.push(task);
    this.taskQueue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    //                   ^^^^ O(N log N) 每次入队
  }
}
```

当队列深度 > 50 时（并发 markdown 渲染 + diff 计算 + 代码高亮），排序开销显著。

### 4.2 修复方案

**替换为二叉堆（Min-Heap）**：

```typescript
class PriorityTaskQueue {
  private heap: Task[] = [];

  enqueue(task: Task): void {
    this.heap.push(task);
    this.bubbleUp(this.heap.length - 1);  // O(log N)
  }

  dequeueForType(type: WorkerType): Task | undefined {
    // 找到匹配类型的最高优先级任务
    const idx = this.findHighestPriorityByType(type);
    if (idx < 0) return undefined;
    return this.removeAt(idx);  // O(log N)
  }

  private bubbleUp(i: number): void { ... }
  private sinkDown(i: number): void { ... }
}
```

### 4.3 `dispatchNext` 优化

当前 L260-267 的 `dispatchNext` 使用 `find()` 线性搜索匹配 workerType 的任务：

```typescript
// L260-267 — 当前实现
private dispatchNext(entry: WorkerEntry): void {
  const task = this.taskQueue.find((t) => t.workerType === entry.type);
  //                              ^^^^ O(N) 线性扫描
  if (task) {
    const idx = this.taskQueue.indexOf(task);
    this.taskQueue.splice(idx, 1);
    this.dispatchToWorker(entry, task);
  }
}
```

**修复**：按 `workerType` 分桶的优先级队列，每个 type 独立堆，`dequeue` O(log N)。

### 4.4 性能目标

| 指标 | 当前 | 目标 |
|------|------|------|
| enqueue 复杂度 | O(N log N) | O(log N) |
| dispatchNext 复杂度 | O(N) | O(log N) |
| 50 任务队列 enqueue 耗时 | ~0.3ms | ≤ 0.05ms |

### 4.5 基准测试 Cargo.toml 配置

目标文件：`crates/conex-stream/Cargo.toml`

在 `[dependencies]` 之后添加：
```toml
[[bench]]
name = "search_bench"
harness = false

[[bench]]
name = "compaction_bench"
harness = false

[[bench]]
name = "ipc_bench"
harness = false

[[bench]]
name = "diff_bench"
harness = false

[[bench]]
name = "sandbox_bench"
harness = false
```

CI 退化检查：
```yaml
# 在 perf-test.yml 中
- name: Bench regression check
  run: |
    cargo bench --bench search_bench -- --baseline main
    # 如果性能退化超过 ±10%，退出码非零
    diff-threshold --threshold=10 --baseline=main --current=HEAD
```

需在 `Cargo.toml` 的 `[dev-dependencies]` 中确认包含 `criterion`（当前已有）。

---

## 五、任务 G-4：Pretext 估算 Worker 卸载

### 5.1 问题定位

[ChatMessageList.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/ChatMessageList.tsx) L729-792 在**主线程 rAF** 中执行 Pretext 文本布局计算：

```typescript
// L753-782 — 当前实现（主线程）
const processBatch = () => {
  const limit = Math.min(cursor + CHUNK_SIZE, pending.length);
  while (cursor < limit) {
    const msg = pending[cursor++];
    // ⚠️ 这些计算在主线程执行
    const prepared = globalPretextCache.getOrCreate(msg.id, text, pretextFont);
    const result = layout(prepared, availWidth, TEXT_LINE_HEIGHT);
    h = result.height + TEXT_PADDING;
    vs.setEstimated(msg.id, h);
  }
  if (cursor < pending.length) {
    pretextRafRef.current = requestAnimationFrame(processBatch);
  }
};
pretextRafRef.current = requestAnimationFrame(processBatch);
```

当 `pending.length` > 100（expand older 或首次加载长会话），即使分帧（CHUNK_SIZE=5），也需要 20+ 帧（~333ms）才能完成所有估算，期间每帧占用 2-5ms 的 layout 计算时间。

### 5.2 修复方案

将 `prepare() + layout()` 计算卸载到 `compute` Worker：

```typescript
// 新建 workers/pretext-worker.ts
// Worker 端
self.onmessage = (e: MessageEvent) => {
  const { messages, font, availWidth, lineHeight } = e.data;
  const results: Array<{ id: string; height: number }> = [];
  for (const msg of messages) {
    const prepared = prepare(msg.text, font);
    const result = layout(prepared, availWidth, lineHeight);
    results.push({ id: msg.id, height: result.height + 40 });
  }
  self.postMessage({ results });
};

// 主线程调用
const heights = await getWorkerPool().schedule<Array<{ id: string; height: number }>>(
  'compute', 'pretext.batch-layout',
  { messages: pending.map(m => ({ id: m.id, text: m.text })), font, availWidth, lineHeight },
  Priority.High
);
for (const { id, height } of heights) {
  vs.setEstimated(id, height);
}
```

### 5.3 注意事项

- `@chenglou/pretext` 的 `prepare()` 需要字体度量数据（`pretextFont`），需确认是否可序列化传输到 Worker
- 如果 `pretextFont` 依赖 Canvas API（`measureText`），则无法在 Worker 中使用，需改用预计算的字体宽度表
- `globalPretextCache` 位于主线程，Worker 计算后结果需回填缓存

### 5.4 性能目标

| 指标 | 当前 | 目标 |
|------|------|------|
| 100 消息估算总耗时（主线程阻塞） | ~333ms (20 帧 × 5 条) | 0ms（Worker 异步） |
| 单消息估算耗时 | ~2-5ms | — (在 Worker 中) |
| 首屏估算完成延迟 | ~333ms | ≤ 80ms（Worker 并行） |

---

## 六、任务 G-5：markdownRender.ts 主线程路径审计

### 6.1 问题定位

[markdownRender.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRender.ts)（961 行！）是一个**完整的同步 Markdown → HTML 解析器**，包含：

- URL 安全性判定（L23-130）
- 完整的 Markdown 行级解析器（表格、代码块、列表、引用、标题、水平线）
- 代码高亮集成（`highlightCode` 同步调用）
- HTML 缓存层（`markdownCache`）

这个 961 行的解析器有**两个调用路径**：

```
路径 A（正常）：markdownRenderAsync → WorkerPool → render-worker.ts → markdownRender.ts
  → Worker 线程执行，不阻塞主线程 ✅

路径 B（fallback）：ChatMessageRow 等组件直接 import parseMarkdownToHtml
  → 主线程同步执行 961 行解析 + highlightCode ⚠️
```

### 6.2 调用方审计

```
直接同步调用 parseMarkdownToHtml 的组件：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ChatMessageRow.tsx → 消息渲染时的 fallback 路径
- FilesCard.tsx → Markdown 文件预览
- InlineAgentPanel.tsx → 内联 agent 面板
- SkillsSettingsTab.tsx → 技能描述渲染
```

### 6.3 修复方案

1. **消除主线程同步路径**：所有 `parseMarkdownToHtml` 调用迁移到 `parseMarkdownToHtmlAsync`
2. **流式渲染使用 StreamingRenderer**：已有 [streaming-renderer.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/streaming-renderer.ts) 封装了 rAF + Worker 异步渲染管线，直接复用
3. **非流式渲染**：使用 `parseMarkdownToHtmlAsync` + `useSuspenseQuery` 模式或 state + useEffect 模式
4. **Worker 失败的 fallback**：使用 `markdownRenderLite`（轻量同步版本，仅做基础 escape），不走 961 行完整解析器

### 6.4 性能目标

| 指标 | 当前 | 目标 |
|------|------|------|
| 10KB Markdown 同步解析（主线程阻塞） | ~15-30ms | 0ms（全部异步） |
| 主线程 `parseMarkdownToHtml` 调用次数 | 4 个文件 | 0（全部迁移到 async） |

---

## 七、任务 G-6：React.memo 覆盖审计

### 7.1 当前覆盖状态

已有 `React.memo` 的组件（21 个）：

| 组件 | 状态 |
|------|------|
| `ChatCard`, `ChatMessageList`, `ChatUserMessageRow`, `ChatAssistantMessageRow` | ✅ 已 memo |
| `DiffCard`, `OverviewCard`, `Sidebar`, `Workspace`, `CardPanel` | ✅ 已 memo |
| `AgentCard`, `AgentTeamBoard`, `ComposerField` | ✅ 已 memo |
| `GlobalDragOverlay`, `DropIndicatorLayer`, `ColumnResizeHandle` | ✅ 已 memo |
| `SidebarContextMenus`, `SettingsSchemaRenderer` | ✅ 已 memo |
| `ModelsSettingsTab` (内部子组件) | ✅ 部分 memo |

**缺少 `React.memo` 的关键组件**：

| 组件 | 行数 | 影响 | 优先级 |
|------|------|------|--------|
| `FilesCard` | 1,629 | 高——文件列表每次父级 re-render 全量重渲染 | P0 |
| `SettingsPanel` | ~800 | 中——设置面板 overlay 打开/关闭时触发 | P1 |
| `App` | 1,189 | 低——根组件，memo 价值有限 | P2 |
| `ChatEmptyState` | ~400 | 中——空态每次 prop 变化触发 | P1 |
| `ChatToolStack` | ~500 | 高——流式期间每条消息的工具栈可能被级联触发 | P0 |
| `WorkspaceChromeBars` | ~300 | 低——仅在 inset chrome 模式下使用 | P2 |

### 7.2 修复步骤

1. 为每个缺少 memo 的组件添加 `React.memo` 包裹
2. 检查组件 props 中的内联对象/函数，使用 `useMemo` / `useCallback` 稳定引用
3. 使用 React DevTools Profiler 录制典型操作（发送消息、切换会话、滚动），验证 re-render 计数

### 7.3 重点审查场景

| 场景 | 预期行为 | 当前风险 |
|------|---------|---------|
| 流式响应中，历史消息行 | 不 re-render | `ChatAssistantMessageRow` 已 memo，但 `msg` 对象引用可能变化 |
| 切换会话 | 仅活跃会话的组件 re-render | `sessionsById` 订阅器可能触发全局 |
| Sidebar 搜索输入 | 仅 Sidebar re-render | `searchInput` 在 App 层 state，可能导致整树 re-render |
| 窗口 resize | 仅尺寸相关组件 re-render | `useResizeFreeze` 已防护，但需验证 |

---

## 八、任务 G-7：Zustand Selector 精细化

### 8.1 当前状态

**好消息**：代码中没有 `useLayoutStore()` 裸调用（全量订阅），所有调用都使用了 selector：

```typescript
// 典型模式（正确）
const activeSessionId = useLayoutStore(s => s.activeSessionId);
const sidebarCollapsed = useLayoutStore(s => s.sidebarCollapsed);
```

**`useShallow` 使用情况**：
- ✅ `sessionStore.ts` — 已使用 `useShallow`（L122, L130, L143, L155）
- ✅ `workspaceStore.ts` — 已使用 `useShallow`（L51, L59）
- ❌ `layoutStore` 组件侧 — **未使用 `useShallow`**

### 8.2 layoutStore 问题 selector 审计

需要审查的模式：

```typescript
// App.tsx L168-176 — 复杂 selector（每次创建新闭包，但返回原始值）
const isRightSidebarCollapsed = useLayoutStore((s) => {
  const w = s.workspaces[s.activeWorkspaceIndex];
  if (!w) return true;
  const toolCol = w.columns.find(
    (c) => c.id !== 'col-chat' && !c.id.startsWith('col-chat-')
  );
  if (!toolCol) return true;
  return toolCol.widthRatio < 0.08;
});
// ⚠️ 返回 boolean 原始值，不需要 useShallow
// 但内部的 find() 每次调用都创建新闭包 — Zustand 的浅比较可正确处理
// 真正问题：workspaces 数组任何变化（包括非活跃 workspace）都会触发此 selector 重算
```

```typescript
// ChatMessageList.tsx L203-204 — 依赖 sessionsById 索引
const pinnedMessageIds = useLayoutStore(
  (s) => s.sessionsById[activeSessionId]?.pinnedMessageIds || EMPTY_PIN_IDS
);
// ✅ 正确：使用 EMPTY_PIN_IDS 常量避免空数组引用不稳定
```

### 8.3 修复清单

| 文件 | selector | 问题 | 修复 |
|------|----------|------|------|
| `App.tsx` L168 | `isRightSidebarCollapsed` | workspace 任意变化触发 | 添加 `activeWorkspaceIndex` 前置守卫 |
| `ChatCard.tsx` 多处 | 18 个独立 selector | 每个 selector 独立订阅 | 聚合为 `useChatCardSelectors()` 使用 `useShallow` |
| 组件内 `s.sessions` 引用 | 返回数组引用 | 数组变化触发全量 | 使用 `s.sessionsById[id]` 精确索引 |

---

## 九、任务 G-8：内存泄漏系统性审计

### 9.1 审计方法

```bash
# EventListener 配对率
$add = (Get-ChildItem -Recurse -Include *.ts,*.tsx c:\Software\conex\apps\crish-desktop\src | Select-String "addEventListener" | Measure-Object).Count
$rem = (Get-ChildItem -Recurse -Include *.ts,*.tsx c:\Software\conex\apps\crish-desktop\src | Select-String "removeEventListener" | Measure-Object).Count

# Timer 配对率
$set = (Get-ChildItem -Recurse -Include *.ts,*.tsx c:\Software\conex\apps\crish-desktop\src | Select-String "setInterval|setTimeout" | Measure-Object).Count
$clr = (Get-ChildItem -Recurse -Include *.ts,*.tsx c:\Software\conex\apps\crish-desktop\src | Select-String "clearInterval|clearTimeout" | Measure-Object).Count

# ResizeObserver 配对率
$obs = (Get-ChildItem -Recurse -Include *.ts,*.tsx c:\Software\conex\apps\crish-desktop\src | Select-String "\.observe\(" | Measure-Object).Count
$unobs = (Get-ChildItem -Recurse -Include *.ts,*.tsx c:\Software\conex\apps\crish-desktop\src | Select-String "\.unobserve\(|\.disconnect\(\)" | Measure-Object).Count
```

### 9.2 已知清理模式（正面示例）

| 文件 | 清理模式 | 状态 |
|------|---------|------|
| `useVirtualScroll.ts` L103-118 | 三个 rAF cleanup（scroll/estimated/actual） | ✅ 正确 |
| `ChatMessageList.tsx` L843-851 | ResizeObserver unobserve all on unmount | ✅ 正确 |
| `StreamRenderBuffer.ts` L129-139 | reset() 清除 rAF + pending | ✅ 正确 |
| `StreamRecovery.ts` L689-695 | stopScanning() clearInterval | ✅ 正确 |
| `beforeunloadFlush.ts` L100-101 | beforeunload + pagehide 注册（全局，不需 cleanup） | ✅ 正确 |

### 9.3 重点审查区域

| 区域 | 风险 | 审查方法 |
|------|------|---------|
| `App.tsx` 12 个 effect | 部分 effect 返回 Promise cleanup | 检查 `cleanupPromise.then` 模式（L460-463） |
| `useChatStream.ts` batcher refs | `registerStreamBatcher` 是否配对 `unregisterStreamBatcher` | 检查 useEffect cleanup |
| `daemonClient` WebSocket 监听器 | `onState()` 返回的 unsub 是否被调用 | 检查 effect cleanup |
| `ShortcutService` | `init() / destroy()` 配对 | `App.tsx` L662-666 已正确 cleanup |

---

## 十、Rust 后端性能基准

### 10.1 基准测试范围

| 模块 | 基准 | 目标 |
|------|------|------|
| `conex-stream` SSE 解析 | 1MB SSE 数据解析延迟 | ≤ 5ms |
| `sidecar/connection.rs` WS 消息序列化 | 1000 条消息序列化 | ≤ 10ms |
| `sidecar/run_stream.rs` 流式中继 | 100 token/s 吞吐延迟 | ≤ 1ms/token |
| `fs_commands.rs` 文件读取 | 10MB 文件读取 + 编码检测 | ≤ 50ms |

### 10.2 基准测试框架

```rust
// crates/conex-stream/benches/parser_bench.rs
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_sse_parse_1mb(c: &mut Criterion) {
    let data = include_bytes!("fixtures/anthropic_1mb.sse");
    c.bench_function("sse_parse_1mb", |b| {
        b.iter(|| {
            let mut parser = AnthropicMessagesStreamParser::new();
            parser.feed(data).unwrap();
            parser.finish();
        })
    });
}

criterion_group!(benches, bench_sse_parse_1mb);
criterion_main!(benches);
```

### 10.3 CI 集成

```bash
cargo bench -- --save-baseline main
# PR 中比较
cargo bench -- --baseline main
```

回归阈值：±10% 自动阻止合并。

---

## 十一、多 Agent 并行分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| **G1** | G-1 (FilesCard 虚拟滚动), G-2 (onFrame 竞态), G-5 (markdownRender 主线程路径) | `FilesCard.tsx` 内联 hook, `useChatStream.ts` onFrame 路径, `markdownRender.ts` 调用方迁移 |
| **G2** | G-6 (React.memo 审计), G-7 (Zustand selector 精细化) | 所有组件文件的 memo/selector 修改 |
| **G3** | G-3 (WorkerPool 优先级堆), G-4 (Pretext Worker 卸载) | `worker-pool.ts`, `ChatMessageList.tsx` Pretext effect |
| **G4** | G-8 (内存泄漏审计) + Rust 基准 | 全量 EventListener/Timer 配对审计 + `crates/conex-stream/benches/` |

**依赖关系**：G1/G2/G3/G4 完全并行，无文件冲突。

---

## 十二、验收标准

| 编号 | 检查项 | 通过条件 | 验证方法 |
|-----|--------|---------|---------|
| V-1 | FilesCard 内联虚拟滚动删除 | 零内联 `useVirtualScroll` 定义 | `grep -n "function useVirtualScroll" FilesCard.tsx` 无结果 |
| V-2 | onFrame 竞态修复 | session 切换后流式帧不写入旧 session | 竞态单元测试 |
| V-3 | WorkerPool enqueue 复杂度 | O(log N) | 代码审查 + 50 任务微基准 |
| V-4 | Pretext Worker 卸载 | 主线程零 `layout()` 调用 | `grep -n "layout(prepared" ChatMessageList.tsx` 无结果 |
| V-5 | markdownRender 同步调用消除 | 组件侧零 `parseMarkdownToHtml` 同步调用 | `grep -rn "parseMarkdownToHtml(" components/` 仅匹配 `Async` 版 |
| V-6 | React.memo 覆盖 | `FilesCard`, `ChatToolStack`, `ChatEmptyState`, `SettingsPanel` 已 memo | 代码审查 |
| V-7 | Zustand selector 精细化 | layoutStore 组件侧无复杂对象返回 selector | 代码审查 |
| V-8 | EventListener 配对率 | 100% 配对（或有明确注释说明全局注册原因） | 自动化脚本审计 |
| V-9 | Timer 配对率 | 100% 配对 | 自动化脚本审计 |
| V-10 | 流式响应 FPS | ≥ 58 fps（100 token/s） | React DevTools Profiler |
| V-11 | 1000 消息滚动 FPS | ≥ 58 fps | React DevTools Profiler |
| V-12 | 全量构建 | `npm run build` + `cargo build` 零错误 | CI |
| V-13 | 全量测试 | `npm test` + `cargo test` 零回归 | CI |

---

## 十三、性能监控持续化

### 13.1 前端性能仪表盘

利用已有的 `telemetry` 基础设施，注入以下持续监控点：

| 监控点 | 采集位置 | 指标 |
|--------|---------|------|
| 虚拟滚动帧率 | `useVirtualScroll.onScroll` | P95 帧间隔 |
| 流式渲染帧预算 | `StreamRenderBuffer.recordRenderDuration` | EMA 帧耗时 |
| Worker 队列深度 | `WorkerPool.getMetrics()` | 队列峰值 + 繁忙率 |
| Pretext 估算延迟 | `usePretextHeights` | 批次完成总耗时 |
| 背压触发频率 | `StreamRecovery.noteRenderBuffer` | pause/resume 次数 |

### 13.2 回归检测阈值

| 指标 | 警告阈值 | 阻止阈值 |
|------|---------|---------|
| 滚动 P95 帧间隔 | > 18ms | > 25ms |
| 流式 EMA 帧耗时 | > 12ms | > 16ms |
| Worker 队列峰值 | > 30 | > 100 |
| 首屏 bundle 大小 | 增长 > 5% | 增长 > 15% |

---

## 十四、风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|---------|
| FilesCard 虚拟滚动迁移导致文件列表闪烁 | 中 | 中 | 分阶段迁移：先将内联版替换为全局版的固定高度模式 |
| onFrame 竞态修复引入新闭包泄漏 | 低 | 高 | 使用 Ref 而非闭包捕获 session ID |
| WorkerPool 堆替换改变任务调度顺序 | 低 | 中 | 堆实现严格按 `priority + createdAt` 排序，保持 FIFO 语义 |
| Pretext Worker 卸载因字体序列化限制失败 | 中 | 中 | 备选方案：主线程预计算字体度量表后传入 Worker |
| markdownRender 主线程路径消除遗漏 | 中 | 中 | `grep` 审计所有 `parseMarkdownToHtml` 同步调用点 |
| 内存泄漏审计覆盖不完整 | 低 | 低 | 审计脚本自动生成报告，标记所有未配对注册/清理 |
| React.memo 添加后 props 引用不稳定导致 memo 失效 | 中 | 中 | 使用 `useCallback`/`useMemo` 稳定内联函数与对象引用 |
| Zustand selector 精细化后订阅器触发频率不降反升 | 低 | 低 | 使用 `useShallow` + 原子 selector 避免过度订阅 |
