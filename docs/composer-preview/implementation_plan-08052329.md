# Composer Preview 全功能梳理 · 架构分析 · 重构方案

## 一、功能全景清单

下面按照 `extensions/index.ts` 的四大分类，逐一列出编辑器当前已注册的全部 **37 个功能特性**，以及它们在三层架构（Extension 定义 → View 渲染 → Serializer 序列化）中的完整覆盖情况。

---

### 1. 行内样式（Inline Marks）— 由 Live Preview 引擎驱动

这些不是独立 Extension，而是由 `core/live-preview/inlineParser.ts` 的 delimiter-stack 算法从文本中实时解析出的 mark。

| # | 功能 | Markdown 语法 | 当前初始文档 | 序列化支持 |
|---|------|-------------|------------|----------|
| 1 | **粗体** | `**text**` | ✅ 已有 | ✅ 文本即语法 |
| 2 | *斜体* | `*text*` | ✅ 已有 | ✅ 文本即语法 |
| 3 | ~~删除线~~ | `~~text~~` | ✅ 已有 | ✅ 文本即语法 |
| 4 | ==高亮== | `==text==` | ✅ 已有 | ✅ 文本即语法 |
| 5 | `行内代码` | `` `code` `` | ✅ 已有 | ✅ 文本即语法 |
| 6 | [链接](url) | `[text](url)` | ✅ 已有 | ✅ 文本即语法 |
| 7 | 行内数学公式 | `$formula$` | ✅ 已有 | ⚠️ 需扩展 |

> [!NOTE]
> Token-in-Document 架构的核心优势：上述 7 种行内语法的分隔符（`**`, `` ` ``, `[]()`...）全部作为**真实字符**存在于文档中。序列化 = 取 `textContent`，零信息损失。

---

### 2. 块级基础（Block Primitives）— StarterKit + 自定义

| # | 功能 | Extension 名 | Node 类型 | View 组件 | Markdown 语法 | 初始文档 | 序列化 |
|---|------|-------------|----------|----------|-------------|---------|--------|
| 8 | 段落 | StarterKit | `paragraph` | 内置 | 直接文本 | ✅ | ✅ |
| 9 | 标题 H1-H3 | StarterKit | `heading` | 内置 | `# ` `## ` `### ` | ✅ | ✅ |
| 10 | 引用 | StarterKit | `blockquote` | 内置 | `> text` | ✅ | ✅ |
| 11 | 无序列表 | StarterKit | `bulletList` | 内置 | `- item` | ✅ | ✅ |
| 12 | 有序列表 | StarterKit | `orderedList` | 内置 | `1. item` | ✅ | ✅ |
| 13 | 任务列表 | TaskList/TaskItem | `taskList` | 内置 | `- [x] item` | ✅ | ✅ |
| 14 | 分割线 | StarterKit | `horizontalRule` | 内置 | `---` | ✅ | ✅ |

---

### 3. 围栏块（Fenced Blocks）— 光标进入显示围栏标记

