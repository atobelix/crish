# 24. 前端流式渲染与 Markdown 路径审计（伪流式成因 + 增量渲染改造事实基础）

> 日期：2026-08-01 · 范围：crish-desktop 流式渲染管线 + conex-markdown Rust crate · 只读研究，未改代码
> 结论摘要：用户描述的"伪流式"属实。流式期间（processing）UI 展示的是**未渲染的原始纯文本**（`AsyncMarkdownBlock.tsx:51-59`），markdown 渲染**只在每条消息结束后一次性执行**（Rust `md_render` 整篇渲染）。项目已存在一套完整的 JS 增量渲染方案（`IncrementalMarkdownParser` / `IncrementalDomRenderer` / `useStreamRenderThrottle`）与 Rust 流式命令（`md_render_stream`），但**全部处于零消费状态**，只差接线。

---

## 一、渲染链路现状图

### 1.1 数据流全景（delta → DOM）

```
[Rust daemon] WS 事件
   ↓
streamAssistantResponseApi (apps/crish-desktop/src/api/chatApi.ts:189-200)
   ↓ streamViaDaemon (apps/crish-desktop/src/api/daemon-chat-bridge/ConnectionLifecycle.ts:340-442)
   ↓ EventRouter → onChunk(delta)
onChunk (apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:416-433)
   ├─ streamedFullText += chunk（本地累计，421 行）
   └─ renderBufferRef.push(chunk)（422 行）→ StreamRenderBuffer 挂 rAF
        ↓
StreamRenderBuffer.flushFrame (apps/crish-desktop/src/api/StreamRenderBuffer.ts:164-242)
   ├─ 每帧 budget 6ms / maxBytesPerFrame 8192 / 积压降级 degraded（:46-50, :222-223）
   ├─ 合成 frame = { delta, full, lastOffset, isFinal, html: '' , chunkUpdates: [] }（:225-234）
   │    ※ frame.html 恒为 '' —— 增量解析器未接入（见 :14-18 注释"解析器尚未接入"）
   └─ onFrame(frame)（注册于 useStreamCallbacks.ts:173-179）
        ↓
setStreamText(sid, assistantMsgId, frame.full)（useStreamCallbacks.ts:178）
   ↓ 写入原始字符全文（非 delta）
streamingStore.byKey（apps/crish-desktop/src/store/streamingStore.ts:132-147，plain zustand 无 immer）
   ↓ React 订阅（仅 processing 行订阅，MessageContent.tsx:46-54）
MessageContent（apps/crish-desktop/src/components/chat-message/MessageContent.tsx）
   ├─ applyStreamTextToMessage（:58-59；streamingStore.ts:449-490）
   ├─ buildAssistantTimeline（:68；api/toolPresentation.ts:16-21）
   └─ AsyncMarkdownBlock（fallback 路径 :99-107；timeline 路径 :125-133）
        ↓
AsyncMarkdownBlock（apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx）
   ├─ 流式期 isStreaming=true：纯文本 <div> + caret，零 IPC（:51-59；CSS caret 见 ChatMessageRow.module.css:466-479）
   └─ 完成态 isStreaming=false：useAsyncMarkdownHtml(text)（:34-46）
        ↓
markdownRenderAsync.parseMarkdownToHtmlAsync（apps/crish-desktop/src/api/markdownRenderAsync.ts:23-54）
   ├─ ① JS LRU 缓存命中（markdownCache.ts:111-124）
   ├─ ② Rust md_render IPC（rustCore.ts:181-185 → agent-workbench/src-tauri/src/markdown_commands.rs:19-24
   │    → conex_markdown::render_markdown（crates/conex-markdown/src/renderer.rs:657-673，spawn_blocking）
   └─ ③ Rust missing/error → worker fallback（workers/render-worker.ts:13-18，highlight.js 路径）
        ↓
AsyncMarkdownBlock useEffect → el.innerHTML = html（AsyncMarkdownBlock.tsx:41-46）
```

### 1.2 完成态收口路径（onComplete）

```
onComplete（useStreamCallbacks.ts:478-648）
   ├─ buffer.push('', true); buffer.flush(true)（:488-489，force 刷尽残余帧）
   ├─ flushStreamBatchers()（:490，48ms 批合并器 flushNow）
   ├─ commitStreamToSession（:492-498；helpers.ts:184-217 → updateMessageText 写 session store 正文）
   ├─ stripThoughtPlaceholders + 最终清洗（:541-549）
   ├─ normalizeAssistantTimeline 重建 blocks（:556-563）
   ├─ scheduleRunFinalHtml → scheduleFinalMarkdownHtml（:565；helpers.ts:53-74）
   │    ※ 异步 Rust 渲染整篇 → updateMessageText(…, html) 写 precomputedHtml 字段
   └─ 状态 processing → completed（:577-578）→ isThinkingMsg 变 false → AsyncMarkdownBlock 触发完整渲染
```

