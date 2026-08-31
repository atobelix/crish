# 挑刺审查报告 02：前端真流式渲染与 Markdown 引擎严苛审查

> **审查范围**：
> - `apps/crish-desktop/src/components/chat-message-row/StreamingMarkdownView.tsx`
> - `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`
> - `apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts`
> - `apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts`
> - `apps/crish-desktop/src/components/chat-message/MessageContent.tsx`
> - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`
>
> **审查原则**：严格只挑刺、只记录架构缺陷、逻辑漏洞、渲染抖动、闪烁塌缩与缓存失效隐患，严禁套话与夸奖。

---

## 1. 流式结束切换完成态导致全量 Cache Miss 触发骨架屏闪烁 (P0 致命缺陷)

### 1.1 `StreamingMarkdownView` 卸载与 `AsyncMarkdownBlock` 全文 Cache Miss 闪现骨架屏
- **缺陷位置**：
  - `apps/crish-desktop/src/components/chat-message/MessageContent.tsx:99-111, 244-249, 340-348`
  - `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx:64-67, 109-111`
  - `apps/crish-desktop/src/api/markdownRenderAsync.ts:27-31, 90-138`
- **缺陷根因与时序链条**：
  1. **流式期间（`streaming = true`）**：`MessageContent` 挂载 `StreamingMarkdownView`，正文被拆解为独立的 Block 切片（如 Block 0, Block 1, ...）。各已封口块在 `MarkdownBlockItem` 中分别调用 `useAsyncMarkdownHtml(blockText)`，将其编译产物**以独立分块的文本为 Key** 存入 `markdownCache`（`setMarkdownHtmlCache(blockText, html)`）。
  2. **流式结束瞬间（`isThinkingMsg` 由 `true` 跃迁为 `false`）**：
     - `MessageContent` 中的 `streaming` 条件变为 `false`（第 244-249 行）。
     - `{streaming && <StreamingMarkdownView .../>}` 表达式求值为 `false`，导致内部所有原本已渲染完毕的 `MarkdownBlockItem` DOM 节点被**全量瞬间卸载（Unmount）**！
     - 渲染控制权转入 `TimelineBody`（第 99-111 行），`TimelineBody` 将全量合并后的正文全文 `bodyText = stripThoughtPlaceholders(item.content || '')` 传入单个 `AsyncMarkdownBlock`。
  3. **缓存击穿与骨架屏闪烁**：
     - `AsyncMarkdownBlock` 调用 `useAsyncMarkdownHtml(bodyText)` 查询 `markdownCache`。
     - 由于流式期间写入缓存的全是**局部块文本**，缓存中根本不存在**全文 `bodyText`** 的条目，导致 **100% 全量 Cache Miss**！
     - `useAsyncMarkdownHtml` 状态进入 `loading: true, html: ''`，向 Rust IPC 派发异步渲染任务。
     - `AsyncMarkdownBlock.tsx:109-111` 执行分支：
       ```tsx
       loading && !html ? (
         <div className={styles.skeletonLine} aria-hidden />
       ) : null
       ```
- **灾难后果**：
  在流式输出结束的刹那，用户眼睁睁看着已经平滑输出完毕的全部富文本内容瞬间消失，整个消息体被一道白光闪烁的骨架屏（`.skeletonLine`）替换，等待 Rust IPC 完成全文编译后才重新注入 innerHTML。这一缺陷彻底击穿了宣称的“零闪烁双缓冲”，造成极度刺眼的界面闪白与跳变。

---

## 2. `useStreamingBlocks` 索引 Key、前序合并与切片缓存击穿 (P1 缺陷)

### 2.1 依赖数组绝对下标的 Key 机制导致级联缓存击穿与 DOM 节点错配
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:65-90`
- **缺陷根因**：
  - 块的唯一键生成策略为 `const key = \`${messageId}-blk-${i}\``，完全绑定于分块结果数组的当前下标 `i`。
  - 在 Markdown 流式生成过程中，前序文本因后续词法的到达可能发生合法重组（例如列表项 `1. ...` 遇到紧跟的 `2. ...` 合并、未闭合 blockquote 或未闭合语法结构被后续符号合并/拆分）。
  - 一旦发生前序块合并或拆分，后续所有块在数组中的索引 `i` 全部发生后移或前移。
  - 索引变动后，`cachedSealed[i]` 检索到的将是原先位于该索引处的旧块，`cached.text === blockText` 检查必然失败，导致当前位置及后续所有原本已封口的块遭遇**级联缓存击穿（Cascade Cache Invalidation）**。
  - React 依据 key 判定节点身份，将原本属于第 3 块的 DOM 节点强制复用给第 2 块，引发 `containerRef` 内部 `textContent` 与 `innerHTML` 的剧烈篡改和污染。

