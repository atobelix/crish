/**
 * IME composition 状态机（stub，可测）。
 *
 * 对齐：
 * - A-IME-01…04：合成生命周期 + 结构键/slash 禁 + pin
 * - round-D D5 §6：Idle | Composing（PendingFlush 可后续扩展）
 * - W0 MountSpec：composing 块必须在 pinned；卸载焦点/composing = 违规
 *
 * 不变量（A-IME）：
 * 1. Composing 时：禁结构键意图、禁 slash（structureKeyGuard）
 * 2. Composing 时：禁 unmount 焦点块 / composing 块（复用 pin.ts）
 * 3. composing 块必须进入 pin（buildPinSet 自动并入）
 */

import type { BlockId } from '@crish/block-paper-contract';
import {
  assertUnmountAllowed,
  buildPinSet,
  checkUnmountAllowed,
  ensureComposingPinned,
  type PinInput,
  type PinResult,
  type PinViolationCode,
} from '../viewport/pin';
import {
  filterStructureIntents,
  guardStructureIntent,
  type GuardableIntent,
  type StructureGuardResult,
} from './structureKeyGuard';

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** IME 相位（stub：Idle | Composing；PendingFlush 后续可插） */
export type ImePhase = 'idle' | 'composing';

/** 只读快照 */
export type ImeSnapshot = {
  phase: ImePhase;
  /** 合成中的块；Idle 时 null */
  blockId: BlockId | null;
  /** 合成会话组 id（一次合成 = 一步撤销的关联键） */
  groupId: string | null;
  /** compositionupdate 最近候选/缓冲（可空） */
  preview: string;
  /** 是否处于 composing */
  composing: boolean;
};

export type ImeStartResult =
  { ok: true; snapshot: ImeSnapshot } | { ok: false; reason: string };

export type ImeEndResult = {
  snapshot: ImeSnapshot;
  /** end 时提交用的最终文本（value 优先语义的 stub） */
  committedText: string;
  groupId: string | null;
  blockId: BlockId | null;
};

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

let groupSeq = 0;

function nextGroupId(): string {
  groupSeq += 1;
  return `ime-g-${groupSeq}`;
}

/**
 * 可测 IME 状态机。
 *
 * 不绑定 DOM composition 事件；宿主在 compositionstart/update/end 时调用对应方法。
 */
export class ImeMachine {
  private phase: ImePhase = 'idle';
  private blockId: BlockId | null = null;
  private groupId: string | null = null;
  private preview = '';

  /** 当前是否 composing */
  isComposing(): boolean {
    return this.phase === 'composing';
  }

  /** 合成块 id；Idle 为 null */
  getComposingBlockId(): BlockId | null {
    return this.blockId;
  }

  getSnapshot(): ImeSnapshot {
    return {
      phase: this.phase,
      blockId: this.blockId,
      groupId: this.groupId,
      preview: this.preview,
      composing: this.phase === 'composing',
    };
  }

  /**
   * compositionstart：进入 Composing，绑定 blockId。
   * 已在 composing 时重复 start → 拒绝（须先 end）。
   */
  startComposition(blockId: BlockId): ImeStartResult {
    if (!blockId) {
      return {
        ok: false,
        reason: 'ImeMachine.startComposition：blockId 不可为空',
      };
    }
    if (this.phase === 'composing') {
      return {
        ok: false,
        reason: `ImeMachine：已在 composing（blockId=${this.blockId}），须先 endComposition`,
      };
    }
    this.phase = 'composing';
    this.blockId = blockId;
    this.groupId = nextGroupId();
    this.preview = '';
    return { ok: true, snapshot: this.getSnapshot() };
  }

  /**
   * compositionupdate：刷新候选预览（仅 composing 有效）。
   * Idle 时 no-op。
   */
  updateComposition(data?: string): ImeSnapshot {
    if (this.phase !== 'composing') {
      return this.getSnapshot();
    }
    if (data !== undefined) {
      this.preview = data;
    }
    return this.getSnapshot();
  }

