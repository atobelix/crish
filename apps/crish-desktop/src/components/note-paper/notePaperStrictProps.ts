/**
 * NotePaperStrictPanel 公开 Props（SD-04-R 从装配壳拆出）。
 * 语义与默认行为见 `NotePaperStrictPanel.tsx` 模块头；**≠ EL-01**。
 */

import type {
  BlockChromeDomHost,
  BlockChromeModel,
  BlockSelectionBridge,
  IntentSink,
  PaperList,
  PaperListScrollState,
  PaperListWindowState,
  SlashInsertIntent,
  SlashMenuModel,
  SlashOpenResult,
  TurnIntoIntent,
  TurnIntoSink,
} from '@crish/block-paper';
import type { SlashOverlayWriteMode } from './SlashMenuOverlay';
import type { NoteHydrateTransport } from './hydrateProjection';
import type {
  ProductMdPrefixBinding,
  ProductMdPrefixCommitResult,
  ProductMdPrefixSinkSource,
  ProductMdPrefixWriteMode,
} from './noteMdPrefixBridge';
import type { PresentationMode } from './presentationMode';
import type {
  MirrorDriftReportView,
  MirrorWatchSource,
  ThreeWayDecision,
} from './mirrorDriftUi';
import type { ProductSlashSinkSource } from './productSlashSink';

/**
 * Strict 上可点名挂载的 PaperList 配置（W3-G 产品挂载子集）。
 * **≠ EL-01**；**≠ W3-P**。
 * 产品默认：开启 paperList 时走 `paper-list`（**不**再默认同屏 content-row）。
 */
export type NotePaperStrictPaperListConfig = {
  window?: PaperListWindowState;
  scroll?: PaperListScrollState;
  overscan?: number;
  focusId?: string | null;
  composingIds?: readonly string[];
  defaultVisibleCount?: number;
  defaultEstimatePx?: number;
  /**
   * 内容呈现模式（SD-04）。优先于 `keepReactRows`。
   * 省略：产品默认 `paper-list`（与 content-row 互斥）。
   */
  presentationMode?: PresentationMode;
  /**
   * @deprecated 请用 `presentationMode`。
   * `true` → `debug-dual`；`false` → `paper-list`。
   * @see PresentationMode / `presentationMode`
   * @removeWhen 调用方全部迁到 `presentationMode` 后删除
   */
  keepReactRows?: boolean;
};

export type NotePaperStrictPanelProps = {
  docId: string;
  /**
   * **必填**：hydrate 通路。产品空态由外层注入；禁止静默回落假数据。
   */
  hydrateTransport: NoteHydrateTransport;
  refreshToken?: number | string;
  chrome?: BlockChromeModel;
  /**
   * W3-E-desk：跨块 multi / focus 统一写入口（`BlockSelectionBridge`）。
   * 省略 → 面板默认 `createProductBlockSelection(chrome)` + hydrate 块序。
   * 注入时与 chrome 须同一实例投影。**≠ EL-01**；**≠** Notion 框选 e2e。
   */
  blockSelection?: BlockSelectionBridge;
  /**
   * 选区桥就绪回调（测可观测 setMulti/clear/focus）。
   * 与 DomMount `onSelectionReady` 同源；0 块 / 卸载时可为 null。
   */
  onBlockSelectionReady?: (selection: BlockSelectionBridge | null) => void;
  slashMenu?: SlashMenuModel;
  /**
   * slash 选中后的 Intent sink。
   * 注入 → 可写；未注 → 默认只读 catalog（CONN-B；禁止可点无写）。
   */
  slashIntentSink?: IntentSink;
  /**
   * slash 写模式覆盖。默认：有 sink → writable；无 → readonly。
   */
  slashWriteMode?: SlashOverlayWriteMode;
  /**
   * 写锥能力来源诚实标注（`data-slash-sink-source`）。
   * 默认：有 sink → injected-sink；无 → none。
   */
  slashSinkSource?: ProductSlashSinkSource;
  /**
   * CONN-D2/D3：MD 前缀 / turn_into 的 TurnInto sink。
   * 注入 → content-row 叶可写；未注 → disabled 静态（`data-md-prefix-write-mode`）。
   * 叶/HiddenInput 经 `commitProductMdPrefixFromLeaf` 提交；**≠ EL-01**。
   */
  turnIntoSink?: TurnIntoSink;
  /**
   * MD 前缀写模式覆盖。默认：有 turnIntoSink → writable；无 → disabled。
   */
  mdPrefixWriteMode?: ProductMdPrefixWriteMode;
  /**
   * MD 前缀能力来源诚实标注（`data-md-prefix-sink-source`）。
   */
  mdPrefixSinkSource?: ProductMdPrefixSinkSource;
  /**
   * CONN-D3：完整产品 binding（优先于 turnIntoSink 拼装；含 collab.wireCalls）。
   * 测可注入 `createProductMdPrefixBinding({ applyOps })` 断言 pending 形状。
   */
  mdPrefixBinding?: ProductMdPrefixBinding;
  /**
   * CONN-D3：叶提交结果（含 disabled/composing 拒绝）；**≠** 旁路写盘。
   */
  onMdPrefixCommit?: (result: ProductMdPrefixCommitResult) => void;
  /** CONN-D3：仅成功 Intent；UI 不得据此把 pending 当 kind */
  onMdPrefixCommittedIntent?: (intent: TurnIntoIntent) => void;
  /**
   * 是否展示「打开斜杠菜单」产品入口（默认 true）。
   * 锚定首块 / 占位锚点 → `openProductSlash`；面板内 **`/`** 键同路径（CONN-B2）。
   * **≠** 完整 IME WebView e2e；**≠ EL-01**。
   */
  showOpenSlashButton?: boolean;
  /**
   * CONN-B2：显式打开 slash 时回调（测 / 宿主）；不替代 model 订阅。
   * 返回 model `SlashOpenResult`（含 composing 拒绝）。
   */
  onSlashOpenResult?: (result: SlashOpenResult) => void;
  onSlashIntent?: (intent: SlashInsertIntent) => void;
  /** DomHost 就绪；**≠ EL-01** */
  onChromeDomHost?: (host: BlockChromeDomHost | null) => void;
  /**
   * W3-G PaperList 可点名挂载。
   * - 省略：内容模式 `react-rows`
   * - true / 对象：产品默认内容模式 `paper-list`（互斥 content-row）
   * 与 chrome **分槽共存**（data-bp-paper-list-mount ∥ data-bp-chrome-mount）。
   */
  paperList?: boolean | NotePaperStrictPaperListConfig;
  /**
   * 面板级内容呈现模式覆盖（SD-04）。
   * 优先于 paperList 配置内 mode / keepReactRows。
   */
  presentationMode?: PresentationMode;
  onPaperListReady?: (list: PaperList | null) => void;
  onClose?: () => void;
  className?: string;
  title?: string;
  /** A-INV-02 方向；**≠ EL-03**；**≠ A-INV-02 全关** */
  mirrorDriftReport?: MirrorDriftReportView | null;
  mirrorWatchSource?: MirrorWatchSource;
  mirrorUnpushedOpCount?: number;
  showMirrorDriftBar?: boolean;
  onMirrorThreeWay?: (decision: ThreeWayDecision) => void;
};