### 2.2 脚注突发回退（Footnote Fallback）引发的全篇坍塌与富文本降级
- **缺陷位置**：
  - `apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts:215-218`
  - `apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:54-61`
- **缺陷根因**：
  - `parseMarkdownIntoBlocks` 开头声明：`if (hasFootnote(markdown)) { return [markdown]; }`。
  - 假设模型在流式输出前 90% 的过程中输出了 15 个段落，前端已稳定分块并完成了 14 个块的 Rust 语法高亮编译与 DOM 封口展示。
  - 当模型在文末突然输出脚注语法（如 `[^1]` 或 `[^note]:`）时，`hasFootnote` 突然命中，`parseMarkdownIntoBlocks` 瞬间由 15 个块坍塌为单个巨型块 `[markdown]`。
  - 原有的 15 个块全部被销毁，新生成的单块处于 `isLastBlock = true, isSealed = false` 的活跃尾块草稿态。
- **灾难后果**：整篇已完成富文本高亮排版的文章在用户眼前突然“闪崩”，瞬间退化为纯文本源码草稿态，伴随巨大的视口抖动。

### 2.3 尾部空白 Token 导致活跃块被提前误判封口（Premature Sealing Race）
- **缺陷位置**：
  - `apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:67-70`
  - `apps/crish-desktop/src/components/chat-message-row/StreamingMarkdownView.tsx:44-46`
- **缺陷根因**：
  - `parseMarkdownIntoBlocks`（基于 marked Lexer）在段落之间会产生独立的 `space` 类型 token（例如 `\n\n`）。
  - `useStreamingBlocks.ts` 判断是否为最后一块的逻辑是 `const isLastBlock = i === totalBlocks - 1`，计算范围包含尾部的空白 token。
  - 而 `StreamingMarkdownView.tsx` 中通过 `rawBlocks.filter((b) => b.text.trim().length > 0)` 过滤掉了空白块。
  - 当文本末尾带有换行产生尾部空 token 时，真正的最后一个内容块在 `useStreamingBlocks` 中因 `i !== totalBlocks - 1` 被提前标记为 `isSealed = true`。
  - 该块在用户实际仍在输入时就被误封口，过早触发 Rust 异步编译，导致紧接着到达的新字符产生缓存错乱与重复渲染竞争。

---

## 3. `useMemo` 与渲染生命周期内 Ref 突变破坏 React 纯函数规范 (P1 缺陷)

### 3.1 `useStreamingBlocks` 在 `useMemo` 内部直接突变 Ref
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:43-46, 49, 58, 94-96`
- **缺陷代码**：
  ```ts
  return useMemo(() => {
    if (prevMessageIdRef.current !== messageId) {
      sealedCacheRef.current = []; // 渲染期突变
      prevMessageIdRef.current = messageId; // 渲染期突变
    }
    if (!fullText) {
      sealedCacheRef.current = []; // 渲染期突变
      return { blocks: [] };
    }
    ...
    sealedCacheRef.current = isStreaming
      ? result.slice(0, totalBlocks - 1)
      : result; // 渲染期突变
    return { blocks: result };
  }, [fullText, isStreaming, messageId]);
  ```
- **违反规则与危害**：
  - 严重违背 React 核心准则（Rules of React: "Never mutate refs or side-effects during render or inside useMemo"）。
  - 在 React 18/19 开启 StrictMode 时，组件 render 会被故意执行两次。第一次执行时修改了 `sealedCacheRef.current`，第二次执行时第 63 行的 `cachedSealed` 读取到的就是第一次脏执行后被污染的切片，导致双执行与单执行行为不一致。
  - 在 React 并发渲染（Concurrent Mode）或渲染被中断丢弃时，Ref 已经被污染，后续恢复渲染将产生不可预测的缓存脏状态。

### 3.2 `MessageContent` 顶层渲染无保护裸写 Ref
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:178-180, 187-193, 208-214, 225-229, 274, 279-280`
- **缺陷代码**：
  ```ts
  if (timelineCacheRef.current.msgId !== msg.id) {
    timelineCacheRef.current = { msgId: msg.id, sig: null, timeline: null };
  }
  if (
    (prevStreamingRef.current && !isThinkingMsg) ||
    (prevStatusRef.current === 'processing' && msg.status !== 'processing')
  ) {
    timelineCacheRef.current.sig = null;
    timelineCacheRef.current.timeline = null;
  }
  ...
  prevStreamingRef.current = streaming;
  prevStatusRef.current = msg.status;
  ```
- **危害**：在函数组件执行体的主干流程中随意读写、重置 Ref，将副作用和状态流变散落在 render 阶段，违背函数纯度约束，在 StrictMode 下产生时序紊乱。

