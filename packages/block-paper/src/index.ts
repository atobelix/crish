/**
 * @crish/block-paper
 *
 * 块纸面呈现层：chrome（把手 / 折叠 / 多选）、slash 菜单、结构 Intent、文本叶（plain / ProseMirror）
 * 与代码叶（CM6）、MD 前缀与 turn-into、PaperList 窗口挂载。
 * 生产写路径：Intent → collab wire → 注入 `applyOps`（RS `DocSession::apply`）；禁止 serialize(DOM) 持久化。
 * 假数据工厂与 mock sink 只留在各实现文件里，不在本入口导出（测试直引实现文件）。
 */

// Block chrome 状态
export {
  BlockChromeModel,
  type SilentLevel,
  type HandleVisibility,
  type BlockChromeSnapshot,
  type ChromeStructureRejectCode,
  type ChromeStructureResult,
  type ChromeStructureOptions,
  type BlockChromeModelOptions,
} from './chrome/BlockChrome';

// W3-E′：跨块多选 / 焦点方向桥（chrome 投影；≠ EL-01；≠ 重复 code 叶）
export {
  BlockSelectionBridge,
  expandBlockRange,
  type BlockSelectionMode,
  type BlockSelectionSnapshot,
  type SetMultiSelectedOptions,
  type ClearMultiOptions,
  type SetFocusedOptions,
  type BlockSelectionBridgeOptions,
} from './chrome/blockSelection';

// Slash 菜单
export {
  SlashMenuModel,
  filterSlashCatalog,
  DEFAULT_SLASH_CATALOG,
  type IsComposingFn,
  type SlashOpenResult,
  type SlashSelectResult,
  type SlashMenuItemView,
  type SlashMenuSnapshot,
  type SlashMenuModelOptions,
} from './chrome/SlashMenuModel';

// Slash 选中 → Intent → sink（React 浮层 / 键盘确认共用）
export {
  selectSlashItemAndSubmit,
  selectSlashActiveAndSubmit,
  groupSlashCatalogItems,
  type SlashSelectAndSubmitOk,
  type SlashSelectAndSubmitFail,
  type SlashSelectAndSubmitResult,
  type SlashCatalogSegment,
} from './chrome/slashSelectAndSubmit';

// W3-F DOM 余量：chrome 最小 DOM 宿主 + 拖拽预览子集（≠ EL-01 / ≠ A-BLK e2e 全关）
export {
  BlockChromeDomHost,
  isBlockChromeDomHost,
  BP_CHROME_ROOT,
  BP_BLOCK_ROW,
  BP_BLOCK_ID,
  BP_HANDLE,
  BP_HANDLE_VISIBILITY,
  BP_MULTI_CHECK,
  BP_DROP_LINE,
  BP_DROP_SIDE,
  BP_DROP_TARGET,
  BP_SLASH_HOST,
  BP_SLASH_OPEN,
  BP_SLASH_ITEM,
  BP_SLASH_GROUP,
  BP_SLASH_EMPTY,
  BP_DRAG_PREVIEW,
  BP_DRAG_SOURCE,
  BP_DRAGGING,
  type DropLineSide,
  type DropLineTarget,
  type DragPreviewState,
  type DragPointerShape,
  type ChromeDomBlockSpec,
  type BlockChromeDomHostOptions,
} from './chrome/BlockChromeDomHost';

