/**
 * slashCommands — 斜杠菜单命令注册表
 *
 * 这是所有「可插入内容」的单一事实来源。
 * 菜单 UI、命令面板、块菜单的「转换为」都从这里读，
 * 因此新增一个区块只需要在这里加一条，三个入口同时生效。
 *
 * 每条命令必须真正把节点插进文档。
 * 历史上这里有一批 `setParagraph()` 占位实现——菜单里看得见、
 * 点了却什么都不发生，是最伤信任的一类 bug。
 */

import type { Editor, JSONContent, Range } from '@tiptap/core';
import {
  Type, Heading1, Heading2, Heading3,
  List, ListOrdered, CheckSquare, ChevronRight,
  Quote, Code, Minus, AlertCircle, GitCompare,
  Image as ImageIcon, Video, FileAudio, Paperclip, Globe, Bookmark,
  Database, BarChart3, Workflow, Sigma, Table2,
  Columns2, Columns3, Layers, ListTree,
  MousePointerClick, Sparkles, FileText, Images,
} from 'lucide-react';

export type SlashCategory =
  | 'basic'
  | 'lists'
  | 'blocks'
  | 'media'
  | 'data'
  | 'layout'
  | 'advanced';

export const CATEGORY_LABELS: Record<SlashCategory, string> = {
  basic: '基础',
  lists: '列表',
  blocks: '区块',
  media: '媒体',
  data: '数据与图表',
  layout: '布局',
  advanced: '高级',
};

export const CATEGORY_ORDER: SlashCategory[] = [
  'basic', 'lists', 'blocks', 'media', 'data', 'layout', 'advanced',
];

export interface SlashCommand {
  id: string;
  title: string;
  description: string;
  /** 搜索关键词，含中文拼音与英文别名 */
  keywords: string[];
  icon: React.FC<{ size?: number }>;
  category: SlashCategory;
  /** 快捷键提示，仅用于展示 */
  shortcut?: string;
  run: (editor: Editor, range: Range) => void;
}

/* ────────────────────────────────────────────
 * 插入辅助
 * ──────────────────────────────────────────── */

/** 删掉触发用的 `/xxx`，然后插入一个节点 */
function insertNode(
  editor: Editor,
  range: Range,
  typeName: string,
  attrs: Record<string, unknown> = {},
  content?: JSONContent[],
): void {
  const type = editor.schema.nodes[typeName];
  if (!type) return;
  const node: JSONContent = { type: typeName, attrs };
  if (content) node.content = content;
  editor.chain().focus().deleteRange(range).insertContent(node).run();
}

/** 在行首写入 Markdown 前缀（标题走 Token-in-Document，前缀是真字符） */
function applyPrefix(editor: Editor, range: Range, level: number): void {
  editor.chain().focus().deleteRange(range).setHeadingLevel(level).run();
}

const emptyParagraph: JSONContent[] = [{ type: 'paragraph' }];

/* ────────────────────────────────────────────
 * 命令表
 * ──────────────────────────────────────────── */

