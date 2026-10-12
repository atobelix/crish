# 07 — 消息行渲染与 Markdown 封口快照专项审计报告

> **审计角色**：消息行渲染与 Markdown 封口快照专项审计员  
> **审计范围**：工作区未提交改动（`git diff` + 未跟踪新文件）中涉及消息行渲染、Markdown 封口过渡快照锁存、增量 DOM 协调及流式缓冲中枢的 9 个核心文件及其上下游调用链  
> **核心问题**：排查未提交改动是否导致消息内容渲染为空白（`""` / 空 DOM）、封口快照锁死或未捕获异常触发 `ErrorBoundary` 回退

---

## 一、执行结论先行（Executive Summary）

1. **核心问题 1（非流式历史静态消息 `isStreaming === false` 的渲染路径）**：
   - 历史消息通过 `MessageContent.tsx:504` → `ProcessItemRenderer.tsx:108` → `StreamingMarkdownView.tsx:79` 走冷路径 `IncrementalBlockSplitter.split(fullText)`，所有分块均以 `isSealed = true, isStreaming = false` 传入 `MarkdownBlockItem.tsx`。
   - 在 `MarkdownBlockItem.tsx:118-174` 中，历史消息不激活 `useStreamingMarkdownHtml`，`lockedUnitsRef.current` 保持 `null`；通过 `useAsyncMarkdownHtml(text, priority)` 结合同步 `getMarkdownHtmlCache(text)` 获取 HTML。首帧若缓存未命中则 `renderedHtml = ''`，待异步 IPC `core_md_render`（或 Worker `markdown.render`）返回后触发重渲染更新 `sealedHtml`，最终由 `ReconciledMarkdownHtml.tsx:132` 调用 `reconcileUnits(container, splitHtmlIntoUnits(html))` 挂载完整 DOM。

2. **核心问题 2（未提交的「Markdown 封口过渡快照锁存」与「流式批合并」改动是否阻断历史静态消息或清空 DOM）**：
   - **对非流式历史静态消息（`isStreaming === false`）**：未提交的封口快照锁存（`lockedUnitsRef`）与 Zero-Collapse Guard（`ReconciledMarkdownHtml.tsx:121-127`）**不会**阻断历史静态消息的 `renderedHtml` 获取，也**不会**在常规历史消息挂载时锁死为空快照或清空已渲染 DOM。唯一会使历史消息在 `MarkdownBlockItem` 层保持空白的前提是底层 `parseMarkdownToHtmlAsync`（Tauri IPC `core_md_render` 与 Worker Pool `markdown.render`）双双失败或返回空串——因为 `MarkdownBlockItem.tsx:147` 忽略了 `useAsyncMarkdownHtml` 返回的 `failed` 状态，未提供类似 `MarkdownDocumentView.tsx:341` 的 `<pre>` 纯文本回退。
   - **对流式消息、封口过渡与跨块复用**：本次未提交改动中存在 **3 处真实逻辑缺陷**，会导致**流式正文/思考摘要丢内容（甚至锁存为空壳 `<p class="md-p"></p>`）**、**StrictMode/并发渲染下跨块复用残留旧 DOM** 以及**会话流式缓冲注册表失效**：
     1. **[高危 · 流式丢字与空壳锁存]** `apps/crish-desktop/src/api/markdownRenderAsync.ts:173, 194-243`：将 `session.getRevision() !== advance.revision` 替换为无条件自增的 `advanceBatchIdRef.current !== currentBatchId`。由于 `IncrementalMarkdownSession` 是增量状态机（每次 `advance` 仅返回新增 delta 的 `textParts`），一旦后续高频 tick 为不产生 `textParts` 的字符（如 `\n`、代码块围栏、行尾潜在标记 `!*_[~`）或后续短片段命中同步缓存先于前序异步 IPC 返回，前序尚未完成的 `Promise.all(partPromises)` 回调会被 `advanceBatchIdRef.current !== currentBatchId` **静默丢弃**，不再更新 `unitsRef.current` 也不触发重渲染；若此刻进入封口（`SEALING_PENDING`），`lockedUnitsRef` 将直接锁存尚未填充内联文本的空壳 `<p class="md-p"></p>`。
     2. **[中危 · Render 阶段副作用污染 Ref]** `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:94-111`：在组件渲染函数体（Render Phase）内直接执行 `streamingTextRef.current = text`（第 `102` 行）。在 React 18 StrictMode 双调用或并发渲染中断重跑时，第二次执行函数体看到 `streamingTextRef.current === text`，导致 `isContinuation` 被错误判定为 `true`（`allowEmptyClear = false`、`hadStaleStreamingUnits = false`），破坏跨块复用时的旧 DOM 清空逻辑。
     3. **[中低危 · 流式缓冲注册表空转与入口分叉]** `apps/crish-desktop/src/hooks/chat-stream/useChatStream.ts:50-62`：在挂载 `useEffect` 中读取 `renderBufferRef.current` 并调用 `registerSessionRenderBuffer`，但挂载时 `renderBufferRef.current` 恒为 `null`（真正的 `new StreamRenderBuffer()` 在 `useRunStreamingAssistant.ts:153-154` 发送消息时才创建且未调用注册），导致 `sessionStreamManager.ts` 中的 `sessionRenderBuffers` 恒为空表。

