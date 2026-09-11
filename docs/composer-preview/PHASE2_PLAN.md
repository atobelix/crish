# Conex Composer — Phase 2 完整落地方案

> **版本**: 2.0
> **日期**: 2026-08-05
> **状态**: 待执行
> **前置文档**: 本文档接续 Phase 0 + Phase 1 已完成的基础设施与核心组件

---

## 第一部分：现状审计

### 1.1 代码量统计

| 维度 | 文件数 | 总行数 | 逻辑行（无注释/空行） |
|:-----|:------:|:------:|:--------------------:|
| TS/TSX 源码 | 42 | 3,995 | 3,417 |
| CSS 样式 | 15 | 4,366 | 3,949 |
| **合计** | **57** | **8,361** | **7,366** |

**目标**: 纯组件逻辑代码 ≥ 8,000 行（不含注释/空行），CSS ≥ 10,000 行。当前差距约 4,600 行 TS/TSX 逻辑代码 + 6,000 行 CSS。

### 1.2 已完成清单

#### 基础设施层（Phase 0）

| 模块 | 文件 | 状态 |
|:-----|:-----|:----:|
| 设计令牌 | `styles/tokens.css` (203 行) | ✅ |
| CSS Reset | `styles/reset.css` (91 行) | ✅ |
| 排版系统 | `styles/typography.css` (135 行) | ✅ |
| ProseMirror 基础 | `styles/prosemirror.css` (459 行) | ✅ |
| 微动效 | `styles/animations.css` (321 行) | ✅ |
| UI 组件样式 | `styles/ui/index.css` (314 行) | ✅ |
| Shell 布局 | `styles/shell.css` (71 行) | ✅ |
| 区块样式 · 代码块 | `styles/blocks/code-block.css` (187 行) | ✅ |
| 区块样式 · 围栏块 | `styles/blocks/fenced.css` (240 行) | ✅ |
| 区块样式 · 数据库 | `styles/blocks/database.css` (758 行) | ✅ |
| 区块样式 · 媒体/布局 | `styles/blocks/media-layout.css` (642 行) | ✅ |
| 区块样式 · 表单 | `styles/blocks/form.css` (364 行) | ✅ |
| 菜单样式 | `styles/menus/index.css` (575 行) | ✅ |
| 统一入口 | `styles/index.css` | ✅ |

#### 核心层

| 模块 | 文件 | 行数 | 状态 |
|:-----|:-----|:----:|:----:|
| 块类型定义 | `core/types/blocks.ts` | 239 | ✅ |
| 数据库类型 | `core/types/database.ts` | 401 | ✅ |
| 编辑器类型 | `core/types/editor.ts` | 146 | ✅ |
| LivePreview 插件 | `core/plugins/LivePreviewPlugin.ts` | 98 | ✅ |
| InlineDecoration 插件 | `core/plugins/InlineDecorationPlugin.ts` | 164 | ✅ |
| useBlockEditing Hook | `hooks/useBlockEditing.ts` | 79 | ✅ |

#### 菜单组件

| 组件 | 文件 | 行数 | 状态 |
|:-----|:-----|:----:|:----:|
| BubbleMenu | `menus/BubbleMenu.tsx` | 160 | ✅ |
| SlashMenu | `menus/SlashMenu.tsx` | 280 | ✅（未集成到 Editor） |
| BlockMenu | `menus/BlockMenu.tsx` | 223 | ✅（未集成到 Editor） |

#### UI 组件库

| 组件 | 文件 | 行数 | 状态 |
|:-----|:-----|:----:|:----:|
| Tooltip | `ui/Tooltip.tsx` | 36 | ✅ |
| Popover | `ui/Popover.tsx` | 43 | ✅ |
| Button | `ui/Button.tsx` | 30 | ✅ |
| DropdownMenu | `ui/DropdownMenu.tsx` | 92 | ✅ |
| ContextMenu | `ui/ContextMenu.tsx` | 130 | ✅ |

#### 共享视图组件

| 组件 | 文件 | 行数 | 状态 |
|:-----|:-----|:----:|:----:|
| FenceMarker | `views/_shared/FenceMarker.tsx` | 100 | ✅ |
| BlockToolbar | `views/_shared/BlockToolbar.tsx` | 42 | ✅ |
| EmptyState | `views/_shared/EmptyState.tsx` | 47 | ✅ |

#### NodeView 组件

| 组件 | 文件 | 行数 | 状态 |
|:-----|:-----|:----:|:----:|
| CodeBlockView | `views/fenced/CodeBlockView.tsx` | 150 | ✅ |
| CalloutView | `views/fenced/CalloutView.tsx` | 84 | ✅ |
| DiffView | `views/fenced/DiffView.tsx` | 83 | ✅ |
| ImageBlockView | `views/panel/ImageBlockView.tsx` | 167 | ✅ |
| BookmarkBlockView | `views/panel/BookmarkBlockView.tsx` | 86 | ✅ |
| FileBlockView | `views/panel/FileBlockView.tsx` | 89 | ✅ |
| DatabaseView | `views/panel/database/DatabaseView.tsx` | 200 | ✅ |
| TableView | `views/panel/database/TableView.tsx` | 292 | ✅ |

#### 编辑器 Shell

| 组件 | 文件 | 行数 | 状态 |
|:-----|:-----|:----:|:----:|
| Editor | `shell/Editor.tsx` | 175 | ✅ |
| main.tsx | `main.tsx` | 15 | ✅ |

### 1.3 未完成 / 待创建清单

以下按**优先级从高到低**排列：

#### P0 — 核心体验（必须完成）

