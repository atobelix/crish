/**
 * Editor — 编辑器主组件
 *
 * 接入 Token-in-Document 实时预览引擎：
 *   - Markdown 语法字符真实存在于文档中，可用键盘直接编辑
 *   - 光标贴近时语法显形，离开时收起
 *   - 序列化 = 取文本，天然无损
 *
 * 有意**不使用** tiptap-markdown：
 * 它在解析时会吃掉 `**`、在序列化时靠 mark 反推分隔符，
 * 与本架构的前提直接冲突，也是此前表格/图片/公式丢失的根因。
 * 导入导出统一走 core/serializer/markdown.ts。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { CharacterCount } from '@tiptap/extension-character-count';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Check, Copy, Download, FileText, Moon, Sun, PanelRight, Command, Keyboard, Upload, Undo2, Redo2, Maximize, Minimize } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { LivePreviewInline, STARTER_KIT_DISABLED } from '../core/live-preview';
import { docToMarkdown, markdownToDoc } from '../core/serializer/markdown';
import { docToHtml } from '../core/serializer/html';
import { BubbleMenuBar } from '../menus/BubbleMenu';
import { SlashCommandExtension } from '../menus/SlashCommandExtension';
import { TableAffordances } from '../views/table/TableAffordances';
import { BlockAffordances } from '../views/block/BlockAffordances';
import { FindReplace } from '../ui/FindReplace';
import { CommandPalette } from '../ui/CommandPalette';
import { OutlineSidebar } from './OutlineSidebar';
import { ShortcutsPanel } from '../ui/ShortcutsPanel';
import {
  CodeBlockExtension, TABLE_EXTENSIONS,
  CalloutExtension, MermaidExtension, DiffExtension,
  ImageExtension, VideoExtension, AudioExtension, FileExtension,
  BookmarkExtension, EmbedExtension, CarouselExtension,
  DatabaseExtension, MathBlockExtension, ChartExtension, AIBlockExtension,
  ColumnLayoutExtension, ColumnNode,
  ToggleHeadingExtension, ToggleListExtension,
  TabsExtension, TabPanelNode,
  TOCExtension, ButtonExtension,
  SyncedBlockExtension, SubPageExtension, BreadcrumbExtension,
  MathInlineExtension,
} from '../extensions';
import { SearchExtension } from '../core/extensions/SearchPlugin';
import { prefetchMermaid } from '../utils/mermaidLoader';
import { prefetchECharts } from '../utils/chartLoader';
import { Tooltip } from '../ui';

/* ────────────────────────────────────────────
 * 演示文档
 *
 * 注意这里是**原始 Markdown 文本**，不是 HTML。
 * 引擎挂载后会自行解析出 marks 与标题级别，
 * 而所有语法字符都会保留在文档里。
 * ──────────────────────────────────────────── */