// W3-F：结构 Intent + PaperIntent 联合
export {
  isStructureIntent,
  isPaperIntent,
  buildInsertBlockIntent,
  buildDeleteBlocksIntent,
  buildMoveBlocksIntent,
  buildToggleCollapseIntent,
  buildSlashInsertIntent,
  structureIntentToOps,
  structureIntentToOp,
  paperIntentToOps,
  submitStructureToCollabWire,
  type StructureIntentOrigin,
  type StructureIntentType,
  type StructureToOpsOptions,
  type StructureCollabWirePayload,
  type InsertBlockIntent,
  type DeleteBlocksIntent,
  type MoveBlocksIntent,
  type ToggleCollapseIntent,
  type SlashInsertIntent,
  type StructureIntent,
  type TextIntent,
  type PaperIntent,
  type BuildIntentIdFn,
  type BuildInsertBlockInput,
  type BuildDeleteBlocksInput,
  type BuildMoveBlocksInput,
  type BuildToggleCollapseInput,
  type BuildSlashInsertInput,
} from './chrome/structureIntents';

// ---------------------------------------------------------------------------
// W3-D：叶子文本 Intent + 真 apply sink 工厂
// ---------------------------------------------------------------------------

export {
  TextLeafModel,
  type TextLeafSnapshot,
  type TextLeafModelOptions,
} from './leaves/TextLeafModel';

export {
  submitIntent,
  /** 生产默认：Intent → wire → applyOps（DocSession::apply 等价） */
  createCollabApplySink,
  createDocSessionApplySink,
  type IntentSink,
  type IntentSinkResult,
  type SubmitIntentOptions,
  type SubmitIntentResult,
  type SubmitIntentRejectCode,
  type SubmittableIntent,
  type ApplyOpsAdapter,
  type CollabApplySinkOptions,
  type CollabApplySink,
} from './leaves/intentBridge';

export {
  DEFAULT_PM_NODE_SOFT_BYTES,
  DEFAULT_EDIT_WINDOW_LINES,
  DEFAULT_CHAR_WINDOW,
  utf8ByteLength,
  shouldUseLineWindow,
  splitLines,
  getOffsetWindow,
  getLineWindowSlice,
  computeLineWindow,
  type TextSlice,
  type LineWindowConfig,
  type LineWindowResult,
} from './leaves/lineWindow';

// ---------------------------------------------------------------------------
// W3-D-PM：真 ProseMirror 叶（sink 可仍 mock；≠ W3-D 真 apply；≠ EL-01）
// ---------------------------------------------------------------------------

export {
  leafInlineSchema,
  pmLeafSchema,
  textToLeafDoc,
  leafDocToText,
  textOffsetToPmPos,
  pmPosToTextOffset,
  PmTextLeaf,
  isPmTextLeaf,
  PmTextLeafHost,
  createPmLeafEditorState,
  isPmTextLeafHost,
  type PmTextLeafSnapshot,
  type PmTextLeafOptions,
  type PmTextLeafHostOptions,
} from './leaves/pm';

// ---------------------------------------------------------------------------
// W3-G：PaperList 仅窗口 DOM（假数据投影可测；≠ 权威树；≠ EL-01）
// ---------------------------------------------------------------------------

export {
  buildMountPlanByWindow,
  buildMountPlanByScroll,
  PaperList,
  isPaperList,
  BP_PAPER_LIST,
  BP_PAPER_BLOCK,
  BP_PAPER_BLOCK_ID,
  BP_PAPER_SPACER_BEFORE,
  BP_PAPER_SPACER_AFTER,
  BP_PAPER_MOUNTED_COUNT,
  BP_PAPER_TOTAL_COUNT,
  type PaperBlockProjection,
  type BuildMountPlanByWindowInput,
  type BuildMountPlanByScrollInput,
  type MountPlan,
  type PaperListOptions,
  type PaperListScrollState,
  type PaperListWindowState,
} from './list';

// ---------------------------------------------------------------------------
// W3-E：CM6 代码叶方向子集
// 可聚焦 + text_edit + 真 CM6 host + flavour/fence→collab kind 映射 + 只读呈现
// **≠** 产品 e2e 满关；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
// ---------------------------------------------------------------------------

