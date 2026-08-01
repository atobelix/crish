# PE-02 流式 Markdown 直接增量渲染 + 增量流打通 · 任务书

> 日期：2026-08-01 · 范围：crish-desktop 流式渲染管线（AsyncMarkdownBlock / MessageContent / StreamRenderBuffer）+ Rust 侧流式产出接口契约
> 类型：方案设计文档（只读研究已完成，本文件为可执行任务书，不包含代码改动）
> 关联文档：
> - `docs/rust-rewrite/24-markdown-streaming-audit.md`（伪流式成因 4 证据 + 增量资产盘点）
> - `docs/rust-rewrite/audits/AA-06-performance-review.md`（P1/F1：首 token 延迟根因；F2/F4）
> - `apps/crish-desktop/src/api/markdown-render/STREAMING_RENDER_PLAN.md`（既有 6 轮计划，含第 3 轮组件接线伪代码）
> - `docs/rust-rewrite/plans/PE-09-*.md`（Rust 侧真增量实现计划，未落盘；本文件定义其接口契约）

---

## 修订记录

| 版本 | 日期 | 修订依据 | 要点 |
|---|---|---|---|
| v1 | 2026-08-01 | — | 初版 |
| v2 | 2026-08-01 | **AU-04 接口冻结裁决** | ① §3.1.1 契约正文按 F1 冻结 v1：补 `ProviderRequest<'a>` 生命周期、`ProviderEventStream` 别名（弃 `StreamItem`）、明确「本文件即契约 SoT，PE-09 落地时同步回写」；② 删除失效资产引用 markdownCache.ts（文件不存在）；③ T02.6 阈值按 F1 口径（500ms 端到端验收 / 600ms 集成由 PE-09 T09.1.3 硬断言 / 300ms 降为 PE-09 T09.7 内部基准），基线文档并入 `docs/rust-rewrite/audits/PE-perf-baseline.md`（PE-09 T09.7 维护）；④ T02.2/T02.4 视觉验收补自动化断言 + 人工检查清单（AU-03 §四）；⑤ 契约锚点文件注明「PE-09 T09.1.3 验收显式引用」 |
| v3 | 2026-08-01 | **T02.1 落地** | §3.1.1 冻结签名按落地形态覆盖更新（标注「已落地」）：`ProviderEventStream` 补 `+ 'static`、方法以显式生命周期 `stream<'a>` 落地（async_trait 展开要求，语义等同草案 `&ProviderRequest<'_>`）、`StreamResult` 保留为兼容别名；§3.1.4 契约测试锚点已落壳（事件顺序 / 流中错误语义 / abort 占位），`cargo test -p session-loop` 全绿 |

---

## 0. 结论摘要（TL;DR）

1. **伪流式属实且成因已定位到函数级**：流式期间（processing）UI 显示的是未渲染的原始纯文本
   （`apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx:51-59`），markdown 渲染只在
   消息结束后整篇执行（`useAsyncMarkdownHtml` → Rust `md_render`）。用户看到的"逐字符"只是纯文本字符，
   不是渲染后的 markdown。
2. **增量渲染能力已全套存在、零接线**：`IncrementalMarkdownParser`（455 行 + 481 行测试）、
   `IncrementalDomRenderer`（96 行）、`IncrementalInlineRenderer`（203 行，行级高亮缓存 LINE_CACHE 有
   10000 上限）、`useStreamRenderThrottle`（64 行）在生产代码中均无调用方（仅 perfBenchmark 与测试引用）。
3. **首 token 延迟根因在 Rust 侧**（AA-06 P1/F1）：`HttpProviderCall::stream`
   （`apps/agent-workbench/src-tauri/src/engine.rs:293-324`）先把整个 SSE 流读入 `Vec`，`streaming.rs` 的
   `emit_message_deltas`（`crates/session-loop/src/loop/handlers/streaming.rs:234-245`）再按 **block** 整块 emit，
   前端直到流结束才收到第一条 delta。前端 `EventRouter.ts:199-216` 已支持增量累加（`assistantText += t`），
   只差 Rust 侧真正逐个产出。
4. **本方案 = 方案 C（流式期 JS 增量解析器，零 IPC）+ 方案 A（完成态 Rust md_render 权威收敛）**，
   Rust markdown 渲染 API（`render_markdown` / `render_markdown_stream`）已就绪无需改动；Rust 侧流式产出
   的**接口契约在本文件 T02.1 定义，实现归 PE-09**（契约按 **AU-04 F1 冻结 v1**，本文件 §3.1 即契约 SoT）。
5. **执行面**：前端 5 个任务（T02.2~T02.6）+ 契约定义 1 个任务（T02.1），按 M1~M4 里程碑推进，
   前端以 mock 增量源先行，与 PE-09 并行不阻塞。

---

## 1. 目标与边界

### 1.1 目标（三条，全部可验收）

| # | 目标 | 落点 | 验收锚点 |
|---|---|---|---|
| G1 | **流式期间直接增量渲染 markdown**：fence/表格/列表/标题随 delta 逐行正确渲染；未闭合 fence 软渲染（内容可见，不闪烁丢失） | AsyncMarkdownBlock 流式态接线增量解析器 | 见 T02.2 验收 |
| G2 | **完成态 Rust 权威渲染收敛**：流式→完成切换用 `md_render` 输出一次性收敛，与增量态同渲染语义（CSS 契约 md-p/md-h1/md-code-block/md-table 等已对齐，audit 24 §4.1），消除终态双渲染 | AsyncMarkdownBlock 完成态 finalize + precomputedHtml 消费 | 见 T02.4 验收 |
| G3 | **首 token 延迟消除**：Rust 侧真增量流（事件按 delta 即时产出，非全量 Vec 缓冲），message-delta 逐个 emit，前端首字符到达时间从「完整响应时长」降为「首个 token 时长」 | Rust 契约（T02.1）+ PE-09 实现 | 见 T02.6 验收 |

### 1.2 边界（明确不做）

