# 深度审查报告：对话流式渲染与超大文档视口虚拟化体系改造评估 (Phase 0 ~ Phase 7)

> **审查基准与规范**：
> - **基准提交**：BATCH-MD-PHASE0 至 PHASE7 关键改动（commit `d32518a2c`, `2dda1c561`, `9d8eadeab`, `65c2c4c90`, `609f49e27`, `bf3d60fa3`）
> - **核心代码范围**：
>   - 聊天流式渲染：`apps/crish-desktop/src/components/chat-message-row/` (`StreamingMarkdownView.tsx`, `MarkdownBlockItem.tsx`, `useStreamingBlocks.ts`)
>   - 文档视口虚拟化：`apps/crish-desktop/src/components/markdown/` (`VirtualMarkdownBlockList.tsx`, `MarkdownDocumentView.tsx`, `MarkdownBlockList.tsx`, `MarkdownBlock.tsx`, `MarkdownSurface.tsx`)
>   - 调度与底层抽象：`apps/crish-desktop/src/api/markdown/` (`markdownBlockScanner.ts`, `markdownChunker.ts`, `markdownDraftCloser.ts`, `useMarkdownRender.ts`), `apps/crish-desktop/src/api/` (`markdownRenderScheduler.ts`, `markdownResultCache.ts`, `rustCore.ts`), `apps/agent-workbench/src-tauri/src/markdown_commands.rs`, `crates/conex-markdown/`
>   - 通用测量设施：`packages/editor-kit/src/viewport/` (`HeightMap.ts`, `ViewportQuery.ts`), `apps/crish-desktop/src/utils/ResizeObserverManager.ts`
> - **审计原则**：以最新提交的真实代码实现与测试事实为唯一准绳，秉持“反退避”与“立体验证”纪律，客观评估重构突破，尖锐指出依然存在的硬伤、潜在隐患与新增风险。

---

## 一、综合评估与审计结论摘要

### 1.1 总体架构裁决

在经历 BATCH-MD-PHASE0 至 PHASE7 的系统性重构后，本仓库的 Markdown 渲染管线经历了**脱胎换骨式的架构精简与权威收敛**。累计剔除逾 14,000 行历史冗余与过度设计代码，彻底终结了前端自研简易解析器与 Rust 内核长期割裂的双轨混乱局面。

1. **重大正面突破**：
   - **双轨历史彻底终结**：清退了前端所有基于 `marked`、Web Worker AST 序列化、TS 正则拼装与回退渲染逻辑，确立 Rust `conex-markdown` 为全系统**唯一权威真相源（SSOT）**。
   - **通信闭环重塑**：正式连通并激活了此前长期悬空的 `core_md_render_stream`（跳过 Syntect 重复高亮开销），并通过 `markdownRenderScheduler` 微任务批处理彻底消除了历史消息展开时的“数百次单条 IPC 轰炸风暴”。
   - **渲染破防点清退**：消除了 `_virtualClosedText` 与 `_timeline` 僵尸代码，流式 `isStreaming` 状态被严格限制于活跃尾块（Active Tail），历史封口块在流式终止时实现了真正意义上的 **0 次重渲染**。
   - **大文档富文本化**：废黜了“超过 256KB 强制退化为纯文本代码查看器（VirtualPlainCodeViewer）”的投降策略，引入基于 `HeightMap` 的富文本分块虚拟化视图。

2. **严峻遗留硬伤与新增隐患**：
   - **【P0】流式高速吐字假性假死（UI Starvation）**：在 `useStreamingMarkdownResult` 中，采用过于严苛的 `textRef.current !== current` 丢弃机制。在高速吐字场景（80~100+ tokens/s）下，每一次 IPC 返回时最新文本均已前移，导致**所有返回的渲染帧被 100% 静默丢弃**，UI 界面长达数秒停滞在纯文本兜底态，直至大模型停顿或结束才瞬间暴冲刷新。
   - **【P0】虚拟滚动严重视口跳跃（Scroll Jitter）**：`VirtualMarkdownBlockList` 采用粗糙字符估算（`length * 0.55`）且**完全缺失视口滚动锚定（Scroll Anchoring）与偏移物理补偿**。当上方块渲染异步 Mermaid、复杂 KaTeX 矩阵或图片导致实测高度突增时，下方可见内容发生数十至上百像素的剧烈跳动；向上回滚时更会产生不可控的内容推挤。
   - **【P1】双重虚拟化机制冲突**：在 JS 绝对定位窗口化（`top: offsetOf(i)`）的基础上，CSS 依然给 `.md-virtual-chunk` 挂载了 `content-visibility: auto; contain-intrinsic-size: auto 240px;`。导致视口外 Overscan 块在首轮 ref 回调中读出伪高度（240px）并污染 HeightMap，进入视口时二次触发重排。
   - **【P1】测试资产严重破防**：重构在清理废弃代码的同时，误伤删除了 `StreamingMarkdownView.test.tsx` (315行)、`MarkdownBlockItem.test.tsx` (774行)、`useStreamingBlocks.test.ts` (191行) 等数百行测试资产，新增核心组件 `VirtualMarkdownBlockList` 单测覆盖率为 0。

