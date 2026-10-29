# 架构割裂（多引擎乱象）与全球顶尖梯队对标全景差距矩阵

> **审查基准**：本项目实际代码库与配置文件（拒绝概念设计文档，以物理代码与集成现状为唯一真理依据）。  
> **核心受审代码域**：
> - `reference/markdown-editor/`（独立原型编辑器：虚拟化块渲染、TableStore、IndentModel、Bidi、math-preview.worker）
> - `apps/crish-desktop/src/components/chat-message-row/`（StreamingMarkdownView、MarkdownBlockItem、StreamingGfmTable）
> - `apps/crish-desktop/src/components/chat-composer/`（基于 Tiptap / ProseMirror 的输入区及反序列化器）
> - `crates/conex-markdown/`（Rust pulldown-cmark + syntect + ammonia 渲染流水线）
> - `crates/conex-md-ast/`（基于 markdown-rs 的 AST 与 CRDT 块树映射契约）

---

## 一、执行摘要与核心论断

经过对 Conex 代码库全景的深度代码审计，本报告给出明确而严肃的结论：

> **核心论断**：当前软件的 Markdown 体系处于**「多头割裂、各自为战、能力严重倒挂」**的极度不成熟状态。  
> 软件内部事实上存在 **4 套互不相通的 Markdown 实现**。在独立原型中投入巨资研发的高级特性（如 KaTeX 公式、Callout、复杂表格岛、Bidi 双向排版）被**死锁在隔离目录**，无法服务于主桌面产品；而主桌面的聊天流式渲染端却在公式与图表方面**处于完全失明（0分）状态**，同时输入框 Composer 又在**主动自我阉割** Markdown 块级语义。

### 业界综合段位定级

对比全球顶尖产品梯队（Typora、Obsidian、Notion、Bear、Cursor），Conex 的真实段位定级如下：

| 对标产品 | 核心定位与技术底座 | 综合成熟度 | 整体评价 |
| :--- | :--- | :--- | :--- |
| **Typora** | 混合式原生 WYSIWYG 单一视图，极致排版 | **4.8 / 5.0** | 桌面级单篇排版黄金标杆 |
| **Obsidian** | CodeMirror 6 统一双模，插件扩展生态 | **4.9 / 5.0** | 个人知识库与扩展性终极形态 |
| **Notion** | 块级 Block 模型，数据库与排版无缝融合 | **4.4 / 5.0** | 结构化协同块级排版代表 |
| **Bear** | 原生 Swift/C++ Polaris 引擎，极致排版美学 | **4.5 / 5.0** | 消费级优雅排版标杆 |
| **Cursor** | VS Code 扩展架构 + 极速流式 LLM 对话通道 | **4.3 / 5.0** | AI 辅助研发第一梯队流式体验 |
| **Conex（纸面原型）** | TanStack Virtual + 自研 2391 行解析器 + TableIsland | **3.6 / 5.0** | 实验室指标亮眼，但未工程落地 |
| **Conex（真实宿主交付）** | 4 套分裂引擎 + 聊天公式失明 + 格式强制扁平 | **2.2 / 5.0** | **处于第三梯队，落后于开源常规 Chat 客户端** |

---

## 二、剖析多头割裂架构：四大独立 Markdown 体系的深度断层

代码审查证实，在同一个仓库中，不同功能模块为了解决各自眼前的需求，分别引入并自研了 4 套完全不同的 Markdown 数据结构、解析管线与渲染逻辑。各体系间零复用、零共享，甚至存在隐蔽的数据截断与语法排斥。

```
                    ┌─────────────────────────────────────────────────────────┐
                    │               Conex 代码库内分裂的 4 套体系               │
                    └─────────────────────────────────────────────────────────┘
                                                 │
         ┌───────────────────┬───────────────────┴───────────────────┬───────────────────┐
         ▼                   ▼                                       ▼                   ▼
┌─────────────────┐ ┌─────────────────┐                     ┌─────────────────┐ ┌─────────────────┐
│  体系一：聊天流式 │ │  体系二：输入框   │                     │  体系三：原型   │ │  体系四：CRDT   │
│  只读渲染管线   │ │  Composer      │                     │  独立编辑器     │ │  AST 块树映射   │
├─────────────────┤ ├─────────────────┤                     ├─────────────────┤ ├─────────────────┤
│• 核心: Rust IPC │ │• 核心: Tiptap / │                     │• 核心: 自研     │ │• 核心: markdown-│
│  pulldown-cmark │ │  ProseMirror    │                     │  parser.ts      │ │  rs (markdown)  │
│• 兜底: marked + │ │• 扁平化反序列化 │                     │  (2391行手写)   │ │• 强转为 BlockIR │
│  自研正则替换   │ │  主动降维块结构 │                     │• 虚拟化行渲染   │ │  表格/任务项丢失│
│• 独占流式防抖与 │ │  (#, >, - 转段落)│                     │• KaTeX / 岛表格 │ │• 插入注释宏     │
│  速率估计调度器 │ │• 仅限行内修饰   │                     │• 纯净独立孤岛   │ │  <!--c:UUID-->  │
└─────────────────┘ └─────────────────┘                     └─────────────────┘ └─────────────────┘
```

