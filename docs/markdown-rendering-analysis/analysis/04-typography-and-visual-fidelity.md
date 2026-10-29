# 04 - 排版美学、视觉保真度与代码块体验深度审查

> **审查定位**：本报告聚焦 Conex / Crish 桌面客户端的 Markdown 排版美学、排版规范度、双引擎语法高亮一致性及代码块交互体验。
> **基准代码**：
> - `apps/crish-desktop/src/styles/markdown-typography.css`（全局统一排版基座）
> - `apps/crish-desktop/src/styles/tokens-type.css` / `tokens-components.css`（字阶与组件级 Token）
> - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`（对话流气泡排版）
> - `crates/conex-markdown/src/highlight.rs`（Rust 后端 syntect 语法高亮）
> - `apps/crish-desktop/src/api/codeHighlight.ts`（前端 highlight.js 降级高亮）
> - `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx`（长文档渲染与交互委托）
> - `apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts`（对话消息交互委托）
> - `crates/conex-markdown/src/sanitizer.rs` 与 `apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts`（CJK 断词与清洗）
> **对比标杆**：Typora、Obsidian、Notion、Bear、VS Code。

---

## 一、执行摘要与评分矩阵

经过对 Conex 全链路样式、Token 体系、双端高亮引擎及交互委托源码的深入排查，当前软件的 Markdown 渲染在基础浏览场景下具备可用的 Design Token 桥接与双模态切换架构（Document 模式 vs Chat 模式），但在**排版保真度（Typographic Fidelity）**、**代码块专业性（Code Fence Capabilities）**及**生态定制力（Theme Extensibility）**三个核心维度上，与业界第一梯队产品存在断崖式差距。

### 1.1 核心缺陷速览（四大致命级痛点）

1. **字阶塌陷与二极管字重（Scale Collapse & Binary Weight）**：
   `tokens-type.css` 将系统字重暴力折叠为 `400` 与 `700` 两档二元对立，中等字重（500/600）全部失效。H4 与 H5 字号被统一降为 `14px`（与正文完全相同），且二者字重均为 `700`，导致 H4、H5 与正文加粗在视觉上彻底同化，层级系统完全瘫痪。
2. **粗暴插入 `<wbr>` 的 CJK 断行反模式与双端确定性漂移**：
   为解决窄屏气泡溢出，前后端在文本清洗阶段利用正则强行在中西文边界及纯中文字符串中硬插 `<wbr>`。这不仅破坏了中文词法与标点避头尾禁则（Kinzoku Shori），而且前端仍保留“每隔 10 个汉字插一个 `<wbr>`”，而 Rust 后端已移除了该逻辑，导致双端 HTML 输出产生确定性 AST/DOM 漂移。
3. **双高亮引擎语言断层与 TypeScript 假高亮掩盖**：
   Rust 后端使用 `syntect::parsing::SyntaxSet::load_defaults_newlines()`（基于 Sublime Text 3 默认包）。**Sublime 官方默认包根本不包含 TypeScript、Swift、Kotlin、Dart**！后端的 `find_syntax("typescript")` 实际恒定返回 `None` 并降级为纯文本，单测利用 `assert!(html.contains("const"))` 这种对纯文本也成立的伪断言掩盖了缺陷；与此同时，PowerShell 被前后端荒谬地硬映射为 `bash`，高亮全面畸变。
4. **专业代码块交互全面交白卷与交互双轨割裂**：
   相比 Typora 与 Obsidian，本软件完全不支持行号（Line Numbers）、行高亮（Line Highlighting）、代码折叠（Code Folding）、语言图标（Icons）、换行切换（Word Wrap Toggle）。更严重的是，代码块复制在长文档视图（`MarkdownDocumentView.tsx`）与对话视图（`useChatMessageState.ts`）各自写了一套毫无复用的事件委托逻辑，且行号无法落地的根本原因在于复制机制无脑调用 `querySelector('pre')?.textContent`，一旦插入行号就会被一并复制。

### 1.2 维度能力评级雷达（对比业界标杆）

| 评测维度 | Crish 现状 | Typora | Obsidian | Notion | Bear |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **字阶与层级韵律 (Typography)** | **C+ (58)** | A+ (98) | A (92) | A (95) | A+ (99) |
| **中西文混排与断字 (CJK Typesetting)** | **D (45)** | A (94) | B+ (85) | A- (90) | A+ (98) |
| **语法高亮准确度与语言覆盖 (Syntax Highlighting)** | **C- (52)** | A+ (97) | A+ (98) | A (93) | A- (88) |
| **代码块高级交互 (Code Block Interactivity)** | **F (35)** | A+ (96) | A+ (99) | A- (89) | B (75) |
| **暗黑/明亮主题与样式定制 (Themes & Extensibility)** | **D+ (48)** | A+ (99) | A+ (100) | B (78) | A (90) |

---

## 二、排版美学与字阶规范（Typography）

### 2.1 标题层次断层与字阶扁平化危机

排版美学的核心在于严格的数学比例字阶（Modular Scale）与清晰的信息层次。审查 `apps/crish-desktop/src/styles/tokens-type.css` 与 `tokens-components.css`，我们发现了严重的字阶设计缺陷：

#### 源码实证：
在 `tokens-type.css:47-54` 中，定义了 6 档字阶：
```css
--font-size-adjust: 0px;
--font-size-caption: calc(11px + var(--font-size-adjust, 0px));
--font-size-meta: calc(12px + var(--font-size-adjust, 0px));
--font-size-body: calc(14px + var(--font-size-adjust, 0px));
--font-size-subhead: calc(16px + var(--font-size-adjust, 0px));
--font-size-heading: calc(18px + var(--font-size-adjust, 0px));
--font-size-title: calc(22px + var(--font-size-adjust, 0px));
```
而在 `tokens-components.css:168-181` 中，标题字号被直接绑定为：
```css
--md-h1-size: var(--font-size-title, 22px);
--md-h2-size: var(--font-size-heading, 18px);
--md-h3-size: var(--font-size-subhead, 16px);
--md-h4-size: var(--font-size-body, 14px);   /* 致命：与正文同大 */
--md-h5-size: var(--font-size-body, 14px);   /* 致命：与 H4、正文完全同大 */
--md-h6-size: var(--font-size-meta, 12px);   /* 倒挂：比正文还小 2px */
```
而在 `markdown-typography.css:260-265` 的长文档（Document）变体中：
```css
.md-rendered[data-md-variant='document'] {
  --md-h1-size: 1.85em;  /* 约 25.9px */
  --md-h2-size: 1.45em;  /* 约 20.3px */
  /* 缺失：未声明 --md-h3-size 到 --md-h6-size！ */
}
```

#### 缺陷与负面体验：
1. **H4 与 H5 视觉层级彻底蒸发**：
   正文字号为 `14px`，H4 与 H5 同样被强行定为 `14px`。当用户在长文档或技术文档中使用 4 级或 5 级小标题时，除了外边距不同外，字号与正文毫无二致。
2. **Document 模式下的断崖回退**：
   `markdown-typography.css` 仅对 Document 模式重载了 H1 (`1.85em`) 与 H2 (`1.45em`)，**漏掉了 H3、H4、H5、H6**。这导致 H1 与 H2 走相对单位 `em`，而 H3~H6 骤降回 `tokens-components.css` 的绝对单位 `px`（16px / 14px / 14px / 12px）。长文档中的层级阶梯呈现剧烈的不规则跳跃。
3. **H6 字号倒挂**：
   H6 为 `12px`，比普通正文段落（`14px`）还要小，阅读时产生次级标题弱化成元信息脚注的错觉。

### 2.2 字重二极管化危机（Binary Font Weight）

在精致的排版工具（如 Bear 与 Typora）中，字重阶梯通常由 400（Regular）、500（Medium）、600（Semibold）与 700（Bold）组成，用于精细调节信息密度。

#### 源码实证：
审查 `tokens-type.css:55-58` 与 `85-90`：
```css
/* 字重两档化（SSOT） */
--fw-regular: 400;
--fw-strong: 700;

