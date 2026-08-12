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
  type NotePaperStrictPaperListConfig,
} from './NotePaperStrictPanel';

/**
 * SD-04 内容呈现策略（反三宿主）：react-rows | paper-list | debug-dual。
 * 产品默认内容宿主互斥；chrome 槽分槽共存。
 */
export {
  isPresentationMode,
  isProductContentHostExclusive,
  PRESENTATION_MODES,
  resolvePresentationMode,
  showPaperListContent,
  showReactContentRows,
  type PresentationMode,
  type ResolvePresentationModeInput,
} from './presentationMode';

/** Strict hydrate 状态机 hook（从 StrictPanel 抽出） */
export {
  useNoteHydrate,
  type HydrateUiStatus,
  type UseNoteHydrateOptions,
  type UseNoteHydrateResult,
} from './useNoteHydrate';

/** W3-F DOM 桌面挂载：BlockChromeDomHost → React（≠ EL-01） */
export {
  BlockChromeDomMount,
  type BlockChromeDomMountProps,
} from './BlockChromeDomMount';

/**
 * W3-G PaperList 桌面挂载：仅窗口 DOM（≠ EL-01；≠ W3-P 全闭环）。
 * 与 chrome DomMount 分槽共存（data-bp-paper-list-mount ∥ data-bp-chrome-mount）。
 */
export {
  PaperListDomMount,
  type PaperListDomMountProps,
  type PaperListMountBlock,
} from './PaperListDomMount';

/** 真 React slash 浮层：catalog 可点 → Intent → sink（≠ EL-01 / ≠ A-BLK-02 e2e） */
export {
  SlashMenuOverlay,
  type SlashMenuOverlayProps,
  type SlashOverlayWriteMode,
} from './SlashMenuOverlay';

/**
 * CONN-B：产品 Strict slash 写锥绑定（有 applyOps → collab；无 → 只读）。
 * **≠ EL-01**；**≠ A-BLK-02 e2e**；禁止 mock 当生产默认。
 */
export {
  createProductStrictSlashBinding,
  type CreateProductStrictSlashBindingOptions,
  type ProductSlashSinkSource,
  type ProductSlashWriteMode,
  type ProductStrictSlashBinding,
} from './productSlashSink';

/**
 * CONN-D2：产品 Strict MD 前缀 / turn_into 写锥（叶/HiddenInput → commitMdPrefixFromLeaf）。
 * **桌面接线 ≠ 打开完成**；**≠ A-BLK-08/09 e2e**；**≠ EL-01**；provisional ≠ kind UI。
 */
export {
  commitProductMdPrefixFromLeaf,
  commitProductMdPrefixFromPlainText,
  createProductMdPrefixBinding,
  resolveStrictMdPrefixBinding,
  tryProductMdPrefixAfterLeafEdit,
  type CommitProductMdPrefixOptions,
  type CreateProductMdPrefixBindingOptions,
  type ProductMdPrefixBinding,
  type ProductMdPrefixCommitResult,
  type ProductMdPrefixSinkSource,
  type ProductMdPrefixWriteMode,
  type ResolveStrictMdPrefixBindingInput,
  type StrictMdPrefixUiBinding,
} from './noteMdPrefixBridge';

/**
 * CONN-B2：产品 slash 打开路径（`/` 键 / openProductSlash；composing 拒开）。
 * 打开后 writeMode 仍由 B1 binding 决定。**≠ EL-01**。
 */
export {
  handleProductSlashKeydown,
  isNativeFormFieldTarget,
  isProductSlashOpenKey,
  isWithinProductSlashFocusContext,
  openProductSlash,
  resolveProductSlashAnchor,
  tryOpenProductSlashFromKey,
  type HandleProductSlashKeydownArgs,
  type OpenProductSlashArgs,
  type ProductSlashKeyLike,
  type ProductSlashOpenResult,
  type ResolveProductSlashAnchorInput,
} from './productSlashOpen';

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

/**
 * A-INV-02 镜像漂移 UI 方向（状态条 + 三路入口骨架 + CONN-E IPC 桥）。
 * ≠ EL-03；≠ inotify 产品满关；≠ A-INV-02 全关。
 */
export {
  MirrorDriftStatusBar,
  type MirrorDriftStatusBarProps,
} from './MirrorDriftStatusBar';

export {
  createMirrorThreeWayOnAction,
  submitThreeWayViaMirrorIpc,
  type MirrorThreeWaySubmitOpts,
  type MirrorThreeWaySubmitResult,
} from './mirrorThreeWayBridge';

export {
  A_INV_02_UI_DIRECTION_ID,
  isDriftAttention,
  makeMirrorDriftReportView,
  MIRROR_DRIFT_CLASS_LABEL,
  MIRROR_DRIFT_UI_HONESTY,
  MIRROR_WATCH_SOURCE_LABEL,
  resolveThreeWayAction,
  shouldShowThreeWayActions,
  THREE_WAY_ACTION_LABEL,
  type MirrorDriftClass,
  type MirrorDriftReportView,
  type MirrorThreeWayAction,
  type MirrorWatchSource,
  type ResolveThreeWayOpts,
  type ThreeWayDecision,
  type ThreeWayStrategy,
} from './mirrorDriftUi';
