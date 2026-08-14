/**
 * W3-E′ 跨块选区公开类型（SD-56 · types）。
 *
 * 桥状态机 / range 展开见 `blockSelection`（`BlockSelectionBridge` / `expandBlockRange`）。
 * 既有调用方仍从 `./blockSelection` 取类型（barrel re-export）。
 *
 * 权威仍是逻辑 blockId；**禁止** getBoundingClientRect / 像素测距。
 * **≠ EL-01**；**≠** 占 SD-40（不改 BlockChrome / snapshot / types）。
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { SelectionStore } from '@crish/editor-kit';
import type { BlockChromeSnapshot } from './BlockChrome.types';

/** 块级选区模式（可点名） */
export type BlockSelectionMode = 'none' | 'blockMulti' | 'focusOnly';

/**
 * 跨块 / 焦点选区只读快照。
 * - `multiSelectedIds`：与 chrome 投影一致（去重保序）
 * - `anchorBlockId` / `headBlockId`：跨块方向端点（单选/焦点时二者可同为 focus）
 */
export type BlockSelectionSnapshot = {
  mode: BlockSelectionMode;
  multiSelectedIds: BlockId[];
  anchorBlockId: BlockId | null;
  headBlockId: BlockId | null;
  focusedBlockId: BlockId | null;
  /** 最近一次投影后的 chrome 快照（拷贝语义由 chrome 保证） */
  chrome: BlockChromeSnapshot;
};

export type SetMultiSelectedOptions = {
  /**
   * 是否把 head（列表末项）同步为 chrome 焦点。
   * 默认 true：多选后焦点落在扩展端，便于键盘/批量 op 回落。
   */
  focusHead?: boolean | undefined;
  /**
   * 显式指定 anchor；缺省 = 列表首项。
   * 须在 multi 列表内（或会被钳到首/末）。
   */
  anchorBlockId?: BlockId | null | undefined;
  /** 显式 head；缺省 = 列表末项 */
  headBlockId?: BlockId | null | undefined;
};

export type ClearMultiOptions = {
  /**
   * 清空多选时是否一并清焦点。
   * 默认 false：保留 focusedBlockId（A-SIL 噪声仅清 multi 高亮）。
   */
  clearFocus?: boolean | undefined;
};

export type SetFocusedOptions = {
  /**
   * 焦点落在 multi **之外**时是否清多选。
   * 默认 true：单点焦点与块多选互斥（后写焦点覆盖 multi）。
   * false：保留 multi 高亮（仅移动 focusedBlockId）。
   */
  clearMultiIfOutside?: boolean | undefined;
  /**
   * 焦点落在 multi **之内**时是否把 head 更新为该块。
   * 默认 true。
   */
  updateHeadIfInside?: boolean | undefined;
};

export type BlockSelectionBridgeOptions = {
  /**
   * 块文档序（逻辑 id）；`selectBlockRange` 用其展开连续区间。
   * 可后续 `setBlockOrder` 更新；缺省时空 range 仅选端点。
   */
  blockOrder?: readonly BlockId[] | undefined;
  /**
   * 可选：镜像块多选到 editor-kit SelectionStore（`setBlockMulti`）。
   * 文本 caret/range **不**由本桥写入。
   */
  selectionStore?: SelectionStore | undefined;
};