| 不做 | 理由 |
|---|---|
| Rust 侧新增块级/行级增量渲染 API（audit 24 §4.3 方案 D） | 收益低于方案 C（每帧 IPC 成本），Rust 侧维持现有 API |
| 流式期改用 `md_render_stream` 每帧 IPC（方案 B） | 每帧 ~200μs IPC + 全文重解析 O(n)，仅 ~30FPS；计划文档已判为中间方案，本文件不采纳 |
| 图片结构化（ImageGallery / resolveToolImages） | 属 STREAMING_RENDER_PLAN 第 4-5 轮独立域；本文件仅要求不回归现状（MessageContent 的 extractImageRefs/inlineImages 保留） |
| `scheduleFinalMarkdownHtml` 的删除 | 保留函数本体，仅改消费方式（T02.4 由 AsyncMarkdownBlock 消费其产物 precomputedHtml），避免动持久化链路 |
| 完成态渲染引擎切换（worker→Rust 等） | 维持现状优先级链：LRU → Rust md_render → worker fallback |

### 1.3 与 PE-09 的分工边界（本域最关键的接口约定）

**总原则：PE-02 管"前端接线 + Rust 侧流式产出的接口契约定义"，PE-09 管"Rust 侧真增量的实现"。**

| 内容 | 归属 | 说明 |
|---|---|---|
| `ProviderCall::stream` 增量签名、事件形状/顺序/终止语义、取消/错误语义 | **PE-02（T02.1）** | 契约正文见 §3.1，本文件即契约 SoT；PE-09 必须按此实现 |
| 契约测试锚点（空壳测试文件 + 断言注释） | **PE-02（T02.1）** | `crates/session-loop/tests/streaming_incremental_contract.rs` 新文件由 PE-02 落壳，PE-09 填实现 |
| `ProviderCall` trait 签名落地、`HttpProviderCall` 边收边发、`transport::read_stream` 逐帧回调、`streaming.rs` 边收边 emit、`consume` 增量聚合、run_loop/divergence 测试更新 | **PE-09** | 实现层，PE-02 不触碰 Rust 非契约代码 |
| 前端全部接线（AsyncMarkdownBlock / MessageContent / throttle / StreamRenderBuffer / 完成态收敛 / 性能测量） | **PE-02（T02.2~T02.6）** | 以 mock 增量源先行，不依赖 PE-09 完成 |
| 端到端联调（真实 Rust 增量流 + 前端） | 双方 | PE-09 完成契约测试后，由 PE-02 T02.6 执行最终验收 |

**并行性与阻塞关系**：T02.1 契约冻结是 PE-09 的启动条件（PE-09 依赖 = [T02.1]）；
T02.2~T02.5 前端任务只依赖 T02.1 的契约形状（mock 源模拟），不阻塞。

### 1.4 现状事实锚点（证据表，实现时以此核对）

#### 1.4.1 伪流式 4 证据（audit 24 §2.1，均已复核）

| # | 证据 | 文件:行号 | 复核结论 |
|---|---|---|---|
| E1 | 流式期 `renderTarget = isStreaming ? '' : text`，渲染请求短路 | AsyncMarkdownBlock.tsx:34；markdownRenderAsync.ts:89-93 | 属实 |
| E2 | 流式期渲染 `<div className="assistantText md-rendered isStreaming">{text}</div>`，纯文本 + caret | AsyncMarkdownBlock.tsx:51-59 | 属实 |
| E3 | `streaming = isThinkingMsg && item.key === lastTextKey`，最后文本块必走纯文本分支 | MessageContent.tsx:122 | 属实 |
| E4 | `buffer.onFrame` 只写 `frame.full`；`frame.html` 恒 `''`、`chunkUpdates` 恒 `[]` | useStreamCallbacks.ts:173-179；StreamRenderBuffer.ts:225-234 | 属实，详见 §3.5 |

#### 1.4.2 首 token 延迟证据（AA-06 P1/F1）

| 环节 | 文件:行号 | 现状 |
|---|---|---|
| SSE 全量缓冲 | engine.rs:293-324 | `read_stream` 收完全部 frames 后才逐帧 parse 进 `Vec<ProviderStreamEvent>` |
| 整块 emit | streaming.rs:46,234-245 | `emit_message_deltas` 按 block（正文整段）一次性 emit |
| 前端已就绪 | EventRouter.ts:199-216；useStreamCallbacks.ts:416-433；StreamRenderBuffer | `assistantText += t` 增量累加、onChunk→buffer、rAF 分帧均可用 |

#### 1.4.3 增量资产零消费清单

| 资产 | 文件 | 消费状态 |
|---|---|---|
| 块级增量解析器 | apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.ts:91-455 | 仅 perfBenchmark.ts:22 与测试 |
| DOM 块级 patch | IncrementalDomRenderer.ts:21-96 | 仅 perfBenchmark.ts:23 |
| 内联 + 行级高亮（LINE_CACHE ≤10000） | IncrementalInlineRenderer.ts:30,122,200 | 仅解析器内部 |
| rAF 节流 hook | apps/crish-desktop/src/hooks/useStreamRenderThrottle.ts:17-64 | grep 无调用方 |
| 首屏批量预热 | apps/crish-desktop/src/api/markdownPreload.ts:22-74 | grep 无调用方 |
| Rust `md_render_stream` | markdown_commands.rs:45-51（main.rs:98 注册）；rustCore.ts:203-212 | 生产零调用 |
| 未闭合 fence 软闭合（Rust） | renderer.rs:143-147（flush_fence）、:396-405 | 完成态可用 |
| stream_mode 双路径（跳 syntect） | renderer.rs:107-110、:1048-1052 | 完成态可用 |

---

## 2. 架构决策（本方案锁定的设计选择）

