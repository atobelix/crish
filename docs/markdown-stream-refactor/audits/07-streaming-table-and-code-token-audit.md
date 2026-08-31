# 挑刺审查报告 07：流式表格与代码块渲染 Token 体系严苛审查

> **审查范围**：
> - `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css`
> - `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.tsx`
> - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`（表格与富文本部分）
> - `apps/crish-desktop/src/styles/tokens.css`（表格、代码块与语法高亮 Token）
> - `apps/crish-desktop/src/styles/design-system.css`（代码块与复制按钮视效规范）
> - `apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts`（代码围栏 DOM 结构）
>
> **审查原则**：严格只挑刺、严禁套话与夸奖。逐一核查所有 CSS/TSX 中的硬编码色值、缺失 Token、样式漂移、失真回退与设计规范违背项。

---

## 1. 表格 Design Token 体系全面缺失与硬编码 Fallback 乱象 (P0 严重缺陷)

### 1.1 全局 Token 体系中 `--table-*` / `--md-table-*` 命名空间 0 命中
- **缺陷位置**：
  - [`apps/crish-desktop/src/styles/tokens.css:1-1072`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)
- **缺陷根因**：
  - 在系统的基础 Design Token 定义文件 `tokens.css` 中，没有任何以 `--table-*` 或 `--md-table-*` 命名的规范化 Token。
  - 对于一个包含大量复杂技术表格、基准测试对比与结构化数据的 AI 协作终端，表格样式的渲染处于完全“无治理”状态，直接导致组件层各自为政、随意拼凑。

### 1.2 `StreamingTableContainer.module.css` 充斥硬编码 Fallback 与亮暗模式撕裂
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:10-11, 43, 53, 56`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L10-L56)
- **缺陷代码**：
  ```css
  /* Line 10-11 */
  border: 1px solid var(--border-color, hsl(0 0% 88%));
  background: var(--bg-card, hsl(0 0% 98%));

  /* Line 43 */
  border-bottom: 1px solid var(--border-subtle, hsl(0 0% 92%));

  /* Line 53 */
  background: var(--bg-card, hsl(0 0% 98%));

  /* Line 56 */
  border-bottom: 1px solid var(--border-color, hsl(0 0% 88%));
  ```
- **缺陷分析**：
  1. **硬编码亮色 HSL Fallback**：所有的 `var(...)` fallback 均硬编码了浅灰白底的 HSL（`hsl(0 0% 88%)`、`hsl(0 0% 98%)`、`hsl(0 0% 92%)`）。一旦变量在暗色模式下解析异常或在隔离测试容器中渲染，表格将瞬间回退为亮白刺目的背景与刺眼边框，彻底击穿暗黑模式。
  2. **缺少专用的表格背景 Token**：表格强行借用卡片背景 `--bg-card`。在消息气泡（Bubble）、侧边栏面板（Panel）或浮层（Elevated）内部嵌套表格时，由于 `--bg-card` 与宿主容器的层次背景可能不一致，会导致表格与外层底板产生丑陋的色块打架。

### 1.3 吸顶表头（Sticky Header）背景穿透与毛玻璃层级缺失
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:49-58`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L49-L58)
  - [`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:341-350`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L341-L350)
- **缺陷代码**：
  ```css
  .tableScrollViewport table thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg-card, hsl(0 0% 98%));
    font-weight: 600;
    color: var(--text-primary, inherit);
    border-bottom: 1px solid var(--border-color, hsl(0 0% 88%));
    user-select: none;
  }
  ```
- **缺陷分析**：
  - 吸顶表头未定义专用 `--md-table-header-bg` Token，且未配置 `backdrop-filter: blur(...)`。
  - 外层容器 `.tableScrollViewport` 设置了 `background: var(--bg-primary, transparent)`，当表格在局部纵向滚动时，下方的单元格文字向上滚入 `thead` 下方，若背景发生微小透明度偏差或抗锯齿渗漏，将产生文字重叠污染。

### 1.4 斑马纹（Zebra Striping）与悬停态（Row Hover）Token 全面缺位
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:30-48`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L30-L48)
- **缺陷分析**：
  - 没有任何 `tbody tr:nth-child(even)` 或 `tbody tr:hover` 的样式定义，也未定义 `--md-table-row-even-bg` / `--md-table-row-hover-bg`。
  - 对于超过 10 行或多于 4 列的长数据表格，无斑马纹与悬停态直接导致用户在大屏幕高分屏下扫视多行数据时极易串行，严重削弱可读性。

