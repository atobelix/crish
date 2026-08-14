/**
 * DomPinningRegistry — DOM Pinning 保护锁与节点驻留管理器。
 *
 * 依据 PLAN-ROUND-3-03 §3.3 与 A-IME-03 规范：
 * - 维护活动/合成中及显式锁定的 DOM 块集合；
 * - 拦截虚拟滚动调度器在用户输入法合成期间卸载活动块 DOM 容器，
 *   彻底防止 Chromium / WebView2 内部断言失败与宿主崩溃；
 * - 协同远端删除事件到达时，将处于 Pinned 状态的活动块列入 deferredRemovals，
 *   待输入法完成选词上屏后再行安全卸载与销毁。
 */

import type { BlockId } from '@crish/block-paper-contract';

/** DOM 卸载过滤结果 */
export type RemovalFilterResult = {
  /** 允许立即安全卸载/移除的块 ID 列表 */
  safeRemovals: BlockId[];
  /** 因处于 Pinned 锁定保护中而暂缓卸载的块 ID 列表 */
  deferredRemovals: BlockId[];
};

/**
 * DOM Pinning 注册表与保护锁管理器。
 */
export class DomPinningRegistry {
  private readonly pinnedBlockIds = new Set<BlockId>();

  /**
   * 锁定（Pin）指定块，使其在 DOM 中驻留，防止被虚拟滚动或外部事件卸载。
   *
   * @param blockId 需要锁定的块 ID
   */
  pin(blockId: BlockId): void {
    if (blockId) {
      this.pinnedBlockIds.add(blockId);
    }
  }

  /**
   * 解除锁定（Unpin）指定块。
   *
   * @param blockId 需要解锁的块 ID
   */
  unpin(blockId: BlockId): void {
    if (blockId) {
      this.pinnedBlockIds.delete(blockId);
    }
  }

  /**
   * 查询指定块是否处于 Pinned 锁定状态。
   */
  isPinned(blockId: BlockId): boolean {
    return this.pinnedBlockIds.has(blockId);
  }

  /**
   * 获取当前全部 Pinned 块 ID 集合（只读）。
   */
  getPinned(): ReadonlySet<BlockId> {
    return this.pinnedBlockIds;
  }

  /**
   * 获取当前锁定的块数量。
   */
  size(): number {
    return this.pinnedBlockIds.size;
  }

  /**
   * 清除所有锁定记录。
   */
  clear(): void {
    this.pinnedBlockIds.clear();
  }

  /**
   * 过滤候选卸载/删除块列表：
   * 将处于 Pinned 锁定状态的块与安全可卸载的块分离。
   *
   * @param candidateRemoveIds 候选被卸载/删除的块 ID 迭代器
   */
  filterSafeRemovals(
    candidateRemoveIds: Iterable<BlockId>
  ): RemovalFilterResult {
    const safeRemovals: BlockId[] = [];
    const deferredRemovals: BlockId[] = [];

    for (const id of candidateRemoveIds) {
      if (!id) continue;
      if (this.pinnedBlockIds.has(id)) {
        deferredRemovals.push(id);
      } else {
        safeRemovals.push(id);
      }
    }

    return { safeRemovals, deferredRemovals };
  }

  /**
   * 对象列表过滤：针对带 id 属性的对象列表进行安全卸载分离。
   */
  filterSafeUnmounts<T extends { id: BlockId }>(
    items: Iterable<T>
  ): { allowed: T[]; retained: T[] } {
    const allowed: T[] = [];
    const retained: T[] = [];

    for (const item of items) {
      if (item && this.pinnedBlockIds.has(item.id)) {
        retained.push(item);
      } else if (item) {
        allowed.push(item);
      }
    }

    return { allowed, retained };
  }
}
