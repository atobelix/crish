/**
 * @crish/block-paper
 *
 * 块纸面呈现层（W3-C chrome + W3-D 叶子 Intent + W3-E 代码叶 + W3-F 结构 Intent）：
 * - BlockChromeModel：把手 / 折叠 / 多选高亮 / 静默 L0 / 批量结构 Intent
 * - SlashMenuModel：slash 打开·过滤·关闭·选中 → slash_insert；composing 禁开/禁交
 * - structureIntents：insert/delete/move/collapse/slash_insert + PaperIntent 联合
 * - silentFixture：N 块假文档投影（ProjectionDiff / MemoryBlock）
 * - TextLeafModel / intentBridge / lineWindow：plain 叶子 Intent（W3-D-S 形状测可用 mock）
 * - **PmTextLeaf / PmTextLeafHost**：真 prosemirror 叶 → TextEditIntent（**W3-D-PM**）
 * - **`createCollabApplySink`**：**生产默认** Intent → wire → 注入 `applyOps`（真 apply 形状）
 * - CodeLeafModel / mountCodeLeaf / Cm6CodeLeafHost：代码叶（可聚焦 + text_edit + 真 CM6 host）
 * - `submitStructureToCollabWire`：PaperIntent → collab wire JSON（喂 RS `ops_from_json`）
 *
 * **包边界 / 写锥（G-INV-3）**：
 * - **生产写路径**：`createCollabApplySink({ applyOps })` → IPC/库 → `DocSession::apply`
 * - `createMockIntentSink` **仅**形状测；**不得**再当生产默认
 * - 真 apply 库侧绿：`conex-doc-collab` 集成测 `w3_d_*`（TextEdit + Structure → 树/`read_text`）
 * - 禁止 serialize(DOM/pmDoc) 持久化；禁止 DOM 当真相
 * - **轨**：
 *   - **W3-D-S** = plain TextLeaf + mock（形状）
 *   - **W3-D-PM** = 真 PM 适配器入库；单独 **≠** W3-D 终局
 *   - **W3-D** = 真 PM + TextEdit/Structure Intent → 真 apply（本包工厂 + RS 集成）
 *   - **≠ EL-01**；**≠ A-BLK 全表 e2e**；**≠** 块工作区完成
 * - W3-E 完成 = 代码叶可聚焦 + Intent 通路绿；W3-F-S = 结构 Intent+wire
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
// W3-D：叶子文本 Intent + 真 apply sink 工厂
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
  /** 生产默认：Intent → wire → applyOps（DocSession::apply 等价） */
  createCollabApplySink,
  createDocSessionApplySink,
  /** 仅测形状；禁止作生产默认写路径 */
  createMockIntentSink,
  type IntentSink,
  type IntentSinkResult,
  type SubmitIntentOptions,
  type SubmitIntentResult,
  type SubmitIntentRejectCode,
  type SubmittableIntent,
  type MockIntentSink,
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