| # | 组件 | 预估行数 | 说明 |
|:-:|:-----|:-------:|:-----|
| 1 | SlashMenu 集成 | 80 | 将 SlashMenu 通过 Tiptap Suggestion API 接入 Editor |
| 2 | BlockMenu 集成 | 50 | 将 BlockMenu 连接到块级右键/拖拽手柄事件 |
| 3 | MathBlockView | 180 | Notion 风格：渲染用 KaTeX，点击弹出公式编辑弹窗 |
| 4 | MathInlineNode | 120 | 行内公式：`$...$` 渲染为 KaTeX，点击弹出编辑 |
| 5 | ToggleHeadingView | 120 | 折叠标题（H1/H2/H3 + 展开/收起箭头动画） |
| 6 | ToggleListView | 80 | 折叠列表项 |
| 7 | ColumnLayoutView | 200 | 2~5 列布局，拖拽调整列宽 |
| 8 | TOCBlockView | 120 | 目录块（自动提取文档标题层级） |
| 9 | DragHandle 插件 | 150 | 块级拖拽排序（拖拽手柄 + 放置指示线） |
| 10 | 链接交互增强 | 100 | 点击导航 / Ctrl+Hover 预览 / 选中显示语法 |

#### P1 — 多媒体 & 嵌入

| # | 组件 | 预估行数 | 说明 |
|:-:|:-----|:-------:|:-----|
| 11 | VideoBlockView | 150 | YouTube/Bilibili/MP4 嵌入播放器 |
| 12 | AudioBlockView | 100 | 自定义音频播放器 UI |
| 13 | EmbedBlockView | 120 | iframe 嵌入（URL → 预览卡片 / 全宽 iframe） |

#### P2 — 数据库高级视图

| # | 组件 | 预估行数 | 说明 |
|:-:|:-----|:-------:|:-----|
| 14 | KanbanView | 280 | 看板视图（列 = select 属性，卡片拖拽） |
| 15 | GalleryView | 180 | 画廊视图（卡片网格 + 封面图 + 属性预览） |
| 16 | CalendarView | 250 | 日历视图（月视图 + 日期属性映射 + 事件卡片） |
| 17 | ListView | 100 | 列表视图（紧凑单行显示） |
| 18 | FormView | 200 | 表单视图（属性 → 表单字段，提交 → 新行） |
| 19 | RecordDetailPanel | 200 | 行详情面板（侧滑打开，编辑所有属性） |
| 20 | PropertyEditor | 150 | 属性配置面板（类型/名称/选项管理） |

#### P3 — 高级区块

| # | 组件 | 预估行数 | 说明 |
|:-:|:-----|:-------:|:-----|
| 21 | TabsBlockView | 130 | 选项卡（添加/删除/重命名 Tab） |
| 22 | ButtonBlockView | 80 | 按钮块（打开链接/复制文本/运行命令） |
| 23 | SyncedBlockView | 100 | 同步区块（蓝色虚线边框 + 源引用） |
| 24 | SubPageView | 80 | 子页面链接（图标 + 标题 + Hover 预览） |
| 25 | BreadcrumbView | 60 | 路径栏（层级面包屑导航） |
| 26 | AIBlockView | 150 | AI 生成块（Prompt 输入 + 流式输出 + 操作按钮） |
| 27 | MermaidBlockView | 120 | Mermaid 图表（渲染 SVG + 编辑切换） |
| 28 | ChartBlockView | 150 | ECharts 图表（可视化配置 + 数据输入） |

#### P4 — 行内节点

| # | 组件 | 预估行数 | 说明 |
|:-:|:-----|:-------:|:-----|
| 29 | MentionNode | 80 | @提及（人员/页面/数据库） |
| 30 | DateInlineNode | 100 | 日期/提醒（日历选择器弹窗） |
| 31 | EmojiNode | 60 | Emoji 选择器 |
| 32 | InlineMathNode | 80 | 已含在 #4 |

#### P5 — Tiptap Extension 注册

| # | Extension | 说明 |
|:-:|:----------|:-----|
| 33 | CalloutExtension | 注册 callout 节点类型到 Tiptap schema |
| 34 | MathExtension | 注册 mathBlock + mathInline 节点 |
| 35 | DatabaseExtension | 注册 databaseBlock 节点 |
| 36 | ImageExtension | 注册 imageBlock 节点 |
| 37 | VideoExtension | 注册 videoBlock 节点 |
| 38 | ColumnLayoutExtension | 注册 columnLayout + column 节点 |
| 39 | ToggleExtension | 注册 toggleHeading + toggleList 节点 |
| 40 | TabsExtension | 注册 tabsBlock + tabPanel 节点 |
| 41 | DragHandleExtension | 拖拽手柄扩展 |
| 42 | SlashCommandExtension | Suggestion API 桥接 |

#### P6 — 主题 & 打磨

| # | 任务 | 说明 |
|:-:|:-----|:-----|
| 43 | 暗色主题 | `tokens-dark.css` + `.dark` class 切换 |
| 44 | 主题切换 UI | Header 中加入 ☀️/🌙 切换按钮 |
| 45 | 响应式优化 | 移动端菜单/布局自适应 |
| 46 | 无障碍 | ARIA roles/labels、键盘导航完善 |

### 1.4 预估代码增量

| 类别 | 新增行数（含注释） | 新增逻辑行 |
|:-----|:-----------------:|:---------:|
| TSX/TS 组件 + Extension + 插件 | ~6,000 | ~4,600 |
| CSS 新增样式 | ~5,000 | ~4,500 |
| **Phase 2 完成后总计** | **~19,000** | **~16,000** |

---

## 第二部分：设计哲学 — Notion 易用性 × Obsidian 键盘效率

### 2.1 交互模式分类

本编辑器的核心交互设计原则是"**分级呈现**"——根据用户的操作上下文，自动选择最合适的交互模式：

#### 模式 A：行内实时编辑（Obsidian 风格）

**适用场景**: 用户记得住、手指不离开键盘就能完成的常用行内格式化。

**行为**: 光标进入 mark/node 时，语法标记以灰色等宽字体淡入显示；光标离开后，标记消失，只显示渲染效果。

**适用的 Mark / Node**:

| 语法 | 光标在内时的显示 | 光标离开后的显示 |
|:-----|:----------------|:----------------|
| `**text**` | **`**`**text**`**`** | **text** |
| `*text*` | `*`*text*`*` | *text* |
| `~~text~~` | `~~`~~text~~`~~` | ~~text~~ |
| `` `code` `` | `` ` ``code`` ` `` | `code` |
| `==text==` | `==`text`==` | <mark>text</mark> |
| `<u>text</u>` | `<u>`text`</u>` | <u>text</u> |
| `## Heading` | `## ` Heading | **Heading**（渲染样式） |
| `[text](url)` | `[`text`](`url`)` | [text](链接样式) |
| `---` | `---` | ─────── |
| `- item` | `- ` item | • item |
| `1. item` | `1. ` item | 1. item |
| `> quote` | `> ` quote | │ quote |
| `- [ ] task` | `- [ ] ` task | ☐ task |

**已实现**: InlineDecorationPlugin 已处理 bold/italic/strike/code/highlight/underline + 标题前缀。

**待实现**: 链接 `[text](url)` 语法标记（模式 C 混合）、列表前缀（`- ` / `1. ` / `- [ ] `）、引用前缀（`> `）、分割线（`---`）。

#### 模式 B：Notion 可视化面板（零语法记忆负担）

**适用场景**: 复杂块类型，用户不可能/不愿意记忆原始 Markdown 语法。

**行为**: 以可视化面板呈现，提供图形化的编辑界面。用户通过 SlashMenu 插入，通过面板交互编辑。

**适用的区块**:

| 区块 | 交互方式 |
|:-----|:---------|
| **代码块** | 语言选择器下拉 + 复制按钮 + 行号（非 ``` 语法） |
| **公式块** | 点击弹出 LaTeX 编辑弹窗，渲染用 KaTeX |
| **Callout** | 图标 + 类型选择（点击图标循环切换），非 `> [!NOTE]` 语法 |
| **图片** | 拖拽上传面板 + 对齐/大小调整工具栏 |
| **视频/音频** | 嵌入播放器 + URL 输入面板 |
| **文件** | 附件卡片 + 上传面板 |
| **书签** | URL 输入 → OG 卡片预览 |
| **数据库** | 全可视化的表格/看板/画廊/日历视图 |
| **Mermaid** | 编辑 → SVG 渲染切换 |
| **ECharts** | 可视化图表配置面板 |
| **列布局** | 拖拽分隔线调整列宽 |
| **选项卡** | 点击 Tab 切换 + 右键管理 |
| **AI 块** | Prompt 输入框 + 流式输出展示 |

#### 模式 C：混合模式（默认可视化，选中时显示语法）

**适用场景**: 链接。

**行为**:
- **默认**: 蓝色文字 + 下划线（Notion 风格），点击直接跳转。
- **Ctrl+Hover**: 弹出链接预览悬浮卡片。
- **光标进入/选中**: 显示 `[text](url)` 语法标记，可直接编辑 URL。
- **独立链接块**（如图片链接、文件链接）: 使用可视化面板。

### 2.2 组件拆分原则

遵循项目 `AGENTS.md` 中的反过度设计红线：

1. **UI 组件 ≤ 500 行**，业务逻辑 ≤ 400 行，类型定义 ≤ 800 行。
2. **单文件单组件**: 每个 NodeView 一个文件，不允许上帝组件。
3. **关注点分离**:
   - `views/` — NodeView 组件（负责渲染 + 交互）
   - `core/plugins/` — ProseMirror 插件（负责状态管理 + 装饰）
   - `core/types/` — 类型定义（负责数据结构）
   - `hooks/` — React Hooks（负责状态订阅）
   - `ui/` — 通用 UI 组件（跨 NodeView 复用）
   - `menus/` — 菜单组件（SlashMenu / BubbleMenu / BlockMenu）
   - `styles/` — CSS 样式（按模块分文件）
4. **组件内 `useState` 数量 ≤ 12 个**: 超过时拆分为子组件或抽取 Hook。

---

## 第三部分：详细执行计划

### Step 1: Tiptap Extension 注册层（~800 行 TS）

**目的**: 将所有自定义区块注册到 Tiptap Schema，使 NodeView 能正确挂载。

#### 1.1 文件结构

```
src/extensions/
├── CalloutExtension.ts        (~80 行)
├── MathBlockExtension.ts      (~100 行)
├── MathInlineExtension.ts     (~80 行)
├── DatabaseExtension.ts       (~60 行)
├── ImageExtension.ts          (~70 行)
├── VideoExtension.ts          (~70 行)
├── AudioExtension.ts          (~50 行)
├── FileExtension.ts           (~50 行)
├── BookmarkExtension.ts       (~60 行)
├── EmbedExtension.ts          (~50 行)
├── ColumnLayoutExtension.ts   (~80 行)
├── ToggleHeadingExtension.ts  (~80 行)
├── ToggleListExtension.ts     (~60 行)
├── TabsExtension.ts           (~70 行)
├── TOCExtension.ts            (~50 行)
├── ButtonExtension.ts         (~40 行)
├── AIBlockExtension.ts        (~50 行)
├── MermaidExtension.ts        (~50 行)
├── ChartExtension.ts          (~50 行)
├── SyncedBlockExtension.ts    (~40 行)
├── SubPageExtension.ts        (~40 行)
├── BreadcrumbExtension.ts     (~30 行)
├── SlashCommandExtension.ts   (~100 行)  ← Tiptap Suggestion API 桥接
├── DragHandleExtension.ts     (~80 行)
└── index.ts                   (~30 行)
```

#### 1.2 Extension 模板

每个 Extension 遵循统一模式：

```typescript
import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { SomeView } from '../views/xxx/SomeView';

export const SomeExtension = Node.create({
  name: 'someBlock',
  group: 'block',
  content: 'inline*',        // 或 'block+' 或 '' 视情况
  atom: false,                // 或 true（不可编辑内部文本）
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      // ... 属性定义，对应 core/types/blocks.ts 中的接口
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="someBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-type': 'someBlock', ...HTMLAttributes }, 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SomeView);
  },
});
```

#### 1.3 SlashCommandExtension 特殊处理

使用 Tiptap 的 `@tiptap/suggestion` API：

```typescript
import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';