---

## 4. 封口晋升过渡期 `white-space: pre-wrap` 剥离导致的垂直高度剧烈塌缩 (P1 缺陷)

### 4.1 样式类切换时 `white-space` 跌落与纯文本折叠塌陷
- **缺陷位置**：
  - `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:111, 122`
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:265-283`
- **缺陷机理**：
  1. 在 `MarkdownBlockItem.tsx` 中：
     - **活跃尾块（`isActiveTail = true`）** 挂载样式类：`${styles.assistantText} ... ${styles.isStreaming}`。
     - **封口块（`isSealed = true`）** 挂载样式类：`${styles.assistantText} ... md-block-sealed`（**`.isStreaming` 类被剥离**）。
  2. 查看 `ChatMessageRow.module.css`：
     ```css
     .assistantText {
       /* 默认继承，无 white-space: pre-wrap 声明，浏览器默认按照 normal 处理 */
       line-height: 1.65;
       ...
     }
     .assistantText.isStreaming {
       white-space: pre-wrap;
       word-break: break-word;
     }
     ```
  3. 当一个多行段落或代码块从活跃尾块转变为已封口块时：
     - `isSealed` 变为 `true`，JSX 立即卸载 `.isStreaming` 类，容器的 `white-space` 瞬间由 `pre-wrap` 跌落为 `normal`。
     - 此时 Rust 异步编译尚未返回（`html` 为空），DOM 容器内依然是 `useLayoutEffect` 维护的纯文本垫片（`el.textContent = text`）。
     - 在 `white-space: normal` 下，文本中的所有换行符 `\n` 和多余空格被浏览器**强行折叠为单个空格**！
     - 一个原本占据 10 行高度（约 260px）的多行文本，在封口瞬间被折叠为单行（约 26px），造成高达 230px 的垂直高度瞬间暴跌。
     - 几毫秒至几十毫秒后 Rust HTML 返回执行 `el.innerHTML = html`，高度又被突兀地撑回 260px。
- **后果**：每一个 Block 封口晋升时，都会在视口中引发极其恶劣的“剧烈垂直塌陷后弹回”的抽搐抖动。

---

## 5. `parseMarkdownIntoBlocks.ts` 死代码与解析状态机缺陷 (P1/P2 缺陷)

### 5.1 导出的防护函数属于 100% 未调用的死代码（Phantom Guards）
- **缺陷位置**：`apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts:148-178, 183-199`
- **缺陷事实**：
  - `hasIncompleteCodeFence(markdown: string): boolean`（第 148-178 行）
  - `hasTable(markdown: string): boolean`（第 183-199 行）
  - 以上两个函数虽然写了大量的正则表达式和行遍历逻辑并对外导出，但在本文件的核心解析入口 `parseMarkdownIntoBlocks` 中**自始至终未被调用过一次**！
  - 在整个工程的所有业务代码中也完全零调用（仅在单测中自测）。所谓“代码块防撕裂”和“表格边界防护”在分块引擎中实际处于**完全裸奔状态**。

### 5.2 HTML 块单标签盲区与未闭合标签吞噬全文档
- **缺陷位置**：`apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts:241-258, 263-274`
- **缺陷根因**：
  1. **单标签异构嵌套盲区**：
     - 在第 242 行中：`const trackedTag = htmlStack[htmlStack.length - 1];`。
     - 状态机在进入 HTML 块后，仅使用栈顶标签名 `trackedTag` 来统计开闭标签。如果 HTML 块内部包含不同名称的子标签（例如 `<details>\n<div>\n<summary>Title</summary>\n</div>\n</details>`），内部的 `<div>` 和 `<summary>` 不会被压入 `htmlStack`，其闭标签也不会被正确消费，导致 HTML 栈深度计算完全失真。
  2. **流式未闭合 HTML 标签吞噬后续所有块**：
     - 当大模型流式输出开标签（例如 `<details>` 或 `<ai-thinking>`）时，在输出到对应的闭标签之前，`htmlStack.length > 0` 始终成立。
     - 导致后续生成的**所有独立语法块（无论正文段落、代码块、列表还是标题）被无条件全部强行拼接进上一个块**（第 236 行：`mergedBlocks[lastIndex] = prev + currentBlock`）。
     - 分块机制彻底失效，整个文档退化为单块全量刷新的伪流式。

### 5.3 LaTeX `$$` 跨块合并状态机假阳性与污染
- **缺陷位置**：`apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts:276-296`
- **缺陷根因**：
  - `countDoubleDollars(previousBlock)` 仅凭 `$$` 出现的奇偶性判断是否合并。
  - 如果前一个段落中包含货币符号组合或非数学公式的 `$$`（如 `$10 and $$20` 或正则表达式字符串），导致 `prevDollarCount % 2 === 1` 产生假阳性，将后续完全无关的下一个独立段落强制合并。
  - 第 294 行：`if (token.type !== 'space') { previousTokenWasCode = token.type === 'code'; }`。如果代码块和下一个文本块之间穿插了 `space` token，状态传递在遇到复杂 token 序列时存在时序漏洞。

---

## 6. 样式与 DOM 状态解耦缺陷 (P2 缺陷)

### 6.1 `:last-child` 导致的块间距阶跃跳变
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:257-263`
- **缺陷代码**：
  ```css
  .streamingMarkdownRoot > .assistantText {
    margin-bottom: 0.85em;
  }
  .streamingMarkdownRoot > .assistantText:last-child {
    margin-bottom: 0;
  }
  ```