| 决策 | 选择 | 理由 |
|---|---|---|
| D1 流式渲染源 | JS 增量解析器（零 IPC），完成态 Rust `md_render` | 120FPS 要求零 IPC；Rust 权威收敛保证一致性 |
| D2 解析器生命周期 | 按消息实例化，挂 AsyncMarkdownBlock ref；流式结束 `finalize(rustHtml)` + `dispose` | 每消息独立状态机，避免跨消息污染；STREAMING_RENDER_PLAN §3.1 伪代码即此形态 |
| D3 驱动模型 | 每帧 `push(fullText)`（全文入参，内部按行增量）；`StreamRenderBuffer` 只负责 delta 分帧与 `full` 累计 | parser 已按 `finalizedLineCount` 增量处理（IncrementalMarkdownParser.ts:104-127），全文入参成本 O(新增行) |
| D4 frame.html 死通道 | **清理**（删除 `RenderFrame.html` / `chunkUpdates`） | 解析器产物直接写 DOM（组件持有实例），回填 frame.html 每帧 O(全文) 序列化，违背 O(delta)；onFrame 消费方只读 delta/full（useStreamCallbacks.ts:173-179） |
| D5 precomputedHtml | **启用消费**（AsyncMarkdownBlock 完成态优先取用） | 消除终态双渲染（audit 24 §3.1 瓶颈 4）；scheduleFinalMarkdownHtml 已写该字段（helpers.ts:53-74） |
| D6 可见性来源 | ChatAssistantMessageRow 加 IntersectionObserver（threshold 0.01）→ visible → MessageContent → AsyncMarkdownBlock | MessageVirtualizer 仅按窗口挂载（overscan 6），窗口内行仍需精确视口判定；组件内 IO 成本低且确定性 |
| D7 Rust 侧契约形态 | `ProviderCall::stream` 返回 `Pin<Box<dyn Stream>>`（候选 A，见 §3.1.1） | futures_util 已在依赖（transport/mod.rs:10）；与 reqwest bytes_stream 天然衔接；取消=drop |

---

## 3. 任务分解（T02.x）

> 每个任务给出：**目标 | 输入 | 产出 | 验收 | 依赖**。产出均为文件路径级。

### T02.1 Rust 侧真增量流接口契约定义（契约产出本域，实现归 PE-09）

- **目标**：冻结 Rust 侧流式产出的接口契约，使：
  (a) PE-09 可以独立实现并通过契约测试；
  (b) 前端 T02.2~T02.5 可以用契约形状的 mock 增量源先行开发与验证；
  (c) 首 token 延迟在语义上被消除（事件不得跨帧/跨块聚合缓冲）。

- **输入**（只读，契约依据）：
  - `crates/session-loop/src/provider.rs:20,57-67`（`StreamResult = Result<Vec<ProviderStreamEvent>, ClassifiedStreamError>`、`ProviderCall::stream` 全量返回契约）
  - `apps/agent-workbench/src-tauri/src/engine.rs:293-324`（HttpProviderCall 全量缓冲现状）
  - `crates/agent-provider/src/transport/mod.rs:51-59`（`read_stream` 一次性返回 `StreamReadOutput`）
  - `crates/session-loop/src/loop/handlers/streaming.rs:36-117,234-245`（handle + emit_message_deltas 现状）
  - `crates/session-loop/src/stream.rs:240-316`（`consume` 聚合与 finish 语义）
  - `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts:178-216`（前端增量累加已就绪）
  - 协议参考：02 §一.3 / §六.9（事件顺序、stop 语义）、01 §五.6（message-start → message-delta* → message-end 序列）

- **产出**：
  1. **契约正文**（本文件 §3.1 即契约 SoT，PE-09 实现必须逐条满足）；**已落地**：冻结签名
     已写入 `crates/session-loop/src/provider.rs`（§3.1.1 标注「已落地」）；
  2. **契约测试锚点**：新建 `crates/session-loop/tests/streaming_incremental_contract.rs`（**已落壳**：
     事件顺序 / 流中错误语义两个可用测试 + abort 占位 `#[ignore]`，PE-09 填实现后可直接运行；
     **该文件为 PE-09 T09.1.3 验收的显式引用对象**，AU-04 F1）；
  3. **前端 mock 增量源**：新建 `apps/crish-desktop/src/api/chat-stream/mockIncrementalSource.ts`
     （按契约形状逐事件 emit TextDelta；供 T02.2/T02.3 开发与测试，T02.6 联调后保留为测试资产）。

- **验收**：
  - A1 契约正文冻结且覆盖：签名、事件形状、顺序、终止、取消、错误分类、对前端协议的影响；
  - A2 mock 源与契约形状一致（TS 类型 `MockDeltaEvent` 字段对齐 serde 字段名）；
  - A3 契约测试锚点文件存在且 `cargo check -p session-loop` 通过（空壳阶段允许测试体为 `todo!` 或跳过）；
  - A4 前端任务在无 Rust 改动的情况下全部可开发（用 mock 源）。

- **依赖**：无（最先执行；是 PE-09 的启动条件）。

### T02.2 前端流式态接线：AsyncMarkdownBlock 重写（增量渲染 + fence 软渲染）

- **目标**：流式期（isStreaming=true）用 `IncrementalMarkdownParser` + `IncrementalDomRenderer` 直接渲染：
  - fence 未闭合软渲染（tail 块渲染为 `md-code-block`，行级高亮缓存 LINE_CACHE，见 parser `buildTailBlock` IncrementalMarkdownParser.ts:404-412）；
  - 表格增量（tail 行 +1）、列表增量（tail 项 +1）、标题/段落即时闭合；
  - 完成态（isStreaming=false）`finalize(rustHtml)` 一次性收敛 + 释放解析器实例；
  - 解析器异常 catch → 回退现有纯文本分支（零回归）。

- **输入**：
  - `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx`（73 行，现状唯一切换点）
  - `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.ts`（455 行，接口：`push(fullText) → { finalizedBlocks, tailBlock, blockCount }`）
  - `apps/crish-desktop/src/api/markdown-render/IncrementalDomRenderer.ts`（96 行，接口：`render(result)` / `finalize(rustHtml)` / `reset` / `dispose`）
  - `apps/crish-desktop/src/api/markdown-render/STREAMING_RENDER_PLAN.md:306-348`（第 3 轮伪代码）
  - `apps/crish-desktop/src/api/markdownRenderAsync.ts`（完成态 hook 现状）
  - T02.1 产出 mock 源（`mockIncrementalSource.ts`）

