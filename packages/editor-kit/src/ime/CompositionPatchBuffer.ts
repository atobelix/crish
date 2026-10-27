/**
 * CompositionPatchBuffer — IME 组合态补丁增量缓冲区。
 *
 * 依据 PLAN-ROUND-3-03 §3.2 与 A-IME-06 规范：
 * - 在用户进行 IME 拼音/输入法合成期间（`isComposing = true`），将远端或后台 Agent 派发的
 *   `ProjectionDiff` 增量补丁（同块文本修改或结构变更）安全拦截并暂存入隔离缓冲区；
 * - 避免在输入法上屏前突变修改正在合成的 DOM 块，杜绝输入法断裂与崩溃；
 * - 在 `compositionend` 触发后，通过 `endComposition()` 批量吐出暂存补丁，
 *   交由上层宿主通过坐标 Mapping 增量合入，彻底消除并发协同吞字与光标跳跃。
 */

import type {
  BlockId,
  DocId,
  ProjectionDiff,
} from '@crish/block-paper-contract';

/** 暂存补丁类型 */
export type BufferedPatchType = 'text_edit' | 'structure';

/** 增量缓冲区中的单条暂存补丁 */
export type BufferedPatch = {
  /** 目标块 ID */
  id: BlockId;
  /** 补丁类型：text_edit（文本变动）或 structure（结构增删改） */
  type: BufferedPatchType;
  /** 原始 ProjectionDiff 对象 */
  diff: ProjectionDiff;
  /** 暂存时的时间戳（毫秒） */
  timestamp: number;
};

/** 补丁拦截决策结果 */
export type PatchInterceptResult = {
  /** 是否可以直接放行（未命中合成保护） */
  passThrough: boolean;
  /** 是否已被暂存入增量缓冲区 */
  buffered: boolean;
  /** 决策原因说明 */
  reason: string;
};

/**
 * IME 组合态补丁增量缓冲区。
 *
 * 线程/上下文安全：无状态外部依赖，纯内存状态机管理。
 */
export class CompositionPatchBuffer {
  private activeBlockId: BlockId | null = null;
  private activeDocId: DocId | null = null;
  private isComposing = false;
  private patchQueue: BufferedPatch[] = [];

  /**
   * 开始 IME 组合态合成会话。
   *
   * @param blockId 当前正在输入的块 ID
   * @param docId 当前块所属文档 ID；块 ID 只保证文档内稳定，因此必须同时绑定文档
   */
  beginComposition(blockId: BlockId, docId: DocId): void {
    if (!blockId || !docId) {
      throw new Error(
        '[CompositionPatchBuffer] beginComposition: blockId 与 docId 不可为空'
      );
    }
    if (this.isComposing) {
      throw new Error(
        `[CompositionPatchBuffer] beginComposition: 文档 ${this.activeDocId} 的块 ${this.activeBlockId} 仍在合成`
      );
    }
    this.activeBlockId = blockId;
    this.activeDocId = docId;
    this.isComposing = true;
  }

  /**
   * 结束 IME 组合态合成会话，清空状态并返回所有暂存的补丁队列。
   *
   * @returns 暂存的补丁列表（按到达时序排列）
   */
  endComposition(): BufferedPatch[] {
    return this.closeComposition();
  }

  /**
   * 取消本地合成并返回期间暂存的远端补丁。
   * 取消只丢弃本地预编辑；远端补丁仍须由宿主按序合入。
   */
  cancelComposition(): BufferedPatch[] {
    return this.closeComposition();
  }

  /**
   * 查询当前是否处于 IME 组合态。
   */
  getIsComposing(): boolean {
    return this.isComposing;
  }

  /**
   * 查询指定块是否正在进行 IME 合成。
   */
  isBlockComposing(blockId: BlockId): boolean {
    return this.isComposing && this.activeBlockId === blockId;
  }

  /**
   * 获取当前处于合成态的块 ID（若未处于合成态则返回 null）。
   */
  getActiveBlockId(): BlockId | null {
    return this.activeBlockId;
  }

  /** 获取当前合成块所属文档 ID；未合成时返回 null。 */
  getActiveDocId(): DocId | null {
    return this.activeDocId;
  }

  /**
   * 只读窥视当前暂存队列长度。
   */
  getQueueLength(): number {
    return this.patchQueue.length;
  }

  /**
   * 只读获取当前暂存队列副本（不消费队列）。
   */
  getQueue(): readonly BufferedPatch[] {
    return [...this.patchQueue];
  }

  /**
   * 结束当前会话并交还暂存补丁。调用方需要按序处理返回值。
   */
  clear(): BufferedPatch[] {
    return this.closeComposition();
  }

  /**
   * 拦截并处理到达的 ProjectionDiff：
   * - 若当前未处于合成态，或 diff 未触及当前合成块，直接放行（passThrough = true）；
   * - 若 diff 触及正在合成的块（包含文本变动或结构删除/更新），暂存入队列（buffered = true）。
   *
   * @param diff 远端或协同引擎派发的 ProjectionDiff
   */
  intercept(diff: ProjectionDiff): PatchInterceptResult {
    if (!this.isComposing || !this.activeBlockId || !this.activeDocId) {
      return {
        passThrough: true,
        buffered: false,
        reason: 'IME 处于 idle 态，直接放行',
      };
    }

    if (diff.docId !== this.activeDocId) {
      return {
        passThrough: true,
        buffered: false,
        reason: `异文档操作（当前合成文档 ${this.activeDocId}），直接放行`,
      };
    }

    const currentActive = this.activeBlockId;

    // 检查是否包含对当前合成块的删除
    const isRemoved = diff.removes.includes(currentActive);

    // 检查是否包含对当前合成块的文本变动通知
    const isTextTouched = diff.textTouches.includes(currentActive);

    // 检查是否包含对当前合成块的属性/内容 upsert
    const isUpserted = diff.upserts.some((u) => u.id === currentActive);

    const touchesActiveBlock = isRemoved || isTextTouched || isUpserted;

    if (touchesActiveBlock) {
      const patchType: BufferedPatchType = isRemoved
        ? 'structure'
        : 'text_edit';
      const bufferedItem: BufferedPatch = {
        id: currentActive,
        type: patchType,
        diff,
        timestamp: Date.now(),
      };
      this.patchQueue.push(bufferedItem);

      return {
        passThrough: false,
        buffered: true,
        reason: isRemoved
          ? `当前块 (${currentActive}) 正在输入法合成中，结构删除操作已暂存`
          : `当前块 (${currentActive}) 正在输入法合成中，文本更新操作已暂存`,
      };
    }

    return {
      passThrough: true,
      buffered: false,
      reason: `异块操作（未触及当前合成块 ${currentActive}），直接放行`,
    };
  }

  private closeComposition(): BufferedPatch[] {
    this.isComposing = false;
    this.activeBlockId = null;
    this.activeDocId = null;
    const flushed = this.patchQueue;
    this.patchQueue = [];
    return flushed;
  }
}