3. **核心问题 3（是否存在未捕获异常触发外层 `ErrorBoundary` 导致消息列表或面板回退为空）**：
   - **不存在静默回退为空的 ErrorBoundary**：`MessageVirtualizer.tsx:416, 447` 的行级 `<AppErrorBoundary variant="minimal">` 与 `TreeLeafPanel.tsx:412` 的面板级 `<AppErrorBoundary compact>` 在捕获异常时均会渲染可见的告警 UI（`"此区域出错"` 或 `"面板 [chat] 渲染异常"`），不会渲染为空白 `null`。
   - **被审计的 9 个文件在 WebView2 运行时无未捕获同步渲染异常**。
   - **跨层关联重要发现**：若画面表现为「整个聊天面板显示为空白欢迎页（无消息列表且无报错）」，根因不在 `MarkdownBlockItem` / `ErrorBoundary`，而在同批未提交改动中的 `TreeLeafPanel.tsx:88-91` 与 `treeLeafPanelModel.ts:36-59`——`isLeafInDraftMode(leaf)` 将 `leaf.activeTabId === '' || leaf.tabs.length === 0` 强制判定为草稿态，并把 `effectiveSessionId = "__pending_draft__:<leafId>"` 注入 `<LeafScopeProvider>`，从而覆盖了全局 `sessionStore.activeSessionId`，导致 `ChatCard` 渲染空会话落地页。

---

## 二、逐文件未提交改动审查清单（9 个目标文件）

| 序号 | 文件路径                                                                         | 状态          | 改动摘要                                                                                                                                                                                       | 致空/崩溃风险评级                                                                                                           |
| :--- | :------------------------------------------------------------------------------- | :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| 1    | `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`       | 已修改 (`M`)  | 新增 `streamingTextRef`、`lockedUnitsRef`、4 态封口状态机（`STREAMING_ACTIVE` / `SEALING_PENDING` / `SEALED_READY` / `EMPTY_NON_CONT`）、`allowEmptyClear` 与 `effectiveIncrementalUnits` 透传 | **中危**（Render 阶段写 Ref 导致 StrictMode 下 `isContinuation` 误判；忽略 `useAsyncMarkdownHtml.failed`）                  |
| 2    | `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx`          | 已修改 (`M`)  | 新增 `allowEmptyClear` 属性、`incrementalModeRef` 模式切换清空、Zero-Collapse Guard（`!html.trim() && !allowEmptyClear && container.childNodes.length > 0` 拒绝清空）                          | **低危**（受 `MarkdownBlockItem` 的 `allowEmptyClear` 驱动，若上游误判 `isContinuation=true` 会阻断清空旧块）               |
| 3    | `apps/crish-desktop/src/api/markdown/unitReconciler.ts`                          | 已修改 (`M`)  | 重写 `reconcileUnits` 为单向 DOM 游标（`cursor = container.firstChild`）原地比对/替换/追加/尾部裁剪算法                                                                                        | **无异常**（游标始终为 `container` 直接子节点，无 `DOMException` 风险）                                                     |
| 4    | `apps/crish-desktop/src/api/markdownRenderAsync.ts`                              | 已修改 (`M`)  | `useStreamingMarkdownHtml` 引入 `advanceBatchIdRef` 替代 `session.getRevision()` 检查，并在 `unitsRef.current = session.getUnits()` 后调用 `setRenderVersion`                                  | **高危**（增量 `advance` 下 `advanceBatchIdRef` 覆盖会导致在途异步 `textParts` 解析完成时被丢弃，造成流式漏字或空壳 `<p>`） |
| 5    | `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx`            | 已修改 (`M`)  | 引入 `useLeafScope()` 获取 `leafId`；以 `${leafId}:${filePath}` 构造 `scopedScrollKey` 读写 `scrollPositions` Map                                                                              | **安全**（`useLeafScope` 有默认 fallback `DEFAULT_LEAF_SCOPE`，不会抛错）                                                   |
| 6    | `apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx` | 已修改 (`M`)  | 删除内部针对 `.thinking-block-wrapper` 的私有 `ResizeObserver` 高度测量 `useEffect`                                                                                                            | **安全/正向修复**（消除了与虚拟列表 `rowMeasureRef` 的双重测高冲突）                                                        |
| 7    | `apps/crish-desktop/src/components/chat-message-row/chatMessageRowUtils.ts`      | 已修改 (`M`)  | 导出 `isMessageEffectivelyEmpty`；将 `hasVisibleAssistantOutput` 改为委托调用 `isMessageEffectivelyEmpty`                                                                                      | **安全**（纯函数等价重构，逻辑与原实现完全一致）                                                                            |
| 8    | `apps/crish-desktop/src/hooks/chat-stream/sessionStreamManager.ts`               | 未跟踪 (`??`) | 新增模块级 `sessionBatchers` 与 `sessionRenderBuffers` 注册表及 `flushAndClearSessionStream` 等管理函数                                                                                        | **低危**（`sessionRenderBuffers` 因上游未在创建处注册而实际为空）                                                           |
| 9    | `apps/crish-desktop/src/hooks/chat-stream/useChatStream.ts`                      | 未跟踪 (`??`) | 从 `chat-stream/index.ts` 拆分出 `useChatStream` 主 Hook，新增 `registerSessionBatcher` / `registerSessionRenderBuffer` 注册 `useEffect`                                                       | **中低危**（挂载时 `renderBufferRef.current` 为 `null` 导致注册失效；与 `hooks/useChatStream.ts` 形成双入口分叉）           |

