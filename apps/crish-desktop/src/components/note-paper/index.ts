/**
 * note-paper 挂载面导出（**双轨并存**）
 *
 * surface = note-paper
 *
 * | 轨 | 包 ID | 入口 |
 * |----|-------|------|
 * | Skeleton | `W5-B-S` | `NotePaperPanel` + `w5bSkeleton` |
 * | Strict   | `W5-B`   | `NotePaperStrictPanel` + `w5bStrict` + hydrate 投影 |
 *
 * **可演示 ≠ EL-01/EL-08**；**≠ W5-C 隔离全关**；挂载冒充交付 = S5。
 * **禁止** 把 Skeleton 常量改成 W5-B 冒充 Strict。
 */

export { NotePaperPanel, type NotePaperPanelProps } from './NotePaperPanel';

export {
  NotePaperStrictPanel,
  type NotePaperStrictPanelProps,
} from './NotePaperStrictPanel';

/** W3-F DOM 桌面挂载：BlockChromeDomHost → React（≠ EL-01） */
export {
  BlockChromeDomMount,
  type BlockChromeDomMountProps,
} from './BlockChromeDomMount';

/** 真 React slash 浮层：catalog 可点 → Intent → sink（≠ EL-01 / ≠ A-BLK-02 e2e） */
export {
  SlashMenuOverlay,
  type SlashMenuOverlayProps,
} from './SlashMenuOverlay';

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

export {
  W5B_PRODUCT_DEFAULT_EMPTY_TRACK,
  W5B_STRICT_BOUNDARY,
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
  type W5bStrictPackageId,
  type W5bStrictTrack,
} from './w5bStrict';

export {
  adaptNoteHydrateIpcAsTransport,
  adaptNoteTransportAsHydrate,
  createEmptyStateStrictDemoTransport,
  createFixtureHydrateTransport,
  createProductStrictHydrateTransport,
  makeHydratedBlock,
  mapHydrateIpcSuccessToProjection,
  mapQueryHitToProjection,
  resolveProductStrictHydrateSource,
  type CreateProductStrictHydrateTransportOptions,
  type DocHydrateProjection,
  type FixtureHydrateDoc,
  type HydratedBlockProjection,
  type NoteHydrateFailure,
  type NoteHydrateOutcome,
  type NoteHydrateSuccess,
  type NoteHydrateTransport,
  type ProductStrictHydrateSource,
  type ResolveProductStrictHydrateSourceOptions,
} from './hydrateProjection';