| # | 功能 | Extension | Node 类型 | View 组件 | content | Markdown 语法 | 初始文档 | 序列化 |
|---|------|-----------|----------|----------|---------|-------------|---------|--------|
| 15 | 代码块 | [CodeBlockExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/CodeBlockExtension.ts) | `codeBlock` | [CodeBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/fenced/CodeBlockView.tsx) | `text*` (code) | ` ```lang ` | ✅ 已有 | ✅ 专用 case |
| 16 | Callout 提示框 | [CalloutExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/CalloutExtension.ts) | `callout` | [CalloutView](file:///C:/Software/conex/docs/composer-preview/src/views/fenced/CalloutView.tsx) | `paragraph+` | `> [!type]` | ✅ 已有 | ⚠️ 走 blockquote fallback |
| 17 | Diff 差异对比 | [DiffExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/DiffExtension.ts) | `diffBlock` | [DiffView](file:///C:/Software/conex/docs/composer-preview/src/views/fenced/DiffView.tsx) | `text*` (code) | ` ```diff ` | ✅ 已有 | ⚠️ 走 codeBlock fallback |
| 18 | Mermaid 图表 | [MermaidExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/MermaidExtension.ts) | `mermaidBlock` | [MermaidBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/fenced/MermaidBlockView.tsx) | `text*` (code) | ` ```mermaid ` | ✅ 已有 | ⚠️ 走 codeBlock fallback |

> [!IMPORTANT]
> **围栏块的序列化缺口**：当前 `serializeBlock` 的 switch-case 只处理 `codeBlock`。`callout`、`diffBlock`、`mermaidBlock` 全部掉进 `default` 分支，序列化时丢失了语言标记和结构信息。这是 **AI 生成文档** 场景的第一个必修 bug。

---

### 4. 交互面板块 · 媒体（Panel Blocks · Media）

| # | 功能 | Extension | Node 类型 | View 组件 | atom | attrs | Markdown 语法 | 初始文档 | 序列化 |
|---|------|-----------|----------|----------|------|-------|-------------|---------|--------|
| 19 | 图片 | [ImageExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/ImageExtension.ts) | `imageBlock` | [ImageBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/ImageBlockView.tsx) | ✅ | src, alt, width, height, alignment, caption | `![alt](url)` | ✅ 已有 | ❌ 无专用 case |
| 20 | 视频 | [VideoExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/VideoExtension.ts) | `videoBlock` | [VideoBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/VideoBlockView.tsx) | ✅ | src, provider, width, height, caption | 无标准语法 | ❌ 未加 | ❌ 无 |
| 21 | 音频 | [AudioExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/AudioExtension.ts) | `audioBlock` | [AudioBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/AudioBlockView.tsx) | ✅ | src, title, caption | 无标准语法 | ❌ 未加 | ❌ 无 |
| 22 | 文件附件 | [FileExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/FileExtension.ts) | `fileBlock` | [FileBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/FileBlockView.tsx) | ✅ | src, name, size, mimeType | 无标准语法 | ❌ 未加 | ❌ 无 |
| 23 | 网页书签 | [BookmarkExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/BookmarkExtension.ts) | `bookmarkBlock` | [BookmarkBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/BookmarkBlockView.tsx) | ✅ | url, title, description, thumbnail, favicon | 无标准语法 | ❌ 未加 | ❌ 无 |
| 24 | 嵌入 | [EmbedExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/EmbedExtension.ts) | `embedBlock` | [EmbedBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/EmbedBlockView.tsx) | ✅ | url, type, width, height | 无标准语法 | ❌ 未加 | ❌ 无 |

---

### 5. 交互面板块 · 数据与图表（Panel Blocks · Data）

| # | 功能 | Extension | Node 类型 | View 组件 | atom | attrs | Markdown 语法 | 初始文档 | 序列化 |
|---|------|-----------|----------|----------|------|-------|-------------|---------|--------|
| 25 | 表格 | [TableExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/TableExtension.ts) | `table` / `tableRow` / `tableHeader` / `tableCell` | [TableAffordances](file:///C:/Software/conex/docs/composer-preview/src/views/table/TableAffordances.tsx) | ❌ | textAlign 等 | GFM `\| a \| b \|` | ✅ 已有 | ✅ 专用 case |
| 26 | 数据库 | [DatabaseExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/DatabaseExtension.ts) | `databaseBlock` | [DatabaseView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/database/DatabaseView.tsx) | ✅ | schemaId, viewType, title, data(JSON) | 无标准语法 | ❌ 未加 | ❌ 无 |
| 27 | ECharts 图表 | [ChartExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/ChartExtension.ts) | `chartBlock` | [ChartBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/ChartBlockView.tsx) | ✅ | chartType, config(JSON) | 无标准语法 | ❌ 未加 | ❌ 无 |
| 28 | 数学公式块 | [MathBlockExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/MathBlockExtension.ts) | `mathBlock` | [MathBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/MathBlockView.tsx) | ✅ | formula | `$$ ... $$` | ✅ 已有 | ❌ 无专用 case |

---

### 6. 布局块（Layout Blocks）

| # | 功能 | Extension | Node 类型 | View 组件 | content | attrs | 初始文档 | 序列化 |
|---|------|-----------|----------|----------|---------|-------|---------|--------|
| 29 | 两列 / 三列 | [ColumnLayoutExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/ColumnLayoutExtension.ts) | `columnLayout` + `column` | [ColumnLayoutView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/ColumnLayoutView.tsx) | `column{2,5}` → `block+` | columns, ratios | ❌ 未加 | ❌ 无 |
| 30 | 选项卡 | [TabsExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/TabsExtension.ts) | `tabsBlock` + `tabPanel` | [TabsBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/TabsBlockView.tsx) | `tabPanel{1,10}` → `block+` | activeTabId, label | ❌ 未加 | ❌ 无 |
| 31 | 折叠标题 | [ToggleHeadingExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/ToggleHeadingExtension.ts) | `toggleHeading` | [ToggleHeadingView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/ToggleHeadingView.tsx) | `block+` | level, collapsed, id | ❌ 未加 | ❌ 无 |
| 32 | 折叠列表 | [ToggleListExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/ToggleListExtension.ts) | `toggleList` | [ToggleListView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/ToggleListView.tsx) | `block+` | collapsed | ❌ 未加 | ❌ 无 |
| 33 | 目录 (TOC) | [TOCExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/TOCExtension.ts) | `tableOfContents` | [TOCBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/TOCBlockView.tsx) | 空 (atom) | 无 | ❌ 未加 | ❌ 无 |

---

### 7. 高级块（Advanced Blocks）

| # | 功能 | Extension | Node 类型 | View 组件 | atom | attrs | 初始文档 | 序列化 |
|---|------|-----------|----------|----------|------|-------|---------|--------|
| 34 | 按钮 | [ButtonExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/ButtonExtension.ts) | `buttonBlock` | [ButtonBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/ButtonBlockView.tsx) | ✅ | label, action, url, variant, size, icon | ❌ 未加 | ❌ 无 |
| 35 | AI 生成块 | [AIBlockExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/AIBlockExtension.ts) | `aiBlock` | [AIBlockView](file:///C:/Software/conex/docs/composer-preview/src/views/panel/AIBlockView.tsx) | ✅ | prompt, status, model | ❌ 未加 | ❌ 无 |
| 36 | 同步区块 | [SyncedBlockExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/SyncedBlockExtension.ts) | `syncedBlock` | 无 React NodeView | ❌ | sourceId | ❌ 未加 | ❌ 无 |
| 37 | 子页面 | [SubPageExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/SubPageExtension.ts) | `subPage` | 无 React NodeView | ✅ | pageId, title, icon | ❌ 未加 | ❌ 无 |
| 38 | 面包屑 | [BreadcrumbExtension](file:///C:/Software/conex/docs/composer-preview/src/extensions/BreadcrumbExtension.ts) | `breadcrumb` | 无 React NodeView | ✅ | 无 | ❌ 未加 | ❌ 无 |

---

## 二、初始文档覆盖率分析

### 已覆盖（15 / 38）

行内样式 7 项 + 基础块 7 项 + 围栏块 4 项 + 表格 1 项 + 数学块 1 项 + 图片 1 项 = **已有 15 项** 在初始文档中可见。

### 未覆盖（23 / 38）

| 分类 | 数量 | 具体项目 |
|------|------|---------|
| 媒体 | 5 | 视频、音频、文件附件、网页书签、嵌入 |
| 数据 | 2 | 数据库、ECharts 图表 |
| 布局 | 5 | 两/三列、选项卡、折叠标题、折叠列表、目录 |
| 高级 | 5 | 按钮、AI 区块、同步区块、子页面、面包屑 |
| 无 NodeView | 3 | 同步区块、子页面、面包屑（只注册了 Schema，没有 React 渲染） |
| **可通过编程插入** | **20** | 有完整 NodeView 的项目 |
| **纯占位无法展示** | **3** | syncedBlock / subPage / breadcrumb |

---

## 三、核心矛盾：markdownToDoc 只识别标准 Markdown

### 问题根源

[markdown.ts](file:///C:/Software/conex/docs/composer-preview/src/core/serializer/markdown.ts) 的 `markdownToDoc` 函数是一个**纯标准 Markdown 块级解析器**（L226-L311）。它的 while 循环只识别以下 6 种块：

```
代码围栏 → codeBlock
分割线   → horizontalRule
引用     → blockquote
表格     → table
列表     → bulletList / orderedList / taskList
其余     → paragraph
```

这意味着：
- `> [!info]` 被解析成了普通 `blockquote`，而不是 `callout` 节点
- ` ```mermaid ` 被解析成了 `codeBlock { language: 'mermaid' }`，而不是 `mermaidBlock` 节点
- ` ```diff ` 同理，被解析成了 `codeBlock { language: 'diff' }`，而不是 `diffBlock`
- `$$ ... $$` 被解析成了普通段落，而不是 `mathBlock`
- `![alt](url)` 是行内语法，只产生带 `![]()` 文本的段落，而不是 `imageBlock`

### 影响范围

1. **初始文档**：虽然 Markdown 里写了 `> [!info]`，但它被解析成了一个普通引用块。Callout 的图标、颜色分类全部丢失。
2. **导入功能**：用户拖一个 `.md` 文件进编辑器，所有的 Mermaid / Diff / Math / Callout 都会降级成普通代码块或引用。
3. **AI 生成文档**：这是最致命的场景。AI 如果输出带 `> [!warning]` 或 ` ```mermaid ` 的 Markdown，编辑器无法正确还原成对应的高级组件。

