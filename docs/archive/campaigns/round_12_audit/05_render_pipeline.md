# 流式渲染管线性能审查报告

## 全链路层级与延迟估计

```
Token到达
  │
  ▼  [Layer 1]  onChunk → pending[] push
  │              ~0.001ms (per chunk, O(1) array push)
  │
  ▼  [Layer 2]  requestAnimationFrame → flushFrame()
  │             帧预算 12ms, maxBytesPerFrame=8192
  │             含 IncrementalMarkdownBridge.push() 主线程 markdown 增量解析
  │             ~0.5-5ms (取决于 delta 大小和 markdown 复杂度)
  │
  ▼  [Layer 3]  onFrame → updateMessageText(store → zustand setState)
  │             ~0.1-1ms (zustand 写 + React 调度入队)
  │
  ▼  [Layer 4]  React re-render → MessageContent → useAsyncMarkdownHtml
  │             ⚠  5-50ms+ — 瓶颈层 (见下文"重复解析")
  │
  ▼  [Layer 5]  requestIdleCallback → DOM  patch (innerHTML / applyDomPatches)
  │             延迟到空闲期执行, 不阻塞主线程交互
  │
  ▼
  DOM 更新
```

**端到端可见延迟**: 从 token 到达 `onChunk` 到 DOM 变更，最快约 ~16ms (一帧 rAF)，但通常因 markdown 重新解析需 20-60ms。高速率下 (500+ tok/s) 积压时，`maxBacklogBytes` 降级会跳过中间帧，用户感知为"跳字"。

---

## 关键检查点结果

### MR-1: StreamRenderBuffer.maxBacklogBytes ✅ 已实现

`StreamRenderBuffer.ts:49` — `private readonly maxBacklogBytes: number;`  
默认值 32768 (约 8K tokens / ~2 秒 @500tok/s)。  
`flushFrame():244` — 当 `bufferedLength() > maxBacklogBytes` 时跳过 `onFrame` 回调，仅累加 pending。`onComplete`/`flush(true)` 强制路径不受降级影响。

**评估**: 阈值合理。但降级时用户看不到中间文字，只有跳变——这是设计取舍，建议在降级发生时在 store 置一个 flag 让 UI 显示"加速中..."提示。

### MR-2: useStreamingText 是否同时服务两条流 ❌ 不一致

`useStreamingText` (`hooks/useStreamCallbacks.ts`) 仅服务于 `useAgentStream` (子 agent 面板)。  
主聊天流 (`hooks/chat-stream/useStreamCallbacks.ts`) 内联创建 `new StreamRenderBuffer()` 并自建 `onFrame`，不通过 `useStreamingText`。

**问题**: 两套管线配置不同：
- 主聊天流: 使用 `StreamRenderBuffer` 默认参数 (12ms/8192/32768)
- Agent 流: 可使用 `useStreamingText(options)` 传入自定义帧预算/字节限制

建议统一入口，避免两处各自维护 buffer 逻辑。

### MR-3: useAgentStream onChunk 直写修复 ✅ 已修复

`useAgentStream.ts:152-153`:
```ts
onChunk: (c: string) => {
  streamRun?.pushChunk(c);  // 经 StreamRenderBuffer 分帧
```
不再使用 `pa((m) => { m.text = c })` 直接突变。  
`pushChunk` → `renderBufferRef.current.push(chunk)` → rAF 分帧 → `onFrame` → `onTextRef.current` → `pa((m) => { m.text = text })`。

正确绕过了 React 批处理，避免了单帧高频写入 store。

### MR-4: MessageContent innerHTML 被 requestIdleCallback 包裹 ✅ 已实现

`MessageContent.tsx:93-98` (首次):
```tsx
requestIdleCallback(() => {
  containerRef.current.innerHTML = wrappedHtml;
}, { timeout: 100 });
```
`MessageContent.tsx:101-105` (增量):
```tsx
requestIdleCallback(() => {
  const patches = chunkUpdatesToDomPatches(...);
  applyDomPatches(containerRef.current, patches);
}, { timeout: 200 });
```

两处均使用 `requestIdleCallback`，避免阻塞主线程。增量路径使用 `outerHTML`/`insertAdjacentHTML` 而非全文 `innerHTML`，布局抖动最小。

### MR-5: useChatCardSelectors useShallow 包装 ✅ 已覆盖

- `appSettings` —  `s(useShallow((st) => st.appSettings))` ✅
- `diffFiles` —  `s(useShallow((st) => st.diffFiles))` ✅
- `composerDrafts` — `s(useShallow((st) => st.composerDrafts))` ✅

**其他 selector**: `permissionMode`, `planModeEnabled`, `planApproved`, `mainSurface` 均为原始类型 / 函数引用，无需 `useShallow`。

---

## 性能瓶颈定位

### 🔴 瓶颈 1 (严重): 重复 markdown 解析 — 100% 浪费

**路径对比**:

| 阶段 | 解析内容 | 位置 |
|------|---------|------|
| StreamRenderBuffer 分帧 | `buffer.bridge.push(fullText)` → `RenderFrame.html` | `StreamRenderBuffer.ts:241` |
| onFrame 回调 | **仅写入 `frame.full` (纯文本)**, `frame.html` 被丢弃 | `useStreamCallbacks.ts:153` |
| MessageContent 渲染 | `parseMarkdownToHtmlAsync(text)` 重新解析全文 | `MessageContent.ts:43` |

