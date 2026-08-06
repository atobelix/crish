# Conex Markdown Live Preview Engine — 全面重构方案

> **版本**: v2.0 Architecture Blueprint
> **日期**: 2026-08-04
> **范围**: `docs/composer-preview/` 完全重写
> **原则**: 单一先进架构，拒绝补丁兼容，融合 Notion 高级交互 + Obsidian Markdown 哲学

---

# 第一部分：现有架构深度诊断

## 1.1 致命级问题（导致运行时崩溃）

### P0-1. Extension 重复注册

**现象**: Tiptap 启动时抛出警告 `Duplicate extension names found: ['underline', 'codeBlock', 'tag', 'callout']`。

**根因**: `CalloutExtension` 同时存在于两个目录：
- [CalloutExtension.tsx](file:///C:/Software/conex/docs/composer-preview/src/extensions/foundation/CalloutExtension.tsx) — `content: 'paragraph+'`，使用 `ReactNodeViewRenderer(CalloutComponent)`
- [CalloutExtension.ts](file:///C:/Software/conex/docs/composer-preview/src/extensions/code-structure/CalloutExtension.ts) — `content: 'text*'`，使用 `ReactNodeViewRenderer(CalloutBlockView)`

同样的问题出现在 `TagExtension`（foundation vs code-structure）和 `CodeBlockExtension`（foundation/index.ts:16 直接引入了 code-structure 的 CodeBlockExtension 又在 code-structure/index.ts 里再次导出）。

**影响**: ProseMirror Schema 编译时随机选取一个定义，导致 `content` 约束不一致，某些操作会触发 `RangeError: Position out of range`。

### P0-2. `import type` 遗漏导致 Vite ESM 崩溃

**现象**: 页面白屏，控制台报 `SyntaxError: does not provide an export named 'NodeViewProps'`。

**根因**: TypeScript 的 `type` 关键字在编译为 ESM 时会被 esbuild 擦除。如果不加 `type`，esbuild 会尝试从运行时模块中导入一个不存在的值导出。当前代码库中至少有 8 处遗漏了 `import type`。

**影响**: 整个应用无法启动，且 Vite HMR 无法恢复，必须手动刷新。

### P0-3. `useLivePreviewEditing` 的 `pos` 值不响应文档变化

**现象**: 用户在节点上方插入/删除内容后，该节点的 Live Preview 编辑检测失效。

**根因**: [useLivePreviewEditing.ts:33](file:///C:/Software/conex/docs/composer-preview/src/hooks/useLivePreviewEditing.ts#L33) 中 `pos` 在组件顶层计算一次：
```ts
const pos = typeof getPos === 'function' ? getPos() : null;
```
这个值在 React 渲染周期中是**固定的**。当文档发生插入/删除操作后，节点的绝对位置已经改变，但 `pos` 仍然是旧值，导致 `selectionUpdate` 回调中的边界比较全部失效。

**正确做法**: 在 `checkSelection` 回调内部每次调用 `getPos()` 获取最新位置。

---

## 1.2 架构级问题（导致功能不可扩展）

### P1-1. Extension 目录混乱，无分层边界

当前结构：
```
extensions/
  foundation/       ← 基础扩展 + Slash Commands + 又引入了 CodeBlockExtension??
    CalloutExtension.tsx    ← 副本 A (content: paragraph+)
    TagExtension.ts         ← 副本 A
    SlashCommands.ts
    HeadingAnchor.ts
    index.ts                ← 直接 import CodeBlockExtension from '../code-structure/'
  code-structure/    ← "高级"扩展
    CalloutExtension.ts     ← 副本 B (content: text*)
    TagExtension.ts         ← 副本 B
    CodeBlockExtension.ts
    MermaidExtension.ts
    ...
  live-preview/
    LivePreviewInlineExtension.ts
```

**问题**:
1. `foundation/index.ts` 同时注册 `CalloutExtension`（来自 foundation）和 `CodeBlockExtension`（来自 code-structure），而 `getCodeStructureExtensions()` 又注册了自己的 `CalloutExtension`（来自 code-structure）。TiptapEditor 同时调用两个 getter，导致重复。
2. 没有"块级"vs"行内"vs"交互面板"的分层概念。
3. `SlashCommands.ts` 425 行，同时定义了数据、渲染逻辑和 Tiptap Extension — 违反单一职责。

### P1-2. NodeView 组件是"上帝组件"

| 文件 | 行数 | 问题 |
|------|------|------|
| [KaTeXBlockView.tsx](file:///C:/Software/conex/docs/composer-preview/src/components/blocks/KaTeXBlockView.tsx) | 733 | 包含：编辑状态管理、KaTeX 渲染、符号工具栏（5个Tab）、全屏模式、Save/Cancel 逻辑、SymbolButton 子组件定义 |
| [CodeBlockView.tsx](file:///C:/Software/conex/docs/composer-preview/src/components/blocks/CodeBlockView.tsx) | 328 | 内联 Popover 语言选择器、复制逻辑、围栏标记管理 |
| [DiffBlockView.tsx](file:///C:/Software/conex/docs/composer-preview/src/components/blocks/DiffBlockView.tsx) | 293 | Diff 解析器（应独立为 util）+ 渲染表格 + 围栏标记 |
| [SlashMenuPopover.tsx](file:///C:/Software/conex/docs/composer-preview/src/components/menus/SlashMenuPopover.tsx) | 364 | 重复实现了 SlashCommands.ts 的菜单逻辑 |

### P1-3. 围栏标记在 ProseMirror 文档模型之外

当前的围栏标记（` ``` `、`$$`）使用了 `contentEditable` 的独立 `<div>`，它们**不属于 ProseMirror 文档树**：

```tsx
// CodeBlockView.tsx:270-283
{isEditing && (
  <div
    contentEditable          // ← 这是一个脱离 PM 的独立可编辑区域
    suppressContentEditableWarning
    onInput={handleFenceStartInput}
    ...
  >
    {`\`\`\`${selectedLanguage}`}
  </div>
)}
```

**影响**:
1. 围栏标记的修改**不参与 Undo/Redo**（ProseMirror 的 History 插件无法追踪）
2. 围栏标记的修改**不触发 `onUpdate` 回调**（文档 Markdown 导出不会包含语言变更）
3. 多个 `contentEditable` 区域共存导致**焦点争抢**，用户在围栏标记和代码内容之间切换时经常丢失光标

### P1-4. 数据库状态存储在 React useState 中

[DatabaseBlockView.tsx:12](file:///C:/Software/conex/docs/composer-preview/src/components/blocks/database/DatabaseBlockView.tsx#L12)：
```ts
const [dbState, setDbState] = useState<DatabaseState>(() => { ... });
```

**影响**:
1. `dbState` 不在 ProseMirror 文档树中 → **Undo/Redo 对数据库操作无效**
2. `updateAttributes({ state: newState })` 将整个 JSON 写入属性 → 每次操作序列化整个数据库 → **性能灾难**
3. 多窗口/多标签页无法同步状态

---

## 1.3 样式级问题（导致 UI 粗糙）

### P2-1. 全局内联样式泛滥

当前代码库中，**所有 Block NodeView 组件** 100% 使用内联 `style={{...}}` 对象。粗略统计：

- `KaTeXBlockView.tsx`: 约 45 处 `style={{...}}`
- `CodeBlockView.tsx`: 约 20 处
- `DiffBlockView.tsx`: 约 18 处
- `DatabaseBlockView.tsx`: 约 15 处
- `SlashMenuPopover.tsx`: 约 22 处

**问题**:
1. 无法使用 CSS 伪类（`:hover`、`:focus`、`::before`）→ 被迫用 `onMouseEnter`/`onMouseLeave` 模拟
2. 无法做主题切换（暗色模式）
3. 无法响应式适配（媒体查询）
4. 代码极度冗长且充满重复的颜色值（`#e2e8f0` 出现 50+ 次）

### P2-2. CSS 设计系统矛盾

[Composer.css:67](file:///C:/Software/conex/docs/composer-preview/src/Composer.css#L67)：
```css
.ProseMirror strong { font-weight: 600; color: #fff; }
```
**在白色背景上把加粗文字设为白色** — 完全不可见。

[Composer.css:136-142](file:///C:/Software/conex/docs/composer-preview/src/Composer.css#L136)：
```css
.ProseMirror code {
  background-color: var(--bg-primary);  /* #ffffff */
  color: #e4e6eb;                       /* 浅灰色 */
  ...
}
```
**在白色背景上用浅灰色文字** — 几乎不可读。

这些是上一轮开发遗留的暗色主题残留代码。

### P2-3. 与 Notion 风格差距巨大

对比用户截图中的 Notion 风格：
- Notion：干净的白底、精致的圆角卡片、柔和的分隔线、表格有颜色标签和图标
- 当前：粗糙的灰色边框、无动画、表格无颜色体系、代码块没有语法高亮

---

## 1.4 功能缺失清单

### 完全不存在的区块类型（0% 实现）

| 类别 | 缺失的区块 |
|------|-----------|
| **基础区块** | 折叠列表 (Toggle)、白页面 (SubPage)、链接到页面 (PageLink)、折叠标题 (H1/H2/H3 Toggle Heading) |
| **布局区块** | 2/3/4/5 列布局 (Column Layout)、选项卡 (Tabs)、路径栏 (Breadcrumb Block) |
| **媒体区块** | 图片 (ImageBlock)、视频 (VideoBlock)、音频 (AudioBlock)、文件附件 (FileBlock)、网页书签 (BookmarkBlock) |
| **数据库视图** | 画廊视图 (Gallery)、列表视图 (ListView)、日历视图 (Calendar)、时间轴视图 (Timeline)、地图视图 (Map)、图表视图（柱形/折线/环形）、表单视图 (Form)、管理面板视图 (Dashboard) |
| **高级区块** | 目录块 (TOC Block，有 Extension 但无 NodeView)、按钮 (Button)、同步区块 (SyncedBlock)、AI 速记 (AI Quicknote)、AI 区块 (AI Block) |
| **行内元素** | 提及人员 (@mention)、提及页面、日期/提醒、表情符号选择器、行内公式（有 Extension 但渲染复用了 Block 组件） |
| **嵌入** | HTML 嵌入、PDF 嵌入、Word/Excel 嵌入、Canvas 画布 |

### 功能残缺的区块

| 区块 | 现状 | 缺失 |
|------|------|------|
| **标题 H1-H6** | 仅渲染，无源码显示 | 编辑时应显示 `## ` 前缀标记 |
| **引用 Blockquote** | 基础 `>` 渲染 | 编辑时应显示 `> ` 前缀标记 |
| **分割线 HR** | 基础渲染 | 编辑时应显示 `---` |
| **任务列表** | Checkbox 可用 | 编辑时应显示 `- [ ]` / `- [x]` |
| **表格** | 用户明确要求**不显示源码**，但当前表格无右键菜单、无颜色系统、无文本格式化 | 缺少：右键上下文菜单（剪切/复制/粘贴/文本格式/对齐/删除）、文本颜色/背景颜色、单元格合并、表头样式 |
| **Mermaid** | Mock 渲染，未安装 mermaid.js | 需要真实 SVG 渲染 |
| **数据库** | 仅 Table + Kanban 两个视图 | 缺少 7+ 个视图类型 |

---

# 第二部分：全新架构设计

## 2.1 设计哲学

### 核心原则

1. **Markdown-First, Notion-Augmented**: 底层数据永远是 Markdown（或 Markdown 扩展语法），高级交互（数据库、画布）通过结构化 JSON 存储在 Markdown 的 YAML frontmatter 或自定义代码块中
2. **源码即真相 (Source as Truth)**: 每个区块的 Markdown 源码可以在编辑模式下完整查看和修改，不存在"隐藏的不可编辑元素"
3. **交互面板 ≠ 源码显示**: 高级区块（数据库、图表、嵌入）不需要显示源码，它们的编辑通过专用面板完成，但底层数据仍然以结构化格式存储在文档中
4. **CSS Class 优先**: 所有样式通过 CSS class 管理，支持主题切换，零内联样式
5. **Extension 即模块边界**: 每个 Tiptap Extension 是一个自包含的模块，包含 Schema 定义、NodeView 组件、CSS 样式、序列化/反序列化逻辑

### 区块分类体系

根据编辑行为的不同，所有区块分为 3 个层级：

| 层级 | 编辑行为 | 代表区块 | 源码显示 |
|------|---------|---------|---------|
| **L1 原生文本块** | ProseMirror 原生编辑，光标进入时显示 Markdown 语法标记 | 标题、段落、列表、引用、分割线、任务列表 | ✅ 光标进入时显示 `##` / `>` / `- [ ]` 等标记 |
| **L2 围栏代码块** | 围栏标记 + 代码内容，光标进入时显示完整围栏，离开时显示渲染结果 | 代码块、Mermaid、Diff、KaTeX、Callout | ✅ 光标进入时显示 ` ``` ` / `$$` / `> [!TYPE]` |
| **L3 交互面板块** | 不显示源码，通过专用 UI 面板编辑，底层数据存储在节点属性中 | 数据库、图表、图片、视频、嵌入、画布、按钮 | ❌ 通过交互面板操作 |

---

## 2.2 目录结构重设计

```
src/
├── core/                          # 引擎核心（不含 UI）
│   ├── schema/                    # Tiptap Extension 定义
│   │   ├── marks/                 # 行内 Mark 扩展
│   │   │   ├── BoldMark.ts
│   │   │   ├── ItalicMark.ts
│   │   │   ├── StrikeMark.ts
│   │   │   ├── UnderlineMark.ts
│   │   │   ├── HighlightMark.ts
│   │   │   ├── CodeMark.ts
│   │   │   ├── LinkMark.ts
│   │   │   ├── WikiLinkMark.ts
│   │   │   ├── TagMark.ts
│   │   │   ├── ColorMark.ts
│   │   │   └── index.ts
│   │   ├── nodes/                 # 块级 Node 扩展
│   │   │   ├── text/              # L1 原生文本块
│   │   │   │   ├── HeadingNode.ts
│   │   │   │   ├── ParagraphNode.ts  # (通常由 StarterKit 提供)
│   │   │   │   ├── BlockquoteNode.ts
│   │   │   │   ├── BulletListNode.ts
│   │   │   │   ├── OrderedListNode.ts
│   │   │   │   ├── TaskListNode.ts
│   │   │   │   ├── ToggleListNode.ts     # 折叠列表
│   │   │   │   ├── HorizontalRuleNode.ts
│   │   │   │   └── index.ts
│   │   │   ├── fenced/            # L2 围栏代码块
│   │   │   │   ├── CodeBlockNode.ts
│   │   │   │   ├── MermaidNode.ts
│   │   │   │   ├── DiffNode.ts
│   │   │   │   ├── MathBlockNode.ts
│   │   │   │   ├── CalloutNode.ts
│   │   │   │   ├── ChartNode.ts          # ECharts
│   │   │   │   └── index.ts
│   │   │   ├── panel/             # L3 交互面板块
│   │   │   │   ├── DatabaseNode.ts
│   │   │   │   ├── ImageNode.ts
│   │   │   │   ├── VideoNode.ts
│   │   │   │   ├── AudioNode.ts
│   │   │   │   ├── FileNode.ts
│   │   │   │   ├── BookmarkNode.ts
│   │   │   │   ├── EmbedNode.ts
│   │   │   │   ├── ButtonNode.ts
│   │   │   │   ├── ColumnLayoutNode.ts
│   │   │   │   ├── TabsNode.ts
│   │   │   │   ├── SyncedBlockNode.ts
│   │   │   │   ├── TableOfContentsNode.ts
│   │   │   │   ├── ToggleHeadingNode.ts
│   │   │   │   ├── SubPageNode.ts
│   │   │   │   ├── BreadcrumbNode.ts
│   │   │   │   ├── AIBlockNode.ts
│   │   │   │   └── index.ts
│   │   │   └── inline/            # 行内 Node 扩展（非 Mark）
│   │   │       ├── MathInlineNode.ts
│   │   │       ├── MentionNode.ts
│   │   │       ├── DateNode.ts
│   │   │       ├── EmojiNode.ts
│   │   │       └── index.ts
│   │   └── index.ts               # 统一注册入口
│   ├── plugins/                   # ProseMirror 插件
│   │   ├── LivePreviewPlugin.ts   # 统一的源码标记显隐逻辑
│   │   ├── SlashCommandPlugin.ts  # Slash 命令触发
│   │   ├── DragHandlePlugin.ts    # 拖拽手柄
│   │   ├── PlaceholderPlugin.ts   # 占位文字
│   │   └── index.ts
│   ├── serializer/                # Markdown 序列化/反序列化
│   │   ├── MarkdownSerializer.ts
│   │   ├── MarkdownParser.ts
│   │   ├── rules/                 # 各区块的序列化规则
│   │   │   ├── headingRule.ts
│   │   │   ├── codeBlockRule.ts
│   │   │   ├── mathRule.ts
│   │   │   ├── calloutRule.ts
│   │   │   ├── databaseRule.ts
│   │   │   └── ...
│   │   └── index.ts
│   ├── commands/                  # 编辑器命令
│   │   ├── insertBlock.ts
│   │   ├── convertBlock.ts
│   │   ├── deleteBlock.ts
│   │   └── index.ts
│   └── types/                     # 类型定义
│       ├── blocks.ts              # 所有区块的类型定义
│       ├── database.ts            # 数据库相关类型
│       ├── editor.ts              # 编辑器通用类型
│       └── index.ts
│
├── views/                         # React NodeView 组件
│   ├── text/                      # L1 原生文本块的 NodeView
│   │   ├── HeadingView.tsx
│   │   ├── BlockquoteView.tsx
│   │   ├── ToggleListView.tsx
│   │   ├── TaskItemView.tsx
│   │   └── index.ts
│   ├── fenced/                    # L2 围栏块的 NodeView
│   │   ├── CodeBlockView.tsx
│   │   ├── MermaidView.tsx
│   │   ├── DiffView.tsx
│   │   ├── MathBlockView.tsx
│   │   ├── CalloutView.tsx
│   │   ├── ChartView.tsx
│   │   └── index.ts
│   ├── panel/                     # L3 交互面板块的 NodeView
│   │   ├── database/
│   │   │   ├── DatabaseView.tsx       # 入口壳组件
│   │   │   ├── TableView.tsx
│   │   │   ├── KanbanView.tsx
│   │   │   ├── GalleryView.tsx
│   │   │   ├── ListViewPanel.tsx
│   │   │   ├── CalendarView.tsx
│   │   │   ├── TimelineView.tsx
│   │   │   ├── ChartViewPanel.tsx
│   │   │   ├── FormView.tsx
│   │   │   ├── DatabaseToolbar.tsx
│   │   │   ├── CellRenderers.tsx
│   │   │   ├── ColumnConfig.tsx
│   │   │   └── index.ts
│   │   ├── media/
│   │   │   ├── ImageView.tsx
│   │   │   ├── VideoView.tsx
│   │   │   ├── AudioView.tsx
│   │   │   ├── FileView.tsx
│   │   │   ├── BookmarkView.tsx
│   │   │   ├── EmbedView.tsx
│   │   │   └── index.ts
│   │   ├── layout/
│   │   │   ├── ColumnLayoutView.tsx
│   │   │   ├── TabsView.tsx
│   │   │   ├── ToggleHeadingView.tsx
│   │   │   └── index.ts
│   │   ├── advanced/
│   │   │   ├── TableOfContentsView.tsx
│   │   │   ├── ButtonView.tsx
│   │   │   ├── SyncedBlockView.tsx
│   │   │   ├── SubPageView.tsx
│   │   │   ├── BreadcrumbView.tsx
│   │   │   ├── AIBlockView.tsx
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── inline/                    # 行内 Node 的 NodeView
│   │   ├── MathInlineView.tsx
│   │   ├── MentionView.tsx
│   │   ├── DateView.tsx
│   │   ├── EmojiView.tsx
│   │   └── index.ts
│   └── _shared/                   # NodeView 共享组件
│       ├── FenceMarker.tsx        # 统一围栏标记组件
│       ├── BlockToolbar.tsx       # 区块工具栏壳
│       ├── EmptyState.tsx         # 空状态占位
│       ├── ResizablePanel.tsx     # 可调大小面板
│       └── index.ts
│
├── ui/                            # 通用 UI 组件（不依赖 Tiptap）
│   ├── Button.tsx
│   ├── Dialog.tsx
│   ├── DropdownMenu.tsx
│   ├── Popover.tsx
│   ├── Tabs.tsx
│   ├── Tooltip.tsx
│   ├── ContextMenu.tsx            # 右键菜单
│   ├── ColorPicker.tsx
│   ├── IconButton.tsx
│   ├── Badge.tsx
│   ├── Avatar.tsx
│   ├── Calendar.tsx               # 日期选择器
│   ├── Select.tsx
│   ├── Input.tsx
│   └── index.ts
│
├── menus/                         # 编辑器级菜单
│   ├── BubbleMenu.tsx
│   ├── SlashMenu.tsx              # 仅 UI 层，数据从 SlashCommandPlugin 注入
│   ├── BlockMenu.tsx              # 块级右键菜单（转换类型、复制、删除）
│   ├── TableContextMenu.tsx       # 表格专用右键菜单
│   ├── CommandPalette.tsx
│   └── index.ts
│
├── shell/                         # 应用外壳
│   ├── Editor.tsx                 # 编辑器主组件（替代 TiptapEditor + ComposerShell）
│   ├── AppLayout.tsx
│   ├── HeaderBar.tsx
│   ├── SidebarLeft.tsx
│   ├── SidebarRight.tsx
│   ├── TableOfContentsSidebar.tsx
│   ├── BacklinksDrawer.tsx
│   └── AIChatSidebar.tsx
│
├── styles/                        # CSS 样式系统
│   ├── tokens.css                 # 设计令牌（颜色、间距、圆角、字体）
│   ├── reset.css                  # CSS Reset
│   ├── typography.css             # 排版基础
│   ├── prosemirror.css            # ProseMirror 基础样式
│   ├── blocks/                    # 各区块样式（与 views/ 一一对应）
│   │   ├── heading.css
│   │   ├── code-block.css
│   │   ├── callout.css
│   │   ├── database.css
│   │   ├── image.css
│   │   ├── ...
│   │   └── index.css              # @import 聚合
│   ├── menus/
│   │   ├── bubble-menu.css
│   │   ├── slash-menu.css
│   │   ├── context-menu.css
│   │   └── index.css
│   ├── ui/
│   │   ├── button.css
│   │   ├── dialog.css
│   │   ├── popover.css
│   │   └── index.css
│   └── index.css                  # 总入口
│
├── hooks/                         # React Hooks
│   ├── useBlockEditing.ts         # 替代 useLivePreviewEditing（修复 pos 问题）
│   ├── useEditorState.ts          # 编辑器状态订阅
│   ├── useTheme.ts                # 主题切换
│   └── index.ts
│
├── utils/                         # 工具函数
│   ├── diffParser.ts              # Diff 解析器（从 DiffBlockView 抽出）
│   ├── slugify.ts                 # 标题锚点生成
│   ├── debounce.ts
│   ├── clipboard.ts               # 剪贴板操作封装
│   └── index.ts
│
└── main.tsx                       # 应用入口
```

---

## 2.3 统一数据模型设计

### 2.3.1 Block Schema 规范

每个 Tiptap Node Extension 必须遵循以下模板：

```typescript
// core/schema/nodes/fenced/CodeBlockNode.ts

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CodeBlockView } from '../../../../views/fenced/CodeBlockView';

export interface CodeBlockAttrs {
  language: string;
  showLineNumbers: boolean;
  highlightLines: number[];
  filename: string;
}

export const CodeBlockNode = Node.create<{ HTMLAttributes: Record<string, any> }>({
  name: 'codeBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      language:       { default: 'plaintext' },
      showLineNumbers:{ default: true },
      highlightLines: { default: [] },
      filename:       { default: '' },
    };
  },

  // parseHTML, renderHTML, addNodeView, addKeyboardShortcuts, addCommands
  // 严格遵循下文的序列化规则
});
```

**规范要求**：
1. 每个 Extension 文件 ≤ 150 行（Schema + 命令 + 快捷键）
2. NodeView 组件文件 ≤ 400 行（UI 渲染 + 交互逻辑）
3. 序列化规则独立到 `core/serializer/rules/` 中
4. CSS 样式独立到 `styles/blocks/` 中

### 2.3.2 Markdown 扩展语法规范

基础 Markdown 语法直接使用标准 CommonMark + GFM：

| 区块 | Markdown 语法 | 备注 |
|------|-------------|------|
| 标题 | `# H1` ~ `###### H6` | 标准 |
| 粗体 | `**text**` | 标准 |
| 斜体 | `*text*` 或 `_text_` | 标准 |
| 删除线 | `~~text~~` | GFM |
| 行内代码 | `` `code` `` | 标准 |
| 链接 | `[text](url)` | 标准 |
| 图片 | `![alt](url)` | 标准 |
| 引用 | `> text` | 标准 |
| 分割线 | `---` | 标准 |
| 无序列表 | `- item` | 标准 |
| 有序列表 | `1. item` | 标准 |
| 任务列表 | `- [ ] item` / `- [x] item` | GFM |
| 表格 | `\| a \| b \|` | GFM |
| 代码块 | ` ```lang ` | 标准 |
| 高亮 | `==text==` | 扩展 |
| 下划线 | `<u>text</u>` | HTML |
| WikiLink | `[[page]]` | Obsidian |
| 标签 | `#tag` | Obsidian |
| 数学行内 | `$formula$` | Obsidian/Typora |
| 数学块 | `$$\nformula\n$$` | Obsidian/Typora |
| Callout | `> [!TYPE]\n> text` | GitHub/Obsidian |
| Mermaid | ` ```mermaid ` | GFM |
| Diff | ` ```diff ` | GFM |

高级区块（不可纯 Markdown 表示）的扩展语法：

```markdown
<!-- 数据库区块 -->
:::database
{
  "id": "db-xxx",
  "title": "项目任务",
  "schema": { ... },
  "data": [ ... ]
}
:::

<!-- 嵌入区块 -->
:::embed{url="https://..." type="bookmark"}
:::

<!-- 列布局 -->
:::columns{count=3}
::col
第一列内容
::col
第二列内容
::col
第三列内容
:::

<!-- 折叠列表 -->
:::toggle{title="点击展开"}
折叠内容
:::

<!-- 按钮 -->
:::button{label="点击执行" action="open" url="https://..."}
:::
```

**设计要点**：
- 使用 `:::` 三冒号语法（Markdown Directive 提案）作为高级区块的分隔符
- 区块属性通过 `{key=value}` 语法传递
- 复杂数据（数据库行列）使用 JSON 嵌入
- 所有扩展语法降级后仍然是合法的 Markdown（`:::` 会被普通渲染器视为分隔符或忽略）

### 2.3.3 数据库数据模型

```typescript
// core/types/database.ts

/** 数据库视图类型 */
export type DatabaseViewType =
  | 'table'       // 表格视图
  | 'kanban'      // 看板视图
  | 'gallery'     // 画廊视图
  | 'list'        // 列表视图
  | 'calendar'    // 日历视图
  | 'timeline'    // 时间轴视图
  | 'chart'       // 图表视图（折线/柱形/环形）
  | 'form'        // 表单视图
  | 'map'         // 地图视图
  | 'dashboard';  // 管理面板视图

/** 列属性类型 */
export type PropertyType =
  | 'title'           // 标题（每个数据库必须有且仅有一个）
  | 'text'            // 多行文本
  | 'number'          // 数字
  | 'select'          // 单选
  | 'multi_select'    // 多选
  | 'status'          // 状态（内建：未开始/进行中/已完成）
  | 'date'            // 日期（支持提醒）
  | 'person'          // 人员
  | 'file'            // 文件附件
  | 'checkbox'        // 复选框
  | 'url'             // URL
  | 'email'           // 电子邮件
  | 'phone'           // 电话
  | 'formula'         // 公式
  | 'relation'        // 关联（关联到另一个数据库）
  | 'rollup'          // 汇总
  | 'created_time'    // 创建时间（只读）
  | 'created_by'      // 创建者（只读）
  | 'last_edited_time'// 最后编辑时间（只读）
  | 'last_edited_by'; // 最后编辑者（只读）

/** 选项（用于 select/multi_select/status） */
export interface SelectOption {
  id: string;
  name: string;
  color: PropertyColor;
}

/** Notion 预定义的 10 种属性颜色 */
export type PropertyColor =
  | 'default' | 'gray' | 'brown' | 'orange' | 'yellow'
  | 'green' | 'blue' | 'purple' | 'pink' | 'red';

/** 列（属性）定义 */
export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  width?: number;
  options?: SelectOption[];
  format?: NumberFormat;
  formula?: string;
  relationConfig?: {
    databaseId: string;
    isTwoWay: boolean;
  };
}

/** 数字格式 */
export type NumberFormat =
  | 'number' | 'number_with_commas' | 'percent'
  | 'dollar' | 'yuan' | 'euro' | 'pound';

/** 单元格值 — 根据 PropertyType 确定具体类型 */
export type CellValue =
  | string              // title, text, url, email, phone
  | number              // number
  | boolean             // checkbox
  | string[]            // multi_select (option ids)
  | string              // select, status (option id)
  | DateValue           // date
  | string[]            // person (user ids)
  | FileValue[]         // file
  | null;

export interface DateValue {
  start: string;         // ISO date string
  end?: string;          // ISO date string (for date ranges)
  includeTime: boolean;
  reminder?: string;     // 提醒时间 ISO
}

export interface FileValue {
  name: string;
  url: string;
  size: number;
  mimeType: string;
}

/** 行（记录） */
export interface DatabaseRow {
  id: string;
  properties: Record<string, CellValue>;
  createdAt: number;
  updatedAt: number;
}

/** 排序条件 */
export interface SortRule {
  propertyId: string;
  direction: 'ascending' | 'descending';
}

/** 筛选条件 */
export interface FilterRule {
  propertyId: string;
  operator: FilterOperator;
  value: any;
}

export type FilterOperator =
  | 'equals' | 'does_not_equal'
  | 'contains' | 'does_not_contain'
  | 'starts_with' | 'ends_with'
  | 'is_empty' | 'is_not_empty'
  | 'greater_than' | 'less_than'
  | 'greater_than_or_equal' | 'less_than_or_equal'
  | 'is_before' | 'is_after' | 'is_on_or_before' | 'is_on_or_after'
  | 'is_relative_to_today';

/** 视图配置 */
export interface DatabaseView {
  id: string;
  name: string;
  type: DatabaseViewType;
  visibleProperties: string[];  // 可见列 ID 列表
  sorts: SortRule[];
  filters: FilterRule[];
  filterOperator: 'and' | 'or';
  // 视图特有配置
  groupBy?: string;                 // Kanban 分组列
  subGroupBy?: string;              // Kanban 子分组
  calendarBy?: string;              // Calendar 日期列
  timelineBy?: { start: string; end: string }; // Timeline 开始/结束列
  galleryCover?: { propertyId: string; size: 'small' | 'medium' | 'large' };
  chartConfig?: ChartConfig;
  cardPreviewProperties?: string[]; // Kanban/Gallery 卡片上显示的属性
}

/** 图表配置 */
export interface ChartConfig {
  type: 'bar' | 'horizontal_bar' | 'line' | 'donut' | 'pie';
  xAxis: string;         // 属性 ID
  yAxis: string;         // 属性 ID
  groupBy?: string;      // 属性 ID
}

/** 数据库顶层结构 */
export interface DatabaseSchema {
  id: string;
  title: string;
  icon?: string;
  cover?: string;
  properties: Property[];
  rows: DatabaseRow[];
  views: DatabaseView[];
  activeViewId: string;
  isInline: boolean;      // 内联数据库 vs 整页数据库
  linkedSourceId?: string; // 链接视图的源数据库 ID
}
```

**关键设计决策**:
- 数据库的**整个 Schema + Data** 存储在 Tiptap 节点的 `attrs.data` 中（JSON 字符串）
- 每次修改通过 ProseMirror 事务 (`tr`) 提交 → 自动参与 Undo/Redo
- 使用 `debounce(350ms)` 批量提交属性变更，避免每次按键都生成事务
- 大数据库（>1000 行）使用虚拟滚动 + 分页加载

---

## 2.4 Live Preview 核心机制重设计

### 2.4.1 统一的 ProseMirror Plugin 方案

**现有问题的根源**: 当前的 Live Preview 逻辑分散在各个 NodeView 组件中（通过 `useLivePreviewEditing` Hook），每个组件独立监听 `selectionUpdate`，且围栏标记在 ProseMirror 文档树之外。

**新方案**: 将所有源码标记的显隐逻辑统一到一个 ProseMirror Plugin（`LivePreviewPlugin`）中，通过 Decoration 系统在合适的时机注入/移除标记。

```typescript
// core/plugins/LivePreviewPlugin.ts

/**
 * LivePreviewPlugin — 统一管理所有区块的源码标记显隐
 *
 * 核心思路：
 * 1. 维护一个 "activeNodes" 集合（当前光标所在的节点 + 被选区覆盖的节点）
 * 2. 对于 activeNodes 中的 L1/L2 类型节点，注入 Decoration 显示源码标记
 * 3. 对于非 activeNodes 中的节点，移除 Decoration，显示渲染结果
 *
 * 这样做的好处：
 * - 所有节点的编辑状态由同一个 Plugin 管理，避免各 NodeView 独立监听的性能开销
 * - Decoration 方案与文档模型一致，支持 Undo/Redo
 * - 全选时可以一次性计算所有节点的状态
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const LivePreviewPluginKey = new PluginKey('livePreview');

interface LivePreviewState {
  activeNodePositions: Set<number>;  // 当前处于编辑模式的节点起始位置集合
}

export const LivePreviewPlugin = new Plugin<LivePreviewState>({
  key: LivePreviewPluginKey,

  state: {
    init(): LivePreviewState {
      return { activeNodePositions: new Set() };
    },

    apply(tr, prev, oldState, newState): LivePreviewState {
      const { from, to } = newState.selection;
      const activeNodePositions = new Set<number>();

      // 遍历文档，找出所有被选区触及的 L1/L2 节点
      newState.doc.descendants((node, pos) => {
        if (isLivePreviewNode(node)) {
          const nodeEnd = pos + node.nodeSize;
          const cursorInside = from >= pos && to <= nodeEnd;
          const selectionCovers = from <= pos && to >= nodeEnd;

          if (cursorInside || selectionCovers) {
            activeNodePositions.add(pos);
          }
        }
      });

      return { activeNodePositions };
    },
  },

  props: {
    // NodeView 组件通过读取 Plugin 状态来决定显示模式
    // 不需要 Decoration — NodeView 直接从 Plugin state 读取
  },
});

function isLivePreviewNode(node: any): boolean {
  // L1 和 L2 类型的节点名
  const livePreviewTypes = [
    'heading', 'blockquote', 'bulletList', 'orderedList',
    'taskList', 'horizontalRule', 'toggleList',
    'codeBlock', 'mermaidBlock', 'diffBlock',
    'mathBlock', 'callout',
  ];
  return livePreviewTypes.includes(node.type.name);
}
```

### 2.4.2 新版 useBlockEditing Hook

```typescript
// hooks/useBlockEditing.ts

import { useMemo, useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/core';
import { LivePreviewPluginKey } from '../core/plugins/LivePreviewPlugin';

/**
 * 替代旧版 useLivePreviewEditing 的新 Hook。
 *
 * 关键改进：
 * 1. 不再在组件顶层调用 getPos() — 而是在 Plugin 的 apply() 中实时计算
 * 2. 使用 useSyncExternalStore 订阅 Plugin 状态 — React 18 并发安全
 * 3. 不再独立监听 selectionUpdate — 统一由 Plugin 管理
 */
export function useBlockEditing(editor: Editor, getPos: (() => number) | boolean) {
  const subscribe = useMemo(() => {
    return (callback: () => void) => {
      editor.on('transaction', callback);
      return () => editor.off('transaction', callback);
    };
  }, [editor]);

  const getSnapshot = useMemo(() => {
    return () => {
      if (typeof getPos !== 'function') return false;
      const pos = getPos();
      const pluginState = LivePreviewPluginKey.getState(editor.state);
      return pluginState?.activeNodePositions.has(pos) ?? false;
    };
  }, [editor, getPos]);

  const isEditing = useSyncExternalStore(subscribe, getSnapshot);

  const focusNode = () => {
    if (!isEditing && typeof getPos === 'function') {
      const pos = getPos();
      editor.commands.setTextSelection(pos + 1);
    }
  };

  return { isEditing, focusNode };
}
```

### 2.4.3 L1 原生文本块的源码显示

L1 类型节点（标题、引用、列表等）不需要围栏标记，它们的 Markdown 语法前缀（`## `、`> `、`- `）通过 **Decoration** 注入：

```typescript
// 标题示例：光标进入时显示 "## " 前缀
// 实现方式：在 LivePreviewPlugin 中为 activeNodes 集合中的 heading 节点
// 添加一个 Widget Decoration

const headingPrefix = Decoration.widget(pos + 1, () => {
  const span = document.createElement('span');
  span.className = 'md-heading-prefix';
  span.textContent = '#'.repeat(node.attrs.level) + ' ';
  return span;
}, { side: -1, key: `heading-${pos}` });
```

这样标题节点**不需要自定义 NodeView**（使用 Tiptap 默认的 `<h1>` ~ `<h6>` 渲染），仅通过 Decoration 在编辑时注入前缀标记。

### 2.4.4 L2 围栏块的新架构

**核心变化**: 围栏标记不再使用独立的 `contentEditable` div，而是通过 `NodeView` 的 `contentDOM` 之外的 **React 受控组件** 来渲染，修改通过 `updateAttributes()` 提交到 ProseMirror 事务中。

```tsx
// views/_shared/FenceMarker.tsx

interface FenceMarkerProps {
  text: string;               // 显示文本，如 "```javascript"
  onTextChange?: (newText: string) => void;  // 文本变更回调
  position: 'top' | 'bottom';
}

/**
 * 围栏标记组件。
 *
 * 不使用 contentEditable — 而是使用普通的 <input> 或 <span>。
 * 修改围栏文本时，通过 onTextChange 回调触发 updateAttributes()，
 * 从而将变更写入 ProseMirror 事务，参与 Undo/Redo。
 */
export const FenceMarker: React.FC<FenceMarkerProps> = ({
  text,
  onTextChange,
  position,
}) => {
  if (!onTextChange) {
    // 只读模式（如围栏结束标记 "```"）
    return (
      <div className={`fence-marker fence-marker--${position}`}>
        <span className="fence-marker__text">{text}</span>
      </div>
    );
  }

  // 可编辑模式（如围栏开始标记 "```javascript"）
  return (
    <div className={`fence-marker fence-marker--${position}`}>
      <input
        className="fence-marker__input"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // 将焦点移入代码内容区域
          }
        }}
        spellCheck={false}
      />
    </div>
  );
};
```

---

## 2.5 CSS 设计系统重建

### 2.5.1 设计令牌 (Design Tokens)

```css
/* styles/tokens.css */

:root {
  /* === 语义色 (Semantic Colors) === */

  /* 背景 */
  --bg-primary:    #ffffff;
  --bg-secondary:  #f7f6f3;         /* Notion 标志性的暖灰 */
  --bg-tertiary:   #f0efeb;
  --bg-hover:      rgba(55, 53, 47, 0.04);  /* Notion 悬浮态 */
  --bg-active:     rgba(55, 53, 47, 0.08);

  /* 文字 */
  --text-primary:   #37352f;         /* Notion 的深棕黑 */
  --text-secondary: #787774;
  --text-tertiary:  #b4b0a8;
  --text-link:      #2383e2;
  --text-code:      #eb5757;

  /* 边框 */
  --border-light:   rgba(55, 53, 47, 0.09);
  --border-medium:  rgba(55, 53, 47, 0.16);

  /* 重点色 */
  --accent-blue:    #2383e2;
  --accent-red:     #eb5757;
  --accent-green:   #4dab5c;
  --accent-orange:  #d9730d;
  --accent-purple:  #9065b0;
  --accent-yellow:  #dfab01;

  /* === Notion 属性颜色体系 (10 色) === */
  --color-default:     #37352f;
  --color-gray:        #787774;
  --color-brown:       #9f6b53;
  --color-orange:      #d9730d;
  --color-yellow:      #cb912f;
  --color-green:       #448361;
  --color-blue:        #337ea9;
  --color-purple:      #9065b0;
  --color-pink:        #c14c8a;
  --color-red:         #d44c47;

  --bg-color-default:  transparent;
  --bg-color-gray:     #f1f1ef;
  --bg-color-brown:    #f4eeee;
  --bg-color-orange:   #fbecdd;
  --bg-color-yellow:   #faf3dd;
  --bg-color-green:    #edf3ec;
  --bg-color-blue:     #e7f3f8;
  --bg-color-purple:   #f6f3f8;
  --bg-color-pink:     #faf1f5;
  --bg-color-red:      #fdebec;

  /* === 间距 === */
  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-6: 12px;
  --space-8: 16px;
  --space-10: 20px;
  --space-12: 24px;
  --space-16: 32px;

  /* === 圆角 === */
  --radius-xs: 3px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;

  /* === 字体 === */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica,
               "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji";
  --font-serif: Lyon-Text, Georgia, ui-serif, serif;
  --font-mono: iaWriterMonoS-Regular, SFMono-Regular, Menlo, Consolas,
               "PT Mono", "Liberation Mono", Courier, monospace;

  /* === 字号 === */
  --text-xs: 12px;
  --text-sm: 14px;
  --text-base: 16px;
  --text-lg: 18px;
  --text-xl: 20px;
  --text-2xl: 24px;
  --text-3xl: 30px;
  --text-4xl: 36px;

  /* === 阴影 === */
  --shadow-sm:   rgba(15, 15, 15, 0.04) 0px 0px 0px 1px,
                 rgba(15, 15, 15, 0.03) 0px 2px 4px;
  --shadow-md:   rgba(15, 15, 15, 0.04) 0px 0px 0px 1px,
                 rgba(15, 15, 15, 0.03) 0px 3px 6px,
                 rgba(15, 15, 15, 0.04) 0px 9px 24px;
  --shadow-lg:   rgba(15, 15, 15, 0.05) 0px 0px 0px 1px,
                 rgba(15, 15, 15, 0.1) 0px 5px 10px,
                 rgba(15, 15, 15, 0.2) 0px 15px 40px;

  /* === 动画 === */
  --transition-fast:  80ms ease-out;
  --transition-normal: 150ms ease-out;
  --transition-slow:  250ms ease-out;
}
```

### 2.5.2 Callout 样式示例

```css
/* styles/blocks/callout.css */

.callout-block {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-8) var(--space-8) var(--space-6);
  border-radius: var(--radius-xs);
  margin: var(--space-2) 0;
  position: relative;
}

.callout-block--note    { background: var(--bg-color-blue); }
.callout-block--tip     { background: var(--bg-color-green); }
.callout-block--warning { background: var(--bg-color-yellow); }
.callout-block--caution { background: var(--bg-color-red); }
.callout-block--important { background: var(--bg-color-purple); }

.callout-block__icon {
  font-size: 1.3em;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  padding: var(--space-1);
  border-radius: var(--radius-xs);
  transition: background var(--transition-fast);
}

.callout-block__icon:hover {
  background: var(--bg-hover);
}

.callout-block__content {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  line-height: 1.6;
  color: var(--text-primary);
}

/* 编辑模式：显示 > [!TYPE] 源码 */
.callout-block.is-editing {
  background: var(--bg-primary);
  border-left: 3px solid var(--color-blue);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
```

---

## 2.6 表格区块高级交互设计

用户截图中 Notion 表格的功能需求：

### 2.6.1 右键上下文菜单

```
┌─────────────────────────┐
│ ✂️  剪切                 │
│ 📋 复制                 │
│ 📌 粘贴                 │
├─────────────────────────┤
│ ✨ 文本格式         ▸   │  → B 加粗 / I 倾斜 / S 删除线 / 高亮 / </> 代码 / Σ 数学 / % 注释
├─────────────────────────┤
│ ≡  左对齐               │
│ ≡  居中对齐             │
│ ≡  右对齐               │
├─────────────────────────┤
│ ◎  颜色             ▸   │  → 文本颜色 (10色) + 背景颜色 (10色)
├─────────────────────────┤
│ ←  在左侧插入           │
│ →  在右侧插入           │
├─────────────────────────┤
│ 📋 创建副本   Ctrl+D    │
│ ⊘  清除内容             │
│ 🗑  删除                │
└─────────────────────────┘
```

### 2.6.2 列类型图标体系

| 类型 | 图标 | 颜色 |
|------|------|------|
| 文本 (Title/Text) | Aa | --text-secondary |
| 数字 (Number) | # | --color-blue |
| 单选 (Select) | ▾ | --color-gray |
| 多选 (Multi-select) | ≋ | --color-purple |
| 状态 (Status) | ● | --color-green |
| 日期 (Date) | 📅 | --color-orange |
| 人员 (Person) | 👤 | --color-gray |
| 文件 (File) | 📎 | --color-gray |
| 复选 (Checkbox) | ☑ | --color-blue |
| URL | 🔗 | --color-blue |
| 公式 (Formula) | ∑ | --color-purple |

---

## 2.7 行内元素体系设计

### 2.7.1 Mention 提及系统

```typescript
// core/schema/nodes/inline/MentionNode.ts

export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,  // 不可编辑内部内容
  selectable: true,

  addAttributes() {
    return {
      type: { default: 'page' },      // 'person' | 'page' | 'database'
      id:   { default: '' },
      label:{ default: '' },
      icon: { default: '' },
    };
  },
});
```

**交互**: 输入 `@` 触发 Mention 搜索弹窗（类似 Slash Menu），搜索人员/页面/数据库。选中后插入一个 `mention` 行内节点。

### 2.7.2 日期/提醒

```typescript
// core/schema/nodes/inline/DateNode.ts

