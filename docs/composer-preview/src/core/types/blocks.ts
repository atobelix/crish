/**
 * Conex Composer — Block Type Definitions
 *
 * 所有区块的类型定义，按 L1/L2/L3 层级分类。
 * 这些类型用于 Extension 注册、NodeView Props 传递和序列化规则。
 */

/* ================================================================
 * L1 原生文本块 — 光标进入时显示 Markdown 语法标记
 * ================================================================ */

/** 标题等级 1-6 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingAttrs {
  level: HeadingLevel;
  id: string | null;
}

export interface ToggleListAttrs {
  collapsed: boolean;
}

export interface ToggleHeadingAttrs {
  level: HeadingLevel;
  collapsed: boolean;
  id: string | null;
}

/* ================================================================
 * L2 围栏块 — 光标进入时显示围栏标记
 * ================================================================ */

/** 代码块属性 */
export interface CodeBlockAttrs {
  language: string;
  showLineNumbers: boolean;
  highlightLines: number[];
  filename: string;
}

/** Mermaid 图表块属性 */
export interface MermaidAttrs {
  /** 当前无额外属性，图表类型由内容第一行决定 */
}

/** Diff 对比块属性 */
export interface DiffAttrs {
  filename: string;
  viewMode: 'unified' | 'split';
}

/** 数学公式块属性 */
export interface MathBlockAttrs {
  isInline: boolean;
}

/** Callout 类型 */
export type CalloutType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

/** Callout 属性 */
export interface CalloutAttrs {
  type: CalloutType;
  icon: string;
  title: string;
  collapsed: boolean;
}

/** ECharts 图表块属性 */
export interface ChartAttrs {
  chartType: 'bar' | 'horizontal_bar' | 'line' | 'donut' | 'pie' | 'scatter' | 'area';
  config: string; // JSON string of ECharts option
}

/* ================================================================
 * L3 交互面板块 — 不显示源码，通过面板编辑
 * ================================================================ */

/** 图片块属性 */
export interface ImageAttrs {
  src: string;
  alt: string;
  title: string;
  width: number | null;
  height: number | null;
  alignment: 'left' | 'center' | 'right';
  caption: string;
}

/** 视频块属性 */
export interface VideoAttrs {
  src: string;
  provider: 'youtube' | 'bilibili' | 'vimeo' | 'mp4' | 'embed';
  width: number | null;
  height: number | null;
  caption: string;
}

/** 音频块属性 */
export interface AudioAttrs {
  src: string;
  title: string;
  caption: string;
}

/** 文件附件块属性 */
export interface FileAttrs {
  src: string;
  name: string;
  size: number;
  mimeType: string;
}

/** 网页书签块属性 */
export interface BookmarkAttrs {
  url: string;
  title: string;
  description: string;
  thumbnail: string;
  favicon: string;
}

/** 嵌入块属性 */
export interface EmbedAttrs {
  url: string;
  type: 'iframe' | 'html' | 'pdf' | 'word' | 'excel';
  width: number | null;
  height: number | null;
}

/** 列布局属性 */
export interface ColumnLayoutAttrs {
  columns: number; // 2 | 3 | 4 | 5
  /** 各列宽度比例，如 [1, 1] 表示等分，[2, 1] 表示左宽右窄 */
  ratios: number[];
}

/** 选项卡属性 */
export interface TabsAttrs {
  tabs: Array<{
    id: string;
    label: string;
  }>;
  activeTabId: string;
}

/** 按钮块属性 */
export interface ButtonAttrs {
  label: string;
  action: 'open_url' | 'copy_text' | 'run_command';
  url: string;
  variant: 'primary' | 'secondary' | 'outline' | 'ghost';
  size: 'sm' | 'md' | 'lg';
  icon: string;
}

/** 同步区块属性 */
export interface SyncedBlockAttrs {
  sourceId: string; // 源同步块的唯一 ID
}

/** 子页面链接属性 */
export interface SubPageAttrs {
  pageId: string;
  title: string;
  icon: string;
}

/** 路径栏属性 */
export interface BreadcrumbAttrs {
  /** 自动生成，无需手动配置 */
}

/** AI 区块属性 */
export interface AIBlockAttrs {
  prompt: string;
  status: 'idle' | 'generating' | 'done' | 'error';
  model: string;
}

/* ================================================================
 * 行内节点
 * ================================================================ */

/** 行内数学公式属性 */
export interface MathInlineAttrs {
  formula: string;
}

/** 提及属性 */
export type MentionType = 'person' | 'page' | 'database' | 'date';

export interface MentionAttrs {
  type: MentionType;
  id: string;
  label: string;
  icon: string;
}

/** 日期/提醒属性 */
export interface DateAttrs {
  date: string;       // ISO date string
  endDate: string | null;
  includeTime: boolean;
  reminder: string | null;
  format: 'relative' | 'full' | 'short';
}

/** 表情符号属性 */
export interface EmojiAttrs {
  emoji: string;      // Unicode emoji character
  shortcode: string;  // :smile: 形式
}

/* ================================================================
 * 区块层级分类常量
 * ================================================================ */

/** L1 原生文本块类型名（ProseMirror Node name） */
export const L1_TEXT_BLOCKS = [
  'heading',
  'paragraph',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'toggleList',
  'horizontalRule',
] as const;

/** L2 围栏块类型名 */
export const L2_FENCED_BLOCKS = [
  'codeBlock',
  'mermaidBlock',
  'diffBlock',
  'mathBlock',
  'callout',
  'chartBlock',
] as const;

/** L3 交互面板块类型名 */
export const L3_PANEL_BLOCKS = [
  'databaseBlock',
  'imageBlock',
  'videoBlock',
  'audioBlock',
  'fileBlock',
  'bookmarkBlock',
  'embedBlock',
  'columnLayout',
  'tabsBlock',
  'toggleHeading',
  'tableOfContents',
  'buttonBlock',
  'syncedBlock',
  'subPage',
  'breadcrumb',
  'aiBlock',
] as const;

export type L1BlockName = typeof L1_TEXT_BLOCKS[number];
export type L2BlockName = typeof L2_FENCED_BLOCKS[number];
export type L3BlockName = typeof L3_PANEL_BLOCKS[number];
export type BlockName = L1BlockName | L2BlockName | L3BlockName;

/**
 * 判断一个节点类型名是否属于 Live Preview 节点
 * （L1 或 L2 类型，光标进入时会显示 Markdown 语法标记）
 */
export function isLivePreviewBlock(typeName: string): boolean {
  return (
    (L1_TEXT_BLOCKS as readonly string[]).includes(typeName) ||
    (L2_FENCED_BLOCKS as readonly string[]).includes(typeName)
  );
}

/**
 * 判断一个节点类型名是否属于围栏块（L2）
 */
export function isFencedBlock(typeName: string): boolean {
  return (L2_FENCED_BLOCKS as readonly string[]).includes(typeName);
}