- **产出**：
  1. 重写 `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx`：
     - props 扩展：`streamId?: string`、`visible?: boolean`（T02.3 透传，先给默认值）；
     - 流式态：`useEffect([text, isStreaming, visible])` 内 `parserRef.current.push(text)` →
       `rendererRef.current.render(result)`；解析器/渲染器懒实例化；StrictMode 双 effect 下 dispose/reinit 幂等；
       `text` 全量变化（如 strip 后替换）时 `reset()` 重建；
     - 完成态：优先消费 `precomputedHtml`（T02.4），缺失走 `useAsyncMarkdownHtml(text)`；
       `useEffect` 中 `rendererRef.current.finalize(html)` + `parserRef.current.dispose()`；
     - 渲染结构：外层 `<div ref={containerRef} className="assistantText md-rendered">` 由
       IncrementalDomRenderer 管理内容（data-block-id / data-block-tail 节点）；**流式期不得把 text
       作为 React 子节点**（避免 React 覆盖 DOM 直操结果）——这是与现状 51-59 行纯文本分支的本质差异；
     - 异常兜底：push/render 抛错 → 置 error 状态 → 渲染纯文本 `<div>{text}</div>`（保底零回归）；
     - caret：CSS `.isStreaming` caret（ChatMessageRow.module.css:466-479）保留给流式态。
  2. 组件测试：新建 `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.test.tsx`：
     - 用例 1：多帧增量 push → 断言容器内 `[data-block-id]` 数 = finalizedBlocks 数、`[data-block-tail]` 至多 1 个；
     - 用例 2：未闭合 fence（` ```typescript\n` + 若干行，无闭合）→ tail 渲染为 `md-code-block`，内容可见；
     - 用例 3：fence 闭合 → 变为 finalized 块，tail 消失；
     - 用例 4：完成态切换 → `container.innerHTML` == rustHtml（mock html），解析器 dispose 被调用；
     - 用例 5：parser 抛错 → 回退纯文本。
  3. mock 源消费示例（dev 工具，可选）：`mockIncrementalSource.ts` 的 README 注释说明用法。

- **验收**：
  - V1 流式期 DOM 呈现 markdown（标题/列表/fence/表格），非纯文本（对照现状 E2）；
  - V2 `IncrementalMarkdownParser.test.ts`（481 行既有用例）全绿；
  - V3 新增组件测试全绿；`npx tsc --noEmit` 通过；
  - V4 未闭合 fence 期间内容持续可见、无闪烁丢失；闭合后一次成型——自动化断言：组件测试用例 2/3
    （tail 块存在性与内容可见性）；人工检查清单（AU-03 §四）：真实长消息流式期间对 fence/表格/列表/标题
    四类文本逐项目检，结果记录到任务 PR 描述；
  - V5 完成态无「纯文本闪现」过渡（finalize 直接以 rustHtml 收敛）。

- **依赖**：T02.1（mock 源形状）；T02.3（visible 透传，可后补）。

### T02.3 MessageContent 流式/完成态切换逻辑 + useStreamRenderThrottle 接入

- **目标**：
  - MessageContent 把 `streamId`（assistantMsgId）、`visible`（视口内）透传给 AsyncMarkdownBlock；
  - 接入 `useStreamRenderThrottle`：48ms 批（streamTextBatcher）+ rAF 节流（hook）双层合并，视口外
    `paused=true` 跳过解析渲染；
  - 保持 S4.4 订阅边界（MessageContent 是唯一正文订阅点，ChatAssistantMessageRow 只订阅 thinking）。

- **输入**：
  - `apps/crish-desktop/src/components/chat-message/MessageContent.tsx`（172 行，:46-54 订阅、
    :122 streaming 判定、:125-133 AsyncMarkdownBlock 调用）
  - `apps/crish-desktop/src/hooks/useStreamRenderThrottle.ts`（64 行，接口 `useStreamRenderThrottle(streamText, isStreaming, visible) → { text, paused }`）
  - `apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx:171-176`
    （流式期不 invalidate；新增 IO 观察点）
  - `apps/crish-desktop/src/components/ChatMessageList.tsx:246-252`（thinkingMsgId 判定，不变）

- **产出**：
  1. `ChatAssistantMessageRow.tsx`：新增 `visible` 状态（IntersectionObserver，threshold 0.01，
     观察正文容器；unmount 断开），透传给 MessageContent；
  2. `MessageContent.tsx`：props 增加 `visible`；向 AsyncMarkdownBlock 传 `streamId={msg.id}`、
     `visible`；`isStreaming` 判定保持 :122 逻辑；流式文本经
     `useStreamRenderThrottle(streamText, isStreaming, visible)` 后再进 `applyStreamTextToMessage` 与
     AsyncMarkdownBlock（或 throttle 结果只作用于 AsyncMarkdownBlock 的 push 频率）；
  3. `extractImageRefs / inlineImages`（MessageContent.tsx:134-146）**保留现状**（图片结构化属独立域），
     仅确认流式期不因增量渲染引入回归。

- **验收**：
  - V1 视口外（IO 未相交）`paused=true`，无 parser.push 调用（可在测试中 stub 验证）；
  - V2 流式期帧率不因 React 重渲染劣化（T02.6 量化验证）；
  - V3 完成态同步路径无延迟（throttle 在 isStreaming=false 时立即同步，useStreamRenderThrottle.ts:27-35）；
  - V4 既有订阅边界测试（MessageContent / streamingStore）全绿。

- **依赖**：T02.2（AsyncMarkdownBlock 新 props）。

### T02.4 完成态收敛：Rust 权威渲染与增量态一致性

- **目标**：
  - 完成态以 `md_render`（syntect 高亮 + ammonia sanitize + moka 缓存）输出为准，`finalize` 一次性替换
    增量 DOM（IncrementalDomRenderer.ts:78-82 已实现）；
  - 消除终态双渲染：AsyncMarkdownBlock 消费 `precomputedHtml`（scheduleFinalMarkdownHtml 产物，
    helpers.ts:53-74 → sessionMessageActions.ts:143-152 写入），命中时跳过 useAsyncMarkdownHtml 的 IPC；
  - parity 测试固化「增量态最终形态 ≈ 完成态结构」：同 tag 序列、同 class 集合、文本实体一致
    （fence inner 高亮差异放行：行级高亮 vs syntect）。

- **输入**：
  - `apps/crish-desktop/src/api/markdownRenderAsync.ts`（119 行，完成态 hook + LRU）
  - `apps/crish-desktop/src/hooks/chat-stream/helpers.ts:53-74`（scheduleFinalMarkdownHtml 双写路径）
  - `crates/conex-markdown/tests/parity_fixtures.rs`（Rust 侧既有 parity fixtures）
  - `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.test.ts`（parity 基础形态）

- **产出**：
  1. `AsyncMarkdownBlock.tsx` 完成态路径（T02.2 内实现）：`props.precomputedHtml` 优先，
     否则 `useAsyncMarkdownHtml(text)`；两者都无 → skeleton（现状 :68-70 保留）；
  2. parity 测试：新建 `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.parity.test.ts`：
     - fixture 集：段落/标题/列表/嵌套列表/表格/fence（含未闭合）/引用/混合长文（≥20 类，转写
       `crates/conex-markdown/tests/parity_fixtures.rs` 或引用共享 JSON）；
     - 断言：JS 解析器对「最终全文一次 push」的块结构（type 序列 + html 的 tag/class 骨架 + 转义后文本）
       与 Rust `md_render` 输出结构一致（归一化 whitespace 与 fence inner 后比较）；
  3. 回归确认：`scheduleFinalMarkdownHtml` 与 AsyncMarkdownBlock 不再并发抢写（单一入口 =
     precomputedHtml 优先，useAsyncMarkdownHtml 兜底）。

- **验收**：
  - V1 parity 测试全绿；
  - V2 完成态切换无 skeleton 闪烁（precomputedHtml 命中路径，长消息 30KB 实测）——自动化断言：组件测试
    用例 4 断言 innerHTML 单次替换（无增量 DOM 先于 rustHtml 被 React 重写）；人工检查清单（AU-03 §四）：
    30KB 长消息流式→完成切换目检无视觉跳变，结果记录到任务 PR 描述；
  - V3 无重复渲染（无增量 DOM 先于 rustHtml 被 React 重写——组件测试断言 innerHTML 只被替换一次）；
  - V4 历史消息（非流式）渲染路径零回归（useAsyncMarkdownHtml 行为不变）。

- **依赖**：T02.2（finalize 接线）、T02.3（完成态切换触发）。

### T02.5 StreamRenderBuffer 死通道清理（frame.html / chunkUpdates）

- **目标**：按 D4 决策清理 `RenderFrame.html` / `RenderFrame.chunkUpdates`，收敛消费方为单路径
  （只读 delta/full），删除「解析器尚未接入，flush 暂写 ''」的遗留注释。

- **输入**：
  - `apps/crish-desktop/src/api/StreamRenderBuffer.ts`（314 行；:14-18 注释、:21-33 接口、:225-234 帧合成）
  - `apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`（帧形状断言需同步）
  - 消费方核查：`useStreamCallbacks.ts:173-179`（只读 frame.full/delta/isFinal——已确认）

- **产出**：
  1. `StreamRenderBuffer.ts`：
     - 删除 `RenderFrame.html`、`RenderFrame.chunkUpdates` 字段；
     - 更新文件头注释（移除「解析器尚未接入」段落，改为说明解析器由组件侧持有、本类仅分帧）；
     - `flushFrame` 帧合成移除 `html: ''`、`chunkUpdates: []`；
     - **可选（AA-06 F2）**：`fullText` 改分块数组 + `frame.full` 惰性 join（仅 isFinal 时计算），
       `pending` 消费改下标游标——若本任务内做，验收增加对应单元测试；
  2. 同步更新 `stressFuzzing.test.ts` 与 `StreamRenderBuffer.test.ts`（如有帧形状断言）；
  3. grep 清零：`html`/`chunkUpdates` 无消费方引用（`frame.html` 相关代码全部移除）。

- **验收**：
  - V1 `npx tsc --noEmit` 通过；stress/fuzz 测试全绿；
  - V2 `rg "chunkUpdates|frame\.html" apps/crish-desktop/src` 无命中；
  - V3 onFrame 消费路径行为不变（full/delta/isFinal 语义与 AA-06 已验证的分帧参数 6ms/8192 保持）。

- **依赖**：T02.2（确认解析器产物不回流 buffer——组件侧持有实例）。

### T02.6 性能验收：长文本流式渲染帧率 + 首 token 延迟测量方法

- **目标**：给出可重复的测量方法与验收基线，量化 G1/G3 达成度；产出基线数据存档供回归对比。

- **输入**：
  - `apps/crish-desktop/src/api/markdown-render/perfBenchmark.ts`（520 行，解析器单测基准已存在）
  - `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`（onChunk 触发点 :416；recordStreamDiag :440）
  - `tests/stress/stress-runner.ts`（既有场景框架，未覆盖 Rust 侧）
  - T02.1 mock 源 / PE-09 真实增量流

- **产出**：
  1. **首 token 延迟测量**（前端埋点，无 Rust 改动即出基线）：
     - `useStreamCallbacks.ts` onChunk 首次触发时：`firstChunkAt = performance.now()`；
       发送时刻在 streamAssistantResponseApi 调用前记录（现有关键路径已有时序，补一个 ref）；
     - 埋点输出：经 `recordStreamDiag` 上抛（scope `ttft`，含 `requestToFirstChunkMs`）；
      - 基线（现状）：首 chunk 到达 ≈ 完整响应时长（全量缓冲）；PE-09 完成后同一埋点对比，
        目标：**端到端 `requestToFirstChunkMs` < 500ms（F1 口径第 2 测量点，本任务书唯一首 token 验收门）**；
      - 其余口径（冻结 v1，AU-04 F1，任何任务书不得新增第四套数字）：集成测试（mock SSE 慢速分块）
        首条 delta 到达事件桥 **< 600ms** = PE-09 T09.1.3 硬断言；「流产出后到达事件桥 ≤ 300ms」
        降为 PE-09 T09.7 内部基准记录，不作验收门；
  2. **长文本流式帧率测量**：
     - 集成性能场景：新建 `apps/crish-desktop/src/api/StreamRenderBuffer.integration.perf.test.ts`
       （或扩展 perfBenchmark）：模拟完整链路（mock 源逐个 delta → buffer.push → onFrame → setStreamText
       → AsyncMarkdownBlock push → render），文本 30KB / 100KB（fence+表格+列表混合，参考
       perfBenchmark 场景生成器）；
     - 测量：每帧 push+render 耗时 p50/p95（performance.now，对齐 perfBenchmark 分位法）；
     - 真实环境：Chrome DevTools Performance 录制（长消息流式）核对长任务（Long Tasks > 50ms）数；
  3. **验收基线表**（写入本文件 §6，作为回归门禁）：

| 指标 | 基线/目标 | 方法 |
|---|---|---|
| 首 token 延迟（端到端 `requestToFirstChunkMs`） | **< 500ms**（现状：≈整条时长，作对照记录）；600ms 集成 / 300ms 内部基准见 PE-09 T09.1.3 / T09.7（F1 口径） | recordStreamDiag `ttft` |
| 流式帧耗时 p95（30KB 混合文本） | < 8.3ms（120Hz 预算，对齐 perfBenchmark FPS_TARGET=120） | 集成 perf 测试 |
| 100KB 长文本流式 | 无长任务 >50ms；稳定 ≥60FPS | DevTools Performance |
| 完成态切换 | precomputedHtml 命中无 skeleton；无视觉跳变帧 | 手动 + 组件测试 |
| LINE_CACHE 内存 | ≤ 10000 条（IncrementalInlineRenderer.ts:31 上限不破） | perfBenchmark memoryStats |

- **验收**：上述 5 项基线全部采集并存档（**`docs/rust-rewrite/audits/PE-perf-baseline.md`**，单一基线
  文档，PE-09 T09.7 维护、本任务写入，AU-04 认领表 #4）；
  PE-09 联调后复测首 token 延迟对比。

- **依赖**：T02.1~T02.5（后置验收）；PE-09（端到端首 token 复测）。

### 3.1 T02.1 契约正文（本文件即契约 SoT）

#### 3.1.1 签名（结论：候选 A，Stream 返回；**冻结 v1，AU-04 F1；T02.1 已落地**）

```rust
// crates/session-loop/src/provider.rs —— 冻结签名（v1，AU-04 F1；**已落地**，PE-02 T02.1）
pub type ProviderStreamItem = Result<ProviderStreamEvent, ClassifiedStreamError>;
pub type ProviderEventStream = Pin<Box<dyn Stream<Item = ProviderStreamItem> + Send + 'static>>;