---

### 1. 体系一：聊天流式只读渲染（Chat Read-Only Streaming Pipeline）

- **承载代码**：
  - 前端调度：`apps/crish-desktop/src/components/chat-message-row/StreamingMarkdownView.tsx`、`MarkdownBlockItem.tsx`、`useStreamingBlocks.ts`
  - 前端切块与流式：`apps/crish-desktop/src/api/markdown/IncrementalBlockSplitter.ts`、`SpeculativeVirtualCloser.ts`、`StreamingGfmTable.tsx`
  - 异步分发网关：`apps/crish-desktop/src/api/markdownRenderAsync.ts`
  - 离线/兜底通道：`apps/crish-desktop/src/workers/markdown-render-standalone.ts`、`apps/crish-desktop/src/api/markdown-render/markdownPlugins.ts`
  - 后端渲染内核：`crates/conex-markdown/src/renderer.rs`
- **技术实现**：
  - **主路径**：通过 Rust IPC 调用 `md_render` 命令，后端使用 `pulldown-cmark` 驱动，开启 `ENABLE_TABLES | ENABLE_TASKLISTS | ENABLE_STRIKETHROUGH`，配合 `syntect` 高亮代码，并通过 `ammonia` 实施严格的 HTML 清洗。
  - **兜底路径**：当 Rust IPC 缺失或崩溃时，回退到 Web Worker 中的 `marked.Lexer`，配合 `markdownPlugins.ts` 中自研的一整套基于正则替换与私有占位符（`\uE000CRISH_MD_...`）的纯 TS 解析器。
  - **流式特化机制**：拥有完善的流式防护体系。`SlidingWindowRateEstimator` 在 500ms 滑动窗口内估算字符速率；`AdaptiveAnimateTimeline` 对齐 GPU 挂钟时间轴；`IncrementalBlockSplitter` 维护行前缀和做 $O(1)$ 语法块封口；`StreamingGfmTableParser` 拦截流式未闭合表格并逐行发射。
- **致命缺陷与盲区**：
  1. **数学公式（LaTeX）完全缺失**：Rust 渲染器未启用公式扩展，前端 `apps/crish-desktop/package.json` **完全没有引入 `katex` 或 `mathjax`**。LLM 生成的所有 LaTeX 公式（`$...$` 和 `$$...$$`）原样暴露为裸文本。
  2. **Callout 语法不支持**：`crates/conex-markdown/src/renderer.rs:246` 将所有 `Tag::BlockQuote` 无脑渲染为 `<blockquote class="md-quote">`。GitHub 风格的 `> [!NOTE]`、`> [!WARNING]` 直接把标记字符当正文输出。
  3. **HTML 标签过度防卫**：`crates/conex-markdown/src/ammonia_config.rs` 白名单中**排除了 `<details>` 和 `<summary>`**，所有原生折叠块标签被全量脱水过滤。
  4. **双轨截断隐患**：Rust 端限制 `MAX_MARKDOWN_INPUT = 5MB`，但 Worker/TS 兜底端的 `markdownPlugins.ts:46` 却写死了 `MAX_MARKDOWN_INPUT = 100_000`（100KB）。一旦发生 IPC 故障触发降级，超过 100KB 的长文本会被**静默截断**。

---

### 2. 体系二：聊天输入框 Composer（Rich-text Input Engine）

- **承载代码**：
  - 编辑器容器：`apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`、`TiptapComposerField.tsx`
  - 扩展与按键：`apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts`、`TiptapKeymap.ts`
  - 反序列化器：`apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts`
  - 序列化器：`apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts`
- **技术实现**：
  - 基于 ProseMirror 封装的 `@tiptap/react` 富文本编辑器。
  - 支持行内修饰（bold, italic, strike, inline code, link, mention）。
- **致命缺陷与盲区**：
  1. **块级排版被主动降维阉割**：`markdownDeserializer.ts:4-12` 明确记载了输出契约的无奈妥协：
     > *"composer 编辑器 schema 刻意禁用块级排版节点（heading / bulletList / orderedList / listItem / taskList / taskItem / blockquote / horizontalRule ...）因此 parseFromMarkdown 输出恒为行内 schema 形状：块级结构降维为段落并原样保留标记文本（# / - / - [ ] / 1. /> / ---）"*
  2. **语义粉碎机**：用户在输入框中粘贴带有各级标题、引用块、列表的 Markdown 时，反序列化器会粗暴地将其全部打散为纯段落，并在段落文本前强行拼入字面量 `# `、`> `、`- `。输入框无法维护真实的 AST 树，完全丧失了现代富文本编辑器应有的结构编辑体验。
  3. **表格与公式零容忍**：Composer schema 根本没有注册 Table 扩展和 Math 扩展，粘贴表格时结构被彻底撕裂，公式直接沦为纯文本。

