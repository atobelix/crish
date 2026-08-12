// 文件域组件 barrel（R2-06b）：浏览页 / 预览页 / 工作区选择器 / 行 / 面包屑
export { FileBrowser, browserViewState, nextDensity } from './FileBrowser';
export type { FileBrowserProps, BrowserView } from './FileBrowser';
export { FileBreadcrumb, segmentLabel } from './FileBreadcrumb';
export type { FileBreadcrumbProps } from './FileBreadcrumb';
export { FileRow, rowMetaText } from './FileRow';
export type { FileRowProps } from './FileRow';
export { FilePreview, numberedLines } from './FilePreview';
export type { FilePreviewProps } from './FilePreview';
export { WorkspaceSwitcher, workspaceCard } from './WorkspaceSwitcher';
export type { WorkspaceSwitcherProps } from './WorkspaceSwitcher';
export {
  detectFileKind,
  fileKindGlyph,
  fileKindColor,
  DIR_GLYPH,
  formatFileSize,
  formatRelativeTime,
  isSensitiveFile,
  mapFilesErrorCode,
} from './fileMeta';
export type { FileKind, FilesErrorText } from './fileMeta';
