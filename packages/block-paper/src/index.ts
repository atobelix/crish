/**
 * @crish/block-paper
 *
 * 块纸面呈现层（W3-C chrome + W3-D 叶子 Intent 骨架）：
 * - BlockChromeModel：把手 / 折叠 / 多选高亮 / 静默 L0
 * - SlashMenuModel：slash 打开·过滤·关闭；composing 禁开
 * - silentFixture：N 块假文档投影（ProjectionDiff / MemoryBlock）
 * - TextLeafModel / intentBridge / lineWindow：叶子写路径 Intent 通路（mock apply）
 *
 * **包边界**：
 * - 本包是呈现 chrome / 叶子写路径骨架，**不接真实后端**
 * - 写路径必须走 **Intent → sink → RS apply**；禁止 serialize(DOM) 持久化
 * - **禁止** DOM 当真相；选区权威在 editor-kit SelectionStore 逻辑坐标
 * - UI（React）可后接；本波优先纯 TS 可测
 * - W3-D 完成 = Intent 通路绿；**≠** EL-01 / A-BLK 全表关闭
 */

// Block chrome 状态
export {
  BlockChromeModel,
  type SilentLevel,
  type HandleVisibility,
  type BlockChromeSnapshot,
} from './chrome/BlockChrome';

// Slash 菜单
export {
  SlashMenuModel,
  filterSlashCatalog,
  DEFAULT_SLASH_CATALOG,
  type IsComposingFn,
  type SlashOpenResult,
  type SlashMenuItemView,
  type SlashMenuSnapshot,
  type SlashMenuModelOptions,
} from './chrome/SlashMenuModel';

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