- **缺陷机理**：
  - 尾部活跃块作为 `:last-child` 时 `margin-bottom` 为 `0`。
  - 一旦新块生成，原活跃块变为非 `:last-child`，其底部外边距瞬间被附加 `0.85em`（约 12px）。
  - 这导致每产生一个新块，上方内容就会向下跳跃 12px，破坏了聊天界面的平滑滚动锚定（Scroll Pinning）。

### 6.2 `data-has-html` 原生 DOM 标记与 React 受控状态失步
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:82, 100, 126-130`
- **缺陷机理**：
  - `MarkdownBlockItem` 依赖原生 DOM 属性 `el.getAttribute('data-has-html')` 判断是否保留纯文本垫片。
  - 在异步编译失败（`failed = true`）或优先级变化导致组件重新挂载时，原生属性与 React 内部的 `failed` 状态缺乏受控绑定。
  - 当 `failed` 发生回退渲染 `<pre className="md-text-fallback">` 时，若未清理 DOM 子树，可能与原生 `innerHTML` 残留产生 DOM 结构冲突与撕裂。

---

## 7. 挑刺审查缺陷汇总清单

| 缺陷编号 | 缺陷分类 | 严重级别 | 影响范围 | 核心表现 |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-MD-01** | 完成态切换闪烁 | **P0 致命** | `MessageContent` -> `AsyncMarkdownBlock` | 流式结束切完成态时 100% Cache Miss，整屏闪烁骨架屏 (`.skeletonLine`) |
| **DEF-MD-02** | 索引 Key 缓存击穿 | **P1 严重** | `useStreamingBlocks` | 依赖 `blk-${i}` 下标 Key，前序块增减时引发后续块级联失效与 DOM 错位 |
| **DEF-MD-03** | 脚注回退单块灾难 | **P1 严重** | `parseMarkdownIntoBlocks` | 文末出现 `[^1]` 导致全文档瞬间坍塌为单块，已渲染 HTML 全部退化为纯文本 |
| **DEF-MD-04** | 空白 Token 误封口 | **P1 严重** | `useStreamingBlocks` | 尾部空白 token 导致未完成活跃块被提前标记 `isSealed`，引发编译竞争 |
| **DEF-MD-05** | `useMemo` 内突变 Ref | **P1 严重** | `useStreamingBlocks` / `MessageContent` | 破坏 React 纯函数规范，StrictMode 双执行下产生缓存数据污染 |
| **DEF-MD-06** | `white-space` 塌缩抖动 | **P1 严重** | `MarkdownBlockItem` / `ChatMessageRow.module.css` | 封口瞬间 `.isStreaming` 剥离导致 `white-space` 变为 normal，多行文本剧烈高度塌缩 |
| **DEF-MD-07** | 防护函数死代码 | **P1 严重** | `parseMarkdownIntoBlocks` | `hasIncompleteCodeFence` 与 `hasTable` 100% 未被主逻辑调用，虚假防护 |
| **DEF-MD-08** | HTML 状态机吞噬块 | **P1 严重** | `parseMarkdownIntoBlocks` | 未闭合 HTML 标签导致后续所有独立块被 100% 吞噬合并，流式分块失效 |
| **DEF-MD-09** | LaTeX 误判合并 | **P2 一般** | `parseMarkdownIntoBlocks` | `$$` 奇偶性误判非数学符号，强行合并独立段落 |
| **DEF-MD-10** | `:last-child` 间距抖动 | **P2 一般** | `ChatMessageRow.module.css` | 块晋升导致 `margin-bottom` 0 -> 0.85em 突变，破坏滚动锚定 |
| **DEF-MD-11** | DOM 属性状态失步 | **P2 一般** | `MarkdownBlockItem` | 原生 `data-has-html` 绕过 React 协调引擎，重试回退时存在 DOM 撕裂隐患 |
