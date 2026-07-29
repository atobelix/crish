# 对话流功能最优方案 · 6 轮执行计划

> 生成日期：2026-07-29
> 核心目标：120+ FPS 流式 Markdown 渲染 + AI 图片结构化显示
> 实现方式：6 轮次执行，每轮 4 agent 并行

---

## 核心架构

### 根本性转变

流式期纯 JS 增量解析 + DOM 直操，零 IPC / 零 morphdom / 零 diff。

| 维度 | 旧方案（已失败） | 中间方案（Rust+morphdom） | **最优方案（JS增量+DOM直操）** |
|---|---|---|---|
| 流式渲染源 | 无（纯文本） | Rust md_render_stream | **JS IncrementalMarkdownParser** |
| 每帧 IPC | 0 | 1 次 (~200μs) | **0** |
| 每帧 DOM 操作 | 0 | morphdom diff (~5ms) | **单节点 innerHTML (~0.05ms)** |
| 每帧解析复杂度 | 0 | O(末段) 全文 pulldown-cmark | **O(delta) 行扫描状态机** |
| 帧率 | ∞（但无渲染） | ~30 FPS | **120+ FPS** |
| 完成态 | Rust md_render | Rust md_render | **Rust md_render（不变）** |

### 三根支柱

1. **JS 块级增量解析器**：行驱动状态机，已闭合块缓存 HTML，仅重解析开放尾块（O(delta)）
2. **DOM 块级 patch**：finalized 块 appendChild 一次，tail 块单节点 innerHTML
3. **rAF 自动对齐帧率**：requestAnimationFrame 自动适配 60/120/144Hz 显示器

### 规避旧方案三大陷阱

旧 IncrementalMarkdownParser 失败根因（见 `analysis/2026-07-24-前端性能与拖拽问题审查报告.md` 第 51-59 行）：
1. 每帧对整个尾部块重做 markdown 解析（非真正增量）
2. 代码高亮缓存键为 `${lang}:${raw}`（全文），流式每帧必 miss → 每帧主线程同步高亮整个已累积代码块
3. `getHtml()` 每帧 join 全部 chunk，O(全文)，产物 `frame.html` / `frame.chunkUpdates` 从未被消费

**规避策略**：
- 稳定块缓存（永不重解析）→ 避免 O(n²)
- 行级代码高亮缓存 `${lang}:${line}` → 避免全文重高亮
- tailBlock 产物被消费 → 避免 bridge 空转

---

## 第 1 轮：基础设施层（4 agent 并行，无依赖）

### Agent 1.1：Rust 侧 renderer.rs 软闭合 + stream_mode

**任务**：修改 `crates/conex-markdown/src/renderer.rs`

1. `render()` 末尾软闭合未闭合 fence（当前会丢失内容）：
```rust
fn render(&mut self, text: &str) -> String {
    for event in Parser::new_ext(text, options) { self.handle_event(event); }
    // 新增：软闭合未闭合 fence
    if let Some(fence) = self.fence.take() {
        self.output.push_str(&build_code_fence_html(&fence.buffer, &fence.lang, fence.file_path.as_deref()));
    }
    post_process_void_elements(&self.output)
}
```

2. 新增 `stream_mode: bool` 字段，`stream_mode=true` 时跳过 syntect 高亮（代码块 plain text）
3. 导出 `render_markdown_stream(text: &str, stream_mode: bool) -> String`

**验证**：`cargo test -p conex-markdown` 全通过；新增未闭合 fence 测试用例

### Agent 1.2：Tauri 命令 + rustCore.ts wrapper

**任务**：
1. `apps/agent-workbench/src-tauri/src/markdown_commands.rs` 新增命令：
```rust
#[tauri::command]
pub async fn md_render_stream(text: String, stream_mode: bool) -> Result<String, CoreError>
```
2. `apps/agent-workbench/src-tauri/src/main.rs` 注册新命令
3. `apps/crish-desktop/src/api/rustCore.ts` 新增 wrapper：
```typescript
export async function renderMarkdownStream(text: string, streamMode: boolean): Promise<string | null>
```

**验证**：Tauri 编译通过；命令注册成功