  /**
   * compositionend：回到 Idle；返回 committed 文本（value 优先 stub）。
   * Idle 时调用 → 空提交，状态不变。
   *
   * @param finalText 控件最终文本；缺省则用 preview
   */
  endComposition(finalText?: string): ImeEndResult {
    if (this.phase !== 'composing') {
      return {
        snapshot: this.getSnapshot(),
        committedText: '',
        groupId: null,
        blockId: null,
      };
    }
    const committedText = finalText !== undefined ? finalText : this.preview;
    const groupId = this.groupId;
    const blockId = this.blockId;
    this.phase = 'idle';
    this.blockId = null;
    this.groupId = null;
    this.preview = '';
    return {
      snapshot: this.getSnapshot(),
      committedText,
      groupId,
      blockId,
    };
  }

  // -------------------------------------------------------------------------
  // pin 集成（A-IME：composing 块必须 pin；禁 unmount）
  // -------------------------------------------------------------------------

  /**
   * 生成 pin 输入：composing 块自动列入 composingIds。
   * 宿主可合并 focusId / 选区 extraPinned 后 buildPinSet。
   */
  toPinInput(
    focusId?: BlockId | null,
    extraPinned?: Iterable<BlockId>
  ): PinInput {
    // exactOptionalPropertyTypes：仅在有值时写入可选字段
    const input: PinInput = {
      composingIds: this.blockId != null ? [this.blockId] : [],
    };
    if (focusId !== undefined) {
      input.focusId = focusId;
    }
    if (extraPinned !== undefined) {
      input.extraPinned = extraPinned;
    }
    return input;
  }

  /**
   * 当前 pin 集合（焦点可选；composing 必入）。
   */
  buildPinned(
    focusId?: BlockId | null,
    extraPinned?: Iterable<BlockId>
  ): Set<BlockId> {
    return buildPinSet(this.toPinInput(focusId, extraPinned));
  }

  /**
   * 审计：composing 块是否已在 pinned 中。
   * 正常路径用 buildPinned；本方法供外部快照审计。
   */
  ensureComposingInPin(pinned: ReadonlySet<BlockId>): PinResult {
    if (this.blockId == null) {
      return { ok: true, value: undefined };
    }
    return ensureComposingPinned(pinned, [this.blockId]);
  }

  /**
   * 校验卸载是否允许（Result，不抛）。
   * composing / 焦点块卸载 → 违规。
   */
  checkUnmount(
    blockId: BlockId,
    opts: { focusId?: BlockId | null; pinned?: ReadonlySet<BlockId> } = {}
  ): PinResult {
    const pinned = opts.pinned ?? this.buildPinned(opts.focusId);
    const ctx: {
      focusId?: BlockId | null;
      composingIds?: BlockId[];
      pinned: ReadonlySet<BlockId>;
    } = {
      composingIds: this.blockId != null ? [this.blockId] : [],
      pinned,
    };
    if (opts.focusId !== undefined) {
      ctx.focusId = opts.focusId;
    }
    return checkUnmountAllowed(blockId, ctx);
  }

  /**
   * 断言允许卸载；失败抛 PinViolationError。
   * 合成中 unmount 焦点/composing 块 = 违规。
   */
  assertUnmount(
    blockId: BlockId,
    opts: { focusId?: BlockId | null; pinned?: ReadonlySet<BlockId> } = {}
  ): void {
    const pinned = opts.pinned ?? this.buildPinned(opts.focusId);
    const ctx: {
      focusId?: BlockId | null;
      composingIds?: BlockId[];
      pinned: ReadonlySet<BlockId>;
    } = {
      composingIds: this.blockId != null ? [this.blockId] : [],
      pinned,
    };
    if (opts.focusId !== undefined) {
      ctx.focusId = opts.focusId;
    }
    assertUnmountAllowed(blockId, ctx);
  }

  // -------------------------------------------------------------------------
  // 结构键 / slash 守卫
  // -------------------------------------------------------------------------

  /**
   * 尝试放行意图：composing 时结构/slash → reject。
   */
  tryAcceptIntent(intent: GuardableIntent): StructureGuardResult {
    return guardStructureIntent(this.isComposing(), intent);
  }

  /**
   * 批量过滤结构意图。
   */
  filterIntents(intents: readonly GuardableIntent[]) {
    return filterStructureIntents(this.isComposing(), intents);
  }
}

export type { PinViolationCode, GuardableIntent, StructureGuardResult };
