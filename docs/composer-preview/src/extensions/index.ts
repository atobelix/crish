/**
 * Extensions — 所有 Tiptap 自定义扩展的统一导出
 *
 * 按类别分组：
 * 1. 围栏块 (Fenced) — 光标进入显示围栏标记
 * 2. 交互面板块 (Panel) — 通过可视化面板编辑
 * 3. 布局块 (Layout) — 页面结构/布局
 * 4. 行内节点 (Inline) — 行内嵌入元素
 */

/* ── 围栏块 ── */
export { CalloutExtension } from './CalloutExtension';
export { DiffExtension } from './DiffExtension';
export { CodeBlockExtension, SUPPORTED_LANGUAGES } from './CodeBlockExtension';
export { TABLE_EXTENSIONS } from './TableExtension';
export { MermaidExtension } from './MermaidExtension';

/* ── 交互面板块 · 媒体 ── */
export { ImageExtension } from './ImageExtension';
export { VideoExtension } from './VideoExtension';
export { AudioExtension } from './AudioExtension';
export { FileExtension } from './FileExtension';
export { BookmarkExtension } from './BookmarkExtension';
export { EmbedExtension } from './EmbedExtension';
export { CarouselExtension } from './CarouselExtension';

/* ── 交互面板块 · 数据 ── */
export { DatabaseExtension } from './DatabaseExtension';
export { MathBlockExtension } from './MathBlockExtension';
export { ChartExtension } from './ChartExtension';
export { AIBlockExtension } from './AIBlockExtension';

/* ── 布局块 ── */
export { ColumnLayoutExtension, ColumnNode } from './ColumnLayoutExtension';
export { ToggleHeadingExtension } from './ToggleHeadingExtension';
export { ToggleListExtension } from './ToggleListExtension';
export { TabsExtension, TabPanelNode } from './TabsExtension';
export { TOCExtension } from './TOCExtension';
export { ButtonExtension } from './ButtonExtension';
export { SyncedBlockExtension } from './SyncedBlockExtension';
export { SubPageExtension } from './SubPageExtension';
export { BreadcrumbExtension } from './BreadcrumbExtension';

/* ── 行内节点 ── */
export { MathInlineExtension } from './MathInlineExtension';