### 1.5 局部滚动条（Scrollbar）Token 缺失与 WebView2 原生粗边框滚动条侵入
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:15-27`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L15-L27)
- **缺陷分析**：
  - `.tableScrollViewport` 开启了 `overflow-x: auto; overflow-y: auto;`，但**完全没有配置滚动条微调样式**（如 `scrollbar-width: thin`、`scrollbar-color: var(--tint-scrollbar-thumb) transparent` 以及 `::-webkit-scrollbar` 系列规范）。
  - 在 Windows 平台的 WebView2 容器内，这会导致渲染出 Windows 默认的 16px 粗笨灰色滚动条，直接覆盖并遮挡表格右侧和底部的单元格文字与圆角边框。

### 1.6 `@container` 容器查询内联硬编码尺寸与字号
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:69-76`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L69-L76)
- **缺陷代码**：
  ```css
  @container tableContainer (max-width: 480px) {
    .tableScrollViewport table th,
    .tableScrollViewport table td {
      padding: 6px 8px;
      font-size: 12px;
    }
  }
  ```
- **缺陷分析**：
  - 硬编码 `padding: 6px 8px;` 与 `font-size: 12px;`，未采用统一的 `--font-size-xs` 与 `--space-1_5` / `--space-2`，脱离了 `tokens.css` 的 `--font-size-adjust` 缩放链条。当用户在设置中调大或调小全局字体时，容器查询内的表格文字尺寸不会响应。

---

## 2. 活跃单元格脉冲（Cell Pulsing）与光标抑制机制缺陷 (P0 严重缺陷)

### 2.1 严重击穿 Zero-Blue 铁律：硬编码高饱和度皇家蓝 `hsl(215 90% 52%)` Fallback
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:64, 66`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L64-L66)
  - [`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:550, 552`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L550-L552)
- **缺陷代码**：
  ```css
  /* StreamingTableContainer.module.css:64-66 */
  outline: 1px dashed var(--accent-color, hsl(215 90% 52%));
  outline-offset: -1px;
  background: color-mix(in srgb, var(--accent-color, hsl(215 90% 52%)) 4%, transparent);

  /* ChatMessageRow.module.css:550-552 */
  outline: 1px dashed var(--accent-color, hsl(215 90% 52%));
  outline-offset: -1px;
  background: color-mix(in srgb, var(--accent-color, hsl(215 90% 52%)) 4%, transparent);
  ```
- **缺陷根因与违规事实**：
  - **严重违反 AGENTS.md Zero-Blue 铁律**：`tokens.css:197-198` 明确裁决：“*Zero-Blue 铁律：--accent-blue / --accent-primary 收敛为高对比中性墨阶与翡翠绿*”。
  - 然而在此处，CSS 开发者直接硬编码了 `hsl(215 90% 52%)` 这一典型的饱和电光蓝（Electric Royal Blue）作为回退色。一旦变量未注入或解析失败，界面立即泄漏显眼的蓝色色斑。

### 2.2 暗黑模式下脉冲边框反白刺目（违反 AGENTS.md §13 焦点对比度 ≤10% 铁律）
- **缺陷位置**：
  - [`apps/crish-desktop/src/styles/tokens.css:732`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L732)
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:64`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L64)
- **缺陷分析**：
  - 在 `tokens.css:732` 中，暗色模式的 `--accent-color` 被定义为 `#f8fafc`（接近纯白）。
  - `outline: 1px dashed var(--accent-color)` 在暗黑背景（`#0c0c0b`）下直接绘制了一条 100% 不透明度的刺眼纯白虚线。
  - 这直接违反了 **AGENTS.md §13（焦点对比度上限约 10%，常规元素优先约 3%-6% 混入以保持柔软）**。在用户长时间夜间阅读流式输出时，活跃单元格的高亮框过于耀眼刺目，产生视觉轰炸。