---

### 3. 体系三：独立原型编辑器（Standalone Prototype Editor - `reference/markdown-editor`）

- **承载代码**：
  - 核心解析器：`reference/markdown-editor/src/core/parser.ts`（2391 行纯自研解析引擎）
  - 抽象语法树：`reference/markdown-editor/src/core/ast.ts`（LineNode + InlineNode）
  - 渲染主引擎：`reference/markdown-editor/src/components/MarkdownEngine.tsx`（2484 行虚拟化容器）
  - 渲染注册表：`reference/markdown-editor/src/components/BlockRenderer.tsx`（1661 行）
  - 表格岛系统：`reference/markdown-editor/src/core/TableStore.ts`、`tableIsland.ts`、`TableBlock.tsx`
  - 公式系统：`reference/markdown-editor/src/components/InlineMath.tsx`、`MathPreview.tsx`、`src/worker/math-preview.worker.ts`
  - 排版与布局：`reference/markdown-editor/src/core/layout/IndentModel.ts`、`src/core/Bidi.ts`、`src/core/foldState.ts`
- **技术实现**：
  - 基于 `@tanstack/react-virtual` 的行级/块级虚拟化渲染架构。
  - 自研 2391 行的行级扫描 CommonMark/GFM 解析器，引入了 `ScanFailureMemo` 记忆集，专门解决回溯正则导致的 $O(2^n)$ 灾难性性能爆炸。
  - 原生支持 KaTeX 离线 Worker 渲染（`math-preview.worker.ts`）。
  - 支持 GitHub 风格的 5 种 Callout 类型（`note`, `tip`, `important`, `warning`, `caution`），带有专用 SVG 图标和边框高亮。
  - 自研「表格岛（Table Island）」架构：`TableStore` 维护列宽（`tableWidths`）、单元格选区矩形（`enterCellSelection`）、拖拽调宽与结构变换（`applyStructOp`）。
  - 自研 `IndentModel` 实现列表像素级对齐，自研 `Bidi.ts` 实现阿拉伯语/希伯来语等 RTL 弱类型行级快速扫描。
- **致命缺陷与盲区**：
  1. **孤岛自嗨，主工程零导入**：在 `apps/crish-desktop` 中检索该目录的引用，结果为 **0 行**！这是一个完全自立门户的独立项目（拥有独立的 `package.json`、`vite.config.ts`、`src-tauri` 桌面壳）。原型中耗费巨量心血构建的先进排版能力，**在主产品中完全不可用**。
  2. **脆弱的手写解析器**：放弃了业界经过千锤百炼的 AST 引擎（如 CodeMirror 6 Lezer 或 remark/mdast），在 `parser.ts` 中手写了 2391 行的行内起止符匹配逻辑与状态机。即便有 `failedAt` 缓存，在应对畸形嵌套的复杂 Markdown 时，稳定性与规范遵从度依然难以与真实成熟引擎相提并论。
  3. **缺失流式防御**：该原型完全基于静态文档设计，只有极其简陋的 `StreamBuffer.ts`（rAF 批处理），完全缺失聊天端所拥有的投机闭合、速率平滑与防止抖动机制。

---

### 4. 体系四：CRDT 文档协作与 AST 转换（CRDT AST & BlockIR Engine - `crates/conex-md-ast`）

- **承载代码**：
  - 核心桥接：`crates/conex-md-ast/src/lib.rs`、`parse_mdast.rs`、`serialize.rs`、`mode.rs`
  - 底层模型：`crates/conex-doc-collab/src/ir.rs`（`BlockTree`, `BlockKind`, `BlockNode`）
- **技术实现**：
  - 采用 Rust `markdown` crate（即 `markdown-rs`）作为 GFM 解析主路径，将其 lowering 映射为 `conex-doc-collab` 的 BlockIR 树结构。
  - 采用 `<!--c:UUID-->` 独占行宏注释在 Markdown 文本中持久化记录块身份，用于多人协作/Agent 操作的 CRDT 稳定寻址。
