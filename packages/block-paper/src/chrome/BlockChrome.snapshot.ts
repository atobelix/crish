/**
 * BlockChrome 快照 / 静默层级纯函数（SD-40）。
 *
 * 不持有可变 chrome 态；`BlockChromeModel` 调用本模做投影与守卫。
 * **禁止** DOM / 像素测距；**≠ EL-01**。
 */

import type { BlockId } from '@crish/block-paper-contract';
import type {
  BlockChromeSnapshot,
  ChromeStructureRejectCode,
  ChromeStructureResult,
  HandleVisibility,
  SilentLevel,
} from './BlockChrome.types';

// ---------------------------------------------------------------------------
// 逻辑 id
// ---------------------------------------------------------------------------

/** 去重保序；空串丢弃（逻辑 id，禁止像素推导） */
export function uniqueBlockIds(ids: readonly BlockId[]): BlockId[] {
  const seen = new Set<BlockId>();
  const out: BlockId[] = [];
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** 空串 / 假值 → null（hover/focus 离开） */
export function normalizeBlockId(blockId: BlockId | null): BlockId | null {
  return blockId && blockId.length > 0 ? blockId : null;
}

// ---------------------------------------------------------------------------
// 把手可见性 / 静默守卫
// ---------------------------------------------------------------------------

/** 把手判定上下文（只读） */
export type ChromeHandleContext = {
  multiSelectedIds: readonly BlockId[];
  focusedBlockId: BlockId | null;
  hoveredBlockId: BlockId | null;
};

/**
 * 计算指定块的把手可见性（A-SIL 按需）。
 * 优先级：multi > focus > hover > hidden
 */
export function resolveHandleVisibility(
  blockId: BlockId,
  ctx: ChromeHandleContext
): HandleVisibility {
  if (!blockId) return 'hidden';
  if (ctx.multiSelectedIds.includes(blockId)) return 'multi';
  if (ctx.focusedBlockId === blockId) return 'focus';
  if (ctx.hoveredBlockId === blockId) return 'hover';
  // 命令态下仍不强制常驻所有把手（避免 L0 退化为 Notion 常驻 chrome）
  return 'hidden';
}

/** 危险结构操作抬升条件 */
export type ChromeSilentGuardContext = {
  silentLevel: SilentLevel;
  commandActive: boolean;
  multiSelectedCount: number;
};

/**
 * 是否允许危险结构操作（删除等）。
 *
 * 对齐 A-SIL：纯 L0 静默纸面、无多选高亮、无命令态 → 拒绝危险批量。
 * 抬升条件（任一）：L1 / commandActive / 多选非空。
 */
export function isDangerousStructureAllowed(
  ctx: ChromeSilentGuardContext
): boolean {
  if (ctx.silentLevel === 'L1') return true;
  if (ctx.commandActive) return true;
  if (ctx.multiSelectedCount > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 快照 / 本地折叠
// ---------------------------------------------------------------------------

/** 快照源（字段与 model 对齐；集合只读拷出） */
export type ChromeSnapshotSource = {
  silentLevel: SilentLevel;
  hoveredBlockId: BlockId | null;
  focusedBlockId: BlockId | null;
  multiSelectedIds: readonly BlockId[];
  collapsedIds: Iterable<BlockId>;
  commandActive: boolean;
};

/** 只读快照：数组拷贝，避免外泄可变引用 */
export function buildChromeSnapshot(
  src: ChromeSnapshotSource
): BlockChromeSnapshot {
  return {
    silentLevel: src.silentLevel,
    hoveredBlockId: src.hoveredBlockId,
    focusedBlockId: src.focusedBlockId,
    multiSelectedIds: [...src.multiSelectedIds],
    collapsedIds: [...src.collapsedIds],
    commandActive: src.commandActive,
  };
}

/**
 * 本地 collapsed 集乐观同步（权威以 sink/投影为准）。
 * `next` 缺省 = 逐块 toggle。
 */
export function applyLocalCollapse(
  collapsed: Set<BlockId>,
  ids: readonly BlockId[],
  next?: boolean
): void {
  for (const id of ids) {
    if (next === true) {
      collapsed.add(id);
    } else if (next === false) {
      collapsed.delete(id);
    } else if (collapsed.has(id)) {
      collapsed.delete(id);
    } else {
      collapsed.add(id);
    }
  }
}

/** 结构操作拒绝结果 */
export function chromeStructureFail(
  code: ChromeStructureRejectCode,
  reason: string
): Extract<ChromeStructureResult<never>, { ok: false }> {
  return { ok: false, code, reason };
}