export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',
  addOptions() {
    return {
      suggestion: {
        char: '/',
        command: ({ editor, range, props }) => { /* 执行命令 */ },
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
```

SlashMenu 组件通过 `suggestion.render()` 回调挂载到 DOM。

#### 1.4 Editor.tsx 集成

更新 `shell/Editor.tsx` 的 `extensions` 数组，按顺序注册所有扩展：

```typescript
const extensions = [
  StarterKit.configure({ ... }),
  // 行内扩展
  TiptapUnderline, Highlight, TextStyle, Color,
  MathInlineExtension,
  // 块扩展
  CalloutExtension, MathBlockExtension, DatabaseExtension,
  ImageExtension, VideoExtension, AudioExtension,
  FileExtension, BookmarkExtension, EmbedExtension,
  ColumnLayoutExtension, ToggleHeadingExtension, ToggleListExtension,
  TabsExtension, TOCExtension, ButtonExtension,
  AIBlockExtension, MermaidExtension, ChartExtension,
  SyncedBlockExtension, SubPageExtension, BreadcrumbExtension,
  // 功能扩展
  SlashCommandExtension,
  DragHandleExtension,
  // 插件
  LivePreviewExtension,
  InlineDecorationExtension,
  // 工具
  CharacterCount, Markdown,
];
```

---

### Step 2: P0 核心体验组件（~1,100 行 TSX）

#### 2.1 MathBlockView — 公式块（~180 行）

**文件**: `src/views/panel/MathBlockView.tsx`

**交互设计**（参考 Notion 截图中的公式块）:
- **渲染模式**: 使用 KaTeX 渲染公式为高质量排版
- **编辑模式**: 点击公式 → 弹出居中弹窗，弹窗内为 LaTeX 源码编辑区 + 实时预览
- **空状态**: 显示 "点击输入公式" 占位文字

**组件结构**:

```
MathBlockView
├── MathRenderer        (渲染 KaTeX 输出)
├── MathEditorPopover   (LaTeX 输入 + 实时预览弹窗)
└── EmptyState          (空状态占位)
```

**技术选型**:
- KaTeX 渲染：动态 import `katex` 包，避免打包体积影响首屏
- 弹窗定位：使用已有的 Popover 组件
- 实时预览：debounce 300ms 后重新渲染

#### 2.2 MathInlineNode — 行内公式（~120 行）

**文件**: `src/views/inline/MathInlineView.tsx`

**交互设计**:
- 行内显示 KaTeX 渲染结果
- 点击弹出小型编辑弹窗（同 MathBlockView 但更紧凑）
- 输入 `$...$` 自动识别为行内公式

#### 2.3 ToggleHeadingView — 折叠标题（~120 行）

**文件**: `src/views/panel/ToggleHeadingView.tsx`

**交互设计**（参考 Notion 截图）:
- 标题左侧显示三角形箭头（▶ / ▼）
- 点击箭头或快捷键切换折叠/展开
- 折叠动画：`max-height` + `opacity` 过渡（CSS 已就绪在 `animations.css`）
- 标题层级：支持 H1/H2/H3

**组件结构**:

```
ToggleHeadingView
├── ToggleArrow           (旋转箭头图标)
├── 标题文本 (NodeViewContent)
└── ToggleContent         (可折叠内容区域)
```

#### 2.4 ToggleListView — 折叠列表（~80 行）

**文件**: `src/views/panel/ToggleListView.tsx`

类似 ToggleHeadingView，但用于普通列表项的折叠。

#### 2.5 ColumnLayoutView — 多列布局（~200 行）

**文件**: `src/views/panel/ColumnLayoutView.tsx`
**子组件**: `src/views/panel/ColumnView.tsx` (~60 行)

**交互设计**:
- 支持 2~5 列
- 列之间有可拖拽的分隔线调整宽度
- 每列内部是独立的 ProseMirror 编辑区域（嵌套 NodeView）
- 通过 SlashMenu 的 "2列" "3列" 等选项插入

**组件结构**:

```
ColumnLayoutView
├── Column × N            (每列是独立的 NodeViewContent)
└── ColumnResizeHandle × (N-1)  (可拖拽分隔线)
```

#### 2.6 TOCBlockView — 目录块（~120 行）

**文件**: `src/views/panel/TOCBlockView.tsx`

**交互设计**:
- 自动扫描文档中的 H1/H2/H3/H4 节点
- 渲染为带缩进的可点击链接列表
- 点击标题 → 平滑滚动到对应位置
- 实时更新（监听 EditorState 变化）

#### 2.7 DragHandle 插件（~150 行）

**文件**: `src/core/plugins/DragHandlePlugin.ts`

**交互设计**:
- 鼠标悬停在任何块的左侧 → 出现 ⠿ 拖拽手柄
- 按住拖拽 → 显示放置指示线（蓝色横线）
- 释放 → 移动块到新位置
- 手柄旁边还有 ＋ 按钮 → 点击打开 SlashMenu

#### 2.8 链接交互增强（~100 行）

**修改文件**: `src/core/plugins/InlineDecorationPlugin.ts` + `src/menus/BubbleMenu.tsx`

**增强内容**:
1. InlineDecorationPlugin 增加 link mark 的 `[` `](` `)` 语法标记
2. BubbleMenu 在选中链接时显示 URL 预览条 + 编辑/取消链接按钮
3. 点击链接的默认行为：`window.open(href, '_blank')`
4. Ctrl+Hover：显示链接目标预览 tooltip

---

### Step 3: P1 多媒体 & 嵌入组件（~370 行 TSX）

#### 3.1 VideoBlockView（~150 行）

**文件**: `src/views/panel/VideoBlockView.tsx`

**交互设计**:
- **空状态**: URL 输入框 + "嵌入视频" 按钮
- **YouTube/Bilibili**: 自动解析 URL → 嵌入 iframe 播放器
- **MP4**: 使用原生 `<video>` 标签 + 自定义控制栏
- **工具栏**: 对齐方式 + 宽度调整 + 删除

**URL 解析**:

```typescript
function parseVideoUrl(url: string): { provider: string; embedUrl: string } {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    // 提取 video ID → https://www.youtube.com/embed/VIDEO_ID
  }
  if (url.includes('bilibili.com')) {
    // 提取 BV 号 → https://player.bilibili.com/player.html?bvid=BV...
  }
  return { provider: 'mp4', embedUrl: url };
}
```

#### 3.2 AudioBlockView（~100 行）

**文件**: `src/views/panel/AudioBlockView.tsx`

**交互设计**:
- 自定义音频播放器 UI（播放/暂停按钮 + 进度条 + 时间显示 + 音量）
- 支持拖拽上传或 URL 输入
- 文件名 + 大小显示

#### 3.3 EmbedBlockView（~120 行）

**文件**: `src/views/panel/EmbedBlockView.tsx`

**交互设计**:
- **空状态**: URL 输入框
- **渲染**: 根据 URL 类型选择渲染方式：
  - 普通网页 → iframe（带安全沙箱属性）
  - PDF → `<embed>` 或 iframe
  - HTML → sandboxed iframe
- **尺寸**: 可拖拽调整高度

---

### Step 4: P2 数据库高级视图（~1,160 行 TSX）

#### 4.1 KanbanView — 看板视图（~280 行）

**文件**: `src/views/panel/database/KanbanView.tsx`
**子组件**: `src/views/panel/database/KanbanColumn.tsx` (~60 行)
**子组件**: `src/views/panel/database/KanbanCard.tsx` (~40 行)

**交互设计**（参考 Notion 看板）:
- 列 = 某个 select/status 属性的各选项值
- 卡片 = 数据库行，显示标题 + 预览属性
- 拖拽卡片在列间移动 = 更新对应属性值
- 列末尾 "+ 新建" 按钮
- 最右侧 "添加分组" 按钮

**组件结构**:

```
KanbanView
├── KanbanColumn × N
│   ├── 列头（属性值标签 + 计数 + 折叠按钮）
│   ├── KanbanCard × M
│   │   ├── 标题
│   │   └── 属性预览（标签、日期、人员等）
│   └── "+ 新建" 按钮
└── "+ 添加分组" 按钮
```

#### 4.2 GalleryView — 画廊视图（~180 行）

**文件**: `src/views/panel/database/GalleryView.tsx`
**子组件**: `src/views/panel/database/GalleryCard.tsx` (~50 行)

**交互设计**:
- 卡片网格布局（CSS Grid，响应式 auto-fill）
- 每张卡片：封面图（如有）+ 标题 + 预览属性
- 点击卡片 → 打开 RecordDetailPanel
- 悬浮效果：轻微上浮 + 阴影加深

#### 4.3 CalendarView — 日历视图（~250 行）

**文件**: `src/views/panel/database/CalendarView.tsx`
**子组件**: `src/views/panel/database/CalendarDay.tsx` (~50 行)
**子组件**: `src/views/panel/database/CalendarEvent.tsx` (~30 行)

**交互设计**:
- 月视图：7×5/6 格子
- 每个日期格显示该日的数据库行（彩色小卡片）
- 点击日期 → 快速创建新行
- 拖拽事件卡片 → 修改日期属性
- 顶部导航：< 上月 | 当前月份 | 下月 >

#### 4.4 ListView — 列表视图（~100 行）

**文件**: `src/views/panel/database/ListView.tsx`

**交互设计**:
- 紧凑的单行显示（标题 + 关键属性）
- 每行左侧有 checkbox
- 支持多选操作

#### 4.5 FormView — 表单视图（~200 行）

**文件**: `src/views/panel/database/FormView.tsx`
**子组件**: `src/views/panel/database/FormField.tsx` (~80 行)

**交互设计**:
- 属性 → 表单字段（文本框/下拉/日期选择器/文件上传等）
- 提交按钮 → 创建新数据库行
- 字段验证（必填/格式）
- 可配置字段显示/隐藏/排序

#### 4.6 RecordDetailPanel — 行详情面板（~200 行）

**文件**: `src/views/panel/database/RecordDetailPanel.tsx`

**交互设计**:
- 从右侧滑入的面板（overlay）
- 顶部：标题（可编辑）+ 图标
- 属性列表：每个属性一行，左侧属性名，右侧可编辑值
- 内容区域：富文本编辑器（可嵌套 Tiptap 实例）
- 底部：创建时间 / 最后编辑时间

#### 4.7 PropertyEditor — 属性编辑器（~150 行）

**文件**: `src/views/panel/database/PropertyEditor.tsx`

**交互设计**:
- 属性名称编辑
- 属性类型切换（下拉选择）
- Select/MultiSelect 选项管理（添加/删除/排序/颜色）
- 删除属性确认

---

### Step 5: P3 高级区块（~870 行 TSX）

#### 5.1 TabsBlockView（~130 行）

**文件**: `src/views/panel/TabsBlockView.tsx`

**交互设计**:
- Tab 栏：水平排列的标签按钮
- 点击 Tab → 切换内容面板
- 右键 Tab → 重命名/删除
- 最右侧 "+" 按钮添加新 Tab
- 每个 Tab 内容是独立的编辑区域

#### 5.2 ButtonBlockView（~80 行）

**文件**: `src/views/panel/ButtonBlockView.tsx`

**交互设计**:
- 可配置的按钮（文本 + 图标 + 链接/动作）
- 4 种样式变体（primary/secondary/outline/ghost）
- 点击设置面板：编辑标签、URL、动作类型

#### 5.3 SyncedBlockView（~100 行）

**文件**: `src/views/panel/SyncedBlockView.tsx`

**交互设计**:
- 蓝色虚线边框包裹
- 顶部显示 "同步区块" 标签 + 链接图标
- 编辑任一副本 → 所有副本同步更新
- 拆分同步关系按钮

#### 5.4 SubPageView（~80 行）

**文件**: `src/views/panel/SubPageView.tsx`

**交互设计**:
- 页面图标 + 标题（类似 Notion 的 📄 新页面）
- 点击 → 打开子页面
- Hover → 显示预览卡片

#### 5.5 BreadcrumbView（~60 行）

**文件**: `src/views/panel/BreadcrumbView.tsx`

**交互设计**:
- 自动生成的面包屑导航路径
- 每个层级可点击
- 当前页面名称不可点击

#### 5.6 AIBlockView（~150 行）

**文件**: `src/views/panel/AIBlockView.tsx`

**交互设计**:
- Prompt 输入框 + 发送按钮
- 流式输出区域（打字机效果）
- 操作按钮：接受/重试/编辑/删除
- 状态指示：idle → generating → done/error
- AI 图标 + 渐变紫色装饰

#### 5.7 MermaidBlockView（~120 行）

**文件**: `src/views/fenced/MermaidBlockView.tsx`

**交互设计**:
- **渲染模式**: SVG 图表输出
- **编辑模式**: 代码编辑区 + 实时预览（split view）
- 使用 mermaid.js 动态渲染
- 错误状态：显示解析错误信息

#### 5.8 ChartBlockView（~150 行）

**文件**: `src/views/panel/ChartBlockView.tsx`

**交互设计**:
- 图表类型选择器（柱状/折线/环形/饼图/散点）
- 数据编辑面板（表格式数据输入）
- 使用 ECharts 渲染
- 图表尺寸可拖拽调整

---

### Step 6: P4 行内节点（~320 行 TSX）

#### 6.1 MentionNode — @提及（~80 行）

**文件**: `src/views/inline/MentionView.tsx`

**交互设计**:
- 输入 `@` 触发搜索弹窗
- 搜索结果：人员/页面/数据库
- 选中后显示为蓝色药丸形标签
- Hover 显示预览卡片

#### 6.2 DateInlineNode — 日期（~100 行）

**文件**: `src/views/inline/DateInlineView.tsx`

**交互设计**:
- 显示格式化的日期文本
- 点击弹出日历选择器（使用 DatePicker 组件）
- 支持设置提醒

#### 6.3 EmojiNode — 表情（~60 行）

**文件**: `src/views/inline/EmojiView.tsx`

**交互设计**:
- 输入 `:` 触发 emoji 搜索弹窗
- Unicode emoji 渲染
- 搜索 + 分类浏览

#### 6.4 DatePicker UI 组件（~150 行）

**文件**: `src/ui/DatePicker.tsx`

**功能**:
- 月历视图
- 日期选择 + 时间选择（可选）
- 键盘导航
- 与 DateInlineView 和 CalendarView 共享

---

### Step 7: P5 CSS 样式补充（~5,000 行 CSS）

#### 7.1 新增样式文件

```
styles/blocks/
├── toggle.css           (~150 行) — 折叠标题/列表
├── column-layout.css    (~120 行) — 多列布局
├── tabs.css             (~130 行) — 选项卡
├── math.css             (~100 行) — 公式块 + 行内公式
├── video-audio.css      (~120 行) — 视频/音频播放器
├── embed.css            (~80 行)  — 嵌入块
├── ai-block.css         (~100 行) — AI 块
├── kanban.css           (~200 行) — 看板视图
├── gallery.css          (~120 行) — 画廊视图
├── calendar.css         (~200 行) — 日历视图
├── list-view.css        (~80 行)  — 列表视图
├── record-detail.css    (~150 行) — 行详情面板
├── property-editor.css  (~100 行) — 属性编辑器

styles/
├── tokens-dark.css      (~200 行) — 暗色主题变量
├── inline-nodes.css     (~100 行) — 行内节点（Mention/Date/Emoji）

styles/ui/
├── date-picker.css      (~150 行) — 日期选择器
├── emoji-picker.css     (~100 行) — Emoji 选择器
```

#### 7.2 现有样式更新

- `styles/blocks/index.css` — 添加所有新模块的 `@import`
- `styles/blocks/media-layout.css` — 补充 video/audio/embed 的具体样式细节
- `styles/blocks/database.css` — 补充 kanban/gallery/calendar 视图样式
- `styles/animations.css` — 补充折叠/Tab切换/卡片拖拽等新动画

---

### Step 8: 主题系统（~200 行 CSS + ~50 行 TSX）

#### 8.1 暗色主题

**文件**: `styles/tokens-dark.css`

```css
[data-theme="dark"] {
  --bg-primary: #191919;
  --bg-secondary: #202020;
  --bg-tertiary: #2f2f2f;
  --text-primary: #e6e6e4;
  --text-secondary: #999896;
  /* ... 完整的暗色变量覆盖 */
}
```

#### 8.2 主题切换

在 Editor header 添加切换按钮，使用 `document.documentElement.setAttribute('data-theme', 'dark')` 切换。

---

## 第四部分：执行顺序与依赖关系

### 4.1 执行阶段

```
阶段 A: Extension 注册层
  ├── Step 1.1: 创建 extensions/ 目录结构
  ├── Step 1.2: 实现所有 Extension（按依赖顺序）
  └── Step 1.3: 更新 Editor.tsx 注册扩展

阶段 B: P0 核心体验（依赖阶段 A）
  ├── Step 2.1: SlashMenu Suggestion 集成
  ├── Step 2.2: BlockMenu 右键集成
  ├── Step 2.3: MathBlockView + MathInlineView
  ├── Step 2.4: ToggleHeadingView + ToggleListView
  ├── Step 2.5: ColumnLayoutView
  ├── Step 2.6: TOCBlockView
  ├── Step 2.7: DragHandle 插件
  └── Step 2.8: 链接交互增强

阶段 C: P1 多媒体（依赖阶段 A）
  ├── Step 3.1: VideoBlockView
  ├── Step 3.2: AudioBlockView
  └── Step 3.3: EmbedBlockView

阶段 D: P2 数据库视图（依赖阶段 A）
  ├── Step 4.1: KanbanView
  ├── Step 4.2: GalleryView
  ├── Step 4.3: CalendarView
  ├── Step 4.4: ListView
  ├── Step 4.5: FormView
  ├── Step 4.6: RecordDetailPanel
  └── Step 4.7: PropertyEditor

阶段 E: P3 高级区块（依赖阶段 A）
  ├── Step 5.1~5.8: 各高级区块

阶段 F: P4 行内节点（依赖阶段 A + DatePicker UI）
  ├── Step 6.1~6.4: 行内节点 + DatePicker

阶段 G: CSS 补充 + 主题
  ├── Step 7: 新增 CSS 文件
  └── Step 8: 暗色主题

阶段 H: 集成测试 + 打磨
  ├── TypeScript 编译验证
  ├── 运行时 DevTools 验证
  └── 微动效调优
```

### 4.2 并行规则

- 阶段 B/C/D/E/F 内部的各 Step 之间**可并行**（无文件冲突）。
- 阶段 B/C/D/E/F 均依赖阶段 A（Extension 注册），必须先完成阶段 A。
- 阶段 G（CSS）可与 B~F 交叉进行。
- 阶段 H 在所有代码完成后执行。

### 4.3 优先执行路径（推荐）

```
A → B（核心体验） → C（多媒体） → D（数据库视图） → E（高级区块） → F（行内节点） → G（CSS） → H（集成）
```

---

## 第五部分：技术细节补充

### 5.1 KaTeX 集成方案

```bash
npm install katex
```

**动态加载**（避免阻塞首屏）:

```typescript
let katexPromise: Promise<typeof import('katex')> | null = null;

export function loadKaTeX() {
  if (!katexPromise) {
    katexPromise = import('katex');
  }
  return katexPromise;
}
```

**渲染器组件**:

```tsx
const MathRenderer: React.FC<{ formula: string; display: boolean }> = ({ formula, display }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadKaTeX().then(katex => {
      if (containerRef.current) {
        katex.render(formula, containerRef.current, {
          displayMode: display,
          throwOnError: false,
          errorColor: 'var(--accent-red)',
        });
      }
    });
  }, [formula, display]);

  return <div ref={containerRef} className="math-renderer" />;
};
```

### 5.2 Mermaid 集成方案

```bash
npm install mermaid
```

**异步渲染**:

```typescript
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
});

