// 文件域组件 barrel
export { FileBrowser, browserViewState } from './FileBrowser';
export type { FileBrowserProps, BrowserView } from './FileBrowser';
export { FileBreadcrumb, segmentLabel } from './FileBreadcrumb';
export type { FileBreadcrumbProps } from './FileBreadcrumb';
export { FileRow, rowMetaText } from './FileRow';
export type { FileRowProps } from './FileRow';
export { FilePreview, numberedLines } from './FilePreview';
export type { FilePreviewProps } from './FilePreview';
export { WorkspaceSheet } from './WorkspaceSheet';
export type { WorkspaceSheetProps } from './WorkspaceSheet';
export {
  detectFileKind,
  FILE_KIND_ICON,
  FILE_KIND_TONE,
  formatFileSize,
  isSensitiveFile,
  mapFilesErrorCode,
} from './fileMeta';
export type { FileKind, FilesErrorText } from './fileMeta';
