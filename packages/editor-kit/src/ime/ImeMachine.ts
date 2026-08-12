/**
 * IME composition 状态机（stub，可测）。
 *
 * 轨：**W6-B-S** 语义子集可测（L0/L1/L1+）；**≠ W6-B** WebView L2 e2e；
 * **≠ 叶子核锁定门禁**；**≠ EL** 关闭。
 *
 * 对齐：
 * - A-IME-01…05：合成生命周期 + 结构键/slash 禁 + pin + 切块策略 + 一步撤销边界
 * - round-D D5 §6：Idle | Composing（PendingFlush 可后续扩展）
 * - W0 MountSpec：composing 块必须在 pinned；卸载焦点/composing = 违规
 *
 * 不变量（A-IME）：
 * 1. Composing 时：禁结构键意图、禁 slash（structureKeyGuard）
 * 2. Composing 时：禁 unmount 焦点块 / composing 块（复用 pin.ts / planScrollUnmount）
 * 3. composing 块必须进入 pin（buildPinSet 自动并入）
 * 4. A-IME-04：合成中点另一块 → **end_then_switch**（先 end 提交原块再切）
 * 5. A-IME-05：仅 endComposition 产生一次 commit 边界（同 groupId）；update 不产生边界
 */

import type { BlockId } from '@crish/block-paper-contract';
import {
  assertUnmountAllowed,
  buildPinSet,
  checkUnmountAllowed,
  ensureComposingPinned,
  planScrollUnmount,
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

/**
 * A-IME-05：合成提交边界（一次合成 = 一步撤销的 model 契约）。
 * 仅 `endComposition` 在离开 composing 时写入；`updateComposition` 永不写入。
 */
export type ImeCommitBoundary = {
  kind: 'composition_end';
  groupId: string;
  blockId: BlockId;
  committedText: string;
};

/**
 * A-IME-04 钉死策略：合成中请求焦点到另一块时，先 endComposition（提交原块）再允许切换。
 * - 不采用「拒绝切换」——用户点击意图优先，半成品拼音可丢但已上屏字经 value 提交。
 * - 禁止半切换（composing 仍挂在旧块同时焦点已跳）。
 */
export type ImeFocusSwitchStrategy = 'end_then_switch';

/** 程序可读钉死常量（与文档 / 矩阵一致） */
export const IME_FOCUS_SWITCH_STRATEGY: ImeFocusSwitchStrategy =
  'end_then_switch';

export type ImeFocusSwitchResult =
  | {
      ok: true;
      strategy: ImeFocusSwitchStrategy;
      /** 是否发生了目标变更（同块点击 = false） */
      switched: boolean;
      fromBlockId: BlockId | null;
      toBlockId: BlockId;
      /** 若请求前在 composing 且目标不同块，则为 end 结果；否则 null */
      ended: ImeEndResult | null;
    }
  | { ok: false; reason: string };

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
  /** A-IME-05：自上次 drain 起产生的提交边界（仅 end 写入） */
  private pendingBoundaries: ImeCommitBoundary[] = [];

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
   * **不**产生 commit 边界（A-IME-05）。
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
   * **不**产生 commit 边界——半成品不入撤销栈（A-IME-05）。
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
   * Idle 时调用 → 空提交，状态不变，**不**写边界。
   *
   * 离开 composing 时写入 **恰好一条** `ImeCommitBoundary`（A-IME-05 一步撤销）。
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
    const groupId = this.groupId!;
    const blockId = this.blockId!;
    this.phase = 'idle';
    this.blockId = null;
    this.groupId = null;
    this.preview = '';
    // 单一提交边界：一次合成会话 → 一步撤销（groupId 关联）
    this.pendingBoundaries.push({
      kind: 'composition_end',
      groupId,
      blockId,
      committedText,
    });
    return {
      snapshot: this.getSnapshot(),
      committedText,
      groupId,
      blockId,
    };
  }

  /**
   * A-IME-05：取出并清空待处理的提交边界。
   * 宿主可映射为 undo 栈的一次 push（无真实 undo 时仍可断言条数与 groupId）。
   */
  drainCommitBoundaries(): ImeCommitBoundary[] {
    const out = this.pendingBoundaries;
    this.pendingBoundaries = [];
    return out;
  }

  /** 只读窥视未 drain 的边界（不消费） */
  peekCommitBoundaries(): readonly ImeCommitBoundary[] {
    return this.pendingBoundaries;
  }

  /**
   * A-IME-04：合成中点另一块的焦点切换（钉死 `end_then_switch`）。
   *
   * - idle：直接允许切换（ended=null）
   * - composing 且目标 === 当前块：不 end、不切换（switched=false）
   * - composing 且目标不同：先 endComposition(finalText) 提交原块，再标记 switched
   *
   * @param targetBlockId 用户点击的目标块
   * @param finalText 可选；composing 时 end 的 value 优先文本
   */
  requestFocusSwitch(
    targetBlockId: BlockId,
    finalText?: string
  ): ImeFocusSwitchResult {
    if (!targetBlockId) {
      return {
        ok: false,
        reason: 'ImeMachine.requestFocusSwitch：targetBlockId 不可为空',
      };
    }
    if (this.phase !== 'composing') {
      return {
        ok: true,
        strategy: IME_FOCUS_SWITCH_STRATEGY,
        switched: true,
        fromBlockId: null,
        toBlockId: targetBlockId,
        ended: null,
      };
    }
    const fromBlockId = this.blockId;
    if (fromBlockId === targetBlockId) {
      return {
        ok: true,
        strategy: IME_FOCUS_SWITCH_STRATEGY,
        switched: false,
        fromBlockId,
        toBlockId: targetBlockId,
        ended: null,
      };
    }
    // 钉死：先 end 再切——禁止半切换（composing 仍挂旧块）
    const ended = this.endComposition(finalText);
    return {
      ok: true,
      strategy: IME_FOCUS_SWITCH_STRATEGY,
      switched: true,
      fromBlockId,
      toBlockId: targetBlockId,
      ended,
    };
  }

  /**
   * A-IME-03：滚动卸载规划 + composing 守卫组合。
   * composing 块 / 焦点 / pin 永不进入 allowed。
   */
  planScrollUnmount(
    scrollUnloadCandidates: Iterable<BlockId>,
    opts: { focusId?: BlockId | null; pinned?: ReadonlySet<BlockId> } = {}
  ): { allowed: BlockId[]; retained: BlockId[] } {
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
    return planScrollUnmount(scrollUnloadCandidates, ctx);
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