### 1.3 关键函数职责表

| 函数/组件 | 文件:行号 | 职责 |
|---|---|---|
| StreamRenderBuffer.push / flushFrame | StreamRenderBuffer.ts:78-89 / 164-242 | rAF 分帧合成，产出 { delta, full, lastOffset, isFinal, html:'' } |
| StreamTextBatcher.push / flushNow | streamTextBatcher.ts:258-314（内层 46-235） | 48ms 窗口按 key 合并全文（非 delta），force 终态 flush |
| useStreamCallbacks.onChunk | useStreamCallbacks.ts:416-433 | SSE chunk → buffer.push（renderBuffer 路径）或 batcher.push（fallback） |
| buffer.onFrame | useStreamCallbacks.ts:173-179 | **只写 frame.full 原始字符**到 streamingStore |
| setStreamText | streamingStore.ts:132-147 | 覆盖式写全文，浅比较去重 |
| MessageContent 订阅 | MessageContent.tsx:47-54 | useShallow 订阅 streamingStore.byKey |
| applyStreamTextToMessage | streamingStore.ts:449-490 | streamText 合并进 msg view-model |
| AsyncMarkdownBlock | AsyncMarkdownBlock.tsx:26-73 | 流式纯文本 / 完成态 Rust 渲染 的唯一切换点 |
| useAsyncMarkdownHtml | markdownRenderAsync.ts:81-119 | 完成态 hook：LRU → Rust → worker |
| scheduleFinalMarkdownHtml | helpers.ts:53-74 | 终态预渲染整篇 html 写 precomputedHtml |
| renderMarkdown / renderMarkdownBatch / renderMarkdownStream | rustCore.ts:181-212 | Tauri IPC 桥（md_render / md_render_batch / md_render_stream） |
| md_render / md_render_batch / md_render_stream | markdown_commands.rs:19-51（注册于 main.rs:96-100） | Tauri 命令，spawn_blocking |

---

## 二、伪流式成因分析（具体到函数）

### 2.1 直接成因：流式期间显示的是原始文本（text/plain），不是 markdown

1. **`AsyncMarkdownBlock.tsx:34`** — `const renderTarget = isStreaming ? '' : text;`
   流式期间渲染目标为空串，`useAsyncMarkdownHtml` 直接短路返回（markdownRenderAsync.ts:90-93），**不发起任何渲染请求**。
2. **`AsyncMarkdownBlock.tsx:51-59`** — `isStreaming` 分支渲染 `<div className="assistantText md-rendered isStreaming">{text}</div>`：
   把原始 markdown 源文本作为 React 文本节点输出（text/plain），仅加一个 CSS caret（ChatMessageRow.module.css:466-479）。这就是用户看到的"原始字符"。
3. **`MessageContent.tsx:122`** — `const streaming = isThinkingMsg && item.key === lastTextKey;`
   `isThinkingMsg` = 该消息是当前 processing 的 assistant 消息（ChatMessageList.tsx:246-252 → MessageVirtualizer.tsx:355）。
   即：**流式中的最后文本块必然走纯文本分支**；只有时间线中已闭合的历史文本块（工具交错后）才会走完整渲染。
4. **`useStreamCallbacks.ts:173-179`** — `buffer.onFrame` 只消费 `frame.full`（原始字符全文），
   `StreamRenderBuffer.ts:225-234` 合成帧时 `html: ''`、`chunkUpdates: []` 恒为空（:14-18 注释明确"解析器尚未接入，flush 暂写 ''"）。
   渲染管线最末端有 html 通道预留，但流式期**没有任何 markdown 产物流入 DOM**。

### 2.2 何时触发 markdown 渲染：仅在每条消息结束后

- 触发点 = 消息状态 `processing → completed`（useStreamCallbacks.ts:577-578）→ `isThinkingMsg` 变 false
  → AsyncMarkdownBlock 的 `isStreaming` 变 false → `useAsyncMarkdownHtml(text)` 对**整篇全文**发起渲染。
