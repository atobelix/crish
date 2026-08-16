/**
 * W3-E′ · 跨块多选 / 焦点方向（chrome 呈现桥）。
 *
 * ## SD-56
 * - 类型：`blockSelection.types`（本文件 barrel re-export）
 * - 本文件：range 展开 + `BlockSelectionBridge` 状态机
 * - **≠ EL-01**；**≠** 占 SD-40（不改 BlockChrome / snapshot / types）
 *
 * ## 角色
 * - 在 `BlockChromeModel` 之上提供 **可点名** 的跨块选区模型：
 *   - 多选有序 id（逻辑 blockId，**禁止**像素测距）
 *   - anchor / head（跨块方向端点）
 *   - 与 `focusedBlockId` 的交互策略（可测）
 * - 可选镜像到 `@crish/editor-kit` `SelectionStore.blockMulti`（presence / pin 消费）
 *
 * ## 不变量
 * - 权威仍是逻辑 id 列表；本模块 **不**读 DOM Range / getBoundingClientRect
 * - 投影写路径：`setMultiSelected` / `setFocused` → chrome snapshot
 * - 文本细粒度 caret/range 仍属 editor-kit SelectionStore；本桥主责 **块级** multi + focus
 *
 * ## 诚实边界
 * - **方向包**，可点名可测；**≠ EL-01**；**≠** Notion 级框选 e2e 完成
 * - **≠** 重复 W3-E code 叶首批；**≠** 重写 PaperList
 *
 * 测：`blockSelection.multiSelect.test.ts`
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { SelectionStore } from '@crish/editor-kit';
import type { BlockChromeModel } from './BlockChrome';
import type {
  BlockSelectionBridgeOptions,
  BlockSelectionMode,
  BlockSelectionSnapshot,
  ClearMultiOptions,
  SetFocusedOptions,
  SetMultiSelectedOptions,
} from './blockSelection.types';

export type {
  BlockSelectionMode,
  BlockSelectionSnapshot,
  SetMultiSelectedOptions,
  ClearMultiOptions,
  SetFocusedOptions,
  BlockSelectionBridgeOptions,
} from './blockSelection.types';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function dedupeIds(blockIds: readonly BlockId[]): BlockId[] {
  const seen = new Set<BlockId>();
  const ids: BlockId[] = [];
  for (const id of blockIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 按文档序展开 [anchor, head] 闭区间（含端点，方向无关）。
 * order 中找不到的端点：退化为仅保留有效端点 id。
 */
export function expandBlockRange(
  blockOrder: readonly BlockId[],
  anchorId: BlockId,
  headId: BlockId
): BlockId[] {
  if (!anchorId && !headId) return [];
  if (!anchorId) return headId ? [headId] : [];
  if (!headId) return [anchorId];
  if (anchorId === headId) return [anchorId];

  const iA = blockOrder.indexOf(anchorId);
  const iH = blockOrder.indexOf(headId);
  if (iA < 0 && iH < 0) return dedupeIds([anchorId, headId]);
  if (iA < 0) return [headId];
  if (iH < 0) return [anchorId];

  const lo = Math.min(iA, iH);
  const hi = Math.max(iA, iH);
  return blockOrder.slice(lo, hi + 1).filter((id) => !!id);
}