---

## 三、核心问题 1 深度追踪：非流式历史消息（`isStreaming === false`）的完整渲染路径

当用户打开或切换到一个已有历史消息的会话时，非流式历史消息从数据进入到最终挂载 DOM 的完整链路如下：

### 3.1 上游消息过滤与分块（`ChatMessageRow` → `StreamingMarkdownView`）

1. **空消息守卫**：
   - 在 `apps/crish-desktop/src/components/ChatMessageRow.tsx:76-82`，对非流式 assistant 消息（`!isStreaming && message.role === 'assistant'`）调用 `isMessageEffectivelyEmpty(message)`（定义于 `chatMessageRowUtils.ts:248-269`）。
   - 只要 `message.content.trim()` 非空、`reasoning` 非空、`toolCalls` 非空、`parts` 非空或有错误文本，`isMessageEffectivelyEmpty` 均返回 `false`，正常渲染 `<ChatAssistantMessageRow>`。
2. **时间线构建与段落分发**：
   - `ChatAssistantMessageRow.tsx:206-218` 渲染 `<MessageContent>`（`MessageContent.tsx:423-530`）。
   - `MessageContent.tsx:136-163` 调用 `buildAssistantTimelineCached(message)` 生成 `timelineItems`，并在第 `497-513` 行通过 `<ProcessItemRenderer>` 渲染每个条目。
   - 对于正文段落（`item.kind === 'content'`），`ProcessItemRenderer.tsx:104-115` 渲染 `<StreamingMarkdownView content={item.text} isStreaming={false} messageId={message.id} priority="high" />`。
3. **块级切分（`useStreamingBlocks`）**：
   - `StreamingMarkdownView.tsx:79` 调用 `useStreamingBlocks(rawContent, false, messageId)`（定义于 `apps/crish-desktop/src/hooks/useStreamingBlocks.ts:59-154`）。
   - 因 `isStreaming === false`，走第 `141-153` 行的静态冷路径：`IncrementalBlockSplitter.split(fullText)`，返回的每个 `BlockDescriptor` 均满足 `isSealed: true`。
   - `StreamingMarkdownView.tsx:105-116` 遍历 `blocks`，为每个块渲染：
     ```tsx
     <MarkdownBlockItem
       key={`${messageId}-blk-${blk.index}`}
       text={blk.text}
       isSealed={true}
       isLast={idx === blocks.length - 1}
       isStreaming={false}
       priority={priority}
     />
     ```

### 3.2 `MarkdownBlockItem.tsx` 内部状态机（当 `isStreaming === false, isSealed === true`）

在 `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:86-205` 中，各状态变量在历史静态消息下的求值如下：

1. **延续性判定（第 `94-112` 行）**：
   - 首次挂载时 `streamingTextRef.current` 初始为 `''`（第 `92` 行）。
   - `isSameBlockContinuation('', text)`（第 `48-55` 行）：当 `!prevText`（`prevText === ''`）时，返回 `Boolean(nextText)`，即对于非空 `text` 返回 `true`。
   - `hadStaleStreamingUnits` = `!isContinuation && streamingUnitsRef.current !== null && streamingUnitsRef.current.length > 0` = `false`。
   - `allowEmptyClear` = `!isContinuation` = `false`。
2. **流式与锁存分支短路（第 `118-136` 行）**：
   - `isActiveTail` = `isStreaming && isLast && !isSealed` = `false`。
   - `useStreamingMarkdownHtml(isActiveTail ? text : '', isActiveTail)`：因 `enabled = false`，在 `markdownRenderAsync.ts:178-190` 立即重置会话并返回 `liveHtml = ''`，`streamingUnitsRef.current = null`。
   - `lockedUnitsRef.current`：因 `streamingUnitsRef.current` 为 `null`，第 `128-133` 行不触发锁存，`lockedUnitsRef.current` 保持 `null`。