export {
  CodeLeafModel,
  DomCodeLeafHost,
  mountCodeLeaf,
  Cm6CodeLeafHost,
  createCm6EditorState,
  resolveCm6LanguageExtension,
  isCm6HighlightedLanguage,
  isCm6CodeLeafHost,
  CODE_FLAVOUR_IDS,
  CODE_COLLAB_KIND,
  isCodeFlavour,
  codeFlavourToCollabKind,
  isCodeCollabKind,
  parseFenceInfo,
  fenceOpenToLanguage,
  resolveCodeLeafLanguage,
  codeLeafAttrsForLanguage,
  resolveCodeLeafKindAndLanguage,
  mountReadonlyCodePresentation,
  createReadonlyCodeSnapshot,
  createReadonlyCodeLeafModel,
  BP_CODE_READONLY,
  BP_CODE_READONLY_CODE,
  type CodeLanguage,
  type CodeLeafSnapshot,
  type CodeLeafModelOptions,
  type CodeEditRejectCode,
  type CodeEditAttempt,
  type CodeLeafHost,
  type MountCodeLeafOptions,
  type CodeLeafMount,
  type Cm6CodeLeafHostOptions,
  type CreateCm6EditorStateOptions,
  type Cm6EditorStateBundle,
  type CodeFlavourId,
  type CodeCollabKind,
  type ResolveCodeLeafLanguageInput,
  type CodeLeafKindResolution,
  type ReadonlyCodePresentationSnapshot,
  type MountReadonlyCodePresentationOptions,
  type ReadonlyCodePresentationMount,
} from './leaves/code';

// ---------------------------------------------------------------------------
// W3-H 方向：MD 前缀快路径 / turn-into / 未知 flavour 占位（≠ A-BLK 全表 e2e / ≠ EL-01）
// ---------------------------------------------------------------------------

export {
  matchMdPrefix,
  shouldTriggerMdPrefix,
  stripMdPrefix,
  firstLineOf,
  mdPrefixRuleCount,
  type MdPrefixRuleId,
  type MdPrefixMatch,
} from './leaves/mdPrefix';

export {
  buildTurnIntoIntent,
  isTurnIntoIntent,
  clampLogicalSelection,
  tryMdPrefixFastPath,
  submitTurnIntoIntent,
  turnIntoToStructureKey,
  turnIntoIntentToProvisionalOps,
  turnIntoStripToTextEdit,
  type TurnIntoTrigger,
  type LogicalSelection,
  type TurnIntoIntent,
  type BuildTurnIntoInput,
  type MdPrefixFastPathRejectCode,
  type MdPrefixFastPathResult,
  type TryMdPrefixFastPathInput,
  type TurnIntoSink,
  type TurnIntoSinkResult,
  type SubmitTurnIntoOptions,
  type SubmitTurnIntoResult,
} from './leaves/turnInto';

export {
  isUnknownCollabKind,
  isUnknownFlavour,
  createUnknownFlavourPlaceholder,
  tryCreateUnknownFlavourPlaceholder,
  placeholderWithText,
  type UnknownCollabKind,
  type UnknownFlavourPlaceholderSnapshot,
  type CreateUnknownFlavourPlaceholderInput,
} from './leaves/unknownFlavourPlaceholder';

// W3-H 产品输入接线（叶 → turn_into sink；CONN-D RS kind 可变；≠ EL-01）
export {
  commitMdPrefixFromLeaf,
  simulateMdPrefixSubmit,
  tryMdPrefixAfterLeafEdit,
  createTurnIntoProvisionalCollabSink,
  createProductIntentAuditSinks,
  type MdPrefixLeafSnapshot,
  type MdPrefixCommitOptions,
  type MdPrefixCommitOk,
  type MdPrefixCommitFail,
  type MdPrefixCommitResult,
  type SimulateMdPrefixSubmitInput,
  type SimulateMdPrefixSubmitResult,
  type TurnIntoProvisionalCollabSink,
  type ProductIntentAuditEntry,
  type ProductIntentAuditSinks,
} from './leaves/mdPrefixHost';