`StreamRenderBuffer` 的 `IncrementalMarkdownBridge` 已做增量解析并生成 HTML，但 `onFrame` 只使用了 `frame.full` 文本写入 store，`frame.html` 和 `frame.chunkUpdates` 被完全丢弃。  
`MessageContent` 收到纯文本后，用 `parseMarkdownToHtmlAsync` **重新解析全文**——不是增量，且走 Worker 异步线程（仍有调度开销）。

**影响**: 每帧多出 5-50ms 的 markdown 解析成本，约为管线总开销的 60-80%。

**改进建议**: 将 `RenderFrame.html` 或 `chunkUpdates` 存入 store 和消息数据中，让 `MessageContent` 直接消费预解析 HTML 或 DOM patch 指令，绕过二次解析。

### 🟡 瓶颈 2: 主线程 markdown 解析占用帧预算

`IncrementalMarkdownBridge.push()` 在主线程 `flushFrame()` 内同步执行，占用 12ms 帧预算的一部分。复杂 markdown (嵌套代码块、大表格) 可能导致单帧超预算，推迟后续 frame 调度。

**改进建议**: 考虑将增量 markdown 解析移到 Worker (`markdownRenderAsync` 已有 worker 基础)，或为复杂 markdown 设置更小的 `maxBytesPerFrame` 以降低单帧负载。

### 🟡 瓶颈 3: 大块无换行代码的分割不可靠

`flushFrame()` 在超过 `maxBytesPerFrame` (8192) 时尝试在 `\n` 边界分割 (`lastIndexOf('\n')`)。当大块代码块无换行时 (如 minified JSON 或 base64)，回退到按字节截断。这可能在多字节 UTF-8 字符中间切开，导致渲染时出现乱码。

**改进建议**: 改用 `TextDecoder` 感知字符边界，或至少检查截断点是否为合法 UTF-8 起始字节。

### 🟢 瓶颈 4: 代际计数器正确防止跨 session 写

`useStreamCallbacks.ts:141-142, 152`:
```ts
const myGen = (generationMapRef.current.get(sid) ?? 0) + 1;
// 在 onFrame 内:
if (myGen !== generationMapRef.current.get(sid)) return;
```

每次新 run 递增 `myGen`，旧 buffer 的 `onFrame` 闭包捕获的是旧 `myGen`，切换 session 后立刻失效。**代际守卫正确**，不存在旧 buffer 继续写入的安全问题。

但注意 `generationMapRef` 是 Map<string, number>，长期运行后不会清理已关闭 session 的条目——有内存泄漏风险，但量级很小 (每个 session 一个数字键)。

---

## 死代码发现

### 1. textBatcherRef 作为 buffer 空时的排障路径 — 低概率路径

`useStreamCallbacks.ts:376-378`:
```ts
if (renderBufferRef.current) {
  renderBufferRef.current.push(chunk);
  ...
} else {
  textBatcherRef.current?.push(streamBatchKey(sid, assistantMsgId), streamedFullText);
}
```

`renderBufferRef.current` 在 `runStreamingAssistant` 入口处被赋值 (line 138)，到 `onChunk` 被调用前不可能为 null (除非极端竞态)。这个 fallback 路径实际上从不会被触发。但作为防御性编程保留也不算错。

### 2. `useStreamingText` 在 agent stream 中不使用 textBatcher

`useStreamingText.startRun()` 的 `onFrame` 直接调用 `onTextRef.current?.(frame.full)`，跳过了 `textBatcherRef` (StreamTextBatcher)。`textBatcherRef` 只在 `pushChunk` 的 fallback 路径使用 (`renderBufferRef.current` 为 null 时)。这意味着 agent stream 的 text batcher 配置 (`textBatcherIntervalMs`, `textBatcherMaxChars`) 实际上永不生效。

---

## 改进建议汇总

| # | 优先级 | 改进内容 | 预期收益 |
|---|--------|---------|---------|
| 1 | **P0** | `updateMessageText` 同时存储 `RenderFrame.html` 或 `chunkUpdates`；`MessageContent` 直接消费预解析 HTML | 消除重复 markdown 解析，节省每帧 **5-50ms** |
| 2 | **P1** | 统一两套渲染管线入口 (主聊天流 vs agent 流) | 减少维护成本，确保参数一致 |
| 3 | **P1** | 大块无换行文本的 UTF-8 安全截断 | 避免渲染乱码 |
| 4 | **P2** | Worker 化增量 markdown 解析 | 释放主线程帧预算 |
| 5 | **P2 | 积压降级时 UI 显示提示 | 改善用户对"跳字"的感知 |
| 6 | **P3** | 清理 `useStreamingText` 中无效的 `textBatcherRef` 代码 | 可读性 |
| 7 | **P3** | `generationMapRef` 添加 session 关闭时的条目清理 | 防微量内存泄漏 |

---

## 总结

渲染管线核心设计健康：代际计数器 ✅、帧预算控制 ✅、requestIdleCallback 延迟 DOM 更新 ✅、useShallow 避免不必要重渲染 ✅。  

**最大问题**是 `RenderFrame` 的 HTML 预解析结果被丢弃导致的重复 markdown 解析 (P0)。若能打通"预解析 HTML → 直接消费"的通道，可减少 60-80% 的渲染管线开销。