function resolveMode(
  multi: readonly BlockId[],
  focused: BlockId | null
): BlockSelectionMode {
  if (multi.length > 0) return 'blockMulti';
  if (focused) return 'focusOnly';
  return 'none';
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * 跨块多选 / 焦点方向桥：状态可测，投影到 `BlockChromeModel`。
 *
 * 用法（产品 / 测）：
 * ```ts
 * const chrome = new BlockChromeModel();
 * const sel = new BlockSelectionBridge(chrome, { blockOrder: ids });
 * sel.selectBlockRange('b1', 'b3'); // multi + focus head
 * sel.clearMultiSelected();         // 清 multi，默认可保留 focus
 * ```
 */
export class BlockSelectionBridge {
  private readonly chrome: BlockChromeModel;
  private blockOrder: BlockId[];
  private readonly selectionStore: SelectionStore | undefined;

  private anchorBlockId: BlockId | null = null;
  private headBlockId: BlockId | null = null;

  constructor(
    chrome: BlockChromeModel,
    options: BlockSelectionBridgeOptions = {}
  ) {
    this.chrome = chrome;
    this.blockOrder = options.blockOrder ? dedupeIds(options.blockOrder) : [];
    this.selectionStore = options.selectionStore;
  }

  /** 更新文档序（结构 op 后由宿主调用） */
  setBlockOrder(blockOrder: readonly BlockId[]): void {
    this.blockOrder = dedupeIds(blockOrder);
  }

  getBlockOrder(): readonly BlockId[] {
    return this.blockOrder;
  }

  /**
   * 设置块多选高亮并投影到 chrome。
   * 空列表 → clear multi（焦点策略见 `clearMultiSelected` 默认）。
   */
  setMultiSelected(
    blockIds: readonly BlockId[],
    options: SetMultiSelectedOptions = {}
  ): BlockSelectionSnapshot {
    const ids = dedupeIds(blockIds);
    if (ids.length === 0) {
      return this.clearMultiSelected({ clearFocus: false });
    }

    const focusHead = options.focusHead !== false;
    let anchor =
      options.anchorBlockId !== undefined
        ? options.anchorBlockId
        : (ids[0] ?? null);
    let head =
      options.headBlockId !== undefined
        ? options.headBlockId
        : (ids[ids.length - 1] ?? null);

    // 钳制：显式 anchor/head 若不在 multi 内，回落到首/末
    if (anchor && !ids.includes(anchor)) anchor = ids[0] ?? null;
    if (head && !ids.includes(head)) head = ids[ids.length - 1] ?? null;
    if (!anchor) anchor = ids[0] ?? null;
    if (!head) head = ids[ids.length - 1] ?? null;

    this.anchorBlockId = anchor;
    this.headBlockId = head;
    this.chrome.setMultiSelected(ids);

    if (focusHead && head) {
      this.chrome.setFocused(head);
    }

    this.mirrorBlockMulti(ids);
    return this.getSnapshot();
  }

  /**
   * 清空多选高亮。
   * 默认保留焦点；`clearFocus: true` 时焦点一并清。
   */
  clearMultiSelected(options: ClearMultiOptions = {}): BlockSelectionSnapshot {
    this.chrome.clearMultiSelected();
    this.anchorBlockId = null;
    this.headBlockId = null;

    if (options.clearFocus) {
      this.chrome.setFocused(null);
    } else {
      // head 退化为当前焦点（便于后续 range 扩展）
      const focused = this.chrome.getSnapshot().focusedBlockId;
      this.anchorBlockId = focused;
      this.headBlockId = focused;
    }

    this.mirrorBlockMulti([]);
    return this.getSnapshot();
  }

  /**
   * 设置焦点块，并与 multi 交互。
   *
   * 默认策略（`clearMultiIfOutside: true`）：
   * - 焦点在 multi 外 → 清 multi，进入 focusOnly
   * - 焦点在 multi 内 → 保留 multi，可选更新 head
   * - blockId null → 仅失焦；multi 保留
   */
  setFocused(
    blockId: BlockId | null,
    options: SetFocusedOptions = {}
  ): BlockSelectionSnapshot {
    const clearOutside = options.clearMultiIfOutside !== false;
    const updateHead = options.updateHeadIfInside !== false;
    const id = blockId && blockId.length > 0 ? blockId : null;

    const multi = this.chrome.getSnapshot().multiSelectedIds;

    if (id === null) {
      this.chrome.setFocused(null);
      return this.getSnapshot();
    }

    if (multi.length > 0 && multi.includes(id)) {
      this.chrome.setFocused(id);
      if (updateHead) {
        this.headBlockId = id;
        if (!this.anchorBlockId) this.anchorBlockId = multi[0] ?? id;
      }
      return this.getSnapshot();
    }

    if (multi.length > 0 && clearOutside) {
      this.chrome.clearMultiSelected();
      this.mirrorBlockMulti([]);
      this.anchorBlockId = id;
      this.headBlockId = id;
      this.chrome.setFocused(id);
      return this.getSnapshot();
    }

    // 无 multi，或 outside 但保留 multi
    this.chrome.setFocused(id);
    if (multi.length === 0) {
      this.anchorBlockId = id;
      this.headBlockId = id;
    }
    return this.getSnapshot();
  }

  /**
   * 跨块连续多选：按 `blockOrder` 展开 [anchor, head] 闭区间。
   * 投影 multi + 默认 focus head。
   */
  selectBlockRange(
    anchorId: BlockId,
    headId: BlockId,
    options: Omit<SetMultiSelectedOptions, 'anchorBlockId' | 'headBlockId'> = {}
  ): BlockSelectionSnapshot {
    if (!anchorId && !headId) {
      return this.clearMultiSelected();
    }
    const ids =
      this.blockOrder.length > 0
        ? expandBlockRange(this.blockOrder, anchorId, headId)
        : dedupeIds([anchorId, headId].filter(Boolean) as BlockId[]);

    return this.setMultiSelected(ids, {
      ...options,
      anchorBlockId: anchorId || ids[0] || null,
      headBlockId: headId || ids[ids.length - 1] || null,
    });
  }

  /**
   * 切换单块是否在 multi 中（checkbox / Ctrl 点块语义方向）。
   * - 加入：append 到 multi；head = 该块；可选 focus
   * - 移除：若清空则走 clear；否则重算 anchor/head
   */
  toggleMulti(
    blockId: BlockId,
    options: { focusHead?: boolean } = {}
  ): BlockSelectionSnapshot {
    if (!blockId) return this.getSnapshot();
    const cur = this.chrome.getSnapshot().multiSelectedIds;
    const set = new Set(cur);
    if (set.has(blockId)) {
      const next = cur.filter((id) => id !== blockId);
      if (next.length === 0) {
        return this.clearMultiSelected({ clearFocus: false });
      }
      return this.setMultiSelected(next, {
        focusHead: options.focusHead !== false,
        anchorBlockId:
          this.anchorBlockId && next.includes(this.anchorBlockId)
            ? this.anchorBlockId
            : (next[0] ?? null),
        headBlockId: next[next.length - 1] ?? null,
      });
    }
    const next = [...cur, blockId];
    return this.setMultiSelected(next, {
      focusHead: options.focusHead !== false,
      anchorBlockId: this.anchorBlockId ?? cur[0] ?? blockId,
      headBlockId: blockId,
    });
  }

  /**
   * 从 chrome 当前 multi/focus 反推 bridge 端点（宿主外写 chrome 后对齐）。
   * multi 非空：anchor=首、head=焦点∩multi 否则末。
   */
  syncFromChrome(): BlockSelectionSnapshot {
    const snap = this.chrome.getSnapshot();
    const multi = snap.multiSelectedIds;
    if (multi.length === 0) {
      this.anchorBlockId = snap.focusedBlockId;
      this.headBlockId = snap.focusedBlockId;
    } else {
      this.anchorBlockId = multi[0] ?? null;
      const focused = snap.focusedBlockId;
      this.headBlockId =
        focused && multi.includes(focused)
          ? focused
          : (multi[multi.length - 1] ?? null);
    }
    this.mirrorBlockMulti(multi);
    return this.getSnapshot();
  }

  getSnapshot(): BlockSelectionSnapshot {
    const chrome = this.chrome.getSnapshot();
    return {
      mode: resolveMode(chrome.multiSelectedIds, chrome.focusedBlockId),
      multiSelectedIds: [...chrome.multiSelectedIds],
      anchorBlockId: this.anchorBlockId,
      headBlockId: this.headBlockId,
      focusedBlockId: chrome.focusedBlockId,
      chrome,
    };
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private mirrorBlockMulti(ids: readonly BlockId[]): void {
    this.selectionStore?.setBlockMulti(ids);
  }
}