### 1.2 改造前后核心架构硬碰硬对比表

| 评估维度 | 改造前 (Commit 前历史状态) | 改造后 (PHASE0~PHASE7 最新状态) | 状态裁决 |
| :--- | :--- | :--- | :--- |
| **解析真相源 (SSOT)** | 前端 `marked` + TS 正则状态机 + Worker + Rust 双轨分裂 | 统一由 Rust `conex-markdown` 权威输出 HTML 外壳 | **彻底突破 (SSOT 确立)** |
| **流式活跃尾块渲染** | 前端 TS DFA 状态机切分 + 逐 cell IPC 狂暴分发 | 纯内存草稿补全 + `core_md_render_stream` (跳过 Syntect) | **显著收敛 (单轨推进)** |
| **流式 IPC 管道频次** | 无节流并发狂发（N×M 单元格并发几百个 IPC） | 串行锁（`inFlight`）+ 33ms 轮询时钟节流（单并发） | **有效受控 (但引发生命周期丢帧)** |
| **历史封口块 React.memo** | 全局 `isStreaming: true->false` 导致历史块全量破防重渲染 | 仅活跃尾块持有 `isStreaming`，历史封口块 0 次重渲染 | **彻底修复** |
| **投机闭合与时间轴** | `_virtualClosedText`, `_timeline` 悬空闲置（100% 僵尸代码） | 彻底删除僵尸属性；转为轻量 `closeMarkdownDraftForRender` | **彻底清洗** |
| **GFM 表格流式排版** | `table-layout: auto`（列宽逐字横向拉扯、果冻抖动） | `table-layout: fixed` + CSS 最小列宽变量约束 | **彻底解决** |
| **超 256KB 大文档策略** | 强制熔断为 `VirtualPlainCodeViewer`（全降级为代码文本） | 拆分 ~8KB chunks + `VirtualMarkdownBlockList` 窗口化 | **架构升级 (富文本保留)** |
| **大文档滚动稳定性** | 纯文本查看器使用 CM6，无视口跳动 | 缺失视口锚定，异步图表/公式加载引发严重 Scroll Jitter | **新增缺陷 (稳定性劣化)** |
| **测试资产保护** | 存有数百行流式与块状态单测 | 伴随旧逻辑物理清退，相关组件测试资产近乎真空 | **红线违规 (测试缺失)** |

### 1.3 核心问题与潜在风险红线清单

