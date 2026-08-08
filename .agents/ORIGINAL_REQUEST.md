# Original User Request

## 2026-08-04T13:42:02+08:00

<USER_REQUEST>
# Teamwork Project Prompt — Draft

> Status: Step 2 — Identifying ambiguity
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

设计并生成一套用于“软件需求迭代修复”的系统性、自上而下的多Agent协同修复方案系列文档。方案需纯粹基于逻辑执行顺序，覆盖从问题识别到验证的完整闭环，并由多个Agent分4个轮次（初稿、综合、细化、评审）协作编写完成。

Working directory: C:\Software\conex\reference\chat-composer-tiptap
Integrity mode: development

## Requirements

### R1. 生成基准需求文档
由于当前缺失具体的需求文档，Agent 团队需首先基于当前 Conex 项目的上下文（特别是将独立原型的 Tiptap Chat Composer 核心代码无缝迁移到主项目 `apps/crish-desktop` 的需求），自主构思并生成一份详尽的“软件需求迭代说明文档”，作为后续方案推演的基础素材。

### R2. 多轮次协同编写方案文档
严格按照四个轮次的逻辑执行：
- 第一轮（需求分析与方案初稿）：基于项目实际代码与需求，编写方案初稿。
- 第二轮（方案综合与优化）：综合评审初稿，解决冲突，输出最佳决策，并按维度拆解总计划。
- 第三轮（维度方案细化）：将各维度文档整理成具体可执行的细致方案。
- 第四轮（方案评审与完善）：全面评审分析并修改文档，形成最终版。

### R2. 方案内容必须覆盖修复全链路
生成的最终修复方案需详细覆盖：1. 问题识别 2. 任务分解 3. Agent分配（均衡工作量，最多6个） 4. 并行修复 5. 结果汇总 6. 验证。且每轮输出必须能作为下一轮输入，形成闭环。

### R3. 方案的高复用性与内化
生成的方案系列文档需具备高度可复用性，能适用于多轮次迭代修复场景，且文档行文要自然内化于当前软件系统中，避免拼凑痕迹，可扩展至数千行。

## Acceptance Criteria

### 文档完整性与逻辑审查
- [ ] 产出文件中必须包含清晰的四轮编写过程记录或体现四个阶段的思考/决策过程。
- [ ] 最终方案文档必须明确包含问题识别、分解、分配、执行、汇总、验证六个标准环节的逻辑执行顺序说明。
- [ ] 方案文档中不得包含具体的硬性时间安排或人员分配，仅包含逻辑分配机制。
- [ ] 产出独立的“子Agent任务指导材料”文档，将具体的提示词和规范要求与主方案解耦。
</USER_REQUEST>

## 2026-08-04T14:15:53Z

<USER_REQUEST>
# Teamwork Project Prompt — Draft

> Status: Ready for launch — awaiting user approval
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

基于之前的架构演练计划，重新启动一次完整的、纯净的 4 轮次多 Agent 协同流程。本次目标是生成一套用于指导 Tiptap Composer 迁移的“多Agent协同修复方案”系列文档。必须输出包含总大纲以及各个维度拆解细节的**多个独立分文档**，以此构成一个数千行级别的庞大技术蓝图体系。

Working directory: C:\Software\conex\docs\schemes
Integrity mode: development

## Requirements

### R1. 生成并确立基准需求
首先生成一份针对 Tiptap Chat Composer 迁移至 `apps/crish-desktop` 的基准需求文档，明确红线约束（如 5% UI 混色、行数门禁、IPC 拦截等）。

### R2. 严格执行 4 轮次协同推演
必须严格按照以下 4 个阶段调度 Agent：
1. **第一轮（方案初稿）**：基于需求起草一份初始的逻辑调度图纸。
2. **第二轮（盲审与总计划）**：对初稿进行纠偏防冲突设计，并输出一份明确的**《总计划文档》(MASTER PLAN)**。
3. **第三轮（维度方案细化）**：基于总计划，分别输出针对前端组件层、IPC 桥接层、数据模型层的**多份独立详细方案文档**。
4. **第四轮（终审与军规剥离）**：进行总复查，并剥离出一份纯粹的《子Agent任务指导材料》。

### R3. 拒绝“单文件汇总”与“过度精简”
本次任务明确要求产出**系列分档**。在每一轮的交接与整合过程中，所有 Agent 必须遵循“只增不减、保留所有底层技术细节”的原则。严禁在总结时大篇幅删减上游 Agent 产出的 API 契约、存根设计或测试矩阵。

## Acceptance Criteria

### 产物结构与体积验收
- [ ] 最终必须在工作目录中独立生成至少 5 份核心文档（如：`MASTER_PLAN.md`, `SCHEME_FRONTEND.md`, `SCHEME_IPC.md`, `SCHEME_DATA.md`, `SUBAGENT_TASK_GUIDE.md` 等）。
- [ ] 整体产出的系列文档体积与行数应当非常庞大（预计可达数千行），足以作为底层代码编写的绝对参考。

