/**
 * 真 ProseMirror 文本叶（W3-D-PM Strict）。
 *
 * - 活动叶持有 `EditorState`（prosemirror-state）
 * - 本地编辑 / `dispatchTransaction` → 产出与 plain 叶一致的 `TextEditIntent`
 * - 源头强制调用标量坐标单射转换，消除 Emoji / 代理项 Off-by-4 漂移
 * - composing 纪律对齐 `TextLeafModel`：合成期不发 Intent，end 时 flush
 * - Intent 默认可走 **mock sink**（本包合法）；**禁止**默认绑 `DocSession::apply`
 *
 * ## 轨声明（诚实）
 * - **W3-D-PM** = 真 PM 适配器入库；sink 可仍 mock
 * - **≠ W3-D**（真 apply 终局 = Intent → `DocSession::apply` 集成绿）
 * - **≠ EL-01** / **≠ A-BLK 全表**
 * - plain `TextLeafModel` **保留**（W3-D-S 合法，不删除）
 *
 * ## 写锥
 * - **禁止** `serialize(pmDoc)` 进持久化 / Agent 权威
 * - 写路径：PM 事务 → `TextEditIntent` → `submitIntent` → sink
 */

import { EditorState, type Transaction } from 'prosemirror-state';
import type { Node as PmNode } from 'prosemirror-model';
import {
  type BlockId,
  type IntentId,
  type TextEditIntent,
  asUtf16Offset,
  utf16OffsetToUnicodeScalar,
} from '@crish/block-paper-contract';
import { nextIntentId } from '../../intentId';
import {
  leafInlineSchema,
  leafDocToText,
  textToLeafDoc,
  textOffsetToPmPos,
  pmPosToTextOffset,
} from './schema';
import { diffToReplace } from './diffToReplace';

export { diffToReplace };

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** PM 叶只读快照（与 TextLeafSnapshot 字段对齐 + state 可观测） */
export type PmTextLeafSnapshot = {
  blockId: BlockId;
  text: string;
  composing: boolean;
  compositionAnchor: number | null;
  compositionReplaceEnd: number | null;
};

export type PmTextLeafOptions = {
  /** 自定义 intentId 工厂；缺省共享 `nextIntentId` */
  createIntentId?: () => IntentId;
  /**
   * 初始 EditorState；缺省由 initialText + leafInlineSchema 构造。
   * 注入时仍以 state.doc 的 textContent 为 plain 真相投影。
   */
  state?: EditorState;
};

// ---------------------------------------------------------------------------
// PmTextLeaf
// ---------------------------------------------------------------------------

/**
 * 单叶子真 PM 缓冲 + Intent 产出。
 *
 * 生命周期（IME，对齐 TextLeafModel）：
 * 1. `beginComposition(anchor)` — 记录合成前快照
 * 2. `applyLocalEdit` / `dispatchTransaction` — 只改本地 PM state，**返回 null**
 * 3. `flushOnCompositionEnd` — 产出一条 `text_edit` 覆盖合成区间
 *
 * 非 composing：doc 变更立即产出 `TextEditIntent`。
 */
export class PmTextLeaf {
  readonly blockId: BlockId;
  private state: EditorState;
  private composing = false;
  private compositionAnchor: number | null = null;
  private compositionReplaceEnd: number | null = null;
  /** 进入 composition 前的 plain 文本 */
  private preCompositionText: string | null = null;
  private readonly createIntentId: () => IntentId;

