/**
 * 真 ProseMirror EditorView Host（W3-D-PM）。
 *
 * - mount → `EditorView` 挂到 HTMLElement
 * - `dispatchTransaction` 委托 `PmTextLeaf` → `TextEditIntent`
 * - 可选 `onIntent` 回调（宿主可 `submitIntent` → mock/真 sink）
 * - composing：监听 compositionstart/end，对齐叶模型纪律
 *
 * ## 轨声明
 * - **W3-D-PM ≠ W3-D**：本 Host **不**默认接 `DocSession::apply`
 * - 默认 sink 仍由宿主注入；单测用 mock
 * - **禁止** serialize(view.state.doc) 持久化
 */

import { EditorState, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { TextEditIntent } from '@crish/block-paper-contract';
import { PmTextLeaf } from './PmTextLeaf';
import { leafInlineSchema, textToLeafDoc, pmPosToTextOffset } from './schema';

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

export type PmTextLeafHostOptions = {
  /**
   * 已构造的 PmTextLeaf；缺省用 blockId + initialText 新建。
   * Host 与 Leaf 共享同一逻辑 state；View 经 leaf.dispatch 同步。
   */
  leaf?: PmTextLeaf;
  /** 无 leaf 时必填：块 id */
  blockId?: string;
  initialText?: string;
  /**
   * 用户编辑产出 Intent 时回调（非 composing 即时；composing 在 end flush）。
   * 宿主应 `submitIntent(intent, sink)`；**默认不**绑真 apply。
   */
  onIntent?: (intent: TextEditIntent) => void;
  /**
   * 为 true 时跳过 onIntent（Model→View 投影推送期）。
   */
  shouldSuppressIntent?: () => boolean;
  /** 只读：禁止用户编辑 */
  readOnly?: boolean;
  /** 追加属性到 editor props */
  attributes?: { [name: string]: string };
};

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * 真 PM 叶 DOM Host。
 *
 * @example
 * ```ts
 * const leaf = new PmTextLeaf('b-1', 'hello');
 * const mock = createMockIntentSink();
 * const host = new PmTextLeafHost(el, {
 *   leaf,
 *   onIntent: (intent) => { void submitIntent(intent, mock.sink); },
 * });
 * // …
 * host.destroy();
 * ```
 */
export class PmTextLeafHost {
  private readonly leaf: PmTextLeaf;
  private readonly view: EditorView;
  private destroyed = false;
  private suppressIntent = false;
  private onIntent: ((intent: TextEditIntent) => void) | undefined;
  private readonly shouldSuppressIntent: (() => boolean) | undefined;
  private readonly onCompositionStart: (ev: Event) => void;
  private readonly onCompositionEnd: (ev: Event) => void;
  private readonly dom: HTMLElement;

  constructor(parent: HTMLElement, options: PmTextLeafHostOptions = {}) {
    if (options.leaf) {
      this.leaf = options.leaf;
    } else {
      const id = options.blockId;
      if (!id) {
        throw new Error('PmTextLeafHost：须提供 leaf 或 blockId');
      }
      this.leaf = new PmTextLeaf(id, options.initialText ?? '');
    }
    this.onIntent = options.onIntent;
    this.shouldSuppressIntent = options.shouldSuppressIntent;

    const readOnly = options.readOnly ?? false;
    const leaf = this.leaf;

    this.view = new EditorView(parent, {
      state: leaf.getState(),
      editable: () => !readOnly && !this.destroyed,
      attributes: options.attributes ?? {
        class: 'pm-text-leaf',
        'data-block-id': leaf.blockId,
      },
      dispatchTransaction: (tr: Transaction) => {
        this.handleTransaction(tr);
      },
    });

    this.dom = this.view.dom;

    // composition 边界：对齐 TextLeaf / IME 纪律
    this.onCompositionStart = () => {
      if (this.destroyed) return;
      const sel = this.view.state.selection;
      const anchor = pmPosToTextOffset(this.view.state.doc, sel.from);
      const end = pmPosToTextOffset(this.view.state.doc, sel.to);
      this.leaf.beginComposition(anchor, end);
    };
    this.onCompositionEnd = (ev: Event) => {
      if (this.destroyed) return;
      const data =
        typeof (ev as CompositionEvent).data === 'string'
          ? (ev as CompositionEvent).data
          : undefined;
      const intent = this.leaf.flushOnCompositionEnd(data);
      this.syncViewFromLeaf();
      if (intent && !this.isSuppressed()) {
        this.onIntent?.(intent);
      }
    };

    this.dom.addEventListener('compositionstart', this.onCompositionStart);
    this.dom.addEventListener('compositionend', this.onCompositionEnd);
  }

  // -----------------------------------------------------------------------
  // 公共 API
  // -----------------------------------------------------------------------

  getLeaf(): PmTextLeaf {
    return this.leaf;
  }

  getView(): EditorView {
    return this.view;
  }

  getText(): string {
    return this.leaf.getText();
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dom.removeEventListener('compositionstart', this.onCompositionStart);
    this.dom.removeEventListener('compositionend', this.onCompositionEnd);
    this.view.destroy();
  }

  /**
   * 投影回填 plain 文本到 leaf + view（不发 Intent）。
   */
  replaceFromProjection(text: string): boolean {
    this.suppressIntent = true;
    try {
      const ok = this.leaf.replaceFromProjection(text);
      if (ok) this.syncViewFromLeaf();
      return ok;
    } finally {
      this.suppressIntent = false;
    }
  }

  /** 外部主动应用编辑（测 / 程序化）；走 leaf 并同步 view */
  applyLocalEdit(
    start: number,
    end: number,
    insert: string
  ): TextEditIntent | null {
    const intent = this.leaf.applyLocalEdit(start, end, insert);
    this.syncViewFromLeaf();
    if (intent && !this.isSuppressed()) {
      this.onIntent?.(intent);
    }
    return intent;
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private isSuppressed(): boolean {
    return this.suppressIntent || Boolean(this.shouldSuppressIntent?.());
  }

  private handleTransaction(tr: Transaction): void {
    if (this.destroyed) return;
    const intent = this.leaf.dispatchTransaction(tr);
    this.view.updateState(this.leaf.getState());
    if (intent && !this.isSuppressed()) {
      this.onIntent?.(intent);
    }
  }

  private syncViewFromLeaf(): void {
    this.view.updateState(this.leaf.getState());
  }
}

/**
 * 无 DOM 工厂：仅构造可挂载的初始 EditorState（证明 prosemirror-state 接线）。
 * 单测 node 环境用；真 View 见 PmTextLeafHost。
 */
export function createPmLeafEditorState(
  text = '',
  schema = leafInlineSchema
): EditorState {
  return EditorState.create({
    doc: textToLeafDoc(text, schema),
    schema,
  });
}

export function isPmTextLeafHost(v: unknown): v is PmTextLeafHost {
  return v instanceof PmTextLeafHost;
}