- 期间没有 throttle / 分块 / 增量：一次 IPC（或 LRU 命中）返回整篇 HTML，`el.innerHTML` 整体替换
  （AsyncMarkdownBlock.tsx:41-46）。
- 另有终态预渲染 `scheduleFinalMarkdownHtml`（helpers.ts:53-74）：onComplete 时异步渲染整篇并写
  `precomputedHtml`（sessionMessageActions.ts:143-152），但 **AsyncMarkdownBlock 不消费 precomputedHtml**（props 仅 text/priority/isStreaming，AsyncMarkdownBlock.tsx:6-13），该字段实际为死数据，完成态渲染走的是 useAsyncMarkdownHtml 自身的 LRU 缓存。

### 2.3 渲染引擎：Rust（Tauri IPC）为主，worker 为 fallback，无 react-markdown

- 完成态渲染链：`useAsyncMarkdownHtml` → `parseMarkdownToHtmlAsync`（markdownRenderAsync.ts:23-54）
  → ① JS LRU 缓存（markdownCache.ts）→ ② `renderMarkdown` → `md_render`（rustCore.ts:181-185，
  markdown_commands.rs:19-24）→ `conex_markdown::render_markdown`（renderer.rs:657-673，pulldown-cmark + syntect + ammonia + moka）
  → ③ Rust missing 时回退 worker（render-worker.ts:13-18，自研 JS 解析 parseMarkdownToHtmlUncached）。
- 项目未使用 react-markdown 等第三方组件；JS 侧自研 markdown-render 目录（markdownPlugins.ts / markdownTable.ts）仅被 worker 与增量解析器使用。

### 2.4 增量渲染能力现状

| 能力 | 现状 | 证据 |
|---|---|---|
| 块级增量解析 | 代码已存在、测试齐全，但**生产零消费** | IncrementalMarkdownParser.ts:91-（455 行）+ .test.ts（481 行）；唯一引用方为 perfBenchmark.ts:22 与测试 |
| DOM 块级 patch | 同上，零消费 | IncrementalDomRenderer.ts:21-；仅 perfBenchmark.ts:23 import |
| 内联增量 + 行级高亮缓存 | 同上，零消费 | IncrementalInlineRenderer.ts:30 LINE_CACHE / :122 renderInline / :200 highlightCodeBlock；仅被解析器自身引用 |
| rAF 渲染节流 | 代码存在、零消费 | useStreamRenderThrottle.ts:17-64；grep 无调用方 |
| 首屏批量预热 | 代码存在、零消费 | markdownPreload.ts:22-74 `preloadSessionHtml`；grep 无调用方 |
| 流式 partial 缓存键 | 代码存在、仅测试消费 | markdownCache.ts:81-175（markdownStreamingCacheKey / invalidateMarkdownStreamCache）；生产代码无引用 |
| Rust 流式渲染命令 | 已注册但前端零调用 | markdown_commands.rs:45-51 `md_render_stream`（main.rs:98 注册）；rustCore.ts:203-212 `renderMarkdownStream` 无生产调用者 |
| 未闭合 code fence 处理 | Rust 侧已实现软闭合；JS 解析器有 tailBlock 概念 | renderer.rs:143-147（flush_fence）+ :396-405；IncrementalMarkdownParser.ts:119-（buildTailBlock） |
| 代码高亮（流式） | worker 侧 StreamingCodeHighlighter 存在；Rust stream_mode 跳过 syntect | render-worker.ts:37-54；renderer.rs:107-110、:1048-1052 |

> 备注：2026-07-24 审查报告（analysis/2026-07-24-前端性能与拖拽问题审查报告.md:51-59）记载了**旧版**增量方案的失败根因
> （全文重解析 O(n²)、高亮缓存键 `${lang}:${raw}` 每帧必 miss、frame.html/chunkUpdates 产物被丢弃），
> 新版增量解析器（markdown-render/ 目录 + STREAMING_RENDER_PLAN.md）已针对性地改为行级缓存 + 稳定块缓存，但尚未接入组件层。

---

## 三、增量渲染改造的可行性要点

### 3.1 每次 delta 到重渲染的现状路径（性能瓶颈）

```
onChunk → StreamRenderBuffer(rAF, 6ms/8192B 预算) → setStreamText(全文覆盖)
→ streamingStore 更新 → MessageContent 订阅重渲染（React）
→ AsyncMarkdownBlock 纯文本 div 整段替换 text（每帧 O(全文) 文本节点更新，无 markdown 解析）
—— 流式期零 markdown 成本，但零 markdown 产出 ——
完成态：整篇 md_render（O(全文) 解析 + syntect 高亮 + ammonia）→ innerHTML 整篇替换
```