export const SLASH_COMMANDS: SlashCommand[] = [
  /* ── 基础 ── */
  {
    id: 'text', title: '正文', description: '普通段落',
    keywords: ['text', 'paragraph', 'p', 'zhengwen', 'duanluo'],
    icon: Type, category: 'basic', shortcut: 'Ctrl+Alt+0',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeadingLevel(0).run(),
  },
  {
    id: 'h1', title: '标题 1', description: '一级标题',
    keywords: ['h1', 'heading', 'biaoti', 'title'],
    icon: Heading1, category: 'basic', shortcut: 'Ctrl+Alt+1',
    run: (e, r) => applyPrefix(e, r, 1),
  },
  {
    id: 'h2', title: '标题 2', description: '二级标题',
    keywords: ['h2', 'heading', 'biaoti'],
    icon: Heading2, category: 'basic', shortcut: 'Ctrl+Alt+2',
    run: (e, r) => applyPrefix(e, r, 2),
  },
  {
    id: 'h3', title: '标题 3', description: '三级标题',
    keywords: ['h3', 'heading', 'biaoti'],
    icon: Heading3, category: 'basic', shortcut: 'Ctrl+Alt+3',
    run: (e, r) => applyPrefix(e, r, 3),
  },

  /* ── 列表 ── */
  {
    id: 'bullet', title: '项目符号列表', description: '无序列表',
    keywords: ['ul', 'bullet', 'list', 'liebiao', 'wuxu'],
    icon: List, category: 'lists',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: 'ordered', title: '编号列表', description: '有序列表',
    keywords: ['ol', 'ordered', 'number', 'bianhao', 'youxu'],
    icon: ListOrdered, category: 'lists',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: 'task', title: '待办事项', description: '可勾选的任务清单',
    keywords: ['todo', 'task', 'checkbox', 'daiban', 'renwu'],
    icon: CheckSquare, category: 'lists',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: 'toggleList', title: '折叠列表', description: '可展开收起的条目',
    keywords: ['toggle', 'collapse', 'zhedie', 'fold'],
    icon: ChevronRight, category: 'lists',
    run: (e, r) => insertNode(e, r, 'toggleList', { collapsed: false }, emptyParagraph),
  },
  {
    id: 'toggleHeading', title: '折叠标题', description: '带折叠箭头的标题',
    keywords: ['toggle heading', 'zhedie biaoti', 'fold'],
    icon: ListTree, category: 'lists',
    run: (e, r) => insertNode(e, r, 'toggleHeading', { level: 2, collapsed: false }, emptyParagraph),
  },

  /* ── 区块 ── */
  {
    id: 'quote', title: '引用', description: '引用文本块',
    keywords: ['quote', 'blockquote', 'yinyong'],
    icon: Quote, category: 'blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: 'callout', title: '标注', description: '带图标的提示框',
    keywords: ['callout', 'note', 'alert', 'biaozhu', 'tishi'],
    icon: AlertCircle, category: 'blocks',
    run: (e, r) => insertNode(e, r, 'callout', { type: 'note' }, emptyParagraph),
  },
  {
    id: 'code', title: '代码块', description: '带语法高亮的代码',
    keywords: ['code', 'pre', 'daima', 'snippet'],
    icon: Code, category: 'blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: 'diff', title: '差异对比', description: '带增删着色的 diff 块',
    keywords: ['diff', 'compare', 'chayi', 'duibi'],
    icon: GitCompare, category: 'blocks',
    run: (e, r) =>
      insertNode(e, r, 'diffBlock', {}, [
        { type: 'text', text: '- const a = 1;\n+ const a = 2;' },
      ]),
  },
  {
    id: 'divider', title: '分隔线', description: '水平分隔线',
    keywords: ['hr', 'divider', 'line', 'fengexian'],
    icon: Minus, category: 'blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },

  /* ── 媒体 ── */
  {
    id: 'image', title: '图片', description: '上传或嵌入图片',
    keywords: ['image', 'img', 'photo', 'tupian'],
    icon: ImageIcon, category: 'media',
    run: (e, r) => insertNode(e, r, 'imageBlock'),
  },
  {
    id: 'video', title: '视频', description: 'YouTube / B 站 / MP4',
    keywords: ['video', 'youtube', 'bilibili', 'shipin'],
    icon: Video, category: 'media',
    run: (e, r) => insertNode(e, r, 'videoBlock'),
  },
  {
    id: 'audio', title: '音频', description: '嵌入音频播放器',
    keywords: ['audio', 'music', 'yinpin', 'yinyue'],
    icon: FileAudio, category: 'media',
    run: (e, r) => insertNode(e, r, 'audioBlock'),
  },
  {
    id: 'file', title: '文件', description: '附件卡片',
    keywords: ['file', 'attachment', 'wenjian', 'fujian'],
    icon: Paperclip, category: 'media',
    run: (e, r) => insertNode(e, r, 'fileBlock'),
  },
  {
    id: 'bookmark', title: '网页书签', description: 'URL 预览卡片',
    keywords: ['bookmark', 'link', 'shuqian', 'wangye'],
    icon: Bookmark, category: 'media',
    run: (e, r) => insertNode(e, r, 'bookmarkBlock'),
  },
  {
    id: 'embed', title: '嵌入', description: '网页 / PDF / Office 文档',
    keywords: ['embed', 'iframe', 'pdf', 'qianru'],
    icon: Globe, category: 'media',
    run: (e, r) => insertNode(e, r, 'embedBlock'),
  },
  {
    id: 'carousel', title: '轮播图', description: '多图轮播展示',
    keywords: ['carousel', 'slider', 'gallery', 'lunbo', 'tupian'],
    icon: Images, category: 'media',
    run: (e, r) => insertNode(e, r, 'carouselBlock'),
  },

  /* ── 数据与图表 ── */
  {
    id: 'table', title: '表格', description: '可调列宽、可着色的表格',
    keywords: ['table', 'grid', 'biaoge'],
    icon: Table2, category: 'data',
    run: (e, r) =>
      e.chain().focus().deleteRange(r)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: 'database', title: '数据库', description: '表格 / 看板 / 画廊多视图',
    keywords: ['database', 'db', 'table', 'shujuku'],
    icon: Database, category: 'data',
    run: (e, r) => insertNode(e, r, 'databaseBlock'),
  },
  {
    id: 'chart', title: '图表', description: '柱状 / 折线 / 饼图',
    keywords: ['chart', 'echarts', 'graph', 'tubiao'],
    icon: BarChart3, category: 'data',
    run: (e, r) => insertNode(e, r, 'chartBlock', { chartType: 'bar', config: '{}' }),
  },
  {
    id: 'mermaid', title: 'Mermaid 图', description: '流程图 / 时序图 / 甘特图',
    keywords: ['mermaid', 'diagram', 'flowchart', 'liuchengtu'],
    icon: Workflow, category: 'data',
    run: (e, r) =>
      insertNode(e, r, 'mermaidBlock', {}, [
        { type: 'text', text: 'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[结束]' },
      ]),
  },
  {
    id: 'math', title: '公式块', description: 'LaTeX 数学公式',
    keywords: ['math', 'latex', 'katex', 'formula', 'gongshi'],
    icon: Sigma, category: 'data',
    run: (e, r) => insertNode(e, r, 'mathBlock', { formula: '' }),
  },

  /* ── 布局 ── */
  {
    id: 'columns2', title: '两列', description: '并排两栏',
    keywords: ['column', '2', 'liangl', 'fenlan'],
    icon: Columns2, category: 'layout',
    run: (e, r) => insertColumns(e, r, 2),
  },
  {
    id: 'columns3', title: '三列', description: '并排三栏',
    keywords: ['column', '3', 'sanl', 'fenlan'],
    icon: Columns3, category: 'layout',
    run: (e, r) => insertColumns(e, r, 3),
  },
  {
    id: 'tabs', title: '选项卡', description: '多个面板切换',
    keywords: ['tab', 'tabs', 'xuanxiangka'],
    icon: Layers, category: 'layout',
    run: (e, r) =>
      insertNode(e, r, 'tabsBlock', { activeTabId: 'tab-1' }, [
        { type: 'tabPanel', attrs: { tabId: 'tab-1', label: 'Tab 1' }, content: emptyParagraph },
        { type: 'tabPanel', attrs: { tabId: 'tab-2', label: 'Tab 2' }, content: emptyParagraph },
      ]),
  },
  {
    id: 'toc', title: '目录', description: '自动生成的文档大纲',
    keywords: ['toc', 'outline', 'contents', 'mulu'],
    icon: FileText, category: 'layout',
    run: (e, r) => insertNode(e, r, 'tableOfContents'),
  },

  /* ── 高级 ── */
  {
    id: 'button', title: '按钮', description: '可配置动作的按钮',
    keywords: ['button', 'anniu', 'action'],
    icon: MousePointerClick, category: 'advanced',
    run: (e, r) => insertNode(e, r, 'buttonBlock', { label: '点击执行' }),
  },
  {
    id: 'ai', title: 'AI 区块', description: '让 AI 生成内容',
    keywords: ['ai', 'gpt', 'assistant', 'zhineng'],
    icon: Sparkles, category: 'advanced',
    run: (e, r) => insertNode(e, r, 'aiBlock', { prompt: '', status: 'idle' }),
  },
];

/** 分栏需要按列数生成对应数量的 column 子节点 */
function insertColumns(editor: Editor, range: Range, count: number): void {
  insertNode(
    editor,
    range,
    'columnLayout',
    { columns: count, ratios: Array.from({ length: count }, () => 1 / count) },
    Array.from({ length: count }, () => ({ type: 'column', content: emptyParagraph })),
  );
}

/* ────────────────────────────────────────────
 * 搜索
 * ──────────────────────────────────────────── */

/**
 * 按查询词过滤命令。
 *
 * 排序规则：标题前缀命中 > 标题包含 > 关键词命中。
 * 这样输入 `h1` 时「标题 1」排在前面，而不是被一堆含 h 的项淹没。
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;

  const scored: Array<{ cmd: SlashCommand; score: number }> = [];
  for (const cmd of SLASH_COMMANDS) {
    const title = cmd.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 3;
    else if (title.includes(q)) score = 2;
    else if (cmd.keywords.some((k) => k.toLowerCase().startsWith(q))) score = 1;
    else if (cmd.keywords.some((k) => k.toLowerCase().includes(q))) score = 0;
    if (score >= 0) scored.push({ cmd, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.cmd);
}