3. **异步封口解析与 LRU 缓存查询（第 `139-174` 行）**：
   - `isEffectivelySealed` = `true`。
   - 调用 `useAsyncMarkdownHtml(text, priority)`（`MarkdownBlockItem.tsx:147-150`）与 `getMarkdownHtmlCache(text)`（第 `151-154` 行）：
     - **情况 A（同步 LRU 缓存命中）**：`cachedHtml` 为非空 HTML 字符串 → 首帧 `renderedHtml = cachedHtml`，`isSealingPending = false`，状态机直接进入 `SEALED_READY`，首帧同步完成 DOM 渲染。
     - **情况 B（同步 LRU 缓存未命中，首次打开会话的常见路径）**：
       - **挂载首帧（Render #1）**：`useAsyncMarkdownHtml` 内部 `const [html, setHtml] = useState('')`（`markdownRenderAsync.ts:99`）返回 `sealedHtml = ''`；`cachedHtml` 为 `undefined`。
       - 由于 `lockedUnitsRef.current === null`，第 `160` 行 `isSealingPending` 为 `false`，状态机走第 `165-174` 行：
         - `renderedHtml = sealedHtml || cachedHtml || liveHtml` = `''`
         - `effectiveIncrementalUnits = undefined`
         - `renderState = 'SEALED_READY'`（注：此处状态名虽叫 `SEALED_READY`，但实际上异步 `sealedHtml` 仍在 flight 中，当前帧 `renderedHtml` 为 `''`）。
       - **异步完成帧（Render #2）**：首帧 commit 后，`useAsyncMarkdownHtml` 的 `useEffect`（`markdownRenderAsync.ts:104-148`）调用 `parseMarkdownToHtmlAsync(markdown, priority)`：
         1. 先调 `rustCore.mdRender(markdown)`（Tauri IPC `core_md_render`）；
         2. 若 IPC 不可用或抛错返回 `null`，回退调用 Worker Pool `workerPool.execute('markdown.render', { markdown }, priority)`；
         3. 拿到安全 HTML 后写入 `setMarkdownHtmlCache(markdown, result)`，并调用 `setHtml(result)`。
       - `setHtml(result)` 触发 `MarkdownBlockItem` 第二次渲染，此时 `sealedHtml = result`（非空），`renderedHtml = result`。

### 3.3 `ReconciledMarkdownHtml.tsx` 与 `unitReconciler.ts` 的 DOM 挂载路径

在 `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx:48-137` 的 `useLayoutEffect` 中：

1. **Render #1（当缓存未命中、`html === ''` 时）**：
   - `hasIncrementalUnits = false`，进入 `else` 分支（第 `117-133` 行）。
   - `incrementalModeRef.current` 为 `false`。
   - Zero-Collapse Guard（第 `121-127` 行）判断 `if (!html.trim())`：由于新建 `div` 容器 `container.childNodes.length === 0`，`!allowEmptyClear && container.childNodes.length > 0` 为 `false`，不 return，向下执行 `reconcileUnits(container, [])`，容器保持为空。
2. **Render #2（当异步 `html` 解析完成、传入非空 `html` 时）**：
   - `useLayoutEffect` 因依赖项 `html` 变化重新执行。
   - `!html.trim()` 为 `false`，直接执行第 `132` 行：`reconcileUnits(container, splitHtmlIntoUnits(html))`。
   - `splitHtmlIntoUnits(html)`（`unitSplitter.ts:66-125`）利用模块级复用的 `<template>` 解析顶层块级元素并生成 `RenderUnit[]`。
   - `reconcileUnits(container, units)`（`unitReconciler.ts:97-172`）从 `cursor = container.firstChild`（此时为 `null`）开始遍历 `units`，命中第 `119-122` 行 `if (!cursor) { container.appendChild(createUnitNode(unit)); continue; }`，将所有块级 DOM 节点挂载到容器中。

---

## 四、核心问题 2 深度排查：未提交改动中的真实缺陷与边界推演

### 4.1 缺陷 1（高危）：`useStreamingMarkdownHtml` 中 `advanceBatchIdRef` 破坏增量状态机契约，导致流式丢内容与空壳快照锁存

- **代码位置**：`apps/crish-desktop/src/api/markdownRenderAsync.ts:173, 194-243`
- **改动对比（`git diff`）**：
  - **改动前**：仅在 `advance.textParts.length > 0` 发起异步解析后，于 `.then()` 中检查 `if (!anyResolved || session.getRevision() !== advance.revision) return;`（且 `session.revision` 仅在 `session.reset()` 时递增，同一流式会话内 `advance()` 不会递增 `revision`）。
  - **改动后**：新增 `const advanceBatchIdRef = useRef(0);`（第 `173` 行），並在每次 `useEffect` 触发时**无条件前置递增**：
    ```ts
    // apps/crish-desktop/src/api/markdownRenderAsync.ts:194-205
    const session = sessionRef.current;
    const currentBatchId = ++advanceBatchIdRef.current;
    const advance = session.advance(markdown);

    if (advance.textParts.length === 0) {
      if (advance.structureChanged) {
        unitsRef.current = session.getUnits();
        setHtml(session.toHtml());
        setRenderVersion((v) => v + 1);
      }
      return;
    }
    ```
    随后在第 `234-242` 行：
    ```ts
    void Promise.all(partPromises).then(() => {
      if (!anyResolved || advanceBatchIdRef.current !== currentBatchId) {
        return;
      }
      unitsRef.current = session.getUnits();
      setHtml(session.toHtml());
      setRenderVersion((v) => v + 1);
    });
    ```