/* [WAVE2-DEPRECATED-ALIAS] 旧字阶、字重与行高别名桥接层 */
--font-weight-normal: var(--fw-regular);     /* 400 */
--font-weight-code: var(--fw-regular);       /* 400 */
--font-weight-medium: var(--fw-regular);     /* 致命：500 被压成 400 */
--font-weight-content: var(--fw-strong);     /* 700 */
--font-weight-semibold: var(--fw-strong);    /* 致命：600 被拔高到 700 */
--font-weight-heavy: var(--fw-strong);       /* 700 */
```
而在 `markdown-typography.css:196-235` 中：
H1、H2、H3、H4、H5 全量统一绑定为 `font-weight: var(--md-heading-font-weight);`，即 `--fw-strong: 700`。

#### 缺陷与负面体验：
- **粗黑笨拙的视觉压迫**：
  由于 Medium（500）与 Semibold（600）在系统底层被强制折叠，所有标题无论是大标题 H1 还是微标题 H5，全都顶格使用 `700`（黑体/特粗）。在 Windows 的渲染引擎（DirectWrite / ClearType）下，`700` 字重的微软雅黑（Microsoft YaHei）笔画粘连严重，显得极其笨重粗糙，完全失去了 Bear 等苹果生态工具所具有的轻盈精致感。

### 2.3 垂直韵律与外边距折叠黑洞（Margin-Collapse Broken by Flexbox）

在经典排版中，段落之间、段落与标题之间的垂直距离依赖 CSS 块级格式化上下文（BFC）的 `margin-collapse`（外边距折叠），保证页面不会因为相邻边距累加而产生突兀空洞。

#### 源码实证：
审查 `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:349-392`：
```css
.assistantBody,
.messageContentWrapper {
  display: flex;
  flex-direction: column;
}
.streamingMarkdownRoot {
  display: flex;
  flex-direction: column;
}
```
审查 `markdown-typography.css:355-413`：
```css
/* 混合排版相邻规则：打补丁式消除空行 */
:is(.conex-markdown, .md-rendered)
  :is(.md-p, p, .md-ul, ul, .md-ol, ol, .md-table-wrap)
  + :is(.md-h1, .md-h2, .md-h3, .md-h4, .md-h5, .md-h6, h1, h2, h3, h4, h5, h6) {
  margin-top: 0.65em;
}
:is(.conex-markdown, .md-rendered)
  :is(.md-h1, .md-h2, .md-h3, .md-h4, .md-h5, .md-h6, h1, h2, h3, h4, h5, h6)
  + :is(.md-p, p, .md-ul, ul, .md-ol, ol, .md-table-wrap) {
  margin-top: 0;
}
```

#### 缺陷与架构根因：
1. **Flexbox 杀死了 Margin Collapse**：
   W3C 规范明确规定：**Flex 容器内的子项目外边距不发生折叠**。开发团队意识到了间距累加的失控，试图通过 CSS 的相邻兄弟选择器（`+`）进行补丁式覆盖（把 `h` 后的 `p` 顶边距清零）。
2. **流式分块渲染（Chunking）使 CSS 补丁彻底击穿**：
   在对话流中，`MarkdownBlockItem.tsx` 将 Markdown 流式内容切分为独立的 React 块级节点。每个 Block 自成一体，**相邻的段落与标题被隔离在不同的 DOM 父容器中**！
   此时，CSS 中所写的 `+ :is(h1, h2...)` 兄弟选择器**全部失效**。在流式对话中，段间距经常出现累加脱节，造成视觉节奏上的跳跃与不可控忽大忽小。

### 2.4 人体工学与行长测量失效（Measure & Line Length）

根据《The Elements of Typographic Style》（排版风格要素），单行最佳阅读行长（Measure）应保持在 **45 到 75 个字符（Characters Per Line, CPL）**，极限不应超过 85 字符。超过该阈值，读者换行时极易发生视觉窜行。

#### 源码实证：
审查 `markdown-typography.css:268`：
```css
.md-rendered[data-md-variant='document'] {
  max-width: min(920px, 100%);
}
```

#### 缺陷与负面体验：
在全屏或大窗口阅读文档时，容器铺满 `920px`。配合 `14px` 的正文字号，一行可排下 **110~130 个汉字**（或 140+ 个英文单词）。视线横向移动轨迹过长，在长文本技术方案或 PRD 评审场景下，阅读极其费力。对比标杆：
- **Typora**：默认主题居中行宽锁定在 `700px`（约 65~75 字符）。
- **Bear**：纯文本长宽默认为 `680px`。
- **Notion**：标准视图页面主体限制在 `720px`。

### 2.5 列表与任务项的负边距补丁（Negative Margin Hack）

#### 源码实证：
审查 `markdown-typography.css:780-789` 与 `ChatMessageRow.module.css:623-630`：
```css
/* markdown-typography.css */
.md-rendered .md-task-item {
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: var(--space-2, 8px);
  margin: var(--md-list-item-margin) 0;
  margin-left: -1.35em;  /* 强行拉回 */
}