- **致命缺陷与盲区**：
  1. **后端解析库双头割裂**：同一个项目的 Rust 后端，渲染用的是 `pulldown-cmark`，而 AST 协作层用的却是 `markdown-rs`！两者的解析语义、对不合规语法的容忍度和 AST 事件模型完全不同。
  2. **BlockKind 核心实体残缺**：`crates/conex-doc-collab/src/ir.rs:14-28` 定义的 `BlockKind` 只有：
     `Paragraph`, `Heading`, `BulletItem`, `OrderedItem`, `Code`, `Quote`, `Divider`, `Unknown`。
     **其枚举中根本没有 `Table` 和 `TaskItem`！**
  3. **有损降级丑态**：`crates/conex-md-ast/src/lib.rs:22-29` 诚实地暴露了底层的妥协：
     > *"collab IR 无 Table/TaskItem 变体 -> 表=Paragraph+structure_note（行列/对齐 plain）；任务=Bullet/Ordered+勾选 plain+列表级 note"*  
     这意味着经过 AST 转换后，表格被粗暴地退化为普通段落文本，并在旁边挂一个非标准的 `structure_note` 字符串。AST 层面无法将表格作为结构化实体进行查询与修改，直接切断了与 `reference/markdown-editor` 中 `TableStore` 的未来对接可能。

---

## 三、四大体系横向能力互斥与倒挂矩阵

下表揭示了 Conex 内部 4 套体系在技术选型与功能支持上的极端分歧与倒挂：

| 评估维度 | 体系一：聊天流式只读渲染 (`chat-message-row`) | 体系二：聊天输入框 (`chat-composer`) | 体系三：独立原型编辑器 (`reference/markdown-editor`) | 体系四：CRDT AST 协作 (`conex-md-ast`) |
| :--- | :--- | :--- | :--- | :--- |
| **底层引擎/库** | Rust `pulldown-cmark` / TS `marked` + 正则 | ProseMirror / `@tiptap/core` | 自研 2391 行 TS `parser.ts` | Rust `markdown-rs` (`markdown` crate) |
| **输出/数据结构** | HTML 字符串 + 流式 React 树 | ProseMirror JSON 树 (强制降维) | 自研 `LineNode` / `InlineNode` 树 | `BlockTree` (`BlockIR` + UUID 注释) |
| **CommonMark 兼容** | 良好 (仅限只读子集) | 极差 (仅限行内，块级强行降维) | 中等 (自研状态机，存在边缘分歧) | 良好 (markdown-rs 保证) |
| **流式防抖/自适应** | **支持** (速率估计 + Timeline + 双缓冲) | 不适用 | **不支持** (仅有简单 rAF 缓冲) | 不适用 |
| **数学公式 (LaTeX)** | **0% 不支持** (裸字符串) | **0% 不支持** (裸字符串) | **90% 支持** (KaTeX + Worker 离线) | **0% 不支持** (视为普通文本段落) |
| **Callout 警告块** | **0% 不支持** (渲染为普通引用) | **0% 不支持** (降维为 `> ` 文本) | **100% 支持** (5类图标 + 状态样式) | **0% 不支持** (视为普通 Quote) |
| **表格支持度** | **仅流式追加展示** (完全不可交互编辑)| **0% 不支持** (无法渲染与输入) | **专业级表格岛** (选区/拖拽/结构操作) | **降级退化** (强转为段落+文本Note) |
| **双向文本 (Bidi)** | 浏览器默认排版 | 浏览器默认排版 | **专用 RTL 弱类型扫描器** (`Bidi.ts`)| 不关心 |
| **代码块高亮** | `syntect` (Rust) / `highlight.js` (Worker) | 简单纯文本代码块 | 语法 Token 提取 + 外部注入 | 不关心 (仅保留代码文本) |
| **HTML 原生标签** | 严重杀伤 (仅透传 `<img>`，禁 `<details>`)| 不支持 | 良好 (CommonMark 7 类 HTML 块透传) | 不支持 |
| **彼此复用度** | **0** (独立实现) | **0** (独立实现) | **0** (独立实现) | **0** (独立实现) |

### 核心倒挂现象总结

1. **「生产饥渴，实验室锁死」**：科研与对话场景中最需要公式（KaTeX）和高亮引文（Callout），生产端代码（`chat-message-row`）因 Rust 缺乏对应逻辑且前端未装依赖而彻底缺失；反观隔离在实验室里的原型（`reference/markdown-editor`）早早实现了 Worker 驱动的 KaTeX 和华丽的 Callout，两者同在一个仓库却如同相隔银河。
2. **「流式防护无法反哺」**：`chat-message-row` 团队花费大量精力调通的滑动窗口速率估算（`SlidingWindowRateEstimator`）、投机闭合器（`SpeculativeVirtualCloser`）和帧率自适应时间轴（`AdaptiveAnimateTimeline`），全部硬编码在聊天组件树内，编辑器原型团队无法复用这套算法，导致编辑器原型在接入长流文本时依然存在重排闪烁。
3. **「表格技术完全撕裂」**：一个软件拥有四种表格表示法——聊天端的静态只读 HTML 表格、流式追加专用的行解析器、编辑器原型的 Zustand 驱动的坐标系表格岛、以及 AST 协作层降级为带 Note 的假段落表格。四套模型之间没有任何序列化转换通道。

---