#[async_trait]
pub trait ProviderCall: Send + Sync {
    /// 流前 Err = 传输层/HTTP/首帧错误，尚未产出任何事件（进重试阶梯）；
    /// 流中 Err(item) = 中途错误：已产出内容 → 内容保留收场（不重试）；未产出 → 重试阶梯；
    /// 每流恰好一个 Stop，Stop 后流立即结束；abort 协作按 safe_point 语义；
    /// 流为 'static，不得借用 request（请求体在返回流前完成序列化）。
    async fn stream<'a>(&self, request: &ProviderRequest<'a>)
        -> Result<ProviderEventStream, ClassifiedStreamError>;
}
// ProviderRequest<'a> { messages: &'a [AgentMessage], tools: Vec<ToolSchema>, max_tokens: Option<u32> }
```

- **已落地（T02.1，2026-08-01）**：上述签名即 `crates/session-loop/src/provider.rs` 现行代码，
  本文件 §3.1 与代码一致（后续变更须走 AU-04 冻结变更流程）。
- **落地差异（vs v2 草案，均为实现必需）**：
  1. `ProviderEventStream` 补 `+ 'static`（流不得借用 request 的编译级强制）；
  2. 方法以显式生命周期 `async fn stream<'a>(&self, request: &ProviderRequest<'a>)` 落地
     （async_trait 展开要求，语义等同草案的 `&ProviderRequest<'_>`）；
  3. 旧形态 `StreamResult` 保留为兼容别名（契约不要求删除，PE-09 评估去留）。
