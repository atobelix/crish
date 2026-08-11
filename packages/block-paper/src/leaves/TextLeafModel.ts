/**
 * 叶子文本本地模型 + TextEditIntent 产出（W3-D 骨架）。
 *
 * 对齐：
 * - W0 Intent：`text_edit`（blockId + range + insert + intentId）
 * - A-IME：composing 期本地缓冲可更新，**不**立刻下发 Intent；end 时 flush
 * - 写路径：Intent → sink → RS apply；**禁止** serialize(DOM) 持久化
 *
 * 本模块 **不** 接真实 ProseMirror；接口钉死供后续 PM 适配器接线。
 */

import type {
  BlockId,
  IntentId,
  TextEditIntent,
} from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// intentId 生成（本地可测；真实波可由宿主注入）
// ---------------------------------------------------------------------------

let intentSeq = 0;

/** 生成唯一 intentId（供单测可预测前缀） */
export function nextIntentId(prefix = 'intent'): IntentId {
  intentSeq += 1;
  return `${prefix}-${intentSeq}`;
}

/** 测试专用：重置序号 */
export function resetIntentIdSeqForTests(): void {
  intentSeq = 0;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function clampOffset(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

/** 叶子只读快照 */
export type TextLeafSnapshot = {
  blockId: BlockId;
  text: string;
  composing: boolean;
  /** 合成锚点 offset；非 composing 时 null */
  compositionAnchor: number | null;
  /** 合成开始时被替换区间 end（半开）；非 composing 时 null */
  compositionReplaceEnd: number | null;
};

export type TextLeafModelOptions = {
  /**
   * 自定义 intentId 工厂；缺省用 `nextIntentId`。
   * 便于宿主对接全局 id 空间。
   */
  createIntentId?: () => IntentId;
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * 单叶子 plain text 缓冲 + Intent 产出。
 *
 * 生命周期（IME）：
 * 1. `beginComposition(anchor)` — 记录合成前快照
 * 2. `applyLocalEdit` — 只改本地缓冲，**返回 null**（不发 Intent）
 * 3. `flushOnCompositionEnd` — 产出一条 `text_edit` 覆盖合成区间
 *
 * 非 composing：`applyLocalEdit` 立即产出 `TextEditIntent`。
 */
export class TextLeafModel {
  readonly blockId: BlockId;
  private text: string;
  private composing = false;
  /** 合成起始 offset（相对合成前文本） */
  private compositionAnchor: number | null = null;
  /** 合成开始时被替换的 end（相对合成前文本） */
  private compositionReplaceEnd: number | null = null;
  /** 进入 composition 前的全文（权威对照，用于 flush 算 insert） */
  private preCompositionText: string | null = null;
  private readonly createIntentId: () => IntentId;

  constructor(
    blockId: BlockId,
    initialText = '',
    options: TextLeafModelOptions = {}
  ) {
    if (!blockId) {
      throw new Error('TextLeafModel：blockId 不可为空');
    }
    this.blockId = blockId;
    this.text = initialText;
    this.createIntentId = options.createIntentId ?? (() => nextIntentId());
  }

  // -----------------------------------------------------------------------
  // 读
  // -----------------------------------------------------------------------

  getText(): string {
    return this.text;
  }

  isComposing(): boolean {
    return this.composing;
  }

  getSnapshot(): TextLeafSnapshot {
    return {
      blockId: this.blockId,
      text: this.text,
      composing: this.composing,
      compositionAnchor: this.compositionAnchor,
      compositionReplaceEnd: this.compositionReplaceEnd,
    };
  }

  // -----------------------------------------------------------------------
  // 投影回填（不产生 Intent）
  // -----------------------------------------------------------------------

  /**
   * 以投影/权威文本覆盖本地缓冲。
   * composing 期间 **拒绝**（避免盖掉合成预览）；返回是否已写入。
   */
  replaceFromProjection(text: string): boolean {
    if (this.composing) {
      return false;
    }
    this.text = text;
    return true;
  }

  // -----------------------------------------------------------------------
  // 本地编辑 → Intent
  // -----------------------------------------------------------------------

  /**
   * 本地区间替换：`text[start, end) ← insert`。
   *
   * - 始终更新本地缓冲
   * - **非 composing**：返回新 `TextEditIntent`（intentId 新生成）
   * - **composing**：仅更新缓冲，返回 `null`（不发 Intent；由 flush 提交）
   *
   * range 坐标为 JS string 索引（UTF-16 code unit）；与 IME 矩阵最终钉死一致。
   */
  applyLocalEdit(
    start: number,
    end: number,
    insert: string
  ): TextEditIntent | null {
    const len = this.text.length;
    const s = clampOffset(start, 0, len);
    const e = clampOffset(end, s, len);
    const ins = insert ?? '';

    this.text = this.text.slice(0, s) + ins + this.text.slice(e);

    if (this.composing) {
      // 合成期：本地预览可改，不发结构/文本 Intent
      return null;
    }

    return this.buildTextEditIntent(s, e, ins);
  }

  // -----------------------------------------------------------------------
  // Composition
  // -----------------------------------------------------------------------

  /**
   * 进入 composition（宿主在 compositionstart / ImeMachine.startComposition 后调用）。
   *
   * @param anchorOffset 合成插入点
   * @param replaceEnd 若 IME 替换已有选区，为选区 end；缺省 = anchor（纯插入）
   */
  beginComposition(anchorOffset: number, replaceEnd?: number): void {
    if (this.composing) {
      // 已在合成中：保持状态，不重置锚点（须先 flush/end）
      return;
    }
    const len = this.text.length;
    const anchor = clampOffset(anchorOffset, 0, len);
    const end =
      replaceEnd === undefined ? anchor : clampOffset(replaceEnd, anchor, len);

    this.composing = true;
    this.compositionAnchor = anchor;
    this.compositionReplaceEnd = end;
    this.preCompositionText = this.text;
  }

  /**
   * compositionend 刷新：产出覆盖合成区间的 `TextEditIntent`。
   *
   * @param finalInsert 合成最终插入串；缺省从「当前缓冲相对 preComposition 锚点」推导
   * @returns 有实质变更时返回 Intent；无 composition 或无变更返回 null
   *
   * 不变量：本方法结束后 `composing === false`。
   */
  flushOnCompositionEnd(finalInsert?: string): TextEditIntent | null {
    if (!this.composing) {
      return null;
    }

    const pre = this.preCompositionText ?? this.text;
    const anchor = this.compositionAnchor ?? 0;
    const replaceEnd = this.compositionReplaceEnd ?? anchor;

    let insert: string;
    if (finalInsert !== undefined) {
      insert = finalInsert;
      // 以合成前文本 + finalInsert 重建权威缓冲
      this.text = pre.slice(0, anchor) + insert + pre.slice(replaceEnd);
    } else {
      // 从当前缓冲推导：锚点后、尾部对齐 pre 的后缀
      const suffix = pre.slice(replaceEnd);
      if (suffix.length > 0 && this.text.endsWith(suffix)) {
        insert = this.text.slice(anchor, this.text.length - suffix.length);
      } else {
        // 后缀对不齐时退化为「从锚点到文末」
        insert = this.text.slice(anchor);
      }
    }

    // 清理 composition 态（先清，再可能返回）
    this.composing = false;
    this.compositionAnchor = null;
    this.compositionReplaceEnd = null;
    this.preCompositionText = null;

    // 无变更（空插入且 range 空）仍产出 Intent，便于 sink 审计；
    // 宿主可按需去重。此处始终产出，保证 flush 可测。
    return this.buildTextEditIntent(anchor, replaceEnd, insert);
  }

  /**
   * 取消 composition：回滚到合成前文本，不发 Intent。
   */
  cancelComposition(): void {
    if (!this.composing) return;
    if (this.preCompositionText != null) {
      this.text = this.preCompositionText;
    }
    this.composing = false;
    this.compositionAnchor = null;
    this.compositionReplaceEnd = null;
    this.preCompositionText = null;
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private buildTextEditIntent(
    start: number,
    end: number,
    insert: string
  ): TextEditIntent {
    return {
      type: 'text_edit',
      blockId: this.blockId,
      range: [start, end],
      insert,
      intentId: this.createIntentId(),
    };
  }
}