/* ChatMessageRow.module.css */
.assistantText :global(.md-task-item) {
  margin-left: -1.4em;   /* 气泡中数值不一致！ */
}
```

#### 缺陷与负面体验：
1. **多处数值漂移**：基座样式是 `-1.35em`，气泡样式是 `-1.4em`，缺乏单真源。
2. **多层嵌套列表直接左穿崩坏**：
   为了消除原生的列表符号占位，代码使用固定负边距将自定义 Checkbox 向左硬拉。然而在多层嵌套列表（`ul ul` 嵌套 `padding-left: 1.4em`）中，一旦子项是待办事项，`-1.4em` 的负外边距会直接把复选框拉到父级文字的正下方甚至重叠，导致严重的缩进对齐灾难。

### 2.6 引用块（Blockquote）的贫瘠与现代 Callout（Admonition）全线缺席

现代知识库管理工具与技术文档（GitHub、Obsidian、Typora、Notion、VitePress）已经将 **Callout / Admonitions** 提升为一级 Markdown 语法资产（如 `> [!NOTE]`、`> [!TIP]`、`> [!WARNING]`、`> [!DANGER]`）。

#### 源码与现状实证：
审查 `markdown-typography.css:418-428` 与全局代码库：
- 引用块背景被定死为 `background: var(--md-quote-bg);`（在 `tokens-components.css:545` 中定义为 `transparent`）。
- 仅保留左侧一条 `3px solid var(--border-color)` 灰线。
- 全局代码库（前端与 Rust 后端）**完全不存在任何 Callout / Admonition 解析器**。

#### 缺陷与负面体验：
当用户从 GitHub、Obsidian 导入带有 `> [!NOTE]` 或 `> [!WARNING]` 的技术文档时，Crish 无法将其渲染为带有彩色药丸、警示图标（Icon）和独立柔和背景卡片的提示框，而是将其作为干瘪的普通引用块输出，首行直接裸露未解析的文本字符串 `[!NOTE]`。在现代化视觉呈现上落后业界一代。

---

## 三、CJK（中日韩）与西文混排断行架构审查

中西文混排（CJK & Latin Bi-directional Typesetting）是中文桌面软件排版质感的分水岭。深入代码分析，Crish 在此处的处理充满了“粗暴修补”与“双端割裂”。

### 3.1 粗暴强插 `<wbr>` 反模式剖析

在标准现代排版中，中西文混排断行与空格（Pangu Spacing / 盘古之白）应当依赖 CSS 文本属性（如 `word-break`、`overflow-wrap`、`text-autospace`）或 OpenType 字体特性（`palt`/`pkna`）。然而 Crish 的做法令人震惊。

#### 源码实证：
审查 `apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts:122-142`：
```typescript
/**
 * 窄屏 CJK 断行：在标签外文本插入 <wbr>。
 * - CJK ↔ 拉丁/数字/路径字符边界
 * - 长纯 CJK 串每隔 10 字（表格窄列、列表长句）
 */
