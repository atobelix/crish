# Tiptap Composer: 真正的简约无缝体验 (Live Preview) 设计规范

根据您上传的 4 张参考截图以及“编辑和非编辑是在一起的，不是你的顶部加这么多的功能”、“让你做简约，你非得搞这么丑和复杂”的指导，我深刻认识到了之前多 Agent 团队过度设计带来的严重偏航。

真正的商用级 Markdown 体验应该像 Typora 或 Obsidian 的 Live Preview 一样，追求**极致的简约、克制与所见即所得**。

以下是根据参考图总结出的“实际效果”规范：

## 1. 核心理念：无缝所见即所得 (Seamless Live Preview)
- **绝对的单窗格编辑**：废弃一切 Split Pane（双栏预览）、复杂的顶栏 (Top Bar)、面包屑 (Breadcrumbs) 和侧边栏 (Sidebar)。整个界面就是一张干净的“白纸”。
- **标记符保留 (Syntax Preservation)**：Markdown 不应该被完全隐藏。正如参考图 4 所示，当焦点在标题上时，`#` 应该以淡灰色显示在文本左侧，既保留了 Markdown 的灵魂，又实现了富文本的美感。

## 2. 具体块级元素的交互还原
### 数学公式 (KaTeX) - 参考图 1 & 2
- **非编辑态**：直接在纯白背景上居中渲染优美的 LaTeX 公式（没有任何恶俗的边框、图标或 Toolbar）。
- **编辑态 (聚焦时)**：当光标移入公式区域，直接在公式上方/下方原地展开蓝灰底色的原生 `$$ ... $$` 代码块供用户直接修改文本，所改即所见。不需要任何表单弹窗或切换按钮。

### 代码块与 Diff - 参考图 3
- **极简渲染**：废弃所有沉重的带有下拉框、复制按钮、行号的黑框 Toolbar。
- 代码块就是干净的带背景色的纯文本区域，上下边界由 ` ```diff ` 和 ` ``` ` 直接划定。没有任何多余的 UI 干扰用户敲击代码。

### 标题与基础排版 - 参考图 4
- **行内标记感知**：加粗 `**`、斜体 `*`、标题 `#` 等 Markdown 标记，在用户聚焦该行或该标记时，以极弱的视觉对比度（灰色）展示出来，失去焦点后自动隐藏或保持弱化显示。

---

## 3. 接下来要执行的“减法”重构计划 (The Implementation Plan)

为了达到上述的简约效果，我们需要进行彻底的“反过度设计”清理：

### 第一步：拆除所有外壳 UI (Teardown)
- **[DELETE]** 移除 `ComposerShell.tsx` 中的顶栏 (`<header>`)、面包屑 (`<BreadcrumbBar>`)、TOC 侧边栏和双向链接抽屉。
- **[MODIFY]** 将 `App.tsx` 或 `ComposerShell` 改为只渲染一个 100% 宽高的 `TiptapEditor`。
- **[MODIFY]** 清空 `index.css` 中所有跟 `code-block-header`, `mermaid-header`, `katex-header` 相关的花哨样式。

### 第二步：重写 NodeViews 为 Live Preview 模式
- **[MODIFY] `KaTeXBlockView.tsx`**：重构交互逻辑。默认只展示 `<div className="katex-render">`，当 `selected` 时，同时展示一个原生的 `<textarea>` (带有浅蓝色背景) 显示原始 `$$` 文本，实现图 2 的效果。
- **[MODIFY] `CodeBlockView.tsx` & `DiffBlockView.tsx`**：剥离复杂的 Toolbar，回退到类似 Tiptap 原生 CodeBlock 的体验，保留语法高亮即可。

### 第三步：引入 Markdown 语法占位符
- 利用 Prosemirror Decorations 或 CSS `::before` 伪元素，在标题 (H1-H6) 聚焦时，向行首注入灰色的 `#` 字符，还原图 4 的效果。

## 用户审核 (User Review Required)
> [!IMPORTANT]
> 这是针对“极简 Live Preview”方向的纠偏计划。在真正的大师级应用中，“少即是多”。我将直接大刀阔斧地砍掉之前团队堆砌的复杂 UI，让编辑器回归纯粹的 Markdown 写作体验。
>
> **请问上述基于图片的理解是否完全击中了您的痛点？如果没问题，请点击“Proceed”（或回复确认），我将立刻动手清理和重构！**
