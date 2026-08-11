/**
 * @crish/block-paper
 *
 * 块纸面呈现层（W3-C chrome + W3-D 叶子 Intent + W3-E 代码叶 + W3-F 结构 Intent）：
 * - BlockChromeModel：把手 / 折叠 / 多选高亮 / 静默 L0 / 批量结构 Intent
 * - SlashMenuModel：slash 打开·过滤·关闭·选中 → slash_insert；composing 禁开/禁交
 * - structureIntents：insert/delete/move/collapse/slash_insert + PaperIntent 联合
 * - silentFixture：N 块假文档投影（ProjectionDiff / MemoryBlock）
 * - TextLeafModel / intentBridge / lineWindow：叶子写路径 Intent 通路（默认 mock sink）
 * - CodeLeafModel / mountCodeLeaf / Cm6CodeLeafHost：代码叶（可聚焦 + text_edit + 真 CM6 host）
 * - `submitStructureToCollabWire`：plain Intent → collab wire JSON（真 apply 的 TS 半桥）
 *
 * **包边界**：
 * - 呈现层默认 **mock sink**（W3-D-S）；真 `DocSession::apply` 在 RS（conex-doc-collab）
 * - 写路径必须走 **Intent → wire → sink/IPC → RS apply**；禁止 serialize(DOM) 持久化
 * - **禁止** DOM 当真相；选区权威在 editor-kit SelectionStore 逻辑坐标
 * - UI（React）可后接；本波优先纯 TS 可测
 * - **轨**：W3-D-S 升级面 / W3-D plain Intent 真 apply **子集**；**≠ W3-D-PM**；**≠** W3-D Strict 终局 / EL-01
 * - W3-E 完成 = 代码叶可聚焦 + Intent 通路绿；W3-F-S = 结构 Intent+wire
 * - **W3-E ≠ 全语言高亮完成**（plain + javascript 已接线；其余 lang 后接）
 * - **W3-F ≠ EL-01 关闭**；**≠** A-BLK 全表关闭
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