- **根因机理（为什么会丢内容/变空白）**：
  1. `IncrementalMarkdownSession.advance(fullMarkdown)`（定义于 `IncrementalMarkdownSession.ts:53-102`）是一个**有状态的增量消费器**：它通过 `this.consumedLength` 只消费本次新增的 `delta = fullMarkdown.slice(this.consumedLength)`，并且**只返回本次 `delta` 触发的 `textParts`**，而不会重新返回上一拍已经消费过的 `textParts`。
  2. 同时，当 `consumeParagraph`（`IncrementalMarkdownConsume.ts:183-214`）首次遇到新段落时，会先同步向 `this.units` 推入一个**空壳单元** `{ key: 'u-0', tag: 'p', html: '<p class="md-p"></p>' }`，等待异步 `partPromises` 完成后通过 `session.resolveTextPart` 把 `<p class="md-p">实际内容</p>` 写回 `this.units`，再靠 `.then()` 里的 `unitsRef.current = session.getUnits(); setRenderVersion(v => v + 1)` 触发 React 重渲染。
  3. **致命竞态场景 A（空 `textParts` tick 截胡）**：
     - **Tick 1**（`currentBatchId = 1`）：流式推入一段正文 `"你好，这是一段测试"`。`session.advance` 生成 `textParts`（1 个段落），向 `this.units` 放入空壳 `<p class="md-p"></p>`，并发起异步 IPC `core_md_render`（耗时约 1~5ms）。
     - **Tick 2**（`currentBatchId = 2`，在 Tick 1 的 IPC 返回前到达）：流式推入的下一个 token 恰好不产生 `textParts`——例如：
       - 单独的换行符 `\n`（`consumeBlankLines` 只设 `structureChanged = true`，`textParts` 为空）；
       - 行尾出现潜在 Markdown 标记字符 `!*_[~` 或反引号（`IncrementalMarkdownConsume.ts:190` 的 `isPotentialMarkerAtEnd` 暂停消费，返回空 `textParts`）；
       - 进入代码块 fence ` ``` ` 或未闭合行内代码/链接 URL 阶段。
     - Tick 2 将 `advanceBatchIdRef.current` 递增为 `2`，若 `structureChanged` 为 `true` 则把尚未 resolve 的空壳 `<p class="md-p"></p>` 写入 `unitsRef.current`，然后直接 `return`。
     - 1ms 后，**Tick 1 的 `Promise.all(partPromises)` 完成**！`session.resolveTextPart` 虽然更新了 `session` 内部数组，但走到第 `235` 行时：`advanceBatchIdRef.current !== currentBatchId`（`2 !== 1`）成立，**直接 `return` 丢弃更新**！
     - **后果**：`unitsRef.current` 永远停留在空壳 `<p class="md-p"></p>`，`setRenderVersion` 不被调用。如果此后该块封口（或流式结束），`MarkdownBlockItem.tsx:128-133` 的 `lockedUnitsRef.current` 锁存的就是空壳 `<p class="md-p"></p>`！
  4. **致命竞态场景 B（同步缓存微任务反超异步 IPC）**：
     - **Tick 1**（`currentBatchId = 1`）：长段落未命中缓存，走异步 IPC `core_md_render`。
     - **Tick 2**（`currentBatchId = 2`）：新起一行短文本（如标题或常见短句）命中了 `getMarkdownHtmlCache(part.raw)`（第 `211` 行），`Promise.resolve()` 在微任务队列立即完成，此时 `advanceBatchIdRef.current === 2`，Tick 2 的 `.then()` 先执行。
     - 随后 Tick 1 的 IPC 返回，因 `currentBatchId (1) !== advanceBatchIdRef.current (2)` 被第 `235` 行直接丢弃，导致 Tick 1 的段落永远停留在旧文本或空壳 `<p class="md-p"></p>`。
  5. **影响范围**：
     - `MarkdownBlockItem.tsx:120`（流式活跃尾块）；
     - `ReasoningRow.tsx:53`（思考过程流式摘要 `useStreamingMarkdownHtml(rawContent, isStreaming)`，且 `ReasoningRow` 在流式期间完全依赖 `streamingHtml` 渲染）。

---

### 4.2 缺陷 2（中危）：`MarkdownBlockItem.tsx` 在 Render 阶段直接写入 `streamingTextRef.current`

- **代码位置**：`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:92-112`
- **问题代码**：
  ```tsx
  const streamingTextRef = useRef<string>('');
  const isContinuation = isSameBlockContinuation(
    streamingTextRef.current,
    text
  );
  const hadStaleStreamingUnits =
    !isContinuation &&
    streamingUnitsRef.current !== null &&
    streamingUnitsRef.current.length > 0;
  if (hadStaleStreamingUnits) {
    streamingUnitsRef.current = null;
    lockedUnitsRef.current = null;
  }
  if (!isContinuation) {
    streamingTextRef.current = text; // <--- 违反 React 纯渲染规则：在 Render 阶段直接修改 Ref
  }
  // ...
  const allowEmptyClear = !isContinuation;
  ```
- **根因机理**：
  - 当同一个 `MarkdownBlockItem` 实例因虚拟列表复用或 key 相同而切换到一段全新的非延续文本（`!isContinuation`，例如从旧文本 `"Hello world"` 切换到 `"Completely different"`，甚至切换到 `""`）时：
  - 在 React 18 `StrictMode`（开发模式下 React 会故意双调用组件函数体以检测副作用）或并发渲染重跑下：
    1. **第 1 次执行函数体**：`streamingTextRef.current` 为 `"Hello world"`，`isContinuation` 为 `false`，`hadStaleStreamingUnits` 为 `true`，`allowEmptyClear` 为 `true`；但第 `102` 行立即把 `streamingTextRef.current` 改写成了 `"Completely different"`。
    2. **第 2 次执行函数体（React 真正采纳返回值的那次）**：此时 `streamingTextRef.current` 已经是 `"Completely different"`，调用 `isSameBlockContinuation("Completely different", "Completely different")` 返回 **`true`**！
    3. 结果：最终传给 `<ReconciledMarkdownHtml allowEmptyClear={allowEmptyClear} />` 的 `allowEmptyClear` 被错误算成了 **`false`**！
  - 一旦新块的异步 `sealedHtml` 尚未返回（首帧 `renderedHtml === ''`），`ReconciledMarkdownHtml.tsx:122` 的 Zero-Collapse Guard 看到 `allowEmptyClear === false && container.childNodes.length > 0`，就会**拒绝清空旧块的 DOM**，导致界面上残留上一个不相关块的错误内容；反之若新块本就是空串，旧 DOM 将永远残留在容器内。

---

### 4.3 缺陷 3（中低危）：`MarkdownBlockItem` 忽略 `useAsyncMarkdownHtml` 的 `failed` 状态，无纯文本兜底

- **代码位置**：`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:147-150` vs `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx:130, 341`
- **现象对比**：
  - `useAsyncMarkdownHtml`（`markdownRenderAsync.ts:95-151`）签名返回 `{ html: string; failed: boolean }`。
  - 在 `MarkdownDocumentView.tsx:130, 341` 中，明确解构了 `{ html: asyncHtml, failed: renderFailed }`，当 `renderFailed && content` 时渲染 `<pre className="md-text-fallback">{content}</pre>` 兜底，保证即便 Rust IPC 与 Worker 全部异常，用户也能看到原始文本。
  - 而在 `MarkdownBlockItem.tsx:147` 中：
    ```tsx
    const { html: sealedHtml } = useAsyncMarkdownHtml(
      isEffectivelySealed ? text : '',
      priority
    );
    ```
    完全丢弃了 `failed` 字段。如果 `parseMarkdownToHtmlAsync` 因 IPC 通道异常且 Worker 初始化失败而返回 `failed: true, html: ''`，则所有已封口块（包括全部历史静态消息）的 `renderedHtml` 将永久停留为 `''`，且由于没有 `<pre>` 回退，气泡内正文区域将完全空白。

---

### 4.4 缺陷 4（中低危）：`useChatStream.ts` 与 `sessionStreamManager.ts` 的 `renderBuffer` 注册失效及入口分叉

- **代码位置**：
  - `apps/crish-desktop/src/hooks/chat-stream/useChatStream.ts:50-62`
  - `apps/crish-desktop/src/hooks/chat-stream/sessionStreamManager.ts:14-64`
  - `apps/crish-desktop/src/hooks/chat-stream/useRunStreamingAssistant.ts:153-155`
- **问题详情**：
  1. 在 `useChatStream.ts:50-62` 中：
     ```ts
     useEffect(() => {
       const batcher = streamBatcherRef.current;
       const renderBuffer = renderBufferRef.current;
       if (scopedSessionId && batcher) {
         registerSessionBatcher(scopedSessionId, batcher);
       }
       if (scopedSessionId && renderBuffer) {
         registerSessionRenderBuffer(scopedSessionId, renderBuffer);
       }
       return () => {
         if (scopedSessionId && batcher) {
           unregisterSessionBatcher(scopedSessionId, batcher);
         }
         if (scopedSessionId && renderBuffer) {
           unregisterSessionRenderBuffer(scopedSessionId, renderBuffer);
         }
       };
     }, [scopedSessionId, streamBatcherRef, renderBufferRef]);
     ```
  2. 然而在 `useStreamBatchers.ts:128` 中，`renderBufferRef` 初始值为 `useRef<StreamRenderBuffer | null>(null)`。真正的 `new StreamRenderBuffer(...)` 是在用户触发流式回复、执行 `useRunStreamingAssistant.ts:153-154` 时才动态创建的：
     ```ts
     const renderBuffer = new StreamRenderBuffer((displayText) => { ... });
     renderBufferRef.current = renderBuffer;
     ```
  3. 由于修改 `renderBufferRef.current` 不会触发 `useChatStream.ts` 的 `useEffect` 重新运行，且 `useRunStreamingAssistant.ts` 内部从未调用 `registerSessionRenderBuffer(sessionId, renderBuffer)`：
     - `sessionStreamManager.ts` 中的 `sessionRenderBuffers` Map **在整个应用生命周期内始终为空**；
     - 当外部调用 `flushAndClearSessionStream(sessionId)` 时，`renderBuffer.flush()` 根本不会被执行！
  4. 此外，存量文件 `apps/crish-desktop/src/hooks/useChatStream.ts` 仍然导出 `./chat-stream/index.ts`，而 `useChatSend.ts:16` 改为了直接导入 `./chat-stream/useChatStream.ts`，造成同一 Hook 存在两份实现（`chat-stream/index.ts` 与 `chat-stream/useChatStream.ts`）的双轨分叉。

---

## 五、核心问题 3 深度排查：是否存在未捕获异常触发 `ErrorBoundary` 导致空白？

### 5.1 外层 `ErrorBoundary` 的包裹层级与触发后表现

1. **单条消息级包裹**：`apps/crish-desktop/src/components/MessageVirtualizer.tsx:416, 447`
   ```tsx
   <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
     <ChatMessageRow ... />
   </AppErrorBoundary>
   ```
   - 核查 `apps/crish-desktop/src/components/AppErrorBoundary.tsx:229-269`：当 `variant="minimal"` 捕获异常时，渲染 `<span className="error-boundary-minimal">`（显示红色感叹号与 `"此区域出错"` + `"重试"` 按钮；若重试超过 ` MAX_RETRIES = 3` 则显示 `"重复出错，请重新加载"`）。**不会渲染为空白 `null`**。
2. **叶子面板级包裹**：`apps/crish-desktop/src/components/layout/TreeLeafPanel.tsx:412`
   ```tsx
   <AppErrorBoundary compact title={`面板 [${leaf.panelType}] 渲染异常`}>
   ```
   - 核查 `AppErrorBoundary.tsx:271-334`：当 `compact` 捕获异常时，渲染 `.error-boundary-compact` 卡片（显示 `"面板 [chat] 渲染异常"`、错误详情 `error.message` 与 `"重试"` 按钮）。**同样不会渲染为空白 `null`**。

### 5.2 被审查的 9 个文件是否存在运行时同步抛错风险？

经逐一核查：

- **`MarkdownDocumentView.tsx:122`**：新增 `const { leafId } = useLeafScope();`。核查 `apps/crish-desktop/src/contexts/LeafScopeContext.tsx:36-57`，`LeafScopeContext` 创建时带有默认对象 `DEFAULT_LEAF_SCOPE`（`leafId: '__global_leaf__'`），`useLeafScope()` 直接返回 `useContext(LeafScopeContext)`，即使在脱离 `<LeafScopeProvider>` 的独立挂载场景下也**绝不会抛错**。
- **`unitReconciler.ts:97-172`**：重写后的 `reconcileUnits` 使用 `let cursor: ChildNode | null = container.firstChild`。在循环中：
  - `container.replaceChild(replacement, cursor)`（第 `159` 行）和 `container.removeChild(cursor)`（第 `169` 行）调用时，`cursor` 必然是 `container` 的当前直接子节点，**不会触发 `NotFoundError: The node to be replaced is not a child of this node`**。
- **`unitSplitter.ts:69-71`**：`getSharedTemplate()` 仅在 `typeof document === 'undefined'` 时 `throw new Error(...)`，在 WebView2 渲染进程中 `document` 恒存在。
- **`MessageToolCallsSection.tsx`**：仅移除了 `ResizeObserver` 副作用，降低了异常面。
- **`chatMessageRowUtils.ts`**：`isMessageEffectivelyEmpty` 对 `message.content`、`message.reasoning`、`message.parts`、`message.toolCalls` 均有可选链与 `Array.isArray` 保护（第 `248-269` 行），无空指针异常。

### 5.3 跨层关联线索：为什么界面可能表现为「整个会话没有任何消息显示（空白/欢迎页）」？

既然 `MarkdownBlockItem` 对历史静态消息不会锁死为空，且 `ErrorBoundary` 不会静默渲染为 `null`，为什么当前工作区的未提交改动会导致「会话消息消失」的视觉现象？

在交叉核对 `MarkdownDocumentView.tsx` 引入的 `LeafScopeContext` 上游提供方 `apps/crish-desktop/src/components/layout/TreeLeafPanel.tsx` 与 `treeLeafPanelModel.ts` 的未提交 `git diff` 时，定位到直接关联根因：

- 在 `apps/crish-desktop/src/components/layout/treeLeafPanelModel.ts:36-41`（未提交改动）中：
  ```ts
  export function isLeafInDraftMode(leaf: LayoutLeaf): boolean {
    if (leaf.panelType !== 'chat') return false;
    return readActiveTabId(leaf) === '' || readLeafTabs(leaf).length === 0;
  }
  ```
- 在 `apps/crish-desktop/src/components/layout/TreeLeafPanel.tsx:88-96`（未提交改动）中：
  ```ts
  const isDraftLeaf = isLeafInDraftMode(leaf);
  const effectiveSessionId = isDraftLeaf
    ? `${DRAFT_LEAF_SESSION_PREFIX}${leaf.id}` // "__pending_draft__:<leaf.id>"
    : boundSessionId || undefined;
  ```
  随后将 `effectiveSessionId` 传入 `<LeafScopeProvider sessionId={effectiveSessionId}>`（第 `413` 行）和 `<ChatCard sessionId={ctx.sessionId}>`（第 `61` 行）。
- 在 `apps/crish-desktop/src/hooks/useScopedSessionField.ts:28-36` 中：
  ```ts
  export function useScopedSessionId(
    explicitSessionId?: string
  ): string | null {
    const { sessionId: leafSessionId } = useLeafScope();
    const globalActiveId = useSessionStore((s) => s.activeSessionId);
    const resolved = explicitSessionId ?? leafSessionId;
    if (resolved !== undefined) {
      return resolved || null;
    }
    return globalActiveId;
  }
  ```
- **触发消息消失的完整链路**：
  当任何代码路径（或初始化恢复、测试脚本、外部切换）仅更新了 `sessionStore.activeSessionId = targetSessionId`，而 `layoutTreeStore` 中对应 `chat` 叶子节点的 `tabs` 数组为空或 `activeTabId === ''` 时，`isLeafInDraftMode(leaf)` 返回 `true`，强制将 `effectiveSessionId` 设为 `"__pending_draft__:leaf-chat"`。
  这导致 `ChatCard` 内部通过 `useScopedSessionId` 拿到的会话 ID 变成了 `"__pending_draft__:leaf-chat"`（而非 `sessionStore.activeSessionId`），`sessionStore.sessions["__pending_draft__:leaf-chat"]` 为 `undefined`，`messages` 为 `[]`，最终整个聊天窗口渲染为 `session-empty` 草稿欢迎页，所有历史消息在画面上「消失」。

---

## 六、修复建议与验证断言（供主控决策）

1. **修复 `useStreamingMarkdownHtml` 的异步批次丢弃 Bug（`apps/crish-desktop/src/api/markdownRenderAsync.ts:173, 194-243`）**：
   - **方案**：移除每次 `useEffect` 递增并拦截 `.then()` 的 `advanceBatchIdRef.current !== currentBatchId` 判断，恢复使用 `session.getRevision() !== advance.revision`（仅当 `session.reset()` 发生会话级重置时才丢弃在途的 `resolveTextPart` 结果）。因为同一 `IncrementalMarkdownSession` 实例内的所有 `advance()` 产出的 `textParts` 都属于同一个递增文档的不同位置片段，任何前序 `partPromise` 完成时都必须更新 `unitsRef.current = session.getUnits()` 并触发 `setRenderVersion((v) => v + 1)`。
2. **修复 `MarkdownBlockItem` 在 Render 阶段写 Ref 的副作用（`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:94-112`）**：
   - **方案**：严禁在组件函数体同步执行 `streamingTextRef.current = text`。将 `streamingTextRef.current = text` 统一收敛到 `useLayoutEffect`（在 `ReconciledMarkdownHtml` 消费完本次 `allowEmptyClear` 之后再同步更新 `streamingTextRef.current = text`），确保 StrictMode 双调用与并发渲染下 `isContinuation` 和 `allowEmptyClear` 的幂等性。
3. **补齐 `MarkdownBlockItem` 对 `useAsyncMarkdownHtml.failed` 的降级显示（`MarkdownBlockItem.tsx:147`）**：
   - **方案**：解构 `{ html: sealedHtml, failed: sealedFailed } = useAsyncMarkdownHtml(...)`，当 `isEffectivelySealed && sealedFailed && !renderedHtml && text` 时，渲染 `<pre className="md-text-fallback">{text}</pre>`，杜绝因底层渲染器异常导致气泡静默空白。
4. **修复 `sessionRenderBuffers` 注册时机与 `useChatStream` 双入口分叉（`useChatStream.ts` / `useRunStreamingAssistant.ts`）**：
   - **方案**：在 `useRunStreamingAssistant.ts:154` 创建 `new StreamRenderBuffer` 时直接调用 `registerSessionRenderBuffer(sessionId, renderBuffer)`，并在 `cleanupStreamingResources` 中调用 `unregisterSessionRenderBuffer`；同时合并 `hooks/chat-stream/index.ts` 与 `hooks/chat-stream/useChatStream.ts`，保持单一真理入口（SSOT）。