  constructor(
    blockId: BlockId,
    initialText = '',
    options: PmTextLeafOptions = {}
  ) {
    if (!blockId) {
      throw new Error('PmTextLeaf：blockId 不可为空');
    }
    this.blockId = blockId;
    this.createIntentId = options.createIntentId ?? (() => nextIntentId('pm'));
    if (options.state) {
      this.state = options.state;
    } else {
      this.state = EditorState.create({
        doc: textToLeafDoc(initialText, leafInlineSchema),
        schema: leafInlineSchema,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 读
  // -----------------------------------------------------------------------

  getText(): string {
    return leafDocToText(this.state.doc);
  }

  /** 当前活动叶 EditorState（真 prosemirror-state） */
  getState(): EditorState {
    return this.state;
  }

  /** 显式采纳外部推进的合法 EditorState，杜绝状态脱节（对齐 PLAN-ROUND-3-03 §3.4） */
  adoptState(nextState: EditorState): void {
    this.state = nextState;
  }

  /** 当前 PM doc 节点 */
  getDoc(): PmNode {
    return this.state.doc;
  }

  isComposing(): boolean {
    return this.composing;
  }

  getSnapshot(): PmTextLeafSnapshot {
    return {
      blockId: this.blockId,
      text: this.getText(),
      composing: this.composing,
      compositionAnchor: this.compositionAnchor,
      compositionReplaceEnd: this.compositionReplaceEnd,
    };
  }

  // -----------------------------------------------------------------------
  // 投影回填（不产生 Intent）
  // -----------------------------------------------------------------------

  /**
   * 以投影/权威 plain 文本覆盖本地 PM doc。
   * composing 期间 **拒绝**；返回是否已写入。
   */
  replaceFromProjection(text: string): boolean {
    if (this.composing) {
      return false;
    }
    const doc = textToLeafDoc(text, this.state.schema);
    this.state = EditorState.create({
      doc,
      schema: this.state.schema,
      plugins: this.state.plugins,
    });
    return true;
  }

  // -----------------------------------------------------------------------
  // 本地编辑 → Intent
  // -----------------------------------------------------------------------

  /**
   * 本地区间替换：`text[start, end) ← insert`，经 PM `tr.insertText` 提交。
   *
   * - 始终更新本地 EditorState
   * - **非 composing**：返回新 `TextEditIntent`
   * - **composing**：仅更新 state，返回 `null`
   */
  applyLocalEdit(
    start: number,
    end: number,
    insert: string
  ): TextEditIntent | null {
    const text = this.getText();
    const len = text.length;
    const s = clampOffset(start, 0, len);
    const e = clampOffset(end, s, len);
    const ins = insert ?? '';

    const from = textOffsetToPmPos(this.state.doc, s);
    const to = textOffsetToPmPos(this.state.doc, e);
    const tr = this.state.tr.insertText(ins, from, to);
    return this.dispatchTransaction(tr);
  }

  /**
   * 应用 PM Transaction（活动叶 dispatch 入口）。
   *
   * - 无 doc 变更 → null
   * - composing → 应用 state，不发 Intent
   * - 否则 → 由 old/new plain 差分产出单条 `TextEditIntent`
   *
   * **W3-D-PM 核心**：`dispatchTransaction` → Intent（非 serialize）。
   */
  dispatchTransaction(tr: Transaction): TextEditIntent | null {
    if (!tr.docChanged) {
      // 选区等非 doc 事务：仍合并 selection
      this.state = this.state.apply(tr);
      return null;
    }

    const oldText = leafDocToText(this.state.doc);
    this.state = this.state.apply(tr);
    const newText = leafDocToText(this.state.doc);

    if (this.composing) {
      return null;
    }

    // 优先：单 Replace 语义从 mapping 取；失败则 diff
    const fromStep = replaceFromFirstStep(tr, oldText);
    if (fromStep) {
      return this.buildTextEditIntent(
        fromStep.start,
        fromStep.end,
        fromStep.insert,
        oldText
      );
    }

    const diff = diffToReplace(oldText, newText);
    return {
      type: 'text_edit',
      blockId: this.blockId,
      range: [diff.startScalar, diff.endScalar],
      insert: diff.insert,
      intentId: this.createIntentId(),
    };
  }

  // -----------------------------------------------------------------------
  // Composition（对齐 TextLeafModel）
  // -----------------------------------------------------------------------

  /**
   * 进入 composition。
   * @param anchorOffset 合成插入点
   * @param replaceEnd 选区 end；缺省 = anchor
   */
  beginComposition(anchorOffset: number, replaceEnd?: number): void {
    if (this.composing) {
      return;
    }
    const len = this.getText().length;
    const anchor = clampOffset(anchorOffset, 0, len);
    const end =
      replaceEnd === undefined ? anchor : clampOffset(replaceEnd, anchor, len);

    this.composing = true;
    this.compositionAnchor = anchor;
    this.compositionReplaceEnd = end;
    this.preCompositionText = this.getText();
  }

  /**
   * compositionend 刷新：产出覆盖合成区间的 `text_edit`。
   * 结束后 `composing === false`。
   */
  flushOnCompositionEnd(finalInsert?: string): TextEditIntent | null {
    if (!this.composing) {
      return null;
    }

    const pre = this.preCompositionText ?? this.getText();
    const anchor = this.compositionAnchor ?? 0;
    const replaceEnd = this.compositionReplaceEnd ?? anchor;

    let insert: string;
    if (finalInsert !== undefined) {
      insert = finalInsert;
      // 以合成前 + finalInsert 重建 PM doc（不经 Intent 的中间态）
      const next = pre.slice(0, anchor) + insert + pre.slice(replaceEnd);
      this.state = EditorState.create({
        doc: textToLeafDoc(next, this.state.schema),
        schema: this.state.schema,
        plugins: this.state.plugins,
      });
    } else {
      const current = this.getText();
      const suffix = pre.slice(replaceEnd);
      if (suffix.length > 0 && current.endsWith(suffix)) {
        insert = current.slice(anchor, current.length - suffix.length);
      } else {
        insert = current.slice(anchor);
      }
    }

    this.composing = false;
    this.compositionAnchor = null;
    this.compositionReplaceEnd = null;
    this.preCompositionText = null;

    return this.buildTextEditIntent(anchor, replaceEnd, insert, pre);
  }

  /** 取消 composition：回滚到合成前文本，不发 Intent */
  cancelComposition(): void {
    if (!this.composing) return;
    if (this.preCompositionText != null) {
      this.state = EditorState.create({
        doc: textToLeafDoc(this.preCompositionText, this.state.schema),
        schema: this.state.schema,
        plugins: this.state.plugins,
      });
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
    startU16: number,
    endU16: number,
    insert: string,
    baseText?: string
  ): TextEditIntent {
    const text = baseText ?? this.getText();
    const startScalar = utf16OffsetToUnicodeScalar(
      text,
      asUtf16Offset(startU16)
    );
    const endScalar = utf16OffsetToUnicodeScalar(text, asUtf16Offset(endU16));

    return {
      type: 'text_edit',
      blockId: this.blockId,
      range: [startScalar, endScalar],
      insert,
      intentId: this.createIntentId(),
    };
  }
}

function clampOffset(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 尝试从 tr.steps[0] 的 Replace 语义提取 [start,end,insert]（相对 oldText）。
 * 多 step 或不识别时返回 null，由调用方 diff。
 */
function replaceFromFirstStep(
  tr: Transaction,
  _oldText: string
): { start: number; end: number; insert: string } | null {
  if (tr.steps.length !== 1) return null;
  const step = tr.steps[0] as {
    from?: number;
    to?: number;
    slice?: {
      content: {
        textBetween: (a: number, b: number, c?: string, d?: string) => string;
        size: number;
      };
    };
  };
  if (typeof step.from !== 'number' || typeof step.to !== 'number') {
    return null;
  }
  // step 坐标相对 **旧** doc；tr.docs[0] 为应用前 doc
  const oldDoc = tr.docs[0] ?? tr.before;
  if (!oldDoc) return null;
  const start = pmPosToTextOffset(oldDoc, step.from);
  const end = pmPosToTextOffset(oldDoc, step.to);
  let insert = '';
  if (step.slice) {
    insert = step.slice.content.textBetween(0, step.slice.content.size, '', '');
  }
  return { start, end, insert };
}

/** 类型守卫：是否为 PmTextLeaf 实例 */
export function isPmTextLeaf(v: unknown): v is PmTextLeaf {
  return v instanceof PmTextLeaf;
}
