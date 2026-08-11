/**
 * mock ProjectionDiff 应用器：对内存 block 列表做增量 patch。
 *
 * 对齐：
 * - W0 ProjectionDiff（`@crish/block-paper-contract`）
 * - A-IME-07 / A-COL-03：`fullRemountCount` 默认路径必须为 0
 *
 * 本模块 **不** 接真实 DocSession；仅内存态，供 W3-A 与后续挂载层 mock。
 * 不变量：未知块不推断变更；未出现在 upserts 的块内容视为未变。
 */

import type { BlockId, ProjectionDiff } from '@crish/block-paper-contract';

/** 内存块条目（mock 投影） */
export type MemoryBlock = {
  id: BlockId;
  props: unknown;
  children?: BlockId[];
  /** textTouches 后递增；无真实文本载荷 */
  textEpoch: number;
};

/** Diff 应用状态（可变；apply 就地更新并返回同一引用） */
export type DiffApplyState = {
  docId: string;
  rev: number;
  /** id → 块 */
  blocks: Map<BlockId, MemoryBlock>;
  /** 展开/兄弟序（简化：扁平 order；结构 moves 未进 W0 类型时仅 upsert 追加） */
  order: BlockId[];
  /**
   * 全量 remount 累计次数（指标 A-IME-07）。
   * 默认增量路径 **不得** 递增；仅灾难恢复路径可 +1。
   */
  fullRemountCount: number;
};

/** 单次 apply 的统计快照 */
export type ApplyDiffStats = {
  upserted: number;
  removed: number;
  textTouched: number;
  /** 本次是否走了 full remount 路径 */
  didFullRemount: boolean;
  fullRemountCount: number;
};

export type ApplyDiffResult = {
  state: DiffApplyState;
  stats: ApplyDiffStats;
};

/**
 * 创建空状态。
 */
export function createDiffApplyState(docId: string, rev = 0): DiffApplyState {
  return {
    docId,
    rev,
    blocks: new Map(),
    order: [],
    fullRemountCount: 0,
  };
}

/**
 * 对内存 block 列表应用 ProjectionDiff。
 *
 * - 默认 `fullRebuild` 省略或 false → 纯增量，`fullRemountCount` 不变
 * - 若运行时出现 `fullRebuild === true`（类型上禁止，灾难恢复逃逸）→
 *   按 upserts 重建 order/blocks 并 `fullRemountCount++`
 * - rev 必须单调；非单调 diff 抛错（防止静默乱序）
 */
export function applyProjectionDiff(
  state: DiffApplyState,
  diff: ProjectionDiff
): ApplyDiffResult {
  if (diff.docId !== state.docId) {
    throw new Error(
      `ProjectionDiff.docId 不匹配：state=${state.docId} diff=${diff.docId}`
    );
  }
  if (diff.rev < state.rev) {
    throw new Error(
      `ProjectionDiff.rev 非单调：state.rev=${state.rev} diff.rev=${diff.rev}`
    );
  }

  // 灾难路径：运行时 true（契约类型为 fullRebuild?: false，此处用宽检查）
  const fullRebuildFlag =
    (diff as { fullRebuild?: boolean }).fullRebuild === true;

  if (fullRebuildFlag) {
    return applyFullRebuild(state, diff);
  }

  // —— 默认增量路径 ——
  let upserted = 0;
  let removed = 0;
  let textTouched = 0;

  for (const id of diff.removes) {
    if (state.blocks.delete(id)) {
      removed++;
    }
    const idx = state.order.indexOf(id);
    if (idx >= 0) state.order.splice(idx, 1);
  }

  for (const u of diff.upserts) {
    const existing = state.blocks.get(u.id);
    const next: MemoryBlock = {
      id: u.id,
      props: u.props,
      textEpoch: existing?.textEpoch ?? 0,
    };
    if (u.children !== undefined) {
      next.children = u.children;
    } else if (existing?.children !== undefined) {
      next.children = existing.children;
    }
    state.blocks.set(u.id, next);
    if (!state.order.includes(u.id)) {
      state.order.push(u.id);
    }
    upserted++;
  }

  for (const id of diff.textTouches) {
    const b = state.blocks.get(id);
    if (!b) {
      // 未知块不推断：忽略
      continue;
    }
    b.textEpoch += 1;
    textTouched++;
  }

  state.rev = diff.rev;

  return {
    state,
    stats: {
      upserted,
      removed,
      textTouched,
      didFullRemount: false,
      fullRemountCount: state.fullRemountCount,
    },
  };
}

/**
 * 灾难恢复：以 upserts 为权威重建；removes 忽略（全量替换）。
 * 递增 fullRemountCount。
 */
function applyFullRebuild(
  state: DiffApplyState,
  diff: ProjectionDiff
): ApplyDiffResult {
  state.blocks.clear();
  state.order = [];
  let upserted = 0;
  for (const u of diff.upserts) {
    const block: MemoryBlock = {
      id: u.id,
      props: u.props,
      textEpoch: 0,
    };
    if (u.children !== undefined) {
      block.children = u.children;
    }
    state.blocks.set(u.id, block);
    state.order.push(u.id);
    upserted++;
  }
  // textTouches 在 full rebuild 后仍可抬 epoch
  let textTouched = 0;
  for (const id of diff.textTouches) {
    const b = state.blocks.get(id);
    if (!b) continue;
    b.textEpoch += 1;
    textTouched++;
  }
  state.rev = diff.rev;
  state.fullRemountCount += 1;

  return {
    state,
    stats: {
      upserted,
      removed: 0,
      textTouched,
      didFullRemount: true,
      fullRemountCount: state.fullRemountCount,
    },
  };
}