const INITIAL_MARKDOWN = `# Conex Composer

这是一个 **Notion 排版** 与 *Obsidian 源码手感* 结合的编辑器。把光标点进下面任意一段带格式的文字，语法标记就会淡入显示。

## 行内实时编辑

- **粗体** —— 点进去看到 \`**\`，删掉一个星号就会降级成斜体
- *斜体* —— 同样可以直接改写分隔符
- ~~删除线~~ 与 ==高亮== 都是真字符
- \`行内代码\` 的反引号也可以直接编辑
- 链接 [Conex](https://conex.dev) 在光标靠近时展开完整语法
- 数学公式：$E = mc^2$ 在光标离开时会自动渲染成公式。

试试把下面这行的 \`##\` 改成 \`###\`，标题级别会实时跟着变：

## 用键盘改我的级别

## 多媒体与附件

![示例图片](https://images.unsplash.com/photo-1707343843437-caacff5cfa74?q=80&w=800&auto=format&fit=crop)

## 复杂区块渲染

### 1. 警告框 (Callouts)

> [!info] 信息提示
> 这是一个类似 Obsidian 的 Callout 块，非常适合用来标注重要信息。

> [!warning] 警告
> 这里有一些需要特别注意的内容。

### 2. 代码块 (带下拉选择)

\`\`\`typescript
// 语法即真相：序列化就是取文本
export function docToMarkdown(doc: PMNode): string {
  return blocks(doc).map(serializeBlock).join('\\n\\n');
}
\`\`\`

### 3. 代码差异 (Diff)

\`\`\`diff
- const oldFeature = false;
+ const newFeature = true;
\`\`\`

### 4. 数据表格

| 特性 | Notion | Obsidian | Composer |
| --- | --- | --- | --- |
| 所见即所得 | ✅ | ❌ | ✅ |
| 源码手感 | ❌ | ✅ | ✅ |
| 双向链接 | ✅ | ✅ | ✅ |

### 5. Mermaid 图表

\`\`\`mermaid
graph TD;
    A[Markdown] --> B(Parser);
    B --> C{ProseMirror};
    C -->|Render| D[Live Preview];
\`\`\`

### 6. 数学块 (Math)

$$
\\frac{n!}{k!(n-k)!} = \\binom{n}{k}
$$

## 为什么这样做

传统做法把 \`**\` 藏在装饰层里，看得见却删不掉；这里它就是文档的一部分，所以：

1. 按退格键真的会改变格式
2. 撤销重做完全一致
3. 导出的 Markdown 与你看到的逐字符相同

> 编辑器不该在你和文本之间加一层玻璃。

---

- [ ] 点开任意格式看语法显形
- [x] 感受一下退格键的行为
- [ ] 试试把上方表格加一行
`;

/**
 * 补充演示节点 — 无法用 Markdown 表达的高级组件
 *
 * 这些节点在 onCreate 中以 ProseMirror JSON 的形式追加到文档末尾，
 * 让用户一次看到编辑器的全部渲染能力。
 */