### Agent 1.3：types.ts 类型扩展

**任务**：修改 `apps/crish-desktop/src/store/types.ts`

```typescript
/** 结构化图片引用 */
export interface MessageImageRef {
  id: string;              // source hash，用于去重
  source: string;
  kind: 'local' | 'http' | 'data' | 'svg' | 'unsafe';
  resolvedUrl?: string;
  status?: 'pending' | 'resolved' | 'error';
  mime?: string;
  alt?: string;
  originToolCallId?: string;
  byteSize?: number;
}

// MessageToolCall 增加 images 字段
// MessageTimelineBlockType 增加 'image'
// MessageTimelineBlock 增加 images?: MessageImageRef[]
// SessionMessage 增加 images?: MessageImageRef[]
```

**验证**：`npx tsc --noEmit` 通过

### Agent 1.4：streamingStore + StreamRenderBuffer 扩展

**任务**：
1. `apps/crish-desktop/src/store/streamingStore.ts`：StreamEntry 增加 `images?: MessageImageRef[]`，StreamToolLive 增加 `images?: MessageImageRef[]`
2. `apps/crish-desktop/src/api/StreamRenderBuffer.ts`：
   - `frameBudgetMs` 从 12ms 降至 6ms（120 FPS 适配）
   - `RenderFrame` 恢复 `html: string` 字段（携带 JS 增量解析器产物）
   - `maxBytesPerFrame` 保持 8192

**验证**：`npx tsc --noEmit` 通过；StreamRenderBuffer 测试更新

---

## 第 2 轮：JS 增量 Markdown 解析器（4 agent 并行，依赖第 1 轮类型）

### Agent 2.1：IncrementalMarkdownParser 核心状态机

**任务**：新建 `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.ts`

**接口契约**：
```typescript
export interface BlockNode {
  type: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'fence' | 'ul' | 'ol' | 'table' | 'quote' | 'hr';
  html: string;
  startLine: number;
  endLine: number;
}

export interface IncrementalParseResult {
  finalizedBlocks: BlockNode[];  // 已闭合块（含历史 + 本次新增）
  tailBlock: BlockNode | null;   // 开放尾块（每帧重算）
  blockCount: number;            // finalizedBlocks.length
}

export class IncrementalMarkdownParser {
  constructor();
  /** 推入最新全文，返回增量解析结果 */
  push(fullText: string): IncrementalParseResult;
  /** 重置状态（新消息） */
  reset(): void;
  /** 释放资源 */
  dispose(): void;
}
```

**实现要点**：
- 行驱动状态机，参考 Rust `renderer.rs` 的状态栈模型
- 复用 `markdownPlugins.ts` 导出的 `matchListItem`/`isIndentedContinuation`/`visualIndent`
- 复用 `markdownTable.ts` 导出的 `isTableSepLine`/`isTableRowLine`/`splitTableCells`
- 块级边界检测算法（见下方）
- 已闭合块 HTML 缓存，永不重解析

**块级边界检测算法**：
```
push(fullText: string):
  lines = splitToLines(fullText)
  newLines = lines.slice(this.finalizedLineCount)
  for line in newLines:
    this.processLine(line)
  this.finalizeTail()  // 尝试闭合可闭合的块

processLine(line):
  // 优先级：fence 内 > 块级起始 > 段落续行
  if this.fence:
    if isFenceClose(line, this.fence):
      this.closeFence()        // finalizedBlocks.push(fenceBlock)
    else:
      this.fence.buffer.push(line)
    return

  if isFenceOpen(line):
    this.closeParagraph()      // flush 当前段落为 finalized
    this.openFence(line)
    return

  if isHeading(line):
    this.closeParagraph()
    this.finalizedBlocks.push(buildHeading(line))
    return

  if isHr(line):
    this.closeParagraph()
    return

  if isTableRowLine(line) and nextLineIsSep(lines, idx):
    this.closeParagraph()
    this.openTable(line, nextLine)
    return

  if this.table:
    if isTableRowLine(line):
      this.table.rows.push(splitCells(line))
    else:
      this.closeTable()
      this.reprocessLine(line)
    return

  if matchListItem(line):
    this.closeParagraph()
    this.processListLine(line)
    return

  if this.listStack:
    if isListContinuation(line):
      this.processListLine(line)
    else:
      this.closeList()
      this.reprocessLine(line)
    return

  if line.trim() === '':
    this.closeParagraph()
    return

  this.paragraphBuffer.push(line)
  this.inParagraph = true

finalizeTail():
  // 不闭合仍在进行的块，仅生成 tailBlock HTML
  this.tailBlock = buildTailBlock(this.currentOpenState)
```

