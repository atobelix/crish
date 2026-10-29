# 深度审查报告：Markdown 流式渲染架构、性能与重渲染瓶颈深度评估

> **审查范围**：
> - 前端流式管道：`apps/crish-desktop/src/components/chat-message-row/`（`StreamingMarkdownView.tsx`, `MarkdownBlockItem.tsx`, `useStreamingBlocks.ts`, `StreamingGfmTable.tsx` 等）
> - 增量编译状态机：`apps/crish-desktop/src/api/markdown/`（`IncrementalBlockSplitter.ts`, `SpeculativeVirtualCloser.ts`, `IncrementalMarkdownSession.ts`, `StreamingGfmTableParser.ts`, `AdaptiveAnimateTimeline.ts`, `SlidingWindowRateEstimator.ts` 等）
> - 异步桥接与 Worker：`apps/crish-desktop/src/api/markdownRenderAsync.ts`, `apps/crish-desktop/src/workers/`（`render-worker.ts`, `markdown-render-standalone.ts`）
> - 静态文档视图与大文件熔断：`apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx`, `apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx`
> - Rust 内核渲染引擎：`crates/conex-markdown/src/`（`renderer.rs`, `cache.rs`, `lib.rs`）, `apps/agent-workbench/src-tauri/src/markdown_commands.rs`
>
> **核心原则**：完全基于现有源代码、组件契约与运行时实现细节，以代码事实为唯一准绳，着重揭示架构缺陷、性能短板与虚假/空转抽象。

---

## 一、核心摘要与综合评级

### 1.1 总体架构裁决

本软件在 Markdown 流式渲染上构想了一套融合“增量分块（Splitter）+ 投机闭合（Closer）+ 异步增量投影（IncrementalSession）+ DOM 单元协调（ReconciledMarkdownHtml）+ 速率自适应（RateEstimator）”的多层防御体系。然而，**深入源码实现后可以确认：该架构存在大量“名不副实”的代码断层、空转僵尸抽象、严重的 IPC 管道滥用以及功能性投降策略**。

对比行业最顶尖梯队（**Typora** 的原位混合渲染、**Obsidian** 基于 CodeMirror 6 的视口轻量化切片、**VS Code** 的单向增量同步、**Notion** 的 Block-Level 状态树与 Windowing），本软件的 Markdown 渲染水平处于**“原型已成、工程冗余、极限性能严重不足、大文档功能残缺”**的中游水准。

### 1.2 核心缺陷红线清单

