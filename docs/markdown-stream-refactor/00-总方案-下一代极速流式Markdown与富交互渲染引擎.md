# 战役总方案：Conex 下一代极速流式 Markdown 与富交互渲染引擎

> **战役定位**：彻底根治正文伪流式退化、多轮文字大段重复、50k+ Tokens 长文卡死、流式表格撕裂与缺乏自定义交互组件五大系统性断层，构建一套具备极致吞吐（5 ~ 2000+ tokens/s 速率不变性）、绝对零骨架屏（Zero-CLS = 0.000）、四层 XSS 安全沙箱与单源确定性幂等的多端渲染架构。  
> **调度标准**：严格遵循 [`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md)。  
> **执行铁律**：先删后改，一个领域概念唯一主路径；禁止新增波次命名文件；严格负产出验收（净删除 23 个孤岛死文件，消除 ~3,700 行废弃代码）。

---

## 一、五大领域概念收敛矩阵与主路径确立

经过 6 份独立方案与 3 轮严苛交叉评审，正式锁定 Conex 下一代流式 Markdown 架构的 5 大领域概念与唯一主路径：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Conex 下一代流式 Markdown 领域收敛全景                          │
├─────────────────┬───────────────────────────────┬──────────────────────────────────────┤
│ 领域概念 (Domain)│ 历史旧有多条割裂路径 (Before) │ 收敛后的唯一主路径 (After)           │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 1. 速率自适应与 │ • JS setInterval 30ms 逐字排队│ • SlidingWindowRateEstimator (SW-TRE)│
│    排版调度     │ • StreamingTextBlock 独立追加 │ • AdaptiveAnimateTimeline (GPU CSS)  │
│                 │ • 无流控裸写导致 500t/s 冻结  │ • TURBO 模式宏块零 Span 硬件加速     │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 2. 词法分块与   │ • Marked 每帧全量正则重扫     │ • IncrementalBlockSplitter O(1) 前缀和│
│    双缓冲晋升   │ • AsyncMarkdownBlock 骨架屏   │ • SpeculativeVirtualCloser 投机补全  │
│                 │ • hasFootnote 全局单块熔断    │ • 单节点原位纯文本垫片双缓冲晋升     │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 3. 流式表格与   │ • 表头 P 标签突变导致全屏跳变 │ • 表格中间态 DFA 虚拟 Token 前瞻锁定 │
│    视口稳定     │ • 单元格裸插 Caret 破坏匿名盒 │ • hasTable 自动抑制光标 + 脉冲边框   │
│                 │ • 暴力 scrollTop 覆盖用户上滚 │ • usePinnedScroll 8px 容差双向吸底   │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 4. 自定义 HTML  │ • CommonMark Type 7 HTML 吞噬 │ • preprocessCustomTags 空行三明治    │
│    与富交互沙箱 │ • 流式未闭合标签源码裸露      │ • normalizeUnclosedOpenTags 实时呈现 │
│                 │ • FullThoughtModal 5 层套娃   │ • React Portal 沙箱 + 4 层 XSS 消毒  │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 5. 生命周期与   │ • onMessageEnd prevLen 切片重复│ • onMessageDelta 单增量生产者        │
│    时间线幂等   │ • sessionActionsTools 二次合并│ • Map 双账本 + 三元槽位 Reconciler   │
│                 │ • timelineNormalizer 616行超标│ • 拆分 4 个 ≤180 行子模块，0 错误吞噬│
└─────────────────┴───────────────────────────────┴──────────────────────────────────────┘
```

---

## 二、【强制专节】全战役死层物理清剿清单（净删除 23 个文件）

本战役在进入实质业务重构前，必须由阶段 0 严格执行“物理清算”，彻底删除以下 23 个孤岛死文件、废弃 Store、Worker 与伪流式组件（累计净减少 3,694 行死代码）：

| 序号 | 待物理删除文件路径 | 代码类型 | 行数 | 替代主路径与无害化依据 |
|:---|:---|:---|:---:|:---|
| 1 | `apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.tsx` | 废弃弹窗 | 283 | 行内极简折叠（`TimelineThoughtSection`） |
| 2 | `apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.module.css` | 废弃样式 | 145 | 无残留样式引用 |
| 3 | `apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.test.tsx` | 废弃测试 | 86 | 转由 `TimelineThoughtSection.test.tsx` 覆盖 |
| 4 | `apps/crish-desktop/src/components/chat-message-row/ThoughtOutline.tsx` | 废弃组件 | 82 | 消除过度设计大纲 |
| 5 | `apps/crish-desktop/src/components/chat-message-row/ThoughtOutline.module.css` | 废弃样式 | 64 | 无残留样式引用 |
| 6 | `apps/crish-desktop/src/components/chat-message-row/ThoughtSearchBar.tsx` | 废弃组件 | 104 | 消除过度设计搜索条 |
| 7 | `apps/crish-desktop/src/components/chat-message-row/ThoughtSearchBar.module.css` | 废弃样式 | 78 | 无残留样式引用 |
| 8 | `apps/crish-desktop/src/workers/thoughtWorker.ts` | 废弃 Worker | 283 | 消除禁令 11 违规项 |
| 9 | `apps/crish-desktop/src/workers/thoughtWorker.test.ts` | 废弃测试 | 65 | 随 Worker 物理删除 |
| 10 | `apps/crish-desktop/src/store/thoughtInspectorStore.ts` | 废弃 Store | 97 | 消除孤立全局状态 |
| 11 | `apps/crish-desktop/src/store/thoughtInspectorStore.test.ts` | 废弃测试 | 52 | 随 Store 物理删除 |
| 12 | `apps/crish-desktop/src/components/chat-message-row/StreamingTextBlock.tsx` | 旧追加器 | 59 | 统一收敛至 `StreamingMarkdownView` |
| 13 | `apps/crish-desktop/src/components/chat-message-row/StreamingTextBlock.test.tsx` | 旧测试 | 109 | 随组件物理删除 |
| 14 | `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx` | 骨架屏源 | 115 | 统一收敛至 `MarkdownBlockItem`（原位双缓冲） |
| 15 | `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.module.css`| 骨架屏样式 | 48 | 彻底销毁 `.skeletonLine` 样式 |
| 16 | `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.test.tsx`| 骨架屏测试 | 92 | 转由 `StreamingMarkdownView.test.tsx` 覆盖 |
| 17 | `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.ts` | 历史手写 | 412 | 统一采用 `IncrementalBlockSplitter` |
| 18 | `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParserRender.ts` | 历史手写 | 285 | 统一采用 Rust `md_render` + 垫片 |
| 19 | `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParserTypes.ts` | 历史手写 | 118 | 统一类型契约 |
| 20 | `apps/crish-desktop/src/api/markdown-render/IncrementalInlineRenderer.ts` | 历史手写 | 224 | 统一采用 `SpeculativeVirtualCloser` |
| 21 | `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.test.ts` | 历史测试 | 185 | 随历史手写包删除 |
| 22 | `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.parity.test.ts` | 历史测试 | 146 | 随历史手写包删除 |
| 23 | `apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.adversarial.test.ts` | 历史测试 | 338 | 随历史手写包删除 |

### 符号级死代码与反模式清除：
1. `parseMarkdownIntoBlocks.ts`: 物理删除未调用死函数 `hasIncompleteCodeFence` 与 `hasTable`，清除 `hasFootnote` 粗暴退化逻辑，清除无界 Map 正则缓存；
2. `continuityUiStore.ts`: 物理删除违背禁令 9 的 `circuitBanners` 熔断状态与方法；
3. `sessionMessageActionsTools.ts`: 物理删除第 205-208 行外层二次冗余 `reconcileAssistantMessageBlocks` 调用；
4. `useStreamBatchers.ts`: 物理删除未使用的 `renderBufferRef` 死引用。

---

## 三、先删后改实施阶段顺序（DAG 实施图）

```
【阶段 0：死层物理清剿与架构瘦身】(强串行门禁)
  ├── 1. 物理删除 23 个废弃文件 (git rm，消除 3,694 行死代码)
  ├── 2. 清除 store / workers / storeAccess 废弃 re-export
  ├── 3. 拆分 timelineNormalizer.ts 为 4 个 ≤180 行子模块，消除 CI 门禁超标
  └── 4. 彻底剔除 circuitBanners 熔断器与 parseMarkdownIntoBlocks 死函数
        │
        ▼ (阶段 0 门禁全绿：npm run typecheck + check:line-counts 通过)
【阶段 1 & 阶段 2：内核协议分流与生命周期单源收敛】(双轨无冲突并行)
  ├── Track A (Rust 内核): StreamingTagExtractor 标签零逃逸分流 + 修复 stream.rs 纯思考流判空与 Abort 抢救
  └── Track B (TS Bridge): onMessageDelta 单增量生产者 + Map 双账本 + 三元槽位 Reconciler + ErrorMessageBanner
        │
        ▼
【阶段 3：渐进分块与双缓冲无缝晋升】(渲染引擎底座)
  ├── 1. IncrementalBlockSplitter 基于行前缀和的 O(1) 增量切分器
  ├── 2. SpeculativeVirtualCloser 纯内存投机语法闭合 (代码块/表格/LaTeX)
  └── 3. MarkdownBlockItem 原位纯文本垫片锁定高度，Rust 异步编译返回原子替换 (Zero-CLS, 0 骨架屏)
        │
        ▼
【阶段 4：速率自适应、流式表格与 HTML 沙箱】(三特性协同装配)
  ├── 1. SlidingWindowRateEstimator (SW-TRE) 速率感知 + AdaptiveAnimateTimeline (GPU CSS) + TURBO 模式
  ├── 2. 流式表格 GFM DFA 语法前瞻锁定 + hasTable 光标抑制 + usePinnedScroll 8px 容差双向吸底
  └── 3. preprocessCustomTags 空行三明治 + normalizeUnclosedOpenTags 实时渲染 + React Portal 沙箱
        │
        ▼
【阶段 5：全链路集成压测与防退化门禁】(交付总验收)
  ├── 1. cargo test --workspace (全部 Rust 测试 100% 通过)
  ├── 2. npm run typecheck + npm test (全部前端测试 100% 通过)
  ├── 3. 50k+ Tokens 满帧压测 (≥59.5 FPS, CLS = 0.000, 单帧耗时 < 4ms)
  └── 4. Tauri MCP 真机 UI 视觉核验 (桌面端 5 t/s 与 1000 t/s 流式呈现无跳变)
```

---

## 四、核心工程契约与架构决策记录（ADRs）

- **ADR-001：确立单一渲染协调器，杜绝组件分裂**  
  全链路只保留 `StreamingMarkdownView` 与 `MarkdownBlockItem`，禁止派生 `ActiveTailMarkdownBlock` 或重新引入 `AsyncMarkdownBlock`。
- **ADR-002：语义哈希稳定 Block Key 策略**  
  封口块采用 `${msgId}-blk-${index}-${hash16}`，活动草稿块采用 `${msgId}-blk-${tailIndex}-active`，彻底终结索引漂移引起的级联缓存击穿。
- **ADR-003：宏观分块优先，组件沙箱内联**  
  `IncrementalBlockSplitter` 拥有最高词法切分权；`preprocessCustomTags` 作为块内部 AST 预处理器，防止全局正则将组件切碎。
- **ADR-004：投机补全纯内存化，保证数据源纯洁性**  
  `SpeculativeVirtualCloser` 仅在内存中补全用于视图展示的草稿副本，绝不修改或落盘原始流式 Markdown 字符串。
- **ADR-005：单生产者单源状态机与三元槽位保全**  
  `onMessageDelta` 唯一驱动增量；`turnAuthoritativeTexts` Map 账本承载收口快照；`(turnIndex, type, id)` 槽位 100% 永久保全历史思考链与工具调用卡片。