**验证**：parity 测试（转写 `crates/conex-markdown/tests/integration.rs` 为 TS）

### Agent 2.2：增量内联解析 + 代码高亮

**任务**：新建 `apps/crish-desktop/src/api/markdown-render/IncrementalInlineRenderer.ts`

**接口契约**：
```typescript
/** 对单块文本做内联解析（bold/italic/code/link/image），返回 HTML */
export function renderInline(text: string): string;

/** 行级代码高亮（复用 StreamingCodeHighlighter 缓存模式） */
export function highlightCodeLine(lang: string, line: string): string;
export function highlightCodeBlock(lang: string, code: string): string;
```

**实现要点**：
- 复用 `markdownPlugins.ts` 的 `applyInline`/`formatMarkdownTextSegment`
- 复用 `markdownSanitizer.ts` 的 `isSafeImgSrc`/`sanitizeUrlCandidate`
- 代码高亮采用 `${lang}:${line}` 行级缓存（关键：避免旧方案 O(n²)）
- 流式期代码块用行级高亮，完成态由 Rust syntect 接管

**验证**：内联解析 parity 测试；行级高亮缓存命中率测试

### Agent 2.3：IncrementalDomRenderer（DOM 块级 patch）

**任务**：新建 `apps/crish-desktop/src/api/markdown-render/IncrementalDomRenderer.ts`

**接口契约**：
```typescript
export class IncrementalDomRenderer {
  constructor(container: HTMLElement);
  /** 应用增量解析结果到 DOM */
  render(result: IncrementalParseResult): void;
  /** 流式→完成态切换：用 Rust HTML 替换全部 */
  finalize(rustHtml: string): void;
  /** 重置（新消息） */
  reset(): void;
}
```

**实现要点**：
- 容器结构：`<div class="md-rendered">{finalized 节点}{tail 节点}</div>`
- finalized 块：`data-block-id` 标记，appendChild 创建一次
- tail 块：`data-block-tail` 标记，单节点 `innerHTML` 更新
- 新 finalized 块出现 → appendChild + 移除旧 tail → 新 tail appendChild
- `finalize()`：`container.innerHTML = rustHtml`（一次性，完成态权威渲染）
- 零 morphdom，零 diff

**验证**：DOM 节点数 = finalizedBlocks.length + 1（tail）；性能测试 < 0.1ms/帧

### Agent 2.4：useStreamRenderThrottle hook

**任务**：新建 `apps/crish-desktop/src/hooks/useStreamRenderThrottle.ts`

**接口契约**：
```typescript
export function useStreamRenderThrottle(
  streamText: string | undefined,
  isStreaming: boolean,
  visible: boolean
): { text: string; paused: boolean };
```

**实现要点**：
- 基于 `requestAnimationFrame`（自动对齐 60/120/144Hz）
- 16ms 内多次更新合并为一次 rAF 回调
- `visible=false` → `paused=true`，跳过渲染
- `isStreaming=false` → 立即同步（完成态无延迟）
- 清理：unmount 时 cancelAnimationFrame

**验证**：rAF 调度测试；视口外暂停测试

---

## 第 3 轮：AsyncMarkdownBlock 重写 + 集成（4 agent 并行，依赖第 2 轮）

### Agent 3.1：AsyncMarkdownBlock 重写

**任务**：重写 `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx`