| 编号 | 缺陷问题描述 | 涉及代码位置 | 严重级别 | 触发场景与影响 |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-01** | **流式 Token 推进引发 UI 饥饿与卡死** | [`useMarkdownRender.ts:190`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/useMarkdownRender.ts#L190) | **P0（体验崩溃）** | 80+ tokens/s 高速生成时，每次 IPC 完成最新文本均已更新，返回结果被全部 drop，界面呈现长时间假死，停顿瞬间才暴闪刷出。 |
| **BUG-02** | **虚拟滚动缺乏滚动锚定引发视口跳跃** | [`VirtualMarkdownBlockList.tsx:85-90`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx#L85-L90) | **P0（视觉跳闪）** | 文档内含 Mermaid、KaTeX、图片时，上方位移块异步高度膨胀使下方块 `top` 暴涨，`scrollTop` 未补正，阅读焦点瞬间被弹飞。 |
| **BUG-03** | **JS 窗口化与 CSS `content-visibility` 冲突** | [`markdown-typography.css:1007`](file:///C:/Software/conex/apps/crish-desktop/src/styles/markdown-typography.css#L1007), [`VirtualMarkdownBlockList.tsx:108`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx#L108) | **P1（逻辑自缚）** | Overscan 块在视口外被 Blink 判定为 skipped，首测读取 240px 伪尺寸回填 HeightMap，滚入视口展开时产生二次布局突变。 |
| **BUG-04** | **无空行连续列表无限膨胀为单体巨块** | [`markdownBlockScanner.ts:271-294`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/markdownBlockScanner.ts#L271-L294) | **P1（性能退化）** | 词法扫描器仍未对无序/有序列表按条目切块，大模型输出超长无空行列表时，数百行整体留驻 Active Draft 尾块中反复序列化重跑。 |
| **BUG-05** | **ResizeObserver 同步读取与重排风暴风险** | [`VirtualMarkdownBlockList.tsx:108`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx#L108), [`ResizeObserverManager.ts:187`](file:///C:/Software/conex/apps/crish-desktop/src/utils/ResizeObserverManager.ts#L187) | **P1（性能隐患）** | 测量回调中直接读取 `getBoundingClientRect()` 触发强制同步重排；普通文档场景下未启用 `SlicedTaskFlusher` 8ms 分片预算，存在循环告警隐患。 |
| **BUG-06** | **流式与虚拟化测试资产大面积丢失** | `chat-message-row/` 与 `components/markdown/` | **P1（质量断层）** | `VirtualMarkdownBlockList.tsx` 单测覆盖为 0；`MarkdownBlockItem.test.tsx` 与 `StreamingMarkdownView.test.tsx` 被整根拔除，违反测试资产保护铁律。 |

---

## 二、改动效果深入评估（正面突破与架构净收敛）

### 2.1 双轨渲染彻底物理清退：marked / Worker AST / TS 正则回退的彻底拔除

在 commit `bf3d60fa3` 中，开发团队以极大的决心执行了代码大扫除（删除 14,214 行代码，新增 721 行），物理拔除了大量长期寄生在前端主线程与 Web Worker 中的历史包袱：
1. **彻底清理前端 `marked` 依赖**：
   - 依赖项已从 `package.json` 彻底删除；
   - 物理删除了 `apps/crish-desktop/src/api/markdownRender.ts` 与 `markdownRenderAsync.ts`；
   - 彻底消除了历史上当 Rust IPC 失败时试图用 `marked.parse` + 简易正则做前端客户端“假兜底”的逃避逻辑。
2. **物理清退前端增量状态机与旧式 Worker**：
   - 删除了 `IncrementalBlockSplitter.ts`、`IncrementalMarkdownSession.ts`、`StreamingGfmTableParser.ts` 等 10 余个自研的、充满死代码与边界缺陷的 TS 增量编译器组件；
   - 拔除了 `markdown-render-standalone.ts` 中基于 Worker `postMessage` 传输巨大 AST 对象的序列化瓶颈，彻底终结了结构化克隆（Structured Clone）引发的主线程卡顿。

### 2.2 通信链路的统一与收敛（SSOT 确立）

通信链路经过重塑后，形成了一条高度清晰、严谨收敛的单向数据流管道：

```
[大模型 SSE 数据流]
        │
        ▼
useStreamingBlocks (MarkdownBlockScanner 仅做行边界词法扫描)
        ├─────────────────────────────┬───────────────────────────────┐
        ▼                             ▼                               ▼
[历史已封口块 0..N-1]            [封口瞬间切换过渡]              [活跃尾块 Active Draft]
        │                             │                               │
useMarkdownResult               (保持 streamResult.html)         useStreamingMarkdownResult
        │                             │                               │ (33ms tick + inFlight 锁)
markdownRenderScheduler               ▼                               ▼
 (微任务合并 + LRU 缓存)       [权威 HTML 到达后无缝置换]        closeMarkdownDraftForRender
        │                                                             │
        ▼                                                             ▼
core_md_render_batch (Tauri IPC)                             core_md_render_stream (Tauri IPC)
        │                                                             │ (跳过 Syntect 高亮)
        └─────────────────────────────┬───────────────────────────────┘
                                      ▼
                        MarkdownSurface (可信 HTML 挂载)
                                      │
                         IslandPortal (Math / Mermaid 注水)
```

#### 关键机制突破：
1. **Tauri IPC 三通道清晰分工**（`apps/agent-workbench/src-tauri/src/markdown_commands.rs`）：
   - `core_md_render`：单文本权威渲染（带 Rust 内部 LRU 缓存）；
   - `core_md_render_batch`：多文本批量原子渲染（在 `tokio::task::spawn_blocking` 中一次性处理），专供会话历史加载与文档批量解析；
   - `core_md_render_stream`：流式渲染模式，**在 Rust 层显式跳过 Syntect 语法高亮开销**，仅输出标准 HTML 外壳结构与语义标签，极大节约了活跃打字过程中的 CPU 开销。
2. **微任务批量调度器消除 IPC 队列风暴**（[`markdownRenderScheduler.ts`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdownRenderScheduler.ts)）：
   - 当会话加载或文档挂载时，组件并发调用 `useMarkdownResult`；
   - `requestMarkdownResult` 不再立即触发 IPC，而是压入 `queue` 并触发 `scheduleFlush`（基于 `queueMicrotask`）；
   - 在同一个事件循环微任务中，将最多 64 个块（或 256KB）打包为单次 `core_md_render_batch` 调用；
   - 经实测，历史包含 30 条消息（约 300 个块）的首屏加载，IPC 往返从原本的 **300 次锐减至 4~5 次**，彻底清除了 Tokio 阻塞线程池被打满导致的系统假死隐患。

### 2.3 历史死代码与协调破防点的清算

重构针对之前报告披露的技术毒点进行了外科手术式的精准清算：

1. **彻底清除僵尸属性**：
   - 彻底删除了 `AdaptiveAnimateTimeline.ts` 与 `MarkdownBlockItem.tsx` 中被重命名为 `_timeline` 的假时间轴参数；
   - 彻底删除了 `SpeculativeVirtualCloser.ts` 与 `MarkdownBlockItem.tsx` 中被参数下划线遗弃的 `_virtualClosedText`；
   - 转为纯函数模块 [`markdownDraftCloser.ts`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/markdownDraftCloser.ts) 中的 `closeMarkdownDraftForRender`，在内存中精准修补未闭合的代码围栏（```）、数学公式（$$）与未闭合表格分隔线，并真正传给 `core_md_render_stream` 执行渲染。
2. **根治流式终态 React.memo 协调破防**：
   - 在 [`StreamingMarkdownView.tsx:60-62`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingMarkdownView.tsx#L60-L62) 中：
     ```typescript
     const isLast = index === blocks.length - 1;
     const blockIsStreaming = isStreaming && isLast && !block.isSealed;
     ```
   - 只有未封口且处于最后的活跃尾块才传入 `isStreaming=true`。
   - 所有已封口历史块的 `isStreaming` 在流式运行期间恒为 `false`，在流式终态完成瞬间依然恒为 `false`。
   - `markdownBlockItemPropsEqual` 的 `prev.isStreaming === next.isStreaming` 比较在历史块上始终成立，**彻底终结了“流式一结束，全屏历史消息集体闪烁重渲染”的恶性缺陷**。
3. **尾块封口瞬间的双缓冲无缝过渡**：
   - 在 [`MarkdownBlockItem.tsx:43-45`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx#L43-L45) 中：
     ```typescript
     const html = isActiveTail
       ? streamResult.html
       : staticResult.html || streamResult.html;
     ```
   - 当活跃尾块被封口时，`isActiveTail` 变 `false`，此时静态权威 HTML 刚进入批量调度队列尚未返回（`staticResult.html === ''`）；
   - 代码优雅地利用 `|| streamResult.html` 维持住最后的一帧流式 HTML，直到权威带语法高亮的 HTML 返回后再平滑置换，**彻底消除了封口瞬间出现的白屏瞬断**。
4. **GFM 表格流式排版稳定性**：
   - 在 `markdown-typography.css:563` 中，全局强制约束 `:is(.md-table, table) { table-layout: fixed; }`；
   - 配合 `markdownDraftCloser.ts` 的 `completeTableSeparator`，彻底拔除了此前单行表格 0 高度隐藏坍塌与逐字吐字引发的列宽“果冻抖动”。

### 2.4 256KB 纯文本投降熔断器的废黜

在 [`MarkdownDocumentView.tsx`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx) 中：
- 删除了原本粗暴的 `DEFAULT_LARGE_FILE_THRESHOLD_BYTES = 256 * 1024` 与 `<VirtualPlainCodeViewer>` 纯文本降级逻辑；
- 设立了以字符数为阈值的柔性分流基准：`VIRTUALIZE_THRESHOLD_CHARS = 128 * 1024`（128KB）；
- 通过 `chunkMarkdown(content, 8_000)` 将 Markdown 沿词法块边界聚合为约 8KB 大小的渲染 chunk：
  - $\le 128\text{KB}$ 时，使用常规 `MarkdownBlockList` 静态批量挂载；
  - $> 128\text{KB}$ 时，无缝切入 `VirtualMarkdownBlockList` 进行视口窗口化挂载；
- 用户打开 500KB~2MB 的大型技术方案、API 文档时，**看到的始终是保持排版结构、代码高亮与公式渲染的完整富文本**，不再断崖式退化为单色代码。

---

## 三、大文档视口虚拟化体系深层缺陷审查 (`VirtualMarkdownBlockList`)

虽然 256KB 熔断器被成功废除，但深入分析最新实现的 [`VirtualMarkdownBlockList.tsx`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx)，可以发现其内部实现相当简陋，缺乏生产级视口虚拟化必备的几何防御能力。

### 3.1 真实渲染机制与测量流水线解构

`VirtualMarkdownBlockList` 的运作核心依赖于两个基础抽象：
1. **`HeightMap`（前缀和高度索引图）**：来自 `@crish/editor-kit`，维护平铺数组 `slots` 与前缀和 `prefix[i] = sum(slots[0..i-1])`。提供 $O(\log N)$ 的二分查找 `indexAt(offsetPx)` 与 $O(1)$ 的 `offsetOf(index)`。
2. **`queryViewport`（视口切片计算器）**：根据 `scrollTop` 与 `viewportHeight` 计算当前视口跨越的 chunk 索引范围，并向上下各扩充 `overscan = 4` 个 chunk。

组件采用绝对定位流（Absolute Windowing）：
```tsx
<div className="md-virtual-list" style={{ height: map.totalHeight(), position: 'relative' }}>
  {window.indices.map((index) => (
    <div
      key={chunk.id}
      ref={measureCallbacks[index]}
      className="md-virtual-chunk"
      style={{
        position: 'absolute',
        top: map.offsetOf(index),
        left: 0,
        right: 0,
      }}
    >
      <MarkdownBlock text={chunk.text} variant={variant} />
    </div>
  ))}
</div>
```

### 3.2 致命隐患：缺乏视口滚动锚定（Scroll Anchoring）引发的视口跳跃（Scroll Jitter）

这是当前虚拟滚动实现中最严重的 **P0 体验杀手**。

#### 1. 根本机理分析
在绝对定位模式下，每个 chunk 的纵向位置由 `top: map.offsetOf(index)` 严格决定。而 `offsetOf(k)` 是其上方所有 chunk `0..k-1` 测量高度的累加和（Prefix Sum）。
初始状态下，所有 chunk 均处于“未测量估算值”（Estimated）状态：
```typescript
// VirtualMarkdownBlockList.tsx:30-32
function estimateChunkHeight(text: string): number {
  return Math.max(80, Math.min(2400, Math.round(text.length * 0.55)));
}
```

当用户阅读文档中后段（例如当前 `scrollTop = 8000px`，正处于 chunk 12）时：
- 视口上方的 chunk 0..8 在挂载或发生动态变化前，在 `HeightMap` 中记录的是估算高度；
- 一旦用户向上轻微滚动，或上方的某个 chunk 内的动态异步内容加载完成（如 Mermaid 渲染出 800px SVG、KaTeX 矩阵加载完成、未指定尺寸的 `<img>` 标签图片下载完成）；
- 该 chunk 的 DOM 节点高度发生巨幅突变，例如由估算的 110px 变为实测的 800px（$\Delta = +690\text{px}$）；
- `measureChunk` 调用触发：
  ```typescript
  // VirtualMarkdownBlockList.tsx:85-90
  const measureChunk = useCallback((index: number, height: number) => {
    if (height <= 0) return;
    if (heightMapRef.current?.measure(index, height)) {
      setRevision((revision) => revision + 1);
    }
  }, []);
  ```
- `HeightMap.measure` 重算前缀和，导致**位于其后的所有 chunk（包括用户当前正眼看着的 chunk 12）的 `top` 偏移量瞬间被整体下推了 690px！**

#### 2. 灾难后果：
- **浏览器视口的 `element.scrollTop` 依然保持在 8000px，未做任何补偿！**
- 用户原本正在阅读的文字，在没有任何用户手势操作的情况下，**瞬间被向屏幕下方暴击推离 690px**（相当于屏幕直接跳屏下移了一大半）；
- 用户视野中突然变成了 chunk 10 或 chunk 11 的内容，产生极度突兀的画面断裂感（Scroll Jitter）；
- 更严重的是**向上回滚（Scroll Up）体验**：当用户试图向上滚动时，原本未挂载的上方 chunk 逐一挂载并实测。每一个挂载的真实高度只要大于预估，就会对后续节点施加向下的位移偏移，导致**滚动条往下弹、视口内容向下抗拒，用户手势与视觉运动方向完全相反！**

> [!CAUTION]
> **架构事实对比**：在 `apps/crish-desktop/src/api/virtualScrollAnchor.ts` 中，本仓库早已针对聊天消息列表封装了极其完善的 `captureScrollAnchor` 与 `compensateScrollTop` 算法。
> 然而，`VirtualMarkdownBlockList` **完全没有集成任何滚动锚点保护机制**，在处理长篇技术文档或图表混排文档时处于“裸奔”状态。

### 3.3 机制冲突：JS 绝对定位窗口化 vs CSS `content-visibility: auto` 的双重虚拟化陷阱

审查样式文件 [`apps/crish-desktop/src/styles/markdown-typography.css:1006-1009`](file:///C:/Software/conex/apps/crish-desktop/src/styles/markdown-typography.css#L1006-L1009)：
```css
.md-virtual-chunk {
  content-visibility: auto;
  contain-intrinsic-size: auto 240px;
}
```

这里暴露出一个极其隐蔽但致命的**设计理念冲突与逻辑自缚**：

1. **JS 窗口化（DOM Windowing）的本质**：
   `VirtualMarkdownBlockList` 已经通过 React 严格控制了 DOM 节点的挂载与卸载，只有 `window.indices`（可视区 + 4 个 overscan chunk）会被放入 DOM 树中。视口较远处的节点早已不在 DOM 中。
2. **CSS `content-visibility: auto` 的介入破坏了尺寸测量**：
   - 处于 `overscan` 边缘的 chunk（例如视口上方 -2 屏的缓冲块）已经被 React 挂载到了 DOM 中；
   - 但因为其物理位置在当前视口之外，Chromium/Blink 渲染引擎的 `content-visibility: auto` 规则生效，**判定该元素为不可见（Skipped），跳过对其内部子树的 Layout 与 Paint**；
   - 此时，该元素的物理渲染尺寸直接回退至 `contain-intrinsic-size: auto 240px`，即**恒定 240px**！
   - 当 React 完成 commit 执行 `measureCallbacks[index]` 时：
     ```typescript
     node.getBoundingClientRect().height
     ```
     读出的不是该 Markdown chunk 的真实排版高度，而是 **240px**！
   - `measureChunk(index, 240)` 将这个虚假的 240px 作为“实测确凿高度（`estimated: false`）”写回了 `HeightMap`！
   - 当用户滚动滚轮，该 chunk 真正移动到视口可见区域时，Blink 突然激活该元素开始真实排版（实际高度可能是 1500px）。`ResizeObserver` 此时被迫再次触发，高度从 240px 骤变到 1500px，引发二次剧烈重排！

> [!WARNING]
> **架构红线**：虚拟滚动方案中，**JS Windowing 与 CSS `content-visibility: auto` 绝对不能在同一容器节点上叠放**。
> 既然已经采用了 JS 维度的 DOM Windowing + ResizeObserver 动态测高，就必须对 `.md-virtual-chunk` 剔除 `content-visibility: auto`，否则预估缓冲层将被 Chromium 的假尺寸劫持，引发测量连锁紊乱。

---

## 四、流式 Token 推进与 IPC 性能极限深层审查

### 4.1 活跃尾块（Active Tail）的最新驱动链路剖析

在旧管线被删除后，流式生成的活跃尾块由 `useStreamingMarkdownResult` 独立承载。审查 [`useMarkdownRender.ts:147-220`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/useMarkdownRender.ts#L147-L220)：

```typescript
export function useStreamingMarkdownResult(
  text: string,
  variant: MarkdownVariant,
  enabled = true
): MarkdownRenderState {
  ...
  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let timer: number | null = null;
    let inFlight = false;
    let lastAttempted = '';

    const tick = () => {
      if (stopped) return;
      const current = textRef.current;
      if (!current.trim()) {
        timer = window.setTimeout(tick, 33);
        return;
      }
      if (inFlight || current === lastAttempted) {
        timer = window.setTimeout(tick, current.length > 32_000 ? 120 : 33);
        return;
      }

      inFlight = true;
      lastAttempted = current;
      const source = closeMarkdownDraftForRender(current);
      const sourceVariant = variantRef.current;

      void renderMarkdownStream(source, sourceVariant)
        .then((result) => {
          if (stopped || textRef.current !== current) return; // 【致命陷阱】
          if (result) {
            setState({
              html: result.html,
              truncated: result.truncated,
              loading: false,
              failed: false,
            });
          } else {
            setState((prev) => ({ ...prev, loading: false, failed: true }));
          }
        })
        .finally(() => {
          inFlight = false;
        });

      timer = window.setTimeout(tick, current.length > 32_000 ? 120 : 33);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled]);
```

### 4.2 核心缺陷挖掘：过度严苛的 `textRef.current !== current` 导致“流式 UI 饥饿与假死”（UI Starvation）

这里存在一个极易被忽略、但在真实大模型高速生成场景下必然引爆的 **P0 逻辑漏洞**！

#### 1. 漏洞触发链还原：
设大模型以 80 tokens/s 的速度吐字（现代本地端侧小模型或云端流式主力模型的常见速度，平均每 12.5ms 到达一个 token）：
1. **$T = 0\text{ms}$**：`tick` 执行，`current = "Hello"`，`inFlight = true`，发起 `core_md_render_stream("Hello")` 的 Tauri IPC；
2. **$T = 12.5\text{ms}$**：新 token 到达，React 更新，`textRef.current = "Hello world"`；
3. **$T = 25\text{ms}$**：新 token 到达，`textRef.current = "Hello world from"`；
4. **$T = 30\text{ms}$**：Tauri IPC 往返完成（Named Pipe + Rust 处理共耗时约 30ms），Promise 解析进入 `.then(...)`：
   ```typescript
   if (stopped || textRef.current !== current) return;
   ```
   - 此时，`textRef.current` 是 `"Hello world from"`；
   - 而入参闭包中的 `current` 是 `"Hello"`；
   - **`textRef.current !== current` 判定为 TRUE！代码直接 `return`！**
   - **本次耗费 CPU 与 IPC 渲染出的 HTML 被彻底丢弃，`setState` 完全未被调用！**
5. **$T = 33\text{ms}$**：下一个 `tick` 触发（`inFlight` 在第 30ms 刚刚被释放）：
   - `current = textRef.current = "Hello world from"`；
   - 发起第二次 `core_md_render_stream`；
6. **$T = 37.5\text{ms}$**：新 token 到达，`textRef.current` 再次前移...
7. **$T = 60\text{ms}$**：第二次 IPC 返回，`textRef.current !== current` 再次命中！**结果再次被静默丢弃！**

#### 2. 真实物理表现：
只要大模型以高于 IPC 往返周期的频率连续吐字，**每一次返回的权威渲染结果都因为被判定为“已过时（Stale）”而全部被就地丢弃！**
- 用户的界面在此期间会**完全定格在纯文本 fallback 状态，没有任何富文本排版更新，如同卡死**；
- 只有等到大模型遇到标点符号、网络拥塞、思考链结束或彻底输出完毕发生停顿（Pause $\ge 30\text{ms}$）时，下一次 IPC 返回才侥幸满足 `textRef.current === current`，界面突然“暴闪式”一次性刷出此前积累的所有内容！

#### 3. 根因剖析与正确做法：
作者试图用 `textRef.current !== current` 防止并发调用的“乱序覆盖”（Race Condition）。
然而，**外部的 `inFlight` 标志位已经彻底实现了调用的强串行化（同一时刻至多有 1 个在途 IPC）！**
在严格串行系统里，刚刚完成返回的渲染结果**必然比当前屏幕上正在展示的结果更加靠前、更加完整**。哪怕它没有包含最新到达的那一两个单词，也必须立即刷新到界面上以保证打字机的流畅性，绝不能因为落后了一两个 token 就将整个渲染帧丢弃！

### 4.3 列表与连续语法块切分盲区

在 [`markdownBlockScanner.ts:271-294`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/markdownBlockScanner.ts#L271-L294) 中：
```typescript
// 6. 段落 / 列表 / 表格：累积到空行或独立块起始
for (let i = firstUnscannedLine; i < scanLimit; i += 1) {
  const line = this.lines[i] ?? '';
  if (line.trim().length === 0) { ... break; }
  if (
    atxHeadingPattern.test(line) ||
    codeFenceOpenPattern.test(line) ||
    thematicBreakPattern.test(line)
  ) { ... break; }
}
```
- 扫描器仅将空行、ATX 标题、代码围栏和分割线视为独立块终止边界；
- **对于无序列表（`- item`）、有序列表（`1. item`）、任务清单（`- [ ]`），完全没有逐项封口逻辑**；
- 若模型生成长达 200 行的技术条目清单，只要条目之间没有空行，切分器将其**整体视为一个普通段落块**；
- 该巨型列表必须全量滞留在 Active Draft 尾块中，在长达几十秒的时间里不断被完整塞入 `closeMarkdownDraftForRender` 并全量向 Rust 发送渲染请求，丧失了块级增量封口的收益。

---

## 五、ResizeObserverManager 集成与重排风暴风险

### 5.1 循环触发与 `ResizeObserver loop limit exceeded` 风险剖析

审查 [`ResizeObserverManager.ts`](file:///C:/Software/conex/apps/crish-desktop/src/utils/ResizeObserverManager.ts) 与 `VirtualMarkdownBlockList.tsx` 的结合点：

1. **父容器与子元素在同一管理器内级联监听**：
   - 在 `VirtualMarkdownBlockList.tsx:75` 中：
     ```typescript
     roManager.observe(element, updateHeight); // 监听视口外层容器 ScrollArea
     ```
   - 在 `VirtualMarkdownBlockList.tsx:110` 中：
     ```typescript
     roManager.observe(node, onResize); // 监听内部每一个渲染出来的 chunk
     ```
   - 所有的元素全部注册在 `ResizeObserverManager` 单例的同一个原生 `ResizeObserver` 实例下。
2. **强制同步布局（Forced Synchronous Layout）**：
   - 观察 `onResize` 实现：
     ```typescript
     const onResize: ResizeCallback = () => {
       measureChunk(index, node.getBoundingClientRect().height);
     };
     ```
   - 在原生 `ResizeObserver` 的分发回调执行栈中，直接调用了 `node.getBoundingClientRect()`！
   - 紧接着，`measureChunk` 触发 `setRevision(r => r + 1)`，导致 React 重新执行并更新 DOM 样式（修改 `.md-virtual-list` 的 `style.height` 以及兄弟节点的 `style.top`）；
   - 如果 `.md-virtual-list` 的高度撑破视口，导致浏览器向外层 `ScrollArea` 注入纵向滚动条，**外层视口的宽度会被立刻挤压变窄 10~15px**；
   - 宽度变窄导致视口内所有处于折行模式的 Markdown 文本次生折行，再次引发高度变动！
   - 根据 W3C ResizeObserver 规范，在同一个动画帧微任务循环中，浅层/深层节点相互牵引形变，且在通知周期内改写布局，浏览器将直接触发：
     `ResizeObserver loop completed with undelivered notifications` 告警。

### 5.2 窗格冻结保护（`isElementSuspended`）在普通文档场景下的空转

`ResizeObserverManager` 内部虽然配备了一套非常先进的 [`SlicedTaskFlusher`](file:///C:/Software/conex/apps/crish-desktop/src/utils/ResizeObserverManager.ts#L14)（单帧 8.0ms 时间预算排空引擎）：
```typescript
// ResizeObserverManager.ts:184-188
if (this.isElementSuspended(entry.target)) {
  this.flusher.enqueue(entry.target);
} else {
  this.dispatch(entry);
}
```
**但是检查其启用前提**：
- `isElementSuspended` 必须要求目标元素归属于某个处于 `suspendedPaneIds` 中的窗格（即仅在用户拖拽分屏分界线、分屏动画冻结时才会被装配）；
- 在日常的大文档浏览、滚动、富文本注水场景中，`suspendedPaneIds` 集合始终为空！
- **其结果是**：`VirtualMarkdownBlockList` 的所有 resize 事件**完完全全绕过了 8ms 时间分片预算引擎**，每个 chunk 的形变全部以 `this.dispatch(entry)` 裸奔同步执行，一旦数十个复杂 chunk 同时排版渲染，依然存在主线程单帧掉帧与卡顿的风险。

---

## 六、工程质量与测试资产保护审查（红线核查）

遵循根目录 `AGENTS.md` §9“测试资产保护铁律”，我们对本次重构涉及的测试套件进行了严苛复核。

### 6.1 删减式重构导致测试资产严重缺失

在 commit `bf3d60fa3` 与 `65c2c4c90` 中，出现了大量测试文件的被动删除与断代：

| 被删除/缺失的测试资产文件 | 历史行数 | 历史测试覆盖职责 | 当前现状与问题 |
| :--- | :--- | :--- | :--- |
| `MarkdownBlockItem.test.tsx` | 774 行 | 覆盖块的 Sealed/Active 切换、Props 比对防重渲、降级容灾 | **被完全删除，无对应新单测** |
| `StreamingMarkdownView.test.tsx` | 315 行 | 覆盖流式块分发、isStreaming 隔离、容器类名与属性透传 | **被完全删除，无对应新单测** |
| `useStreamingBlocks.test.ts` | 191 行 | 覆盖流式文本增量追加、前缀复用、冷热路径切换断言 | **被完全删除，无对应新单测** |
| `VirtualMarkdownBlockList.test.tsx` | - | 新增的超大文档视口虚拟化列表核心组件 | **从未编写过单测（覆盖率为 0）** |

### 6.2 集成测试的假象脱水

审查当前针对文档视图的唯一测试文件 [`MarkdownDocumentView.test.tsx`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.test.tsx)：
```typescript
vi.mock('./VirtualMarkdownBlockList', () => ({
  VirtualMarkdownBlockList: (props: { chunks: { text: string }[] }) => (
    <div data-testid="virtual-list">{props.chunks.length}</div>
  ),
}));
```
- 测试在头部直接使用 `vi.mock` 将 `VirtualMarkdownBlockList` **整体替换成了一个返回假 DOM 的空壳组件**！
- 所谓的“通过单元测试”，仅仅测试了 `content.length > 128KB` 时是否渲染了带 `data-testid="virtual-list"` 的空 `div`；
- 对于 `VirtualMarkdownBlockList` 内部真正的 HeightMap 测高计算、ResizeObserver 注册注销、滚动视口切片、绝对定位偏移量等**核心生产逻辑，在自动化测试防护网中完全裸奔！**

---

## 七、架构演进与修复建议路线图

针对上述深入审查揭示出的硬伤与缺陷，提出以下具体的架构收敛与修复路径：

### 7.1 拔除流式 UI 饥饿漏洞（优先修复 BUG-01）

修改 [`apps/crish-desktop/src/api/markdown/useMarkdownRender.ts`](file:///C:/Software/conex/apps/crish-desktop/src/api/markdown/useMarkdownRender.ts#L190)：
- 废除 `textRef.current !== current` 这种粗暴的丢弃检查；
- 维护单调递增的渲染版本号或时间戳（如 `renderSeq`）。每次调用 `renderMarkdownStream` 附带递增序列号；
- 只要 Promise 返回的结果版本高于当前界面已呈现的版本（即该结果比当前画面更新），就必须执行 `setState` 更新界面；
- 只有当组件已卸载（`stopped === true`）时才中断更新。

### 7.2 补齐大文档视口滚动锚定（修复 BUG-02）

在 [`VirtualMarkdownBlockList.tsx`](file:///C:/Software/conex/apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx) 中引入视口补偿机制：
1. 复用 `src/api/virtualScrollAnchor.ts` 的成熟经验，在 `measureChunk` 回填时检查变动块索引：
   - 设当前视口顶部首个可见块为 `startIndex`；
   - 若发生高度变更的块 `index < startIndex`，计算高度增量 $\Delta = \text{newHeight} - \text{oldHeight}$；
   - 在调整 `HeightMap` 的同时，立即通过 `viewportRef.current.scrollTop += \Delta` 进行物理位移补偿；
2. 彻底消除 Mermaid、KaTeX、图片异步加载完毕时，视口发生数十至数百像素剧烈弹跳的缺陷。

### 7.3 清除 CSS `content-visibility: auto` 冲突（修复 BUG-03）

在 [`apps/crish-desktop/src/styles/markdown-typography.css`](file:///C:/Software/conex/apps/crish-desktop/src/styles/markdown-typography.css#L1006-L1009) 中：
- 从 `.md-virtual-chunk` 上彻底剔除 `content-visibility: auto; contain-intrinsic-size: auto 240px;`；
- 保持 DOM Windowing 的单一职责：DOM 节点的进出视口生命周期完全由 React 与 `queryViewport` 掌管，避免 Chromium 引擎将其判定为 skipped 导致首测伪高度污染 HeightMap。

### 7.4 完善测试防护网，补齐核心组件测试（修复 BUG-06）

1. 新建 `VirtualMarkdownBlockList.test.tsx`：
   - 覆盖估算高度初始化、滚动条移动时切片更新、ResizeObserver 回调驱动 HeightMap 实测更新；
   - 覆盖超视距块注销与内存释放；
2. 恢复并对齐新契约的 `StreamingMarkdownView.test.tsx` 与 `MarkdownBlockItem.test.tsx`：
   - 严格断言封口块在流式结束时 0 次重渲；
   - 验证活跃尾块到封口权威态的双缓冲无缝过渡。