## 四、全球最顶尖 Markdown 产品全景横向对标矩阵

本章引入 **Typora、Obsidian、Notion、Bear、Cursor** 五款全球顶级产品，与 Conex 的现状进行 8 大维度的 1~5 分量化对标（5分最高，1分最低）。

> **打分标准说明**：
> - **5分**：业界标杆，规范全兼容，交互无死角，架构高度一致自洽。
> - **4分**：成熟工业级，覆盖绝大多数主流与进阶场景，存在极少数非核心短板。
> - **3分**：可用但体验平庸，存在明显的功能缺口或较多小瑕疵。
> - **2分**：架构出现断层，关键能力有严重缺失，使用时有挫败感。
> - **1分**：完全不可用、架构严重扭曲或功能完全未实现。

### 1. 全景量化打分表

| 评测维度 | Typora | Obsidian | Notion | Bear | Cursor | Conex (当前宿主实况) | Conex (原型纸面潜力) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. 基础 CommonMark/GFM 解析合规度** | 5.0 | 5.0 | 3.5 | 4.5 | 4.5 | **2.5** | 3.5 |
| **2. 流式 LLM 生成体验 (防抖/平滑/零跳变)** | N/A | 2.5 | 3.0 | N/A | 4.5 | **4.0** | 2.0 |
| **3. 数学公式 (LaTeX / KaTeX) 支持** | 5.0 | 5.0 | 4.5 | 3.5 | 4.0 | **0.0** | 4.0 |
| **4. 图表引擎 (Mermaid / PlantUML) 支持** | 4.5 | 5.0 | 4.0 | 2.0 | 3.5 | **0.0** | 0.0 |
| **5. 表格能力 (流式/复杂表格/交互编辑)** | 5.0 | 4.5 | 4.5 | 3.5 | 3.0 | **2.0** | 4.0 |
| **6. 排版视觉与主题系统** | 4.5 | 5.0 | 4.5 | 5.0 | 3.5 | **2.5** | 3.5 |
| **7. 交互扩展性 (Callout/折叠/脚注/标签)** | 4.5 | 5.0 | 4.5 | 3.5 | 3.5 | **1.5** | 3.5 |
| **8. 架构统一性与工程自洽性** | 4.5 | 5.0 | 4.0 | 4.5 | 4.0 | **1.0** | 1.0 |
| **综合加权得分 (满分 5.0)** | **4.7** | **4.9** | **4.1** | **3.8** | **3.8** | **1.7** | **2.7** |

*(注：Typora 与 Bear 无内置 LLM 生成对话场景，该项不计入其劣势惩罚。)*

---

### 2. 逐项深度对标与技术差距剖析

#### 维度一：基础 CommonMark/GFM 解析合规度
- **业界顶尖水准**：
  - **Obsidian**：基于 CodeMirror 6 解析器管线与成熟的 markdown-it/remark 插件系统，严格遵从 CommonMark 0.31.2 规范，能够精准处理成对分隔符游程（Delimiter Runs）、复杂内联嵌套规则与 Setext 标题打断。
  - **Typora**：业内极少数能够完美统一 Markdown 源码与 WYSIWYG 渲染的标杆，对所有边缘用例（如在引用块中嵌套代码块与列表）解析零失真。
- **Conex 实况差距**：
  - 聊天主路径虽然依赖 `pulldown-cmark` 获得了较好的基础合规度，但由于后端过度防卫，**粗暴逃逸所有原生 HTML 标签**。
  - 降级路径中的 `markdownPlugins.ts` 完全依靠脆弱的正则表达式进行查找替换（例如匹配行内格式的正则），在应对交替嵌套（如 `**加粗 _斜体_**`）或代码反引号包含星号时频频失效。
  - 原型编辑器的 `parser.ts` 试图手写 CommonMark 全集，导致其必须编写复杂的 `ScanFailureMemo`（`failedAt` / `noClose`）来防止回溯爆炸，属于典型的重复造劣质轮子。

#### 维度二：流式 LLM 生成体验（防抖、平滑、零跳变）
- **业界顶尖水准**：
  - **Cursor**：通过针对 VS Code 编辑器核心深度改造的流式缓冲通道，在 LLM 高速吐字时保持稳定的行高锁定与平滑帧率，视口滚动锁（Scroll Lock）极为稳固，末行未完成的代码块或表格有平滑的占位过渡。
- **Conex 实况分析（亮点与短板并存）**：
  - **亮点**：Conex 在 `apps/crish-desktop` 中实现的流式链路是整个项目中最具技术含量的模块。`IncrementalBlockSplitter` 实现了行级增量扫描，`SpeculativeVirtualCloser` 实施了内存级的投机语法补全，`AdaptiveAnimateTimeline` 与 `SlidingWindowRateEstimator` 在高速 token 涌入时能够动态降级动画并锁定计算频次，有效消除了普通 Chat 客户端常见的全量重排闪烁。
  - **短板**：当活跃末尾块由普通文本向 GFM 表格或多行代码块转变时，由于 `StreamingGfmTable` 挂载以及代码语法高亮分词的开销，仍会出现短暂的 DOM 切换微跳变。更严重的是，该能力完全没有抽象为公共包，无法为编辑态赋能。