### 2.3 呼吸脉冲（Cell Pulsing）有名无实：缺失 `@keyframes` 动画，退化为静态死框
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:60-67`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L60-L67)
- **缺陷分析**：
  - 注释宣称“*活跃单元格呼吸脉冲边框反馈 (替代侵入性 DOM 光标)*”，但该规则中**完全没有绑定任何 `animation` 或 `@keyframes`**！
  - 它仅仅设置了静态的 `outline` 与 `background`。在文本持续流入时，该单元格没有呼吸、没有明暗律动，只是一个呆板的静态虚线框，完全未能达到打字机光标的同等生命力反馈。

### 2.4 DOM 选择器与状态契约彻底错配（Phantom Selector）
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:61`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L61)
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.tsx:42-45`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.tsx#L42-L45)
- **缺陷代码**：
  ```css
  /* StreamingTableContainer.module.css:61 */
  .tableScrollViewport table tbody tr:last-child td:last-child[data-streaming='true'],
  :global(.isStreaming) .tableScrollViewport table tbody tr:last-child td:last-child { ... }
  ```
  ```tsx
  /* StreamingTableContainer.tsx:42-45 */
  <div
    className={`${styles.tableContainerRoot} ${className || ''}`.trim()}
    data-streaming={isStreaming ? 'true' : 'false'}
  >
  ```
- **缺陷根因**：
  - `StreamingTableContainer.tsx` 将 `data-streaming="true"` 挂载在最外层的 `tableContainerRoot`（根 `div`）上。
  - 但是 CSS 规则中写的是 `td:last-child[data-streaming='true']`，选择器要求 `td` 元素自身携带 `data-streaming` 属性！
  - 由于 Markdown 解析器（无论是 Rust 还是 JS）生成的 `<td>` 根本不会带有 `data-streaming` 属性，因此前半段选择器**永远无法命中（Dead Selector）**！
  - 后半段 `:global(.isStreaming) ...` 依赖祖先节点有 `.isStreaming`，但在 `MarkdownBlockItem` 封口后此 class 消失，导致渲染逻辑极度脆弱。

---

## 3. 代码块容器、工具条与语法高亮 Token 体系严重断裂 (P0 严重缺陷)

### 3.1 孤儿 DOM 节点：`.md-code-lang` 与 `.md-code-breadcrumb*` 完全零样式（CSS 裸奔）
- **缺陷位置**：
  - [`apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts:57-74`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts#L57-L74)
  - [`apps/crish-desktop/src/styles/design-system.css:98-161`](file:///c:/Software/conex/apps/crish-desktop/src/styles/design-system.css#L98-L161)
- **缺陷代码**：
  ```typescript
  /* markdownCodeFence.ts:57-73 */
  const langBadge = langClean
    ? `<span class="md-code-lang" data-lang="${escapeHtml(langClean)}" aria-label="${escapeHtml(langClean)}">${escapeHtml(langClean)}</span>`
    : '';
  // ...
  breadcrumb = `<span class="md-code-breadcrumb">${parts.join('<span class="md-code-breadcrumb-separator">/</span>')}</span>`;
  return `<div class="md-code-block"${blockAttr}>${breadcrumb}${langBadge}<button type="button" class="md-code-copy" aria-label="复制代码">复制</button><pre class="md-code-pre hljs">...</pre></div>`;
  ```
- **缺陷分析**：
  - `markdownCodeFence.ts` 在生成代码块 HTML 时，精心构造了 `.md-code-breadcrumb`、`.md-code-breadcrumb-file`、`.md-code-breadcrumb-segment`、`.md-code-breadcrumb-separator` 以及 `.md-code-lang` 等结构化 DOM 节点。
  - **但在整个前端工程的任何 CSS 文件中，针对这些 class 的样式定义数量为 0！**
  - **严重后果**：
    1. 语言徽标（如 `ts`、`python`）和文件路径（如 `src/utils.ts`）以无样式的默认行内文本直接输出在 `<div class="md-code-block">` 内部；
    2. 没有固定高度、没有工具条底色、没有边框分割线、没有胶囊样式、没有字体与字号约束；
    3. 语言标签直接顶在代码块最左上方，与右侧绝对定位的复制按钮（`.md-code-copy`）在空间上发生严重的错乱与碰撞，在视觉上如同破碎的未完成品。

### 3.2 语法高亮 Token 全量失效（100% Dead Tokens）
- **缺陷位置**：
  - [`apps/crish-desktop/src/styles/tokens.css:270-281, 841-852`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L270-L281)
- **缺陷代码**：
  ```css
  /* tokens.css (Light) */
  --syntax-keyword: #7c6fdb;
  --syntax-string: #0d9488;
  --syntax-number: #c2410c;
  --syntax-title: #2563eb;
  --syntax-builtin: #ca8a04;
  --syntax-attr: #db2777;
  --syntax-comment: var(--text-tertiary);
  --syntax-addition: #16a34a;
  --syntax-deletion: #dc2626;
  --syntax-meta: var(--text-secondary);

  /* tokens.css (Dark) */
  --syntax-keyword: #c4b5fd;
  --syntax-string: #5eead4;
  --syntax-number: #fdba74;
  --syntax-title: #93c5fd;
  --syntax-builtin: #fde047;
  --syntax-attr: #f9a8d4;
  --syntax-comment: #8b8b8b;
  --syntax-addition: #4ade80;
  --syntax-deletion: #f87171;
  --syntax-meta: #a3a3a3;
  ```
- **缺陷根因与荒谬现状**：
  - `tokens.css` 中定义了 10 组亮色和 10 组暗色的 `--syntax-*` 高亮 Token；
  - **但是检索整个仓库发现：这 20 个 Token 从未在任何 CSS 规则中被 `var(--syntax-*)` 引用过！**
  - 前端既没有针对 highlight.js 生成的 `.hljs-keyword`、`.hljs-string`、`.hljs-title`、`.hljs-number` 等 class 编写选择器；
  - 也没有针对 Rust syntect（`ClassStyle::Spaced`）生成的 `.source`、`.keyword`、`.string`、`.constant` 编写选择器；
  - **严重后果**：这套精心配置的明暗主题语法高亮色彩系统完全是“幽灵代码”，语法高亮在浏览器中根本没有应用这套 Token 调色盘，属于严重的架构断层。

### 3.3 复制按钮 `.md-code-copy` 引用不存在的 `--status-success` Token 导致硬编码回退
- **缺陷位置**：
  - [`apps/crish-desktop/src/styles/design-system.css:158-160`](file:///c:/Software/conex/apps/crish-desktop/src/styles/design-system.css#L158-L160)
- **缺陷代码**：
  ```css
  .md-code-copy.is-copied {
    color: var(--status-success, #10b981);
  }
  ```
- **缺陷分析**：
  - `tokens.css` 中定义的成功色语义变量为 `--color-success` / `--text-success` / `--accent-green`。
  - `tokens.css` 中**根本不存在 `--status-success` 这一变量**。
  - 该规则始终因为变量未命中而静默回退到写死的 `#10b981` 纯色，丢失了主题自适应机制。

### 3.4 复制按钮与代码预格式化块（pre）内联大量魔数尺寸
- **缺陷位置**：
  - [`apps/crish-desktop/src/styles/design-system.css:108-144`](file:///c:/Software/conex/apps/crish-desktop/src/styles/design-system.css#L108-L144)
- **缺陷代码**：
  ```css
  .md-code-pre {
    padding: 12px 14px;
    font-size: var(--font-size-xs, 12px);
  }

  .md-code-copy {
    top: 6px;
    right: 8px;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
    border-radius: var(--radius-sm, 4px);
  }
  ```
- **缺陷分析**：
  - 复制按钮的 `height: 22px;`、`font-size: 11px;`、`top: 6px; right: 8px; gap: 4px;` 全部使用魔数（Magic Numbers），未接入 `--space-1`、`--space-1_5`、`--space-2`、`--font-size-xxs` 等设计 Token；
  - 代码块 `.md-code-pre` 的 `padding: 12px 14px;` 未接入 `--space-3` 与 `--space-3_5`；
  - 当在不同 UI Size Gear（如 `[data-ui-size="small"]` / `[data-ui-size="large"]`）下运行时，外围控件自适应缩放，但代码块复制按钮与内边距纹丝不动，造成局部比例失调。

### 3.5 行号（Gutter）与高亮行（Line Highlight）Token 体系完全空白
- **缺陷分析**：
  - 代码块容器缺少对长代码多行展示的系统化支持，缺少 `--md-code-gutter-bg`、`--md-code-gutter-fg`、`--md-code-line-highlight-bg`、`--md-code-line-number-width` 等 Token 体系；
  - 相比于 Diff 组件（定义了 `--diff-gutter-bg`, `--diff-gutter-text` 等完整体系），Markdown 代码块属于被遗忘的二等公民。

---

## 4. 高分屏发丝线与边框对比度违规 (P1 缺陷)

### 4.1 全面硬编码 `border: 1px solid`，丢弃 `--hairline-width` 与 `--hairline`
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:10, 43, 56`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L10-L56)
  - [`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:335, 348`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L335-L348)
  - [`apps/crish-desktop/src/styles/design-system.css:103, 134`](file:///c:/Software/conex/apps/crish-desktop/src/styles/design-system.css#L103-L134)
- **缺陷分析**：
  - `tokens.css:65-67, 645-647` 明确声明了发丝线标准：
    ```css
    --hairline-width: 1px;
    --hairline: var(--border-subtle);
    --hairline-strong: var(--border-color);
    ```
  - 但上述所有表格、代码块、复制按钮的边框，全部写死 `1px solid ...`。
  - 在 Retina 屏、4K 显示器或系统设置了 150%/200% DPI 缩放时，硬编码的 `1px` 边框会显得粗厚硬钝，无法配合未来的 `0.5px` 或发丝线动态微调。

### 4.2 缺失感知均匀混色与现代 CSS 斜杠透明度规范（AGENTS.md §14）
- **缺陷分析**：
  - 表格的表头底边线与单元格底边线直接采用 `--border-color` / `--border-subtle`，没有使用感知均匀的 `color-mix(in srgb, ...)` 或 HSL 斜杠透明度微调；
  - 在暗黑模式下，黑底与 `--border-color: hsl(0, 0%, 18%)` 的阶跃变化缺乏环境光融合，造成网格线割裂感过重。

### 4.3 `StreamingTableContainer` 与 `ChatMessageRow` 表格样式双源漂移（Dual-Source Drift）
- **缺陷位置**：
  - [`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:30-58`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L30-L58)
  - [`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:322-350`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L322-L350)
- **缺陷根因**：
  - `ChatMessageRow.module.css` 内部拷贝了一份与 `StreamingTableContainer.module.css` 几乎一模一样的 table/th/td 规则；
  - 但是 `ChatMessageRow.module.css` 没有 `@container` 容器查询规则，没有 `tableContainerRoot` 边框与圆角封装；
  - 当消息在不同阶段（流式阶段 vs 完成阶段 vs 降级阶段）渲染时，DOM 结构在 `.tableContainerRoot` 与 `.md-table-wrap` 之间来回跳跃，样式规则在两个独立 CSS Module 文件之间双源漂移。

---

## 5. 缺陷清单与重构整改对照表

| 缺陷 ID | 严重级 | 涉及模块 / 文件 | 缺陷核心事实与违规项 | 预期整改标准（收敛方案） |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-TOK-01** | **P0** | `tokens.css`<br>`StreamingTableContainer.module.css` | 表格缺少系统化 `--table-*` / `--md-table-*` Token 命名空间，全靠通用卡片变量与浅灰硬编码 Fallback 拼凑 | 在 `tokens.css` 中建立完整的 `--md-table-*` 规范（背景、表头、边框、斑马纹、悬停态、圆角、内边距、发丝线） |
| **DEF-TOK-02** | **P0** | `StreamingTableContainer.module.css:64,66`<br>`ChatMessageRow.module.css:550,552` | 活跃单元格脉冲描边硬编码 `hsl(215 90% 52%)` 鲜艳蓝，严重击穿 **Zero-Blue 铁律** | 严禁蓝色回退，统一接入 `--md-table-cell-pulse-border` 与 `--md-table-cell-pulse-bg`，亮色走墨阶、暗色走柔和翡翠绿 |
| **DEF-TOK-03** | **P0** | `StreamingTableContainer.module.css:64`<br>`tokens.css:732` | 暗色模式下脉冲边框直接使用纯白 `--accent-color`，击穿 **AGENTS.md §13 焦点对比度 ≤10% 铁律** | 脉冲描边与背景在暗色模式下采用 `color-mix(in srgb, var(--accent-primary) 12%, transparent)`，保持视觉克制柔和 |
| **DEF-TOK-04** | **P0** | `StreamingTableContainer.module.css:60-67` | 脉冲边框声称具有呼吸效果，但没有任何 `@keyframes` 动画，退化为静态死虚线框 | 接入 `@keyframes md-table-pulse` 关键帧动画，实现 `opacity` 与 `outline-color` 的细腻呼吸律动 |
| **DEF-TOK-05** | **P0** | `StreamingTableContainer.module.css:61`<br>`StreamingTableContainer.tsx:42-45` | `td:last-child[data-streaming='true']` 选择器要求属性在 `td` 上，但实际挂载在根 `div`，导致选择器永久失效 | 统一在表格容器挂载 `data-table-streaming="true"`，通过 `.tableScrollViewport[data-table-streaming='true'] tbody tr:last-child td:last-child` 精确选定 |
| **DEF-TOK-06** | **P0** | `markdownCodeFence.ts:57-74`<br>`design-system.css` | `markdownCodeFence.ts` 生成的 `.md-code-lang` 与 `.md-code-breadcrumb*` 在全局所有 CSS 中**零样式定义**，导致元素以无样式纯文本裸奔 | 在 `design-system.css` / 代码块样式表中补全 `.md-code-lang`（语言徽标胶囊）与 `.md-code-breadcrumb`（文件路径工具条）的完整 Token 样式 |
| **DEF-TOK-07** | **P0** | `tokens.css:270-281,841-852` | `tokens.css` 中定义的 20 个 `--syntax-*` 语法高亮 Token 从未被任何 CSS 选择器引用，100% 荒废（Dead Tokens） | 编写系统化的语法高亮样式表，将 highlight.js（`.hljs-*`）与 syntect（`.keyword` 等）统一映射到 `--syntax-*` Token |
| **DEF-TOK-08** | **P0** | `design-system.css:159` | 复制按钮引用了不存在的 `--status-success` Token，导致样式静默回退到硬编码 `#10b981` | 修正为项目正式语义 Token `var(--color-success, var(--accent-green))` |
| **DEF-TOK-09** | **P1** | `StreamingTableContainer.module.css`<br>`design-system.css:108-144` | 代码块复制按钮、预格式化容器与表格各处充斥魔数尺寸（11px, 22px, 6px, 8px, 12px 等），丢弃 Design Token | 全面替换为 `--space-*`、`--font-size-*`、`--control-height-*` 与 `--radius-*` 系统化 Token |
| **DEF-TOK-10** | **P1** | `StreamingTableContainer.module.css`<br>`ChatMessageRow.module.css` | 表格边框写死 `1px solid`，丢弃 `--hairline-width` 与 `--hairline`，高分屏下边缘粗笨 | 全面接入 `var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle))` 规范 |
| **DEF-TOK-11** | **P1** | `StreamingTableContainer.module.css:15-27` | 局部滚动视口未配置滚动条 Token 与规则，Windows/WebView2 呈现 16px 粗笨原生灰滚动条 | 接入 `overlay-scrollbar.css` 规范与 `--tint-scrollbar-thumb`，声明 `scrollbar-width: thin` 与 `scrollbar-color` |
| **DEF-TOK-12** | **P1** | `StreamingTableContainer.module.css`<br>`ChatMessageRow.module.css` | 表格样式存在双源定义与漂移，且 `ChatMessageRow` 缺少容器查询支持 | 消除重复定义，将表格样式收敛到统一的样式单源，支持响应式容器查询 |

---
*本审查报告基于 Conex / Crish 代码库真实源码与设计 Token 体系进行逐行严苛核查产出，无任何臆测，问题定性精准，证据链条完整。*