---

## 四、如何把未覆盖的 20 个组件加进初始文档

### 方案：在 `onCreate` 回调中编程式追加

当前 [Editor.tsx](file:///C:/Software/conex/docs/composer-preview/src/shell/Editor.tsx) 的初始化流程（L199-L208）：

```typescript
onCreate: ({ editor: ed }) => {
  const doc = markdownToDoc(INITIAL_MARKDOWN, ed.schema);
  ed.view.dispatch(
    ed.state.tr.replaceWith(0, ed.state.doc.content.size, doc.content)
      .setMeta('addToHistory', false),
  );
  ed.commands.reconcileDocument();
}
```

Markdown 能覆盖的已经覆盖了。剩下的 20 个高级组件，必须在 `onCreate` 里用 `editor.chain().insertContentAt(...)` 或直接构造 ProseMirror JSON 追加到文档末尾。

#### 具体做法

在 `INITIAL_MARKDOWN` 之后定义一个 `EXTRA_BLOCKS: JSONContent[]` 数组，包含所有无法用 Markdown 表达的节点 JSON，然后在 `onCreate` 中 `replaceWith` 之后，再追加这批节点：

```typescript
const EXTRA_BLOCKS: JSONContent[] = [
  // 折叠标题
  { type: 'toggleHeading', attrs: { level: 2, collapsed: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '这是一个折叠标题，点击箭头收起' }] }] },
  // 折叠列表
  { type: 'toggleList', attrs: { collapsed: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '这是折叠列表项' }] }] },
  // 两列布局
  { type: 'columnLayout', attrs: { columns: 2, ratios: [0.5, 0.5] },
    content: [
      { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: '左列内容' }] }] },
      { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: '右列内容' }] }] },
    ] },
  // 选项卡
  { type: 'tabsBlock', attrs: { activeTabId: 'tab-1' },
    content: [
      { type: 'tabPanel', attrs: { tabId: 'tab-1', label: '选项 A' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '选项卡 A 的内容' }] }] },
      { type: 'tabPanel', attrs: { tabId: 'tab-2', label: '选项 B' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '选项卡 B 的内容' }] }] },
    ] },
  // 目录
  { type: 'tableOfContents' },
  // 按钮
  { type: 'buttonBlock', attrs: { label: '打开链接', action: 'open_url', url: 'https://conex.dev', variant: 'primary', size: 'md' } },
  // AI 区块
  { type: 'aiBlock', attrs: { prompt: '写一首五言绝句', status: 'idle' } },
  // 视频（YouTube 示例）
  { type: 'videoBlock', attrs: { src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'youtube' } },
  // 音频
  { type: 'audioBlock', attrs: { src: '', title: '示例音频' } },
  // 文件附件
  { type: 'fileBlock', attrs: { src: '', name: '示例文档.pdf', size: 1024000 } },
  // 网页书签
  { type: 'bookmarkBlock', attrs: { url: 'https://github.com', title: 'GitHub', description: 'Where the world builds software' } },
  // 嵌入
  { type: 'embedBlock', attrs: { url: '', type: 'iframe', height: 300 } },
  // 数据库
  { type: 'databaseBlock', attrs: { title: '项目追踪', viewType: 'table' } },
  // 图表
  { type: 'chartBlock', attrs: { chartType: 'bar', config: JSON.stringify({
    categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [{ name: '收入', values: [120, 200, 180, 320] }],
  }) } },
  // 数学公式块（通过 attrs.formula 传入，不走 Markdown）
  { type: 'mathBlock', attrs: { formula: '\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}' } },
];
```

---

## 五、AI 生成文档场景的序列化重构方案

### 当前问题

`serializeBlock` 的 switch-case（[markdown.ts:61-115](file:///C:/Software/conex/docs/composer-preview/src/core/serializer/markdown.ts#L61-L115)）只覆盖了 7 种节点类型。其余全部掉进 `default`，只取 `textContent` 输出，丢失全部结构信息。

### 重构目标

让 `docToMarkdown` 和 `markdownToDoc` 形成**双向无损**往返：编辑器里的任何内容，导出为 Markdown 后再导入，应该还原出相同的节点结构。

### 分层策略

按照是否有标准 Markdown 语法，将 38 个节点类型分为三层处理：

#### 第一层：标准 Markdown（已有，不需改动）

`paragraph`, `heading`, `codeBlock`, `blockquote`, `bulletList`, `orderedList`, `taskList`, `horizontalRule`, `table`

#### 第二层：扩展 Markdown（可用约定语法表达，需新增 case）

| 节点 | 序列化输出 | 反序列化识别 |
|------|----------|------------|
| `callout` | `> [!TYPE] title\n> content` | 检测引用首行 `> [!xxx]` 模式 |
| `mermaidBlock` | ` ```mermaid\n...\n``` ` | 代码围栏 language === 'mermaid' 时分流 |
| `diffBlock` | ` ```diff\n...\n``` ` | 代码围栏 language === 'diff' 时分流 |
| `mathBlock` | `$$\nformula\n$$` | 检测独立行 `$$` 包围 |
| `imageBlock` | `![caption](src)` | 检测独立行 `![...]()` |
| `toggleHeading` | `<details><summary>## Title</summary>\n...\n</details>` 或自定义指令 | — |
| `toggleList` | `<details><summary>...\n</details>` | — |

#### 第三层：结构化 JSON 指令（无标准 Markdown 对应物）

对于 `videoBlock`, `audioBlock`, `fileBlock`, `bookmarkBlock`, `embedBlock`, `databaseBlock`, `chartBlock`, `tabsBlock`, `columnLayout`, `buttonBlock`, `aiBlock` 等富组件，标准 Markdown 无法表达它们的结构。

**推荐方案**：采用 **自定义围栏指令** 语法（类似 Obsidian / MDX 的做法）：

```markdown
:::video
src: https://www.youtube.com/watch?v=xxx
provider: youtube
:::

:::chart{type=bar}
{"categories":["Q1","Q2"],"series":[{"name":"销量","values":[100,200]}]}
:::

:::columns{count=2 ratios="0.5,0.5"}
::column
左列内容
::column
右列内容
:::

:::tabs{active=tab-1}
::tab{id=tab-1 label="选项 A"}
选项卡 A 的内容
::tab{id=tab-2 label="选项 B"}
选项卡 B 的内容
:::

:::button{label="点击" action=open_url url="https://conex.dev" variant=primary}
:::

:::bookmark
url: https://github.com
title: GitHub
description: Where the world builds software
:::
```

这个语法的优势：
1. **AI 友好**：大模型可以很容易地输出这种格式
2. **可读性好**：人类阅读时也能理解
3. **结构化**：属性在 `{key=value}` 中，内容在 `:::` 包围中
4. **向后兼容**：不认识这种语法的渲染器会当成普通文本显示，不会崩溃

---

## 六、序列化器需要新增的 case

### `serializeBlock` 新增（[markdown.ts:61](file:///C:/Software/conex/docs/composer-preview/src/core/serializer/markdown.ts#L61)）

```typescript
// 围栏块分流
case 'mermaidBlock': {
  const body = node.textContent.split('\n').map(l => ctx.indent + l).join('\n');
  return `${ctx.indent}\`\`\`mermaid\n${body}\n${ctx.indent}\`\`\``;
}

case 'diffBlock': {
  const body = node.textContent.split('\n').map(l => ctx.indent + l).join('\n');
  return `${ctx.indent}\`\`\`diff\n${body}\n${ctx.indent}\`\`\``;
}

case 'callout': {
  const type = (node.attrs.type as string) || 'note';
  const inner: string[] = [];
  node.forEach(child => inner.push(serializeBlock(child, ctx)));
  const body = inner.join('\n\n').split('\n')
    .map(line => line.trim() ? `> ${line}` : '>').join('\n');
  return `> [!${type}]\n${body}`;
}

case 'mathBlock': {
  const formula = (node.attrs.formula as string) || '';
  return `$$\n${formula}\n$$`;
}

case 'imageBlock': {
  const src = (node.attrs.src as string) || '';
  const alt = (node.attrs.alt as string) || '';
  return `![${alt}](${src})`;
}
```

### `markdownToDoc` 新增解析逻辑

在 [markdown.ts:231](file:///C:/Software/conex/docs/composer-preview/src/core/serializer/markdown.ts#L231) 的 while 循环中插入：

```typescript
// 在代码围栏解析之后，对 language 做分流
if (fence) {
  const lang = info.trim().toLowerCase();
  if (lang === 'mermaid') {
    blocks.push({ type: 'mermaidBlock', content: body.length ? [{ type: 'text', text: body.join('\n') }] : [] });
  } else if (lang === 'diff') {
    blocks.push({ type: 'diffBlock', content: body.length ? [{ type: 'text', text: body.join('\n') }] : [] });
  } else {
    blocks.push({ type: 'codeBlock', attrs: { language: lang }, content: ... });
  }
  continue;
}

// 引用块解析之后，检测 callout 语法
if (/^>\s*\[!(\w+)\]/.test(quoted[0])) {
  const match = quoted[0].match(/^>\s*\[!(\w+)\]/);
  const calloutType = match[1].toLowerCase();
  // 去掉首行的 [!type] 前缀，剩余内容递归解析
  blocks.push({ type: 'callout', attrs: { type: calloutType }, content: ... });
  continue;
}

// $$ 独立行 → mathBlock
if (line.trim() === '$$') {
  const formulaLines: string[] = [];
  i++;
  while (i < lines.length && lines[i].trim() !== '$$') {
    formulaLines.push(lines[i]);
    i++;
  }
  i++; // 跳过结束 $$
  blocks.push({ type: 'mathBlock', attrs: { formula: formulaLines.join('\n') } });
  continue;
}
```

---

## 七、实施计划与优先级

### Phase 1：初始文档全覆盖（当前任务）

| 步骤 | 工作内容 | 文件 |
|------|---------|------|
| 1.1 | 在 `Editor.tsx` 的 `onCreate` 中追加 `EXTRA_BLOCKS` JSON 节点到文档末尾 | [Editor.tsx](file:///C:/Software/conex/docs/composer-preview/src/shell/Editor.tsx) |
| 1.2 | 为每个节点组加一个 `### N. 分类标题` 的段落作为分隔 | 同上 |
| 1.3 | 验证所有 20 个可渲染组件都正确显示 | 浏览器手动 |

### Phase 2：序列化器双向补全（序列化安全网）

| 步骤 | 工作内容 | 文件 |
|------|---------|------|
| 2.1 | `serializeBlock` 新增 `mermaidBlock`, `diffBlock`, `callout`, `mathBlock`, `imageBlock` 的 case | [markdown.ts](file:///C:/Software/conex/docs/composer-preview/src/core/serializer/markdown.ts) |
| 2.2 | `markdownToDoc` 中对代码围栏按 language 分流为 `mermaidBlock` / `diffBlock` | 同上 |
| 2.3 | `markdownToDoc` 中对引用首行检测 `[!TYPE]` 分流为 `callout` | 同上 |
| 2.4 | `markdownToDoc` 中对独立 `$$` 行分流为 `mathBlock` | 同上 |
| 2.5 | 单元测试覆盖：序列化 → 反序列化 → 再序列化，断言不变 | [__tests__/](file:///C:/Software/conex/docs/composer-preview/src/__tests__) |

### Phase 3：自定义指令语法（AI 生成文档的基础设施）

| 步骤 | 工作内容 | 文件 |
|------|---------|------|
| 3.1 | 设计 `:::directive{attrs}` 语法规范文档 | `docs/` |
| 3.2 | 在 `markdownToDoc` 中新增 `:::` 围栏指令解析器 | markdown.ts |
| 3.3 | 在 `serializeBlock` 中为所有 atom 面板块输出 `:::` 指令 | markdown.ts |
| 3.4 | AI 服务层（`services/ai/`）输出模板调整为包含指令语法 | ai service |

### Phase 4：缺失 NodeView 补全

| 步骤 | 工作内容 |
|------|---------|
| 4.1 | `SyncedBlockExtension` 添加 React NodeView（显示同步图标 + 来源链接） |
| 4.2 | `SubPageExtension` 添加 React NodeView（显示页面图标 + 标题卡片） |
| 4.3 | `BreadcrumbExtension` 添加 React NodeView（显示路径面包屑导航） |

---

## 八、CSS 样式文件映射

| 文件 | 覆盖的组件 | 行数 |
|------|----------|------|
| [code-block-view.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/code-block-view.css) | CodeBlockView 代码块（含工具栏、下拉面板、行号） | 498 |
| [fenced.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/fenced.css) | Callout / Diff / Mermaid 围栏块 | 14396 |
| [media-data-blocks.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/media-data-blocks.css) | 图片 / 视频 / 音频 / 文件 / 书签 / 嵌入 / 数学 / 图表 | 15525 |
| [layout-blocks.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/layout-blocks.css) | ColumnLayout / Tabs / Toggle / TOC / Button / AI | 10922 |
| [database.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/database.css) | Database 数据库全部视图 | 20095 |
| [table.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/table.css) | Table 基础表格 | 12726 |
| [block-shell.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/block-shell.css) | BlockShell 统一外壳（选中环、工具条、拖拽手柄） | 8157 |
| [block-affordances.css](file:///C:/Software/conex/docs/composer-preview/src/styles/blocks/block-affordances.css) | 块级悬浮交互反馈 | 6751 |

---

## 九、Slash 菜单命令覆盖率

[slashCommands.ts](file:///C:/Software/conex/docs/composer-preview/src/menus/slashCommands.ts) 中注册了 **27 条命令**，覆盖了以下功能：

| 分类 | 命令数 | 具体 ID |
|------|--------|---------|
| 基础 (basic) | 4 | text, h1, h2, h3 |
| 列表 (lists) | 5 | bullet, ordered, task, toggleList, toggleHeading |
| 区块 (blocks) | 5 | quote, callout, code, diff, divider |
| 媒体 (media) | 6 | image, video, audio, file, bookmark, embed |
| 数据 (data) | 5 | table, database, chart, mermaid, math |
| 布局 (layout) | 4 | columns2, columns3, tabs, toc |
| 高级 (advanced) | 2 | button, ai |

**未在 Slash 菜单注册的 Extension**：
- `syncedBlock` — 语义上应该通过「转换为同步块」而非直接插入
- `subPage` — 应有独立的页面选择器 UI
- `breadcrumb` — 通常是页面级组件，不应在块级菜单里
- `mathInline` — 行内节点，通过 `$...$` 语法插入而非 Slash 菜单
- `column` / `tabPanel` — 子节点，由父节点命令自动创建

这个覆盖率是合理的，不需要额外增加命令。

---

## 十、总结

| 维度 | 当前状态 | 目标状态 |
|------|---------|---------|
| 初始文档展示 | 15 / 38 个功能可见 | **35 / 38** 个可见（排除 3 个无 View 的） |
| 序列化 → Markdown | 7 种块有专用 case | **12 种块** 有专用 case + `:::` 指令兜底 |
| Markdown → 文档 | 只识别标准 Markdown | 识别 **Callout / Mermaid / Diff / Math / Image** |
| AI 可生成 | 仅标准 Markdown | 通过 `:::` 指令语法支持所有富组件 |
| Slash 菜单 | 27 / 27 命令可用 | 不变（覆盖率已满） |
