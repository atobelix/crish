/**
 * note-paper 挂载面导出（**W5-B-S Skeleton**）
 *
 * surface = note-paper
 * 轨：Skeleton（预览壳 + 假数据 / 半 transport）
 * **≠** W5-B Strict；**≠** 任何 EL 关闭
 */

export { NotePaperPanel, type NotePaperPanelProps } from './NotePaperPanel';

export {
  SendToNoteButton,
  type SendToNoteButtonProps,
} from './SendToNoteButton';

export {
  EDITOR_SURFACE_CHAT,
  EDITOR_SURFACE_NOTE_PAPER,
  EDITOR_SURFACES,
  isEditorSurface,
  type EditorSurface,
} from './editorSurface';

export {
  W5B_SKELETON_BOUNDARY,
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
  type W5bSkeletonPackageId,
  type W5bSkeletonTrack,
} from './w5bSkeleton';