#### 维度三：数学公式（LaTeX / KaTeX）支持
- **业界顶尖水准**：
  - **Typora / Obsidian**：提供媲美 LaTeX 原生的公式体验。支持行内 `$...$` 与行间 `$$...$$`，支持 MathJax/KaTeX 语法扩展、物理宏包、公式自动编号、矩阵与多行方程对齐（`align*`），且在输入时提供毫秒级实时渲染。
  - **Cursor**：聊天窗口对模型输出的公式提供无缝的 KaTeX 渲染支持。
- **Conex 实况差距（灾难级缺陷）**：
  - **主宿主完全失明（0 分）**：在核心的聊天界面中，**完全没有集成任何数学渲染引擎**。一个面向现代 AI 编码辅助与科研对话的工具，模型输出的所有数学公式均显示为刺眼的原始 LaTeX 源码，严重破坏用户体验。
  - **原型的自嗨孤岛**：原型目录中虽然编写了完整的 `InlineMath.tsx` 和 `math-preview.worker.ts`，却因为从未启动架构整合工作，导致生产端毫无受益。

#### 维度四：图表引擎（Mermaid / PlantUML）支持
- **业界顶尖水准**：
  - **Obsidian**：原生内置 Mermaid 图表引擎，支持流程图、时序图、甘特图、类图、状态机以及脑图的交互式缩放与拖拽。
  - **Notion**：支持在代码块中切换 Mermaid 模式并直接呈现可视化架构图。
- **Conex 实况差距（绝对真空）**：
  - 全工程检索 `mermaid` 或 `plantuml`，**匹配结果为 0**。无论在宿主聊天端还是原型编辑器中，图表渲染能力彻底缺失。遇到图表代码块，只能显示为高亮的代码文本，没有任何可视化渲染能力。

#### 维度五：表格能力（复杂表格、流式追加、交互编辑）
- **业界顶尖水准**：
  - **Typora**：所见即所得表格操作的行业天花板。支持可视化拖拽调整任意列宽、快捷键快速增删行/列、跨单元格批量文本选择、以及富文本格式化。
  - **Notion**：表格作为数据驱动的一级公民，支持单元格换行控制、数据类型定义与拖拽排序。
  - **Obsidian**：自 1.5 版本起引入了全新的可视化表格编辑器，彻底摆脱了手打 Markdown 竖线的低效操作。
- **Conex 实况差距**：
  - **聊天端是死表格**：`StreamingGfmTable.tsx` 仅能解决流式传输中表格逐行展示的视觉跳变问题，输出的是纯只读的静态 HTML。用户无法拖动列宽，无法选择单个单元格内容，无法一键复制为 CSV/Excel。
  - **原型端未落地的表格岛**：原型端虽然在 `TableStore.ts` 中实现了完整的相对坐标选区模型（`tableSelection.ts`）与列宽记忆，但由于缺乏与宿主协作层（`conex-doc-collab`）的数据对齐，这一系统注定无法支持协同与持久化。
  - **AST 层的毁灭性打击**：在 `crates/conex-md-ast` 中，表格直接被降格为普通文本段落，整个底层架构对表格是歧视性的。

#### 维度六：排版视觉与主题系统
- **业界顶尖水准**：
  - **Bear**：被誉为 Markdown 排版的美学标杆。字体层级、行间距、引用线缩进、以及在浅色/暗色主题下的色调饱和度控制达到了像素级艺术水准。
  - **Obsidian**：拥有强大的 CSS 变量系统与全球社区沉淀的数百款专业排版主题，支持完全自定义的排版微调。
- **Conex 实况差距**：
  - 聊天界面采用模块化 CSS，各处间距（padding/margin）充斥着硬编码的微调值。
  - 原型编辑器采用了一套自成体系的 `renderTheme.ts` 和 `--grid-size: 28px` 栅格，与主桌面的设计系统令牌（Design Tokens）互不相通。全局缺乏统一的排版规范与打印导出样式。

#### 维度七：交互扩展性（Callout / 折叠 / 脚注 / 标签）
- **业界顶尖水准**：
  - **Obsidian**：开创了现代 Markdown Callout 标准（`> [!NOTE]`，支持折叠标记 `> [!NOTE]-`、自定义图标与嵌套 Callout），支持全文脚注快速跳转、块引用（Block Reference）与标签过滤。
  - **Typora**：完整支持脚注、YAML Frontmatter 属性卡片、TOC 目录大纲自动提取。