const EXTRA_BLOCKS: JSONContent[] = [
  // ── 章节标题 ──
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '## 高级组件展示' }] },

  // 7. 折叠标题
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 7. 折叠标题' }] },
  { type: 'toggleHeading', attrs: { level: 2, collapsed: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '这是一个折叠标题，点击左侧箭头可以收起下方内容。' }] }] },

  // 8. 折叠列表
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 8. 折叠列表' }] },
  { type: 'toggleList', attrs: { collapsed: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '折叠列表可以用来隐藏次要信息，让文档更加简洁。' }] }] },

  // 9. 多列布局
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 9. 多列布局' }] },
  { type: 'columnLayout', attrs: { columns: 2, ratios: [0.5, 0.5] },
    content: [
      { type: 'column', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '左列：可以在这里放置任意内容，支持拖拽分隔条调整列宽。' }] },
      ] },
      { type: 'column', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '右列：最多支持 5 列并排，最少 2 列。双击分隔条可重置为等宽。' }] },
      ] },
    ] },

  // 10. 选项卡
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 10. 选项卡' }] },
  { type: 'tabsBlock', attrs: { activeTabId: 'demo-1' },
    content: [
      { type: 'tabPanel', attrs: { tabId: 'demo-1', label: '概览' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '选项卡可以把多块内容组织在同一区域，通过标签切换查看。双击标签可重命名。' }] }] },
      { type: 'tabPanel', attrs: { tabId: 'demo-2', label: '详情' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '这是第二个面板。点击标签栏末尾的 + 可以添加更多面板。' }] }] },
      { type: 'tabPanel', attrs: { tabId: 'demo-3', label: '日志' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '每个面板都是独立的编辑区域，可以放置任意块级内容。' }] }] },
    ] },

  // 11. 目录 (TOC)
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 11. 自动目录' }] },
  { type: 'tableOfContents' },

  // 12. 按钮
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 12. 按钮' }] },
  { type: 'buttonBlock', attrs: { label: '访问 Conex 官网', action: 'open_url', url: 'https://conex.dev', variant: 'primary', size: 'md' } },

  // 13. AI 区块
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 13. AI 区块' }] },
  { type: 'aiBlock', attrs: { prompt: '', status: 'idle' } },

  // 14. 视频
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 14. 视频嵌入' }] },
  { type: 'videoBlock', attrs: { src: '', provider: 'mp4' } },

  // 15. 音频
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 15. 音频播放器' }] },
  { type: 'audioBlock', attrs: { src: '', title: '' } },

  // 16. 文件附件
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 16. 文件附件' }] },
  { type: 'fileBlock', attrs: { src: '', name: '', size: 0 } },

  // 17. 网页书签
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 17. 网页书签' }] },
  { type: 'bookmarkBlock', attrs: { url: 'https://github.com', title: 'GitHub', description: 'Where the world builds software', favicon: 'https://github.githubassets.com/favicons/favicon.svg' } },

  // 18. 嵌入
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 18. 网页嵌入' }] },
  { type: 'embedBlock', attrs: { url: '', type: 'iframe', height: 300 } },

  // 19. 数据库
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 19. 数据库' }] },
  { type: 'databaseBlock', attrs: { title: '项目追踪', viewType: 'table' } },

  // 20. ECharts 图表
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 20. 数据图表' }] },
  { type: 'chartBlock', attrs: {
    chartType: 'bar',
    config: JSON.stringify({
      categories: ['一月', '二月', '三月', '四月', '五月'],
      series: [{ name: '销量', values: [120, 200, 150, 320, 260] }],
    }),
  } },

  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '### 21. 轮播图' }] },
  { type: 'carouselBlock', attrs: {
    images: [
      { src: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800', alt: '山景', caption: '' },
      { src: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=800', alt: '森林', caption: '' },
      { src: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800', alt: '湖泊', caption: '' },
    ],
    activeIndex: 0,
  } },
];

/* ────────────────────────────────────────────
 * 扩展配置（模块顶层，避免 StrictMode 下重复创建）
 * ──────────────────────────────────────────── */
const extensions = [
  StarterKit.configure({ ...STARTER_KIT_DISABLED, codeBlock: false }),
  CodeBlockExtension,
  Placeholder.configure({
    placeholder: ({ node }) =>
      node.type.name === 'heading' ? '标题' : '输入 / 打开命令菜单，或直接开始写作...',
  }),
  CharacterCount,
  TaskList,
  TaskItem.configure({ nested: true }),
  TextStyle,
  Color,
  LivePreviewInline,
  ...TABLE_EXTENSIONS,
  CalloutExtension, MermaidExtension, DiffExtension,
  ImageExtension, VideoExtension, AudioExtension, FileExtension,
  BookmarkExtension, EmbedExtension, CarouselExtension,
  DatabaseExtension, MathBlockExtension, ChartExtension, AIBlockExtension,
  ColumnLayoutExtension, ColumnNode, TabsExtension, TabPanelNode,
  ToggleHeadingExtension, ToggleListExtension, TOCExtension,
  ButtonExtension, SyncedBlockExtension, SubPageExtension, BreadcrumbExtension,
  MathInlineExtension,
  SlashCommandExtension,
  SearchExtension,
];

/* ────────────────────────────────────────────
 * Editor
 * ──────────────────────────────────────────── */
export const Editor: React.FC = () => {
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  const [editorRoot, setEditorRoot] = useState<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [searchMode, setSearchMode] = useState<'find' | 'replace' | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [showOutline, setShowOutline] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { theme, toggle: toggleTheme } = useTheme();

  const editor = useEditor({
    extensions,
    content: INITIAL_MARKDOWN,
    editorProps: { attributes: { class: 'ProseMirror', spellcheck: 'false' } },
    onCreate: ({ editor: ed }) => {
      const doc = markdownToDoc(INITIAL_MARKDOWN, ed.schema);
      ed.view.dispatch(
        ed.state.tr.replaceWith(0, ed.state.doc.content.size, doc.content).setMeta('addToHistory', false),
      );
      /* 追加非 Markdown 高级组件 */
      ed.commands.insertContentAt(
        ed.state.doc.content.size - 1,
        EXTRA_BLOCKS,
        { updateSelection: false },
      );
      /* 标记为非历史操作：撤销不会逐个移除演示节点 */
      ed.view.dispatch(ed.state.tr.setMeta('addToHistory', false));
      ed.commands.reconcileDocument();
      syncStats(ed);
      prefetchMermaid();
      prefetchECharts();
    },
    onUpdate: ({ editor: ed }) => syncStats(ed),
  });

  const syncStats = (ed: NonNullable<typeof editor>) => {
    const storage = ed.storage.characterCount as
      | { words: () => number; characters: () => number }
      | undefined;
    if (storage) setStats({ words: storage.words(), chars: storage.characters() });
  };

  const markdown = useCallback(
    () => (editor ? docToMarkdown(editor.state.doc) : ''),
    [editor],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* 剪贴板不可用时静默降级 */ }
  }, [markdown]);

  const handleDownload = useCallback((format: 'md' | 'html' = 'md') => {
    if (!editor) return;
    const content = format === 'html' ? docToHtml(editor.state.doc) : markdown();
    const mime = format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `document.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [editor, markdown]);

  const handleImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !editor) return;
      const text = await file.text();
      const doc = markdownToDoc(text, editor.schema);
      editor.view.dispatch(
        editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content),
      );
      editor.commands.reconcileDocument();
      event.target.value = '';
    },
    [editor],
  );

  const readingTime = useMemo(() => Math.max(1, Math.round(stats.words / 250)), [stats.words]);

  if (!editor) return null;

  /* ── 全局键盘快捷键 ── */
  const handleGlobalKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowPalette(true); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey) { e.preventDefault(); setSearchMode('find'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') { e.preventDefault(); setSearchMode('replace'); }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      if (editor.state.selection.empty) setShowShortcuts(true);
    }
    if (e.key === 'F11') { e.preventDefault(); setFocusMode(f => !f); }
  };

  /* ── 拖拽上传 ── */
  const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current++; if (e.dataTransfer.types.includes('Files')) setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current--; if (dragCounterRef.current === 0) setIsDragging(false); };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false); dragCounterRef.current = 0;
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const t = file.type;
      if (t.startsWith('image/')) { editor.chain().focus().insertContent({ type: 'imageBlock', attrs: { src: URL.createObjectURL(file), alt: file.name } }).run(); }
      else if (t.startsWith('video/')) { editor.chain().focus().insertContent({ type: 'videoBlock', attrs: { src: URL.createObjectURL(file) } }).run(); }
      else if (t.startsWith('audio/')) { editor.chain().focus().insertContent({ type: 'audioBlock', attrs: { src: URL.createObjectURL(file), title: file.name } }).run(); }
      else if (file.name.match(/\.(md|markdown|txt)$/)) {
        file.text().then(text => { const doc = markdownToDoc(text, editor.schema); editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content)); editor.commands.reconcileDocument(); });
      } else { editor.chain().focus().insertContent({ type: 'fileBlock', attrs: { filename: file.name, size: file.size } }).run(); }
    }
  };

  /* ── JSX ── */
  return (
    <div
      className={`editor-shell ${showOutline ? 'has-outline' : ''} ${focusMode ? 'is-focus-mode' : ''}`}
      onKeyDown={handleGlobalKeyDown}
      onDragEnter={handleDragEnter} onDragLeave={handleDragLeave}
      onDragOver={handleDragOver} onDrop={handleDrop}
    >
      <header className="editor-header">
        <div className="editor-header__left">
          <span className="editor-header__brand">
            <FileText size={16} className="editor-header__brand-icon" />
            <span className="editor-header__brand-name">Conex Composer</span>
          </span>
        </div>

        <div className="editor-header__right">
          <span className="editor-header__stats">
            {stats.words} 词 · {stats.chars} 字符 · 约 {readingTime} 分钟
          </span>

          {/* 撤销/重做 */}
          <Tooltip content="撤销 (Ctrl+Z)">
            <button type="button" className="btn btn--ghost btn--sm btn--icon-only motion-tap" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
              <Undo2 size={14} />
            </button>
          </Tooltip>
          <Tooltip content="重做 (Ctrl+Shift+Z)">
            <button type="button" className="btn btn--ghost btn--sm btn--icon-only motion-tap" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
              <Redo2 size={14} />
            </button>
          </Tooltip>

          <span className="editor-header__divider" />

          {/* 导入 */}
          <input ref={fileInputRef} type="file" accept=".md,.markdown,.txt" hidden onChange={handleImport} />
          <Tooltip content="导入 Markdown 文件">
            <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={() => fileInputRef.current?.click()}>导入</button>
          </Tooltip>

          {/* 复制 */}
          <Tooltip content={copied ? '已复制到剪贴板' : '复制为 Markdown'}>
            <button type="button" className={`btn btn--ghost btn--sm motion-tap ${copied ? 'is-success' : ''}`} onClick={handleCopy}>
              {copied ? <Check size={14} className="motion-pulse" /> : <Copy size={14} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </Tooltip>

          {/* 下载 */}
          <Tooltip content="下载 .md">
            <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={() => handleDownload('md')}>
              <Download size={14} /><span>.md</span>
            </button>
          </Tooltip>
          <Tooltip content="下载 .html">
            <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={() => handleDownload('html')}>
              <Download size={14} /><span>.html</span>
            </button>
          </Tooltip>

          <span className="editor-header__divider" />

          {/* 命令面板 */}
          <Tooltip content="命令面板 (Ctrl+K)">
            <button type="button" className="btn btn--ghost btn--sm btn--icon-only motion-tap" onClick={() => setShowPalette(true)}>
              <Command size={15} />
            </button>
          </Tooltip>

          {/* 大纲 */}
          <Tooltip content={showOutline ? '隐藏大纲' : '显示大纲'}>
            <button type="button" className={`btn btn--ghost btn--sm btn--icon-only motion-tap ${showOutline ? 'is-active' : ''}`} onClick={() => setShowOutline(!showOutline)}>
              <PanelRight size={15} />
            </button>
          </Tooltip>

          {/* 快捷键 */}
          <Tooltip content="快捷键 (?)">
            <button type="button" className="btn btn--ghost btn--sm btn--icon-only motion-tap" onClick={() => setShowShortcuts(true)}>
              <Keyboard size={15} />
            </button>
          </Tooltip>

          {/* 专注模式 */}
          <Tooltip content={focusMode ? '退出专注 (F11)' : '专注模式 (F11)'}>
            <button type="button" className={`btn btn--ghost btn--sm btn--icon-only motion-tap ${focusMode ? 'is-active' : ''}`} onClick={() => setFocusMode(f => !f)}>
              {focusMode ? <Minimize size={15} /> : <Maximize size={15} />}
            </button>
          </Tooltip>

          {/* 主题 */}
          <Tooltip content={theme === 'dark' ? '切换为亮色' : '切换为暗色'}>
            <button type="button" className="btn btn--ghost btn--sm btn--icon-only motion-tap" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </Tooltip>
        </div>
      </header>

      <main className="editor-content" ref={setEditorRoot}>
        <EditorContent editor={editor} />
        <BubbleMenuBar editor={editor} />
        <BlockAffordances editor={editor} root={editorRoot} />
        <TableAffordances editor={editor} root={editorRoot} />
        {searchMode && <FindReplace editor={editor} mode={searchMode} onClose={() => setSearchMode(null)} />}
      </main>

      {showOutline && <OutlineSidebar editor={editor} />}

      {showPalette && (
        <CommandPalette
          editor={editor} theme={theme}
          onClose={() => setShowPalette(false)}
          onToggleTheme={toggleTheme} onCopy={handleCopy} onDownload={handleDownload}
          onOpenSearch={(mode) => setSearchMode(mode)}
          onToggleOutline={() => setShowOutline(!showOutline)}
        />
      )}

      {showShortcuts && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}

      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay__border" />
          <div className="drop-overlay__icon"><Upload size={28} /></div>
          <span className="drop-overlay__text">松开以上传文件</span>
          <span className="drop-overlay__hint">支持图片、视频、音频、Markdown 文件</span>
        </div>
      )}

      {focusMode && (
        <div className="focus-exit-bar">
          <span>专注模式</span>
          <kbd>F11</kbd>
          <button type="button" className="focus-exit-bar__btn" onClick={() => setFocusMode(false)}>退出</button>
        </div>
      )}
    </div>
  );
};
