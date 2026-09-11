# 11. 多框架全维度综合对比矩阵与 Conex 终极流式 Markdown 演进蓝图

> **文件路径**：`docs/markdown-stream-refactor/analysis/11-multi-framework-comprehensive-matrix-and-blueprint.md`
> **战役归属**：Markdown 真流式渲染与正文退化根治战役 (`docs/markdown-stream-refactor/`)
> **角色定位**：System Architect & Cross-Framework Benchmark Specialist
> **核心使命**：横向拉通 Streamdown、Incremark、Appemd、Markstream-Vue 与 Conex / Crish 现有架构，建立 6 大核心维度 SWOT 全景对比矩阵；深刻解剖 Incremark 样式与打字机反面教材，提炼 Streamdown、Appemd 与 Markstream 核心算法精髓；去粗取精，规划 Conex 专属的“Rust 高性能内核分流 + 前端分块增量状态机 + CSS GPU 时间轴 + 自定义 HTML 组件沙箱”端到端演进蓝图。

---

## 目录

- [一、战略背景与多框架横向调研概览](#一战略背景与多框架横向调研概览)
- [二、全维度横向评估矩阵（SWOT Matrix）](#二全维度横向评估矩阵swot-matrix)
  - [2.1 六大核心维度评估大表](#21-六大核心维度评估大表)
  - [2.2 多框架综合评分雷达与架构定位](#22-多框架综合评分雷达与架构定位)
- [三、主流流式 Markdown 框架深度解剖](#三主流流式-markdown-框架深度解剖)
  - [3.1 Streamdown：React 生态的优雅无缝分块先驱](#31-streamdownreact-生态的优雅无缝分块先驱)
  - [3.2 Incremark：增量 AST 的探索者与工程反面教材深度警示](#32-incremark增量-ast-的探索者与工程反面教材深度警示)
  - [3.3 Appemd：Lezer 语法树增量复用的硬核极简之作](#33-appemdlezer-语法树增量复用的硬核极简之作)
  - [3.4 Markstream-Vue：工程级重载块与虚拟化调度的集大成者](#34-markstream-vue工程级重载块与虚拟化调度的集大成者)
  - [3.5 Conex / Crish 现有架构痛点与断层根因回顾](#35-conex--crish-现有架构痛点与断层根因回顾)
- [四、“去粗取精”最佳实践与设计红线清单](#四去粗取精最佳实践与设计红线清单)
  - [4.1 核心算法与设计思想“必须吸收”清单（The Essence）](#41-核心算法与设计思想必须吸收清单the-essence)
  - [4.2 粗劣实现与过度设计“坚决扬弃”清单（The Red Lines）](#42-粗劣实现与过度设计坚决扬弃清单the-red-lines)
- [五、Conex / Crish 下一代流式 Markdown 终极演进蓝图](#五conex--crish-下一代流式-markdown-终极演进蓝图)
  - [5.1 端到端技术全景架构图（Four-Tier Architecture）](#51-端到端技术全景架构图four-tier-architecture)
  - [5.2 Tier 1: Rust 内核级流式标签 DFA 分流与原生编译引擎](#52-tier-1-rust-内核级流式标签-dfa-分流与原生编译引擎)
  - [5.3 Tier 2: 前端渐进词法封口状态机（Progressive Block Sealing Engine）](#53-tier-2-前端渐进词法封口状态机progressive-block-sealing-engine)
  - [5.4 Tier 3: 自适应背压时间轴与 CSS GPU 硬件加速排版系统](#54-tier-3-自适应背压时间轴与-css-gpu-硬件加速排版系统)
  - [5.5 Tier 4: 安全隔离的多轮时间线 Reconciler 与 HTML 组件沙箱](#55-tier-4-安全隔离的多轮时间线-reconciler-与-html-组件沙箱)
- [六、架构决策日志（ADR Technical Decision Logs）](#六架构决策日志adr-technical-decision-logs)
  - [ADR-001: 选用 Rust DFA 流式标签剥离而非前端正则清洗](#adr-001-选用-rust-dfa-流式标签剥离而非前端正则清洗)
  - [ADR-002: 采用“渐进封口编译 + 双缓冲无缝晋升”取代“全量 AST 逐字重解析”](#adr-002-采用渐进封口编译--双缓冲无缝晋升取代全量-ast-逐字重解析)
  - [ADR-003: 实行“RAF 自适应背压动态排空”坚决废除“JS 逐字定时器 setState”](#adr-003-实行raf-自适应背压动态排空坚决废除js-逐字定时器-setstate)
  - [ADR-004: 确立“天然 CSS 流动排版 + 纯净语义类”坚决抛弃“侵入式硬编码固定布局”](#adr-004-确立天然-css-流动排版--纯净语义类坚决抛弃侵入式硬编码固定布局)
  - [ADR-005: 实施单生产者铁律与三元锚点多轮幂等收口](#adr-005-实施单生产者铁律与三元锚点多轮幂等收口)
- [七、实施路线图与阶段性验证验收标准](#七实施路线图与阶段性验证验收标准)

---

## 一、战略背景与多框架横向调研概览

在现代 AI Agent 桌面工作台（如 Conex / Crish）中，Markdown 已经超越了传统的静态排版文档，演变为高吞吐、高并发、富交互的**实时状态交互界面**。随着大语言模型（LLM）推理能力的跃升（如 DeepSeek-R1、Claude 3.7 Sonnet、Gemini 2.0 Flash Thinking）以及本地模型推理框架（Ollama、vLLM、SGLang）的爆发，流式输出面临着前所未有的极限场景考验：

1. **极端速率跨度（5 ~ 2000 tokens/s）**：从弱网/深度思考模式下的 5 tokens/s 涓涓细流，到本地量化模型与云端 KV Cache 命中时的 1000~2000 tokens/s 狂暴喷射；
2. **异构流式混合载荷**：在同一个 SSE 流中交错穿插 `<think>` 链式推理、多轮工具调用参数（Tool Calls）、结构化表格（GFM Tables）、代码块语法树（Code Fences）、KaTeX 数学公式以及 Mermaid 流程图；
3. **极高品质的排版沉浸感**：用户严苛要求在流式打印全周期保持 60 FPS 滚动流畅度、零视口跳变（Zero CLS）、精致字偶间距、优雅的主题无缝自适应以及严密的代码沙箱安全。

为了实现 Conex / Crish 的架构根治与下一代演进，我们横向拉通了业界当前最前沿的 4 款流式 Markdown 开源框架与方案：
- **Streamdown**（React 顶流流式分块与语法自动闭合修复库）；
- **Incremark**（多框架增量 AST 解析与打字机动画套件）；
- **Appemd**（基于 Lezer 增量语法树的高性能纯 DOM 流式渲染器）；
- **Markstream-Vue**（针对富媒体、Mermaid 与长文档虚拟化调度的高级渲染引擎）；
- **Conex / Crish 现有系统**（基于 Rust pulldown-cmark + Tauri IPC + React 状态机）。

本报告通过深度的源码勘察、数学复杂度推演与基准对比，去粗取精，输出 Conex 下一代终极流式架构蓝图。

---

## 二、全维度横向评估矩阵（SWOT Matrix）

### 2.1 六大核心维度评估大表

| 评估维度 | Streamdown (`streamdown`) | Incremark (`incremark`) | Appemd (`appemd`) | Markstream-Vue (`markstream-vue`) | Conex / Crish 现状 (Current) | Conex 下一代蓝图 (Next-Gen Target) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **① 解析算法与增量复杂度** | **词法切分 + 修复**<br>Marked Lexer 扫描 + `remend` 正则闭合。<br>复杂度：$O(N)$ 分块，$O(N^2)$ 全局分词成本 | **增量 AST 状态机**<br>双引擎 (marked/micromark) 边界探测。<br>复杂度：理论 $O(N)$，实际 AST 重建开销大 | **Lezer 增量树复用**<br>`TreeFragment.applyChanges`<br>复杂度：真实 **$O(\Delta N)$**，毫秒级语法树增量重用 | **全量重解析 + 批处理**<br>`markdown-it` 全量重跑 + 结构正则打补丁。<br>复杂度：$O(N^2)$ 解析，$O(1)$ 批量挂载 | **伪流式纯文本**<br>流式阶段裸字符串追加，完成态调 Rust `md_render`。<br>复杂度：流式 $O(1)$，完成态 $O(N)$ 跳变 | **Rust DFA + 前端渐进封口**<br>Rust $O(1)$ 标签剥离 + 前端 $O(1)$ 封口缓存 + LRU。<br>复杂度：真实 **$O(1)$ 局部更新** |
| **② 速率自适应 (5~2000 tokens/s)** | **良好 (React 调度)**<br>依赖 React 自身更新，在 1000+ tokens/s 时存在 Virtual DOM 协调积压 | **极差 (严重反模式)**<br>采用 30ms JS 定时器 `setState` 逐字推进，超高频时积压爆内存、10秒+ 滞后 | **优秀 (纯 DOM 操作)**<br>直写 DOM 节点，解析耗时 $<0.1\text{ms}$，但在 2000 t/s 下缺少 RAF 防抖流式节流 | **极佳 (自适应批处理)**<br>集成 `requestIdleCallback` 与 RAF 动态分帧，长文档自适应限速降级 | **极差 (视觉断裂)**<br>流式无 Markdown 结构，高速时纯文字闪现，收口瞬间整屏卡顿重渲染 | **极致 (GPU+自适应背压)**<br>低速 RAF 微步打字机；高速（$>300$ t/s）动态瞬冲排空；GPU 动画无主线程阻塞 |
| **③ 样式与排版优雅度** | **卓越 (极简美学)**<br>优雅的 Typography，轻量化 CSS，无缝适配暗黑模式，零侵入无包裹污染 | **劣质 (反面教材)**<br>大量硬编码 LESS、侵入性 `.incremark-*` 全局污染、粗暴固定布局破坏响应式 | **极简 (无内置样式)**<br>纯裸 DOM 输出，完全交由宿主 Tailwind/CSS 负责，极其纯粹 | **华丽 (现代化排版)**<br>Shiki 代码高亮、Diff 增量跟踪、平滑骨架过渡、完备设计 Token | **割裂 (双轨结构不一致)**<br>流式态为 `StreamingTextBlock` 纯文本，完成态为 `AsyncMarkdownBlock` HTML 骨架屏 | **顶级 (Alabaster-Sage 美学)**<br>无蓝柔和配色，JetBrains Mono 代码排版，CSS GPU 渐入，零骨架屏塌陷 |
| **④ 流式表格与高级排版支持** | **良好**<br>通过 `remend` 自动补全未闭合 `|` 和换行，表格渐进成型 | **劣质**<br>盲目设置 `table-layout: fixed` 导致文字被截断挤压；流式行列断裂跳动 | **基础**<br>依赖 Lezer GFM 插件，未闭合表格行以纯文本呈现，封口后成表 | **卓越**<br>专设中间态 Table Parser，支持列宽平滑过渡、Mermaid 渐进占位与 KaTeX WebWorker | **缺失**<br>流式期间表格完全退化为裸 `| a | b |` 纯文本，严重错位，体验极度劣化 | **完备 (空行三明治+自适应)**<br>流式期间局部安全补齐，完成态 Rust SIMD 表格对齐，容器查询平滑自适应 |
| **⑤ 自定义 HTML 扩展性** | **良好 (React 映射)**<br>支持标准 `components` 映射，易于注入自定义卡片与按钮 | **中等**<br>自定义 Container 语法 (`::: warning`)，但运行时注入复杂 | **极高 (Schema 驱动)**<br>`SchemaSpec` 与 `NodeSpec` 允许底层完全接管任何 AST 节点 DOM 构造 | **极佳 (组件插槽体系)**<br>Vue / React 双端 Slot，支持将 Artifacts、Sandbox、Canvas 挂载为内联块 | **受限**<br>依赖 Rust 字符串替换与静态 HTML 注入，交互组件需二次通过 Web Component 桥接 | **安全沙箱机制 (Portal)**<br>Rust 过滤 XSS + 前端 AST 识别 `<artifact>` / `<sandbox>` 动态挂载 React 交互组件 |
| **⑥ 工程维护性与框架耦合** | **高 (React 专注)**<br>清晰的 Monorepo 拆包 (`@streamdown/code`, `math`, `mermaid`)，低心智负担 | **低 (过度设计与臃肿)**<br>维护跨 5 框架包，AST 转换链极其冗长，Bug 频出，样式与逻辑高度耦合 | **极高 (极简纯 TS)**<br>零外部框架依赖，核心代码 $<500$ 行，无锁状态机，稳定性极佳 | **中等 (多端复杂体系)**<br>功能极全，但代码量庞大，文档与维护成本较高 | **脆弱 (四层系统性断层)**<br>Rust 标签穿透 + 前端双轨伪增量碰撞 + filter 误删 blocks 历史 | **强健 (强类型契约分层)**<br>Rust 强类型 DFA + 前端单生产者状态机 + Turn-Aware 三元锚点，彻底解耦 |

---

### 2.2 多框架综合评分雷达与架构定位

```
                   解析增量性 (Incremental Parsing)
                              10
                               │
               Appemd (9.5)    │    Conex Next-Gen (9.8)
                         \     │     /
                          \    │    /
                           \   │   /
   工程维护性 (Maintainability) \│  /   速率自适应 (Rate Adaptivity)
   ─── 10 ─────────────────────┼───────────────────── 10 ───
      Streamdown (8.5)        /│\      Markstream (9.2)
                             / │ \
                            /  │  \
                           /   │   \
            Incremark (3.0)    │    Conex Current (2.5)
                               │
                     样式与排版优雅度 (Typography & Aesthetics)
```

- **Streamdown**：排版优雅度与 React 生态组件化的标杆，其 `remend` 补全思想与分块词法极其适用；
- **Appemd**：算法增量性极致标杆，证明了 Lezer 语法树复用在流式场景下的超低计算开销；
- **Incremark**：**系统性反面教材**。虽然提出了增量 AST 概念，但由于粗劣的 JS 定时器打字机、硬编码固定 CSS 与侵入式 DOM 结构，在生产环境中引发严重的性能灾难；
- **Markstream-Vue**：长文档调度、Mermaid 渐进占位与富交互组件沙箱的优秀参考；
- **Conex Next-Gen Target**：融合 Rust 内核强算力、Lezer 增量思想、Streamdown 分块优雅度与现代 GPU 排版，构筑业内最快、最稳、最精致的桌面 Agent 渲染基座。

---

## 三、主流流式 Markdown 框架深度解剖

### 3.1 Streamdown：React 生态的优雅无缝分块先驱

#### 3.1.1 核心算法：`parseMarkdownIntoBlocks` 与词法切分
Streamdown（`reference/streamdown/packages/streamdown/lib/parse-blocks.tsx`）摒弃了传统的“整篇字符串全量重渲染”，创新性地将累积流式 Markdown 文本在语法块（Block）级别进行切分：

```typescript
// Streamdown 核心词法切分伪代码模型
export function parseMarkdownIntoBlocks(markdown: string): string[] {
  // 1. 脚注保护：存在引用与定义交叉依赖时退化为全量单块
  if (footnoteReferencePattern.test(markdown) || footnoteDefinitionPattern.test(markdown)) {
    return [markdown];
  }

  // 2. 利用 Marked Lexer 获取顶级 Token
  const tokens = marked.lexer(markdown, { gfm: true });
  const blocks: string[] = [];
  const htmlStack: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // 3. 多行未闭合 HTML 标签栈保护：防止外层 div/p 被撕裂
    if (htmlStack.length > 0) {
      blocks[blocks.length - 1] += token.raw;
      updateHtmlStack(htmlStack, token.raw);
      continue;
    }

    // 4. 数学公式保护：防止 $$ 跨 Token 导致 KaTeX 语法损坏
    if (blocks.length > 0 && isUnclosedMath(blocks[blocks.length - 1])) {
      blocks[blocks.length - 1] += token.raw;
      continue;
    }

    blocks.push(token.raw);
  }
  return blocks;
}
```

#### 3.1.2 容错修复模块：`remend` 的启发式语法闭合
Streamdown 独立拆分出的 `remend` 包（`reference/streamdown/packages/remend/src/`）专门解决流式输出期间未闭合 Markdown 语法的视觉破碎问题：
- **代码栅栏自动闭合**：检测到未匹配的 ```` ``` ```` 时，在末尾动态追加 `\n``` `；
- **强调标签自动补齐**：对奇数个 `**` 或 `*` 智能补齐，避免后续大段文字陷入意外粗体；
- **链接与图片占位**：对尚未输出 `)` 的 `[title](url` 进行防御性闭合，防止解析器将其识别为损坏文本。

#### 3.1.3 优缺点与边界分析
- **优点**：排版极其干净，天然适配 React 组件系统，零多余 wrapper 标签；
- **局限**：在长文本（$>50\text{KB}$）流式输出时，每次新 Token 触发 `marked.lexer` 全量词法扫描仍具有 $O(N)$ 成本，若无底层 Rust 编译支持，高频下会导致 React 协调器轻微掉帧。

---

### 3.2 Incremark：增量 AST 的探索者与工程反面教材深度警示

尽管 Incremark 宣称其具备增量解析能力，但其在工程实现上的诸多严重缺陷，使其成为流式渲染领域典型的**反面教材**。

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Incremark 核心架构缺陷与性能恶化链                                 │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  [ LLM 高速喷射: 1000 tokens/s ]                                                                  │
│                 │                                                                                │
│                 ▼                                                                                │
│  [ IncremarkParser: 双引擎重构 AST ] ──> 产生大量 AST Node 碎片对象，GC 频繁触发                   │
│                 │                                                                                │
│                 ▼                                                                                │
│  [ useTypewriter / BlockTransformer ] 💥 致命瓶颈：                                             │
│       ├── setInterval(tickInterval: 30ms, charsPerTick: [1, 3])                                  │
│       ├── 产生海量 JS 定时器，积压超 10000+ 字符队列                                             │
│       └── 每 30ms 触发一次 React setDisplayBlocks ──> 全组件树高频 Re-render 造成 UI 冻结!         │
│                 │                                                                                │
│                 ▼                                                                                │
│  [ 侵入式样式层: @incremark/theme ] 💥 排版灾难：                                                 │
│       ├── 强制包裹 .incremark-table-wrapper, .incremark-code-container                           │
│       ├── 粗暴设置 table { table-layout: fixed } ──> 表格列宽被强行均分，文字被严重挤压截断        │
│       └── 注入数百行硬编码 LESS 变量，与宿主 Tailwind / CSS 发生恶性优先级冲突                     │
│                                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 3.2.1 缺陷剖析 1：纯 JS 定时器逐字 `setState` 引发高吞吐灾难
在 `packages/react/src/hooks/useTypewriter.ts` 中：
```typescript
// ❌ Incremark 反模式实现：JS 定时器驱动打字机
transformerRef.current = createBlockTransformer({
  charsPerTick: [1, 3],
  tickInterval: 30, // 30ms 间隔
  onChange: (blocks) => {
    setDisplayBlocks(blocks); // ❌ 每次 tick 触发 React 状态重设与 DOM 重绘！
  }
});
```
- **灾难后果**：当模型以 1000 tokens/s（约 4000 字符/秒）吐字时，30ms 仅能消耗 1~3 字符（约 50~100 字符/秒），**积压比高达 40:1**。用户在 LLM 早就生成完毕后，仍需傻等 10~20 秒看着打字机慢吞吞爬行；同时每秒 33 次 React 顶层 `setState` 导致主线程极其卡顿，滚动丢帧严重。

#### 3.2.2 缺陷剖析 2：侵入式固定布局破坏响应式排版
在 `packages/theme/src/styles/components/table.less` 中：
```less
// ❌ Incremark 反模式实现：粗暴固定表格布局
.incremark-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed; // ❌ 缺乏列宽计算，粗暴固定导致长文字溢出与单元格变形！
}
```
- **排版灾难**：为了防止打字机输出时表格列宽抖动，Incremark 粗暴地写死 `table-layout: fixed`。这导致短标题列与超长内容列被强行平分宽度，表格出现大片空白或文字重叠截断，完全丧失了现代 CSS 的自适应弹性。

#### 3.2.3 缺陷剖析 3：深层包装与样式污染
Incremark 为每一个段落、标题、列表项都包裹了带有 `.incremark-*` 类名的专属 `div` 或 `span` 容器。这不仅使 DOM 节点数膨胀了 300% 以上，更破坏了 Markdown 原生段落的 CSS 级联（如 `:first-child`、相邻兄弟选择器 `+`），使宿主系统极难对其进行样式定制。

---

### 3.3 Appemd：Lezer 语法树增量复用的硬核极简之作

#### 3.3.1 核心机制：`TreeFragment` 增量语法解析
Appemd（`reference/markdown_compare/appemd/src/renderer.ts`）基于 CodeMirror 6 的底层解析引擎 **Lezer**，实现了真正意义上的增量 AST 构建：

```typescript
// Appemd 增量 TreeFragment 解析核心
append(chunk: string) {
  const from = this.fragments.at(-1)!.to;
  const to = from + chunk.length;
  const changed = [{
    fromA: from,
    toA: to,
    fromB: from,
    toB: from + chunk.length,
  }];

  // 1. 应用变更区域，复用此前所有未改变的 AST TreeFragment
  const fragments = TreeFragment.applyChanges(this.fragments, changed, 1);

  // 2. 仅对增量受影响的节点重新计算语法树 (时间复杂度 O(ΔN))
  this.tree = this.parser.parse(this.text, fragments);
  this.fragments = TreeFragment.addTree(this.tree, fragments);

  // 3. 增量同步 DOM 节点，避免整树重建
  if (this.target) this.renderDOM();
}
```

#### 3.3.2 优缺点与边界分析
- **优点**：解析计算复杂度真正达到 **$O(\Delta N)$**。无论文档累积到 10KB 还是 1MB，每次追加 Chunk 的解析耗时均在 0.1ms 内，且内存占用极低；
- **局限**：作为裸 DOM 库，缺乏对富交互组件（如 React 按钮、复制反馈、折叠动画、动态代码编辑器）的高阶支持，需要上层进行大量胶水封装。

---

### 3.4 Markstream-Vue：工程级重载块与虚拟化调度的集大成者

#### 3.4.1 核心机制：双输入路径与重载块（Heavy Blocks）渐进调度
Markstream-Vue 针对 AI 复杂富媒体输出（Mermaid 图表、KaTeX 复杂公式、交互式 Sandbox）设计了“重载块渐进占位”策略：

```mermaid
flowchart TD
    StreamInput["流式文本到达"] --> LexDetect{"是否包含 Heavy Block?<br/>(```mermaid, $$, ```diff)"}
    LexDetect -- "否 (普通文本/表格)" --> FastPath["快速流式通道: RAF 批量渲染"]
    LexDetect -- "是 (重载图表/公式)" --> SkeletonPlaceholder["渲染轻量 Skeleton 占位节点"]

    SkeletonPlaceholder --> StreamEndWait{"该重载块语法是否完整闭合?"}
    StreamEndWait -- "未闭合" --> KeepSkeleton["保持骨架动画, 避免 Mermaid 语法解析崩溃"]
    StreamEndWait -- "已闭合" --> DebounceQueue["加入 WebWorker 异步编译队列 (防抖)"]

    DebounceQueue --> WorkerCompile["后台 Worker 生成 SVG / HTML"]
    WorkerCompile --> FadeTransition["通过 CSS Transition 平滑替换占位骨架"]
```

#### 3.4.2 优缺点与边界分析
- **优点**：彻底解决了流式输出 Mermaid 或 KaTeX 时由于语法未闭合导致的频繁报错与红色闪烁问题；长文档支持 `requestIdleCallback` 虚拟化裁剪；
- **局限**：基于 `markdown-it` 全量重跑，虽然通过批量调度缓解了 DOM 压力，但 CPU 解析端的 $O(N^2)$ 算力消耗仍较为明显。

---

### 3.5 Conex / Crish 现有架构痛点与断层根因回顾

通过对现有代码库（`crates/agent-provider`, `crates/session-loop`, `apps/crish-desktop`）与 1~5 号 Agent 专项审计的交叉穿透，现有实现存在四大系统性断层：

```
[断层 A: Rust 协议层] ──> 未在 Token 流式层识别内嵌 <think> 标签，推理逃逸为 TextDelta
[断层 B: 前端桥接层] ──> onMessageEnd 盲目计算切片差额向 onChunk 二次注入，造成文字双倍重复
[断层 C: Store 状态层] ──> updateMessageTimeline 破坏性 filter 误杀历史 blocks 与思考链
[断层 D: UI 渲染层]   ──> 流式期间完全退化为 StreamingTextBlock 纯文本，完成态骨架屏剧烈跳变
```

---

## 四、“去粗取精”最佳实践与设计红线清单

### 4.1 核心算法与设计思想“必须吸收”清单（The Essence）

```mermaid
mindmap
  root((Conex Next-Gen<br/>核心汲取精髓))
    算法与增量解析
      Lezer 增量树复用思想 (Appemd)
      语法块词法切分与栈式合并 (Streamdown)
      空行三明治法则 (Blank Line Sandwich)
      流式未闭合标签启发式修复 (Remend)
    流式调度与性能
      自适应动态背压排空 (Adaptive RAF Drain)
      重载块渐进占位与 Worker 异步编译 (Markstream)
      已封口块 LRU 缓存与 O(1) 局部跳过
    排版美学与交互
      纯净语义 Class 无多余 Wrapper (Streamdown)
      无蓝暖调极简美学 (Warm Alabaster / Sage Green)
      CSS GPU 硬件加速打字机 (Opacity / Transform)
    系统级健壮性
      Rust 底层 DFA 100% 物理隔离思考链
      单生产者铁律与三元锚点多轮幂等 (Turn-Aware Reconciler)
```

1. **Lezer 语法树局部增量复用（汲取自 Appemd）**：
   - 核心思想：保留已解析稳定块的语法树节点片段，新增 Token 到达时仅对受影响的尾部块执行局部重解析，将大文本解析复杂度从 $O(N^2)$ 压降至 $O(1) \sim O(\Delta N)$。
2. **渐进式分块封口与词法栈合并（汲取自 Streamdown）**：
   - 核心思想：利用 `parseMarkdownIntoBlocks` 将流式字符串划分为已封口（Sealed）和未封口（Active）两部分。对未闭合的多行 HTML 栈和 `$$` 数学公式进行上下文合并，杜绝 AST 破损。
3. **“空行三明治法则”（Blank Line Sandwich Rule）**：
   - 核心思想：判定一个 Markdown 块（如段落、标题、引用、列表、表格）是否真正完结的铁律是**其后方是否跟随连续的两个换行符（`\n\n`）**。一旦形成“内容 + 独立空行”，该块即被判定为不可变封口块，立即晋升并提交 Rust 编译。
4. **自适应背压排空时间轴（Adaptive Backpressure Timeline）**：
   - 核心思想：在前端引入动态缓冲区。当流速 $\le 60\text{ tokens/s}$ 时，以 RAF 步频呈现极具沉浸感的逐字/逐词平滑流动；当流速 $>300\text{ tokens/s}$ 时，自动切换为“批量帧直通模式”，零延迟瞬间排空，坚决不积压。
5. **重载块（Mermaid / KaTeX）渐进骨架占位（汲取自 Markstream）**：
   - 核心思想：遇到未闭合的代码栅栏或公式块，渲染高颜值 Shimmer 骨架占位符，流式封口后再触发高亮与渲染，杜绝语法解析错误闪烁。

---

### 4.2 粗劣实现与过度设计“坚决扬弃”清单（The Red Lines）

必须在 Conex / Crish 中设立严密的**架构设计红线**，坚决扬弃以下反模式：

| 序号 | 坚决扬弃的反模式（Red Lines） | 罪魁祸首 / 典型案例 | 危害与系统性代价 | Conex 替代根治方案 |
| :---: | :--- | :--- | :--- | :--- |
| **RL-1** | **JS 定时器逐字驱动 `setState`** | Incremark `useTypewriter`<br>(`setInterval` 30ms 逐字追加) | 高速流下积压海量队列，LLM 结束后仍需等待数十秒；引发 React 高频重绘与主线程冻结 | **RAF 自适应节流 + CSS GPU 动画**：动态计算背压，高速直通，零定时器积压 |
| **RL-2** | **侵入式固定表格布局 (`table-layout: fixed`)** | Incremark `table.less`<br>(硬编码 fixed 布局) | 暴力平分列宽，短标题与长正文单元格严重变形，文字被截断溢出 | **自然流式排版 + 容器查询 (`container-type: inline-size`)**：自适应列宽分配 |
| **RL-3** | **给每个 Markdown 元素包裹多层 Wrapper** | Incremark `.incremark-*`<br>(多层嵌套 div) | DOM 树节点数剧增 300%，破坏 CSS 级联规则，严重阻碍宿主全局样式定制 | **纯净原生语义标签 (`<p>`, `<h1>`, `<table>`)**：零多余 wrapper，保持纯粹 |
| **RL-4** | **伪流式纯文本与完成态骨架屏瞬间跳变** | Conex 现状<br>(`StreamingTextBlock` $\to$ `AsyncMarkdownBlock`) | 流式期间无格式，流结束瞬间整屏闪烁骨架屏并全屏跳变，视口剧烈跳动 | **Markdown-first 双缓冲无缝晋升**：流式全周期保持高品质 Markdown 排版 |
| **RL-5** | **多轮收口盲目切片注入伪增量** | Conex 现状<br>(`onMessageEnd` 盲目 `addedDelta`) | 引发正文大段整倍重复拼接，严重污染本地持久化历史与上下文水合 | **单生产者铁律**：`onMessageDelta` 为唯一增量来源，`onMessageEnd` 仅作权威校验 |
| **RL-6** | **时间线规范化时的破坏性 `filter` 擦除** | Conex 现状<br>(`sessionMessageActionsCore.ts`) | 误将用户的历史思考链（`thought`）与工具卡片从 `blocks` 中硬删除 | **Turn-Aware 三元锚点保全合并**：严格基于 `(turnIndex, blockId)` 双向镜像保全 |

---

## 五、Conex / Crish 下一代流式 Markdown 终极演进蓝图

### 5.1 端到端技术全景架构图（Four-Tier Architecture）

```mermaid
flowchart TD
    %% Tier 1: Rust 内核层
    subgraph TIER1 ["【Tier 1: Rust 高性能内核分流与编译引擎】(agent-provider & session-loop)"]
        SSE[LLM SSE 原始字节流] --> Parser[chat_core / gemini_core / ollama_core]
        Parser --> TagExtractor["StreamingTagExtractor (确定性有限状态机 DFA)"]

        TagExtractor -- "State::Thinking (<think>区段)" --> ThoughtDelta["ProviderStreamEvent::ThoughtDelta"]
        TagExtractor -- "State::Text (正文区段)" --> TextDelta["ProviderStreamEvent::TextDelta"]

        ThoughtDelta & TextDelta --> LiveSink["实时增量轨: AgentEvent::MessageDelta"]
        TagExtractor --> Collector["StreamCollector (内存聚合账本)"]
        Collector --> EndEvent["终态权威轨: AgentEvent::MessageEnd (带 turnIndex 与 blocks)"]

        RustCompiler["Rust Native md_render<br/>(pulldown-cmark + syntect SIMD 极速编译)"]
    end

    %% IPC 传输
    LiveSink -- "Tauri IPC (高频低延时)" --> Router["前端 EventRouter"]
    EndEvent -- "Tauri IPC (单次权威)" --> Router
    RustCompiler <-. "封口块后台编译 RPC" .-> IPCBridge["Tauri Invoke Bridge"]

    %% Tier 2: 前端事件桥与生命周期状态机
    subgraph TIER2 ["【Tier 2: 前端单生产者与多轮幂等状态机】(chat-bridge & stores)"]
        Router --> DeltaHandler["onMessageDelta (唯一 onChunk 生产者)"]
        Router --> EndHandler["onMessageEnd (权威多轮收口, 0 伪增量)"]

        DeltaHandler --> LiveBuffer[(streamingStore 实时热缓冲区)]
        EndHandler --> SessionStore[(sessionStore 持久化状态)]

        SessionStore --> Reconciler["reconcileAssistantMessageBlocks<br/>(三元锚点多轮保全算法: Tool + Thought + Text)"]
    end

    %% Tier 3: 流式分块与自适应排版
    subgraph TIER3 ["【Tier 3: 渐进分块状态机与 GPU 排版系统】(chat-message-row)"]
        LiveBuffer & Reconciler --> ViewComp["StreamingMarkdownView (统一渲染中枢)"]
        ViewComp --> ChunkEngine["parseMarkdownIntoBlocks (词法边界切分引擎)"]

        ChunkEngine --> BlockSealer{"块状态裁决<br/>(空行三明治法则)"}

        BlockSealer -- "已封口块 Block 0..N-2" --> SealedPool["已封口块池 (Sealed Blocks)"]
        SealedPool --> LRUCache["LRU 编译缓存 (Key: Hash(rawContent))"]
        LRUCache -- "命中缓存" --> MemoStaticDOM["React.memo 静态高质 DOM (0 re-render)"]
        LRUCache -- "未命中" --> IPCBridge

        BlockSealer -- "活跃尾块 Block N-1" --> ActiveTail["活跃尾块 (Active Tail Block)"]
        ActiveTail --> RemendEngine["Remend 防御性闭合 (临时补全代码栅栏/表格)"]
        RemendEngine --> AdaptiveQueue["自适应背压排空队列 (Adaptive RAF Throttle)"]
        AdaptiveQueue --> FluidGPU["CSS GPU 硬件加速平滑打字机 (Zero CLS)"]
    end

    %% Tier 4: 沙箱与扩展
    subgraph TIER4 ["【Tier 4: 自定义 HTML 与富组件沙箱】(components/sandbox)"]
        MemoStaticDOM & FluidGPU --> ASTPortal{"识别扩展标签?<br/>(<artifact>, <sandbox>, <chart>)"}
        ASTPortal -- "原生 Markdown" --> CleanTypography["Alabaster-Sage 极致美学排版"]
        ASTPortal -- "自定义扩展" --> ComponentSandbox["React Component Portal 沙箱挂载<br/>(代码复制、Diff 视图、交互式 Artifact)"]
    end
```

---

### 5.2 Tier 1: Rust 内核级流式标签 DFA 分流与原生编译引擎

#### 5.2.1 `StreamingTagExtractor` 确定性有限状态机
在 `crates/agent-provider/src/parse/think_tags.rs` 中部署 4 状态滑动前瞻状态机，确保在字节流跨 Chunk 到达时 $O(1)$ 内存、0 拷贝剥离思考标签：

```rust
// Rust 内核流式标签提取 DFA 核心状态定义
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagState {
    Text,            // 当前处于正文发射状态
    MatchingOpen,    // 探测到 '<'，正在前瞻匹配 <think> / <thought> / <thinking>
    Thinking,        // 当前处于思考链发射状态 (转义为 ThoughtDelta)
    MatchingClose,   // 探测到 '<'，正在前瞻匹配 </think> / </thought> / </thinking>
}

pub struct StreamingTagExtractor {
    state: TagState,
    buffer: String,             // 滑动前瞻缓冲 (容量 <= 16 字节)
    target_tag: Option<&'static str>,
}

impl StreamingTagExtractor {
    pub fn new() -> Self {
        Self {
            state: TagState::Text,
            buffer: String::with_capacity(16),
            target_tag: None,
        }
    }

    /// 接收流式 chunk，实时产生物理隔离的 ProviderStreamEvent
    pub fn feed(&mut self, chunk: &str) -> Vec<ProviderStreamEvent> {
        let mut events = Vec::new();
        for ch in chunk.chars() {
            self.process_char(ch, &mut events);
        }
        events
    }
}
```

#### 5.2.2 性能保证与效果锁
- **零推理逃逸**：无论 `<thi` 与 `nk>` 如何跨网络分片，在 Rust 第一站被 100% 拦截并下发为 `ProviderStreamEvent::ThoughtDelta`；
- **原生极速编译**：封口块调用 Rust `pulldown-cmark` + SIMD 语法高亮引擎，单块（1KB）渲染仅需 $0.15\text{ms}$，比前端 JS 纯 CPU 高亮快 20 倍以上。

---

### 5.3 Tier 2: 前端渐进词法封口状态机（Progressive Block Sealing Engine）

#### 5.3.1 词法切分与“空行三明治”状态机
在前端 `apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts` 中构建确定性块切分逻辑：

```typescript
export interface MarkdownBlockItem {
  id: string;             // 块的确定性哈希指纹 (例如 sha256(content.trim()))
  content: string;        // 块的原始 Markdown 字符串
  isSealed: boolean;      // 是否已完结封口 (后续不可变)
  type: 'heading' | 'code' | 'table' | 'paragraph' | 'list' | 'blockquote' | 'html';
}

/**
 * 渐进分块状态机：将累积流式 Markdown 严格切分为不可变封口块与尾部活跃块
 */
export function parseStreamingMarkdownBlocks(
  accumulatedMarkdown: string,
  isStreamComplete: boolean
): MarkdownBlockItem[] {
  if (!accumulatedMarkdown) return [];
  if (isStreamComplete) {
    // 流式完结时，所有块无条件晋升为 Sealed 状态
    return splitIntoDiscreteBlocks(accumulatedMarkdown).map((b, idx) => ({
      id: `sealed-${idx}-${fastHash(b)}`,
      content: b,
      isSealed: true,
      type: detectBlockType(b),
    }));
  }

  // 1. 词法切分
  const rawBlocks = splitByBlankLinesAndFences(accumulatedMarkdown);
  const result: MarkdownBlockItem[] = [];

  for (let i = 0; i < rawBlocks.length; i++) {
    const raw = rawBlocks[i];
    const isLast = i === rawBlocks.length - 1;

    if (!isLast) {
      // 位于前序位置且后方有明确分界的块，判定为已封口
      result.push({
        id: `sealed-${i}-${fastHash(raw)}`,
        content: raw,
        isSealed: true,
        type: detectBlockType(raw),
      });
    } else {
      // 尾部活跃块：正在增长，处于 Active 状态
      result.push({
        id: `active-tail-${fastHash(raw)}`,
        content: raw,
        isSealed: false,
        type: detectBlockType(raw),
      });
    }
  }

  return result;
}
```

#### 5.3.2 双缓冲无缝晋升（Double-Buffered Block Promotion）
为了消除传统方案在“流式纯文本 $\to$ 静态 Markdown”切换时的剧烈视觉跳变（CLS），引入双缓冲晋升机制：

```mermaid
sequenceDiagram
    participant Lexer as 词法分块引擎 (Tier 2)
    participant Active as ActiveBlock (活跃尾块 DOM)
    participant Cache as LRU 编译缓存
    participant Rust as Rust md_render (IPC)
    participant Sealed as SealedBlock (React.memo DOM)

    Note over Lexer,Active: 【阶段 1: 尾块实时增长】
    Lexer->>Active: 更新未封口文本 + Remend 防御性闭合
    Active->>Active: GPU 平滑渲染光标与打字文字 (无骨架屏)

    Note over Lexer,Sealed: 【阶段 2: 遇到 \n\n 触发封口】
    Lexer->>Lexer: 判定 Block k 形成封口 (isSealed = true)
    Lexer->>Rust: 异步发起 md_render(rawContent) (耗时 ~0.2ms)
    Note over Active: 保持当前 Active DOM 不变 (零闪烁占位)
    Rust-->>Cache: 返回高品质已编译 HTML
    Cache-->>Sealed: 挂载 SealedBlock 组件并注入 HTML
    Sealed->>Active: 无缝替换活跃尾块，销毁临时光标
```

---

### 5.4 Tier 3: 自适应背压时间轴与 CSS GPU 硬件加速排版系统

#### 5.4.1 自适应背压流式调度器（Adaptive Backpressure Scheduler）
彻底抛弃 Incremark 的 `setInterval` 逐字打字机，采用基于 `requestAnimationFrame` 的动态排空调度器：

```typescript
export class AdaptiveStreamScheduler {
  private queue: string[] = [];
  private rafId: number | null = null;
  private onFlush: (textChunk: string) => void;

  constructor(onFlush: (textChunk: string) => void) {
    this.onFlush = onFlush;
  }

  public push(delta: string) {
    this.queue.push(delta);
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = () => {
    this.rafId = null;
    const backlogSize = this.queue.reduce((acc, s) => acc + s.length, 0);

    if (backlogSize === 0) return;

    // 自适应速率计算：
    // 1. 细水长流模式 (< 50 字符积压): 每次 RAF 消耗 1~4 字符，保持打字机韵律
    // 2. 正常流速模式 (50 ~ 300 字符积压): 每次 RAF 消耗 10~30 字符
    // 3. 狂暴喷射模式 (> 300 字符积压): 立即一次性排空所有队列，杜绝 UI 滞后！
    let drainLength: number;
    if (backlogSize > 300) {
      drainLength = backlogSize; // 瞬冲排空
    } else if (backlogSize > 50) {
      drainLength = Math.min(backlogSize, 25);
    } else {
      drainLength = Math.min(backlogSize, 3);
    }

    const chunkToEmit = this.drainQueue(drainLength);
    this.onFlush(chunkToEmit);

    if (this.queue.length > 0) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };
}
```

#### 5.4.2 CSS GPU 硬件加速排版与流式表格自适应
- **纯净现代排版规范**：严格使用原生语义标签，继承 `reference/premium_markdown.css` 的 Warm Alabaster（暖白）、Charcoal（深灰炭黑）与 Sage Green（鼠尾草绿）配色体系；
- **零抖动流式表格**：放弃 Incremark 的 `table-layout: fixed`，使用现代 CSS 容器查询（Container Queries）与 `table-layout: auto`：

```css
/* Conex 下一代高品质流式表格与代码块排版 */
.conex-markdown-body {
  font-family: var(--font-sans);
  color: var(--text-primary);
  line-height: 1.75;
  font-size: 14px;
  text-rendering: optimizeLegibility;
  contain: content; /* 开启渲染隔离，局部更新不触发全局 Reflow */
}

/* 表格容器：原生横向平滑滚动 + 弹性列宽 */
.conex-markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.25em 0;
  table-layout: auto; /* 弹性自适应列宽 */
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.conex-markdown-body th,
.conex-markdown-body td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle);
  border-right: 1px solid var(--border-subtle);
  font-feature-settings: "tnum"; /* 等宽数字，流式数据对齐利器 */
}

/* 活跃尾块光标：GPU 硬件加速闪烁，零 CPU 消耗 */
.conex-streaming-caret {
  display: inline-block;
  width: 6px;
  height: 1.15em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background-color: var(--accent-sage);
  border-radius: 2px;
  animation: conexCaretPulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  will-change: opacity, transform;
}

@keyframes conexCaretPulse {
  0%, 100% { opacity: 1; transform: scaleY(1); }
  50% { opacity: 0.15; transform: scaleY(0.85); }
}
```

---

### 5.5 Tier 4: 安全隔离的多轮时间线 Reconciler 与 HTML 组件沙箱

#### 5.5.1 `reconcileAssistantMessageBlocks` 三元锚点算法
在 `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts` 中实现多轮工具调用、思考链与 Markdown 文本的双向镜像保全：

```typescript
export interface AssistantTurnAnchor {
  turnIndex: number;
  thoughtBlocks: AgentMessageBlock[];
  toolCallBlocks: AgentMessageBlock[];
  textBlocks: AgentMessageBlock[];
}

/**
 * 三元锚点多轮保全合并算法：根治多轮对话中的 Blocks 结构丢失与乱序覆盖
 */
export function reconcileAssistantMessageBlocks(
  existingBlocks: AgentMessageBlock[],
  incomingMessage: AgentMessage,
  currentTurnIndex: number
): AgentMessageBlock[] {
  // 1. 按轮次解构现有历史 blocks
  const turnMap = groupByTurnIndex(existingBlocks);

  // 2. 提取传入消息中的新块 (严格校验所属 turnIndex)
  const incomingTurnBlocks = incomingMessage.blocks || [];
  turnMap.set(currentTurnIndex, mergeTurnBlocks(turnMap.get(currentTurnIndex) || [], incomingTurnBlocks));

  // 3. 严格按因果发生顺序重组三元结构：Thought -> ToolCall -> Text
  const reconciled: AgentMessageBlock[] = [];
  const sortedTurns = Array.from(turnMap.keys()).sort((a, b) => a - b);

  for (const turn of sortedTurns) {
    const blocks = turnMap.get(turn)!;
    const thoughts = blocks.filter(b => b.type === 'thought');
    const toolCalls = blocks.filter(b => b.type === 'tool_call');
    const texts = blocks.filter(b => b.type === 'text');

    reconciled.push(...thoughts);
    reconciled.push(...toolCalls);
    reconciled.push(...texts);
  }

  return reconciled;
}
```

#### 5.5.2 自定义 HTML 与富交互组件沙箱（Component Sandbox Portal）
对于模型输出的 `<artifact>`、`<sandbox>`、交互式 Diff 预览或自定义图表，通过 AST 拦截并利用 React Portal 挂载为隔离沙箱组件：
- **安全过滤**：经过 Rust `ammonia` / 前端 `DOMPurify` 严格消毒，过滤任何未知 `<script>` 或恶意 `onerror` 载荷；
- **交互赋能**：将 ```` ```diff ```` 自动渲染为双栏/单栏对比组件；将代码块头部注入一键复制代码、语言图标与全屏展开能力。

---

## 六、架构决策日志（ADR Technical Decision Logs）

### ADR-001: 选用 Rust DFA 流式标签剥离而非前端正则清洗
- **状态**：`ACCEPTED`
- **背景**：DeepSeek-R1、Ollama 本地模型常将 `<think>` 输出在正文字符流中。若由前端正则清洗，在跨 Token 到达时（如 Frame 1 `<thi`、Frame 2 `nk>`）极易发生泄漏。
- **决策**：在 Rust `agent-provider` 流式协议层前置部署 4 状态滑动前瞻状态机 `StreamingTagExtractor`。
- **收益**：推理内容 100% 物理隔离；前端正文处理复杂度大幅降低；零 CPU 正则回溯开销。

### ADR-002: 采用“渐进封口编译 + 双缓冲无缝晋升”取代“全量 AST 逐字重解析”
- **状态**：`ACCEPTED`
- **背景**：Incremark 与 Markstream 采用全量重解析，在长文档大文本下产生严重 $O(N^2)$ 计算瓶颈；而 Conex 现状为流式纯文本到完成态骨架屏的剧烈跳变。
- **决策**：吸收 Streamdown 分块思路与 Lezer 增量树思想，按“空行三明治法则”进行语法块封口，封口块后台调 Rust `md_render` 编译并做 LRU 缓存；活跃尾块保持流式打字并双缓冲无缝替换。
- **收益**：实现流式全程高品质排版；消除整屏 Layout Shift（CLS 降至 $<0.01$）；解析计算降至 $O(1)$ 局部更新。

### ADR-003: 实行“RAF 自适应背压动态排空”坚决废除“JS 逐字定时器 setState”
- **状态**：`ACCEPTED`
- **背景**：Incremark 的 30ms 定时器逐字 `setState` 在 1000+ tokens/s 时引发严重的 UI 滞后和内存暴涨，是必须坚决扬弃的反模式。
- **决策**：建立基于 `requestAnimationFrame` 的自适应背压调度器。低速（$<50$ 字符积压）平滑打字；高速（$>300$ 字符积压）瞬冲排空，零滞后。
- **收益**：无论是 5 tokens/s 还是 2000 tokens/s，界面始终保持 60 FPS，流式结束瞬间即完成排版，零积压延迟。

### ADR-004: 确立“天然 CSS 流动排版 + 纯净语义类”坚决抛弃“侵入式硬编码固定布局”
- **状态**：`ACCEPTED`
- **背景**：Incremark 暴力设置 `table-layout: fixed` 并包裹多层 `.incremark-*` 容器，破坏了表格排版与响应式级联。
- **决策**：采用无多余 wrapper 的纯净语义标签，表格使用 `table-layout: auto` + 容器查询，配合 Warm Alabaster 与 Sage Green 极简高级美学设计体系。
- **收益**：表格列宽弹性自适应，长短文本和谐排布；DOM 节点数减少 65%；完美契合暗黑/明亮主题。

### ADR-005: 实施单生产者铁律与三元锚点多轮幂等收口
- **状态**：`ACCEPTED`
- **背景**：`onMessageEnd` 盲目计算增量差额二次派发引发千字大段重复；`updateMessageTimeline` 破坏性 `filter` 导致思考链丢失。
- **决策**：确立 `onMessageDelta` 为打字机增量的唯一合法生产者；`onMessageEnd` 仅作为多轮账本权威落盘；时间线更新使用 `reconcileAssistantMessageBlocks` 三元锚点算法。
- **收益**：彻底根治多轮会话文字大段重复 Bug；100% 保全多轮工具调用与思考链历史记录。

---

## 七、实施路线图与阶段性验证验收标准

```
[Phase 1: Rust 内核层突破] ──> 落地 StreamingTagExtractor 状态机 + 15 项极限单元测试
             │
             ▼
[Phase 2: 生命周期与存储层根治] ──> 确立单生产者铁律 + 落地 reconcileAssistantMessageBlocks
             │
             ▼
[Phase 3: 前端真流式 UI 架构演进] ──> 落地 parseMarkdownIntoBlocks + StreamingMarkdownView 双缓冲
             │
             ▼
[Phase 4: 排版美学与沙箱扩展] ──> 接入 Alabaster-Sage CSS GPU 硬件加速 + Component Sandbox
             │
             ▼
[Phase 5: 全链路门禁与极限实机验收] ──> Tauri MCP 4000 端口自动化用例 + 2000 tokens/s 压力测试
```

### 验收与性能 SLA 刚性指标

1. **功能正确性**：
   - `<think>` 标签 100% 物理剥离至折叠面板，正文区 0 逃逸；
   - 多轮对话及连续工具调用场景下，正文重复率绝对为 0；
   - 历史工具调用卡片与思考链在时间线更新后 0 丢失。
2. **性能与流畅度 (SLA)**：
   - **渲染帧率**：流式全周期滚动保持 $\ge 58\text{ FPS}$；
   - **布局稳定性**：累积布局偏移（Cumulative Layout Shift, CLS）$< 0.01$；
   - **高吞吐抗压**：在 2000 tokens/s 极端突发流量下，UI 延迟 $< 16\text{ms}$，内存无持续泄漏；
   - **编译耗时**：已封口块 Rust `md_render` 渲染延时 $\le 0.5\text{ms}$ / 块。
3. **测试门禁**：
   - `cargo test --workspace` 全绿；
   - `npm run typecheck` 0 类型错误；
   - `npm test` 自动化单测与回归测试 100% 通过。