- **Conex 实况差距**：
  - **Callout 仅在原型存活**：主聊天界面中，Callout 语法会被无情地打回原形变为朴素的灰色引用边框。
  - **原生折叠被封杀**：`crates/conex-markdown/src/ammonia_config.rs` 白名单直接剥夺了 `<details><summary>` 的合法地位，用户与模型无法利用原生 HTML 实现内容折叠。
  - **脚注被代码写死拒绝**：`crates/conex-markdown/src/renderer.rs:223` 显式声明：
    ```rust
    Event::FootnoteReference(_) => {} // 不支持脚注
    ```
    对标准 GFM 脚注语法进行了硬性丢弃。

#### 维度八：架构统一性与工程自洽性
- **业界顶尖水准**：
  - **Obsidian / Bear / Typora**：均拥有高度统一的核心引擎。无论是读、写、预览还是插件交互，都运行在同一套 AST 与虚拟 DOM 模型之上，数据流单一且清晰。
- **Conex 实况差距（严重不及格，1.0 分）**：
  - 四套完全不同的 Markdown 体系（pulldown-cmark, ProseMirror, 自研 parser.ts, markdown-rs）。
  - 四套体系使用四种不同的解析库，维护四种不同的语法树表示，面对同一种 Markdown 语法会产生四种不同的解析与展示结果。工程实现呈现出高度的碎片化与重复建设，技术负债极重。

---

## 五、业界真实段位裁决与核心硬伤清单（直击痛点）

### 1. 业界真实段位最终裁决

> **最终裁决**：  
> Conex 当前的 Markdown 渲染水平在业界**处于二流偏下至三流之间（第 3 梯队）**。  
> 
> 虽然其在前端聊天场景中针对 LLM 流式输出研发了具备业界一流水准的防抖调度机制（`AdaptiveAnimateTimeline` + `IncrementalBlockSplitter`），并在孤岛原型中攻坚了表格岛和 KaTeX 离线渲染，**但从最终软件交付给用户的端到端实际能力来看，由于严重的架构割裂，所有高级能力均未打通**。用户在核心聊天界面中面对的是一个**不能渲染数学公式、不能渲染架构图表、不能折叠、不能展示 Callout、且输入框会破坏文档排版结构的半成品 Markdown 环境**。其真实可用性甚至落后于大量基于开源方案（如 markdown-it + katex）拼装的轻量级 Chat 工具。

---

### 2. 八大核心硬伤清单（不留情面）

#### 硬伤 1：宿主核心对话通道「数学公式彻底失明」
- **缺陷定性**：功能性严重缺失（P0 级缺陷）。
- **代码事实**：`apps/crish-desktop/package.json` 中不存在 `katex` 或 `mathjax` 依赖；`crates/conex-markdown/src/renderer.rs` 没有公式事件分支。
- **痛点后果**：任何包含科学计算、算法推导、机器学习理论或数据分析的对话，LLM 输出的 LaTeX 全部以丑陋的原始文本裸露，使得软件在学术、科研与工程研发场景下的专业度大打折扣。

#### 硬伤 2：全工程图表渲染引擎「完全绝对真空」
- **缺陷定性**：现代知识工具核心能力断代。
- **代码事实**：全仓库检索 `mermaid`、`plantuml` 命中数为 0。
- **痛点后果**：模型无法用可视化图表展示架构图、状态机、时序图和流程图，技术人员必须手动将代码复制到外部工具中查看，阻断了「分析-设计-编码」的沉浸式工作流。

#### 硬伤 3：聊天 Composer「块级结构主动自我阉割」
- **缺陷定性**：反人类的富文本降维设计。
- **代码事实**：`markdownDeserializer.ts` 刻意将 heading、blockquote、list、task 等块级节点强行压平为段落，并在前缀拼入字符。
- **痛点后果**：用户从外部复制格式完美的 Markdown 粘贴进输入框，格式瞬间被击得粉碎；输入框不支持表格和复杂结构，富文本编辑体验极度割裂。

#### 硬伤 4：核心资产「隔离孤岛化」沦为自娱自乐
- **缺陷定性**：工程管理与架构规划严重失职。
- **代码事实**：`reference/markdown-editor/` 包含 2391 行解析器、完备的 KaTeX 支持和复杂表格岛，但主宿主 `apps/crish-desktop` 中对其引用为 0。
- **痛点后果**：高昂研发成本沉淀的资产无法转化为产品竞争力，主产品与原型各走各路，造成严重的研发资源浪费与技术债务堆积。

#### 硬伤 5：HTML 标签粗暴剿灭与过度防卫
- **缺陷定性**：规范遵从度人为受损。
- **代码事实**：`crates/conex-markdown/src/renderer.rs:5` 声明仅透传 `<img>`，其他 raw HTML 全逃逸；`ammonia_config.rs` 封杀 `<details>` 与 `<summary>`。
- **痛点后果**：原生折叠列表无法展开，标准 HTML 嵌入式内容（音频、视频、iframe、折叠）全部损坏，严重偏离了 Markdown 规范倡导的「HTML 兼容」原则。