**核心逻辑**：
```typescript
export function AsyncMarkdownBlock({ text, precomputedHtml, isStreaming, paused, streamId }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const parserRef = useRef<IncrementalMarkdownParser | null>(null);
  const rendererRef = useRef<IncrementalDomRenderer | null>(null);

  // 流式期：JS 增量解析 + DOM 直操
  useEffect(() => {
    if (!isStreaming || paused || !text) return;
    if (!parserRef.current) parserRef.current = new IncrementalMarkdownParser();
    if (!rendererRef.current && containerRef.current)
      rendererRef.current = new IncrementalDomRenderer(containerRef.current);

    const result = parserRef.current.push(text);
    rendererRef.current?.render(result);
  }, [text, isStreaming, paused]);

  // 完成态：Rust md_render（优先 precomputedHtml）
  const { html } = useAsyncMarkdownHtml(
    isStreaming ? '' : (precomputedHtml || text),
    priority,
    { skipRustIfCached: !!precomputedHtml }
  );

  useEffect(() => {
    if (isStreaming) return;
    if (html || precomputedHtml) {
      rendererRef.current?.finalize(html || precomputedHtml!);
      parserRef.current?.dispose();
      parserRef.current = null;
    }
  }, [html, precomputedHtml, isStreaming]);

  return <div ref={containerRef} className={`${styles.assistantText} md-rendered`} />;
}
```

**验证**：流式期 120 FPS；完成态无视觉跳变

### Agent 3.2：useAsyncMarkdownHtml 改造

**任务**：修改 `apps/crish-desktop/src/api/markdownRenderAsync.ts`

- 新增 `skipRustIfCached` option：命中 precomputedHtml 时跳过 IPC
- 新增 `renderMarkdownStream` fallback（Rust missing 时）

### Agent 3.3：MessageContent 透传改造

**任务**：修改 `apps/crish-desktop/src/components/chat-message/MessageContent.tsx`

- 透传 `precomputedHtml`/`streamId`/`paused`/`visible` 给 `AsyncMarkdownBlock`
- 接入 `useStreamRenderThrottle`
- 移除 `extractImageRefs + inlineImages`（第 121-146 行）

### Agent 3.4：首屏批量预热

**任务**：新建 `apps/crish-desktop/src/api/markdownPreload.ts`

```typescript
/** 会话首屏加载时批量预渲染可见消息的 precomputedHtml */
export async function preloadSessionHtml(messages: SessionMessage[]): Promise<void>;
```

- 调用 `md_render_batch`（新增 Rust 命令）批量渲染
- 写入 `msg.precomputedHtml` + LRU 缓存

---

## 第 4 轮：图片结构化（4 agent 并行，依赖第 1 轮类型）

### Agent 4.1：toolFeedback resolveToolImages

**任务**：修改 `apps/crish-desktop/src/api/toolFeedback.ts`

- 新增 `resolveToolImages` 函数（从 output/args 提取结构化图片）
- 新增 `isImageProducingTool` 函数
- `useStreamCallbacks.ts` 的 `onToolSuccess` 增加 `images` 参数

### Agent 4.2：markdownPlugins renderImgFromDest 分类占位

**任务**：修改 `apps/crish-desktop/src/api/markdown-render/markdownPlugins.ts`

- `renderImgFromDest` 改为分类处理：local → `data-local-path` 占位；svg → 独立通道；http/data → 直写 src
- 新增 `classifyImageSrc` 函数

### Agent 4.3：ImageGallery + ImageTile + LocalImgResolver

**任务**：新建 `apps/crish-desktop/src/components/chat-image/ImageGallery.tsx` + `ImageTile.tsx` + `LocalImgResolver.tsx`

- `ImageGallery`：统一图片渲染容器
- `ImageTile`：IntersectionObserver 懒加载 + 错误回退 + 加载状态
- `LocalImgResolver`：解析 `[data-local-path]` 的 `<img>`，异步 `toAssetUrl`

### Agent 4.4：移除旧图片逻辑

**任务**：修改 `MessageContent.tsx` + `ToolCallOutput.tsx`

- 移除 `extractImageRefs + inlineImages`（MessageContent）
- 移除 `extractImageRefs + toolResultImages`（ToolCallOutput）
- 改为消费 `tc.images` 结构化字段 + `ImageGallery` 组件

---

## 第 5 轮：流式图片 + 安全性能（4 agent 并行，依赖第 3、4 轮）

