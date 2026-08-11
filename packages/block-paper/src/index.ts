/**
 * @crish/block-paper
 *
 * 块纸面呈现层（W3-C chrome + W3-D 叶子 Intent + W3-E 代码叶 + W3-F 结构 Intent）：
 * - BlockChromeModel：把手 / 折叠 / 多选高亮 / 静默 L0 / 批量结构 Intent
 * - SlashMenuModel：slash 打开·过滤·关闭·选中 → slash_insert；composing 禁开/禁交
 * - structureIntents：insert/delete/move/collapse/slash_insert + PaperIntent 联合
 * - silentFixture：N 块假文档投影（ProjectionDiff / MemoryBlock）
 * - TextLeafModel / intentBridge / lineWindow：plain 叶子 Intent（W3-D-S；默认 mock sink）
 * - **PmTextLeaf / PmTextLeafHost**：真 prosemirror 叶 → TextEditIntent（**W3-D-PM**；sink 可仍 mock）
 * - CodeLeafModel / mountCodeLeaf / Cm6CodeLeafHost：代码叶（可聚焦 + text_edit + 真 CM6 host）
 * - `submitStructureToCollabWire`：plain Intent → collab wire JSON（真 apply 的 TS 半桥）
 *
 * **包边界**：
 * - 呈现层默认 **mock sink**；真 `DocSession::apply` 在 RS（conex-doc-collab）—— **W3-D 终局**另包
 * - 写路径必须走 **Intent → wire → sink/IPC → RS apply**；禁止 serialize(DOM/pmDoc) 持久化
 * - **禁止** DOM 当真相；选区权威在 editor-kit SelectionStore 逻辑坐标
 * - UI（React）可后接；本波优先纯 TS 可测
 * - **轨**：
 *   - **W3-D-S** = plain TextLeaf + mock
 *   - **W3-D-PM** = 真 PM 适配器入库（本导出 `leaves/pm`）；**≠** 真 apply；**≠** EL-01
 *   - **W3-D** = 真 PM + Intent→真 apply（**本包未宣称**）
 * - W3-E 完成 = 代码叶可聚焦 + Intent 通路绿；W3-F-S = 结构 Intent+wire
 * - **W3-E ≠ 全语言高亮完成**；**W3-F ≠ EL-01 关闭**
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
} from './chrome/BlockChrome';

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

// 静默假数据
export {
  createSilentFixture,
  createSilentProjectionDiff,
  listSilentBlocks,
  type SilentBlockProps,
  type SilentFixtureOptions,
  type SilentFixture,
} from './chrome/silentFixture';

// ---------------------------------------------------------------------------
// W3-D：叶子文本 Intent 通路（mock apply）
// ---------------------------------------------------------------------------

export {
  TextLeafModel,
  nextIntentId,
  resetIntentIdSeqForTests,
  type TextLeafSnapshot,
  type TextLeafModelOptions,
} from './leaves/TextLeafModel';

export {
  submitIntent,
  createMockIntentSink,
  type IntentSink,
  type IntentSinkResult,
  type SubmitIntentOptions,
  type SubmitIntentResult,
  type SubmitIntentRejectCode,
  type SubmittableIntent,
  type MockIntentSink,
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
  diffToReplace,
  isPmTextLeaf,
  PmTextLeafHost,
  createPmLeafEditorState,
  isPmTextLeafHost,
  type PmTextLeafSnapshot,
  type PmTextLeafOptions,
  type PmTextLeafHostOptions,
} from './leaves/pm';

// ---------------------------------------------------------------------------
// W3-E：CM6 代码叶（可聚焦 + text_edit + 真 CM6 host；不接 RS / 不全语言高亮）
// ---------------------------------------------------------------------------

export {
  CodeLeafModel,
  createMockCodeLeafHost,
  DomCodeLeafHost,
  mountCodeLeaf,
  Cm6CodeLeafHost,
  createCm6EditorState,
  resolveCm6LanguageExtension,
  isCm6HighlightedLanguage,
  isCm6CodeLeafHost,
  type CodeLanguage,
  type CodeLeafSnapshot,
  type CodeLeafModelOptions,
  type CodeEditRejectCode,
  type CodeEditAttempt,
  type CodeLeafHost,
  type MockCodeLeafHost,
  type MockCodeLeafHostOptions,
  type MountCodeLeafOptions,
  type CodeLeafMount,
  type Cm6CodeLeafHostOptions,
  type CreateCm6EditorStateOptions,
  type Cm6EditorStateBundle,
} from './leaves/code';