export function wrapCjkTextSegment(text: string): string {
  let s = text
    .replace(
      /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])([A-Za-z0-9@._/\\-])/g,
      '$1<wbr>$2'
    )
    .replace(
      /([A-Za-z0-9@._/\\-])([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
      '$1<wbr>$2'
    );
  s = s.replace(
    /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{10})(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
    '$1<wbr>'
  );
  return s;
}
```
再审视 Rust 后端 `crates/conex-markdown/src/sanitizer.rs:371-377`：
```rust
/// 窄屏 CJK 断行: 在标签外文本插入 `<wbr>`。
/// - CJK ↔ 拉丁/数字/路径字符边界插入 `<wbr>`
/// - 纯 CJK 长文本不再强插 `<wbr>`，交由现代 CSS 引擎接管，杜绝表格单元格列宽畸变。
pub fn wrap_cjk_text_segment(text: &str) -> String { ... }
```

#### 严重缺陷与技术债：
1. **词法生硬切断与排版禁则破坏**：
   前端的 `/{10}/` 正则完全脱离词法分析，长中文文本每到第 10 个字符就被强行切一刀。例如专业术语“大规模语言模型微调实验”，在第 10 个字符“调”字后被插入 `<wbr>`，极窄屏下“实验”两字被直接换行撕裂。
2. **标点避头尾禁则（Kinzoku Shori）失守**：
   因为正则包含了 `@._/\\-` 等符号，当路径或标点与中文相邻时强插 `<wbr>`，可能造成句号、顿号或斜杠恰好落入换行符之后，排在下一行的行首，犯下中文印刷排版的大忌。
3. **前后端确定性双源漂移（Dual-Engine Parity Break）**：
   Rust 后端在维护过程中意识到问题，注释写明“**纯 CJK 长文本不再强插 `<wbr>`**”（`crates/conex-markdown/src/sanitizer.rs:373`，且有单元测试 `wrap_cjk_does_not_insert_wbr_in_pure_cjk` 锁定）；
   **但是前端 `markdownSanitizer.ts:137-140` 却完全没有同步这一修改，依然在顽固地每 10 字插入 `<wbr>`！**
   这意味着同一段纯中文文本，通过 Rust 渲染（异步完成消息）输出的 HTML 没有 `<wbr>`，而通过前端 Worker/Sync 渲染（备用或同步路径）输出的 HTML 带有大量 `<wbr>`。两端 DOM 树彻底失去同构性！

### 3.2 现代 CSS 排版属性的全面白卷

审查 `markdown-typography.css` 与 `tokens-type.css`：
- **`text-rendering`**：全局检索结果为 **0 处**。没有声明 `optimizeLegibility`，导致连字（Ligatures）与字偶间距调整（Kerning pairs）在大部分字体中被 Chromium 忽略。
- **`line-break`**：检索结果为 **0 处**。未设置 `line-break: strict` 或 `line-break: normal`，浏览器对于中文标点符号的换行折叠完全处于未受控的松散默认状态。
- **`font-feature-settings`**：检索结果为 **0 处**。未开启 `'palt' 1`（比例替代宽度）或 `'pkna' 1`，中文全角标点在视觉上占用完整 1em 方块，导致标点间距巨大而松散，无法像 Bear 那样实现精致的标点压缩。
- **`hyphens`**：未声明英文连字符断词 `hyphens: auto`。遇到长英文单词或 URL，要么在气泡中强行撑开，要么由于 `overflow-wrap: anywhere` 在任意字母处被腰斩。

### 3.3 字体回退栈与字形度量失调（Metric Mismatch）

审查 `tokens-type.css:8-32` 的字体定义：
```css
--font-sans: var(
  --user-font-sans,
  'Segoe UI Variable Text',
  'HarmonyOS Sans SC',
  'HarmonyOS Sans',
  'PingFang SC',
  'Noto Sans SC',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  ...
);
```
在 Windows 平台上，首选西文字体是 `Segoe UI Variable Text`，而中文字体回退到 `Microsoft YaHei UI`。
- **度量差异（Metrics Disparity）**：
  `Segoe UI` 的大写字母高度（Cap-Height）与 x 高度（x-Height）同微软雅黑的字框设计（Em-square）完全不匹配，基线对齐存在微小偏差。
- **行高振荡**：
  当一个段落中夹杂中英文混合词组时，文本行基准线在 DirectWrite 绘制下会出现肉眼可见的 1px 微量上下抖动，且微软雅黑粗体是字形算法描粗，导致中西文混排视觉粗细不均。

---

## 四、代码块（Code Fence）功能与美学体验

代码块是技术型 Markdown 工具的核心门面。以下从语法高亮引擎、Token 映射、高级交互与水平滚动四个方面展开深入剖析。

### 4.1 语法高亮双引擎分裂与 TypeScript 假高亮掩盖

软件宣称具备双引擎语法高亮：后端 Rust（`syntect`）负责静态/完成消息，前端（`highlight.js`）负责实时流式与降级。实际代码事实揭示了极其严重的架构漏洞。

#### 致命漏洞实证：Syntect 根本不支持 TypeScript 等主流语言！
审查 `crates/conex-markdown/src/highlight.rs:18-20`：
```rust
/// 全局 SyntaxSet (内置语法,带 newline 模式)。
static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(SyntaxSet::load_defaults_newlines);
```
在 `highlight.rs:162` 中，写着别名转换：
```rust
"ts" | "tsx" => Cow::Borrowed("typescript"),
```
然而，`syntect` 的 `load_defaults_newlines()` 是在编译期内嵌了 Sublime Text 3 的官方 Packages 仓库快照。**Sublime Text 3 官方默认打包的语言包中根本没有 TypeScript！**（TypeScript、Swift、Kotlin、Dart 在 Sublime 生态中全部属于第三方 PackageControl 插件）。

当调用 `find_syntax("typescript")` 时：
```rust
fn find_syntax(lang: &str) -> Option<&'static syntect::parsing::SyntaxReference> {
    if lang.is_empty() { return None; }
    let ss = &*SYNTAX_SET;
    ss.find_syntax_by_token(lang)
        .or_else(|| ss.find_syntax_by_extension(lang))
        .or_else(|| ss.find_syntax_by_name(lang))
}
```
**`find_syntax` 对 `"typescript"` 必返 `None`！**
继而走入 `highlight_code`（`highlight.rs:239`）：
```rust
    let html = match find_syntax(&lang_norm) {
        Some(syntax) => {
            render_with_syntect(&raw, syntax).unwrap_or_else(|_| escape_html_plain(&raw))
        }
        None => escape_html_plain(&raw),  /* 降级为纯文本转义！ */
    };