async function renderMermaid(code: string, container: HTMLElement) {
  const id = `mermaid-${Date.now()}`;
  const { svg } = await mermaid.render(id, code);
  container.innerHTML = svg;
}
```

### 5.3 ECharts 集成方案

```bash
npm install echarts
```

**懒加载 + resize 监听**:

```typescript
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);
```

### 5.4 拖拽排序方案

使用 ProseMirror 原生的 `draggable` + `handleDOMEvents`:

```typescript
// DragHandlePlugin.ts
const plugin = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const target = event.target as HTMLElement;
        if (!target.closest('.block-drag-handle')) return false;
        // 开始拖拽流程
        return true;
      },
    },
  },
});
```

拖拽指示线通过 `Decoration.widget` 在放置目标位置渲染蓝色横线。

### 5.5 列布局嵌套编辑

列布局中每列是独立的 ProseMirror 节点，包含 `block+` 内容。

Schema 定义:

```typescript
// columnLayout: group: 'block', content: 'column{2,5}'
// column: group: '', content: 'block+'
```

这允许每列内部放置任意块类型（段落、列表、代码块等）。

---

## 第六部分：验收标准

### 6.1 功能验收

- [ ] TypeScript 编译 0 错误（`npm run typecheck`）
- [ ] Vite 构建 0 错误（`npm run build`）
- [ ] 运行时 DevTools 0 错误/0 未处理异常
- [ ] 所有 SlashMenu 命令可正常插入对应区块
- [ ] 行内 Markdown 标记在光标进入/离开时正确显示/隐藏
- [ ] 代码块语言选择器可正常工作
- [ ] 公式块 KaTeX 渲染正确
- [ ] 折叠标题展开/收起动画流畅
- [ ] 列布局可拖拽调整宽度
- [ ] 数据库所有视图可切换
- [ ] 暗色主题可切换

### 6.2 代码质量验收

- [ ] 纯组件逻辑代码 ≥ 8,000 行（不含注释/空行）
- [ ] CSS 样式 ≥ 10,000 行
- [ ] 所有组件 ≤ 500 行
- [ ] 注释覆盖率 ≥ 30%（所有公共函数/组件/接口都有 JSDoc）
- [ ] 无上帝组件（单组件 useState ≤ 12 个）
- [ ] 文件命名统一（PascalCase 组件、camelCase 工具/Hook）

### 6.3 视觉验收

- [ ] Notion 暖灰色系一致性
- [ ] 微动效流畅（fadeIn/slideIn/bounce）
- [ ] 滚动条美化
- [ ] 响应式布局（≥768px 桌面，<768px 移动端适配）
- [ ] 暗色主题色彩协调

---

## 附录 A：文件清单（完整目录树）

完成后的 `src/` 目录结构预览：

```
src/
├── main.tsx
├── core/
│   ├── plugins/
│   │   ├── InlineDecorationPlugin.ts
│   │   ├── LivePreviewPlugin.ts
│   │   ├── DragHandlePlugin.ts          [NEW]
│   │   └── index.ts
│   └── types/
│       ├── blocks.ts
│       ├── database.ts
│       ├── editor.ts
│       └── index.ts
├── extensions/                           [NEW — 全部新建]
│   ├── CalloutExtension.ts
│   ├── MathBlockExtension.ts
│   ├── MathInlineExtension.ts
│   ├── DatabaseExtension.ts
│   ├── ImageExtension.ts
│   ├── VideoExtension.ts
│   ├── AudioExtension.ts
│   ├── FileExtension.ts
│   ├── BookmarkExtension.ts
│   ├── EmbedExtension.ts
│   ├── ColumnLayoutExtension.ts
│   ├── ToggleHeadingExtension.ts
│   ├── ToggleListExtension.ts
│   ├── TabsExtension.ts
│   ├── TOCExtension.ts
│   ├── ButtonExtension.ts
│   ├── AIBlockExtension.ts
│   ├── MermaidExtension.ts
│   ├── ChartExtension.ts
│   ├── SyncedBlockExtension.ts
│   ├── SubPageExtension.ts
│   ├── BreadcrumbExtension.ts
│   ├── SlashCommandExtension.ts
│   ├── DragHandleExtension.ts
│   └── index.ts
├── hooks/
│   ├── useBlockEditing.ts
│   └── index.ts
├── menus/
│   ├── BubbleMenu.tsx
│   ├── SlashMenu.tsx
│   ├── BlockMenu.tsx
│   └── index.ts
├── shell/
│   └── Editor.tsx
├── ui/
│   ├── Button.tsx
│   ├── ContextMenu.tsx
│   ├── DatePicker.tsx                    [NEW]
│   ├── DropdownMenu.tsx
│   ├── EmojiPicker.tsx                   [NEW]
│   ├── Popover.tsx
│   ├── Tooltip.tsx
│   └── index.ts
├── utils/
│   ├── diffParser.ts
│   ├── mathLoader.ts                     [NEW]
│   ├── mermaidLoader.ts                  [NEW]
│   ├── chartLoader.ts                    [NEW]
│   ├── videoUrlParser.ts                 [NEW]
│   └── index.ts
├── views/
│   ├── _shared/
│   │   ├── BlockToolbar.tsx
│   │   ├── EmptyState.tsx
│   │   ├── FenceMarker.tsx
│   │   └── index.ts
│   ├── fenced/
│   │   ├── CalloutView.tsx
│   │   ├── CodeBlockView.tsx
│   │   ├── DiffView.tsx
│   │   ├── MermaidBlockView.tsx          [NEW]
│   │   └── index.ts
│   ├── inline/                           [NEW — 全部新建]
│   │   ├── MathInlineView.tsx
│   │   ├── MentionView.tsx
│   │   ├── DateInlineView.tsx
│   │   ├── EmojiView.tsx
│   │   └── index.ts
│   └── panel/
│       ├── ImageBlockView.tsx
│       ├── VideoBlockView.tsx            [NEW]
│       ├── AudioBlockView.tsx            [NEW]
│       ├── EmbedBlockView.tsx            [NEW]
│       ├── BookmarkBlockView.tsx
│       ├── FileBlockView.tsx
│       ├── MathBlockView.tsx             [NEW]
│       ├── ColumnLayoutView.tsx          [NEW]
│       ├── ColumnView.tsx                [NEW]
│       ├── ToggleHeadingView.tsx         [NEW]
│       ├── ToggleListView.tsx            [NEW]
│       ├── TabsBlockView.tsx             [NEW]
│       ├── ButtonBlockView.tsx           [NEW]
│       ├── SyncedBlockView.tsx           [NEW]
│       ├── SubPageView.tsx               [NEW]
│       ├── BreadcrumbView.tsx            [NEW]
│       ├── AIBlockView.tsx               [NEW]
│       ├── TOCBlockView.tsx              [NEW]
│       ├── ChartBlockView.tsx            [NEW]
│       ├── database/
│       │   ├── DatabaseView.tsx
│       │   ├── TableView.tsx
│       │   ├── KanbanView.tsx            [NEW]
│       │   ├── KanbanColumn.tsx          [NEW]
│       │   ├── KanbanCard.tsx            [NEW]
│       │   ├── GalleryView.tsx           [NEW]
│       │   ├── GalleryCard.tsx           [NEW]
│       │   ├── CalendarView.tsx          [NEW]
│       │   ├── CalendarDay.tsx           [NEW]
│       │   ├── CalendarEvent.tsx         [NEW]
│       │   ├── ListView.tsx              [NEW]
│       │   ├── FormView.tsx              [NEW]
│       │   ├── FormField.tsx             [NEW]
│       │   ├── RecordDetailPanel.tsx     [NEW]
│       │   ├── PropertyEditor.tsx        [NEW]
│       │   └── index.ts
│       └── index.ts
├── services/
│   ├── ai/mockAiService.ts
│   ├── history/historyService.ts
│   └── io/markdownService.ts
└── styles/
    ├── index.css
    ├── tokens.css
    ├── tokens-dark.css                   [NEW]
    ├── reset.css
    ├── typography.css
    ├── prosemirror.css
    ├── animations.css
    ├── shell.css
    ├── ui/
    │   ├── index.css
    │   ├── date-picker.css              [NEW]
    │   └── emoji-picker.css             [NEW]
    ├── menus/
    │   └── index.css
    └── blocks/
        ├── index.css
        ├── code-block.css
        ├── fenced.css
        ├── database.css
        ├── media-layout.css
        ├── form.css
        ├── toggle.css                   [NEW]
        ├── column-layout.css            [NEW]
        ├── tabs.css                     [NEW]
        ├── math.css                     [NEW]
        ├── video-audio.css              [NEW]
        ├── embed.css                    [NEW]
        ├── ai-block.css                 [NEW]
        ├── kanban.css                   [NEW]
        ├── gallery.css                  [NEW]
        ├── calendar.css                 [NEW]
        ├── list-view.css               [NEW]
        ├── record-detail.css            [NEW]
        ├── property-editor.css          [NEW]
        └── inline-nodes.css             [NEW]
```

---

## 附录 B：执行检查清单

每个 Step 完成后必须通过以下检查：

```bash
# 1. TypeScript 编译
npm run typecheck

# 2. Vite 构建
npm run build

# 3. 代码行数统计
# TS/TSX 逻辑行 ≥ 8000，CSS ≥ 10000
```

---

**文档结束**