### Agent 5.1：useStreamCallbacks onChunk 增量图片检测

**任务**：修改 `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`

- `onChunk` 增量检测图片（扫描 chunk + 末尾 200 字符）
- 检测到图片 → 写入 `streamingStore.images`（status: 'pending'）
- 本地路径 → 异步 `toAssetUrl` → 更新 status: 'resolved'

### Agent 5.2：workspaceFsApi toAssetUrl 增强

**任务**：修改 `apps/crish-desktop/src/api/workspaceFsApi.ts`

- `toAssetUrl` 增加 `isSafeAssetPath` 校验（拒绝 `..` 路径穿越）
- 新增 `assetUrlCache` LRU 500 条
- 新增 `imageRefCache` 跨消息复用

### Agent 5.3：markdownSanitizer 安全增强

**任务**：修改 `apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts`

- `isSafeImgSrc` 增加 data URL 大小限制（2MB）
- 新增 `sanitizeSvgContent`（剥 script/event handler）
- 新增 `classifyImageSrc`（local/http/data/svg/unsafe）

### Agent 5.4：render-worker fallback + 废弃 StreamingCodeHighlighter

**任务**：修改 `apps/crish-desktop/src/workers/render-worker.ts`

- 新增 `markdown.render.stream` case（Rust missing 时 fallback）
- 废弃 `streamingCodeHighlighter.ts`（由 JS 增量解析器替代）

---

## 第 6 轮：测试 + 验证 + 优化（4 agent 并行，依赖所有）

### Agent 6.1：增量 markdown 渲染器单元测试

**任务**：新建 `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.test.ts`

- 转写 `crates/conex-markdown/tests/integration.rs` 全部用例为 TS
- parity 测试：JS 增量输出 vs Rust 完成态输出
- 边界测试：未闭合 fence、嵌套列表、表格 lookahead

### Agent 6.2：图片结构化集成测试

**任务**：新建 `apps/crish-desktop/src/components/chat-image/ImageGallery.test.tsx`

- 工具图片提取测试
- 本地路径解析测试
- SVG 安全清洗测试
- 去重测试

### Agent 6.3：性能基准测试

**任务**：新建 `apps/crish-desktop/src/api/markdown-render/perfBenchmark.ts`

- FPS 测量（requestAnimationFrame 时间戳）
- 每帧解析耗时（performance.mark/measure）
- 内存占用（finalizedBlocks 缓存大小）
- 目标：120 FPS 下每帧 < 2ms

### Agent 6.4：端到端验证 + 回归测试

**任务**：
- 运行全量测试套件
- TypeScript 类型检查
- 手动验证：新建对话流式渲染、历史消息、图片显示、撤回功能
- 性能验证：Chrome DevTools Performance 录制

---

## 轮次依赖关系

```
第 1 轮（基础设施）
    │
    ├─→ 第 2 轮（JS 增量解析器）── 依赖类型
    │       │
    │       └─→ 第 3 轮（AsyncMarkdownBlock 重写）── 依赖解析器
    │               │
    │               └─→ 第 6 轮（测试验证）
    │
    ├─→ 第 4 轮（图片结构化）── 依赖类型
    │       │
    │       └─→ 第 5 轮（流式图片 + 安全）── 依赖图片组件 + AsyncMarkdownBlock
    │               │
    │               └─→ 第 6 轮（测试验证）
    │
    └─→ 第 6 轮（测试验证）── 依赖所有
```

**并行机会**：第 1 轮完成后，第 2 轮和第 4 轮可并行启动。

---

## 关键设计决策

1. **JS 增量解析器而非 Rust 流式**：120 FPS 要求零 IPC，JS 侧 O(delta) 解析 < 0.5ms/帧
2. **DOM 直操而非 morphdom**：块级 patch（appendChild + 单节点 innerHTML）< 0.1ms，morphdom diff 5ms
3. **rAF 而非定时器**：自动对齐显示器刷新率（60/120/144Hz）
4. **行级代码高亮缓存**：`${lang}:${line}` 键，避免旧方案 O(n²) 全文重高亮
5. **完成态 Rust 权威渲染**：JS 增量解析器仅用于流式期，完成态切换到 Rust（syntect 高质量高亮 + ammonia sanitize）
6. **parity 测试保障**：JS 输出与 Rust 输出结构兼容，完成态切换无视觉跳变
7. **降级路径**：JS 解析器异常 → catch → 回退纯文本流式，零回归