```
**这就是铁的事实：在 Rust 后端，所有的 TypeScript / TSX 代码块根本没有任何语法高亮，全部被直接转义为纯白/纯黑的平铺文本！**

更甚者，审查其单元测试 `crates/conex-markdown/src/highlight.rs:286-290`：
```rust
    #[test]
    fn highlight_known_language_returns_spans() {
        let html = highlight_code("const x = 1;", Some("ts"));
        // syntect class style 输出 <span class="..."> 或转义文本
        assert!(html.contains("const"));
    }
```
**单测注释竟然自认了“或转义文本”，且断言仅仅是 `assert!(html.contains("const"))`！**
即便高亮失败返回未上色的纯文本 `"const x = 1;"`，字符串中也包含 `"const"`，测试照样通过！开发团队用一个无效的断言掩盖了 TypeScript 在后端完全无法高亮的严重缺陷。

#### 前端 highlight.js 的语言黑洞：
审查 `apps/crish-desktop/src/api/codeHighlight.ts:13-34`：
前端仅仅按需引入了 22 门语言。在现代化技术栈中：
`dockerfile`、`toml`、`lua`、`graphql`、`r`、`scala`、`haskell`、`proto`、`ini`、`makefile`、`vue`、`svelte`、`zig`
**以上所有语言全部未注册！** 用户在这类代码块中输入代码，前端 highlight.js 直接进入 fallback 分支 `escapeHtml(raw)`，毫无高亮。

#### PowerShell 荒谬映射为 Bash：
在 `highlight.rs:166` 与 `codeHighlight.ts:59` 中：
```rust
"sh" | "shell" | "zsh" | "ps1" | "powershell" => Cow::Borrowed("bash"),
```
```typescript
hljs.registerLanguage('powershell', bash);
```
PowerShell 是典型的基于 .NET 对象与动名词命令结构的脚本语言，具有 `$Variable`、`[String]`、`Get-Process`、`-eq`、`param()` 等独有结构。将其硬生生塞进 `bash` 解析器中，导致变量与运算符识别全面走样，在 Windows 开发者核心场景下带来极其粗糙的视觉体验。

### 4.2 Token 细分被粗暴拍扁（Scope Flattening）

Syntect 依托 TextMate 语法树，能够输出成百上千种极其精细的 Token Scope（例如 `storage.modifier.rust`、`variable.other.member.rust`、`entity.name.function.macro.rust`）。

#### 源码实证：
审查 `apps/crish-desktop/src/styles/design-system.css:151-279`：
所有的 Syntect scope 和 Highlight.js 类名被粗暴合并并平铺到 16 组 `--syntax-*` 变量上：
```css
/* 1. Keyword 关键字控制流 */
.hljs-keyword, .hljs-selector-tag, .source .keyword, .source .storage {
  color: var(--syntax-keyword);
}
/* 1.1 Type */
.hljs-type, .source .entity.name.type, .source .entity.name.class, ... {
  color: var(--syntax-type, var(--syntax-keyword));
}
/* 2. String */
.hljs-string, .hljs-regexp, .hljs-subst, .source .string, ... {
  color: var(--syntax-string);
}
```

#### 缺陷与负面体验：
1. **层次单一平瘪**：
   在 VS Code、Typora（CodeMirror）或 Obsidian（Prism/Lezer）中，修饰符（`pub`、`mut`）、内置宏（`println!`）、类型参数（`<T>`）与对象属性有层次分明的明度与色相差。而在 Crish 中，全被归并进 `syntax-keyword` 或 `syntax-variable`，代码色彩极其单调，缺乏顶尖编辑器的代码“呼吸感”。
2. **丢失 Sublime Theme 支持**：
   Syntect 原生是具备加载 Sublime `.tmTheme` 调色板能力的，但 Crish 强制采用 `ClassStyle::Spaced` 剥离了颜色引擎，改走 CSS 类名桥接，反而丢掉了业界成熟的代码主题库（One Dark、Dracula、Monokai、GitHub Dark 等）。

### 4.3 交互功能全面缺失对比矩阵

| 交互能力 | Crish 现状 | 顶尖水准（Typora / Obsidian / VS Code） | 架构根因与代码事实 |
| :--- | :---: | :---: | :--- |
| **行号 (Line Numbers)** | ❌ **完全缺失** | ✅ 原生支持，可切换显隐 | 无 Gutter DOM 结构；复制时由于直接读取 `pre.textContent`，若加行号会导致复制污染 |
| **行高亮 (Line Highlighting)** | ❌ **完全缺失** | ✅ 支持 `{1,3-5}` 语法高亮特定行 | Fence info 正则仅提取 `file="..."`，完全丢弃了行号标注语法 |
| **代码折叠 (Code Folding)** | ❌ **完全缺失** | ✅ 超长代码自动折叠/可按语法块折叠 | 无折叠控件，无 `<details>` 支持，上千行代码直接垂直贯穿打爆页面 |
| **语言图标 (Language Icons)** | ❌ **完全缺失** | ✅ 显示对应语言官方 SVG 徽标 | 仅输出 `<span class="md-code-lang">ts</span>` 纯小写文本 |
| **软折行切换 (Word Wrap)** | ❌ **普通模式失效** | ✅ 一键切换折行/横向滚动 | `MarkdownDocumentViewProps` 虽然定义了 `wordWrap`，但在正常渲染分支直接被遗弃 |
| **代码执行 (Code Run/Exec)** | ❌ **完全缺失** | ✅ 支持快速执行与复制到终端 | 无与终端环境的管道打通 |

### 4.4 代码复制与交互管道的双轨撕裂

用户点击代码块右上角的“复制”按钮时，系统的底层处理呈现出明显的复制粘贴式代码遗留与逻辑割裂。

#### 源码实证：
**管道 A：长文档视图（`MarkdownDocumentView.tsx:153-194`）**
```typescript
const copyBtn = target.closest('.md-code-copy');
if (copyBtn instanceof HTMLElement) {
  const codeBlock = copyBtn.closest('.md-code-block');
  const codeEl = codeBlock?.querySelector('pre code') ||
                 codeBlock?.querySelector('pre') ||
                 codeBlock?.querySelector('code');
  const textToCopy = codeEl?.textContent ?? '';
  copyTextToClipboard(textToCopy).then((ok) => {
    // 触发 React 状态反馈与 1500ms 计时器
  });
}
```
**管道 B：对话流气泡（`useChatMessageState.ts:226-252`）**
```typescript
const copyBtn = target.closest('.md-code-copy');
if (copyBtn instanceof HTMLElement) {
  const text = copyBtn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
  void navigator.clipboard.writeText(text).then(
    () => { /* 独立手写了一遍 classList.add 和 setTimeout */ },
    () => toast.show(t('common.copyFailed'))
  );
}
```

#### 严重缺陷：
1. **底层 API 割裂**：长文档视图使用工具库 `copyTextToClipboard`（带系统兜底与剪贴板权限检测），而对话消息视图直接裸调 `navigator.clipboard.writeText`，在部分非聚焦 WebView 环境下会直接触发 `NotAllowedError` 报错。
2. **源码抓取机制的致命设计陷阱**：
   两处逻辑全部通过 `querySelector('pre')?.textContent` 获取文本！
   **这是导致代码块行号（Line Numbers）长期无法落地的核心技术阻碍**：一旦在 `pre` 内部加入 `<span class="line-number">1</span>`，`textContent` 就会将行号和代码混杂在一起拷入剪贴板！成熟架构（如 Prism 或 Monaco）必须将原始代码存入 DOM 属性（如 `data-raw-code`）或由受控组件树维护，当前架构无法容纳行号。

### 4.5 长行水平滚动条体验与遮挡

#### 源码实证：
审查 `markdown-typography.css:756-778`：
```css
.md-rendered .md-code-pre {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  white-space: inherit; /* pre 默认 white-space: pre，不折行 */
  --scrollbar-thumb-width: 8px;
}
```

#### 缺陷与负面体验：
1. **无自动折行选项**：
   在紧凑对话气泡中（行宽常在 500px 左右），一行 100 字符的终端命令或代码直接触发水平横滚。在 Windows 系统配合普通鼠标使用时，滚轮默认是垂直滚动，无法驱动代码块横向平移，用户必须小心翼翼地把光标对准细小的滚动条进行拖拽。
2. **滚动条浮层压字**：
   滚动条强制设定为 `--scrollbar-thumb-width: 8px`，且位于 `pre` 的内边距内侧。当滚动条常驻或悬停变粗时，会直接覆盖最后一行代码的下半部分，造成严重的代码遮挡。

---

## 五、主题系统（Dark / Light Mode）适配与生态扩展力

### 5.1 Design Token 融入评价

#### 积极方面：
- `markdown-typography.css` 与 `tokens-components.css` 构建了较完整的 CSS 变量化基座，文字颜色（`--text-primary`）、边框（`--border-subtle`）、背景（`--bg-card`）均动态绑定。
- 采用现代 CSS 语法（`color-mix(in srgb, ...)`）处理交互激活态，避免了老旧硬编码的不透明度伪元素层叠。

#### 缺陷实证：语法高亮色与全局皮肤完全脱节
审查 `tokens-components.css:73-88` 与 `tokens-components.css:429-444`：
`--syntax-*`（如 `--syntax-keyword: #b20037`、`--syntax-string: #006925` 等）是一组在全局样式表中写死的 Hex 绝对色值。
- 在 `themePresets.ts` 中，系统提供了多种皮肤预设（如暖灰 `warm-gray`、冷灰 `pure-gray` 等），每种预设精心定义了 `surfaceBase`、`textBase` 与混合基色 `mixColor`。
- **然而，语法高亮完全独立于皮肤预设！** 无论用户切换到暖色调皮肤还是冷色调皮肤，代码块内的颜色永远是冷冰冰、高饱和的生硬 Hex 色值。在暗色模式下，`--syntax-string: #f5cc58`（亮黄）与 `--syntax-number: #2bdeff`（青亮）色调刺眼，严重缺乏统一设计语言的色彩调和（Color Harmony）。