- **本文件 §3.1 即契约 SoT**（AU-04 F1：契约正文 SoT 归 PE-02 §3.1 修订后）：
  PE-09 T09.1.1/T09.1.2 引用本文件，实现按本形状落地（增量消费属 T09.1）。
- **别名取定（v1）**：条目别名 = `ProviderStreamItem`（本文件名，弃用 PE-09 的 `StreamItem`）；
  流别名 = `ProviderEventStream`（冻结）。两个名字各只保留一个，PE-09 不得再引入 `StreamItem`。
- **生命周期**：`ProviderRequest<'a>`（消息借用期，`messages: &'a [AgentMessage]`，即
  PE-09 T09.3 阶段 1 的借用改造）；返回流为 `'static`，不得借用 request（请求体在返回流前
  完成序列化）。
- 允许 PE-09 换用 tokio mpsc 形态，但**必须保持本契约的事件形状/顺序/终止/取消语义不变**；
  若换形态需在 PE-09 计划内声明理由并经契约测试锚点回归。
- 现有 `StreamResult = Result<Vec<...>, ...>` 是流式化前的形态，PE-09 落地后删除或保留别名
  （契约不要求删除，当前保留为兼容别名）。

#### 3.1.2 事件形状与顺序（02 §一.3 / §六.9 不变式）

1. `ProviderStreamEvent::TextDelta { text }` / `ThoughtDelta` 按 producer 产出顺序**逐事件**流出，
   **禁止跨帧/跨块聚合后一次性 emit**（这是 P1 修复的本质要求）；
2. 每流恰好一个 Stop；Stop 之后无事件；流正常结束 = 事件序列结束；
3. 传输层错误已分类（`ClassifiedStreamError`，02 §4.2 13 类）：
   - 流未开始（连接失败/HTTP 状态/首字节超时）→ `Err` 返回（流前）；
   - 流中错误（idle 超时/读取中断）→ 流内 `Err(item)` 终止；