#### 硬伤 6：CRDT 协作层对表格与任务的「降级歧视」
- **缺陷定性**：核心数据模型设计重大缺陷。
- **代码事实**：`crates/conex-doc-collab/src/ir.rs` 的 `BlockKind` 枚举缺失 `Table` 与 `TaskItem`；`crates/conex-md-ast/src/lib.rs` 被迫将表格降格为挂着 Note 的普通文本段落。
- **痛点后果**：数据契约层先天残疾，导致协同架构根本无法原生支撑富表格与任务列表的实时协作与结构化查询，为未来的文档协作埋下了巨大的重构地雷。

#### 硬伤 7：多端降级时的「静默数据截断炸弹」
- **缺陷定性**：隐蔽性数据安全隐患。
- **代码事实**：Rust 后端限制 `MAX_MARKDOWN_INPUT = 5MB`，而 Worker/TS 降级端 `markdownPlugins.ts:46` 限制为 `100_000` 字符（100KB）。
- **痛点后果**：在系统 IPC 偶发抖动或 Web Worker 降级路径下，一旦处理超过 100KB 的技术文档或日志，系统会无声无息地切掉超长部分，用户无法察觉数据丢失，存在重大信任风险。

#### 硬伤 8：底层解析器「五马分尸」，缺乏单一真理源（SSOT）
- **缺陷定性**：系统架构严重失序。
- **代码事实**：
  1. Rust 渲染端用 `pulldown-cmark`；
  2. Rust AST 契约端用 `markdown-rs`；
  3. 前端 Worker 端用 `marked`；
  4. 前端降级兜底用正则查找替换；
  5. 前端 Composer 端用 `ProseMirror` schema；
  6. 原型编辑器用手写 `parser.ts`。
- **痛点后果**：全仓同时存在 6 种解析逻辑！任何语法的微小变更都需要在六处不同语言、不同架构的地方分别实现，造成了维护成本的指数级上升和不可避免的渲染一致性漂移。

---

## 六、战略重构靶向建议（Architecture Convergence Roadmap）

为彻底根治上述硬伤，技术架构必须果断推行**「四归一」收敛战略**，严禁继续在原有四套体系上打补丁：

```
                    ┌───────────────────────────────────────────────┐
                    │          未来的单一真理源架构 (SSOT 目标)          │
                    └───────────────────────────────────────────────┘
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         ▼                                                                   ▼
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│     统一底层：Rust 核心解析库     │                 │    统一前端：内核驱动的渲染与编辑   │
├─────────────────────────────────┤                 ├─────────────────────────────────┤
│• 淘汰 markdown-rs 与手写正则     │                 │• 将 reference 的表格岛与 KaTeX  │
│• 统一采用 pulldown-cmark        │ ──(单一事件流)──> │  抽离为独立的 `@crish/markdown` │
│• 扩展 AST 支持 Math、Callout、   │                 │• 聊天行与编辑器共用同一渲染运行时│
│  原生 Table 节点与 Details 标签  │                 │• 流式调度器全面赋能编辑态与阅读态│
└─────────────────────────────────┘                 └─────────────────────────────────┘
```

1. **废黜割裂的自研轮子，确立统一的底层解析核心**：
   - 彻底废除 `reference/markdown-editor/src/core/parser.ts`（2391行冗余代码）与 `markdownPlugins.ts`（手写正则）。
   - 将后端的 Markdown 解析权收敛至单一 Rust 库（建议以 `pulldown-cmark` 为基础），通过扩展官方抽象补全 Math（KaTeX 语法）与 Callout 识别，直接输出标准 AST 与预编译 HTML。
2. **打捞原型资产，成立统一的 `@crish/markdown-view` 前端包**：
   - 将 `reference/markdown-editor` 中的 `InlineMath`、`TableStore`、`TableIsland` 与 `Bidi` 从隔离目录彻底救出，封装为主产品与原型共享的公共组件包。
   - 在 `apps/crish-desktop` 中正式引入 `katex` 和 `mermaid`，立即补齐核心聊天端的公式与图表盲区。
3. **修复数据底座，将 Table 与 TaskItem 升格为一级 BlockKind**：
   - 彻底改造 `crates/conex-doc-collab/src/ir.rs`，增加原生 `BlockKind::Table` 与 `BlockKind::TaskItem`，终结「表格降格为段落文本 Note」的丑陋妥协。
4. **重建输入框 Composer 的 Schema 契约**：
   - 为 Tiptap Composer 赋予合理的富文本映射能力，放弃粗暴降维抹杀 Markdown 块级结构的策略，使输入框与展示端具备对称的排版感知力。