### 5.2 对比 Obsidian / Typora 主题生态的断崖差距

| 定制能力维度 | Typora | Obsidian | Conex / Crish 当前现状 |
| :--- | :--- | :--- | :--- |
| **主题生态** | 开放 CSS 文件，成百上千款社区主题一键下载 | 庞大插件与主题商店（Community Themes） | **零主题生态**，仅系统内置 Light / Dark 两组固定样式 |
| **局部样式片段 (CSS Snippets)**| 支持覆盖任意选择器 | 支持建立多个独立 `.css` snippet 并独立勾选启用 | **完全不支持**，没有提供任何用户自定义 CSS 加载入口 |
| **代码高亮主题切换** | 随 Markdown 主题自带独立代码高亮样式 | 支持定制 Prism / CodeMirror 主题，Style Settings 调节 | **不可选择**，代码配色与系统明暗模式强制绑定 |
| **排版参数可视化调节** | 各主题支持配置 CSS 变量 | Style Settings 插件可视化调节字号、行距、边距 | 仅 `themeStore.ts` 暴露了 `fontSizeAdjust`，排版无法调节 |

**架构闭塞性总结**：
当前的 Markdown 样式是紧耦合在桌面端应用编译包内的（编译进 `assets/index-*.css`）。用户或二次开发者没有任何手段注入自定义样式表（没有类似 Obsidian `.obsidian/snippets/*.css` 的监控机制，也没有 Typora `themes/` 目录的扫描注入机制）。对于一款面向开发者的高端 AI 工作台而言，这种闭门造车的设计严重抑制了个性化与生产力定制。