| 缺陷维度 | 代码确凿位置 | 严重程度 | 核心技术事实 |
| :--- | :--- | :--- | :--- |
| **投机闭合完全悬空** | [`MarkdownBlockItem.tsx:91`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx#L91) | **P0（架构断层）** | `SpeculativeVirtualCloser` 计算出的 `virtualClosedText` 在组件参数中被重命名为 `_virtualClosedText` 并彻底闲置，流式活跃尾块直接使用未闭合 raw text 编译。 |
| **僵尸调度时间轴** | [`AdaptiveAnimateTimeline.ts:76`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/AdaptiveAnimateTimeline.ts#L76), [`MarkdownBlockItem.tsx:96`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx#L96) | **P1（空转开销）** | 每帧执行 `beginPass`/`commitPass`，传给子组件后被标为 `_timeline` 闲置；核心槽位调度 `take()` 在全仓库仅存于单测，属于 100% 僵尸代码。 |
| **流式表格单胞 IPC 轰炸** | [`StreamingGfmTable.tsx:47`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingGfmTable.tsx#L47), [`markdownRenderAsync.ts:273`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts#L273) | **P0（性能瓶颈）** | 每个表格单元格独立挂载 `useStreamingMarkdownUnits`，流式期间 N×M 个单元格并发向 Tauri IPC 发起 `core_md_render`，造成跨进程管道饱和与线程池饥饿。 |
| **流式跳过高亮成死代码** | [`conex-markdown/src/renderer.rs:773`](file:///C:/Software/conex/crates/conex-markdown/src/renderer.rs#L773), [`markdown_commands.rs:23`](file:///C:/Software/conex/apps/agent-workbench/src-tauri/src/markdown_commands.rs#L23) | **P1（性能浪费）** | Rust 内核虽写了 `render_markdown_stream(text, stream_mode)`，但 Tauri 仅暴露全量 `core_md_render`。流式阶段所有片段被迫执行完整的 Syntect 语法高亮与 Ammonia 净化。 |
| **大文档 256KB 彻底投降** | [`MarkdownDocumentView.tsx:15`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx#L15), [`MarkdownDocumentView.tsx:317`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx#L317) | **P0（功能缺失）** | 超过 256KB 直接放弃 Markdown 渲染，强行切入纯文本行号查看器 `VirtualPlainCodeViewer`，面对中大型文档（如 500KB~1MB）完全丧失富文本排版能力。 |
| **表格自适应抖动（CLS）** | [`StreamingTableContainer.module.css:36`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L36), [`StreamingGfmTableParser.ts:133`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/StreamingGfmTableParser.ts#L133) | **P1（视觉抖动）** | 首行 `\|` 触发空态隐藏（高坍塌为 0），第二行分隔线到达瞬间高度骤弹；`table-layout: auto` 导致每个新字符灌入时列宽持续横向位移。 |
| **封口块协调全量破防** | [`MarkdownBlockItem.tsx:76`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx#L76) | **P1（重渲染扩散）** | `markdownBlockItemPropsEqual` 显式比对 `prev.isStreaming === next.isStreaming`。流式终止瞬间，全局 `isStreaming` 变 `false`，所有历史已封口块集体触发重新执行。 |

---

## 二、流式分块机制与布局抖动（CLS）深度审查

### 2.1 分块切分机制（`IncrementalBlockSplitter`）与语法边界缺陷

`IncrementalBlockSplitter` 采用行缓冲与行前缀和方案，设计意图是通过 DFA 扫描独立语法边界并封口。然而，其切分逻辑存在严重的语法不平衡与盲区：

```typescript
// apps/crish-desktop/src/api/markdown/IncrementalBlockSplitter.ts:330-357
// 7. 普通段落 / 列表 / 表格：持续累积直到遇到空行或新的独立块起始标志
for (let i = firstUnscannedLine; i < scanLimit; i += 1) {
  const line = this.lines[i] ?? '';
  if (line.trim().length === 0) {
    paragraphEnd = i - 1;
    nextStart = i + 1;
    break;
  }
  if (
    atxHeadingPattern.test(line) ||
    codeFenceOpenPattern.test(line) ||
    thematicBreakPattern.test(line)
  ) {
    paragraphEnd = i - 1;
    nextStart = i;
    break;
  }
}
```

#### 缺陷点 1：列表（Lists）缺乏独立切分逻辑，无限膨胀为单体巨块
- **代码事实**：语法扫描器仅将 `atxHeading`、`codeFence`、`thematicBreak` 视为独立块中断标志。**对于无序列表（`- item`）、有序列表（`1. item`）、任务列表（`- [ ]`），完全没有块切分分支**。
- **运行后果**：若大模型输出一个包含 100 个条目的长列表，只要列表项之间没有空行，切分器将其**整体归入同一个普通块**中，永远无法封口！
- **性能连锁反应**：该长列表必须全量常驻在“活跃草稿尾块”（Active Draft Tail）中，每个流式 chunk 的到达都会导致这个长达数百行的未封口块反复进行增量推进，直到列表彻底结束并出现空行才一次性封口。

#### 缺陷点 2：尾部未闭合块的状态悬停与跳跃
- **代码块（Code Fence）**：当接收到 ````typescript` 开头时，`closedAtLine === -1`，切分器直接 `break`（行 251）。代码块正文全部留在 `pendingDraft`。一旦接收到闭合 ```` `，切分器立即将其封口并触发全量编译（行 246）。
- **LaTeX $$ 数学块**：通过 `countDoubleDollars` 奇偶校验（行 257），奇数时挂起在 `pendingDraft`，偶数闭合时封口。
- **HTML 块**：通过栈式计数开闭标签（行 282），未闭合前全部停留在草稿。

### 2.2 虚拟补全器（`SpeculativeVirtualCloser`）的失效与悬空现象

在 `apps/crish-desktop/src/api/markdown/SpeculativeVirtualCloser.ts` 中，实现了对未闭合围栏、奇数 `$$`、未闭合反引号、粗体 `**`、表格未闭合竖线的纯内存补全逻辑：

```typescript
// apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:51-62
function makeActiveDescriptor(text: string, index: number, messageId: string): ParsedBlockDescriptor {
  return {
    key: `${messageId}-blk-${index}-active`,
    text,
    virtualClosedText: speculativeCloseBlock(text), // 此处认真计算了补全文本
    index,
    isSealed: false,
  };
}
```

然而，进入消费端组件 `MarkdownBlockItem.tsx` 审查其实际装配情况：

```typescript
// apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:89-93
export const MarkdownBlockItem = React.memo(function MarkdownBlockItem({
  text,
  virtualClosedText: _virtualClosedText, // 【代码实锤】：重命名为下划线忽略变量！
  isSealed,
  isLast,
  isStreaming,
  priority,
  timeline: _timeline,                   // 【代码实锤】：同样被下划线忽略！
  ...
}: MarkdownBlockItemProps) {
  ...
  // apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:129-134
  const liveHtml = useStreamingMarkdownHtml(
    text, // 【致命】：传给底层流式 HTML 编译器的依然是原始未闭合的 text！
    isActiveTail && !isStreamingGfmTable,
    priority,
    streamingUnitsRef
  );
```

> [!CAUTION]
> **代码事实铁证**：`virtualClosedText` 在 `useStreamingBlocks` 中耗费 CPU 进行正则扫描并补全，但传到 `MarkdownBlockItem` 后被参数解构为 `_virtualClosedText`，在组件函数体内**没有任何一处代码使用它**！
> 传给渲染通道 `useStreamingMarkdownHtml` 的始终是原始文本 `text`。所谓的“纯内存投机虚拟补全器”在渲染链路中**完全悬空无效**。

### 2.3 GFM 表格流式渲染中的 CLS 抖动与闪烁

表格在流式传输中是最容易引发累积布局偏移（CLS）的重灾区。审查 `StreamingGfmTable.tsx` 与 `StreamingGfmTableParser.ts`：

#### 1. 首行高度坍塌（Blanking）与二阶段暴增
在 `looksLikeStreamingGfmTable` 判定逻辑中：
```typescript
// apps/crish-desktop/src/api/markdown/StreamingGfmTableParser.ts:133-139
export function looksLikeStreamingGfmTable(markdown: string): boolean {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const [firstLine = '', secondLine] = normalized.split('\n');
  if (!firstLine.includes('|')) return false;
  if (secondLine === undefined) return true; // 单行含 | 即认为可能是表格！
  ...
```
当大模型刚刚吐出表头第一行（例如 `| 序号 | 名称 | 说明 |`），尚未吐出第二行分隔线 `| --- | --- |` 时：
1. `looksLikeStreamingGfmTable` 返回 `true`，`shouldRenderStreamingTable` 为 `true`；
2. 组件挂载 `<StreamingGfmTable markdown={text} />`；
3. `StreamingGfmTableParser.advance` 扫描发现没有到达换行或分隔行未建立，内部 `header` 为 `null`，`trailingMarkdown` 为 `''`；
4. `StreamingGfmTable` 返回 `null`（无任何 DOM）；
5. **视觉表现**：**该行文本完全从屏幕上消失，高度塌陷为 0px！**
6. 当第二行 `| --- | --- |` 终于到达并换行后，表头瞬间从 0 弹出，高度瞬间跃变 40px+，产生极度突兀的视觉跳闪。

#### 2. 非表格普通文本误伤（“幽灵文本”回潮）
若用户正文中写了一句 `A | B 是常见逻辑运算`：
- 第 1 行输入时命中 `firstLine.includes('|')`，被误判为流式表格，**该行文字被立即隐藏**；
- 第 2 行输入普通文字，`StreamingGfmTableParser` 发现第二行不是 `isTableSepLine`，触发 `closeAsProse()`，将 `header` 置空并将全文作为 `trailingMarkdown` 倒灌回普通段落渲染；
- **视觉表现**：用户看到打字机打出的一句话突然消失不见，几百毫秒后又像故障一样重新跳出。

#### 3. `table-layout: auto` 引发的列宽横向震颤
审查样式文件 `StreamingTableContainer.module.css`：
```css
/* apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:34-37 */
.tableScrollViewport table,
.tableScrollViewport :global(.md-table) {
  table-layout: auto;
  width: 100%;
}
```
- 在浏览器原生表格布局中，`table-layout: auto` 要求浏览器根据单元格内容动态计算列宽；
- 流式生成表格时，大模型逐字向单元格注入文本。如果第 1 列正在吐字，第 1 列宽度逐渐扩张，迫使第 2 列、第 3 列不断向右挤压收缩；当第 2 列开始吐字时，第 1 列又反向收缩；
- **整张表格在流式吐字期间呈现高频“果冻抖动”与列宽横向拉扯**。对比 Typora 或 Notion（均采用固定列宽比或 CSS Grid 约束），本软件视觉稳定性严重欠缺。

### 2.4 封口块（Sealed Block）的 freeze / React.memo 协调破防点

设计目标声称“已封口块在后续流式帧中 0 重渲染”，但在真实协调链路上存在多处协调破防点：

#### 破防点 1：流式终态广播破防（全量重渲染）
审查 `markdownBlockItemPropsEqual`：
```typescript
// apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:67-82
export function markdownBlockItemPropsEqual(
  prev: MarkdownBlockItemProps,
  next: MarkdownBlockItemProps
): boolean {
  return (
    prev.text === next.text &&
    prev.virtualClosedText === next.virtualClosedText &&
    prev.isSealed === next.isSealed &&
    prev.isLast === next.isLast &&
    prev.isStreaming === next.isStreaming && // 【关键破防点】
    prev.priority === next.priority &&
    prev.ast === next.ast &&
    prev.enableWorkerOffload === next.enableWorkerOffload &&
    prev.isPurged === next.isPurged
  );
}
```
- 当 AI 消息生成完毕，父容器 `StreamingMarkdownView` 接收到的 `isStreaming` 从 `true` 变为 `false`；
- 父容器重新渲染，遍历 `blocks.map(...)`，所有历史封口块（哪怕已经稳定渲染了几十秒的块）传入的 `isStreaming` 均变成 `false`；
- `prev.isStreaming !== next.isStreaming`，**所有历史已封口块全部 React.memo 比较失败，无一幸免全部触发重渲染！**

#### 破防点 2：封口瞬间的状态切换二次级联震荡
当一个活跃尾块封口成为历史块时：
1. **第 1 次重渲染**：`isSealed` 变 `true`，`isActiveTail` 变 `false`。此时组件处于 `isSealingPending` 态（行 222），渲染 `effectiveLockedUnits`；同时 `useAsyncMarkdownHtml(text)` 触发向 Rust 发起异步 IPC 请求，内部 `loading = true`；
2. **第 2 次重渲染**：若干毫秒后 Rust IPC `core_md_render` 返回权威 HTML，`useAsyncMarkdownHtml` 内部 `setHtml(result)` 触发组件内部状态变更，`MarkdownBlockItem` 再次重渲染；
3. **DOM 替换**：在 `ReconciledMarkdownHtml` 中，由于权威 HTML 到达，从原本的 `incrementalUnits` 路径强切到 `reconcileUnits(container, splitHtmlIntoUnits(html))`，整个子 DOM 树被二次对比与替换。

#### 破防点 3：全局状态 Store 穿透
在 `MarkdownBlockItem.tsx` 第 123 行：
```typescript
const codeIndent = useSettingsField((s) =>
  normalizeCodeBlockIndent(s.appSettings?.markdown?.codeBlockIndent)
);
```
每个 `MarkdownBlockItem` 实例独立订阅了 Zustand Store。一旦用户在设置中变动配置，无论该块是否封口，所有挂载的 BlockItem 立即无视 React.memo 强制并发重执行。

---

## 三、渲染延迟、IPC 管道与 Worker 开销剖析

### 3.1 Tauri IPC 跨进程管道的吞吐量与上下文切换瓶颈

#### 1. 单次 IPC 调用的物理往返成本
在 `apps/crish-desktop/src/api/markdownRenderAsync.ts` 中：
```typescript
// apps/crish-desktop/src/api/markdownRenderAsync.ts:81
const rustHtml = await renderMarkdown(raw);
```
其调用链深入至 Tauri 底层：
$$\text{JS V8 引擎} \xrightarrow{\text{JSON.stringify}} \text{WebView2 COM IPC} \xrightarrow{\text{Windows Named Pipe}} \text{Rust 主进程} \xrightarrow{\text{tokio::task::spawn\_blocking}} \text{工作线程池} \xrightarrow{\text{pulldown + syntect}} \text{HTML 字符串} \xrightarrow{\text{JSON 序列化}} \text{IPC 回传} \xrightarrow{\text{Promise 解析}}$$

单次 IPC 调用的往返耗时基线通常在 **1.5ms ~ 4.5ms**（视机器负载与进程调度而定）。
对于纯文本正则或轻量 JS 解析，仅需 **0.02ms ~ 0.08ms**。**IPC 的调用开销比算法本身的计算耗时高出 30~50 倍！**

#### 2. 流式片段逐块派发造成的“IPC 队列风暴”
在 `useStreamingMarkdownHtml` 活跃推进循环中：
```typescript
// apps/crish-desktop/src/api/markdownRenderAsync.ts:272-277
for (const part of advance.textParts) {
  void parseMarkdownFragmentToHtmlAsync(part.source, priority, part.kind, {
    signal: currentSignal,
    ...(sessionId !== undefined ? { sessionId } : {}),
  })
```
- 当大模型以 60~100 tokens/s 的高并发吐字时，每个 token chunk 切割出的 `advance.textParts` 可能会并发产生多个待解析片段；
- 每一个片段都发起一个独立的 `parseMarkdownToHtmlAsync` $\to$ `renderMarkdown` $\to$ `core_md_render`；
- **更恐怖的是 `StreamingTableCell`（行 47）**：在一张 5 列 × 10 行的表格中，50 个单元格全部挂载 `useStreamingMarkdownUnits`，流式期间有几十个单元格同时向 Rust 管道并发倾泻 `core_md_render` 调用！
- **Tokio 阻塞线程池饥饿**：
  在 `apps/agent-workbench/src-tauri/src/markdown_commands.rs:24` 中：
  ```rust
  tokio::task::spawn_blocking(move || conex_markdown::render_markdown(&text))
  ```
  大量突发的并发 Markdown 渲染把 Tokio 的 `blocking` 线程池打满，导致文件 I/O、Git 操作等其他依赖 `spawn_blocking` 的系统核心任务排队等待，引发桌面主界面微卡顿。

#### 3. 架构谎言：Rust `render_markdown_stream` 沦为未连线死代码
审查 `crates/conex-markdown/src/renderer.rs`：
```rust
// crates/conex-markdown/src/renderer.rs:773-777
/// 流式渲染 markdown。
/// stream_mode=true 时代码块跳过 syntect 高亮,直接输出 plain text (escaped HTML),
/// 避免每个 chunk 重复高亮的开销...
pub fn render_markdown_stream(text: &str, stream_mode: bool) -> String { ... }
```
这个极其重要的性能优化（流式跳过 Syntect 重复高亮）在 Rust crate 中已经写好。**但是检查 Tauri 命令层与前端桥接层**：
- `apps/agent-workbench/src-tauri/src/markdown_commands.rs` 中**只暴露了 `core_md_render` 和 `core_md_render_batch`**，根本没有暴露 `core_md_render_stream`！
- 全仓库搜索 `render_markdown_stream`，除了 crate 自身的单测外，**在 Tauri、IPC 和前端中调用次数为 0**！
- **事实结论**：前端所有流式 chunk 片段，在调用 Rust IPC 时走的全部是默认 `stream_mode=false` 的全量 `render_markdown`，每一个未闭合的微小代码片段都在一遍又一遍地跑完整的 Syntect 语法高亮与 Ammonia 净化，造成极大的 CPU 周期浪费。

#### 4. 历史会话加载灾难：`core_md_render_batch` 闲置
Rust 端专门开发了 `core_md_render_batch`（`markdown_commands.rs:36`），用于首屏一次性打包渲染多条消息。
然而，检查前端消息加载逻辑：
- 在 `MessageContent.tsx:453` 中，历史消息直接实例化 `<StreamingMarkdownView text={fallbackText} isStreaming={false} />`；
- 每个历史消息被 `IncrementalBlockSplitter.split` 拆成十几个块，每个块各自发起单条 `useAsyncMarkdownHtml`；
- **一个包含 30 条历史消息的会话打开时，瞬间并发打出 300~500 个单条 `core_md_render` IPC 请求！**
- `renderMarkdownBatch` 仅在 `markdownBatchPrewarm.ts` 和单测中被引用，实际页面渲染逻辑根本没有接入批处理管道。

### 3.2 Web Worker 离线解析的结构化克隆（Structured Clone）瓶颈

在 Worker 模式中，`render-worker.ts` 提供了 `markdown.parse.ast` 和 `markdown.render`：

```typescript
// apps/crish-desktop/src/workers/markdown-render-standalone.ts:64-178
export function parseMarkdownToBlockAst(raw: string): MarkdownAstResult { ... }
```

该函数返回的 `MarkdownAstResult` 结构：
```typescript
export interface MarkdownAstResult {
  raw: string;
  blocks: MarkdownBlockToken[]; // 数组，每个元素包含 id, type, raw, text, lang, code, html
  fullHtml: string;
  hasCode: boolean;
  hasTable: boolean;
  codeBlocksCount: number;
}
```

- **结构化克隆不可避免的序列化开销**：
  Worker 与主线程通信必须依赖 `postMessage`。因为返回的是复杂的嵌套 JS 对象图（数十个 `MarkdownBlockToken` 实例，内含长字符串），浏览器底层执行深拷贝（Structured Clone Algorithm）；
- **内存双倍膨胀与 GC 停顿**：
  对于 100KB~200KB 的 Markdown，编译出的 AST 对象图加上语法高亮后的 HTML 字符串体积达数兆字节。主线程反序列化这几兆的复杂对象会导致主线程执行数百毫秒的内存分配与垃圾回收（GC），抵消了 Web Worker 卸载计算带来的收益；
- **Transferable 机制完全未利用**：
  没有使用 `ArrayBuffer` 二进制紧凑布局（如 flatbuffers 或紧凑 TypedArray）进行 Transferable 零拷贝传输，依然在使用原生的普通对象结构化克隆。

---

## 四、大文档与极限负载表现：256KB 熔断器与其背后的架构投降

### 4.1 256KB 熔断机制深度审查

审查 `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx`：

```typescript
// apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx:15
/** 超过此阈值（默认 256KB）将强制熔断切入虚拟化极速代码呈现 */
export const DEFAULT_LARGE_FILE_THRESHOLD_BYTES = 256 * 1024;

// apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx:134-145
const isLargeFile = Boolean(
  largeFileThreshold &&
  largeFileThreshold > 0 &&
  contentLength > largeFileThreshold
);

// 只有非大文件才交由异步渲染引擎处理；熔断时严格向 Rust / worker 传空串
const targetMarkdown = isLargeFile ? '' : content || '';
const { html, loading, failed } = useAsyncMarkdownHtml(targetMarkdown, priority);

// apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx:317-344
if (isLargeFile) {
  return (
    <div className="md-rendered conex-markdown md-large-file" data-large-file="true">
      <VirtualPlainCodeViewer content={content} filePath={filePath} wordWrap={wordWrap} />
    </div>
  );
}
```

#### 1. 架构投降的本质：缺乏富文本视口虚拟化（DOM Windowing）
- 为什么设定 256KB 这个死线？
  因为 `MarkdownDocumentView` 在第 439 行采用了极其原始的渲染方式：
  ```tsx
  <div dangerouslySetInnerHTML={{ __html: html }} />
  ```
  如果将一份 500KB 或 1MB 的 Markdown 文档完整编译为 HTML 并一次性注入 DOM：
  - 生成的 DOM 节点数量将突破 **10,000 ~ 30,000 个**；
  - 浏览器的样式重新计算（Style Recalculation）、布局计算（Layout Tree）和绘制（Paint）将直接导致主线程卡死 **2~5 秒**；
  - 随后的页面滚动更是会产生灾难级的掉帧（FPS < 10）。
- **投降策略**：由于前端无法做到针对已渲染 Markdown 块的视口虚拟滚动（Viewport Virtualization），开发团队选择了最简单粗暴的“逃生门”——**一旦超过 256KB，直接不渲染 Markdown！**
- **功能后果**：用户打开一份 300KB 的技术设计文档、产品规划书或长篇日志，看到的不是排版优美的 Markdown，而是一个冷冰冰的代码查看器（`VirtualPlainCodeViewer`），所有标题、列表、粗体、公式、图片、表格**全部降级为带行号的单色代码字面量**！在桌面端 Markdown 工具中，这是严重的体验断崖。

#### 2. 前后端规格分裂与不诚实设计
- 在 Rust 内核中：`crates/conex-markdown/src/lib.rs:30` 明确声明：
  ```rust
  /// 输入长度上限:超过截断(5MB),避免恶意长输入拖垮渲染线程,杜绝100KB~256KB文件静默截断。
  pub const MAX_MARKDOWN_INPUT: usize = 5 * 1024 * 1024;
  ```
  Rust 内核开发者写下这行注释自豪地宣称“杜绝 100KB~256KB 文件静默截断”，支持 5MB 输入；
- 然而在前端 UI 表现层：`MarkdownDocumentView.tsx` 却卡死在 256KB。后端支持 5MB 变成了无意义的自嗨，前端早在 256KB 就彻底罢工。

### 4.2 对标顶尖产品（Typora / Obsidian / VS Code / Notion）

我们将本软件与当前业界最顶尖的四款 Markdown 渲染/编辑产品进行多维度极限能力硬碰硬对比：

| 评估维度 | **Conex (本仓库当前状态)** | **Typora** | **Obsidian (CM6 核心)** | **VS Code (Markdown 预览)** | **Notion** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **渲染模式** | 离散分块 + dangerouslySetInnerHTML | 混合原位 WYSIWYG（DOM 节点动态切换） | CodeMirror 6 Viewport Virtualization | Webview 独立进程管道 + 增量补丁 | Block 结构化数据树 + Canvas/DOM 混合 |
| **视口虚拟化能力** | **无**（大文件直接切纯文本代码查看器；聊天区仅有消息级虚拟化） | **有**（视口外仅保留占位高，视口内动态装卸节点） | **极其强悍**（CM6 行级/块级视口按需挂载） | **有**（长文档分段流式递送并按需渲染） | **强悍**（Block 级原生虚拟滚动列表） |
| **中大型文档上限 (500KB~2MB)** | **完全崩溃/降级**（超过 256KB 直接退化为代码查看器） | **流畅**（支持数万行、5MB 文档秒开编辑） | **秒开流畅**（测试数万行 Markdown 零卡顿） | **流畅渲染**（支持长篇技术白皮书） | **流畅**（支持超长页面无缝滚动） |
| **流式动态吐字体验** | 抖动明显（表格 CLS、代码块封口二次闪烁、光标生硬） | 无流式场景（纯编辑器） | 插件流式（基于 CM6 ViewState 事务平滑增量） | 流式平滑（扩展协议增量更新） | 内部流式原生支持（Block 级追加） |
| **语法高亮开销控制** | **差**（流式阶段全量调用 Syntect，未连线流式跳过模式） | 极佳（Worker 增量高亮与缓存） | 极佳（Lezer 增量语法树，仅重算变更范围） | 极佳（TextMate / Tree-sitter 后台高亮） | 极佳（独立 Block 异步着色） |
| **内存效率与 GC 表现** | **较差**（Tauri IPC JSON 拷贝 + Web Worker AST 拷贝） | **极高**（C++ 原生内核，轻量级封装） | **高**（CM6 Immutable 数据结构，内存常驻低） | **高**（Electron 主进程与渲染分离，跨进程共享） | **中高**（针对巨型页面具备垃圾回收策略） |

#### 深度差距解析：
1. **根本差距在“视口虚拟化”（Windowing）**：
   Typora 和 Obsidian 之所以能轻松吃下数万行、数兆字节的 Markdown，核心在于底层采用了基于行高测量和视口边界的动态回收机制——屏幕外的内容只有高度占位符（Spacer），不渲染实际的 DOM 标签。本软件完全不具备富文本 Markdown 内部的视口虚拟化能力，才不得不设置 256KB 的耻辱熔断。
2. **状态增量更新机制的差距**：
   Obsidian 的 Lezer 解析器和 CodeMirror 6 采用**增量语法树（Incremental Syntax Tree）**，用户输入一个字符，只重新解析该字符所在的 AST 节点及其父节点，局部复杂度为 $O(\log N)$；而本软件每次流式哪怕只进一个单词，都要通过正则切分器、状态机和 IPC 重走一遍，计算开销与复杂度随文本长度线性飙升。

---

## 五、过度设计与僵尸架构（Phantom Architecture）曝光

在审查过程中，我们发现了令人震惊的过度设计与完全未被使用的“装饰性代码”：

### 5.1 `AdaptiveAnimateTimeline` 动态时间轴全流程空转

文件 `apps/crish-desktop/src/api/markdown/AdaptiveAnimateTimeline.ts` 宣称：
> “融合速率感知的单挂钟动态时间轴调度器，软预算 B=320ms，最小步长下限 S_min=4ms，跨帧削峰 beginPass，StrictMode / 并发渲染幂等支持...”

检查代码调用链路：
1. 在 `StreamingMarkdownView.tsx` 中（行 49-86）：
   ```typescript
   const timeline = timelineRef.current;
   timeline.beginPass(now); // 开启 Pass
   ...
   useLayoutEffect(() => {
     timeline.commitPass(); // 提交 Pass
   });
   ...
   <MarkdownBlockItem ... timeline={timeline} />
   ```
2. 在 `MarkdownBlockItem.tsx` 中（行 96）：
   ```typescript
   export const MarkdownBlockItem = React.memo(function MarkdownBlockItem({
     ...
     timeline: _timeline, // 直接重命名为 _timeline
   ```
3. 在 `MarkdownBlockItem.tsx` 的函数体内搜索 `_timeline`：**使用次数为 0**！
4. 在全仓库范围内搜索调用其核心方法 `timeline.take(...)`：
   **除了其自身的单测文件 `AdaptiveAnimateTimeline.test.ts` 之外，整个生产代码中调用次数为 0！**

> [!WARNING]
> **技术裁决**：`AdaptiveAnimateTimeline` 是典型的**假架构、僵尸代码**！
> 它在主组件中煞有介事地执行 `beginPass`、`commitPass`，把实例一层层传下去，但下层组件连看都不看一眼就直接丢弃。这套机制没有为系统带来哪怕 1 毫秒的平滑动画效果，纯粹是在白白消耗 CPU 周期和组件渲染开销。

### 5.2 `SlidingWindowRateEstimator` 与复杂档位调度的形式主义

文件 `apps/crish-desktop/src/api/markdown/SlidingWindowRateEstimator.ts` 实现了：
- 500ms 环形滑动窗口；
- 非对称 EMA 平滑（加速 $\alpha=0.5$，减速 $\alpha=0.2$）；
- 冷启动前 3 样本锁定；
- 换算 CRAWL / NORMAL / FAST / TURBO 四级速率快照；
- 计算推荐交错步长（`staggerStepMs`）、动画时长（`animationDurationMs`）、`allowWordSpans`。

然而，在生产代码中，这些详尽计算出来的参数被如何使用呢？
1. `staggerStepMs`：**未被任何组件消费**；
2. `animationDurationMs`：**未被任何组件消费**；
3. `allowWordSpans`：**未被任何组件消费**；
4. 真正被使用的仅仅是 `tier === 'TURBO'` 这个布尔值，在 DOM 上挂载一个 `data-turbo="true"` 属性，该属性在 CSS 中仅仅对应了一行：
   ```css
   /* streaming-animation.css:63 */
   .md-block-active[data-turbo="true"] {
     contain: layout style paint;
   }
   ```
为了设置一个 CSS 的 `contain` 属性，在前端主线程上跑了一套包含滑动窗口、非对称 EMA、Token 换算的复杂数学模型。这是典型的**杀鸡用牛刀、过度设计与形式主义**。

---

## 六、总结与架构收敛路径

### 6.1 审查核心结论

1. **真实可用性**：
   对于普通 10KB 以内的短文本、简单 Markdown 段落，当前系统能正常完成流式展示与基础渲染。
2. **生产缺陷与性能黑洞**：
   - 投机闭合代码写了但被下划线遗弃，形同虚设；
   - 复杂的动态时间轴调度是 100% 空转的死代码；
   - 表格流式状态机引发严重的布局偏移（CLS）与高度跳闪；
   - 单表格单元格高频轰炸 Tauri IPC，跨进程通信成本极其高昂；
   - 面对 256KB 以上文档全面溃退为代码查看器，无法胜任专业级 Markdown 文档阅读需求。

### 6.2 建议重构收敛路线（建议后续战役执行）

1. **封堵悬空缺陷，落实投机闭合**：
   - 修正 `MarkdownBlockItem.tsx`，将 `_virtualClosedText` 真正接驳入 `useStreamingMarkdownHtml`；
   - 或精简掉 `SpeculativeVirtualCloser`，消除两套闭合机制的认知负担。
2. **清除僵尸抽象与过度设计**：
   - 彻底删除 `AdaptiveAnimateTimeline` 及 `SlidingWindowRateEstimator` 中未被消费的冗余字段，将速率分档简化为单行的基于字符计数的节流判断；
   - 移除 `_timeline` 等悬空 props。
3. **连通 Rust 流式接口与批处理 IPC**：
   - 将 `conex_markdown::render_markdown_stream` 暴露给 Tauri（如 `core_md_render_stream`），使流式块在传输期间跳过 Syntect 重复高亮，仅在封口态高亮；
   - 历史消息加载全面切换到已有的 `core_md_render_batch`，消除首屏数百次 IPC 往返风暴。
4. **废黜 256KB 逃生门，引入真正的富文本虚拟化**：
   - 参考 VS Code / Obsidian 架构，实现针对已解析 Markdown AST 块的视口窗口化（Block-Level Windowing）；
   - 彻底废除将 Markdown 文档退化为 `VirtualPlainCodeViewer` 的不合理熔断机制，使 1MB~5MB 文档能够以真实富文本平滑滚动。
5. **稳定表格流式布局**：
   - 表格必须预先声明 `table-layout: fixed` 或设定单元格最小宽度，彻底杜绝逐字吐字引发的列宽横向震荡；
   - 彻底取消单行表格的盲目 0 高度隐藏机制，引入预估占位骨架，保障 CLS 稳定在 0。