### 逻辑与防爆机制审查
- [ ] 各分档必须涵盖防冲突并行策略（如 T0 存根阶段划分）、单一事实来源定义以及内存防爆机制。
- [ ] 方案纯粹基于逻辑执行顺序，不能出现具体的“张三、李四”或“几月几号”的物理排期。
</USER_REQUEST>

## 2026-08-04T06:38:34Z

<USER_REQUEST>
# Teamwork Project Prompt — Draft

> Status: Ready for launch — awaiting user approval
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

基于前期生成的《多Agent协同修复方案 - 终版》(`docs/schemes/FINAL_REPAIR_SCHEME.md`) 及其系列图纸，统筹多智能体进行实质性的 Tiptap 核心代码迁移与开发，并在开发完成后执行严格的“纯找茬”多重交叉审计。

Working directory: C:\Software\conex
Integrity mode: development

## Requirements

### R1. 基于终版蓝图的并行编码
根据 `FINAL_REPAIR_SCHEME.md` 和 `SUBAGENT_TASK_GUIDE.md` 中的设计（如 T0 存根阶段解除死锁，T1 高并发隔离期），分配多个 Worker 智能体并行实现代码。必须严格遵守规定的 5% 混色焦点、Z-Index = 200 等视觉规范，以及单组件 `useState` 不超过 12 个的防爆红线。

### R2. 执行“纯找茬”多智能体交叉审计
在第一遍编码完成后，必须启动一个独立的多智能体审计团队（Auditors）。
**核心要求**：审计团队必须采取“纯找茬”模式。严禁在审计报告中报告任何“现在的优点”或“做得好的地方”，报告内容必须 100% 聚焦于代码漏洞、不符合 `SUBAGENT_TASK_GUIDE.md` 军规的地方、内存防爆机制的缺失、以及潜在的竞态条件。

### R3. 审计驱动的循环修复
如果多智能体审计团队找出了问题，系统必须触发重复修复流程（Re-iteration），指派修复智能体解决这些具体问题，直到审计团队无法再挑出任何毛病为止。

## Acceptance Criteria

### 编码合规性验收
- [ ] 所有前端组件修改必须通过 `npm run typecheck`。
- [ ] 必须彻底阻断 LFI 与跨目录读取风险（如 `file://` 被 Rust 后端硬拦截并返回 `UserFacingError`）。

### 审计严格性验收
- [ ] 生成的独立审计报告文件中，不能包含任何夸奖或正向评价的词汇（如“干得好”、“架构清晰”等），必须全部是冷酷的缺陷指控与修改要求。
- [ ] 必须包含可追溯的审计 -> 修复 -> 再次审计的循环迭代日志记录。
</USER_REQUEST>

## 2026-08-04T10:02:06Z

<USER_REQUEST>
# Teamwork Project Prompt — Draft

> Status: Ready for launch — awaiting user approval
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Build a commercial-grade, highly interactive, Notion-like Markdown rendering engine and editor. It must feature flawless visual typography (continuous curvature, exact padding), an advanced table editor, floating menus, block drag-and-drop, bidirectional Markdown serialization, and a suite of AI-assisted writing tools.

Working directory: `C:\Software\conex\docs\composer-preview`
Integrity mode: demo (Use synthetic mock data for AI features; read existing prototype/test code before implementation)

## Requirements

### R1. 基础排版与视觉引擎 (Foundation & UX)
Must implement pixel-perfect, light-mode commercial UI matching the provided reference screenshots. Includes support for Paragraph, Bold, Italic, Strike, Underline, Highlight, Inline Code, Link, Tag, H1-H6, Blockquote (with alerts/callouts like ⚠️ Warning, 💡 Note), and Divider. Must include Notion-style Block Drag-and-Drop (6-dot handle), contextual Bubble Menus (with text/background color pickers), and a `/` Slash Command menu.

### R2. 开发者与结构化支持 (Code & Structure)
Must support multi-language Code Blocks (with syntax highlighting, copy button, line numbers), Mermaid diagrams (flowchart, sequence, ER, etc.), LaTeX Math formulas (inline and block), and GitHub-style Diff blocks. Must support Auto TOC (Table of Contents), Breadcrumbs, Bidirectional Links (`[[ ]]`), Tags (`#`), and Backlinks.

### R3. 高级表格与多媒体 (Tables & Media)
Must implement an Advanced Table Editor (not just pure markdown) supporting drag-and-drop columns, sorting, filtering, cell merging, and cell formatting. Must support Database-like tables (text, number, date, tags, formula). Must support Media content: Images (drag/drop, paste, auto-upload, caption, resize), Video, Audio, and File attachments (PDF, Word, ZIP).

### R4. AI 赋能与科研增强 (AI & Sci-Tech)
Must implement AI Writing (expand, shorten, rewrite, translate, polish), AI Summarization (summary, key points, TODOs), AI Q&A based on the document, AI Continue writing, and AI Review. **Note: All AI backend calls must use pure frontend synthetic mock data for this phase.** Must support Sci-Tech features including BibTex Reference Management, Chart rendering (Chart.js/ECharts), Dataset blocks, and Experiment Record blocks.