export const DateNode = Node.create({
  name: 'inlineDate',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      date: { default: '' },           // ISO date string
      endDate: { default: null },       // 日期范围的结束日期
      includeTime: { default: false },
      reminder: { default: null },      // 提醒配置
      format: { default: 'relative' },  // 'relative' | 'full' | 'short'
    };
  },
});
```

**交互**: 输入 `@日期` 或 `/date` 触发日期选择器弹窗。

### 2.7.3 表情符号

通过 Emoji Picker 弹窗插入，存储为 Unicode 字符（不是图片）。输入 `:` 触发搜索。

---

# 第三部分：分阶段实施路线图

## Phase 0: 基础设施搭建（预计 2 轮）

### 目标
搭建新的项目骨架，确保编辑器能正常启动并渲染基础文本。

### 任务清单
- [ ] 创建 `styles/tokens.css` 设计令牌
- [ ] 创建 `styles/reset.css` + `styles/typography.css`
- [ ] 创建 `styles/prosemirror.css` 基础样式（修复 `strong` 白色、`code` 浅灰色等问题）
- [ ] 创建 `core/schema/` 目录结构
- [ ] 创建 `core/plugins/LivePreviewPlugin.ts` 核心插件
- [ ] 创建 `hooks/useBlockEditing.ts` 新版 Hook
- [ ] 创建 `views/_shared/FenceMarker.tsx` 统一围栏标记组件
- [ ] 重构 `shell/Editor.tsx` 替代 `TiptapEditor.tsx + ComposerShell.tsx`
- [ ] 清理所有重复的 Extension（CalloutExtension × 2、TagExtension × 2）
- [ ] 修复所有 `import type` 问题

### 验收标准
- `npm run typecheck` 零错误
- `npm run dev` 启动后页面正常渲染
- 基础文本（段落、加粗、斜体、列表）可以正常编辑

---

## Phase 1: L1 原生文本块 Live Preview（预计 3 轮）

### 目标
所有 L1 块（标题、引用、分割线、任务列表、折叠列表）支持光标进入时显示 Markdown 前缀标记。

### 任务清单
- [ ] 实现 HeadingNode（光标进入时显示 `##` 前缀 Decoration）
- [ ] 实现 BlockquoteNode（光标进入时显示 `>` 前缀 Decoration）
- [ ] 实现 HorizontalRuleNode（光标进入时显示 `---` Decoration）
- [ ] 实现 TaskItemView（光标进入时显示 `- [ ]` / `- [x]`）
- [ ] 实现 ToggleListNode + ToggleListView（折叠列表）
- [ ] 实现行内 Mark 的 Live Preview（`**` `_` `~~` `==` `` ` `` `<u>` `[[` `#`）
- [ ] 确保全选 (Ctrl+A) 时所有节点同时进入编辑模式

### 验收标准
- 光标点击标题时，左侧出现 `## ` 灰色前缀
- 光标离开标题时，前缀消失，显示渲染后的标题
- Ctrl+A 全选时，所有标题/引用/列表同时显示前缀

---

## Phase 2: L2 围栏块重写（预计 3 轮）

### 目标
所有 L2 围栏块使用新的 FenceMarker 组件和 useBlockEditing Hook。

### 任务清单
- [ ] 重写 CodeBlockView（使用 FenceMarker + CSS class）
  - [ ] 语法高亮（集成 Shiki 或 Prism）
  - [ ] 行号显示
  - [ ] 语言选择器（使用 DropdownMenu 组件）
  - [ ] 复制按钮
- [ ] 重写 MermaidView（集成真实 mermaid.js 渲染）
- [ ] 重写 DiffView（Diff 解析器抽到 utils）
- [ ] 重写 MathBlockView（拆分：编辑器 + 符号面板 + 预览）
- [ ] 重写 CalloutView（统一单一 Extension）
- [ ] 新增 ChartView（集成 ECharts）

### 验收标准
- 围栏标记的修改参与 Undo/Redo
- 修改代码块语言后，Markdown 导出正确反映
- KaTeXBlockView 拆分后 ≤ 400 行

---

## Phase 3: L3 交互面板块 — 媒体类（预计 3 轮）

### 目标
实现所有媒体区块的上传/嵌入/预览功能。

### 任务清单
- [ ] ImageView：拖拽上传、粘贴截图、URL 嵌入、标题/描述、点击放大
- [ ] VideoView：URL 嵌入（YouTube/B站/MP4）、播放器 UI
- [ ] AudioView：音频播放器 UI、波形可视化
- [ ] FileView：文件图标 + 名称 + 大小 + 下载按钮
- [ ] BookmarkView：URL 预览卡片（标题 + 描述 + 缩略图）
- [ ] EmbedView：iframe 嵌入（HTML/PDF/Web）

---

## Phase 4: L3 交互面板块 — 数据库（预计 5 轮）

### 目标
实现完整的 Notion 式数据库系统。

### 任务清单

#### 4.1 核心框架
- [ ] DatabaseNode Extension（数据存储在 attrs.data）
- [ ] DatabaseView 壳组件（视图切换 + 工具栏）
- [ ] DatabaseToolbar（筛选/排序/搜索/分组/新建按钮）
- [ ] Property 系统（所有 18 种列类型的 CellRenderer）

#### 4.2 视图实现
- [ ] TableView（表格视图：列拖拽排序、列宽调整、行拖拽排序）
- [ ] KanbanView（看板视图：拖拽卡片、分组）
- [ ] GalleryView（画廊视图：封面图 + 属性预览）
- [ ] ListViewPanel（列表视图：紧凑行 + 属性标签）
- [ ] CalendarView（日历视图：按日期分布卡片）
- [ ] TimelineView（时间轴视图：甘特图样式）
- [ ] ChartViewPanel（图表视图：柱形/折线/环形图）
- [ ] FormView（表单视图：收集数据的表单 UI）

#### 4.3 高级功能
- [ ] 右键上下文菜单
- [ ] 单元格内文本格式化（加粗/斜体/代码/颜色）
- [ ] 文本颜色 + 背景颜色（10 色体系）
- [ ] 属性配置面板（修改列名、类型、选项颜色）
- [ ] 关联属性（Relation + Rollup）
- [ ] 公式属性
- [ ] 筛选/排序/分组的持久化

---

## Phase 5: 布局与高级区块（预计 3 轮）

### 任务清单
- [ ] ColumnLayoutNode + View（2/3/4/5 列布局，每列是独立的 ProseMirror 编辑区域）
- [ ] TabsNode + View（选项卡，每个 Tab 是独立的 ProseMirror 编辑区域）
- [ ] ToggleHeadingNode + View（折叠标题 H1/H2/H3）
- [ ] TableOfContentsView（从文档中提取标题树渲染为目录）
- [ ] ButtonNode + View（可配置动作的按钮块）
- [ ] SubPageNode + View（子页面链接卡片）
- [ ] BreadcrumbNode + View（路径栏）
- [ ] SyncedBlockNode + View（同步区块：跨页面同步内容）

---

## Phase 6: 行内元素与嵌入（预计 2 轮）

### 任务清单
- [ ] MentionNode + View（@人员、@页面、@数据库）
- [ ] DateNode + View（日期选择器 + 提醒）
- [ ] EmojiNode + Emoji Picker
- [ ] MathInlineView（行内公式，使用独立组件，不复用 Block 组件）
- [ ] PDF 嵌入
- [ ] Word/Excel 嵌入（使用 iframe 或 Office Web Viewer）

---

## Phase 7: 菜单系统与编辑体验（预计 2 轮）

### 任务清单
- [ ] 重写 SlashMenu（统一为单一实现，消除重复）
  - 完整分类：基础区块 / 媒体 / 数据库 / 高级区块 / 行内 / 嵌入 / AI
- [ ] 重写 BubbleMenu（增加块类型转换、对齐方式）
- [ ] BlockMenu（块级右键菜单：删除、复制、转换类型、颜色、移动）
- [ ] TableContextMenu（表格专用右键菜单）
- [ ] CommandPalette 重写
- [ ] 快捷键系统完善

---

## Phase 8: AI 功能集成（预计 2 轮）

### 任务清单
- [ ] AI Continue Writing（光标后续写）
- [ ] AI Block（AI 生成内容的专用块，带状态指示）
- [ ] AI Quick Note（AI 速记块）
- [ ] AI Sidebar Chat（基于文档上下文的问答）

---

# 第四部分：技术红线与质量门禁

## 4.1 代码规模约束

| 文件类型 | 最大行数 | 说明 |
|---------|---------|------|
| Extension (Schema) | 150 行 | 仅含 Schema 定义、属性、快捷键 |
| NodeView (组件) | 400 行 | 超过则必须拆分子组件 |
| CSS (样式文件) | 300 行 | 超过则按功能拆分 |
| 类型定义 | 600 行 | 允许较长 |
| 工具函数 | 200 行 | 超过则按功能拆分 |

## 4.2 样式规范

1. **零内联样式**: 所有样式通过 CSS class 管理，`style={{...}}` 仅允许用于动态计算值（如宽度百分比）
2. **BEM 命名**: 使用 `block__element--modifier` 命名法
3. **CSS 变量优先**: 所有颜色、间距、圆角值必须使用 `tokens.css` 中的变量
4. **禁止硬编码颜色**: 任何 `#e2e8f0` 之类的直接颜色值都必须替换为语义变量

## 4.3 导入规范

1. 所有类型导入必须使用 `import type { ... }` 语法
2. 禁止跨层级直接导入（如 `views/` 不能直接导入 `core/plugins/` 的内部实现）
3. 每个目录的 `index.ts` 是唯一的公开接口

## 4.4 测试要求

1. 每个 Extension 必须有对应的 Schema 测试（验证解析 HTML → 节点属性 → 序列化 Markdown 的往返正确性）
2. 每个 NodeView 必须有对应的渲染测试（验证编辑/渲染模式切换）
3. `npm run typecheck` 零错误
4. `npm run dev` 启动后零控制台错误

---

# 第五部分：关键设计决策总结

| # | 决策 | 理由 |
|---|------|------|
| D1 | 完全重写，不保留现有代码 | 现有架构存在 Extension 重复、围栏标记脱离文档树、数据库状态在 React useState 中等根本性问题，补丁修复只会增加复杂度 |
| D2 | 区块分 3 层（L1/L2/L3） | 不同类型的区块有本质不同的编辑行为，统一处理会导致过度抽象 |
| D3 | Live Preview 由 ProseMirror Plugin 统一管理 | 避免每个 NodeView 独立监听 selectionUpdate 的性能开销和一致性问题 |
| D4 | 围栏标记通过 React 受控组件实现 | 确保修改参与 Undo/Redo，避免多个 contentEditable 区域焦点争抢 |
| D5 | 数据库数据存储在节点 attrs 中 | 确保数据库操作参与 Undo/Redo，支持 Markdown 序列化/反序列化 |
| D6 | 使用 `:::directive` 语法作为高级区块的 Markdown 扩展 | 兼容标准 Markdown 解析器（会被当作普通文本），同时提供足够的语义信息 |
| D7 | CSS 使用 Notion 暖灰色体系 (`#37352f`) 替代当前的冷灰 (`#0f172a`) | 用户明确要求 Notion 风格 |
| D8 | 使用 `useSyncExternalStore` 替代 `useState + useEffect` 订阅 | React 18 并发安全，避免 tearing 问题 |
| D9 | 表格不显示源码，但支持完整的右键菜单和文本格式化 | 用户明确要求"表格倒是不用显示源码，毕竟表格还需要进阶操作，就像excel那样" |
| D10 | 禁止 Tailwind CSS | 用户规则明确禁止，使用 Vanilla CSS + CSS 变量 |

---

> [!IMPORTANT]
> **请审阅以上方案**。如果你同意总体方向，我将开始按 Phase 0 → Phase 1 的顺序执行。如果有任何需要调整的地方（比如优先级、区块清单、交互设计），请在这里提出。