---

## 性能预估

| 场景 | 每帧成本 | 120FPS 预算占比 |
|---|---|---|
| 典型段落流式（尾块 100-500 字符） | 0.1-0.5ms（尾块 regex）+ 0.05ms（单节点 innerHTML） | ~7% |
| 代码块流式（每帧 +1-3 行） | 0.05-0.2ms/新行高亮 + 0.05ms（尾节点 innerHTML） | ~4% |
| 长列表流式（尾块 +1 项） | 0.2-0.4ms（尾块重解析） | ~5% |
| 表格流式（尾行 +1 行） | 0.1-0.3ms（尾行 splitCells + innerHTML） | ~4% |
| **最坏情况**（500 字符尾块 + 3 行代码） | ~1.2ms | ~14% |

对比当前流式（0ms，纯文本）：新增成本 <1.2ms/帧，120FPS（8.3ms 预算）下安全裕度 >7ms。

对比旧 IncrementalMarkdownParser（O(n²)，20KB 代码流式时数十 ms/帧）：新方案 O(delta)，性能提升 1-2 个数量级。

---

## 关键文件清单

### Rust 侧
- `crates/conex-markdown/src/renderer.rs` — 状态机模型参考 + 软闭合改造
- `crates/conex-markdown/src/lib.rs` — 公共 API
- `crates/conex-markdown/tests/integration.rs` — parity 测试用例
- `apps/agent-workbench/src-tauri/src/markdown_commands.rs` — Tauri 命令层
- `apps/agent-workbench/src-tauri/src/main.rs` — 命令注册

### JS 增量解析器（新建）
- `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.ts`
- `apps/crish-desktop/src/api/markdown-render/IncrementalInlineRenderer.ts`
- `apps/crish-desktop/src/api/markdown-render/IncrementalDomRenderer.ts`
- `apps/crish-desktop/src/hooks/useStreamRenderThrottle.ts`

### JS 可复用资产
- `apps/crish-desktop/src/api/markdown-render/markdownPlugins.ts` — 行级识别函数
- `apps/crish-desktop/src/api/markdown-render/markdownTable.ts` — 表格行级识别
- `apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts` — URL/CJK 安全
- `apps/crish-desktop/src/api/streamingCodeHighlighter.ts` — 行级高亮缓存模式
- `apps/crish-desktop/src/api/StreamRenderBuffer.ts` — rAF 帧调度
- `apps/crish-desktop/src/api/codeHighlight.ts` — `highlightCode` 同步入口

### 集成点
- `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx` — 流式/完成态切换
- `apps/crish-desktop/src/components/chat-message/MessageContent.tsx` — `isStreaming` 传递
- `apps/crish-desktop/src/api/markdownRenderAsync.ts` — 完成态 Rust 调用
- `apps/crish-desktop/src/hooks/chat-stream/useStreamBatchers.ts` — StreamRenderBuffer 持有

### 图片结构化（新建 + 修改）
- `apps/crish-desktop/src/store/types.ts` — 类型扩展
- `apps/crish-desktop/src/api/toolFeedback.ts` — resolveToolImages
- `apps/crish-desktop/src/components/chat-image/ImageGallery.tsx` — 新建
- `apps/crish-desktop/src/components/chat-image/ImageTile.tsx` — 新建
- `apps/crish-desktop/src/components/chat-image/LocalImgResolver.tsx` — 新建
- `apps/crish-desktop/src/api/workspaceFsApi.ts` — toAssetUrl 增强

### 历史教训
- `analysis/2026-07-24-前端性能与拖拽问题审查报告.md` 第 51-59 行 — 旧方案失败根因
- `apps/crish-desktop/src/api/StreamRenderBuffer.ts` 第 14-16 行、25-28 行 — bridge 移除注释
- `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx` 第 24 行 — D0 residual 标注