瓶颈点：
1. **完成态整篇重渲染**：长消息（>30KB）一次 IPC 全量渲染 + 整篇 innerHTML 替换，期间显示 skeleton（AsyncMarkdownBlock.tsx:68-70）。
2. **流式期无渲染**：用户看到原始 markdown 源码；code fence、标题、列表均不生效。
3. **每帧 React 重渲染**：streamingStore 全文覆盖 → MessageContent/AsyncMarkdownBlock 每帧重渲染（rAF 约 60-120fps），纯文本节点整段更新（无 useStreamRenderThrottle 二次节流——该 hook 已存在未接线）。
4. **终态双渲染**：scheduleFinalMarkdownHtml 与 AsyncMarkdownBlock 完成态渲染是两条独立路径（前者写 precomputedHtml 未被消费），存在重复渲染浪费。

### 3.2 现有可复用点（零新建即可接线）

| 资产 | 位置 | 用途 |
|---|---|---|
| IncrementalMarkdownParser（行驱动状态机，finalizedBlocks 只增 + tailBlock 重算） | api/markdown-render/IncrementalMarkdownParser.ts:91- | 流式期每帧 push(fullText) 得 { finalizedBlocks, tailBlock, blockCount } |
| IncrementalDomRenderer（finalized 块 appendChild 一次、tail 块单节点 innerHTML） | api/markdown-render/IncrementalDomRenderer.ts:21- | 块级 DOM patch，finalize(rustHtml) 完成态切换 |
| IncrementalInlineRenderer（renderInline / highlightCodeLine / LINE_CACHE 行级高亮） | api/markdown-render/IncrementalInlineRenderer.ts:30-200 | 内联解析与行级高亮（规避旧方案 O(n²)） |
| useStreamRenderThrottle（rAF 对齐刷新率、视口外暂停） | hooks/useStreamRenderThrottle.ts:17-64 | 组件层二次节流 |
| StreamRenderBuffer.frame.html 预留字段 | StreamRenderBuffer.ts:21-33、:225-234 | 帧内携带解析器产物；消费方已按"空/非空双路径"设计 |
| markdownCache 流式 partial 键 + 整批失效 | api/markdownCache.ts:81-175 | 流式 partial HTML 缓存隔离 |
| Rust render_markdown_stream（stream_mode 跳过 syntect、未闭合 fence 软闭合） | renderer.rs:689-693、:396-405；markdown_commands.rs:45-51 | 流式 IPC 渲染或 JS 解析器缺失时的降级 |
| markdownPlugins / markdownTable 行级识别函数 | markdown-render/markdownPlugins.ts:28-441、markdownTable.ts:8-132 | 解析器已复用，无需重复实现 |
| StreamingCodeHighlighter（worker 流式高亮） | workers/render-worker.ts:37-54；api/streamingCodeHighlighter.ts | Rust 不可用时的流式代码高亮降级 |
| markdownPreload.preloadSessionHtml（首屏 md_render_batch 预热） | api/markdownPreload.ts:22-74 | 历史消息完成态秒开（当前零消费） |

### 3.3 需新建/接线点（改造的最小面）

1. **AsyncMarkdownBlock 重写**（组件层唯一切换点）：流式期实例化 IncrementalMarkdownParser + IncrementalDomRenderer，
   `push(text)` → `renderer.render(result)`；完成态 `finalize(rustHtml)` + dispose（计划文档 STREAMING_RENDER_PLAN.md:306-348 已有伪代码）。
2. **MessageContent 透传**：把 isStreaming / streamId / visible（视口状态）传给 AsyncMarkdownBlock，接入 useStreamRenderThrottle。
3. **StreamRenderBuffer 消费端**：onFrame 内用 frame.delta/frame.full 驱动解析器（或由组件侧 push），frame.html 由解析器回填。
4. **降级路径**：解析器异常 → 回退现有纯文本分支（零回归）；Rust missing → worker。
5. **完成态一致性**：finalize 用 Rust 权威输出（syntect 高亮 + ammonia），保证与历史消息渲染一致。
6. **可选**：接线 preloadSessionHtml（首屏）、清理 precomputedHtml 双写路径、删除零消费的残余字段（frame.chunkUpdates）。

### 3.4 风险提示

