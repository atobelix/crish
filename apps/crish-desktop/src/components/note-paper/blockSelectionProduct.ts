/**
 * W3-E-desk · 产品挂 BlockSelectionBridge（薄适配）
 *
 * ## 角色
 * - 库侧 W3-E′ `BlockSelectionBridge` 已有；本模块 = 桌面 note-paper / DomMount
 *   **统一写入口** 的工厂 + 可观测 data 属性投影
 * - setMulti / clear / focus 策略经 bridge → chrome；产品宿主可读 `data-sel-*`
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠** Notion 框选 e2e；**≠** 重复 code 叶 / w3f_dom 回退
 * - 权威仍是逻辑 blockId；不读 DOM Range / getBoundingClientRect
 * - CONN-C pin 仍消费 `chrome.focusedBlockId`（bridge.setFocused 投影之）
 *
 * 测：`blockSelectionProduct.test.tsx`
 */

import {
  BlockSelectionBridge,
  type BlockChromeModel,
  type BlockSelectionBridgeOptions,
  type BlockSelectionSnapshot,
} from '@crish/block-paper';

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export type CreateProductBlockSelectionOptions = BlockSelectionBridgeOptions;

/**
 * 产品默认装配：chrome + 可选 blockOrder / SelectionStore 镜像。
 * 宿主可注入既有 bridge；本工厂供 DomMount / Strict 缺省路径。
 */
export function createProductBlockSelection(
  chrome: BlockChromeModel,
  options: CreateProductBlockSelectionOptions = {}
): BlockSelectionBridge {
  return new BlockSelectionBridge(chrome, options);
}

// ---------------------------------------------------------------------------
// 可观测 data 属性（DOM / 面板）
// ---------------------------------------------------------------------------

/** 选区 data 属性名（契约锚，测可点名） */
export const SEL_DATA_MODE = 'data-sel-mode';
export const SEL_DATA_MULTI = 'data-sel-multi';
export const SEL_DATA_FOCUS = 'data-sel-focus';
export const SEL_DATA_ANCHOR = 'data-sel-anchor';
export const SEL_DATA_HEAD = 'data-sel-head';
/** 产品已挂 bridge 写入口（1 = 经 BlockSelectionBridge） */
export const SEL_DATA_BRIDGE = 'data-sel-bridge';

/**
 * 选区快照 → 宿主 data 属性字典（可测）。
 * multi 以 `,` 连接保序 id；空串 = 无。
 */
export function blockSelectionSnapshotToDataAttrs(
  snap: BlockSelectionSnapshot
): Record<string, string> {
  return {
    [SEL_DATA_MODE]: snap.mode,
    [SEL_DATA_MULTI]: snap.multiSelectedIds.join(','),
    [SEL_DATA_FOCUS]: snap.focusedBlockId ?? '',
    [SEL_DATA_ANCHOR]: snap.anchorBlockId ?? '',
    [SEL_DATA_HEAD]: snap.headBlockId ?? '',
    [SEL_DATA_BRIDGE]: '1',
  };
}

/** 把选区快照写到 DOM 元素（DomMount 根 / 面板根） */
export function applyBlockSelectionDataAttrs(
  el: HTMLElement,
  snap: BlockSelectionSnapshot
): void {
  const attrs = blockSelectionSnapshotToDataAttrs(snap);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
}

/**
 * 从 chrome 当前 multi/focus 对齐 bridge 端点后投影 data。
 * 宿主外写 chrome（如 DomHost checkbox）后调用，避免 anchor/head 漂移。
 */
export function syncAndApplyBlockSelectionDataAttrs(
  el: HTMLElement,
  selection: BlockSelectionBridge
): BlockSelectionSnapshot {
  const snap = selection.syncFromChrome();
  applyBlockSelectionDataAttrs(el, snap);
  return snap;
}
