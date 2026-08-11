/**
 * SelectionStore：逻辑选区权威（blockId + offset / 块多选）。
 *
 * 对齐：
 * - round-D `05-投影虚拟化与IME.md` §4（LogicPos / LogicRange / EditorSel）
 * - A-SEL-01：逻辑坐标往返；**禁止**像素测距选块
 * - W0：选区不进文档 Op 历史（可镜像 presence）
 *
 * 不变量：
 * - 权威在逻辑坐标；DOM Range 仅派生视图
 * - 文本选与块多选互斥（后写覆盖）
 * - 不依赖像素测距 / getBoundingClientRect 选块
 */

import type { BlockId } from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// 逻辑坐标（权威）
// ---------------------------------------------------------------------------

/** 块内逻辑位置：offset = 块内逻辑偏移（grapheme / UTF-16 由 IME 矩阵统一） */
export type LogicPos = {
  blockId: BlockId;
  offset: number;
};

/** 有方向文本选区；折叠时 anchor === head */
export type LogicRange = {
  anchor: LogicPos;
  head: LogicPos;
};

/** 块多选（有序 id 列表；顺序由调用方保证） */
export type BlockMultiSel = {
  blockIds: BlockId[];
};

/**
 * 编辑器选区联合。
 * - `caret`：折叠文本选（光标）
 * - `range`：跨点文本选（可同块或跨块）
 * - `blockMulti`：块级多选
 * - `none`：无选区
 */
export type EditorSel =
  | { type: 'caret'; pos: LogicPos }
  | { type: 'range'; range: LogicRange }
  | { type: 'blockMulti'; blockIds: BlockId[] }
  | { type: 'none' };

/** 只读快照（getSnapshot 返回） */
export type SelectionSnapshot = {
  sel: EditorSel;
  /**
   * 应 pin 的块（锚点 / head / 多选成员）。
   * 供 WindowManager 与 buildPinSet.extraPinned 使用。
   */
  pinnedBlockIds: BlockId[];
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  // 上限由文档长度在 Diff 后钳制；此处仅防 NaN/负
  return Math.floor(offset);
}

function normalizePos(pos: LogicPos): LogicPos {
  if (!pos.blockId) {
    throw new Error('SelectionStore：LogicPos.blockId 不可为空');
  }
  return { blockId: pos.blockId, offset: clampOffset(pos.offset) };
}

function isSamePos(a: LogicPos, b: LogicPos): boolean {
  return a.blockId === b.blockId && a.offset === b.offset;
}

/**
 * 从 EditorSel 收集须 pin 的 blockId（去重、保序）。
 */
export function collectPinnedFromSel(sel: EditorSel): BlockId[] {
  switch (sel.type) {
    case 'none':
      return [];
    case 'caret':
      return sel.pos.blockId ? [sel.pos.blockId] : [];
    case 'range': {
      const ids: BlockId[] = [];
      const seen = new Set<BlockId>();
      for (const id of [sel.range.anchor.blockId, sel.range.head.blockId]) {
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      return ids;
    }
    case 'blockMulti': {
      const ids: BlockId[] = [];
      const seen = new Set<BlockId>();
      for (const id of sel.blockIds) {
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      return ids;
    }
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * 本地逻辑选区存储（stub，可测）。
 *
 * 不持 DOM；不测像素；不读 window.getSelection() 作权威。
 */
export class SelectionStore {
  private sel: EditorSel = { type: 'none' };

  /**
   * 设置折叠光标（caret）。
   * 等价于 setRange(pos, pos) 但快照 type 为 `caret`。
   */
  setCaret(blockId: BlockId, offset: number): SelectionSnapshot {
    const pos = normalizePos({ blockId, offset });
    this.sel = { type: 'caret', pos };
    return this.getSnapshot();
  }

  /**
   * 设置文本选区 range（anchor → head，有方向）。
   * 若 anchor 与 head 重合 → 归一为 caret。
   */
  setRange(anchor: LogicPos, head: LogicPos): SelectionSnapshot {
    const a = normalizePos(anchor);
    const h = normalizePos(head);
    if (isSamePos(a, h)) {
      this.sel = { type: 'caret', pos: a };
    } else {
      this.sel = { type: 'range', range: { anchor: a, head: h } };
    }
    return this.getSnapshot();
  }

  /**
   * 设置块多选（逻辑 id 列表；**禁止**像素测距推导）。
   * 空列表 → none。
   */
  setBlockMulti(blockIds: readonly BlockId[]): SelectionSnapshot {
    const seen = new Set<BlockId>();
    const ids: BlockId[] = [];
    for (const id of blockIds) {
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    this.sel =
      ids.length === 0
        ? { type: 'none' }
        : { type: 'blockMulti', blockIds: ids };
    return this.getSnapshot();
  }

  /** 清空选区 */
  clear(): SelectionSnapshot {
    this.sel = { type: 'none' };
    return this.getSnapshot();
  }

  /** 只读快照（深拷贝 pos，防外部 mutation） */
  getSnapshot(): SelectionSnapshot {
    const sel = cloneSel(this.sel);
    return {
      sel,
      pinnedBlockIds: collectPinnedFromSel(sel),
    };
  }
}

function cloneSel(sel: EditorSel): EditorSel {
  switch (sel.type) {
    case 'none':
      return { type: 'none' };
    case 'caret':
      return { type: 'caret', pos: { ...sel.pos } };
    case 'range':
      return {
        type: 'range',
        range: {
          anchor: { ...sel.range.anchor },
          head: { ...sel.range.head },
        },
      };
    case 'blockMulti':
      return { type: 'blockMulti', blockIds: [...sel.blockIds] };
  }
}