### R5. 版本控制与输入输出 (Version & IO)
Must support Document History (diffing, rollback). Must support Importing (Markdown, HTML, Word, PDF, Notion) and Exporting (Markdown, PDF, HTML, Word, LaTeX).

## Acceptance Criteria

### UI & Typography
- [ ] Light-mode typography exactly matches the reference screenshots (fonts, line height, continuous corner radius).
- [ ] Block drag-and-drop works flawlessly with a visual drop indicator.
- [ ] Hovering over text selection summons a customized Bubble Menu containing formatting and color picking options identical to the reference.
- [ ] Table cells can be right-clicked or hovered to spawn a column/row insertion floating menu.

### Functional Parsing
- [ ] Bidirectional serialization works without data loss (Markdown string <-> Tiptap AST).
- [ ] Code blocks render with syntax highlighting and do not trigger erroneous form submissions on `Enter`.
- [ ] Checkbox task lists toggle state and serialize correctly back to `- [x]` or `- [ ]`.
- [ ] `/` Slash menu opens accurately at the cursor without stealing window focus.

### Integration & Mocking
- [ ] AI summarize/rewrite actions return convincing mock data immediately upon invocation.
- [ ] The engine parses a massive test Markdown document (incorporating tables, math, diagrams, and callouts) without main-thread blocking or visual layout shifts.
</USER_REQUEST>

## 2026-08-04T12:50:56Z

<USER_REQUEST>
# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Build a commercial-grade, highly interactive, Notion-like Markdown rendering engine and editor. It must feature flawless visual typography (continuous curvature, exact padding), an advanced table editor, floating menus, block drag-and-drop, bidirectional Markdown serialization, and a suite of AI-assisted writing tools.

Working directory: `C:\Software\conex\docs\composer-preview`
Integrity mode: demo (Use synthetic mock data for AI features; read existing prototype/test code before implementation)

## Requirements

### R1. 基础排版与视觉引擎 (Foundation & UX)
Must implement pixel-perfect, light-mode commercial UI matching the provided reference screenshots. Includes support for Paragraph, Bold, Italic, Strike, Underline, Highlight, Inline Code, Link, Tag, H1-H6, Blockquote (with alerts/callouts like ⚠️ Warning, 💡 Note), and Divider. Must include Notion-style Block Drag-and-Drop (6-dot handle), contextual Bubble Menus (with text/background color pickers), and a `/` Slash Command menu.

### R2. 开发者与结构化支持 (Code & Structure)
Must support multi-language Code Blocks (with syntax highlighting, copy button, line numbers), Mermaid diagrams (flowchart, sequence, ER, etc.), LaTeX Math formulas (inline and block), and GitHub-style Diff blocks. Must support Auto TOC (Table of Contents), Breadcrumbs, Bidirectional Links (`[[ ]]`), Tags (`#`), and Backlinks.

### R3. 高级表格与多媒体 (Tables & Media)
Must implement an Advanced Table Editor (not just pure markdown) supporting drag-and-drop columns, sorting, filtering, cell merging, and cell formatting. Must support Database-like tables (text, number, date, tags, formula). Must support Media content: Images (drag/drop, paste, auto-upload, caption, resize), Video, Audio, and File attachments (PDF, Word, ZIP).

### R4. AI 赋能与科研增强 (AI & Sci-Tech)
Must implement AI Writing (expand, shorten, rewrite, translate, polish), AI Summarization (summary, key points, TODOs), AI Q&A based on the document, AI Continue writing, and AI Review. **Note: All AI backend calls must use pure frontend synthetic mock data for this phase.** Must support Sci-Tech features including BibTex Reference Management, Chart rendering (Chart.js/ECharts), Dataset blocks, and Experiment Record blocks.

### R5. 版本控制与输入输出 (Version & IO)
Must support Document History (diffing, rollback). Must support Importing (Markdown, HTML, Word, PDF, Notion) and Exporting (Markdown, PDF, HTML, Word, LaTeX).

## Acceptance Criteria

### UI & Typography
- [ ] Light-mode typography exactly matches the reference screenshots (fonts, line height, continuous corner radius).
- [ ] Block drag-and-drop works flawlessly with a visual drop indicator.
- [ ] Hovering over text selection summons a customized Bubble Menu containing formatting and color picking options identical to the reference.
- [ ] Table cells can be right-clicked or hovered to spawn a column/row insertion floating menu.

### Functional Parsing
- [ ] Bidirectional serialization works without data loss (Markdown string <-> Tiptap AST).
- [ ] Code blocks render with syntax highlighting and do not trigger erroneous form submissions on `Enter`.
- [ ] Checkbox task lists toggle state and serialize correctly back to `- [x]` or `- [ ]`.
- [ ] `/` Slash menu opens accurately at the cursor without stealing window focus.

### Integration & Mocking
- [ ] AI summarize/rewrite actions return convincing mock data immediately upon invocation.
- [ ] The engine parses a massive test Markdown document (incorporating tables, math, diagrams, and callouts) without main-thread blocking or visual layout shifts.
</USER_REQUEST>