4. 取消协作：实现方每帧检查共享 `AbortSignal`（`crate::safe_point::AbortSignal`），置位后尽快终止流，
   已产出事件全部保留（partial salvage 语义不变，stream.rs:294-316）。

#### 3.1.3 session-loop 消费端语义（PE-09 实现 streaming.rs；事件序列契约兼容 01 §五.6）

```
message-start（message_id 固定，流开始前生成）
  → message-delta（block = Text{text: 增量片段} | Thought{text: 增量片段}）*   ← 逐 TextDelta 即时 emit
  → message-end（携带完整消息：全部 blocks 含全文 text）                          ← 文本段结束后一次 emit
```

- `emit_message_deltas`（streaming.rs:234-245）改造为逐 delta 调用：签名
  `fn emit_message_delta(state: &mut LoopState, message_id: &str, block: AgentMessageBlock)`，
  仅 emit Text/Thought 增量块；
- `consume`（stream.rs:240）改造为流式增量聚合：`Aggregate` 边收边更新（text 追加 O(1)），
  `finish` 语义（stopReason/usage/error 标注、Empty/StreamError/Message 分类）不变；
- tool-call 段：文本结束后聚合（02 §一.3 顺序约束），不逐 delta emit（保持现状工具事件路径）；
- **前端协议零改动**：message-delta 增量 + message-end 全文，EventRouter.ts:178-216 已按
  `assistantText += t` 累加消费，T02.2~T02.5 的 mock 源按本形状 emit。

#### 3.1.4 契约测试锚点（`crates/session-loop/tests/streaming_incremental_contract.rs`）

> **已落地（T02.1，2026-08-01）**：锚点文件已落壳三个测试——① 事件顺序
> （TextDelta...→Stop 恰好一个，Stop 后无事件）；② 流中错误语义（Err 条目是
> 最后一条，其后流立即结束，错误前内容逐事件保留）；③ T3 取消保留
> （`#[ignore]` 占位，PE-09 T09.9 填充）。`cargo test -p session-loop` 全绿
> （2 通过 + 1 忽略）。下表 message-delta 级 T1~T4 断言由 PE-09 增量消费
> 落地后补齐。

| 用例 | 断言 |
|---|---|
| T1 增量性 | 脚本化 TestProvider 产出 N 个 TextDelta → 收到 N 个 message-delta 事件且每个 text 为增量片段 |
| T2 收敛性 | message-end 的全文 text == 全部 delta 拼接 |
| T3 取消保留 | 流中途置 abort → 已 emit 的 delta 保留，收场为 aborted 且内容不丢（对照 streaming.rs:84-88） |
| T4 传输错误 | 流中 Err item → 分类进入重试阶梯（stream_error::handle 路径） |

---

## 4. 风险与对策

| # | 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|---|
| R1 | **增量态/完成态视觉差异**：JS 解析器与 Rust 渲染器语义差异（嵌套列表/任务列表/表格对齐/引用/图片/URL 实体/wbr CJK 换行） | 流式期与完成态外观不一致，用户感知跳动 | parity 测试（T02.4）覆盖 ≥20 类 fixtures；finalize 一次性收敛吸收残余差异；CSS 契约已对齐（audit 24 §4.1） | T02.4 |
| R2 | **fence 边界闪烁**：未闭合 fence 的 tail 块每帧整块重绘；闭合瞬间从行级高亮切 syntect 高亮 | 视觉跳动、copy 按钮等外壳元素闪烁 | tail 渲染复用 renderFenceHtml 外壳（IncrementalMarkdownParser.ts:357-370）与 Rust shell 一致（renderer.rs:1058-1102）；行级缓存保证 O(新行)；闭合→finalize 一步到位不经过中间态 | T02.2 |
| R3 | **渲染性能退化**：tail 块过大（500 字符段落 + 长代码块）时每帧重渲染；LINE_CACHE 命中率；DOM 直操 + React 混合双写 | 长消息卡顿 | useStreamRenderThrottle + 48ms 批双层限频（T02.3）；LINE_CACHE 已设 10000 FIFO 上限（IncrementalInlineRenderer.ts:31,187-192）；T02.6 帧耗时门禁 p95<8.3ms | T02.3/T02.6 |
| R4 | **React 与 DOM 直操冲突**：流式期 React 渲染树与 renderer 写入的 DOM 竞争（text 子节点覆盖 data-block 节点）；StrictMode 双 effect 重复实例化；消息复用/撤回时实例泄漏 | 渲染错乱、重复解析 | 流式期外层 div 无 React 子节点（D3/D2）；dispose/reinit 幂等；effect 清理钩子统一在 unmount 释放；组件测试覆盖 | T02.2 |
| R5 | **Virtualizer 高度测量**：增量渲染使行高连续变化；ChatAssistantMessageRow.tsx:171-176 流式期不 invalidate | 滚动位置跳动、高度错位 | 依赖既有 ResizeObserver 兜底（MessageVirtualizer.tsx:133-139）；验收关注初始 1-2 帧高度估算误差；不做流式期 invalidate（现状决策不变） | T02.6 |
| R6 | **strip 双端一致性**：MessageContent（:119）与 parser 内（IncrementalMarkdownParser.ts:106）各 strip 一次 | strip 幂等性破坏行号对齐 → 增量错位 | 确认 stripThoughtPlaceholders 幂等（重复调用结果不变）；parity 测试含 thought 占位符 fixtures；组件测试断言 strip 前后帧连续 | T02.2/T02.4 |
| R7 | **首 token 延迟依赖 PE-09**：若 PE-09 推迟/失败，G3 不达成 | 前端增量渲染已交付但延迟未消 | 前端以 mock 源交付并验收（T02.6 记录现状基线作对照）；契约测试锚点使 PE-09 可独立回归；G3 单独列为跨域验收项 | T02.1/T02.6 |
| R8 | **precomputedHtml 竞争**：scheduleFinalMarkdownHtml 异步写字段与 AsyncMarkdownBlock 完成态渲染时序竞态 | 完成态双渲染或 stale html | 单一入口：precomputedHtml 优先 + useAsyncMarkdownHtml 兜底（T02.4）；helpers.ts:67-69 已有「nowClean 与渲染文本一致才写」防竞态；组件测试覆盖「html 到达前完成态已切换」 | T02.4 |
| R9 | **降级路径失效**：解析器异常/浏览器无 DOM API（jsdom 测试） | 流式期白屏 | catch → 纯文本分支（现状行为，零回归）；测试环境渲染器用真实 jsdom container；Rust missing → worker 路径保持 | T02.2 |
| R10 | **每帧 React 重渲染成本**：streamingStore 48ms 批 + throttle rAF 合并后仍有订阅重渲染 | 长消息 CPU 占用 | S4.4 订阅边界已收敛（仅 MessageContent 订阅正文）；AA-06 F3 已判无害；T02.6 帧耗时门禁兜底 | T02.3 |