---

## 六、架构级整改与对齐顶尖水准的技术路线

为彻底扭转当前排版粗糙、引擎分裂、代码块残疾的现状，必须破除“打补丁”思路，自底向上推进四步核心重构：

```
+-----------------------------------------------------------------------------------+
|                           Conex 视觉保真度重构路线                                 |
+-----------------------------------------------------------------------------------+
|  1. 语法引擎统一 (Shiki / TextMate WASM / 完整 Syntect 语法包)                    |
|     彻底解决 TypeScript 等语言缺失，统一两端 AST 与高亮 Token                        |
+-----------------------------------------------------------------------------------+
|  2. 代码块架构翻新 (CodeBlock Semantic Container)                                  |
|     数据解耦 (data-code 源码隔离) -> 支撑 行号、行高亮、折叠、软折行切换            |
+-----------------------------------------------------------------------------------+
|  3. CJK 排版正规化 (Modern CSS Typography Baseline)                               |
|     废除 <wbr> 强插 -> 启用 text-autospace / line-break: strict / OpenType 'palt'  |
+-----------------------------------------------------------------------------------+
|  4. 字阶与垂直节奏重建 (Modular Scale & CSS Grid/Subgrid)                          |
|     恢复 500/600 字重 -> 纠正 H4/H5 字阶 -> 统一行长 Measure (720px)                |
+-----------------------------------------------------------------------------------+
```

