/**
 * @crish/block-paper
 *
 * 块纸面 **呈现 chrome**（W3-C）：
 * - BlockChromeModel：把手 / 折叠 / 多选高亮 / 静默 L0
 * - SlashMenuModel：slash 打开·过滤·关闭；composing 禁开
 * - silentFixture：N 块假文档投影（ProjectionDiff / MemoryBlock）
 *
 * **包边界**：
 * - 本包是呈现 chrome / 假数据骨架，**不接真实后端**
 * - 写路径必须走 **Intent → RS apply**；禁止 serialize(DOM) 持久化
 * - **禁止** DOM 当真相；选区权威在 editor-kit SelectionStore 逻辑坐标
 * - UI（React）可后接；本波优先纯 TS 可测
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