---

## 5. 执行顺序

### 5.1 依赖图

```
T02.1 契约（冻结）
  ├─→ PE-09（Rust 实现，外部依赖 [T02.1]）──→ 端到端首 token 复测 ──→ T02.6 验收
  ├─→ T02.2 AsyncMarkdownBlock（mock 源）
  │      └─→ T02.3 throttle + MessageContent（visible）
  │             └─→ T02.4 完成态收敛 + parity
  │                    └─→ T02.6 性能验收（全部前置）
  └─→ T02.5 StreamRenderBuffer 清理（并行，依赖 T02.2 确认消费面）
```

### 5.2 里程碑

| 里程碑 | 内容 | 时长 | 产出门禁 |
|---|---|---|---|
| **M1** | T02.1 契约冻结 + 契约测试锚点落壳；T02.2 并行启动（mock 源） | 1-2 天 | 契约正文评审通过；mock 源可用；AsyncMarkdownBlock 组件测试绿 |
| **M2** | T02.5 buffer 清理；T02.3 throttle/visible 接入 | 1-2 天 | tsc 绿；stress 测试绿；视口外暂停生效 |
| **M3** | T02.4 完成态收敛 + parity | 1.5-2 天 | parity 全绿；precomputedHtml 消费生效；无 skeleton 闪烁 |
| **M4** | T02.6 测量与验收（基线采集）；PE-09 联调后复测首 token | 1-2 天 + 联调 | §6 验收清单全项；基线存档 |

### 5.3 并行建议

- M1 内 T02.1 与 T02.2 可并行（前者 1 人半天出契约正文，后者 1 人全天写组件）；T02.5 与 T02.3 并行；
- PE-09 在 M1 契约冻结后立即启动，与 M2/M3 并行；若 PE-09 人手不足，优先保 M1~M3（前端域可独立交付），
  M4 的 G3 复测延后但不阻塞其他验收。

---

## 6. 全局验收清单（回归门禁）

- [ ] `npx tsc --noEmit`（apps/crish-desktop）通过
- [ ] `npm test`（前端）全绿：IncrementalMarkdownParser.test.ts / AsyncMarkdownBlock.test.tsx /
      parity / stressFuzzing / StreamRenderBuffer
- [ ] `cargo test -p session-loop`（契约锚点测试，PE-09 填充后）通过
- [ ] G1：流式期 DOM 呈现 markdown（fence 软渲染、表格/列表增量）——手动验证 5 类文本
- [ ] G2：完成态切换无视觉跳变、无 skeleton 闪烁、无重复渲染——手动 + 组件测试
- [ ] G3：首 token 延迟基线（现状）已存档至 `PE-perf-baseline.md`；PE-09 后复测
      `requestToFirstChunkMs < 500ms`（F1 口径：600ms 集成 = PE-09 T09.1.3，300ms = T09.7 内部基准）
- [ ] 性能：30KB 混合文本流式帧耗时 p95 < 8.3ms；100KB 无长任务 >50ms
- [ ] 降级：解析器异常 → 纯文本（零回归）；Rust missing → worker
- [ ] 死代码：`frame.html` / `chunkUpdates` 引用清零（T02.5）

---

## 附录 A：关键文件清单（改动面汇总）

| 文件 | 任务 | 操作 |
|---|---|---|
| apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx | T02.2/T02.4 | 重写 |
| apps/crish-desktop/src/components/chat-message/MessageContent.tsx | T02.3 | 修改（props 透传 + throttle） |
| apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx | T02.3 | 修改（IO visible） |
| apps/crish-desktop/src/api/StreamRenderBuffer.ts | T02.5 | 修改（删死通道，可选 F2） |
| apps/crish-desktop/src/api/chat-stream/mockIncrementalSource.ts | T02.1 | 新建 |
| apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.parity.test.ts | T02.4 | 新建 |
| apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.test.tsx | T02.2 | 新建 |
| apps/crish-desktop/src/api/StreamRenderBuffer.integration.perf.test.ts | T02.6 | 新建（或并入 perfBenchmark） |
| apps/crish-desktop/src/__tests__/stressFuzzing.test.ts | T02.5 | 同步帧形状 |
| crates/session-loop/tests/streaming_incremental_contract.rs | T02.1 | 新建（锚点，已落壳；PE-09 填实现） |
| crates/session-loop/src/provider.rs | T02.1（已落地）/ PE-09 | 契约落地（本文件 §3.1.1 冻结签名已写入；PE-09 实现增量消费） |
| crates/session-loop/src/loop/handlers/streaming.rs | PE-09 | 边收边 emit |
| crates/session-loop/src/stream.rs | PE-09 | consume 增量聚合 |
| apps/agent-workbench/src-tauri/src/engine.rs | PE-09 | HttpProviderCall 边收边发 |
| crates/agent-provider/src/transport/mod.rs | PE-09 | read_stream 逐帧回调 |

## 附录 B：不动面（明确不改）

- `crates/conex-markdown/src/renderer.rs`、`markdown_commands.rs`：Rust 渲染 API 已就绪（stream_mode /
  flush_fence / md_render_stream 均不动）；
- `EventRouter.ts`：增量累加已实现，零改动；
- `streamTextBatcher.ts` / `streamingStore.ts`：48ms 批与 store 形态保持；
- `markdownPreload.ts`：首屏预热可选接线（AA-06 F4），不在本域强制。