- 旧方案（2026-07-24 报告 P1）因"每帧全文重解析 + 全文高亮缓存 miss"失败；新方案已用 finalizedBlocks 缓存 + 行级高亮缓存规避，但需以 parity 测试（IncrementalMarkdownParser.test.ts 已覆盖 40+ 用例）兜底流式/完成态输出一致性。
- 流式期 DOM 直操绕过 React 渲染树，需注意与 Virtualizer 高度测量（ChatAssistantMessageRow.tsx:173-176 流式期不 invalidate）的配合：增量 DOM 高度变化目前由 ResizeObserver 兜底。

---

## 四、conex-markdown Rust crate 职责现状与可接入点

### 4.1 crate 结构（crates/conex-markdown/src/）

| 模块 | 职责 | 关键导出 |
|---|---|---|
| lib.rs | crate 门面：公共 API 汇总，输入 100KB 截断（:26） | render_markdown / render_markdown_batch / render_markdown_stream / strip_thought_placeholders / highlight_code / clear_cache |
| renderer.rs | pulldown-cmark 事件流 → HTML 状态机（1106 行）；byte-for-byte 兼容 JS CSS 契约（md-p/md-h1/md-code-block/md-table 等） | render_markdown:657 / render_markdown_batch:676 / render_markdown_stream:689 / strip_thought_placeholders:729 |
| highlight.rs | syntect class-style 高亮 + 语言别名归一（170 行） | highlight_code / clear_cache |
| cache.rs | moka LRU：2048 条 / 32MB（UTF-16 估算）/ 单条 1MB 上限 | render_cache() / entry_within_budget |
| ammonia_config.rs | ammonia sanitize 配置（img 属性剥离等） | sanitize |
| sanitizer.rs | URL/路径/CJK 安全（is_safe_href、is_safe_img_src、wrap_cjk_text_segment 等） | — |
| table.rs | GFM 表格对齐、斑马纹 class | stripe_class / table_cell_align_attr |
| tests/integration.rs + parity_fixtures.rs | 与 JS 实现的结构 parity 测试 | — |

### 4.2 关键设计点（与流式改造直接相关）

1. **stream_mode 双路径**（renderer.rs:107-110、:398-401、:1048-1052）：`stream_mode=true` 时代码块跳过 syntect 直接 escape，
   HTML 外壳与完成态一致 → 流式/完成态切换无视觉跳变；`false` 等价完整渲染。`render_markdown_stream` 是唯一入口（:689-693）。
2. **未闭合 fence 软闭合**（renderer.rs:143-147、:396-405）：render() 末尾 flush_fence 把残留在 self.fence 的 buffer 输出为 HTML，
   与计划文档 STREAMING_RENDER_PLAN.md 第 1 轮目标一致（已完成）。
3. **缓存**：`render_markdown` 按全文 key 走 moka LRU（:661-672），流式 partial 每帧不同 → 缓存无效 → `render_markdown_stream` 明确绕过缓存（:683-688）。
4. **渲染管线**：spawn_blocking（markdown_commands.rs:21-24）隔离主线程；ammonia 仅在顶级 img 处 sanitize，避免破坏实体兼容（renderer.rs:149-155、:242-260）。

### 4.3 可接入点评估

| 接入方案 | 现状 | 评估 |
|---|---|---|
| A. 完成态整篇渲染（现状） | useAsyncMarkdownHtml → md_render | 已工作；长消息首帧有 skeleton 空窗 |
| B. 流式期每帧 md_render_stream | rustCore.ts:203-212 + markdown_commands.rs:45-51 均已就绪，零消费 | 每帧 1 次 IPC（~200μs）+ 全文重解析 O(n)，仅适合低频（≥48ms 批）场景；计划文档已判其为"中间方案（~30FPS）" |
| C. JS 增量解析器（零 IPC）+ 完成态 Rust 权威渲染（计划文档"最优方案"） | 解析器全套已存在，只差 AsyncMarkdownBlock 接线 | 每帧 O(delta) + 单节点 innerHTML；Rust 侧只需维持现有 API，无新开发 |
| D. Rust 增量块级渲染 API（新增） | 不存在 | 需新增 crate API + 命令 + 缓存键设计（块级/行级）；工作量大，收益低于 C |

> 结论：事实基础支持"方案 C + 方案 A 完成态"，Rust 侧仅需保持现状（render_markdown / render_markdown_stream 已就绪），
> 主要工作量在前端 AsyncMarkdownBlock / MessageContent 接线与降级路径。