### 6.1 语法高亮引擎统一与语言完整补全
1. **补全 Syntect 语法集或切换至 Shiki**：
   - 若保留 Rust 后端 Syntect，**必须停止使用 `SyntaxSet::load_defaults_newlines()`**。必须将现代 Sublime 语法包（包括 TypeScript、Swift、Kotlin、Dart、Dockerfile、TOML 等）通过 `SyntaxSetBuilder` 打包并序列化为二进制 `.packdump`，彻底根除 TypeScript 在后端渲染为纯文本的严重故障。
   - 移除 PowerShell 映射到 Bash 的荒谬别名，引入完整的 PowerShell 语法文件。
2. **主题加载器解耦（TextMate / VS Code Theme Support）**：
   - 利用 Syntect 的 `ThemeSet` 原生加载标准 TextMate 主题（如 VS Code Dark+、One Dark Pro），将真实色彩直接内联或生成细分 scope，废除粗暴拍扁的 16 组 `--syntax-*`。

### 6.2 代码块语义容器与高级交互改造
1. **源码与表现层解耦（Data-Code Separation）**：
   在渲染 HTML 时，将原始代码写入 `<div class="md-code-block" data-raw-code="...">`，代码复制按钮**只读取 `data-raw-code`**，彻底解除复制对 `pre.textContent` 的盲目依赖。
2. **轻量行号与行高亮系统落地**：
   - 依赖解耦后，即可安全引入 CSS Counter 行号系统：`<pre class="line-numbers"><code><span class="line" data-line="1">...</span></code></pre>`。
   - 解析 Fence info 中的 `{1,3-5}` 语法，赋予对应行 `.highlight-line` 类名，实现行高亮。
3. **交互功能补全**：
   - 在 `.md-code-header` 中增加语言 SVG 图标；
   - 增加软折行切换按钮（Toggle Wrap），动态切换 `.md-code-pre { white-space: pre-wrap; }`；
   - 针对超过 30 行的代码块，提供折叠展开控件。

### 6.3 废除 `<wbr>` 强插，接入现代 CJK 排版标准
1. **全面拔除 `<wbr>` 正则**：
   立即在前端 `markdownSanitizer.ts` 与后端 `sanitizer.rs` 中**彻底删除 `wrapCjkTextSegment` 中的 `<wbr>` 替换逻辑**，消除前后端 AST 漂移与词法切断问题。
2. **拥抱现代 CSS 文本特性**：
   在 `markdown-typography.css` 中引入现代排版标准规则：
   ```css
   :is(.conex-markdown, .md-rendered) {
     /* 标点避头尾与严格断行规则 */
     line-break: strict;
     /* 优雅断字与超长链接安全包裹 */
     overflow-wrap: break-word;
     word-break: normal;
     /* 文本渲染最佳可读性 */
     text-rendering: optimizeLegibility;
     /* OpenType 标点压缩特性 */
     font-feature-settings: 'palt' 1, 'liga' 1;
     /* 现代中西文自动间隔（针对 Chromium 120+） */
     text-autospace: normal;
   }
   ```

### 6.4 字阶比例重构与 Callout 语法体系接入
1. **重建符合人体工学的 Modular Scale**：
   - 纠正 H4 / H5 字阶：H1 (28px) -> H2 (22px) -> H3 (18px) -> H4 (16px, 600) -> H5 (14px, 600) -> H6 (13px, 500, 弱化)。
   - 恢复 `500`（Medium）与 `600`（Semibold）字重，禁止二极管化折叠。
   - 将长文档阅读宽度从 `920px` 调整为黄金阅读宽 `720px`。
2. **完整支持 GitHub / Obsidian 规范的 Callout 语法**：
   在 Markdown 解析流中支持 `> [!NOTE]`、`> [!TIP]`、`> [!WARNING]`，输出标准 `.md-callout.md-callout-note` 结构，注入圆角卡片、柔和同系背景色与专属 SVG 徽标，全面对齐 2026 年现代 Markdown 视觉标准。
